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

import { DB_RPC } from '../../../db/protocol.js';
import { JMAP_TYPE, SERVICE_KIND, KEYWORD } from '../../../constants/states.js';
import { wlog } from '../../../db/worker-log.js';
import { ingestSession } from './session.js';
import { syncMailboxes, syncMailboxChanges } from './mailboxes.js';
import {
  syncFolderWindow,
  syncFolderWindowChanges,
  syncEmailChanges,
} from './messages.js';
import { fetchEmailBodies } from './bodies.js';
import { syncIdentities } from './identities.js';
import {
  syncAddressBooks,
  syncContacts,
  syncContactCardChanges,
} from './contacts.js';
import { processMutationRow } from './outbox.js';
import { OutboxRunner } from './outbox-runner.js';

const SUBSCRIBED_TYPES = [
  JMAP_TYPE.MAILBOX,
  JMAP_TYPE.EMAIL,
  JMAP_TYPE.THREAD,
  JMAP_TYPE.IDENTITY,
  JMAP_TYPE.EMAIL_DELIVERY,
  JMAP_TYPE.ADDRESSBOOK,
  JMAP_TYPE.CONTACT_CARD,
];

export class JmapBackend {
  /**
   * @param {object} args
   * @param {import('./transport.js').JmapTransport} args.transport
   * @param {string} args.serverOrigin
   * @param {Record<string, (params: any) => Promise<any>>} args.handlers
   * @param {{ useWebSocket?: boolean }} [args.options]
   */
  constructor({ transport, serverOrigin, handlers, options = {} }) {
    this.transport = transport;
    this.serverOrigin = serverOrigin;
    this.handlers = handlers;
    this.useWebSocket = options.useWebSocket ?? true;
    this.account = null;
    this.services = [];
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
    /** @type {number | null} cached urn:ietf:params:jmap:core
     *  maxObjectsInGet; loaded lazily on the first indexer tick so we
     *  don't slow down start() with an extra query. */
    this._maxObjectsInGetCap = null;
    // Created in start() once we know our local account.id. Owns the
    // pending_mutations drain loop: auto-draining on insert (via the
    // makeHandlers hook), on StateChange (any push that signals the
    // WS is live also signals it can carry our queued writes), and on
    // backoff timer expiry. See sync/backends/jmap/outbox-runner.js.
    /** @type {import('./outbox-runner.js').OutboxRunner | null} */
    this.outboxRunner = null;
    this._outboxRunnerOptions = options.outboxRunnerOptions ?? null;
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
    wlog.info('jmap-backend', `account ingested id=${this.account.id} remote=${this.account.remote_account_id} services=${this.services.map((s) => s.serviceKind).join(',')}`);

    // Build the runner once the account row exists. processRow gets
    // the current transport / useWebSocket at call time so the
    // runner doesn't capture a stale snapshot if the backend later
    // flips between HTTP and WS.
    this.outboxRunner = new OutboxRunner({
      accountId: this.account.id,
      handlers: this.handlers,
      processRow: (row) => processMutationRow({
        transport: this.transport,
        account: this.account,
        handlers: this.handlers,
        row,
        useWebSocket: this._wsReady(),
      }),
      options: this._outboxRunnerOptions ?? undefined,
    });

    const mbResult = await syncMailboxes({
      transport: this.transport,
      account: this.account,
      handlers: this.handlers,
    });
    wlog.info('jmap-backend', `syncMailboxes -> ${mbResult.count} folders, state=${mbResult.state}`);

    this._started = true;

    // Drain anything left over from a previous session. The migration
    // already reset in_flight -> pending; this just kicks the loop so
    // those rows go out without waiting for the next user action.
    this.outboxRunner.notify();

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
    const idResult = await syncIdentities({
      transport: this.transport,
      account: this.account,
      handlers: this.handlers,
    });
    wlog.info('jmap-backend', `syncIdentities -> ${idResult.count} identities`);

    if (this._hasContactsService()) {
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
    }

    if (this.useWebSocket) {
      const pushState = await this._loadPushState();
      try {
        await this.transport.openWebSocket(SUBSCRIBED_TYPES, pushState);
        wlog.info('jmap-backend', 'WebSocket open, push enabled');
        // Now that the WS is up, any pending mutations that failed
        // mid-restart (or that landed on disk while we were on HTTP)
        // can finally go out. Cheap if the queue is empty.
        this.outboxRunner?.notify();
      } catch (err) {
        wlog.warn('jmap-backend', 'WebSocket unavailable; staying on HTTP', err);
      }
    }
    this._unsubStateChange = this.transport.onStateChange(
      (change) => this._onStateChange(change).catch((err) => {
        wlog.error('jmap-backend', 'StateChange dispatch failed', err);
      }),
    );
    // Catch up on whatever changed while we were disconnected. The
    // WebSocketPushEnable+pushState handshake is supposed to deliver
    // a StateChange for any types that moved, but servers may decline
    // to push when the stored pushState is unrecognised (e.g. after a
    // restart) and EmailDelivery only fires for new mail, not for
    // destroys or moves done elsewhere. Running queryChanges per
    // active view here makes the first repaint authoritative without
    // waiting for the user to refresh.
    await this._refreshActiveQueryViews().catch((err) => {
      wlog.warn('jmap-backend', 'startup view catch-up failed', err);
    });
    this._scheduleMetadataIndexer(1_000);
  }

