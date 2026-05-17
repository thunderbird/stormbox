/**
 * Mail data store. Reads folder + message metadata exclusively from the
 * Repository (SQLite via SharedWorker RPC). The sync layer pushes
 * "tables touched" broadcasts; this store re-runs the relevant queries
 * when its tables change.
 *
 * Loading philosophy:
 *   - SQLite is the source of truth for what the UI renders.
 *   - Folder navigation reads cached rows synchronously; the spinner
 *     only appears when we have nothing local for a folder yet.
 *   - The sync layer is asked to fetch a page only on a real cache
 *     miss; subsequent re-entries into a folder we've visited reuse
 *     the loaded pages without any network IO.
 *   - Positional reads come from query_view_items.position so a deep
 *     scroll into row 1500 returns the correct row even when the
 *     folder_messages cache is sparse.
 *
 * No JMAP or fetch calls here.
 */

import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';

import { getRepositoryAsync } from '../composables/use-repository.js';
import { useAuthStore } from './auth-store.js';
import { TABLE_FAMILIES } from '../db/protocol.js';
import { KEYWORD } from '../constants/states.js';

// Page size for both Email/query/get round trips and the SQLite
// positional reads. ~100 metadata records per Email/get is well below
// the ~50KB-per-record envelope and fits in one WS frame.
const PAGE_SIZE = 100;

