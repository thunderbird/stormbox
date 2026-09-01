/**
 * JmapBackend ties the JMAP transport, the SQLite handlers, and every
 * per-method sync function into a single object that satisfies the
 * SyncClient backend contract. One instance per (account, transport).
 *
 * Lifecycle:
 *   start():
 *     - Fetch session (if not already cached on the transport)
 *     - Ingest into accounts / account_services / account_capabilities
 *     - Run a bootstrap sync for mailboxes + identities + addressbooks
 *       (when contacts service is present) using HTTP
 *     - Open the WebSocket; once open, all subsequent JMAP calls go
 *       over WS for lower per-request overhead
 *     - Subscribe to StateChange notifications and route them to the
 *       relevant /changes handler per JMAP type
 *
 *   stop():
 *     - Close the WebSocket and detach the StateChange listener
 *
 * Per-need helpers (called by the SyncClient facade):
 *   ensureFolderTree     ensureFolderWindow     ensureMessageBody
 *   ensureMessageBodyForDisplay (via sync.messageBodyForDisplay RPC)
 *   ensureIdentities     ensureAddressbooks     ensureContacts
 *   runMutation
 */

import { DB_RPC } from '../../../db/protocol';
import {
  MUTATION_RECOVERY_POLICIES,
  SERVICE_KIND,
} from '../../../constants/states';
import { wlog } from '../../../db/worker-log';
import { ingestSession } from './session';
import { syncMailboxes, syncMailboxChanges } from './mailboxes';
import {
  syncFolderWindow,
  syncFolderWindowChanges,
  syncEmailChanges,
} from './messages';
import { fetchEmailBodies } from './bodies';
import { syncIdentities } from './identities';
import { syncQuota } from './quota';
import { pageCompleteQuery } from './query-paging';
import {
  inventoryAddressBook,
  syncAddressBooks,
  syncContacts,
  syncContactCardChanges,
} from './contacts';
import { MUTATION_TYPES, processMutationRow } from './outbox';
import { OutboxRunner } from './outbox-runner';
import { refreshScheduleCapability } from './schedule-capability';
import {
  scheduleClockWindow,
  SUBMISSION_RELEASE_OBSERVATION_DELAY_MS,
} from './schedule-time';
import { readScheduledMailboxRemoteId } from './scheduled-mailbox';
import { syncSubmissionsForAccount } from './submissions';
import { hasFileNodeCapability, syncSettingsFromServer } from './settings';
import { syncContactsTrashFromServer } from './contacts-trash';
import { attachmentTransferLimits, maxObjectsInGet } from './limits';
import { bytesToBase64 } from '../../../utils/inline-images';
import { addressKey } from '../../../utils/address-key';
import { createContactUid } from '../../../utils/contact-uid';

const SUBSCRIBED_TYPES = [
  'Mailbox',
  'Email',
  'Thread',
  'Identity',
  'EmailDelivery',
  'EmailSubmission',
  'AddressBook',
  'ContactCard',
];

const SUBMISSION_WAKE_MIN_MS = 1_000;
// Far-out schedules are periodically re-derived without overflowing the
// 32-bit setTimeout budget.
const SUBMISSION_WAKE_MAX_MS = 6 * 60 * 60_000;
// A settled submission whose local move/cancel is still draining gets
// one short recheck instead of waiting for the next natural trigger.
const SUBMISSION_SETTLED_RECHECK_MS = 15_000;

const CONTACTS_TRASH_GATED_MUTATIONS = new Set([
  MUTATION_TYPES.WHITELIST_SENDER,
  MUTATION_TYPES.DELETE_CONTACT,
  MUTATION_TYPES.CONTACT_BATCH,
  MUTATION_TYPES.CONTACT_TRASH,
]);

// How many mailbox-window views the startup / push catch-up reconciles
// by recency. The inbox view is always reconciled in addition to these
// (see _refreshActiveQueryViews), since it is the folder the UI opens
// by default and must never be left stale just because the user last
// browsed other folders.
const ACTIVE_VIEW_REFRESH_LIMIT = 5;

// How many folders a single indexer tick may attempt and fail before
// giving up for the tick. Bounds the burst when a whole account's
// folders fail at once (e.g. a revoked shared session answers every
// Email/query with an error tuple): the sweep pushes every failing
// folder into backoff over a few ticks instead of issuing one failing
// round trip per folder per tick.
const INDEXER_MAX_FAILED_ATTEMPTS_PER_TICK = 3;
const DRAFT_SAVE_MAX_ATTEMPTS = 3;
const UNSAFE_TO_REPLAY_MUTATION_TYPES = MUTATION_RECOVERY_POLICIES
  .map(({ mutationType }) => mutationType);
const REPLAYABLE_MUTATION_PHASES = [
  ...new Set(MUTATION_RECOVERY_POLICIES.flatMap(({ replayablePhases }) => replayablePhases)),
];
const COMPLETED_MUTATION_PHASES = [
  ...new Set(MUTATION_RECOVERY_POLICIES.flatMap(({ completedPhases }) => completedPhases)),
];

// Concurrent account starts can briefly create overlapping backend instances.
// The shared handler map identifies one local database, so automatic historical
// promotion is serialized per database and account (CS-3.13).
const RECIPIENT_IMPORT_INFLIGHT = new WeakMap<
  Record<string, (params: any) => Promise<any>>,
  Map<number, Promise<any>>
>();

type ContactsTrashReadiness =
  | { ok: true }
  | { ok: false; error: any };

function contactsTrashReadinessError(error: any): any {
  if (error && typeof error.type === 'string') return error;
  return {
    type: 'contactsTrashUnavailable',
    message: error?.message ?? String(error),
  };
}

function transferTooLargeError(
  message: string,
  maxBytes: number,
  actualBytes: number,
) {
  const error: any = new Error(message);
  error.type = 'tooLarge';
  error.status = 413;
  error.maxBytes = maxBytes;
  error.actualBytes = actualBytes;
  return error;
}

export class JmapBackend {
  transport: any;
  serverOrigin: string;
  handlers: Record<string, (params: any) => Promise<any>>;
  useWebSocket: boolean;
  account: any;
  services: any[];
  sharedAccounts: any[];
  _accountsByLocalId: Map<number, any>;
  _accountsByRemoteId: Map<string, any>;
  _unsubStateChange: (() => void) | null;
  _started: boolean;
  _indexerTimer: any;
  _indexerRunning: boolean;
  _foregroundFolderWindowCount: number;
  _bodyFetchInflight: Map<number, Promise<any>>;
  _bodyPriorityInflight: Map<number, Promise<any>>;
  _eagerBodyPrefetchCap: number;
  _indexerTickDelayMs: number;
  _indexerChunksPerTick: number;
  _indexerFolderFailures: Map<number, { count: number; nextRetryAfter: number }>;
  _indexerFailureBackoffBaseMs: number;
  _indexerFailureBackoffMaxMs: number;
  _indexerTickFailures: number;
  _indexerTickMaxDelayMs: number;
  outboxRunner: any;
  _outboxRunnerOptions: any;
  _bootstrappedPromise: Promise<void> | null;
  _contactsTrashReady: boolean;
  _contactsTrashRefresh: Promise<ContactsTrashReadiness> | null;
  _stateChangeInflight: Promise<void> | null;
  _stateChangePending: { changed: Record<string, Record<string, string>>; pushState: string | null } | null;
  _stateChangeRetryPending: { changed: Record<string, Record<string, string>>; pushState: string | null } | null;
  _stateChangeRetryTimer: any;
  _stateChangeRetryDelayMs: number;
  _unsubClose: (() => void) | null;
  _reconnectTimer: any;
  _reconnectAttempts: number;
  _reconnectBaseDelayMs: number;
  _reconnectMaxDelayMs: number;
  _submissionSyncInflight: Promise<void> | null;
  _submissionSyncQueued: boolean;
  _submissionSyncFailures: number;
  _submissionWakeTimer: any;

