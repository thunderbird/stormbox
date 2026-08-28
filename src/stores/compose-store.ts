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
import type {
  BodyAttachmentRow,
  FolderRow,
  IdentityRow,
  MessageRow,
} from '../types';
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
  parseAddressEntries,
  parseAddressList,
  type ParsedAddress,
} from '../utils/address-parse';
import { buildReplyAudience, buildThreadHeaders } from '../utils/reply';
import { addressKey } from '../utils/address-key';
import { isInlineImageType } from '../utils/message-html';
import { makeMessageId, makeOperationId } from '../utils/message-id';
import { editSafeDraftHtml } from '../utils/compose-html';

export type RecipientField = 'to' | 'cc' | 'bcc';

export const RECIPIENT_FIELDS: readonly RecipientField[] = ['to', 'cc', 'bcc'];
export const INVALID_RECIPIENT_MESSAGE =
  'Fix invalid recipients before saving or sending this message.';

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

export interface Draft {
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
  attachments: BodyAttachmentRow[];
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
    attachments: [],
    inReplyTo: [],
    references: [],
  };
}

export const COMPOSE_PRESENTATION = {
  EXPANDED: 'expanded',
  MINIMIZED: 'minimized',
} as const;

export type ComposePresentation =
  (typeof COMPOSE_PRESENTATION)[keyof typeof COMPOSE_PRESENTATION];

export interface ConfirmedDraftRevision {
  emailId: string;
  localMessageId: number | null;
  revision: number;
  messageId: string;
  payloadHash: string;
}

export interface ComposeSession {
  id: string;
  presentation: ComposePresentation;
  status: ComposeState;
  error: string | null;
  saveError: string | null;
  isSaving: boolean;
  isDiscarding: boolean;
  closePromptOpen: boolean;
  draft: Draft;
  recipientEntriesByField: Record<RecipientField, RecipientEntry[]>;
  rejectedRecipients: Record<RecipientField, string[]>;
  pendingRecipientText: Record<RecipientField, string>;
  draftEpoch: number;
  generation: number;
  seedJson: string;
  revision: number;
  confirmedRevision: ConfirmedDraftRevision | null;
  sourceMessageId: number | null;
  unresolvedFrom: ParsedAddress | null;
  failedSaveMutationId: number | null;
  failedSaveSeedJson: string | null;
  failedSaveRequest: Record<string, any> | null;
}

