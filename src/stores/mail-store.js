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
const BODY_PREFETCH_BATCH = 4;
const INITIAL_BODY_PREFETCH = 5;

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
  const folderProgress = ref(new Map());
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
   * @property {Array<{start:number,end:number}>} paintedRanges
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
  const bodyQueue = [];
  const bodyQueued = new Set();
  let bodyPrefetchRunning = false;

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
          folderProgress.value = new Map();
          folderStates.clear();
          folderState = null;
          bodyQueue.length = 0;
          bodyQueued.clear();
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
      refreshFolderProgress();
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
      await refreshFolderProgress();
    } catch (err) {
      error.value = err?.message ?? String(err);
      console.error('[mail-store] refreshFolders failed', err);
    }
  }

  async function refreshFolderProgress() {
    if (!repo || authStore.accountId == null || folders.value.length === 0) return;
    const next = new Map(folderProgress.value);
    await Promise.all(folders.value.map(async (folder) => {
      if (Number(folder.total_emails ?? 0) <= PAGE_SIZE) {
        next.set(folder.id, {
          total: Number(folder.total_emails ?? 0),
          covered: Number(folder.total_emails ?? 0),
          percent: 100,
        });
        return;
      }
      const progress = await repo.queryViewProgress({
        accountId: authStore.accountId,
        folderId: folder.id,
        sort: _sortPropFor(folder),
      });
      next.set(folder.id, progress);
    }));
    folderProgress.value = next;
    folders.value = folders.value.map((folder) => {
      const progress = next.get(folder.id);
      if (!progress) return folder;
      return {
        ...folder,
        index_total: progress.total,
        index_covered: progress.covered,
        index_percent: progress.percent,
      };
    });
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
        paintedRanges: [],
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
    isLoading.value = state.paintedRanges.length === 0;

    // Prime page 0 once. Errors are surfaced via the spinner timing
    // out; we don't throw out of selectFolder so click handlers stay
    // simple.
    if (state.paintedRanges.length === 0 && authStore.accountId != null && repo) {
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

    const offset = Math.max(0, Number(start ?? 0));
    const limit = Math.max(1, Math.min(PAGE_SIZE, Number(end ?? offset + 1) - offset));
    if (rangeCovered(state.paintedRanges, offset, offset + limit)) return;

    pageInflight = _loadPage(state, offset, limit)
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
          const nextOffset = Math.max(0, Number(s ?? 0));
          const nextEnd = Math.max(nextOffset + 1, Number(e ?? nextOffset + 1));
          if (!rangeCovered(state.paintedRanges, nextOffset, nextEnd)) {
            // Don't await; let the chain unwind and fire on a fresh
            // microtask so re-entrancy stays simple.
            ensureLoaded(s, e);
          }
        }
      });
    return pageInflight;
  }

  async function _loadPage(state, offset, limit) {
    // Try SQLite first. If a previous JMAP fetch already populated
    // query_view_items for this page (likely after refresh-the-current-
    // folder broadcasts) we can avoid the network entirely.
    const cached = await repo.listMessagesForView({
      accountId: authStore.accountId,
      folderId: state.folderId,
      sort: state.sortProp,
      offset,
      limit,
    });
    if (state !== folderState) return;
    if (cached.length > 0) {
      _splice(state, offset, cached);
      addRange(state.paintedRanges, offset, offset + cached.length);
      return;
    }

    // Cache miss: fetch from JMAP, then re-read the page positionally.
    // ensureFolderWindow is what writes both query_view_items and
    // messages, so the second read is the one that produces UI rows.
    const result = await repo.ensureFolderWindow(authStore.accountId, state.folderId, {
      offset,
      limit,
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
      limit,
    });
    if (state !== folderState) return;
    _splice(state, offset, rows);
    addRange(state.paintedRanges, offset, offset + rows.length);
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
    if (offset === 0 && state === folderState) {
      maybePrefetchInitialBodies(state);
    }
  }

  function rangeCovered(ranges, start, end) {
    if (end <= start) return true;
    for (const range of ranges) {
      if (start >= range.start && end <= range.end) return true;
    }
    return false;
  }

  function addRange(ranges, start, end) {
    if (end <= start) return;
    ranges.push({ start, end });
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 0; i < ranges.length - 1;) {
      const cur = ranges[i];
      const next = ranges[i + 1];
      if (next.start <= cur.end) {
        cur.end = Math.max(cur.end, next.end);
        ranges.splice(i + 1, 1);
      } else {
        i += 1;
      }
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
    for (const range of state.paintedRanges) {
      const offset = range.start;
      const limit = range.end - range.start;
      const rows = await repo.listMessagesForView({
        accountId: authStore.accountId,
        folderId: state.folderId,
        sort: state.sortProp,
        offset,
        limit,
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

  function maybePrefetchInitialBodies(state) {
    const folder = folders.value.find((f) => f.id === state.folderId);
    const isSmallFolder = Number(state.total ?? 0) <= PAGE_SIZE;
    const shouldPrefetch = folder?.role === 'inbox' || isSmallFolder;
    if (!shouldPrefetch || state.didInitialBodyPrefetch) return;
    state.didInitialBodyPrefetch = true;
    const ids = state.rows
      .slice(0, INITIAL_BODY_PREFETCH)
      .map((row) => row?.id)
      .filter(Boolean);
    enqueueBodyPrefetch(ids);
  }

  function nearbyMessageIds(messageId) {
    const idx = messages.value.findIndex((row) => row?.id === messageId);
    if (idx < 0) return [messageId];
    const order = [idx, idx + 1, idx + 2, idx - 1];
    return order
      .map((i) => messages.value[i]?.id)
      .filter(Boolean);
  }

  function enqueueBodyPrefetch(messageIds, { priority = false } = {}) {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return;
    const deduped = [];
    for (const id of messageIds) {
      if (id == null || bodyQueued.has(id)) continue;
      bodyQueued.add(id);
      deduped.push(id);
    }
    if (deduped.length === 0) return;
    if (priority) bodyQueue.unshift(...deduped);
    else bodyQueue.push(...deduped);
    drainBodyPrefetchQueue();
  }

  async function drainBodyPrefetchQueue() {
    if (bodyPrefetchRunning || !repo || authStore.accountId == null) return;
    bodyPrefetchRunning = true;
    try {
      while (bodyQueue.length > 0 && repo && authStore.accountId != null) {
        const batch = bodyQueue.splice(0, BODY_PREFETCH_BATCH);
        for (const id of batch) bodyQueued.delete(id);
        const selectedAtStart = selectedMessageId.value;
        await repo.ensureMessageBodies(authStore.accountId, batch);
        if (selectedAtStart != null && batch.includes(selectedAtStart)) {
          await refreshMessageBody(selectedAtStart);
        }
        // Yield so metadata reads and user-triggered RPCs can get into
        // the worker queue between body batches.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } catch (err) {
      console.warn('[mail-store] body prefetch failed', err);
    } finally {
      bodyPrefetchRunning = false;
      if (bodyQueue.length > 0) {
        setTimeout(() => drainBodyPrefetchQueue(), 0);
      }
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
    refreshMessageBody(messageId);

    if (!_isSeenInList(messageId)) {
      markRead(messageId).catch((err) => {
        console.warn('[mail-store] markRead failed', err);
      });
    }

    const token = ++bodyFetchToken;
    enqueueBodyPrefetch(nearbyMessageIds(messageId), { priority: true });
    drainBodyPrefetchQueue().finally(() => {
      if (token === bodyFetchToken && selectedMessageId.value === messageId) {
        refreshMessageBody(messageId);
      }
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
      const paintedSorted = [...state.paintedRanges].sort((a, b) => a.start - b.start);
      for (const range of paintedSorted) {
        if (state !== folderState) return;
        const result = await repo.ensureFolderWindow(authStore.accountId, state.folderId, {
          offset: range.start,
          limit: range.end - range.start,
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
