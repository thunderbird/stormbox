/**
 * Mail data store. Reads folder + message metadata exclusively from the
 * Repository (SQLite via SharedWorker RPC). The sync layer pushes
 * "tables touched" broadcasts; this store re-runs the relevant queries
 * when its tables change.
 *
 * No JMAP or fetch calls here. Mutations are submitted as
 * pending_mutations rows + sync requests so the optimistic UI stays
 * decoupled from network latency.
 */

import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';

import { getRepositoryAsync } from '../composables/use-repository.js';
import { useAuthStore } from './auth-store.js';
import { TABLE_FAMILIES } from '../db/protocol.js';
import { KEYWORD } from '../constants/states.js';

export const useMailStore = defineStore('mail', () => {
  const authStore = useAuthStore();

  const folders = ref([]);
  const currentFolderId = ref(null);
  const messages = ref([]);
  const totalForFolder = ref(0);
  const pageSize = ref(100);
  const selectedMessageId = ref(null);
  const messageBody = ref(null);
  const isLoading = ref(false);
  const error = ref(null);

  let repo = null;
  let unsubscribe = null;

  const currentFolder = computed(
    () => folders.value.find((f) => f.id === currentFolderId.value) ?? null,
  );

  const inbox = computed(
    () => folders.value.find((f) => f.role === 'inbox') ?? null,
  );

  /**
   * Connect the store to the Repository and subscribe to broadcasts.
   * Idempotent.
   */
  async function attach() {
    if (repo) return;
    repo = await getRepositoryAsync();
    unsubscribe = repo.subscribe(onTablesTouched);
    watch(
      () => authStore.accountId,
      (newId) => {
        if (newId) {
          refreshFolders();
        } else {
          folders.value = [];
          messages.value = [];
          currentFolderId.value = null;
          selectedMessageId.value = null;
          messageBody.value = null;
        }
      },
      { immediate: true },
    );
  }

  function detach() {
    unsubscribe?.();
    unsubscribe = null;
    repo = null;
  }

  function onTablesTouched(tables) {
    if (tables.includes(TABLE_FAMILIES.FOLDERS)) {
      refreshFolders();
    }
    if (tables.includes(TABLE_FAMILIES.MESSAGES) && currentFolderId.value != null) {
      refreshMessages();
    }
  }

  async function refreshFolders() {
    if (!repo || authStore.accountId == null) {
      folders.value = [];
      return;
    }
    try {
      folders.value = await repo.listFolders(authStore.accountId);
    } catch (err) {
      error.value = err?.message ?? String(err);
      console.error('[mail-store] refreshFolders failed', err);
    }
  }

  async function selectFolder(folderId) {
    currentFolderId.value = folderId;
    selectedMessageId.value = null;
    messageBody.value = null;
    if (folderId == null) {
      messages.value = [];
      return;
    }
    isLoading.value = true;
    try {
      // Render whatever we have in cache immediately, then ask the sync
      // layer to refresh the visible window. The "tables touched"
      // broadcast will trigger another refresh once the sync lands.
      await refreshMessages();
      if (authStore.accountId != null) {
        await repo.ensureFolderWindow(authStore.accountId, folderId, {
          offset: 0,
          limit: pageSize.value,
        });
      }
    } catch (err) {
      error.value = err?.message ?? String(err);
    } finally {
      isLoading.value = false;
    }
  }

  async function refreshMessages() {
    if (!repo || currentFolderId.value == null) {
      return;
    }
    const sortProp = currentFolder.value?.role === 'sent'
      || currentFolder.value?.role === 'drafts'
      ? 'sent'
      : 'received';
    messages.value = await repo.listMessagesForFolder(currentFolderId.value, {
      sort: sortProp,
      limit: pageSize.value,
    });
  }

  async function selectMessage(messageId) {
    selectedMessageId.value = messageId;
    messageBody.value = null;
    if (messageId == null || authStore.accountId == null) return;
    try {
      await repo.ensureMessageBody(authStore.accountId, messageId);
      messageBody.value = await loadBody(messageId);
      if (!_isSeenInList(messageId)) {
        await markRead(messageId);
      }
    } catch (err) {
      error.value = err?.message ?? String(err);
    }
  }

  function _isSeenInList(messageId) {
    const m = messages.value.find((row) => row.id === messageId);
    return !!m && Number(m.is_seen) === 1;
  }

  async function loadBody(messageId) {
    const rows = await repo.call('db.query', {
      sql: `SELECT bv.kind, bv.value, bv.is_truncated
              FROM body_values bv
             WHERE bv.message_id = ?`,
      params: [messageId],
    });
    const text = rows.find((r) => r.kind === 'text')?.value ?? '';
    const html = rows.find((r) => r.kind === 'html')?.value ?? '';
    const attachments = await repo.call('db.query', {
      sql: `SELECT part_id, blob_id, name, media_type AS mime_type, size, disposition, cid
              FROM body_parts WHERE message_id = ? AND is_attachment = 1
             ORDER BY position`,
      params: [messageId],
    });
    return { text, html, attachments };
  }

  /**
   * Optimistically mark a message as read locally and queue a JMAP
   * mutation. The outbox runs against pending_mutations and the
   * Email/changes path will reconcile.
   */
  async function markRead(messageId) {
    if (!repo || authStore.accountId == null) return;
    const local = messages.value.find((m) => m.id === messageId);
    const keywordsJson = JSON.parse(local?.keywords_json ?? '{}');
    keywordsJson[KEYWORD.SEEN] = true;
    await repo.replaceMessageKeywords(messageId, Object.keys(keywordsJson), JSON.stringify(keywordsJson));
    await repo.insertPendingMutation({
      accountId: authStore.accountId,
      mutationType: 'setKeywords',
      targetMessageId: messageId,
      requestJson: JSON.stringify({ add: [KEYWORD.SEEN], remove: [] }),
      optimisticPatchJson: JSON.stringify({ is_seen: 1 }),
    });
  }

  async function destroyMessage(messageId) {
    if (!repo || authStore.accountId == null) return;
    await repo.insertPendingMutation({
      accountId: authStore.accountId,
      mutationType: 'destroy',
      targetMessageId: messageId,
      requestJson: JSON.stringify({}),
      optimisticPatchJson: JSON.stringify({ is_deleted: 1 }),
    });
    messages.value = messages.value.filter((m) => m.id !== messageId);
    if (selectedMessageId.value === messageId) {
      selectedMessageId.value = null;
      messageBody.value = null;
    }
  }

  async function refresh() {
    if (!repo || authStore.accountId == null) return;
    isLoading.value = true;
    try {
      await repo.ensureFolderTree(authStore.accountId);
      if (currentFolderId.value != null) {
        await repo.ensureFolderWindow(authStore.accountId, currentFolderId.value, {
          offset: 0,
          limit: pageSize.value,
        });
      }
    } finally {
      isLoading.value = false;
    }
  }

  return {
    folders,
    currentFolderId,
    currentFolder,
    inbox,
    messages,
    totalForFolder,
    selectedMessageId,
    messageBody,
    isLoading,
    error,
    pageSize,
    attach,
    detach,
    refreshFolders,
    refreshMessages,
    selectFolder,
    selectMessage,
    markRead,
    destroyMessage,
    refresh,
  };
});
