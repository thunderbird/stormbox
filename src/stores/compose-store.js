/**
 * Compose state. Holds the in-flight draft and the identity picker.
 * Send is implemented as a pending_mutations row plus a drainOutbox
 * call on the worker, so the UI can dismiss the composer immediately
 * and the actual JMAP submission proceeds asynchronously.
 */

import { defineStore } from 'pinia';
import { computed, reactive, ref, watch } from 'vue';

import { getRepositoryAsync } from '../composables/use-repository.js';
import { useAuthStore } from './auth-store.js';
import { useMailStore } from './mail-store.js';
import { COMPOSE_STATE } from '../constants/states.js';

const EMPTY_DRAFT = Object.freeze({
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

  const status = ref(COMPOSE_STATE.IDLE);
  const error = ref(null);
  const isOpen = ref(false);
  const identities = ref([]);
  const draft = reactive({ ...EMPTY_DRAFT });
  let repo = null;

  const fromIdentity = computed(() =>
    identities.value[draft.fromIdx] ?? identities.value[0] ?? null,
  );

  async function attach() {
    if (repo) return;
    repo = await getRepositoryAsync();
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

  async function refreshIdentities() {
    if (!repo || authStore.accountId == null) return;
    identities.value = await repo.listIdentities(authStore.accountId);
  }

  function open(prefill = {}) {
    Object.assign(draft, EMPTY_DRAFT, prefill);
    isOpen.value = true;
    status.value = COMPOSE_STATE.EDITING;
    error.value = null;
  }

  function close() {
    isOpen.value = false;
    status.value = COMPOSE_STATE.IDLE;
    Object.assign(draft, EMPTY_DRAFT);
    error.value = null;
  }

  function prepareReply({ to, subject, html, text }) {
    open({
      to: to ?? '',
      subject: subject ?? '',
      htmlBody: html ?? '',
      textBody: text ?? '',
    });
  }

  async function send() {
    if (!repo || authStore.accountId == null) {
      status.value = COMPOSE_STATE.FAILED;
      error.value = 'Not connected.';
      return false;
    }
    const identity = fromIdentity.value;
    if (!identity) {
      status.value = COMPOSE_STATE.FAILED;
      error.value = 'No identities are configured.';
      return false;
    }
    const toList = parseAddressList(draft.to);
    if (toList.length === 0) {
      status.value = COMPOSE_STATE.FAILED;
      error.value = 'Add at least one recipient.';
      return false;
    }

    const drafts = mailStore.folders.find((f) => f.role === 'drafts');
    const sent = mailStore.folders.find((f) => f.role === 'sent');
    const outbox = mailStore.folders.find((f) => f.role === 'outbox');

    status.value = COMPOSE_STATE.SENDING;
    error.value = null;
    try {
      const mutation = await repo.insertPendingMutation({
        accountId: authStore.accountId,
        mutationType: 'send',
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
        status.value = COMPOSE_STATE.FAILED;
        error.value = 'Send failed; the message stays in your outbox.';
        return false;
      }
      status.value = COMPOSE_STATE.SENT;
      close();
      return true;
    } catch (err) {
      status.value = COMPOSE_STATE.FAILED;
      error.value = err?.message ?? String(err);
      return false;
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
    refreshIdentities,
    open,
    close,
    prepareReply,
    send,
  };
});

function parseAddressList(input) {
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
