/**
 * Compose state. Holds the in-flight draft and the identity picker.
 * Send is implemented as a pending_mutations row plus a drainOutbox
 * call on the worker, so the UI can dismiss the composer immediately
 * and the actual JMAP submission proceeds asynchronously.
 */

import { defineStore } from 'pinia';
import { computed, reactive, ref, watch } from 'vue';

import { getRepositoryAsync } from '../composables/use-repository.js';
import { useAuthStore } from './auth-store';
import { useMailStore } from './mail-store.js';
import { COMPOSE_STATE, MUTATION_TYPE } from '../constants/states';
import type { ComposeState } from '../constants/states';
import type { IdentityRow, MessageRow } from '../types';
import { TABLE_FAMILIES } from '../db/protocol.js';
import {
  buildQuotedHtml,
  buildQuotedText,
  buildReplyAllRecipients,
  makeForwardSubject,
  makeReplySubject,
} from '../utils/compose-quote.js';

interface Draft {
  fromIdx: number;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  textBody: string;
  htmlBody: string;
}

interface ParsedAddress {
  name?: string;
  email: string;
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

export const useComposeStore = defineStore('compose', () => {
  const authStore = useAuthStore();
  const mailStore = useMailStore();

  const status = ref<ComposeState>(COMPOSE_STATE.IDLE);
  const error = ref<string | null>(null);
  const isOpen = ref(false);
  const identities = ref<any[]>([]);
  const draft = reactive<Draft>({ ...EMPTY_DRAFT });
  let repo: any = null;
  let unsubscribe: (() => void) | null = null;

  const fromIdentity = computed<any | null>(() =>
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
          await refreshIdentities();
        } else {
          identities.value = [];
        }
      },
      { immediate: true },
    );
  }

  function detach(): void {
    unsubscribe?.();
    unsubscribe = null;
  }

  function onTablesTouched(tables: string[]): void {
    if (!tables.includes(TABLE_FAMILIES.IDENTITIES)) return;
    if (authStore.accountId == null) return;
    refreshIdentities().catch((err) => {
      console.warn('[compose-store] refresh after broadcast failed', err);
    });
  }

  async function refreshIdentities(): Promise<void> {
    if (!repo || authStore.accountId == null) return;
    identities.value = await repo.listIdentities(authStore.accountId);
  }

  function open(prefill: Partial<Draft> = {}): void {
    Object.assign(draft, EMPTY_DRAFT, prefill);
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

    const drafts = mailStore.folders.find((f: any) => f.role === 'drafts');
    const sent = mailStore.folders.find((f: any) => f.role === 'sent');
    // 'outbox' is not a JMAP role per RFC 8621 §2 — this find() is
    // effectively a no-op against a real Stalwart server. Kept for
    // back-compat with any backend that surfaces a custom role.
    const outbox = mailStore.folders.find((f: any) => f.role === 'outbox');

    status.value = COMPOSE_STATE.SENDING;
    error.value = null;
    try {
      const mutation = await repo.insertPendingMutation({
        accountId: authStore.accountId,
        mutationType: MUTATION_TYPE.SEND,
        targetMessageId: null,
        requestJson: JSON.stringify({
          identityId: identity.remote_id,
          from: { name: identity.name, email: identity.email },
          to: toList,
          cc: parseAddressList(draft.cc),
          bcc: parseAddressList(draft.bcc),
          subject: draft.subject,
          textBody: draft.textBody,
          htmlBody: draft.htmlBody,
          draftsRemoteId: drafts?.remote_id ?? null,
          sentRemoteId: sent?.remote_id ?? null,
          outboxRemoteId: outbox?.remote_id ?? null,
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
    attach,
    detach,
    refreshIdentities,
    open,
    close,
    prepareReply,
    prepareReplyFromMessage,
    prepareReplyAll,
    prepareForward,
    send,
  };
});

function parseAddressList(input: string): ParsedAddress[] {
  if (!input) return [];
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^(.+?)\s*<(.+?)>$/);
      if (m) {
        return { name: m[1].trim().replace(/^"|"$/g, ''), email: m[2].trim() };
      }
      return { email: part };
    });
}
