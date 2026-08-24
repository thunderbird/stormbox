/**
 * Compose state. Holds the in-flight draft and the identity picker.
 * Send is implemented as a pending_mutations row plus a drainOutbox
 * call on the worker. send() awaits the outcome and close() refuses
 * while SENDING (CS-1.12): the composer stays open until the send is
 * confirmed, failed, or parked, so its result is never invisible.
 */

import { defineStore } from 'pinia';
import { computed, reactive, ref, watch } from 'vue';

import { getRepositoryAsync } from '../composables/useRepository';
import { useAuthStore } from './auth-store';
import { useMailStore } from './mail-store';
import { COMPOSE_STATE, MUTATION_TYPE } from '../constants/states';
import type { ComposeState, MailboxRole } from '../constants/states';
import type { FolderRow, IdentityRow, MessageRow } from '../types';
import type { Repository } from '../db/repository';
import { TABLE_FAMILIES } from '../db/protocol';
import {
  findMatchingIdentityIndex,
  resolveComposeIdentityIndex,
  type RememberedComposeIdentity,
} from '../utils/compose-identity';
import {
  buildQuotedHtml,
  buildQuotedText,
  makeForwardSubject,
  makeReplySubject,
} from '../utils/compose-quote';
import {
  parseAddressList,
  type ParsedAddress,
} from '../utils/address-parse';
import { buildReplyAudience, buildThreadHeaders } from '../utils/reply';

export type RecipientField = 'to' | 'cc' | 'bcc';

export const RECIPIENT_FIELDS: readonly RecipientField[] = ['to', 'cc', 'bcc'];

/**
 * Text a user committed as a recipient that is not a readable address.
 *
 * It is kept rather than dropped, because dropping it is how a recipient
 * goes missing: the entry stays where it was entered, marked, and refuses
 * the send until it is fixed (CS-2.4, CS-3.16).
 */
export interface InvalidRecipient {
  text: string;
  invalid: true;
}

/** One committed recipient: an address, or text that is not one. */
export type RecipientEntry = ParsedAddress | InvalidRecipient;

interface Draft {
  fromIdx: number;
  /**
   * Recipients as addresses rather than as text. A recipient list is a
   * list, and the string form cannot represent one unambiguously: a comma
   * inside a display name is not a separator, so any consumer of the text
   * has to parse it again and can disagree about what it holds.
   */
  to: ParsedAddress[];
  cc: ParsedAddress[];
  bcc: ParsedAddress[];
  subject: string;
  textBody: string;
  htmlBody: string;
  /** Threading for a reply, per RFC 5322 §3.6.4. Empty for a new message. */
  inReplyTo: string[];
  references: string[];
}

/**
 * A fresh empty draft. This is a factory rather than a frozen constant
 * because the recipient fields are arrays: one shared instance would be
 * aliased into every draft and mutated across them.
 */
function emptyDraft(): Draft {
  return {
    fromIdx: 0,
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    textBody: '',
    htmlBody: '',
    inReplyTo: [],
    references: [],
  };
}

/**
 * Identity `replyTo` per RFC 8621 §6: where replies to this identity
 * should go. Stored as JSON since it is a list.
 */
function identityReplyTo(identity: IdentityRow): ParsedAddress[] {
  if (!identity.reply_to_json) return [];
  try {
    const parsed = JSON.parse(identity.reply_to_json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry && typeof entry.email === 'string')
      .map((entry) => ({
        ...(typeof entry.name === 'string' && entry.name.trim() ? { name: entry.name } : {}),
        email: entry.email,
      }));
  } catch {
    return [];
  }
}

const FROM_IDENTITY_STORAGE_PREFIX = 'stormbox.compose.fromIdentity';

function fromIdentityStorageKey(accountId: number): string {
  return `${FROM_IDENTITY_STORAGE_PREFIX}.${accountId}`;
}