function hasInvalidRecipientPills(session: ComposeSession): boolean {
  return RECIPIENT_FIELDS.some((field) => session.rejectedRecipients[field].length > 0);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled compose presentation: ${String(value)}`);
}

export function isExpandedPresentation(presentation: ComposePresentation): boolean {
  switch (presentation) {
    case COMPOSE_PRESENTATION.EXPANDED:
      return true;
    case COMPOSE_PRESENTATION.MINIMIZED:
      return false;
    default:
      return assertNever(presentation);
  }
}

function makeSessionId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `compose-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cloneDraft(prefill: Partial<Draft> = {}): Draft {
  return {
    ...emptyDraft(),
    ...prefill,
    to: [...(prefill.to ?? [])].map((entry) => ({ ...entry })),
    cc: [...(prefill.cc ?? [])].map((entry) => ({ ...entry })),
    bcc: [...(prefill.bcc ?? [])].map((entry) => ({ ...entry })),
    attachments: [...(prefill.attachments ?? [])].map((attachment) => ({ ...attachment })),
    inReplyTo: [...(prefill.inReplyTo ?? [])],
    references: [...(prefill.references ?? [])],
  };
}

function emptyRejectedRecipients(): Record<RecipientField, string[]> {
  return { to: [], cc: [], bcc: [] };
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
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

  // Transient send confirmation, rendered by StoreErrorToast after the
  // dialog has closed. Cleared on a timer the same way mail-store's
  // notice is, so it never lingers over a later screen.
  const notice = ref<string | null>(null);
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  const sessions = ref<ComposeSession[]>([]);
  const activeSessionId = ref<string | null>(null);
  const fallbackDraft = reactive<Draft>(emptyDraft());
  const fallbackRejectedRecipients = reactive<Record<RecipientField, string[]>>(
    emptyRejectedRecipients(),
  );
  const fallbackStatus = ref<ComposeState>(COMPOSE_STATE.IDLE);
  const fallbackError = ref<string | null>(null);
  let sessionGeneration = 0;
  // Bumped by every prefill gesture, every open(), and $reset(). A reply has
  // to read the parent's addresses before it can open, so two quick gestures
  // settle in completion order rather than in the order they were made: the
  // slower read would otherwise open the composer quoting and addressing the
  // message the user had already moved on from.
  let prefillGeneration = 0;
  const identities = ref<IdentityRow[]>([]);
  const accountPrimaryEmail = ref<string | null>(null);
  let repo: Repository | null = null;
  let unsubscribe: (() => void) | null = null;

  function sessionById(id: string | null | undefined): ComposeSession | null {
    if (!id) return null;
    return sessions.value.find((session) => session.id === id) ?? null;
  }

  const activeSession = computed(() => sessionById(activeSessionId.value));
  const isOpen = computed(() => sessions.value.length > 0);
  const isExpanded = computed(() => {
    const session = activeSession.value;
    return !!session && isExpandedPresentation(session.presentation);
  });
  const draft = computed(() => activeSession.value?.draft ?? fallbackDraft);
  const rejectedRecipients = computed(() =>
    activeSession.value?.rejectedRecipients ?? fallbackRejectedRecipients);
  const draftEpoch = computed(() => activeSession.value?.draftEpoch ?? 0);
  const status = computed<ComposeState>({
    get: () => activeSession.value?.status ?? fallbackStatus.value,
    set: (value) => {
      const session = activeSession.value;
      if (session) session.status = value;
      else fallbackStatus.value = value;
    },
  });
  const error = computed<string | null>({
    get: () => activeSession.value?.error ?? fallbackError.value,
    set: (value) => {
      const session = activeSession.value;
      if (session) session.error = value;
      else fallbackError.value = value;
    },
  });

  const fromIdentity = computed<IdentityRow | null>(() =>
    identities.value[draft.value.fromIdx] ?? identities.value[0] ?? null,
  );

  /** Recipients across all three fields; any of them can carry a send. */
  const recipientCount = computed(() =>
    RECIPIENT_FIELDS.reduce((total, field) => total + draft.value[field].length, 0),
  );
  const autosaveRuntime = new Map<string, {
    timer: ReturnType<typeof setTimeout> | null;
    firstDirtyAt: number | null;
    inFlight: Promise<boolean> | null;
    queued: boolean;
    blocked: boolean;
  }>();
  const AUTOSAVE_DEBOUNCE_MS = 2_000;
  const AUTOSAVE_MAX_DELAY_MS = 30_000;

  function runtimeFor(sessionId: string) {
    let runtime = autosaveRuntime.get(sessionId);
    if (!runtime) {
      runtime = {
        timer: null,
        firstDirtyAt: null,
        inFlight: null,
        queued: false,
        blocked: false,
      };
      autosaveRuntime.set(sessionId, runtime);
    }
    return runtime;
  }

  function clearAutosaveTimer(sessionId: string): void {
    const runtime = autosaveRuntime.get(sessionId);
    if (!runtime?.timer) return;
    clearTimeout(runtime.timer);
    runtime.timer = null;
  }

  function disposeSessionRuntime(sessionId: string): void {
    clearAutosaveTimer(sessionId);
    const runtime = autosaveRuntime.get(sessionId);
    if (runtime) runtime.blocked = true;
    autosaveRuntime.delete(sessionId);
  }

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
   * identity list, compose sessions, status, and error. Used by the
   * accountId watch on logout and exposed as
   * $reset for explicit callers (tests, account switching).
   */
  function $reset(): void {
    sessionGeneration += 1;
    prefillGeneration += 1;
    for (const sessionId of autosaveRuntime.keys()) disposeSessionRuntime(sessionId);
    identities.value = [];
    accountPrimaryEmail.value = null;
    sessions.value = [];
    activeSessionId.value = null;
    Object.assign(fallbackDraft, emptyDraft());
    Object.assign(fallbackRejectedRecipients, emptyRejectedRecipients());
    fallbackStatus.value = COMPOSE_STATE.IDLE;
    fallbackError.value = null;
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

  function identityForSession(session: ComposeSession | null): IdentityRow | null {
    if (!session) return null;
    if (session.unresolvedFrom) return null;
    return identities.value[session.draft.fromIdx] ?? identities.value[0] ?? null;
  }

  function semanticHtml(html: string): string {
    const compact = String(html ?? '').trim();
    if (/^<(?:p|div)><br\s*\/?><\/(?:p|div)>$/i.test(compact)) return '';
    return compact;
  }

  function semanticText(text: string): string {
    return String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  }

  function canonicalSessionJson(session: ComposeSession): string {
    const identity = identityForSession(session);
    const recipients = (field: RecipientField) => ({
      entries: session.recipientEntriesByField[field].map((entry) =>
        'email' in entry
          ? { email: entry.email, name: entry.name ?? '' }
          : { invalid: true, text: entry.text }),
      pending: session.pendingRecipientText[field],
    });
    return JSON.stringify({
      identity: session.unresolvedFrom?.email
        ?? identity?.remote_id
        ?? identity?.email
        ?? session.draft.fromIdx,
      to: recipients('to'),
      cc: recipients('cc'),
      bcc: recipients('bcc'),
      subject: session.draft.subject,
      textBody: semanticText(session.draft.textBody),
      htmlBody: semanticHtml(session.draft.htmlBody),
      inReplyTo: [...session.draft.inReplyTo],
      references: [...session.draft.references],
      attachments: session.draft.attachments.map((attachment) => ({
        name: attachment.name,
        type: attachment.mime_type,
        size: attachment.size,
        disposition: attachment.disposition,
        cid: attachment.cid,
      })),
    });
  }

  function payloadHash(value: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function isSessionDirty(sessionId: string | null = activeSessionId.value): boolean {
    const session = sessionById(sessionId);
    return !!session && canonicalSessionJson(session) !== session.seedJson;
  }

  function isSessionMeaningfullyNonEmpty(
    sessionId: string | null = activeSessionId.value,
  ): boolean {
    const session = sessionById(sessionId);
    if (!session) return false;
    const hasRecipients = RECIPIENT_FIELDS.some((field) =>
      session.draft[field].length > 0
      || session.rejectedRecipients[field].length > 0
      || session.pendingRecipientText[field].trim().length > 0);
    const html = semanticHtml(session.draft.htmlBody);
    const htmlText = html
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .trim();
    return hasRecipients
      || session.draft.subject.trim().length > 0
      || session.draft.textBody.trim().length > 0
      || htmlText.length > 0
      || /<(?:img|video|audio)\b/i.test(html)
      || session.draft.attachments.length > 0;
  }

  function reconcileFromIdxAfterIdentityRefresh(
    session: ComposeSession,
    previousIdentity: IdentityRow | null,
  ): void {
    if (identities.value.length === 0) {
      session.draft.fromIdx = 0;
      return;
    }
    if (session.unresolvedFrom) {
      const unresolved = addressKey(session.unresolvedFrom.email);
      const resolvedIdx = identities.value.findIndex(
        (identity) => addressKey(identity.email) === unresolved,
      );
      if (resolvedIdx >= 0) {
        session.draft.fromIdx = resolvedIdx;
        session.unresolvedFrom = null;
      }
      return;
    }

    const preservedIdx = findMatchingIdentityIndex(identities.value, previousIdentity);
    if (preservedIdx >= 0) {
      session.draft.fromIdx = preservedIdx;
      return;
    }

    if (!previousIdentity || session.draft.fromIdx >= identities.value.length) {
      session.draft.fromIdx = defaultFromIdx();
    }
  }

  async function refreshIdentities(): Promise<void> {
    if (!repo || authStore.accountId == null) return;
    const previousIdentities = new Map(
      sessions.value.map((session) => [session.id, identityForSession(session)]),
    );
    const cleanSessions = new Set(
      sessions.value
        .filter((session) => canonicalSessionJson(session) === session.seedJson)
        .map((session) => session.id),
    );
    identities.value = await repo.listIdentities(authStore.accountId);
    for (const session of sessions.value) {
      reconcileFromIdxAfterIdentityRefresh(
        session,
        previousIdentities.get(session.id) ?? null,
      );
      if (cleanSessions.has(session.id)) session.seedJson = canonicalSessionJson(session);
    }
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

  function open(prefill: Partial<Draft> = {}): string {
    prefillGeneration += 1;
    const expanded = activeSession.value;
    if (expanded?.status === COMPOSE_STATE.SENDING) return expanded.id;
    if (expanded) expanded.presentation = COMPOSE_PRESENTATION.MINIMIZED;

    const nextDraft = cloneDraft(prefill);
    if (!Object.prototype.hasOwnProperty.call(prefill, 'fromIdx')) {
      nextDraft.fromIdx = defaultFromIdx();
    }
    const id = makeSessionId();
    sessionGeneration += 1;
    const session: ComposeSession = reactive({
      id,
      presentation: COMPOSE_PRESENTATION.EXPANDED,
      status: COMPOSE_STATE.EDITING,
      error: null,
      saveError: null,
      isSaving: false,
      isDiscarding: false,
      closePromptOpen: false,
      draft: nextDraft,
      recipientEntriesByField: {
        to: nextDraft.to.map((entry) => ({ ...entry })),
        cc: nextDraft.cc.map((entry) => ({ ...entry })),
        bcc: nextDraft.bcc.map((entry) => ({ ...entry })),
      },
      rejectedRecipients: emptyRejectedRecipients(),
      pendingRecipientText: { to: '', cc: '', bcc: '' },
      draftEpoch: 1,
      generation: sessionGeneration,
      seedJson: '',
      revision: 0,
      confirmedRevision: null,
      sourceMessageId: null,
      unresolvedFrom: null,
      failedSaveMutationId: null,
      failedSaveSeedJson: null,
      failedSaveRequest: null,
    });
    session.seedJson = canonicalSessionJson(session);
    sessions.value.push(session);
    activeSessionId.value = id;
    clearNotice();
    refreshIdentitiesFromServer();
    return id;
  }

  function close(sessionId: string | null = activeSessionId.value): boolean {
    const session = sessionById(sessionId);
    if (!session) return true;
    if (session.status === COMPOSE_STATE.SENDING
        || session.isSaving
        || session.isDiscarding) return false;
    session.generation += 1;
    disposeSessionRuntime(session.id);
    sessions.value = sessions.value.filter((candidate) => candidate.id !== session.id);
    if (activeSessionId.value === session.id) activeSessionId.value = null;
    return true;
  }

  function minimize(sessionId: string | null = activeSessionId.value): boolean {
    const session = sessionById(sessionId);
    if (!session
        || session.status === COMPOSE_STATE.SENDING
        || session.isSaving
        || session.isDiscarding) return false;
    session.presentation = COMPOSE_PRESENTATION.MINIMIZED;
    if (activeSessionId.value === session.id) activeSessionId.value = null;
    return true;
  }

  function restore(sessionId: string): boolean {
    const session = sessionById(sessionId);
    if (!session) return false;
    const expanded = activeSession.value;
    if (expanded?.id === session.id) return true;
    if (expanded?.status === COMPOSE_STATE.SENDING) return false;
    if (expanded) expanded.presentation = COMPOSE_PRESENTATION.MINIMIZED;
    session.presentation = COMPOSE_PRESENTATION.EXPANDED;
    activeSessionId.value = session.id;
    return true;
  }

  function selectFromIndex(
    value: number | string,
    sessionId: string | null = activeSessionId.value,
  ): void {
    const session = sessionById(sessionId);
    if (!session) return;
    const parsed = typeof value === 'number' ? value : Number(value);
    const maxIdx = identities.value.length - 1;
    const nextIdx = Number.isFinite(parsed)
      ? Math.min(Math.max(Math.trunc(parsed), 0), Math.max(maxIdx, 0))
      : 0;
    session.draft.fromIdx = nextIdx;
    session.unresolvedFrom = null;
    rememberIdentity(authStore.accountId, identityForSession(session));
    touchSession(session.id);
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
    sessionId: string | null = activeSessionId.value,
  ): void {
    const session = sessionById(sessionId);
    if (!session) return;
    session.recipientEntriesByField[field] = entries.map((entry) => ({ ...entry }));
    session.draft[field] = session.recipientEntriesByField[field]
      .filter((entry): entry is ParsedAddress => 'email' in entry)
      .map((entry) => ({ ...entry }));
    session.rejectedRecipients[field] = session.recipientEntriesByField[field]
      .filter((entry): entry is InvalidRecipient => 'invalid' in entry)
      .map((entry) => entry.text);
    if (!hasInvalidRecipientPills(session)) {
      if (session.saveError === INVALID_RECIPIENT_MESSAGE) session.saveError = null;
      if (session.error === INVALID_RECIPIENT_MESSAGE) session.error = null;
    }
    touchSession(session.id);
  }

  function setPendingRecipientText(
    field: RecipientField,
    value: string,
    sessionId: string | null = activeSessionId.value,
  ): void {
    const session = sessionById(sessionId);
    if (!session) return;
    session.pendingRecipientText[field] = value;
    touchSession(session.id);
  }

  /**
   * A recipient field as entries, addresses first.
   *
   * Read when the draft has been replaced, where interleaved order is not
   * recoverable and does not exist yet: a reply's audience is addresses
   * alone, and a fragment only arrives once someone types one.
   */
  function recipientEntries(
    field: RecipientField,
    sessionId: string | null = activeSessionId.value,
  ): RecipientEntry[] {
    const session = sessionById(sessionId);
    if (!session) return [];
    return session.recipientEntriesByField[field].map((entry) => ({ ...entry }));
  }

  function hasPendingRecipientText(session: ComposeSession): boolean {
    return RECIPIENT_FIELDS.some((field) => session.pendingRecipientText[field].trim());
  }

  function commitPendingRecipientText(session: ComposeSession): void {
    let changed = false;
    for (const field of RECIPIENT_FIELDS) {
      const text = session.pendingRecipientText[field].trim();
      if (!text) continue;
      const parsed = parseAddressEntries(text);
      const additions: RecipientEntry[] = [];
      if (parsed.length === 0) {
        additions.push({ text, invalid: true });
      }
      for (const entry of parsed) {
        if ('address' in entry) additions.push({ ...entry.address });
        else additions.push({ text: entry.rejected, invalid: true });
      }
      session.recipientEntriesByField[field].push(...additions);
      session.draft[field] = session.recipientEntriesByField[field]
        .filter((entry): entry is ParsedAddress => 'email' in entry)
        .map((entry) => ({ ...entry }));
      session.rejectedRecipients[field] = session.recipientEntriesByField[field]
        .filter((entry): entry is InvalidRecipient => 'invalid' in entry)
        .map((entry) => entry.text);
      session.pendingRecipientText[field] = '';
      changed = true;
    }
    if (changed) session.draftEpoch += 1;
  }

  function scheduleAutosave(sessionId: string): void {
    const session = sessionById(sessionId);
    if (!session) return;
    const runtime = runtimeFor(sessionId);
    if (runtime.blocked || session.status === COMPOSE_STATE.SENDING || session.isDiscarding) return;
    if (hasPendingRecipientText(session)) {
      clearAutosaveTimer(sessionId);
      runtime.firstDirtyAt = null;
      return;
    }
    if (!isSessionDirty(sessionId)
        || (!session.confirmedRevision && !isSessionMeaningfullyNonEmpty(sessionId))) {
      clearAutosaveTimer(sessionId);
      runtime.firstDirtyAt = null;
      runtime.queued = false;
      return;
    }
    const now = Date.now();
    runtime.firstDirtyAt ??= now;
    const dueAt = Math.min(now + AUTOSAVE_DEBOUNCE_MS, runtime.firstDirtyAt + AUTOSAVE_MAX_DELAY_MS);
    clearAutosaveTimer(sessionId);
    runtime.timer = setTimeout(() => {
      runtime.timer = null;
      runtime.firstDirtyAt = null;
      void saveDraft(sessionId);
    }, Math.max(0, dueAt - now));
  }

  function touchSession(sessionId: string | null = activeSessionId.value): void {
    if (!sessionId) return;
    scheduleAutosave(sessionId);
  }

  function draftMutationRequest(
    session: ComposeSession,
    identity: IdentityRow,
    capturedJson: string,
  ) {
    const folders = mailStore.folders as FolderRow[];
    const drafts = folders.find((folder) => folder.role === 'drafts');
    return {
      operationId: makeOperationId(),
      draftSessionId: session.id,
      revision: session.revision + 1,
      revisionMessageId: makeMessageId(identity.email),
      payloadHash: payloadHash(capturedJson),
      identityId: identity.id,
      to: session.draft.to.map((address) => ({ ...address })),
      cc: session.draft.cc.map((address) => ({ ...address })),
      bcc: session.draft.bcc.map((address) => ({ ...address })),
      replyTo: identityReplyTo(identity),
      subject: session.draft.subject,
      textBody: session.draft.textBody,
      htmlBody: session.draft.htmlBody,
      attachments: session.draft.attachments.map((attachment) => ({ ...attachment })),
      inReplyTo: [...session.draft.inReplyTo],
      references: [...session.draft.references],
      draftsFolderId: drafts?.id ?? null,
      draftEmailIds: session.confirmedRevision
        ? [session.confirmedRevision.emailId]
        : [],
    };
  }

  async function applyDraftSaveResult(
    session: ComposeSession,
    request: Record<string, any>,
    capturedJson: string,
    result: any,
  ): Promise<boolean> {
    let detail = result?.result;
    if (result?.succeeded > 0
        && result?.failed === 0
        && typeof detail?.emailId !== 'string'
        && repo
        && authStore.accountId != null) {
      const recovered = await repo.findMessageByRfc822MessageId(
        authStore.accountId,
        request.revisionMessageId.replace(/^<|>$/g, ''),
      );
      if (recovered?.remote_id) {
        const recoveredBody = await repo.getMessageBodyForDisplay(
          authStore.accountId,
          recovered.id,
        );
        detail = {
          revision: request.revision,
          emailId: recovered.remote_id,
          localMessageId: recovered.id,
          messageId: request.revisionMessageId,
          payloadHash: request.payloadHash,
          attachments: recoveredBody?.attachments ?? [],
        };
      }
    }
    if (!(result?.succeeded > 0 && result?.failed === 0)
        || typeof detail?.emailId !== 'string') {
      session.saveError = 'Draft could not be saved.';
      return false;
    }
    const current = sessionById(session.id);
    if (!current) return true;
    current.revision = Number.isInteger(detail.revision)
      ? detail.revision
      : request.revision;
    current.confirmedRevision = {
      emailId: detail.emailId,
      localMessageId: Number.isInteger(detail.localMessageId)
        ? detail.localMessageId
        : null,
      revision: current.revision,
      messageId: String(detail.messageId ?? request.revisionMessageId),
      payloadHash: String(detail.payloadHash ?? request.payloadHash),
    };
    if (Array.isArray(detail.attachments)) {
      current.draft.attachments = detail.attachments
        .filter((attachment) => {
          const cid = attachment?.cid?.replace(/^<|>$/g, '');
          return attachment?.disposition !== 'inline'
            || !cid
            || new RegExp(`cid:${cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i')
              .test(current.draft.htmlBody);
        })
        .map((attachment) => ({ ...attachment }));
    }
    current.seedJson = capturedJson;
    current.saveError = hasInvalidRecipientPills(current)
      ? INVALID_RECIPIENT_MESSAGE
      : null;
    current.failedSaveMutationId = null;
    current.failedSaveSeedJson = null;
    current.failedSaveRequest = null;
    return true;
  }

  async function retryFailedDraftSave(
    session: ComposeSession,
    runtime: ReturnType<typeof runtimeFor>,
  ): Promise<boolean> {
    if (!repo
        || authStore.accountId == null
        || session.failedSaveMutationId == null
        || !session.failedSaveSeedJson
        || !session.failedSaveRequest) {
      return false;
    }
    runtime.blocked = false;
    session.isSaving = true;
    session.error = null;
    const task = (async () => {
      try {
        await repo!.retryPendingDraftMutation(
          authStore.accountId!,
          session.failedSaveMutationId!,
        );
        const result = await repo!.runMutation(
          authStore.accountId!,
          session.failedSaveMutationId!,
        );
        return applyDraftSaveResult(
          session,
          session.failedSaveRequest!,
          session.failedSaveSeedJson!,
          result,
        );
      } catch (retryError: any) {
        session.saveError = retryError?.message ?? 'Draft could not be saved.';
        session.error = session.saveError;
        return false;
      }
    })();
    runtime.inFlight = task;
    const saved = await task;
    runtime.inFlight = null;
    session.isSaving = false;
    if (!saved) {
      runtime.blocked = true;
      session.error = session.saveError;
      return false;
    }
    if (isSessionDirty(session.id)) {
      return saveDraft(session.id, { explicit: true });
    }
    return true;
  }

  async function abandonFailedDraftSave(session: ComposeSession): Promise<void> {
    if (!repo
        || authStore.accountId == null
        || session.failedSaveMutationId == null) return;
    await repo.abandonPendingDraftMutation(
      authStore.accountId,
      session.failedSaveMutationId,
    );
    session.failedSaveMutationId = null;
    session.failedSaveSeedJson = null;
    session.failedSaveRequest = null;
  }

  async function saveDraft(
    sessionId: string | null = activeSessionId.value,
    { explicit = false } = {},
  ): Promise<boolean> {
    const session = sessionById(sessionId);
    if (!session) return false;
    const runtime = runtimeFor(session.id);
    if (session.status === COMPOSE_STATE.SENDING || session.isDiscarding) {
      return false;
    }
    if (runtime.blocked) {
      return explicit ? retryFailedDraftSave(session, runtime) : false;
    }
    if (explicit) commitPendingRecipientText(session);
    else if (hasPendingRecipientText(session)) return false;
    clearAutosaveTimer(session.id);
    if (runtime.inFlight) {
      runtime.queued = true;
      const prior = await runtime.inFlight;
      if (!prior && explicit) return false;
      const current = sessionById(session.id);
      if (!current || !isSessionDirty(session.id)) return prior;
      return saveDraft(session.id, { explicit });
    }
    const needsInitialExplicitSave = explicit
      && !session.confirmedRevision
      && isSessionMeaningfullyNonEmpty(session.id);
    if (!isSessionDirty(session.id) && !needsInitialExplicitSave) return true;
    if (!session.confirmedRevision && !isSessionMeaningfullyNonEmpty(session.id)) return true;
    if (!repo || authStore.accountId == null) {
      session.saveError = 'Draft could not be saved while disconnected.';
      if (explicit) session.error = session.saveError;
      return false;
    }
    const identity = identityForSession(session);
    if (!identity) {
      session.saveError = 'Draft could not be saved without a From identity.';
      if (explicit) session.error = session.saveError;
      return false;
    }

    const capturedJson = canonicalSessionJson(session);
    const request = draftMutationRequest(session, identity, capturedJson);
    session.isSaving = true;
    session.saveError = null;
    if (explicit) session.error = null;
    const task = (async () => {
      try {
        const mutation = await repo!.insertPendingMutation({
          accountId: authStore.accountId!,
          mutationType: MUTATION_TYPE.SAVE_DRAFT,
          targetMessageId: session.confirmedRevision?.localMessageId ?? null,
          requestJson: JSON.stringify(request),
          optimisticPatchJson: null,
        });
        session.failedSaveMutationId = mutation?.id ?? null;
        session.failedSaveSeedJson = capturedJson;
        session.failedSaveRequest = request;
        const result = typeof repo!.runMutation === 'function' && mutation?.id != null
          ? await repo!.runMutation(authStore.accountId!, mutation.id)
          : await repo!.drainOutbox(authStore.accountId!);
        const saved = await applyDraftSaveResult(session, request, capturedJson, result);
        if (!saved && explicit) session.error = session.saveError;
        return saved;
      } catch (saveError: any) {
        const current = sessionById(session.id);
        if (current) {
          current.saveError = saveError?.message ?? 'Draft could not be saved.';
          if (explicit) current.error = current.saveError;
        }
        return false;
      }
    })();
    runtime.inFlight = task;
    const saved = await task;
    runtime.inFlight = null;
    session.isSaving = false;
    const needsFollowUp = runtime.queued || isSessionDirty(session.id);
    runtime.queued = false;
    if (saved && needsFollowUp && !runtime.blocked) {
      void saveDraft(session.id);
    } else if (!saved) {
      runtime.blocked = true;
    }
    return saved;
  }

  async function saveAndClose(sessionId: string | null = activeSessionId.value): Promise<boolean> {
    const session = sessionById(sessionId);
    if (!session) return false;
    const saved = await saveDraft(session.id, { explicit: true });
    if (!saved) return false;
    return close(session.id);
  }

  function requestClose(sessionId: string | null = activeSessionId.value): boolean {
    const session = sessionById(sessionId);
    if (!session
        || session.status === COMPOSE_STATE.SENDING
        || session.isSaving
        || session.isDiscarding) return false;
    if (!isSessionDirty(session.id)) return close(session.id);
    if (!isExpandedPresentation(session.presentation) && !restore(session.id)) return false;
    session.closePromptOpen = true;
    return false;
  }

  function cancelClose(sessionId: string | null = activeSessionId.value): void {
    const session = sessionById(sessionId);
    if (session) session.closePromptOpen = false;
  }

  async function closeWithoutSaving(
    sessionId: string | null = activeSessionId.value,
  ): Promise<boolean> {
    const session = sessionById(sessionId);
    if (!session) return true;
    const runtime = runtimeFor(session.id);
    runtime.blocked = true;
    clearAutosaveTimer(session.id);
    if (runtime.inFlight) await runtime.inFlight;
    if (!sessionById(session.id)) return true;
    await abandonFailedDraftSave(session);
    session.closePromptOpen = false;
    return close(session.id);
  }

  async function discardDraft(
    sessionId: string | null = activeSessionId.value,
  ): Promise<boolean> {
    const session = sessionById(sessionId);
    if (!session || session.status === COMPOSE_STATE.SENDING || session.isDiscarding) return false;
    const runtime = runtimeFor(session.id);
    runtime.blocked = true;
    clearAutosaveTimer(session.id);
    if (runtime.inFlight) await runtime.inFlight;
    const current = sessionById(session.id);
    if (!current) return true;
    const emailIds = current.confirmedRevision ? [current.confirmedRevision.emailId] : [];
    if (emailIds.length === 0) {
      await abandonFailedDraftSave(current);
      return close(current.id);
    }
    if (!repo || authStore.accountId == null) {
      current.error = 'Draft could not be discarded while disconnected.';
      runtime.blocked = false;
      return false;
    }
    const drafts = (mailStore.folders as FolderRow[]).find((folder) => folder.role === 'drafts');
    current.isDiscarding = true;
    current.error = null;
    try {
      const mutation = await repo.insertPendingMutation({
        accountId: authStore.accountId,
        mutationType: MUTATION_TYPE.DISCARD_DRAFT,
        targetMessageId: current.confirmedRevision?.localMessageId ?? null,
        requestJson: JSON.stringify({
          draftSessionId: current.id,
          draftsFolderId: drafts?.id ?? null,
          draftEmailIds: emailIds,
        }),
        optimisticPatchJson: null,
      });
      const result = typeof repo.runMutation === 'function' && mutation?.id != null
        ? await repo.runMutation(authStore.accountId, mutation.id)
        : await repo.drainOutbox(authStore.accountId);
      if (!(result?.succeeded > 0 && result?.failed === 0)) {
        current.error = 'Draft could not be discarded.';
        runtime.blocked = false;
        return false;
      }
      await abandonFailedDraftSave(current);
      current.isDiscarding = false;
      return close(current.id);
    } catch (discardError: any) {
      current.error = discardError?.message ?? 'Draft could not be discarded.';
      runtime.blocked = false;
      return false;
    } finally {
      current.isDiscarding = false;
    }
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

  async function editableDraftHtml(
    html: string,
    attachments: BodyAttachmentRow[],
  ): Promise<{ html: string; resolvedCids: Set<string> }> {
    let editable = String(html ?? '');
    const resolvedCids = new Set<string>();
    if (!repo || authStore.accountId == null) {
      return { html: editSafeDraftHtml(editable), resolvedCids };
    }
    for (const attachment of attachments) {
      const cid = attachment.cid?.replace(/^<|>$/g, '');
      if (!cid || !attachment.blob_id || !isInlineImageType(attachment.mime_type)) continue;
      try {
        const blob = await repo.downloadBlob(authStore.accountId, {
          blobId: attachment.blob_id,
          type: attachment.mime_type,
          name: attachment.name,
        });
        if (!blob?.base64 || !blob?.type || !isInlineImageType(blob.type)) continue;
        const escaped = cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const next = editable.replace(
          new RegExp(`cid:(?:%3C|<)?${escaped}(?:%3E|>)?(?=["'\\s>])`, 'gi'),
          `data:${blob.type};base64,${blob.base64}`,
        );
        if (next !== editable) {
          editable = next;
          resolvedCids.add(cid.toLowerCase());
        }
      } catch {
        // The body stays editable; an unresolved cid remains visibly broken.
      }
    }
    return { html: editSafeDraftHtml(editable), resolvedCids };
  }

  async function completeDraftBody(body: {
    html?: string | null;
    text?: string | null;
    attachments?: BodyAttachmentRow[];
    isComplete?: boolean;
    bodyParts?: Array<{
      kind: 'text' | 'html';
      value: string;
      isTruncated: boolean;
      blob_id: string | null;
      mime_type: string | null;
      charset: string | null;
    }>;
    truncatedParts?: Array<{
      kind: 'text' | 'html';
      blob_id: string | null;
      mime_type: string | null;
      charset?: string | null;
    }>;
  }) {
    const completed = {
      ...body,
      html: body.html ?? '',
      text: body.text ?? '',
    };
    const bodyParts = Array.isArray(body.bodyParts) ? body.bodyParts : [];
    for (const kind of ['text', 'html'] as const) {
      const matching = bodyParts.filter((part) => part.kind === kind);
      if (matching.length > 1) return null;
      if (matching.length === 1) completed[kind] = matching[0].value;
    }
    const truncated = Array.isArray(body.truncatedParts) ? body.truncatedParts : [];
    if (body.isComplete !== false && truncated.length === 0) return completed;
    if (!repo || authStore.accountId == null) return null;
    for (const part of truncated) {
      if (!part.blob_id) return null;
      try {
        const blob = await repo.downloadBlob(authStore.accountId, {
          blobId: part.blob_id,
          type: part.mime_type,
          name: `draft-${part.kind}`,
        });
        if (!blob?.base64) return null;
        const bytes = Uint8Array.from(atob(blob.base64), (character) => character.charCodeAt(0));
        completed[part.kind] = new TextDecoder(part.charset || 'utf-8', { fatal: true })
          .decode(bytes);
      } catch {
        return null;
      }
    }
    return completed;
  }

  async function prepareDraftFromMessage(
    message: MessageRow,
    body: {
      html?: string | null;
      text?: string | null;
      attachments?: BodyAttachmentRow[];
      isComplete?: boolean;
      bodyParts?: Array<{
        kind: 'text' | 'html';
        value: string;
        isTruncated: boolean;
        blob_id: string | null;
        mime_type: string | null;
        charset: string | null;
      }>;
      truncatedParts?: Array<{
        kind: 'text' | 'html';
        blob_id: string | null;
        mime_type: string | null;
        charset?: string | null;
      }>;
    } = {},
  ): Promise<string | null> {
    const gesture = (prefillGeneration += 1);
    const existing = sessions.value.find((session) =>
      session.sourceMessageId === message.id
      || session.confirmedRevision?.emailId === message.remote_id);
    if (existing) {
      return restore(existing.id) ? existing.id : null;
    }
    if (!repo || authStore.accountId == null) return null;
    if (activeSession.value?.status === COMPOSE_STATE.SENDING) {
      setNotice('Finish the current send before opening another draft.');
      return null;
    }
    const accountId = authStore.accountId;
    const stillCurrent = () =>
      gesture === prefillGeneration && authStore.accountId === accountId;
    if (typeof repo.isEmailClaimedBySend === 'function'
        && await repo.isEmailClaimedBySend(accountId, message.remote_id)) {
      setNotice('This draft belongs to a send whose outcome is still being resolved.');
      return null;
    }
    if (!stillCurrent()) return null;
    const completedBody = await completeDraftBody(body);
    if (!stillCurrent()) return null;
    if (!completedBody) {
      setNotice('This draft body could not be loaded completely, so it was not opened for editing.');
      return null;
    }
    const addressRows = await repo.listMessageAddresses(message.id);
    if (!stillCurrent()) return null;
    const byKind = (kind: RecipientField) => addressRows
      .filter((row) => row.kind === kind && row.email)
      .sort((left, right) => left.position - right.position)
      .map((row) => ({
        ...(row.name ? { name: row.name } : {}),
        email: row.email,
      }));
    const from = addressRows.find((row) => row.kind === 'from' && row.email);
    const fromKey = addressKey(from?.email);
    const fromIdx = fromKey
      ? identities.value.findIndex((identity) => addressKey(identity.email) === fromKey)
      : -1;
    const attachments = Array.isArray(completedBody.attachments)
      ? completedBody.attachments.map((attachment) => ({ ...attachment }))
      : [];
    const editable = await editableDraftHtml(completedBody.html, attachments);
    if (!stillCurrent()) return null;
    const retainedAttachments = attachments.filter((attachment) => {
      const cid = attachment.cid?.replace(/^<|>$/g, '').toLowerCase();
      return !cid || !editable.resolvedCids.has(cid);
    });
    const sessionId = open({
      ...(fromIdx >= 0 ? { fromIdx } : {}),
      to: byKind('to'),
      cc: byKind('cc'),
      bcc: byKind('bcc'),
      subject: message.subject ?? '',
      textBody: completedBody.text,
      htmlBody: editable.html,
      attachments: retainedAttachments,
      inReplyTo: parseStringArray(message.in_reply_to_json),
      references: parseStringArray(message.references_json),
    });
    const session = sessionById(sessionId);
    if (!session) return null;
    session.sourceMessageId = message.id;
    if (fromKey && fromIdx < 0 && from?.email) {
      session.unresolvedFrom = {
        ...(from.name ? { name: from.name } : {}),
        email: from.email,
      };
    }
    session.revision = 0;
    session.confirmedRevision = {
      emailId: message.remote_id,
      localMessageId: message.id,
      revision: 0,
      messageId: message.rfc822_message_id
        ? `<${message.rfc822_message_id.replace(/^<|>$/g, '')}>`
        : '',
      payloadHash: '',
    };
    session.seedJson = canonicalSessionJson(session);
    session.confirmedRevision.payloadHash = payloadHash(session.seedJson);
    return session.id;
  }

  function failSend(message: string, sessionId: string | null = activeSessionId.value): false {
    const session = sessionById(sessionId);
    if (session) {
      session.status = COMPOSE_STATE.FAILED;
      session.error = message;
      const runtime = autosaveRuntime.get(session.id);
      if (runtime) {
        runtime.blocked = false;
        scheduleAutosave(session.id);
      }
    } else {
      fallbackStatus.value = COMPOSE_STATE.FAILED;
      fallbackError.value = message;
    }
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

  async function send(sessionId: string | null = activeSessionId.value): Promise<boolean> {
    const session = sessionById(sessionId);
    if (!session
        || session.status === COMPOSE_STATE.SENDING
        || session.isDiscarding) return false;
    if (runtimeFor(session.id).blocked && session.saveError) {
      return failSend('Resolve the draft save failure before sending.', session.id);
    }
    if (!repo || authStore.accountId == null) return failSend('Not connected.', session.id);
    const identity = identityForSession(session);
    if (!identity) return failSend('No identities are configured.', session.id);
    commitPendingRecipientText(session);
    const sessionDraft = session.draft;
    // Report what could not be read before anything else: a fragment left
    // in a recipient field is a recipient the user believes they added, and
    // sending without it delivers to a smaller audience than they asked
    // for (CS-2.4).
    const rejected = RECIPIENT_FIELDS.flatMap((field) => session.rejectedRecipients[field]);
    if (rejected.length > 0) {
      return failSend(INVALID_RECIPIENT_MESSAGE, session.id);
    }
    // Any of the three carries the message, so requiring To would refuse a
    // send the user has every right to make (CS-2.2).
    const sessionRecipientCount = RECIPIENT_FIELDS.reduce(
      (total, field) => total + sessionDraft[field].length,
      0,
    );
    if (sessionRecipientCount === 0) return failSend('Add at least one recipient.', session.id);

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

    const sessionRuntime = runtimeFor(session.id);
    clearAutosaveTimer(session.id);
    sessionRuntime.blocked = true;
    if (sessionRuntime.inFlight) await sessionRuntime.inFlight;
    if (!sessionById(session.id)) return false;
    session.presentation = COMPOSE_PRESENTATION.EXPANDED;
    activeSessionId.value = session.id;
    session.status = COMPOSE_STATE.SENDING;
    session.error = null;
    // The composer this send belongs to. Logout ($reset) and opening
    // another message both bump the counter, and neither waits for an
    // in-flight send, so the result below has to prove it is still
    // relevant before touching shared state.
    const generation = session.generation;
    const stillCurrent = () => sessionById(session.id)?.generation === generation;
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
        targetMessageId: session.confirmedRevision?.localMessageId ?? null,
        requestJson: JSON.stringify({
          draftSessionId: session.id,
          identityId: identity.id,
          to: sessionDraft.to,
          cc: sessionDraft.cc,
          bcc: sessionDraft.bcc,
          replyTo: identityReplyTo(identity),
          subject: sessionDraft.subject,
          textBody: sessionDraft.textBody,
          htmlBody: sessionDraft.htmlBody,
          attachments: sessionDraft.attachments.map((attachment) => ({ ...attachment })),
          inReplyTo: sessionDraft.inReplyTo,
          references: sessionDraft.references,
          draftsFolderId: drafts?.id ?? null,
          sentFolderId: sent?.id ?? null,
          outboxFolderId: outbox?.id ?? null,
          draftEmailIds: session.confirmedRevision
            ? [session.confirmedRevision.emailId]
            : [],
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
          session.status = COMPOSE_STATE.IDLE;
          close(session.id);
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
            session.id,
          );
        }
        return failSend('Send failed; the message stays in your outbox.', session.id);
      }
      if (!stillCurrent()) return true;
      session.status = COMPOSE_STATE.SENT;
      close(session.id);
      // Confirmation is deliberately about acceptance, not arrival: the
      // server has taken the message, and nothing the client can observe
      // proves it reached the recipient (CS-1.13).
      setNotice(result.result?.filed === false
        ? 'Message accepted for delivery. Your Sent folder will show it shortly.'
        : 'Message accepted for delivery.');
      return true;
    } catch (err: any) {
      if (!stillCurrent()) return false;
      return failSend(err?.message ?? String(err), session.id);
    }
  }

  return {
    status,
    error,
    notice,
    clearNotice,
    sessions,
    activeSessionId,
    activeSession,
    isOpen,
    isExpanded,
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
    sessionById,
    identityForSession,
    open,
    close,
    minimize,
    restore,
    isSessionDirty,
    isSessionMeaningfullyNonEmpty,
    touchSession,
    saveDraft,
    saveAndClose,
    requestClose,
    cancelClose,
    closeWithoutSaving,
    discardDraft,
    selectFromIndex,
    setRecipientEntries,
    setPendingRecipientText,
    recipientEntries,
    prepareReply,
    prepareReplyFromMessage,
    prepareReplyAll,
    prepareForward,
    prepareDraftFromMessage,
    send,
  };
});