  constructor({ transport, serverOrigin, handlers, options = {} }: {
    transport: any;
    serverOrigin: string;
    handlers: Record<string, (params: any) => Promise<any>>;
    options?: any;
  }) {
    this.transport = transport;
    this.serverOrigin = serverOrigin;
    this.handlers = handlers;
    this.useWebSocket = options.useWebSocket ?? true;
    this.account = null;
    this.services = [];
    // Shared accounts (RFC 9670) advertised by the same session. Their
    // mailboxes sync through this backend over the same transport;
    // folder-scoped operations resolve the owning account row through
    // _accountForFolder.
    this.sharedAccounts = [];
    this._accountsByLocalId = new Map();
    this._accountsByRemoteId = new Map();
    this._unsubStateChange = null;
    this._started = false;
    this._indexerTimer = null;
    this._indexerRunning = false;
    this._foregroundFolderWindowCount = 0;
    // Map<local message_id, Promise<{ fetched }>>. Tracks Email/get
    // body fetches that are currently in flight. Two callers asking
    // for the same body (e.g. the EmailDelivery push handler
    // prefetching eagerly and the user clicking the new message
    // before that finishes) share the single round trip via this
    // map instead of firing it twice. The body_fetched_at column
    // dedups across separate ensureMessageBodies calls, but it's
    // checked at the start of each call and doesn't catch overlap
    // before the first finishes.
    this._bodyFetchInflight = new Map();
    /** @type {Map<number, Promise<{ fetched: number, cached?: boolean }>>}
     *  Display-path body fetches. Not shared with batch prefetch promises
     *  so a click during an in-flight ensureMessageBodies batch does not
     *  wait for the whole batch. */
    this._bodyPriorityInflight = new Map();
    // Cap on how many bodies we eagerly prefetch per push. A long
    // offline catch-up can land hundreds of newly-visible ids at
    // once; we fetch only the most recent few and let the rest
    // fall back to click-time fetch.
    this._eagerBodyPrefetchCap = options.eagerBodyPrefetchCap ?? 10;
    // Indexer tuning. The indexer can run for large folders while the
    // user is actively reading mail, so its work must be split into
    // foreground-sized chunks. Each chunk writes query_view_items,
    // messages, addresses, keywords, and folder membership through the
    // single OPFS SQLite connection; large background chunks make a
    // user-driven scroll/body read wait behind that write lock even
    // when the JMAP response itself is already back.
    //
    // Five 100-row chunks per tick still covers 500 positions every
    // ~250 ms tick when idle, but gives foreground ensureFolderWindow
    // calls a chance to interrupt between bounded SQLite transactions.
    // _selectIndexerChunkSize still clamps against
    // urn:ietf:params:jmap:core's maxObjectsInGet so we never ask for
    // more records than the server is willing to return.
    this._indexerTickDelayMs = options.indexerTickDelayMs ?? 250;
    this._indexerChunksPerTick = options.indexerChunksPerTick ?? 5;
    // Per-folder indexer failure backoff, in-memory only (a restart
    // resets it). A folder whose sync throws — or that returns without
    // advancing coverage — is skipped until its backoff expires, so
    // one bad folder can neither hot-loop the tick nor starve the
    // folders ordered behind it. 30 s base is 120 ticks: a stuck
    // folder drops from four probes/second to two/minute, and the 15
    // min cap bounds a permanently-dead folder to four probes/hour.
    this._indexerFolderFailures = new Map();
    this._indexerFailureBackoffBaseMs = options.indexerFailureBackoffBaseMs ?? 30_000;
    this._indexerFailureBackoffMaxMs = options.indexerFailureBackoffMaxMs ?? 15 * 60_000;
    // Consecutive whole-tick failures (candidate SQL or the session
    // capability probe throwing before the folder loop) back the
    // scheduler itself off exponentially up to this cap.
    this._indexerTickFailures = 0;
    this._indexerTickMaxDelayMs = options.indexerTickMaxDelayMs ?? 30_000;
    // Created in start() once we know our local account.id. Owns the
    // pending_mutations drain loop: auto-draining on insert (via the
    // makeHandlers hook), on StateChange (any push that signals the
    // WS is live also signals it can carry our queued writes), and on
    // backoff timer expiry. See sync/backends/jmap/outbox-runner.js.
    /** @type {import('./outbox-runner').OutboxRunner | null} */
    this.outboxRunner = null;
    this._outboxRunnerOptions = options.outboxRunnerOptions ?? null;
    this._bootstrappedPromise = null;
    this._contactsTrashReady = false;
    this._contactsTrashRefresh = null;
    // StateChange serialization. The transport delivers push frames
    // by firing each registered listener synchronously, without
    // awaiting the Promise the listener returns; if it awaited we
    // would block the message pump. So without explicit
    // serialization here, two pushes arriving in quick succession
    // (the EmailDelivery + Email pair Stalwart emits on a new-mail
    // delivery is the canonical case) start two concurrent
    // _doStateChange invocations which can race.
    //
    // The fix is the same pattern OutboxRunner uses for its drain
    // queue: one inflight pass at a time, with a coalescing pending
    // bucket that the trailing iteration of the inflight loop picks
    // up. Frames arriving during a pass merge into the bucket; a
    // trailing iteration then runs once with the union.
    this._stateChangeInflight = null;
    this._stateChangePending = null;
    this._stateChangeRetryPending = null;
    this._stateChangeRetryTimer = null;
    this._stateChangeRetryDelayMs = options.stateChangeRetryDelayMs ?? 1_000;
    // Reconnect supervisor. The transport rejects pending requests
    // on close but does not reopen the socket itself; without this
    // a single network blip leaves push notifications dead until
    // the user reloads. Exponential backoff between attempts
    // (1s → 30s by default) so we don't hammer a dead server, and
    // the supervisor only runs while _started is true so explicit
    // teardown (stop, sign-out, account switch) cleanly stops it.
    this._unsubClose = null;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 1_000;
    this._reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
    // Submission-sync serialization, same single-flight + trailing-pass
    // pattern as StateChange. The wake timer targets the account's
    // nearest pending sendAt.
    this._submissionSyncInflight = null;
    this._submissionSyncQueued = false;
    this._submissionSyncFailures = 0;
    this._submissionWakeTimer = null;
  }

  _resetContactsTrashReadiness() {
    this._contactsTrashReady = false;
  }

  _refreshContactsTrash(): Promise<ContactsTrashReadiness> {
    if (this._contactsTrashRefresh) return this._contactsTrashRefresh;
    const refresh = this.ensureContactsTrash()
      .then(() => {
        this._contactsTrashReady = true;
        return { ok: true as const };
      })
      .catch((error) => {
        this._contactsTrashReady = false;
        wlog.warn('jmap-backend', 'contacts trash refresh failed', error);
        return {
          ok: false as const,
          error: contactsTrashReadinessError(error),
        };
      })
      .finally(() => {
        if (this._contactsTrashRefresh === refresh) {
          this._contactsTrashRefresh = null;
        }
      });
    this._contactsTrashRefresh = refresh;
    return refresh;
  }

  async _contactsTrashReadyForMutation(): Promise<ContactsTrashReadiness> {
    if (this._contactsTrashReady) return { ok: true };
    if (!this._started) {
      return {
        ok: false,
        error: { type: 'contactsTrashUnavailable' },
      };
    }
    return this._refreshContactsTrash();
  }

  async _processMutationRow(row: any) {
    if (CONTACTS_TRASH_GATED_MUTATIONS.has(row.mutation_type)) {
      const readiness = await this._contactsTrashReadyForMutation();
      if (!readiness.ok) return readiness;
    }
    return processMutationRow({
      transport: this.transport,
      account: this.account,
      handlers: this.handlers,
      row,
      useWebSocket: this._wsReady(),
    });
  }

  /**
   * start() returns as soon as the local account row + the folder tree
   * are populated. Identities, contacts, and the WebSocket are kicked
   * off in the background after start() resolves so the UI can paint a
   * folder list within a single round trip of "login complete".
   */
  async start() {
    if (this._started) {
      return;
    }
    wlog.info('jmap-backend', 'fetchSession');
    const session = await this.transport.fetchSession();
    wlog.info('jmap-backend', `session ok, primaryMail=${session.primaryAccounts?.['urn:ietf:params:jmap:mail']}, caps=${Object.keys(session.capabilities ?? {}).length}`);
    const ingest = await ingestSession({
      session,
      serverOrigin: this.serverOrigin,
      handlers: this.handlers,
    });
    this.account = ingest.account;
    this.services = ingest.services;
    this.sharedAccounts = ingest.sharedAccounts ?? [];
    this._accountsByLocalId = new Map(
      [this.account, ...this.sharedAccounts].map((a) => [Number(a.id), a]),
    );
    this._accountsByRemoteId = new Map(
      [this.account, ...this.sharedAccounts].map((a) => [a.remote_account_id, a]),
    );
    wlog.info('jmap-backend', `account ingested id=${this.account.id} remote=${this.account.remote_account_id} services=${this.services.map((s) => s.serviceKind).join(',')} shared=${this.sharedAccounts.length}`);
    this._resetContactsTrashReadiness();

    // Build the runner once the account row exists. processRow gets
    // the current transport / useWebSocket at call time so the
    // runner doesn't capture a stale snapshot if the backend later
    // flips between HTTP and WS.
    //
    // onForegroundChange wires the same counter the user-driven
    // ensureFolderWindow path uses, so the metadata indexer's
    // between-chunks yield gate (`_foregroundFolderWindowCount > 0`
    // in _runMetadataIndexerChunk and ensureFolderIndex) also yields
    // for in-flight outbox mutations. Without this, a delete that
    // arrived mid-indexer-tick had to wait for the remaining 5x100
    // row chunks (~500 ms of held engine lock) before its own SQL
    // could run, and the user saw ~1.2 s per click against a local
    // Stalwart.
    const runnerOptions = {
      ...(this._outboxRunnerOptions ?? {}),
      maxAttemptsByType: {
        [MUTATION_TYPES.SAVE_DRAFT]: DRAFT_SAVE_MAX_ATTEMPTS,
        ...(this._outboxRunnerOptions?.maxAttemptsByType ?? {}),
      },
      // These writes have irreversible or ambiguous calls. Their durable
      // phases route recovered rows through protocol-specific verification.
      unsafeToReplayTypes: UNSAFE_TO_REPLAY_MUTATION_TYPES,
      replayablePhases: REPLAYABLE_MUTATION_PHASES,
      completedPhases: COMPLETED_MUTATION_PHASES,
      onForegroundChange: (delta) => {
        this._foregroundFolderWindowCount = Math.max(
          0,
          this._foregroundFolderWindowCount + delta,
        );
      },
    };
    this.outboxRunner = new OutboxRunner({
      accountId: this.account.id,
      handlers: this.handlers,
      processRow: (row) => this._processMutationRow(row),
      options: runnerOptions,
    });
    // Reclaim rows stranded in_flight by an earlier crash. Migration 002
    // only covers the boot that applied it, so this has to run on every
    // start or a crashed row is stuck forever.
    try {
      await this.outboxRunner.recoverStranded();
    } catch (err) {
      wlog.warn('jmap-backend', 'stranded outbox recovery failed', err);
    }

    const mbResult = await syncMailboxes({
      transport: this.transport,
      account: this.account,
      handlers: this.handlers,
    });
    wlog.info('jmap-backend', `syncMailboxes -> ${mbResult.count} folders, state=${mbResult.state}`);

    // Shared accounts: pull their mailbox trees too so shared folders
    // are visible in the sidebar / subscription manager. Best effort —
    // a failing shared account must not block the user's own mail.
    for (const shared of this.sharedAccounts) {
      try {
        const sharedResult = await syncMailboxes({
          transport: this.transport,
          account: shared,
          handlers: this.handlers,
          repairArchive: false,
        });
        wlog.info('jmap-backend', `syncMailboxes shared account ${shared.remote_account_id} -> ${sharedResult.count} folders`);
      } catch (err) {
        wlog.warn('jmap-backend', `shared account ${shared.remote_account_id} mailbox sync failed`, err);
      }
    }

    this._started = true;

    // Fire-and-forget background bootstrap: identities, contacts, then
    // open the WebSocket. The UI is already painting from the folder
    // table at this point; nothing here blocks the user. Tests can
    // await bootstrapped() to know when this chain is done.
    this._bootstrappedPromise = this._continueBootstrap().catch((err) => {
      wlog.error('jmap-backend', 'background bootstrap failed', err);
    });
  }

  /**
   * Promise that resolves once the background bootstrap chain
   * (identities, contacts, WebSocket open) finishes. Useful in tests
   * and for any caller that wants to wait for the post-folders sync.
   */
  bootstrapped() {
    return this._bootstrappedPromise ?? Promise.resolve();
  }

