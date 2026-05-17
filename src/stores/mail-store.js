/**
 * Mail data store. Reads folder + message metadata exclusively from the
 * Repository (SQLite via SharedWorker RPC). The sync layer pushes
 * "tables touched" broadcasts; this store re-runs the relevant queries
 * when its tables change.
 *
 * Loading philosophy:
 *   - SQLite is the source of truth for what the UI renders.
 *   - Every read returns whatever is cached locally, immediately. No
 *     awaiting a server round-trip before we draw anything.
 *   - The sync layer is asked to refresh in the background; the
 *     "tables touched" broadcast triggers another read once the
 *     newer data lands.
 *
 * No JMAP or fetch calls here.
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
  let bodyFetchToken = 0;

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
          // Render whatever is already in OPFS immediately, then ask the
          // sync layer to catch up. The "tables touched" broadcast will
          // re-read once new rows land.
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

    // Auto-pick inbox when folders first arrive. Reactive on the
    // computed; this fires once and won't override an explicit user
    // choice on later refreshes.
    watch(inbox, (newInbox) => {
      if (newInbox && currentFolderId.value == null) {
        selectFolder(newInbox.id);
      }
    });
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
    if (tables.includes(TABLE_FAMILIES.MESSAGES)) {
      if (currentFolderId.value != null) {
        refreshMessages();
      }
      // If the currently-open message's body just arrived, refresh it.
      if (selectedMessageId.value != null) {
        refreshMessageBody(selectedMessageId.value);
      }
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

  /**
   * Switch the open folder. Reads cached messages immediately so the
   * list paints from disk; the network refresh runs in the background
   * and a fresh read is triggered by the broadcast when it lands.
   */
  function selectFolder(folderId) {
    currentFolderId.value = folderId;
    selectedMessageId.value = null;
    messageBody.value = null;
    if (folderId == null) {
      messages.value = [];
      return;
    }
    // Synchronous-feeling cache read; no await here. The async refresh
    // below will populate via the broadcast.
    refreshMessages();
    if (authStore.accountId != null && repo) {
      isLoading.value = true;
      repo
        .ensureFolderWindow(authStore.accountId, folderId, {
          offset: 0,
          limit: pageSize.value,
        })
        .catch((err) => {
          error.value = err?.message ?? String(err);
          console.error('[mail-store] ensureFolderWindow failed', err);
        })
        .finally(() => {
          isLoading.value = false;
        });
    }
  }

  async function refreshMessages() {
    if (!repo || currentFolderId.value == null) {
      return;
    }
    const folder = currentFolder.value;
    const sortProp = folder?.role === 'sent' || folder?.role === 'drafts'
      ? 'sent'
      : 'received';
    const list = await repo.listMessagesForFolder(currentFolderId.value, {
      sort: sortProp,
      limit: pageSize.value,
    });
    // Avoid stomping if the user has already moved on to another folder.
    if (folder?.id === currentFolderId.value) {
      messages.value = list;
    }
  }

  /**
   * Open a message. Renders the cached body immediately if we have one;
   * always asks the sync layer to refresh in the background.
   */
  function selectMessage(messageId) {
    selectedMessageId.value = messageId;
    if (messageId == null || authStore.accountId == null) {
      messageBody.value = null;
      return;
    }
    // 1. Paint from cache instantly.
    refreshMessageBody(messageId);

    // 2. Background optimistic mark-read so the sender weight in the
    //    list flips immediately.
    if (!_isSeenInList(messageId)) {
      markRead(messageId).catch((err) => {
        console.warn('[mail-store] markRead failed', err);
      });
    }

    // 3. Background body fetch from the server. Fire-and-forget; the
    //    broadcast that follows the SQLite write will trigger another
    //    refreshMessageBody so the UI updates without a second click.
    const token = ++bodyFetchToken;
    repo
      .ensureMessageBody(authStore.accountId, messageId)
      .then(() => {
        // If the user has already moved on, leave them alone.
        if (token === bodyFetchToken && selectedMessageId.value === messageId) {
          refreshMessageBody(messageId);
        }
      })
      .catch((err) => {
        console.warn('[mail-store] ensureMessageBody failed', err);
      });
  }

  async function refreshMessageBody(messageId) {
    if (!repo) return;
    const body = await loadBody(messageId);
    if (selectedMessageId.value === messageId) {
      messageBody.value = body;
    }
  }

  function _isSeenInList(messageId) {
    const m = messages.value.find((row) => row.id === messageId);
    return !!m && Number(m.is_seen) === 1;
  }

  async function loadBody(messageId) {
    const rows = await repo.call('db.query', {
      sql: 'SELECT bv.kind, bv.value, bv.is_truncated FROM body_values bv WHERE bv.message_id = ?',
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
    if (rows.length === 0 && attachments.length === 0) {
      // Don't blow away an existing body if the read raced before the
      // sync write landed; let the broadcast retry.
      return null;
    }
    return { text, html, attachments };
  }

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
    try {
      await repo.ensureFolderTree(authStore.accountId);
      if (currentFolderId.value != null) {
        await repo.ensureFolderWindow(authStore.accountId, currentFolderId.value, {
          offset: 0,
          limit: pageSize.value,
        });
      }
    } catch (err) {
      console.warn('[mail-store] refresh failed', err);
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