  async stop() {
    if (!this._started) return;
    this._unsubStateChange?.();
    this._unsubStateChange = null;
    if (this._indexerTimer) {
      clearTimeout(this._indexerTimer);
      this._indexerTimer = null;
    }
    if (this.outboxRunner) {
      await this.outboxRunner.stop();
      this.outboxRunner = null;
    }
    this.transport.closeWebSocket();
    this._started = false;
  }

  // ----- SyncClient.Backend surface -----------------------------------

  async ensureFolderTree() {
    return syncMailboxes({
      transport: this.transport,
      account: this.account,
      handlers: this.handlers,
      useWebSocket: this._wsReady(),
    });
  }

  async ensureFolderWindow(folderId, range = {}) {
    this._foregroundFolderWindowCount += 1;
    try {
      const folder = await this._loadFolder(folderId);
      const r = await syncFolderWindow({
        transport: this.transport,
        account: this.account,
        folder,
        handlers: this.handlers,
        sortProp: range.sortProp ?? this._defaultSortPropFor(folder),
        position: range.offset ?? 0,
        limit: range.limit ?? 100,
        collapseThreads: range.collapseThreads ?? false,
        useWebSocket: this._wsReady(),
      });
      wlog.info(
        'jmap-backend',
        `ensureFolderWindow offset=${range.offset ?? 0} fetched=${r?.fetched ?? 0} total=${r?.total ?? '?'}`,
      );
      return r;
    } finally {
      this._foregroundFolderWindowCount = Math.max(0, this._foregroundFolderWindowCount - 1);
    }
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
      sql: `SELECT remote_id
              FROM messages
             WHERE id IN (${placeholders})
               AND body_fetched_at IS NULL`,
      params: ids,
    });
    const remoteIds = rows.map((row) => row.remote_id).filter(Boolean);
    if (remoteIds.length === 0) return { fetched: 0 };
    return fetchEmailBodies({
      transport: this.transport,
      account: this.account,
      handlers: this.handlers,
      remoteIds,
      useWebSocket: this._wsReady(),
    });
  }

  async ensureFolderIndex(folderId, options = {}) {
    const folder = await this._loadFolder(folderId);
    const sortProp = options.sortProp ?? this._defaultSortPropFor(folder);
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
      const gap = await this._nextQueryViewGap({ folder, sortProp, startAt: offset, total, limit });
      if (!gap) break;
      const result = await syncFolderWindow({
        transport: this.transport,
        account: this.account,
        folder,
        handlers: this.handlers,
        sortProp,
        position: gap.offset,
        limit: gap.limit,
        collapseThreads: false,
        useWebSocket: this._wsReady(),
      });
      fetched += result?.fetched ?? 0;
      total = Number(result?.total ?? total);
      offset = gap.offset + gap.limit;
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
        .catch((err) => wlog.warn('jmap-backend', 'metadata indexer failed', err))
        .finally(() => {
          if (this._started) this._scheduleMetadataIndexer(this._indexerTickDelayMs);
        });
    }, effectiveDelay);
  }

  /**
   * One indexer tick. Picks the highest-priority folder that still
   * has uncovered positions and runs up to `_indexerChunksPerTick`
   * back-to-back Email/query+Email/get round trips against it. The
   * per-chunk size scales with folder size (see
   * `_selectIndexerChunkSize`) and is clamped against the server's
   * advertised maxObjectsInGet.
   *
   * `break` after one folder per tick is intentional: it keeps the
   * WS connection serving a predictable single-folder stream and
   * yields to any foreground ensureFolderWindow the user kicks off
   * mid-flight (which would bump _foregroundFolderWindowCount and
   * stall the *next* tick at the gate above).
   */
  async _runMetadataIndexerChunk() {
    if (this._indexerRunning || !this.account) return;
    if (this._foregroundFolderWindowCount > 0) return;
    this._indexerRunning = true;
    try {
      const serverCap = await this._loadMaxObjectsInGetCap();
      const folders = await this.handlers[DB_RPC.QUERY]({
        sql: `SELECT *
                FROM folders
               WHERE account_id = ?
                 AND is_deleted = 0
                 AND COALESCE(total_emails, 0) > 0
               ORDER BY CASE role
                          WHEN 'inbox' THEN 0
                          WHEN 'sent' THEN 1
                          WHEN 'archive' THEN 2
                          ELSE 3
                        END,
                        COALESCE(total_emails, 0) DESC`,
        params: [this.account.id],
      });
      for (const folder of folders) {
        const progress = await this._queryViewProgress(folder);
        if (progress.total > 0 && progress.covered >= progress.total) {
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
            `metadata indexer folder=${folder.name} fetched=${result.fetched} total=${result.total} chunkLimit=${chunkLimit}`,
          );
        }
        break;
      }
    } finally {
      this._indexerRunning = false;
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

  /**
   * Read maxObjectsInGet out of the cached jmap-core capability.
   * Cached on first call; never refreshed because the value only
   * changes when the server pushes a session-state update, which is
   * a re-login event for our purposes.
   */
  async _loadMaxObjectsInGetCap() {
    if (this._maxObjectsInGetCap != null) return this._maxObjectsInGetCap;
    if (!this.account) return null;
    try {
      const rows = await this.handlers[DB_RPC.QUERY]({
        sql: `SELECT payload_json FROM account_capabilities
                WHERE account_id = ? AND capability = ?
                LIMIT 1`,
        params: [this.account.id, 'urn:ietf:params:jmap:core'],
      });
      const payload = rows?.[0]?.payload_json
        ? JSON.parse(rows[0].payload_json)
        : null;
      const raw = Number(payload?.maxObjectsInGet);
      this._maxObjectsInGetCap = Number.isFinite(raw) && raw > 0 ? raw : null;
    } catch (err) {
      wlog.warn('jmap-backend', 'failed to read maxObjectsInGet capability', err);
      this._maxObjectsInGetCap = null;
    }
    return this._maxObjectsInGetCap;
  }

  async _queryViewProgress(folder) {
    const sortProp = this._defaultSortPropFor(folder);
    const filterJson = JSON.stringify({ inMailbox: folder.remote_id });
    const sortJson = JSON.stringify([{ property: sortProp, isAscending: false }]);
    const views = await this.handlers[DB_RPC.QUERY]({
      sql: `SELECT id, total
              FROM query_views
             WHERE account_id = ?
               AND view_type = 'mailbox-window'
               AND folder_id = ?
               AND filter_json = ?
               AND sort_json = ?
               AND collapse_threads = 0`,
      params: [this.account.id, folder.id, filterJson, sortJson],
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

  async ensureContacts(_addressbookId) {
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

  // ----- StateChange dispatch -----------------------------------------

  async _onStateChange({ changed, pushState }) {
    if (!this.account) return;
    if (pushState) {
      await this._persistPushState(pushState);
    }
    // Any push frame, regardless of which JMAP type it carries, is
    // also a strong signal that the WebSocket is alive end-to-end.
    // Wake the outbox runner so anything queued during a transient
    // disconnect goes out now — this is how we get reconnect-retry
    // without having to add an explicit reconnect callback to the
    // transport layer.
    this.outboxRunner?.notify();
    const types = changed?.[this.account.remote_account_id];
    if (!types) return;

    // Any Email or EmailDelivery state change can reorder, add, or
    // remove rows from active mailbox windows (created, destroyed,
    // moved between folders, or a flag flip that the server re-sorts
    // on). Email/changes only refreshes message rows the client
    // already knows about; it never updates query_view_items, which
    // is what the UI's message list reads from. We collect a flag
    // here and run a single _refreshActiveQueryViews pass after the
    // type loop so multiple types arriving together (Email +
    // EmailDelivery is the common case for a new delivery) only
    // trigger one queryChanges round per active view.
    let needViewRefresh = false;

    for (const [type, _state] of Object.entries(types)) {
      switch (type) {
        case JMAP_TYPE.MAILBOX: {
          const sync = await this._loadSyncState('Mailbox');
          if (!sync?.state) {
            await this.ensureFolderTree();
            break;
          }
          const result = await syncMailboxChanges({
            transport: this.transport,
            account: this.account,
            handlers: this.handlers,
            sinceState: sync.state,
            useWebSocket: this._wsReady(),
          });
          if (result.needsFullSync) {
            await this.ensureFolderTree();
          }
          break;
        }
        case JMAP_TYPE.EMAIL: {
          const sync = await this._loadSyncState('Email');
          if (sync?.state) {
            // Refresh metadata for message rows the client already
            // knows about (e.g. $seen/$flagged flips, subject edits).
            // Per-view membership is reconciled below via
            // queryChanges; this is just the row-data side.
            await syncEmailChanges({
              transport: this.transport,
              account: this.account,
              handlers: this.handlers,
              sinceState: sync.state,
              useWebSocket: this._wsReady(),
            }).catch((err) => {
              wlog.warn('jmap-backend', 'syncEmailChanges failed', err);
            });
          }
          // Always refresh active views: created/destroyed/moved
          // emails only show up in the UI once query_view_items is
          // reconciled. Unchanged views still emit a cheap empty
          // queryChanges response, which is bounded to 5 views.
          needViewRefresh = true;
          break;
        }
        case JMAP_TYPE.EMAIL_DELIVERY: {
          // EmailDelivery is push-only and fires only when new mail
          // has arrived. The view always needs to be refreshed so
          // the new rows show up in the open folder.
          needViewRefresh = true;
          break;
        }
        case JMAP_TYPE.IDENTITY: {
          await this.ensureIdentities();
          break;
        }
        case JMAP_TYPE.ADDRESSBOOK: {
          await this.ensureAddressbooks();
          break;
        }
        case JMAP_TYPE.CONTACT_CARD: {
          const sync = await this._loadSyncState('ContactCard');
          if (!sync?.state) {
            await this.ensureContacts();
            break;
          }
          const result = await syncContactCardChanges({
            transport: this.transport,
            account: this.account,
            handlers: this.handlers,
            sinceState: sync.state,
            useWebSocket: this._wsReady(),
          });
          if (result.needsFullSync) {
            await this.ensureContacts();
          }
          break;
        }
        default:
          // Unknown JMAP type: ignore. We only care about the types we
          // explicitly subscribed to via WebSocketPushEnable.
          break;
      }
    }

    if (needViewRefresh) {
      await this._refreshActiveQueryViews();
    }
  }

  async _refreshActiveQueryViews() {
    const views = await this.handlers[DB_RPC.QUERY]({
      sql: `SELECT * FROM query_views
             WHERE account_id = ? AND view_type = 'mailbox-window'
             ORDER BY last_accessed_at DESC LIMIT 5`,
      params: [this.account.id],
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
      const result = await syncFolderWindowChanges({
        transport: this.transport,
        account: this.account,
        folder,
        handlers: this.handlers,
        sinceQueryState: view.query_state,
        sortProp,
        collapseThreads: !!view.collapse_threads,
        useWebSocket: this._wsReady(),
      });
      if (result.needsFullSync) {
        await syncFolderWindow({
          transport: this.transport,
          account: this.account,
          folder,
          handlers: this.handlers,
          sortProp,
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
      await this._prefetchBodiesForNewlyDelivered(newlyAdded);
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
  async _prefetchBodiesForNewlyDelivered(additions) {
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
      params: [this.account.id, ...ordered],
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

  _wsReady() {
    return this.useWebSocket && !!this.transport._ws && this.transport._ws.readyState === 1;
  }

  _defaultSortPropFor(folder) {
    if (folder?.role === 'sent' || folder?.role === 'drafts') {
      return 'sentAt';
    }
    return 'receivedAt';
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

  async _loadSyncState(objectType, scope = '') {
    return this.handlers[DB_RPC.SYNC_STATE_GET]({
      accountId: this.account.id,
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

  async _nextQueryViewGap({ folder, sortProp, startAt = 0, total = 0, limit = 100 }) {
    const filterJson = JSON.stringify({ inMailbox: folder.remote_id });
    const sortJson = JSON.stringify([{ property: sortProp, isAscending: false }]);
    const views = await this.handlers[DB_RPC.QUERY]({
      sql: `SELECT id, total
              FROM query_views
             WHERE account_id = ?
               AND view_type = 'mailbox-window'
               AND folder_id = ?
               AND filter_json = ?
               AND sort_json = ?
               AND collapse_threads = 0`,
      params: [this.account.id, folder.id, filterJson, sortJson],
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