  async _continueBootstrap() {
    // Identities and contacts are auxiliary to the mail list. A
    // transient failure on Identity/get or any contacts call must NOT
    // abort the rest of the bootstrap chain: the mail-view catch-up
    // below (_refreshActiveQueryViews) is what reconciles a warm
    // relogin's persisted inbox against the server, and on a fresh
    // login the inbox is painted from last session's
    // query_view_items. If an identities/contacts error short-circuited
    // _continueBootstrap, that catch-up would never run and a
    // returning user would keep looking at stale mail until they
    // manually refreshed. Each auxiliary step is therefore isolated so
    // its failure degrades only itself.
    try {
      const idResult = await syncIdentities({
        transport: this.transport,
        account: this.account,
        handlers: this.handlers,
      });
      wlog.info('jmap-backend', `syncIdentities -> ${idResult.count} identities`);
    } catch (err) {
      wlog.warn('jmap-backend', 'syncIdentities failed; continuing bootstrap', err);
    }

    try {
      await this.ensureSettings();
    } catch (err) {
      wlog.warn('jmap-backend', 'settings sync failed; continuing bootstrap', err);
    }

    await this._refreshContactsTrash();
    // Sweep persisted mutations after remote trash has had its startup sync.
    this.outboxRunner?.notify();

    if (this._hasContactsService()) {
      try {
        const abResult = await syncAddressBooks({
          transport: this.transport,
          account: this.account,
          handlers: this.handlers,
        });
        wlog.info('jmap-backend', `syncAddressBooks -> ${abResult.count}`);
        const cResult = await syncContacts({
          transport: this.transport,
          account: this.account,
          handlers: this.handlers,
        });
        wlog.info('jmap-backend', `syncContacts -> ${cResult.fetched} fetched of ${cResult.total}`);
      } catch (err) {
        wlog.warn('jmap-backend', 'contacts sync failed; continuing bootstrap', err);
      }
    }

    let recipientUsage: { scanned: number; ranked: number } | null = null;
    try {
      const usage = await this._refreshRecipientUsage();
      recipientUsage = usage;
      wlog.info(
        'jmap-backend',
        `recipient usage -> scanned ${usage.scanned}, ranked ${usage.ranked}`,
      );
    } catch (err) {
      wlog.warn('jmap-backend', 'recipient usage rebuild failed; continuing bootstrap', err);
    }

    if (recipientUsage && this._hasContactsService()) {
      try {
        const result = await this.importRecentRecipients(recipientUsage.scanned);
        const status = result.alreadyImported
          ? 'already complete'
          : (result.deferred ? 'deferred' : 'completed');
        wlog.info(
          'jmap-backend',
          `recent recipient import -> ${status}, considered ${result.considered}`,
        );
      } catch (err) {
        wlog.warn('jmap-backend', 'recent recipient import failed; continuing bootstrap', err);
      }
    }

    // Each step above swallows its own failure, so teardown cannot stop
    // this chain by making a call fail. Check for it directly instead:
    // everything below either opens a socket or arms something that
    // outlives this function, and a stopped backend must do neither.
    if (!this._started) return;

    if (this.useWebSocket) {
      const pushState = await this._loadPushState();
      try {
        await this.transport.openWebSocket(this._subscribedTypes(), pushState);
        wlog.info('jmap-backend', 'WebSocket open, push enabled');
        // Now that the WS is up, any pending mutations that failed
        // mid-restart (or that landed on disk while we were on HTTP)
        // can finally go out. Cheap if the queue is empty.
        this.outboxRunner?.notify();
      } catch (err) {
        wlog.warn('jmap-backend', 'WebSocket unavailable; staying on HTTP', err);
      }
    }
    // stop() unsubscribes these; re-check so a teardown that happened
    // while the socket was opening does not get them back.
    if (!this._started) return;
    this._unsubStateChange = this.transport.onStateChange(
      (change) => this._onStateChange(change),
    );
    this._unsubClose = this.transport.onClose(
      (event) => this._onTransportClose(event),
    );
    // Catch up on whatever changed while we were disconnected. The
    // WebSocketPushEnable+pushState handshake is supposed to deliver
    // a StateChange for any types that moved, but servers may decline
    // to push when the stored pushState is unrecognised (e.g. after a
    // restart) and EmailDelivery only fires for new mail, not for
    // destroys or moves done elsewhere. Running queryChanges per
    // active view here makes the first repaint authoritative without
    // waiting for the user to refresh.
    for (const account of this._sessionAccounts()) {
      await this._refreshActiveQueryViews(account).catch((err) => {
        wlog.warn(
          'jmap-backend',
          `startup view catch-up failed for ${account.remote_account_id}`,
          err,
        );
      });
    }
    // Catch up on schedules that released or were canceled while this
    // client was away, and arm the nearest-sendAt wake-up. Nothing later
    // in bootstrap depends on it, so it does not gate bootstrapped().
    this._syncSubmissions().catch((err) => {
      wlog.warn('jmap-backend', 'startup submission sync failed', err);
      this._armSubmissionWake(Date.now() + this._submissionRetryDelayMs());
    });
    this._scheduleMetadataIndexer(1_000);
  }

  authenticationUpdated() {
    if (!this._started
        || !this.useWebSocket
        || !this._unsubClose
        || this.transport.isWebSocketOpen()) return;
    this._onTransportClose({});
  }

  async stop() {
    if (this._stateChangeRetryTimer) {
      clearTimeout(this._stateChangeRetryTimer);
      this._stateChangeRetryTimer = null;
    }
    this._stateChangeRetryPending = null;
    if (!this._started) return;
    // Flip _started first so the reconnect supervisor's onClose
    // listener (which we are about to fire via closeWebSocket)
    // recognises the close as intentional and skips its backoff
    // scheduling. Same reasoning for cancelling any pending
    // reopen timer up front.
    this._started = false;
    this._resetContactsTrashReadiness();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._unsubClose?.();
    this._unsubClose = null;
    this._unsubStateChange?.();
    this._unsubStateChange = null;
    if (this._indexerTimer) {
      clearTimeout(this._indexerTimer);
      this._indexerTimer = null;
    }
    if (this._submissionWakeTimer) {
      clearTimeout(this._submissionWakeTimer);
      this._submissionWakeTimer = null;
    }
    this._submissionSyncFailures = 0;
    // Cancel in-flight network calls before waiting on the runner.
    // OutboxRunner.stop() awaits the in-flight drain, and a drain
    // parked on a request that the server never answers would hold
    // teardown open for the whole request deadline.
    this.transport.abort();
    if (this.outboxRunner) {
      await this.outboxRunner.stop();
      this.outboxRunner = null;
    }
    this.transport.closeWebSocket();
  }

  // ----- SyncClient.Backend surface -----------------------------------

  async ensureFolderTree() {
    const result = await syncMailboxes({
      transport: this.transport,
      account: this.account,
      handlers: this.handlers,
      useWebSocket: this._wsReady(),
    });
    for (const shared of this.sharedAccounts) {
      try {
        await syncMailboxes({
          transport: this.transport,
          account: shared,
          handlers: this.handlers,
          useWebSocket: this._wsReady(),
          repairArchive: false,
        });
      } catch (err) {
        wlog.warn('jmap-backend', `shared account ${shared.remote_account_id} folder tree refresh failed`, err);
      }
    }
    return result;
  }

  async ensureFolderWindow(folderId: number, range: any = {}) {
    this._foregroundFolderWindowCount += 1;
    try {
      const folder = await this._loadFolder(folderId);
      this._maybeSyncSubmissionsForFolder(folder);
      const defaultSort = await this._defaultSortFor(folder);
      const sortProp = range.sortProp ?? defaultSort.sortProp;
      const sortAscending = range.sortAscending
        ?? (range.sortProp == null ? defaultSort.sortAscending : false);
      const r = await syncFolderWindow({
        transport: this.transport,
        account: this._accountForFolder(folder),
        folder,
        handlers: this.handlers,
        sortProp,
        sortAscending,
        position: range.offset ?? 0,
        limit: range.limit ?? 100,
        anchor: range.anchor ?? null,
        anchorOffset: range.anchorOffset ?? 0,
        collapseThreads: range.collapseThreads ?? false,
        useWebSocket: this._wsReady(),
      });
      wlog.info(
        'jmap-backend',
        `ensureFolderWindow offset=${range.offset ?? 0} anchor=${range.anchor ?? ''} fetched=${r?.fetched ?? 0} total=${r?.total ?? '?'}`,
      );
      return r;
    } finally {
      this._foregroundFolderWindowCount = Math.max(0, this._foregroundFolderWindowCount - 1);
    }
  }

  /**
   * Opening the Scheduled mailbox is a natural moment for the schedule
   * columns to be fresh (the user is looking right at them), so it
   * triggers a fire-and-forget submission pass alongside the normal
   * window sync.
   */
  _maybeSyncSubmissionsForFolder(folder: any) {
    if (!folder || Number(folder.account_id) !== Number(this.account?.id)) return;
    void (async () => {
      const scheduledRemoteId = await readScheduledMailboxRemoteId(
        this.handlers,
        this.account.id,
      );
      if (!scheduledRemoteId || folder.remote_id !== scheduledRemoteId) return;
      await this._syncSubmissions();
    })().catch((err) => {
      wlog.warn('jmap-backend', 'scheduled-folder submission sync failed', err);
      this._armSubmissionWake(Date.now() + this._submissionRetryDelayMs());
    });
  }

  async _hasTrackedSchedules(accountId: number): Promise<boolean> {
    const rows = await this.handlers[DB_RPC.QUERY]({
      sql: `SELECT 1 FROM messages
             WHERE account_id = ? AND scheduled_undo_status IS NOT NULL
             LIMIT 1`,
      params: [accountId],
    });
    return rows.length > 0;
  }

  async ensureMessageBody(messageId) {
    return this.ensureMessageBodies([messageId]);
  }

  /**
   * Ensure a message body is available for the reading pane. Returns
   * immediately when body_fetched_at is set. On a cache miss, issues a
   * single-id fetch that does not piggyback on an in-flight prefetch
   * batch (see _bodyPriorityInflight).
   */
  async ensureMessageBodyForDisplay(messageId) {
    if (messageId == null) {
      return { fetched: 0 };
    }
    if (await this._bodyCached(messageId)) {
      return { fetched: 0, cached: true };
    }
    const existing = this._bodyPriorityInflight.get(messageId);
    if (existing) {
      return existing;
    }
    const promise = this._fetchBodiesForLocalIds([messageId]);
    this._bodyPriorityInflight.set(messageId, promise);
    promise.finally(() => {
      if (this._bodyPriorityInflight.get(messageId) === promise) {
        this._bodyPriorityInflight.delete(messageId);
      }
    });
    return promise;
  }

  async _bodyCached(messageId) {
    const rows = await this.handlers[DB_RPC.QUERY]({
      sql: 'SELECT body_fetched_at FROM messages WHERE id = ? LIMIT 1',
      params: [messageId],
    });
    return rows[0]?.body_fetched_at != null;
  }