export const useMailStore = defineStore('mail', () => {
  const authStore = useAuthStore();

  const folders = ref([]);
  const currentFolderId = ref(null);
  // Bound to the current folder's positional `rows` array. Indices
  // we haven't fetched are `undefined`, so the virtualiser renders
  // skeleton placeholders for them and the scrollbar reflects the
  // true total.
  const messages = ref([]);
  const totalForFolder = ref(0);
  const selectedMessageId = ref(null);
  const messageBody = ref(null);
  const isLoading = ref(false);
  const error = ref(null);

  /**
   * Per-folder cache. Keys live as long as the store does (i.e. as
   * long as the user is logged in), so navigating Inbox -> Archives
   * -> Inbox restores the original Inbox state with no network IO and
   * no UI flicker.
   *
   * @typedef {object} FolderCache
   * @property {number} folderId
   * @property {number} total          authoritative once Email/query lands
   * @property {Array<object|undefined>} rows  positional, sparse OK
   * @property {Set<number>} paintedOffsets   page-aligned offsets we've loaded
   * @property {'received'|'sent'} sortProp
   * @property {number} scrollTop
   *
   * @type {Map<number, FolderCache>}
   */
  const folderStates = new Map();
  let folderState = null;
  let pageInflight = null;

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
          refreshFolders();
        } else {
          folders.value = [];
          messages.value = [];
          currentFolderId.value = null;
          selectedMessageId.value = null;
          messageBody.value = null;
          folderStates.clear();
          folderState = null;
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
        refreshLoadedPages();
      }
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

  function _sortPropFor(folder) {
    return folder?.role === 'sent' || folder?.role === 'drafts' ? 'sent' : 'received';
  }

  /**
   * Switch the open folder. Synchronous-feeling: the cached rows for
   * this folder paint immediately, and only a never-visited folder
   * shows a spinner. The actual network round trip is fired in the
   * background and lands via the broadcast.
   *
   * Returns once the very first page has either resolved from cache
   * or completed its initial fetch, so callers that want to await
   * "navigation complete" can. Subsequent visits resolve immediately
   * because the cache is already populated.
   */
  async function selectFolder(folderId) {
    // Save outgoing folder's scroll position before we swap the bound
    // ref out from under MessageList.
    if (folderState && folderState.folderId !== folderId) {
      // (scroll position is written by MessageList via setScrollTop)
    }

    currentFolderId.value = folderId;
    selectedMessageId.value = null;
    messageBody.value = null;
    if (folderId == null) {
      folderState = null;
      messages.value = [];
      totalForFolder.value = 0;
      isLoading.value = false;
      return;
    }

    let state = folderStates.get(folderId);
    if (!state) {
      const folderRow = folders.value.find((f) => f.id === folderId);
      state = {
        folderId,
        total: Number(folderRow?.total_emails ?? 0) || 0,
        rows: [],
        paintedOffsets: new Set(),
        sortProp: _sortPropFor(folderRow),
        scrollTop: 0,
      };
      folderStates.set(folderId, state);
    } else {
      // Pick up any total drift since the last visit.
      const folderRow = folders.value.find((f) => f.id === folderId);
      const fresh = Number(folderRow?.total_emails ?? state.total) || state.total;
      state.total = fresh;
    }
    folderState = state;
    totalForFolder.value = state.total;
    messages.value = state.rows;
    isLoading.value = state.paintedOffsets.size === 0;

    // Prime page 0 once. Errors are surfaced via the spinner timing
    // out; we don't throw out of selectFolder so click handlers stay
    // simple.
    if (state.paintedOffsets.size === 0 && authStore.accountId != null && repo) {
      await ensureLoaded(0, PAGE_SIZE);
    }
  }

  /**
   * Make sure rows in [start, end) are backed by metadata. Called by
   * the MessageList virtualiser on every visible-window change. Reads
   * SQLite first; only goes to the network when the matching page
   * isn't cached.
   *
   * Re-pumping after each page completes against the *current*
   * visible range (not the captured one) is what lets a fast scroll
   * across several pages hydrate the right window.
   */
  async function ensureLoaded(start, end) {
    const state = folderState;
    if (!state || state.folderId !== currentFolderId.value) return;
    if (authStore.accountId == null || !repo) return;
    if (pageInflight) return pageInflight;

    const lastIdx = Math.max(start, end - 1);
    const offset = Math.floor(lastIdx / PAGE_SIZE) * PAGE_SIZE;
    if (state.paintedOffsets.has(offset)) return;

    pageInflight = _loadPage(state, offset)
      .catch((err) => {
        error.value = err?.message ?? String(err);
        console.error('[mail-store] ensureLoaded failed', { offset, err });
      })
      .finally(() => {
        pageInflight = null;
        // Drop the spinner once anything has painted.
        if (folderState === state) isLoading.value = false;
        // Re-evaluate against the latest virtualiser-requested range,
        // which the watch in MessageList keeps fresh on state via
        // setRequestedRange.
        if (folderState === state && state.requestedRange) {
          const { start: s, end: e } = state.requestedRange;
          const nextOffset = Math.floor(Math.max(s, e - 1) / PAGE_SIZE) * PAGE_SIZE;
          if (!state.paintedOffsets.has(nextOffset)) {
            // Don't await; let the chain unwind and fire on a fresh
            // microtask so re-entrancy stays simple.
            ensureLoaded(s, e);
          }
        }
      });
    return pageInflight;
  }

  async function _loadPage(state, offset) {
    // Try SQLite first. If a previous JMAP fetch already populated
    // query_view_items for this page (likely after refresh-the-current-
    // folder broadcasts) we can avoid the network entirely.
    const cached = await repo.listMessagesForView({
      accountId: authStore.accountId,
      folderId: state.folderId,
      sort: state.sortProp,
      offset,
      limit: PAGE_SIZE,
    });
    if (state !== folderState) return;
    if (cached.length > 0) {
      _splice(state, offset, cached);
      state.paintedOffsets.add(offset);
      return;
    }

    // Cache miss: fetch from JMAP, then re-read the page positionally.
    // ensureFolderWindow is what writes both query_view_items and
    // messages, so the second read is the one that produces UI rows.
    const result = await repo.ensureFolderWindow(authStore.accountId, state.folderId, {
      offset,
      limit: PAGE_SIZE,
    });
    if (state !== folderState) return;
    if (Number.isFinite(result?.total)) {
      state.total = Number(result.total);
      totalForFolder.value = state.total;
    }
    const rows = await repo.listMessagesForView({
      accountId: authStore.accountId,
      folderId: state.folderId,
      sort: state.sortProp,
      offset,
      limit: PAGE_SIZE,
    });
    if (state !== folderState) return;
    _splice(state, offset, rows);
    state.paintedOffsets.add(offset);
  }

  /**
   * Splice a page of rows into the folder's positional array starting
   * at `offset`. We mutate state.rows in place so the messages.value
   * binding (which points to the same array reference) stays live;
   * Vue's deep-watcher treats the assignment-trigger via the
   * messages.value = state.rows below as a fresh subscription source
   * but reads the same content.
   */
  function _splice(state, offset, rows) {
    if (state.rows.length < offset + rows.length) {
      state.rows.length = offset + rows.length;
    }
    for (let i = 0; i < rows.length; i += 1) {
      state.rows[offset + i] = rows[i];
    }
    if (state === folderState) {
      // Force a reactive update by handing Vue a fresh array reference
      // pointing at the same per-folder buffer.
      messages.value = state.rows.slice();
    }
  }

  /**
   * Re-read every page we've already painted for the current folder
   * from SQLite. Triggered by table-touched broadcasts after read/flag
   * changes. Does not fetch new pages.
   */
  async function refreshLoadedPages() {
    const state = folderState;
    if (!repo || !state || state.folderId !== currentFolderId.value) return;
    for (const offset of state.paintedOffsets) {
      const rows = await repo.listMessagesForView({
        accountId: authStore.accountId,
        folderId: state.folderId,
        sort: state.sortProp,
        offset,
        limit: PAGE_SIZE,
      });
      if (state !== folderState) return;
      if (rows.length > 0) _splice(state, offset, rows);
    }
  }

  // Persist the user's scroll position so navigating away and back
  // returns them to where they were. Called from MessageList on every
  // scroll event (rAF-throttled there).
  function setScrollTop(folderId, scrollTop) {
    const state = folderStates.get(folderId);
    if (state) state.scrollTop = scrollTop;
  }

  function getScrollTop(folderId) {
    return folderStates.get(folderId)?.scrollTop ?? 0;
  }

  // Tracked separately from ensureLoaded args so the inflight-page
  // .finally can re-pump against the *latest* visible range.
  function setRequestedRange(folderId, start, end) {
    const state = folderStates.get(folderId);
    if (state) state.requestedRange = { start, end };
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
    refreshMessageBody(messageId);

    if (!_isSeenInList(messageId)) {
      markRead(messageId).catch((err) => {
        console.warn('[mail-store] markRead failed', err);
      });
    }

    const token = ++bodyFetchToken;
    repo
      .ensureMessageBody(authStore.accountId, messageId)
      .then(() => {
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
    const m = messages.value.find((row) => row?.id === messageId);
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
      return null;
    }
    return { text, html, attachments };
  }

  async function markRead(messageId) {
    if (!repo || authStore.accountId == null) return;
    const local = messages.value.find((m) => m?.id === messageId);
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
    if (folderState) {
      const idx = folderState.rows.findIndex((m) => m?.id === messageId);
      if (idx >= 0) folderState.rows[idx] = undefined;
      messages.value = folderState.rows.slice();
    }
    if (selectedMessageId.value === messageId) {
      selectedMessageId.value = null;
      messageBody.value = null;
    }
  }

  /**
   * Force a refetch of the current folder's first page and its
   * already-painted pages. Bound to the toolbar refresh button.
   */
  async function refresh() {
    if (!repo || authStore.accountId == null || !folderState) return;
    const state = folderState;
    try {
      await repo.ensureFolderTree(authStore.accountId);
      // Re-fetch every page we've already painted so the user sees
      // any server-side changes without losing scroll position.
      const paintedSorted = [...state.paintedOffsets].sort((a, b) => a - b);
      for (const offset of paintedSorted) {
        if (state !== folderState) return;
        const result = await repo.ensureFolderWindow(authStore.accountId, state.folderId, {
          offset,
          limit: PAGE_SIZE,
        });
        if (Number.isFinite(result?.total)) {
          state.total = Number(result.total);
          totalForFolder.value = state.total;
        }
      }
      await refreshLoadedPages();
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
    attach,
    detach,
    refreshFolders,
    selectFolder,
    selectMessage,
    ensureLoaded,
    setScrollTop,
    getScrollTop,
    setRequestedRange,
    markRead,
    destroyMessage,
    refresh,
  };
});
