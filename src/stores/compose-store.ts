/**
 * Compose state. Holds the in-flight draft and the identity picker.
 * Send is implemented as a pending_mutations row plus a drainOutbox
 * call on the worker, so the UI can dismiss the composer immediately
 * and the actual JMAP submission proceeds asynchronously.
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
  buildReplyAllRecipients,
  makeForwardSubject,
  makeReplySubject,
} from '../utils/compose-quote';
import { parseAddressList } from '../utils/address-list';

interface Draft {
  fromIdx: number;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  textBody: string;
  htmlBody: string;
}

const EMPTY_DRAFT: Readonly<Draft> = Object.freeze({
  fromIdx: 0,
  to: '',
  cc: '',
  bcc: '',
  subject: '',
  textBody: '',
  htmlBody: '',
});

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
  const isOpen = ref(false);
  const identities = ref<IdentityRow[]>([]);
  const accountPrimaryEmail = ref<string | null>(null);
  const draft = reactive<Draft>({ ...EMPTY_DRAFT });
  let repo: Repository | null = null;
  let unsubscribe: (() => void) | null = null;

  const fromIdentity = computed<IdentityRow | null>(() =>
    identities.value[draft.fromIdx] ?? identities.value[0] ?? null,
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
    identities.value = [];
    accountPrimaryEmail.value = null;
    Object.assign(draft, EMPTY_DRAFT);
    isOpen.value = false;
    status.value = COMPOSE_STATE.IDLE;
    error.value = null;
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

  function open(prefill: Partial<Draft> = {}): void {
    Object.assign(draft, EMPTY_DRAFT, prefill);
    if (!Object.prototype.hasOwnProperty.call(prefill, 'fromIdx')) {
      draft.fromIdx = defaultFromIdx();
    }
    isOpen.value = true;
    status.value = COMPOSE_STATE.EDITING;
    error.value = null;
  }

  function close(): void {
    isOpen.value = false;
    status.value = COMPOSE_STATE.IDLE;
    Object.assign(draft, EMPTY_DRAFT);
    error.value = null;
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

  function prepareReply(
    { to, subject, html, text }: { to?: string; subject?: string; html?: string; text?: string },
  ): void {
    open({
      to: to ?? '',
      subject: subject ?? '',
      htmlBody: html ?? '',
      textBody: text ?? '',
    });
  }

  function prepareReplyFromMessage(
    message: Pick<MessageRow, 'from_text' | 'subject' | 'received_at'>,
    body: { html?: string | null; text?: string | null } = {},
  ): void {
    prepareReply({
      to: message.from_text ?? '',
      subject: makeReplySubject(message.subject),
      html: buildQuotedHtml({
        from: message.from_text,
        date: message.received_at,
        subject: message.subject,
        html: body.html,
        text: body.text,
      }),
      text: buildQuotedText({
        from: message.from_text,
        date: message.received_at,
        subject: message.subject,
        text: body.text,
      }),
    });
  }

  function prepareReplyAll(
    message: Pick<MessageRow, 'from_text' | 'to_text' | 'subject' | 'received_at'>,
    body: { html?: string | null; text?: string | null } = {},
  ): void {
    const { to, cc } = buildReplyAllRecipients({
      fromText: message.from_text,
      toText: message.to_text,
      selfEmail: fromIdentity.value?.email ?? null,
    });
    open({
      to,
      cc,
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

  async function send(): Promise<boolean> {
    if (!repo || authStore.accountId == null) return failSend('Not connected.');
    const identity = fromIdentity.value;
    if (!identity) return failSend('No identities are configured.');
    const toList = parseAddressList(draft.to);
    if (toList.length === 0) return failSend('Add at least one recipient.');

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
          to: toList,
          cc: parseAddressList(draft.cc),
          bcc: parseAddressList(draft.bcc),
          subject: draft.subject,
          textBody: draft.textBody,
          htmlBody: draft.htmlBody,
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
      if (result.failed > 0) {
        return failSend('Send failed; the message stays in your outbox.');
      }
      status.value = COMPOSE_STATE.SENT;
      close();
      return true;
    } catch (err: any) {
      return failSend(err?.message ?? String(err));
    }
  }

  return {
    status,
    error,
    isOpen,
    identities,
    draft,
    fromIdentity,
    $reset,
    attach,
    detach,
    refreshIdentities,
    open,
    close,
    selectFromIndex,
    prepareReply,
    prepareReplyFromMessage,
    prepareReplyAll,
    prepareForward,
    send,
  };
});