  /**
   * Fetch and persist bodies for the given local message ids.
   *
   * Concurrent callers asking for any of the same ids share one
   * JMAP round trip: the first call registers a Promise in
   * `_bodyFetchInflight` keyed by local id, and any later call
   * arriving before that resolves piggy-backs on the same
   * promise rather than firing a duplicate Email/get. The
   * `body_fetched_at IS NULL` filter inside `_fetchBodiesForLocalIds`
   * handles the orthogonal "already in the DB" case.
   */
  async ensureMessageBodies(messageIds = []) {
    const ids = [...new Set((messageIds ?? []).filter((id) => id != null))];
    if (ids.length === 0) return { fetched: 0 };

    const fresh = [];
    const piggyback = [];
    for (const id of ids) {
      const existing = this._bodyFetchInflight.get(id);
      if (existing) piggyback.push(existing);
      else fresh.push(id);
    }

    let freshPromise = null;
    if (fresh.length > 0) {
      freshPromise = this._fetchBodiesForLocalIds(fresh);
      for (const id of fresh) this._bodyFetchInflight.set(id, freshPromise);
      freshPromise
        .catch(() => {
          // Errors propagate to the caller via the awaited promise
          // below; the catch here is only to prevent an unhandled
          // rejection warning from the bookkeeping branch.
        })
        .finally(() => {
          for (const id of fresh) {
            if (this._bodyFetchInflight.get(id) === freshPromise) {
              this._bodyFetchInflight.delete(id);
            }
          }
        });
    }

    const settled = await Promise.all(
      [freshPromise, ...piggyback].filter(Boolean),
    );
    let fetched = 0;
    for (const result of settled) {
      fetched += Number(result?.fetched ?? 0);
    }
    return { fetched };
  }