function readRememberedIdentity(accountId: number | null): RememberedComposeIdentity | null {
  if (accountId == null) return null;
  try {
    const raw = globalThis.localStorage?.getItem(fromIdentityStorageKey(accountId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      remoteId: typeof parsed.remoteId === 'string' ? parsed.remoteId : null,
      email: typeof parsed.email === 'string' ? parsed.email : null,
    };
  } catch {
    return null;
  }
}

function rememberIdentity(accountId: number | null, identity: IdentityRow | null): void {
  if (accountId == null || !identity) return;
  try {
    globalThis.localStorage?.setItem(
      fromIdentityStorageKey(accountId),
      JSON.stringify({ remoteId: identity.remote_id, email: identity.email }),
    );
  } catch {
    // Storage can be unavailable in private contexts; compose still works for this session.
  }
}

export const useComposeStore = defineStore('compose', () => {
  const authStore = useAuthStore();
  const mailStore = useMailStore();

  const status = ref<ComposeState>(COMPOSE_STATE.IDLE);
  const error = ref<string | null>(null);
  // Transient send confirmation, rendered by StoreErrorToast after the
  // dialog has closed. Cleared on a timer the same way mail-store's
  // notice is, so it never lingers over a later screen.
  const notice = ref<string | null>(null);
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  const isOpen = ref(false);
  // Bumped by every open() and $reset(). send() captures it and drops its
  // own result if it no longer matches, so a slow send settling after a
  // logout or after the user opened a new message cannot write status,
  // error, or close over the composer that replaced it.
  let composeGeneration = 0;
  // Bumped by every prefill gesture, every open(), and $reset(). A reply has
  // to read the parent's addresses before it can open, so two quick gestures
  // settle in completion order rather than in the order they were made: the
  // slower read would otherwise open the composer quoting and addressing the
  // message the user had already moved on from.
  let prefillGeneration = 0;
  const identities = ref<IdentityRow[]>([]);
  const accountPrimaryEmail = ref<string | null>(null);
  const draft = reactive<Draft>(emptyDraft());
  /**
   * Fragments of a recipient field that are not addresses, per field.
   *
   * Kept out of the draft because they are not part of the message: they
   * are what the user still has to fix. Send refuses while any is present,
   * so a typed address is never silently dropped or passed to the server
   * as though it were one (CS-2.4).
   */
  const rejectedRecipients = reactive<Record<RecipientField, string[]>>({
    to: [],
    cc: [],
    bcc: [],
  });
  /**
   * Bumped whenever the draft is replaced wholesale — opened, prefilled by
   * a reply, closed, reset. A control that edits recipients as text uses it
   * to know when to re-read them, which it cannot do by watching the
   * addresses themselves: those change on every keystroke it causes, and
   * re-rendering them mid-word would rewrite what the user is typing.
   */
  const draftEpoch = ref(0);
  let repo: Repository | null = null;
  let unsubscribe: (() => void) | null = null;

  const fromIdentity = computed<IdentityRow | null>(() =>
    identities.value[draft.fromIdx] ?? identities.value[0] ?? null,
  );

  /** Recipients across all three fields; any of them can carry a send. */
  const recipientCount = computed(() =>
    RECIPIENT_FIELDS.reduce((total, field) => total + draft[field].length, 0),
  );

  async function attach(): Promise<void> {
    if (repo) return;
    repo = await getRepositoryAsync();
    // Identity sync runs in the JMAP backend's _continueBootstrap, which
    // is fire-and-forget from start(). That means accountId can be set
    // and our watch can fire before the identities row has been written
    // to SQLite. Subscribe to the IDENTITIES family so we pick it up
    // whenever syncIdentities lands, matching how contacts-store reacts
    // to the CONTACTS family.
    unsubscribe = repo.subscribe(onTablesTouched);
    watch(
      () => authStore.accountId,
      async (newId) => {
        if (newId) {
          await refreshAccount();
          await refreshIdentities();
        } else {
          $reset();
        }
      },
      { immediate: true },
    );
  }

  function detach(): void {
    unsubscribe?.();
    unsubscribe = null;
    repo = null;
    $reset();
  }

  /**
   * Drop every piece of session-scoped state the store holds:
   * identity list, draft contents, status, error, and the open
   * flag. Used by the accountId watch on logout and exposed as
   * $reset for explicit callers (tests, account switching).
   */
  function $reset(): void {
    composeGeneration += 1;
    prefillGeneration += 1;
    identities.value = [];
    accountPrimaryEmail.value = null;
    resetDraft();
    isOpen.value = false;
    status.value = COMPOSE_STATE.IDLE;
    error.value = null;
    clearNotice();
  }

  function setNotice(message: string): void {
    notice.value = message;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      notice.value = null;
      noticeTimer = null;
    }, 6000);
  }

  function clearNotice(): void {
    notice.value = null;
    if (noticeTimer) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
  }

  function onTablesTouched(tables: string[]): void {
    if (!tables.includes(TABLE_FAMILIES.IDENTITIES)) return;
    if (authStore.accountId == null) return;
    refreshIdentities().catch((err) => {
      console.warn('[compose-store] refresh after broadcast failed', err);
    });
  }

  async function refreshAccount(): Promise<void> {
    if (!repo || authStore.accountId == null) {
      accountPrimaryEmail.value = null;
      return;
    }
    if (typeof repo.getAccount !== 'function') {
      accountPrimaryEmail.value = null;
      return;
    }
    const account = await repo.getAccount(authStore.accountId);
    accountPrimaryEmail.value = account?.primary_email ?? null;
  }

  function defaultFromIdx(): number {
    return resolveComposeIdentityIndex(identities.value, {
      remembered: readRememberedIdentity(authStore.accountId),
      primaryEmail: accountPrimaryEmail.value,
    });
  }

  function reconcileFromIdxAfterIdentityRefresh(previousIdentity: IdentityRow | null): void {
    if (identities.value.length === 0) {
      draft.fromIdx = 0;
      return;
    }

    const preservedIdx = findMatchingIdentityIndex(identities.value, previousIdentity);
    if (preservedIdx >= 0) {
      draft.fromIdx = preservedIdx;
      return;
    }

    if (isOpen.value || draft.fromIdx >= identities.value.length) {
      draft.fromIdx = defaultFromIdx();
    }
  }

  async function refreshIdentities(): Promise<void> {
    if (!repo || authStore.accountId == null) return;
    const previousIdentity = fromIdentity.value;
    identities.value = await repo.listIdentities(authStore.accountId);
    reconcileFromIdxAfterIdentityRefresh(previousIdentity);
  }

  /**
   * Ask the server for the identity list, without making anyone wait.
   *
   * An alias added on another device does not exist locally until something
   * fetches it, and nothing did: the list was read once at login, which
   * meant restarting the app to send from a new address (CS-4.6). What is
   * cached is already on screen, so this refreshes behind it — the answer
   * arrives as an IDENTITIES broadcast, which the subscription above turns
   * into a repaint whether or not this call is still being awaited.
   *
   * Failure is not surfaced: composing with the identities we have is the
   * correct outcome of a refresh that could not reach the server.
   */
  function refreshIdentitiesFromServer(): void {
    if (!repo || authStore.accountId == null) return;
    void repo.ensureIdentities(authStore.accountId).catch(() => {});
  }

  /**
   * Return the draft and the recipient state to empty.
   *
   * The recipient arrays are replaced rather than emptied in place so a
   * prefill's array cannot be aliased by the draft and mutated by later
   * editing.
   */
  function resetDraft(prefill: Partial<Draft> = {}): void {
    draftEpoch.value += 1;
    Object.assign(draft, emptyDraft(), prefill);
    for (const field of RECIPIENT_FIELDS) {
      draft[field] = [...(prefill[field] ?? [])];
      rejectedRecipients[field] = [];
    }
    draft.inReplyTo = [...(prefill.inReplyTo ?? [])];
    draft.references = [...(prefill.references ?? [])];
  }

  function open(prefill: Partial<Draft> = {}): void {
    composeGeneration += 1;
    prefillGeneration += 1;
    resetDraft(prefill);
    if (!Object.prototype.hasOwnProperty.call(prefill, 'fromIdx')) {
      draft.fromIdx = defaultFromIdx();
    }
    isOpen.value = true;
    status.value = COMPOSE_STATE.EDITING;
    error.value = null;
    clearNotice();
    refreshIdentitiesFromServer();
  }

  /**
   * Discard the composer and its draft.
   *
   * Refused while a send is in flight. The queued mutation keeps running
   * in the worker after the dialog closes, and its request payload is
   * the only durable copy of the message, so wiping the draft here would
   * leave the user with nothing to recover if the send then failed.
   * Returns false when the request was refused.
   */
  function close(): boolean {
    if (status.value === COMPOSE_STATE.SENDING) return false;
    isOpen.value = false;
    status.value = COMPOSE_STATE.IDLE;
    resetDraft();
    error.value = null;
    return true;
  }

  function selectFromIndex(value: number | string): void {
    const parsed = typeof value === 'number' ? value : Number(value);
    const maxIdx = identities.value.length - 1;
    const nextIdx = Number.isFinite(parsed)
      ? Math.min(Math.max(Math.trunc(parsed), 0), Math.max(maxIdx, 0))
      : 0;
    draft.fromIdx = nextIdx;
    rememberIdentity(authStore.accountId, fromIdentity.value);
  }

  /**
   * Replace a field from a control that holds recipients one at a time.
   *
   * The order the two kinds are shown in is the control's business, not the
   * draft's: what the message carries is the addresses, and what stops it
   * being sent is the presence of anything else.
   */
  function setRecipientEntries(
    field: RecipientField,
    entries: readonly RecipientEntry[],
  ): void {
    draft[field] = entries
      .filter((entry): entry is ParsedAddress => 'email' in entry)
      .map((entry) => ({ ...entry }));
    rejectedRecipients[field] = entries
      .filter((entry): entry is InvalidRecipient => 'invalid' in entry)
      .map((entry) => entry.text);
  }

  /**
   * A recipient field as entries, addresses first.
   *
   * Read when the draft has been replaced, where interleaved order is not
   * recoverable and does not exist yet: a reply's audience is addresses
   * alone, and a fragment only arrives once someone types one.
   */
  function recipientEntries(field: RecipientField): RecipientEntry[] {
    return [
      ...draft[field].map((address) => ({ ...address })),
      ...rejectedRecipients[field].map((text) => ({ text, invalid: true as const })),
    ];
  }

  /** Every address this account can send as, for excluding from a reply. */
  function ownedEmails(): string[] {
    return [
      ...identities.value.map((identity) => identity.email),
      accountPrimaryEmail.value,
    ].filter((email): email is string => !!email);
  }

  function prepareReply(
    { to, subject, html, text }: { to?: string; subject?: string; html?: string; text?: string },
  ): void {
    open({
      to: to ? parseAddressList(to).addresses : [],
      subject: subject ?? '',
      htmlBody: html ?? '',
      textBody: text ?? '',
    });
  }

  /**
   * The parent's addresses, or null when they cannot be read.
   *
   * Null is not the same as a message with no addresses: it means the
   * audience is unknown, and a reply-all computed from nothing would
   * quietly drop every recipient. Callers fall back to the narrower reply
   * rather than mailing a smaller audience than the user asked for.
   */
  async function parentAddresses(messageId: number | null | undefined) {
    if (!repo || messageId == null) return null;
    try {
      return await repo.listMessageAddresses(messageId);
    } catch (err) {
      console.warn('[compose-store] could not read the addresses of the parent message', err);
      return null;
    }
  }

  /**
   * Build a reply to `message`, addressing it from the parent's structured
   * addresses and threading it to the parent (CS-2.5, CS-2.6).
   */
  async function prepareReplyToMessage(
    message: Pick<
      MessageRow,
      'id' | 'from_text' | 'subject' | 'received_at' | 'rfc822_message_id'
      | 'references_json' | 'in_reply_to_json'
    >,
    body: { html?: string | null; text?: string | null },
    all: boolean,
  ): Promise<void> {
    const gesture = (prefillGeneration += 1);
    const addresses = await parentAddresses(message.id);
    // Another reply, a forward, or a logout happened while this one was
    // reading the parent. Whatever replaced it is what the user asked for.
    if (gesture !== prefillGeneration) return;
    const audience = addresses
      ? buildReplyAudience({ addresses, ownedEmails: ownedEmails(), all })
      : { to: parseAddressList(message.from_text ?? '').addresses, cc: [] };
    const { inReplyTo, references } = buildThreadHeaders(message);
    open({
      to: audience.to,
      cc: audience.cc,
      inReplyTo,
      references,
      subject: makeReplySubject(message.subject),
      htmlBody: buildQuotedHtml({
        from: message.from_text,
        date: message.received_at,
        subject: message.subject,
        html: body.html,
        text: body.text,
      }),
      textBody: buildQuotedText({
        from: message.from_text,
        date: message.received_at,
        subject: message.subject,
        text: body.text,
      }),
    });
  }

  function prepareReplyFromMessage(
    message: Parameters<typeof prepareReplyToMessage>[0],
    body: { html?: string | null; text?: string | null } = {},
  ): Promise<void> {
    return prepareReplyToMessage(message, body, false);
  }

  function prepareReplyAll(
    message: Parameters<typeof prepareReplyToMessage>[0],
    body: { html?: string | null; text?: string | null } = {},
  ): Promise<void> {
    return prepareReplyToMessage(message, body, true);
  }

  function prepareForward(
    message: Pick<MessageRow, 'from_text' | 'subject' | 'received_at'>,
    body: { html?: string | null; text?: string | null } = {},
  ): void {
    open({
      subject: makeForwardSubject(message.subject),
      htmlBody: buildQuotedHtml({
        from: message.from_text,
        date: message.received_at,
        subject: message.subject,
        html: body.html,
        text: body.text,
      }),
      textBody: buildQuotedText({
        from: message.from_text,
        date: message.received_at,
        subject: message.subject,
        text: body.text,
      }),
    });
  }

  function failSend(message: string): false {
    status.value = COMPOSE_STATE.FAILED;
    error.value = message;
    return false;
  }

  /**
   * What a finished mutation row says about a send whose confirmation
   * never arrived: whether the outcome is recorded as unknown, and
   * whether the created Email is known to exist on the server.
   *
   * Every path that parks a send records the same `outcomeUnknown` type —
   * the outbox itself, and the crash recovery at startup — so reading the
   * row also covers a park the caller was not waiting on.
   *
   * `emailOnServer` comes from the send checkpoint the row carries in
   * `server_response_json` (send-checkpoint.ts): a recorded Email id
   * means the message text lives in a mailbox — Sent if the submission
   * was accepted, Drafts if it was not — so the folders will show what
   * happened. Without one, this composer holds the only copy the user
   * can reach. A row with no readable checkpoint reads as "no server
   * copy", which errs toward keeping the draft open.
   */
  async function readUnknownSend(mutationId: number | null | undefined): Promise<{
    unknown: boolean;
    emailOnServer: boolean;
  }> {
    const nothing = { unknown: false, emailOnServer: false };
    if (!repo || mutationId == null) return nothing;
    try {
      const row = await repo.getPendingMutationError(mutationId);
      if (!row) return nothing;
      let emailOnServer = false;
      if (row.server_response_json) {
        try {
          emailOnServer =
            typeof JSON.parse(row.server_response_json)?.emailRemoteId === 'string';
        } catch {
          // An unreadable checkpoint proves nothing about a server copy.
        }
      }
      const unknown = row.error_json
        ? JSON.parse(row.error_json)?.type === 'outcomeUnknown'
        : false;
      return { unknown, emailOnServer };
    } catch {
      // No readable error means nothing to warn about; the generic
      // failure message below is still correct.
      return nothing;
    }
  }

  async function send(): Promise<boolean> {
    if (status.value === COMPOSE_STATE.SENDING) return false;
    if (!repo || authStore.accountId == null) return failSend('Not connected.');
    const identity = fromIdentity.value;
    if (!identity) return failSend('No identities are configured.');
    // Report what could not be read before anything else: a fragment left
    // in a recipient field is a recipient the user believes they added, and
    // sending without it delivers to a smaller audience than they asked
    // for (CS-2.4).
    const rejected = RECIPIENT_FIELDS.flatMap((field) => rejectedRecipients[field]);
    if (rejected.length > 0) {
      return failSend(
        rejected.length === 1
          ? `${rejected[0]} is not an email address.`
          : `These are not email addresses: ${rejected.join(', ')}`,
      );
    }
    // Any of the three carries the message, so requiring To would refuse a
    // send the user has every right to make (CS-2.2).
    if (recipientCount.value === 0) return failSend('Add at least one recipient.');

    const folders = mailStore.folders as FolderRow[];
    const findByRole = (role: MailboxRole) => folders.find((f) => f.role === role);
    const drafts = findByRole('drafts');
    const sent = findByRole('sent');
    // 'outbox' is not a JMAP role per RFC 8621 §2 — this find() is
    // effectively a no-op against a real Stalwart server. Kept for
    // back-compat with any backend that surfaces a custom role.
    // Cast to MailboxRole because 'outbox' is not in the RFC-8621 union
    // but appears on backends that surface a custom role with the same
    // semantics.
    const outbox = folders.find((f) => f.role === ('outbox' as MailboxRole));

    status.value = COMPOSE_STATE.SENDING;
    error.value = null;
    // The composer this send belongs to. Logout ($reset) and opening
    // another message both bump the counter, and neither waits for an
    // in-flight send, so the result below has to prove it is still
    // relevant before touching shared state.
    const generation = composeGeneration;
    const stillCurrent = () => generation === composeGeneration;
    try {
      // Mutation payload carries local row ids only; the JMAP outbox
      // resolves identity and folder remote ids at dispatch time, the
      // same way moveToFolders / setKeywords / destroy already do.
      // Keeping protocol values out of the store keeps the layer
      // boundary clean and lets a non-JMAP backend reuse the row
      // shape unchanged.
      const mutation = await repo.insertPendingMutation({
        accountId: authStore.accountId,
        mutationType: MUTATION_TYPE.SEND,
        targetMessageId: null,
        requestJson: JSON.stringify({
          identityId: identity.id,
          to: draft.to,
          cc: draft.cc,
          bcc: draft.bcc,
          replyTo: identityReplyTo(identity),
          subject: draft.subject,
          textBody: draft.textBody,
          htmlBody: draft.htmlBody,
          inReplyTo: draft.inReplyTo,
          references: draft.references,
          draftsFolderId: drafts?.id ?? null,
          sentFolderId: sent?.id ?? null,
          outboxFolderId: outbox?.id ?? null,
        }),
        optimisticPatchJson: null,
      });
      // Wait on THIS row specifically rather than draining the whole
      // account queue. drainOutbox would also block on any unrelated
      // pending setKeywords / move rows that happen to be in flight,
      // turning a "send" click into a wait for arbitrary background
      // work. runMutation also avoids the inverse case: a parallel
      // markRead enqueued just before us would have been counted in
      // drainOutbox's failed/succeeded tally and our success branch
      // could have falsely reported a send failure.
      const result = typeof repo.runMutation === 'function' && mutation?.id != null
        ? await repo.runMutation(authStore.accountId, mutation.id)
        : await repo.drainOutbox(authStore.accountId);
      // A mutation can fail after the server accepted the message: local
      // filing into Sent is repair work that runs past the point of no
      // return. Calling that a failed send would invite a second press of
      // Send, and a second press is a second delivery.
      // Positive evidence only. A zero-count outcome means the runner
      // never reached the row — it was stopped, or the row was in a state
      // it will not process — and reading "nothing failed" as success
      // there would confirm a send that never happened.
      const submitted = (result.succeeded > 0 && result.failed === 0)
        || result.result?.submitted === true;
      if (!submitted) {
        // The outcome reports an unknown ending directly when the runner
        // knows; otherwise the row's own error does (a park by crash
        // recovery, say).
        const parked = await readUnknownSend(mutation?.id);
        const unknown = result.errorType === 'outcomeUnknown' || parked.unknown;
        if (!stillCurrent()) return false;
        if (unknown && parked.emailOnServer) {
          // The message text is on the server: in Sent if the submission
          // was accepted, still in Drafts if it was not. Nothing here can
          // tell which, but the mailbox itself will as it syncs, so the
          // composer closes and says where to look rather than holding
          // the draft behind a state only Discard could leave (CS-1.9).
          status.value = COMPOSE_STATE.IDLE;
          close();
          setNotice(
            'Could not confirm this send. If it went out it is in your '
            + 'Sent folder; if not, the message is in Drafts.',
          );
          return false;
        }
        if (unknown) {
          // No Email is known to exist on the server, so the text in this
          // dialog is the only copy the user can reach: it stays open.
          // Send stays offered too — never resubmitted automatically, but
          // after checking Sent, sending again is the user's call (CS-1.9).
          return failSend(
            'Could not confirm whether this message was sent. Check your '
            + 'Sent folder before sending it again.',
          );
        }
        return failSend('Send failed; the message stays in your outbox.');
      }
      if (!stillCurrent()) return true;
      status.value = COMPOSE_STATE.SENT;
      close();
      // Confirmation is deliberately about acceptance, not arrival: the
      // server has taken the message, and nothing the client can observe
      // proves it reached the recipient (CS-1.13).
      setNotice(result.result?.filed === false
        ? 'Message accepted for delivery. Your Sent folder will show it shortly.'
        : 'Message accepted for delivery.');
      return true;
    } catch (err: any) {
      if (!stillCurrent()) return false;
      return failSend(err?.message ?? String(err));
    }
  }

  return {
    status,
    error,
    notice,
    clearNotice,
    isOpen,
    identities,
    draft,
    draftEpoch,
    rejectedRecipients,
    recipientCount,
    fromIdentity,
    $reset,
    attach,
    detach,
    refreshIdentities,
    open,
    close,
    selectFromIndex,
    setRecipientEntries,
    recipientEntries,
    prepareReply,
    prepareReplyFromMessage,
    prepareReplyAll,
    prepareForward,
    send,
  };
});