  async _fetchBodiesForLocalIds(ids) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await this.handlers[DB_RPC.QUERY]({
      sql: `SELECT remote_id, account_id
              FROM messages
             WHERE id IN (${placeholders})
               AND body_fetched_at IS NULL`,
      params: ids,
    });
    // Group by owning account so bodies in shared-account folders are
    // fetched with the right JMAP accountId and persisted under the
    // right local account row.
    const byAccount = new Map();
    for (const row of rows) {
      if (!row.remote_id) continue;
      const accountId = Number(row.account_id);
      if (!byAccount.has(accountId)) byAccount.set(accountId, []);
      byAccount.get(accountId).push(row.remote_id);
    }
    if (byAccount.size === 0) return { fetched: 0 };
    let fetched = 0;
    for (const [accountId, remoteIds] of byAccount) {
      const account = this._accountsByLocalId.get(accountId)
        ?? (Number(this.account?.id) === accountId ? this.account : null);
      if (!account) {
        wlog.warn('jmap-backend', `body fetch skipped for unknown local account ${accountId}`);
        continue;
      }
      const result = await fetchEmailBodies({
        transport: this.transport,
        account,
        handlers: this.handlers,
        remoteIds,
        useWebSocket: this._wsReady(),
      });
      fetched += Number(result?.fetched ?? 0);
    }
    return { fetched };
  }

  async ensureFolderIndex(folderId: number, options: any = {}) {
    const folder = await this._loadFolder(folderId);
    const folderAccount = this._accountForFolder(folder);
    const defaultSort = await this._defaultSortFor(folder);
    const sortProp = options.sortProp ?? defaultSort.sortProp;
    const sortAscending = options.sortAscending
      ?? (options.sortProp == null ? defaultSort.sortAscending : false);
    const limit = Math.max(1, Math.min(Number(options.limit ?? 100), 500));
    const maxChunks = Math.max(1, Number(options.maxChunks ?? 1));
    // Caller can opt out of mid-tick yielding (foreground callers
    // and unit tests don't want their chunks aborted by a parallel
    // ensureFolderWindow). The indexer tick sets this to true so
    // it can give the WS back to a user-driven page load between
    // chunks; foreground callers leave it false so a single
    // ensureFolderWindow with limit > PAGE_SIZE doesn't tear itself
    // up by raising _foregroundFolderWindowCount on its own entry.
    const yieldToForeground = options.yieldToForeground === true;
    let offset = Number(options.offset ?? 0);
    let total = Number(options.total ?? folder.total_emails ?? 0);
    let fetched = 0;
    for (let i = 0; i < maxChunks; i += 1) {
      if (yieldToForeground && this._foregroundFolderWindowCount > 0) {
        // Foreground request arrived (user scrolled, clicked, etc.);
        // give the WS back. The next indexer tick will resume from
        // the same gap with the latest progress.
        break;
      }
      const gap = await this._nextQueryViewGap({
        folder,
        sortProp,
        sortAscending,
        startAt: offset,
        total,
        limit,
      });
      if (!gap) break;
      const result = await syncFolderWindow({
        transport: this.transport,
        account: folderAccount,
        folder,
        handlers: this.handlers,
        sortProp,
        sortAscending,
        position: gap.offset,
        limit: gap.limit,
        collapseThreads: false,
        useWebSocket: this._wsReady(),
      });
      fetched += result?.fetched ?? 0;
      total = Number(result?.total ?? total);
      offset = gap.offset + gap.limit;
      if ((result?.ids?.length ?? 0) === 0) {
        // A JMAP query result is a dense list: empty at this position
        // means the server's real result ends here (or its advertised
        // total was overstated), so later offsets can only be empty
        // too. Without this break, the effectiveTotal<=0 fallback in
        // _nextQueryViewGap — which ignores startAt — re-issues the
        // identical position-0 probe for every remaining chunk.
        break;
      }
    }
    return { fetched, total };
  }

  _scheduleMetadataIndexer(delayMs) {
    if (!this._started || this._indexerTimer) return;
    const effectiveDelay = Number.isFinite(delayMs)
      ? delayMs
      : this._indexerTickDelayMs;
    this._indexerTimer = setTimeout(() => {
      this._indexerTimer = null;
      this._runMetadataIndexerChunk()
        .then(() => {
          this._indexerTickFailures = 0;
        })
        .catch((err) => {
          // Whole-tick failures (candidate SQL, the session capability
          // probe, or a scaffolding bug) never reach the network, but
          // without backoff they would spin the worker and flood the
          // log every 250 ms forever. Back off exponentially, capped,
          // until a tick succeeds again.
          this._indexerTickFailures += 1;
          wlog.warn('jmap-backend', 'metadata indexer failed', err);
        })
        .finally(() => {
          if (this._started) this._scheduleMetadataIndexer(this._indexerTickFailureDelayMs());
        });
    }, effectiveDelay);
  }

  _indexerTickFailureDelayMs() {
    if (this._indexerTickFailures === 0) return this._indexerTickDelayMs;
    return Math.min(
      this._indexerTickDelayMs * 2 ** this._indexerTickFailures,
      this._indexerTickMaxDelayMs,
    );
  }

  /**
   * One indexer tick. Picks the highest-priority folder that still
   * has uncovered positions and runs up to `_indexerChunksPerTick`
   * back-to-back Email/query+Email/get round trips against it. The
   * per-chunk size scales with folder size (see
   * `_selectIndexerChunkSize`) and is clamped against the server's
   * advertised maxObjectsInGet.
   *
   * `break` after one SUCCESSFUL folder per tick is intentional: it
   * keeps the WS connection serving a predictable single-folder
   * stream and yields to any foreground ensureFolderWindow the user
   * kicks off mid-flight (which would bump
   * _foregroundFolderWindowCount and stall the *next* tick at the
   * gate above).
   *
   * A folder whose sync throws (e.g. a still-subscribed shared
   * mailbox whose mayReadItems was revoked, so Email/query answers a
   * JMAP error tuple) or that returns without advancing coverage (an
   * overstated server total whose tail pages keep coming back empty)
   * must not abort the tick: the failure is recorded in
   * `_indexerFolderFailures` with exponential backoff and the tick
   * moves on to the next candidate, so one bad folder neither
   * hot-loops every 250 ms nor starves every folder ordered behind
   * it. At most INDEXER_MAX_FAILED_ATTEMPTS_PER_TICK failing folders
   * are walked per tick, bounding the burst when an entire account
   * is failing.
   *
   * Shared accounts are indexed too, but only after every primary
   * folder is covered, and only for folders the sidebar actually
   * renders — subscribed shared folders, per FM-6.9.
   */
  async _runMetadataIndexerChunk() {
    if (this._indexerRunning || !this.account) return;
    if (this._foregroundFolderWindowCount > 0) return;
    this._indexerRunning = true;
    try {
      const serverCap = await this._loadMaxObjectsInGetCap();
      const accountIds = this._sessionAccounts().map((a) => Number(a.id));
      const placeholders = accountIds.map(() => '?').join(',');
      const primaryId = Number(this.account.id);
      const folders = await this.handlers[DB_RPC.QUERY]({
        sql: `SELECT *
                FROM folders
               WHERE account_id IN (${placeholders})
                 AND is_deleted = 0
                 AND COALESCE(total_emails, 0) > 0
                 AND (account_id = ? OR COALESCE(is_subscribed, 0) != 0)
               ORDER BY CASE WHEN account_id = ? THEN 0 ELSE 1 END,
                        CASE role
                          WHEN 'inbox' THEN 0
                          WHEN 'sent' THEN 1
                          WHEN 'archive' THEN 2
                          ELSE 3
                        END,
                        COALESCE(total_emails, 0) DESC`,
        params: [...accountIds, primaryId, primaryId],
      });
      this._pruneIndexerFolderFailures(folders);
      let failedAttempts = 0;
      for (const folder of folders) {
        const failure = this._indexerFolderFailures.get(folder.id);
        if (failure && failure.nextRetryAfter > Date.now()) {
          continue;
        }
        try {
          const progress = await this._queryViewProgress(folder);
          if (progress.total > 0 && progress.covered >= progress.total) {
            this._indexerFolderFailures.delete(folder.id);
            continue;
          }
          const effectiveTotal = progress.total || Number(folder.total_emails ?? 0);
          const chunkLimit = this._selectIndexerChunkSize(effectiveTotal, serverCap);
          const result = await this.ensureFolderIndex(folder.id, {
            limit: chunkLimit,
            maxChunks: this._indexerChunksPerTick,
            total: effectiveTotal,
            yieldToForeground: true,
          });
          if ((result?.fetched ?? 0) > 0) {
            wlog.info(
              'jmap-backend',
              `metadata indexer account=${this._accountForFolder(folder).remote_account_id} folder=${folder.name} fetched=${result.fetched} total=${result.total} chunkLimit=${chunkLimit}`,
            );
            this._indexerFolderFailures.delete(folder.id);
            break;
          }
          // The sync returned without throwing but fetched nothing.
          // It only counts as stuck when coverage did not move at
          // all: a concurrent foreground sync may have advanced it,
          // and a server that corrected an overstated total downward
          // may have completed it — neither is a failure.
          const after = await this._queryViewProgress(folder);
          const advanced = after.covered > progress.covered;
          const complete = after.total > 0 && after.covered >= after.total;
          if (advanced || complete) {
            this._indexerFolderFailures.delete(folder.id);
            break;
          }
          this._markIndexerFolderFailed(folder, 'no coverage progress');
          failedAttempts += 1;
        } catch (err) {
          this._markIndexerFolderFailed(folder, err);
          failedAttempts += 1;
        }
        if (failedAttempts >= INDEXER_MAX_FAILED_ATTEMPTS_PER_TICK) break;
      }
    } finally {
      this._indexerRunning = false;
    }
  }

  /**
   * Record an indexer failure for one folder and skip it until the
   * backoff expires. The entry is cleared the next time the folder
   * makes progress, becomes fully covered, or leaves the candidate
   * set; user-visible folders usually recover sooner through the
   * foreground / push sync paths, which never consult this map.
   */
  _markIndexerFolderFailed(folder, reason) {
    const prev = this._indexerFolderFailures.get(folder.id);
    const count = (prev?.count ?? 0) + 1;
    const delay = Math.min(
      this._indexerFailureBackoffBaseMs * 2 ** (count - 1),
      this._indexerFailureBackoffMaxMs,
    );
    this._indexerFolderFailures.set(folder.id, {
      count,
      nextRetryAfter: Date.now() + delay,
    });
    wlog.warn(
      'jmap-backend',
      `metadata indexer folder=${folder.name} attempt ${count} failed; retry in ${delay}ms`,
      reason,
    );
  }

  /** Drop failure entries for folders no longer in the candidate set. */
  _pruneIndexerFolderFailures(folders) {
    if (this._indexerFolderFailures.size === 0) return;
    const candidateIds = new Set(folders.map((f) => Number(f.id)));
    for (const id of [...this._indexerFolderFailures.keys()]) {
      if (!candidateIds.has(id)) this._indexerFolderFailures.delete(id);
    }
  }

  /**
   * Background indexer chunk-size selection.
   *
   * Keep chunks aligned with the foreground page size. Bigger chunks
   * improve idle throughput slightly, but they also hold the OPFS
   * SQLite lock across several hundred message/address/keyword writes.
   * That makes a user-driven folder window or body display wait behind
   * background indexing even when Stalwart answered quickly.
   *
   * Clamped against the server-advertised maxObjectsInGet so we
   * never trip a 'tooManyObjectsInGet' SetError (RFC 8620 §3.5).
   */
  _selectIndexerChunkSize(_folderTotal, serverCap) {
    const target = 100;
    const cap = Number.isFinite(serverCap) && serverCap > 0 ? serverCap : target;
    return Math.max(1, Math.min(target, cap));
  }

  async _loadMaxObjectsInGetCap() {
    return maxObjectsInGet(this.transport);
  }

  async _queryViewProgress(folder) {
    const { sortProp, sortAscending } = await this._defaultSortFor(folder);
    const filterJson = JSON.stringify({ inMailbox: folder.remote_id });
    const sortJson = JSON.stringify([{ property: sortProp, isAscending: sortAscending }]);
    const views = await this.handlers[DB_RPC.QUERY]({
      sql: `SELECT id, total
              FROM query_views
             WHERE account_id = ?
               AND view_type = 'mailbox-window'
               AND folder_id = ?
               AND filter_json = ?
               AND sort_json = ?
               AND collapse_threads = 0`,
      params: [this._accountForFolder(folder).id, folder.id, filterJson, sortJson],
    });
    const view = views[0];
    if (!view) {
      return { total: Number(folder.total_emails ?? 0), covered: 0 };
    }
    const ranges = await this.handlers[DB_RPC.QUERY]({
      sql: `SELECT start_position, end_position
              FROM query_view_ranges
             WHERE view_id = ?
             ORDER BY start_position, end_position`,
      params: [view.id],
    });
    const total = Number(view.total ?? folder.total_emails ?? 0);
    let covered = 0;
    let start = null;
    let end = null;
    for (const range of ranges) {
      const rs = Math.max(0, Math.min(Number(range.start_position ?? 0), total));
      const re = Math.max(0, Math.min(Number(range.end_position ?? 0), total));
      if (re <= rs) continue;
      if (start == null) {
        start = rs;
        end = re;
      } else if (rs <= end) {
        end = Math.max(end, re);
      } else {
        covered += end - start;
        start = rs;
        end = re;
      }
    }
    if (start != null) covered += end - start;
    return { total, covered };
  }

  async ensureIdentities() {
    return syncIdentities({
      transport: this.transport,
      account: this.account,
      handlers: this.handlers,
      useWebSocket: this._wsReady(),
    });
  }

  async ensureQuota() {
    return syncQuota({
      transport: this.transport,
      account: this.account,
      handlers: this.handlers,
      useWebSocket: this._wsReady(),
    });
  }

  /**
   * Live FUTURERELEASE capability for the compose scheduling UI. Forces
   * a session refetch so the answer (and the transport's server clock
   * reference) is current at the moment the user opens the dialog.
   */
  async getScheduleCapability() {
    return refreshScheduleCapability(this.transport, this.account);
  }

  async ensureSettings() {
    const result = await syncSettingsFromServer({
      transport: this.transport,
      account: this.account,
      handlers: this.handlers,
      useWebSocket: this._wsReady(),
    });
    if (result.ok === false) {
      const error: any = new Error(
        result.error.message ?? `Settings FileNode sync failed (${result.error.type})`,
      );
      Object.assign(error, result.error);
      throw error;
    }
    return result;
  }

  async ensureContactsTrash() {
    const result = await syncContactsTrashFromServer({
      transport: this.transport,
      account: this.account,
      handlers: this.handlers,
      useWebSocket: this._wsReady(),
    });
    if (result.ok === false) {
      const error: any = new Error(
        result.error.message ?? `Contacts trash FileNode sync failed (${result.error.type})`,
      );
      Object.assign(error, result.error);
      throw error;
    }
    return result;
  }

  async ensureAddressbooks() {
    if (!this._hasContactsService()) {
      return { count: 0, state: null };
    }
    return syncAddressBooks({
      transport: this.transport,
      account: this.account,
      handlers: this.handlers,
      useWebSocket: this._wsReady(),
    });
  }

  async inventoryAddressbook(addressbookId: number) {
    if (!this._hasContactsService()) {
      const error: any = new Error('Address book service is not available');
      error.type = 'addressBookServerUnavailable';
      throw error;
    }
    return inventoryAddressBook({
      transport: this.transport,
      account: this.account,
      handlers: this.handlers,
      addressbookId,
      useWebSocket: this._wsReady(),
    });
  }

  async ensureContacts(_addressbookId?: any) {
    if (!this._hasContactsService()) {
      return { fetched: 0 };
    }
    // For MVP we sync the whole account at once. addressbookId is
    // accepted by the SyncClient interface but not used for filtering;
    // ContactCard/query without a filter returns the account-wide set.
    return syncContacts({
      transport: this.transport,
      account: this.account,
      handlers: this.handlers,
      useWebSocket: this._wsReady(),
    });
  }

  /**
   * Serialize automatic historical promotion across overlapping bootstraps.
   * Ranking refreshes remain read-only with respect to contacts (CS-3.13).
   */
  importRecentRecipients(scanned: number) {
    const accountId = Number(this.account?.id);
    if (!Number.isFinite(accountId)) {
      throw new Error('Recent recipient import requires a local account');
    }
    let imports = RECIPIENT_IMPORT_INFLIGHT.get(this.handlers);
    if (!imports) {
      imports = new Map();
      RECIPIENT_IMPORT_INFLIGHT.set(this.handlers, imports);
    }
    const current = imports.get(accountId);
    if (current) return current;
    const tracked = this._importRecentRecipients(scanned);
    imports.set(accountId, tracked);
    const clear = () => {
      if (imports.get(accountId) === tracked) imports.delete(accountId);
    };
    void tracked.then(clear, clear);
    return tracked;
  }

  async _importRecentRecipients(scanned: number) {
    const prior = await this.handlers[DB_RPC.SYNC_STATE_GET]({
      accountId: this.account.id,
      objectType: 'RecentRecipientContactImport',
    });
    if (prior?.state) {
      return { considered: 0, alreadyImported: true, deferred: false };
    }
    if (scanned <= 0) {
      return { considered: 0, alreadyImported: false, deferred: true };
    }
    const rows = await this.handlers[DB_RPC.QUERY]({
      sql: `WITH recent AS (
              SELECT m.id AS message_id,
                     MAX(COALESCE(m.sent_at, fm.sort_sent_at)) AS sent_at
                FROM messages m
                JOIN folder_messages fm ON fm.message_id = m.id
                JOIN folders f ON f.id = fm.folder_id
               WHERE m.account_id = ?
                 AND f.account_id = ?
                 AND f.role = 'sent'
                 AND COALESCE(m.sent_at, fm.sort_sent_at) IS NOT NULL
               GROUP BY m.id
               ORDER BY sent_at DESC, m.id DESC
               LIMIT 300
            )
            SELECT r.message_id, r.sent_at, ma.kind, ma.name, ma.email
              FROM recent r
              JOIN message_addresses ma ON ma.message_id = r.message_id
             WHERE ma.email IS NOT NULL
             ORDER BY r.sent_at DESC, r.message_id DESC, ma.kind, ma.position`,
      params: [this.account.id, this.account.id],
    });
    const ownedRows = await this.handlers[DB_RPC.QUERY]({
      sql: `SELECT email FROM identities WHERE account_id = ?
            UNION
            SELECT primary_email AS email FROM accounts
             WHERE id = ? AND primary_email IS NOT NULL`,
      params: [this.account.id, this.account.id],
    });
    const owned = new Set(ownedRows.map((row) => addressKey(row.email)).filter(Boolean));
    const byMessage = new Map<number, any[]>();
    for (const row of rows) {
      const messageId = Number(row.message_id);
      const list = byMessage.get(messageId) ?? [];
      list.push(row);
      byMessage.set(messageId, list);
    }
    const recipients = new Map<
      string,
      { email: string; name: string | null; sourceSentAt: number; uid: string }
    >();
    for (const addresses of byMessage.values()) {
      if (!addresses.some((row) => row.kind === 'from' && owned.has(addressKey(row.email)))) {
        continue;
      }
      for (const row of addresses) {
        if (row.kind !== 'to' && row.kind !== 'cc' && row.kind !== 'bcc') continue;
        const key = addressKey(row.email);
        if (!key || owned.has(key) || recipients.has(key)) continue;
        recipients.set(key, {
          email: String(row.email).trim(),
          name: row.name?.trim() || null,
          sourceSentAt: Number(row.sent_at),
          uid: createContactUid(),
        });
      }
    }

    if (recipients.size > 0) {
      const inserted = await this.handlers[DB_RPC.PENDING_MUTATION_INSERT]({
        accountId: this.account.id,
        mutationType: MUTATION_TYPES.WHITELIST_SENDER,
        targetMessageId: null,
        requestJson: JSON.stringify({ senders: [...recipients.values()] }),
      });
      const result = await this.runMutation(inserted.id);
      if ((result?.failed ?? 0) > 0 || (result?.succeeded ?? 0) === 0) {
        throw new Error('Recent recipient import did not complete');
      }
    }
    await this.handlers[DB_RPC.SYNC_STATE_SET]({
      accountId: this.account.id,
      objectType: 'RecentRecipientContactImport',
      state: JSON.stringify({ completedAt: Date.now() }),
    });
    return { considered: recipients.size, alreadyImported: false, deferred: false };
  }

  async drainOutbox() {
    if (!this.outboxRunner) {
      return { attempted: 0, succeeded: 0, failed: 0 };
    }
    return this.outboxRunner.drain();
  }

  async runMutation(mutationId) {
    if (!this.outboxRunner) {
      return { attempted: 0, succeeded: 0, failed: 0 };
    }
    return this.outboxRunner.runMutation(mutationId);
  }

  attachmentLimits(localAccountId: number) {
    const account = this._accountForLocalId(localAccountId);
    return attachmentTransferLimits(this.transport, account);
  }

  async uploadComposeAttachment({
    accountId,
    blob,
    type,
    totalAttachmentBytes,
    signal,
    onProgress,
  }: {
    accountId: number;
    blob: Blob;
    type?: string;
    totalAttachmentBytes?: number;
    signal?: AbortSignal;
    onProgress?: (progress: any) => void;
  }) {
    const account = this._accountForLocalId(accountId);
    if (typeof Blob === 'undefined' || !(blob instanceof Blob)) {
      const error: any = new TypeError('Compose attachment upload requires a Blob or File');
      error.type = 'invalidBlob';
      throw error;
    }
    const limits = attachmentTransferLimits(this.transport, account);
    if (blob.size > limits.maxSizeUpload) {
      throw transferTooLargeError(
        `Attachment is ${blob.size} bytes, exceeding the ${limits.maxSizeUpload} byte upload limit`,
        limits.maxSizeUpload,
        blob.size,
      );
    }
    const totalBytes = totalAttachmentBytes ?? blob.size;
    if (
      !Number.isSafeInteger(totalBytes)
      || totalBytes < blob.size
      || totalBytes < 0
    ) {
      const error: any = new RangeError(
        'totalAttachmentBytes must be a non-negative safe integer at least as large as the uploaded Blob',
      );
      error.type = 'invalidAttachmentTotal';
      throw error;
    }
    if (totalBytes > limits.maxSizeAttachmentsPerEmail) {
      throw transferTooLargeError(
        `Attachments total ${totalBytes} bytes, exceeding the ${limits.maxSizeAttachmentsPerEmail} byte message limit`,
        limits.maxSizeAttachmentsPerEmail,
        totalBytes,
      );
    }
    const result = await this.transport.upload({
      accountId: account.remote_account_id,
      type: type || blob.type || 'application/octet-stream',
      body: blob,
      signal,
      onProgress,
    });
    if (
      typeof result?.accountId !== 'string'
      || typeof result?.blobId !== 'string'
      || !result.blobId
      || typeof result?.type !== 'string'
      || !Number.isSafeInteger(result?.size)
      || result.size < 0
    ) {
      const error: any = new Error('JMAP upload returned invalid metadata');
      error.type = 'invalidUploadResponse';
      throw error;
    }
    return result;
  }

  async downloadAttachment({
    accountId,
    blobId,
    type,
    name,
    maxBytes,
    truncateAtMaxBytes = false,
    signal,
    onProgress,
  }: {
    accountId: number;
    blobId: string;
    type?: string;
    name?: string;
    maxBytes?: number;
    truncateAtMaxBytes?: boolean;
    signal?: AbortSignal;
    onProgress?: (progress: any) => void;
  }) {
    const account = this._accountForLocalId(accountId);
    if (!blobId) {
      const error: any = new TypeError('Attachment download requires a blobId');
      error.type = 'invalidBlobId';
      throw error;
    }
    return this.transport.downloadBlob({
      accountId: account.remote_account_id,
      blobId,
      type: type ?? undefined,
      name: name ?? undefined,
      maxBytes,
      truncateAtMaxBytes,
      signal,
      onProgress,
    });
  }

  /**
   * Compatibility path for inline cid: images and truncated draft bodies.
   */
  async downloadBlob({
    accountId,
    blobId,
    type,
    name,
    signal,
    onProgress,
  }: {
    accountId: number;
    blobId: string;
    type?: string;
    name?: string;
    signal?: AbortSignal;
    onProgress?: (progress: any) => void;
  }) {
    if (!blobId) return null;
    const account = this._accountForLocalId(accountId);
    const bytes = await this.transport.download({
      accountId: account.remote_account_id,
      blobId,
      type: type ?? undefined,
      name: name ?? undefined,
      signal,
      onProgress,
    });
    return { base64: bytesToBase64(bytes), type: type ?? null };
  }

  // ----- WebSocket reconnect supervisor -------------------------------

  /**
   * Close listener registered with the transport. Fires for every
   * close — intentional or otherwise. _started is the policy gate:
   * stop() flips it false before calling closeWebSocket(), so this
   * handler distinguishes an intentional teardown from a network
   * blip by reading that flag.
   */
  _onTransportClose(_event: any) {
    if (!this._started) return;
    if (this._reconnectTimer) return;
    const attempt = this._reconnectAttempts;
    const delay = Math.min(
      this._reconnectBaseDelayMs * 2 ** attempt,
      this._reconnectMaxDelayMs,
    );
    this._reconnectAttempts = attempt + 1;
    wlog.info(
      'jmap-backend',
      `WebSocket closed; reopening in ${delay}ms (attempt ${this._reconnectAttempts})`,
    );
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      void this._reconnect();
    }, delay);
  }

  async _reconnect() {
    if (!this._started) return;
    this._resetContactsTrashReadiness();
    let pushState = this.transport.lastPushState;
    if (!pushState) {
      try {
        pushState = await this._loadPushState();
      } catch (err) {
        wlog.warn('jmap-backend', `reconnect push-state load failed: ${(err as any)?.message ?? err}`);
        if (this._started && !this._reconnectTimer) this._onTransportClose({});
        return;
      }
    }
    try {
      await this.transport.openWebSocket(this._subscribedTypes(), pushState);
    } catch (err) {
      wlog.warn('jmap-backend', `WebSocket reopen failed: ${(err as any)?.message ?? err}`);
      // openWebSocket may have failed before the underlying socket
      // ever emitted close, in which case our close listener never
      // fired. Schedule another attempt explicitly.
      if (this._started && !this._reconnectTimer) {
        this._onTransportClose({});
      }
      return;
    }
    if (!this._started) return;
    wlog.info('jmap-backend', 'WebSocket reopened');
    this._reconnectAttempts = 0;
    // An Identity push emitted while the socket was down is not replayed,
    // and there is no delta call for identities to fall back on, so a
    // reconnect is the only chance to notice an alias that changed while we
    // were away (CS-4.6).
    await this.ensureIdentities().catch((err) => {
      wlog.warn('jmap-backend', `reconnect identity refresh failed`, err);
    });
    await this.ensureSettings().catch((err) => {
      wlog.warn('jmap-backend', 'reconnect settings refresh failed', err);
    });
    await this._refreshContactsTrash();
    // Apply queued contact work only after pulling deletions from other clients.
    this.outboxRunner?.notify();
    for (const account of this._sessionAccounts()) {
      await this._refreshActiveQueryViews(account).catch((err) => {
        wlog.warn(
          'jmap-backend',
          `reconnect view refresh failed for ${account.remote_account_id}`,
          err,
        );
      });
    }
    await this._refreshRecipientUsage().catch((err) => {
      wlog.warn('jmap-backend', 'reconnect recipient usage refresh failed', err);
    });
    // EmailSubmission pushes emitted while the socket was down are not
    // replayed either; one pass re-reads whatever settled meanwhile.
    await this._syncSubmissions().catch((err) => {
      wlog.warn('jmap-backend', 'reconnect submission sync failed', err);
      this._armSubmissionWake(Date.now() + this._submissionRetryDelayMs());
    });
  }

  // ----- Send Later submission sync ------------------------------------

  /**
   * Run one level-based submission-sync pass for the primary account
   * (compose only schedules from it). Single-flight with a trailing
   * re-run, mirroring the StateChange pattern: triggers may fire as
   * often as they like — push, reconnect, Scheduled-folder open, wake
   * timer — and collapse into at most one queued follow-up pass.
   *
   * Each pass re-arms the wake timer from its own result, so the timer
   * always reflects the latest nearest pending sendAt.
   */
  _syncSubmissions(): Promise<void> {
    if (!this._started || !this.account) return Promise.resolve();
    if (this._submissionSyncInflight) {
      this._submissionSyncQueued = true;
      return this._submissionSyncInflight;
    }
    this._submissionSyncInflight = (async () => {
      try {
        do {
          this._submissionSyncQueued = false;
          const result = await syncSubmissionsForAccount({
            transport: this.transport,
            account: this.account,
            handlers: this.handlers,
            useWebSocket: this._wsReady(),
          });
          if (result.unresolvedSettled) this.outboxRunner?.notify();
          const clock = scheduleClockWindow(this.transport);
          const pendingWakeAt = result.nearestPendingAt == null
            ? null
            : Date.now() + Math.max(
              result.nearestPendingAt
                + SUBMISSION_RELEASE_OBSERVATION_DELAY_MS
                - clock.lowerMs,
              0,
            );
          const settledWakeAt = result.unresolvedSettled
            ? Date.now() + SUBMISSION_SETTLED_RECHECK_MS
            : null;
          this._armSubmissionWake(
            settledWakeAt == null
              ? pendingWakeAt
              : Math.min(settledWakeAt, pendingWakeAt ?? Infinity),
          );
        } while (this._submissionSyncQueued && this._started);
        this._submissionSyncFailures = 0;
      } catch (error) {
        this._submissionSyncFailures += 1;
        throw error;
      } finally {
        this._submissionSyncInflight = null;
      }
    })();
    return this._submissionSyncInflight;
  }

  _submissionRetryDelayMs() {
    return Math.min(
      SUBMISSION_SETTLED_RECHECK_MS
        * 2 ** Math.max(0, this._submissionSyncFailures - 1),
      SUBMISSION_WAKE_MAX_MS,
    );
  }

  _armSubmissionWake(wakeAt: number | null) {
    if (this._submissionWakeTimer) {
      clearTimeout(this._submissionWakeTimer);
      this._submissionWakeTimer = null;
    }
    if (!this._started || wakeAt == null || !Number.isFinite(wakeAt)) return;
    const delay = Math.min(
      Math.max(wakeAt - Date.now(), SUBMISSION_WAKE_MIN_MS),
      SUBMISSION_WAKE_MAX_MS,
    );
    this._submissionWakeTimer = setTimeout(() => {
      this._submissionWakeTimer = null;
      this._syncSubmissions().catch((err) => {
        wlog.warn('jmap-backend', 'submission wake-up sync failed', err);
        this._armSubmissionWake(Date.now() + this._submissionRetryDelayMs());
      });
    }, delay);
  }

  // ----- StateChange dispatch -----------------------------------------

  /**
   * Entry point called synchronously by the transport for every push
   * frame. Merges the incoming change into the pending bucket and
   * starts the inflight loop if it isn't already running. The
   * trailing iteration of the loop picks up any frames that arrived
   * during the current pass, so the EmailDelivery+Email burst (and
   * any other rapid sequence) collapses into one catch-up pass with
   * a unioned type-state map.
   *
   * Synchronous on purpose: returning a Promise to the transport
   * tempted earlier code to .catch() on it, which let two pushes
   * race because the transport never awaited the Promise. The
   * inflight loop now owns error handling.
   */
  _onStateChange(change) {
    if (!this.account) return;
    if (
      Object.hasOwn(
        change?.changed?.[this.account.remote_account_id] ?? {},
        'FileNode',
      )
    ) {
      this._resetContactsTrashReadiness();
    }
    if (this._stateChangeRetryPending) {
      change = mergeStateChange(this._stateChangeRetryPending, change);
      this._stateChangeRetryPending = null;
      if (this._stateChangeRetryTimer) {
        clearTimeout(this._stateChangeRetryTimer);
        this._stateChangeRetryTimer = null;
      }
    }
    this._stateChangePending = mergeStateChange(this._stateChangePending, change);
    if (this._stateChangeInflight) {
      // A pass is already running; it will see the updated pending
      // bucket on its next loop iteration.
      return;
    }
    this._stateChangeInflight = (async () => {
      try {
        // Yield once so frames arriving synchronously in the same
        // event-loop turn can merge into the pending bucket before
        // we consume it. Stalwart emits the EmailDelivery + Email
        // pair on new-mail delivery as two back-to-back WS frames
        // delivered in one message-pump turn; without this yield
        // the IIFE would read pending after the first frame, set
        // it to null, then race the second frame to write back —
        // and we'd end up running _doStateChange twice for one
        // logical delivery event.
        await Promise.resolve();
        while (this._stateChangePending) {
          const next = this._stateChangePending;
          this._stateChangePending = null;
          try {
            await this._doStateChange(next);
          } catch (err) {
            wlog.error('jmap-backend', 'StateChange dispatch failed', err);
          }
        }
      } finally {
        this._stateChangeInflight = null;
      }
    })();
  }

  /**
   * Visible for tests: resolves once the current StateChange pass
   * (and any trailing iteration the pending bucket has queued) has
   * finished. Production code does not need this — fire-and-forget
   * is the contract — but unit tests that drive the WS frame stream
   * synchronously need a deterministic completion signal.
   */
  async _stateChangeIdle() {
    while (this._stateChangeInflight) {
      await this._stateChangeInflight.catch(() => {});
    }
  }

  async _doStateChange({ changed, pushState }) {
    if (!this.account) return;
    // Any push frame, regardless of which JMAP type it carries, is
    // also a strong signal that the WebSocket is alive end-to-end.
    // Wake the outbox runner so anything queued during a transient
    // disconnect goes out now — this is how we get reconnect-retry
    // without having to add an explicit reconnect callback to the
    // transport layer.
    this.outboxRunner?.notify();

    const failedChanged: Record<string, Record<string, string>> = {};
    for (const account of this._sessionAccounts()) {
      const types = changed?.[account.remote_account_id];
      if (!types) continue;
      let failedTypes;
      try {
        failedTypes = await this._syncAccountStateChange(account, types);
      } catch (error) {
        failedTypes = { ...types };
        wlog.warn(
          'jmap-backend',
          `StateChange sync failed for ${account.remote_account_id}; continuing`,
          error,
        );
      }
      if (Object.keys(failedTypes).length > 0) {
        failedChanged[account.remote_account_id] = failedTypes;
      }
    }
    if (Object.keys(failedChanged).length > 0) {
      this._scheduleStateChangeRetry({ changed: failedChanged, pushState });
      return;
    }
    if (pushState) await this._persistPushState(pushState);
  }

  async _syncAccountStateChange(account, types) {
    let needViewRefresh = false;
    const viewRefreshTypes: string[] = [];
    const failedTypes: Record<string, string> = {};
    // Contact deletions must land before Email events from the same push so an
    // older Sent change cannot recreate a card another client just removed.
    // Address books precede cards because card membership depends on them.
    const priority = new Map([
      ['AddressBook', 0],
      ['ContactCard', 1],
      ['FileNode', 2],
      ['Identity', 3],
      ['Mailbox', 4],
      ['Email', 5],
      ['EmailDelivery', 6],
      ['Thread', 7],
      // After Email so a released schedule's mailbox move is already in
      // the cache when the submission pass reads placements.
      ['EmailSubmission', 8],
    ]);
    const orderedTypes = Object.keys(types).sort(
      (left, right) => (priority.get(left) ?? 99) - (priority.get(right) ?? 99),
    );
    for (const type of orderedTypes) {
      try {
        switch (type) {
          case 'Mailbox': {
            const sync = await this._loadSyncStateFor(account, 'Mailbox');
            const result = sync?.state
              ? await syncMailboxChanges({
                transport: this.transport,
                account,
                handlers: this.handlers,
                sinceState: sync.state,
                useWebSocket: this._wsReady(),
              })
              : { needsFullSync: true };
            if (result.needsFullSync) {
              await syncMailboxes({
                transport: this.transport,
                account,
                handlers: this.handlers,
                useWebSocket: this._wsReady(),
                repairArchive: account.id === this.account.id,
              });
            }
            if (
              account.id === this.account.id
              && !Object.hasOwn(types, 'EmailSubmission')
              && await this._hasTrackedSchedules(account.id)
            ) {
              void this._syncSubmissions().catch((err) => {
                wlog.warn('jmap-backend', 'mailbox-triggered submission sync failed', err);
                this._armSubmissionWake(Date.now() + this._submissionRetryDelayMs());
              });
            }
            break;
          }
          case 'Email': {
            const sync = await this._loadSyncStateFor(account, 'Email');
            if (sync?.state) {
              const result = await syncEmailChanges({
                transport: this.transport,
                account,
                handlers: this.handlers,
                sinceState: sync.state,
                useWebSocket: this._wsReady(),
              });
              if (result.needsFullSync && account.id === this.account.id) {
                await this._refreshRecipientUsage({ resetEmailState: true });
              }
            }
            needViewRefresh = true;
            viewRefreshTypes.push(type);
            break;
          }
          case 'EmailDelivery':
            needViewRefresh = true;
            viewRefreshTypes.push(type);
            break;
          case 'EmailSubmission':
            if (account.id === this.account.id) await this._syncSubmissions();
            break;
          case 'Identity':
            if (account.id === this.account.id) await this.ensureIdentities();
            break;
          case 'AddressBook':
            if (account.id === this.account.id) await this.ensureAddressbooks();
            break;
          case 'ContactCard': {
            if (account.id !== this.account.id) break;
            const sync = await this._loadSyncStateFor(account, 'ContactCard');
            if (!sync?.state) {
              await this.ensureContacts();
              break;
            }
            const result = await syncContactCardChanges({
              transport: this.transport,
              account,
              handlers: this.handlers,
              sinceState: sync.state,
              useWebSocket: this._wsReady(),
            });
            if (result.needsFullSync) await this.ensureContacts();
            await this.handlers[DB_RPC.RECIPIENT_USAGE_REBUILD]({
              accountId: this.account.id,
            });
            break;
          }
          case 'FileNode':
            if (account.id === this.account.id) {
              let fileNodeError: unknown = null;
              try {
                await this.ensureSettings();
              } catch (error) {
                fileNodeError = error;
              }
              const trashRefresh = await this._refreshContactsTrash();
              if (trashRefresh.ok === false) fileNodeError ??= trashRefresh.error;
              if (fileNodeError) throw fileNodeError;
            }
            break;
          default:
            break;
        }
      } catch (error) {
        failedTypes[type] = types[type];
        wlog.warn(
          'jmap-backend',
          `StateChange ${type} sync failed for ${account.remote_account_id}`,
          error,
        );
      }
    }
    if (needViewRefresh) {
      try {
        await this._refreshActiveQueryViews(account);
      } catch (error) {
        for (const type of viewRefreshTypes) failedTypes[type] = types[type];
        wlog.warn(
          'jmap-backend',
          `StateChange view refresh failed for ${account.remote_account_id}`,
          error,
        );
      }
    }
    return failedTypes;
  }

  _scheduleStateChangeRetry(change) {
    this._stateChangeRetryPending = mergeStateChange(
      this._stateChangeRetryPending,
      change,
    );
    if (this._stateChangeRetryTimer != null || !this._started) return;
    this._stateChangeRetryTimer = setTimeout(() => {
      this._stateChangeRetryTimer = null;
      const pending = this._stateChangeRetryPending;
      this._stateChangeRetryPending = null;
      if (pending && this._started) this._onStateChange(pending);
    }, this._stateChangeRetryDelayMs);
  }

  /**
   * Refresh the latest Sent metadata and replace the local ranking cache.
   * This path never creates contacts; it is safe after a user deletes one.
   */
  async _refreshRecipientUsage({ resetEmailState = false } = {}) {
    const sent = await this.handlers[DB_RPC.FOLDER_BY_ROLE]({
      accountId: this.account.id,
      role: 'sent',
    });
    if (!sent) return { scanned: 0, ranked: 0 };
    let baselineEmailState: string | null = null;
    const paging = await pageCompleteQuery({
      pageSize: 300,
      maxPosition: 300,
      readPage: async ({ position, limit }) => {
        const page = await syncFolderWindow({
          transport: this.transport,
          account: this.account,
          folder: sent,
          handlers: this.handlers,
          sortProp: 'sentAt',
          position,
          limit,
          useWebSocket: this._wsReady(),
        });
        const total = page.total == null ? null : Number(page.total);
        return {
          ids: page.ids,
          queryState: typeof page.queryState === 'string' ? page.queryState : null,
          total: total != null && Number.isFinite(total) ? total : null,
          position: Number.isFinite(page.position) ? Number(page.position) : null,
          value: page,
        };
      },
      visitPage: ({ value: page }) => {
        if (baselineEmailState == null) {
          if (!page.emailState) {
            throw new Error('Sent snapshot did not include an Email object state');
          }
          baselineEmailState = page.emailState;
        }
      },
    });
    if (
      paging.complete === false
      && (paging.reason === 'queryStateChanged' || paging.reason === 'queryTotalChanged')
    ) {
      throw new Error('Sent query changed while rebuilding recipient usage');
    }
    if (
      (paging.complete === false && paging.reason === 'queryStateMissing')
      || (
        paging.complete
        && paging.total != null
        && paging.position < paging.total
        && !paging.queryState
      )
    ) {
      throw new Error('Sent query did not provide stable paging state');
    }
    if (paging.complete === false) {
      if (paging.reason === 'cursorStalled') {
        throw new Error('Sent query changed while rebuilding recipient usage');
      }
      throw new Error('Sent query did not complete while rebuilding recipient usage');
    }
    const current = await this.handlers[DB_RPC.SYNC_STATE_GET]({
      accountId: this.account.id,
      objectType: 'Email',
    });
    if (baselineEmailState && (resetEmailState || !current?.state)) {
      await this.handlers[DB_RPC.SYNC_STATE_SET]({
        accountId: this.account.id,
        objectType: 'Email',
        state: baselineEmailState,
      });
      const catchup = await syncEmailChanges({
        transport: this.transport,
        account: this.account,
        handlers: this.handlers,
        sinceState: baselineEmailState,
        useWebSocket: this._wsReady(),
      });
      if (catchup.needsFullSync) {
        throw new Error('Sent snapshot changes catch-up was incomplete');
      }
    }
    return this.handlers[DB_RPC.RECIPIENT_USAGE_REBUILD]({
      accountId: this.account.id,
      limit: 300,
    });
  }

  async _refreshActiveQueryViews(account = this.account) {
    if (!account) return;
    const forceInbox = account.id === this.account.id ? 1 : 0;
    const views = await this.handlers[DB_RPC.QUERY]({
      sql: `SELECT * FROM query_views
             WHERE account_id = ? AND view_type = 'mailbox-window'
               AND (
                 (? = 1 AND folder_id IN (
                   SELECT id FROM folders
                   WHERE account_id = ? AND role = 'inbox'
                 ))
                 OR id IN (
                   SELECT id FROM query_views
                   WHERE account_id = ? AND view_type = 'mailbox-window'
                   ORDER BY last_accessed_at DESC
                   LIMIT ?
                 )
               )
             ORDER BY last_accessed_at DESC`,
      params: [
        account.id,
        forceInbox,
        account.id,
        account.id,
        ACTIVE_VIEW_REFRESH_LIMIT,
      ],
    });
    // Track ids that newly entered an active view as a result of
    // this refresh so we can eagerly fetch their bodies into the
    // DB. The expected case is a single EmailDelivery push adding
    // one row to the inbox; doing the body fetch now means the
    // click-to-render path is a local SQL read instead of a
    // server round trip.
    /** @type {{ id: string, index: number }[]} */
    const newlyAdded = [];
    for (const view of views) {
      const folder = await this._loadFolder(view.folder_id);
      if (!folder) continue;
      const sortJson = JSON.parse(view.sort_json);
      const sortProp = sortJson?.[0]?.property ?? 'receivedAt';
      const sortAscending = sortJson?.[0]?.isAscending === true;
      const result = view.query_state
        ? await syncFolderWindowChanges({
          transport: this.transport,
          account,
          folder,
          handlers: this.handlers,
          sinceQueryState: view.query_state,
          sortProp,
          sortAscending,
          collapseThreads: !!view.collapse_threads,
          useWebSocket: this._wsReady(),
        })
        : { needsFullSync: true };
      if (result.needsFullSync) {
        await syncFolderWindow({
          transport: this.transport,
          account,
          folder,
          handlers: this.handlers,
          sortProp,
          sortAscending,
          collapseThreads: !!view.collapse_threads,
          useWebSocket: this._wsReady(),
        });
        continue;
      }
      for (const add of (result.added ?? [])) {
        if (add?.id) newlyAdded.push({ id: add.id, index: Number(add.index ?? 0) });
      }
    }
    if (newlyAdded.length > 0) {
      await this._prefetchBodiesForNewlyDelivered(account, newlyAdded);
    }
  }

  /**
   * Resolve newly-added remote ids to local message ids and eagerly
   * fetch their bodies. Bounded to `_eagerBodyPrefetchCap` so a
   * post-disconnect catch-up that surfaces dozens of new rows
   * doesn't dump every one of them onto the WebSocket. We pick the
   * lowest-index entries (most recent) since those are the ones
   * the user is most likely to click.
   */
  async _prefetchBodiesForNewlyDelivered(account, additions) {
    if (!Array.isArray(additions) || additions.length === 0) return;
    const ordered = [...additions]
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .slice(0, this._eagerBodyPrefetchCap)
      .map((a) => a.id)
      .filter(Boolean);
    if (ordered.length === 0) return;
    const placeholders = ordered.map(() => '?').join(',');
    const rows = await this.handlers[DB_RPC.QUERY]({
      sql: `SELECT id FROM messages
             WHERE account_id = ?
               AND remote_id IN (${placeholders})`,
      params: [account.id, ...ordered],
    });
    const localIds = rows
      .map((r) => Number(r.id))
      .filter((n) => Number.isFinite(n));
    if (localIds.length === 0) return;
    try {
      const result = await this.ensureMessageBodies(localIds);
      if ((result?.fetched ?? 0) > 0) {
        wlog.info(
          'jmap-backend',
          `eager body prefetch: ${result.fetched} bodies for newly-delivered ids`,
        );
      }
    } catch (err) {
      wlog.warn('jmap-backend', 'eager body prefetch failed', err);
    }
  }

  // ----- helpers ------------------------------------------------------

  _hasContactsService() {
    return this.services.some((s) => s.serviceKind === SERVICE_KIND.JMAP_CONTACTS);
  }

  _subscribedTypes() {
    return hasFileNodeCapability(this.transport, this.account)
      ? [...SUBSCRIBED_TYPES, 'FileNode']
      : SUBSCRIBED_TYPES;
  }

  _wsReady() {
    return this.useWebSocket && !!this.transport._ws && this.transport._ws.readyState === 1;
  }

  async _defaultSortFor(folder) {
    const scheduledRemoteId = await readScheduledMailboxRemoteId(
      this.handlers,
      Number(folder?.account_id),
    );
    if (scheduledRemoteId && folder?.remote_id === scheduledRemoteId) {
      return { sortProp: 'sentAt', sortAscending: true };
    }
    if (folder?.role === 'sent' || folder?.role === 'drafts') {
      return { sortProp: 'sentAt', sortAscending: false };
    }
    return { sortProp: 'receivedAt', sortAscending: false };
  }

  /**
   * Resolve the current Session account that owns a folder. Primary
   * folders may use the primary row directly in narrow tests before the
   * account map is initialized. A folder belonging to a removed or
   * otherwise unavailable shared account throws instead of being sent
   * through the primary JMAP account.
   */
  _accountForFolder(folder) {
    const localAccountId = Number(folder?.account_id);
    const mapped = this._accountsByLocalId.get(localAccountId);
    if (mapped) return mapped;
    if (Number(this.account?.id) === localAccountId) return this.account;
    throw new Error(`Folder ${folder?.id ?? '(unknown)'} belongs to an unavailable account`);
  }

  _accountForLocalId(localAccountId: number) {
    const normalized = Number(localAccountId);
    const mapped = this._accountsByLocalId.get(normalized);
    if (mapped) return mapped;
    if (Number(this.account?.id) === normalized) return this.account;
    const error: any = new Error(
      `JMAP account ${localAccountId ?? '(unknown)'} is unavailable`,
    );
    error.type = 'accountUnavailable';
    throw error;
  }

  _sessionAccounts() {
    return [this.account, ...this.sharedAccounts].filter(Boolean);
  }

  async _loadFolder(folderId) {
    const rows = await this.handlers[DB_RPC.QUERY]({
      sql: 'SELECT * FROM folders WHERE id = ?',
      params: [folderId],
    });
    if (rows.length === 0) {
      throw new Error(`Folder ${folderId} not found`);
    }
    return rows[0];
  }

  async _loadSyncStateFor(account, objectType, scope = '') {
    return this.handlers[DB_RPC.SYNC_STATE_GET]({
      accountId: account.id,
      objectType,
      scope,
    });
  }

  async _loadPushState() {
    const rows = await this.handlers[DB_RPC.QUERY]({
      sql: `SELECT push_state FROM account_services
              WHERE account_id = ? AND service_kind = ?`,
      params: [this.account.id, SERVICE_KIND.JMAP_MAIL],
    });
    return rows[0]?.push_state ?? null;
  }

  async _persistPushState(pushState) {
    if (!this.account) return;
    await this.handlers[DB_RPC.QUERY]({
      sql: `UPDATE account_services
              SET push_state = ?, updated_at = ?
            WHERE account_id = ? AND service_kind = ?`,
      params: [pushState, Date.now(), this.account.id, SERVICE_KIND.JMAP_MAIL],
    });
  }

  async _nextQueryViewGap({
    folder,
    sortProp,
    sortAscending = false,
    startAt = 0,
    total = 0,
    limit = 100,
  }) {
    const filterJson = JSON.stringify({ inMailbox: folder.remote_id });
    const sortJson = JSON.stringify([{ property: sortProp, isAscending: sortAscending }]);
    const views = await this.handlers[DB_RPC.QUERY]({
      sql: `SELECT id, total
              FROM query_views
             WHERE account_id = ?
               AND view_type = 'mailbox-window'
               AND folder_id = ?
               AND filter_json = ?
               AND sort_json = ?
               AND collapse_threads = 0`,
      params: [this._accountForFolder(folder).id, folder.id, filterJson, sortJson],
    });
    const view = views[0] ?? null;
    const effectiveTotal = Number(view?.total ?? total ?? 0);
    if (!Number.isFinite(effectiveTotal) || effectiveTotal <= 0) {
      return { offset: 0, limit };
    }
    const ranges = view
      ? await this.handlers[DB_RPC.QUERY]({
        sql: `SELECT start_position, end_position
                FROM query_view_ranges
               WHERE view_id = ?
               ORDER BY start_position, end_position`,
        params: [view.id],
      })
      : [];
    let cursor = Math.max(0, Math.min(startAt, effectiveTotal));
    for (const range of ranges) {
      const start = Math.max(0, Number(range.start_position ?? 0));
      const end = Math.min(effectiveTotal, Number(range.end_position ?? 0));
      if (end <= start) continue;
      if (cursor < start) {
        return { offset: cursor, limit: Math.min(limit, start - cursor) };
      }
      if (cursor < end) cursor = end;
      if (cursor >= effectiveTotal) return null;
    }
    return cursor < effectiveTotal
      ? { offset: cursor, limit: Math.min(limit, effectiveTotal - cursor) }
      : null;
  }
}

/**
 * Union the type-state maps of two consecutive StateChange frames so
 * a single trailing pass can catch up on every type that changed.
 * The state values themselves are opaque to us — we only iterate the
 * keys in _doStateChange to decide which /changes call to issue — so
 * later-wins for any duplicate type key is fine. The pushState
 * always takes the freshest value because that is what gets
 * persisted to account_services and replayed on reconnect.
 */
function mergeStateChange(prev: any, next: any) {
  const nextChanged = next?.changed ?? {};
  const nextPushState = next?.pushState ?? null;
  if (!prev) {
    return { changed: { ...nextChanged }, pushState: nextPushState };
  }
  const changed = { ...prev.changed };
  for (const [accountId, types] of Object.entries(nextChanged) as Array<[string, Record<string, string>]>) {
    changed[accountId] = { ...(changed[accountId] ?? {}), ...types };
  }
  return {
    changed,
    pushState: nextPushState ?? prev.pushState,
  };
}
