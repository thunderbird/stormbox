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
import { FOLDER_ROLE, KEYWORD } from '../constants/states.js';

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
  // Multi-select set, distinct from `selectedMessageId` (which is the
  // "focused / previewed" row). Ports Overture's split between
  // SelectionController (set) and SingleSelectionController (current).
  // The Set instance is replaced (not mutated in place) by helpers so
  // Vue's reactivity picks up changes — same pattern useListSelection
  // uses.
  const selectedIds = ref(new Set());
  const messageBody = ref(null);
  const isLoading = ref(false);
  const error = ref(null);

  /**
   * Per-folder cache. Keys live as long as the store does (i.e. as
   * long as the user is logged in), so navigating Inbox -> Archives
   * -> Inbox restores the original Inbox state with no network IO and
   * no UI flicker.
   *
   * Each entry owns its own pageInflight: a single shared inflight
   * promise across folders is what caused mid-switch deadlocks where
   * folder B's ensureLoaded returned folder A's still-pending load
   * and never started B's own _loadPage. With per-folder inflight
   * the user can flip between folders as fast as they want and each
   * folder's loading state is independent.
   *
   * @typedef {object} FolderCache
   * @property {number} folderId
   * @property {number} total          authoritative once Email/query lands
   * @property {Array<object|undefined>} rows  positional, sparse OK
   * @property {Array<{start:number,end:number}>} paintedRanges
   * @property {'received'|'sent'} sortProp
   * @property {number} scrollTop
   * @property {Promise|null} pageInflight
   * @property {{start:number,end:number}|null} requestedRange
   *
   * @type {Map<number, FolderCache>}
   */
  const folderStates = new Map();
  let folderState = null;

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
          selectedIds.value = new Set();
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
    // computed; this fires once and won't override an explicit
    // user choice on later refreshes.
    watch(inbox, (newInbox) => {
      if (newInbox && currentFolderId.value == null) {
        selectFolder(newInbox.id);
      }
    });

    // Authoritative totals come from query_views.total, which the
    // sync layer keeps current via syncFolderWindow /
    // syncFolderWindowChanges. The MESSAGES broadcast that those
    // writes emit drives refreshLoadedPages, which calls
    // queryViewProgress and updates state.total / totalForFolder
    // there. We deliberately do NOT mirror folder.total_emails
    // onto state.total via a watch: a switch-away-and-back resets
    // the computed currentFolder which would fire the watch with
    // the stale Mailbox value, clobbering a JMAP-corrected total.
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
  function selectFolder(folderId) {
    // Switch synchronously so the FolderTree highlight and the
    // MessageList rebind in the same tick. Any awaited work below
    // could race against another selectFolder call from a rapid
    // click, leaving currentFolderId on one folder and folderState
    // on another — keeping this function sync avoids that class of
    // bug entirely.
    currentFolderId.value = folderId;
    selectedMessageId.value = null;
    selectedIds.value = new Set();
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
        pageInflight: null,
        requestedRange: null,
      };
      folderStates.set(folderId, state);
    } else {
      // Revisit: keep the cached state.total. Don't reset it from
      // folder.total_emails — that's an older Mailbox/get value
      // and can clobber a JMAP-authoritative count from the last
      // _loadPage. The currentFolder.total_emails watch picks up
      // any actual growth (new mail since we were last here), and
      // _loadPage's partial-cache fallthrough will reconcile a
      // shrink the next time we read.
    }
    folderState = state;
    totalForFolder.value = state.total;
    messages.value = state.rows;
    isLoading.value = state.paintedRanges.length === 0;

    // Prime page 0 once for first-time visits. Fire and forget:
    // the MessageList's virtualItems watch will re-pump
    // ensureLoaded for whatever range is visible, and selectFolder
    // returning synchronously means a rapid switch doesn't sit on
    // an old folder's pending load.
    if (state.paintedRanges.length === 0 && authStore.accountId != null && repo) {
      ensureLoaded(0, PAGE_SIZE);
    }
  }

  /**
   * Make sure rows in [start, end) are backed by metadata. Called
   * by the MessageList virtualizer on every visible-window change.
   * Reads SQLite first; only goes to the network when the matching
   * page isn't cached (or is only partially cached — see _loadPage).
   *
   * pageInflight lives on the folder state so loads in one folder
   * never block ensureLoaded for another folder. The re-pump in the
   * .finally re-evaluates against the *latest* visible range so a
   * fast scroll across several pages hydrates the right window.
   */
  async function ensureLoaded(start, end) {
    const state = folderState;
    if (!state || state.folderId !== currentFolderId.value) return;
    if (authStore.accountId == null || !repo) return;
    if (state.pageInflight) return state.pageInflight;

    const offset = Math.max(0, Number(start ?? 0));
    let requestedEnd = Math.max(offset + 1, Number(end ?? offset + 1));
    // Clip against the folder's known total so we don't keep firing
    // ensureLoaded for positions that don't exist. Without this,
    // virtualizer rowCount > state.total would loop the .finally
    // re-pump against an uncoverable range forever.
    if (state.total > 0) {
      requestedEnd = Math.min(requestedEnd, state.total);
    }
    if (requestedEnd <= offset) return;
    if (rangeCovered(state.paintedRanges, offset, requestedEnd)) return;
    const limit = Math.max(1, Math.min(PAGE_SIZE, requestedEnd - offset));

    let loadFailed = false;
    state.pageInflight = _loadPage(state, offset, limit)
      .then(() => {
        state.lastFailedRange = null;
      })
      .catch((err) => {
        loadFailed = true;
        error.value = err?.message ?? String(err);
        // Record the failed range so the .finally re-pump does not
        // spin on it forever. Without this guard a single broken
        // _loadPage call would re-fire ensureLoaded(0, 100) on every
        // microtask (because the .finally re-pump sees requestedRange
        // still set and paintedRanges still uncovered), flooding the
        // console with "[mail-store] ensureLoaded failed" lines.
        state.lastFailedRange = { start: offset, end: offset + limit };
        console.error('[mail-store] ensureLoaded failed', {
          folderId: state.folderId,
          offset,
          limit,
          total: state.total,
          message: err?.message ?? String(err),
          stack: err?.stack,
        });
      })
      .finally(() => {
        state.pageInflight = null;
        if (folderState === state) isLoading.value = false;
        if (folderState !== state || !state.requestedRange) return;
        const { start: s, end: e } = state.requestedRange;
        const nextOffset = Math.max(0, Number(s ?? 0));
        const nextEnd = Math.max(nextOffset + 1, Number(e ?? nextOffset + 1));
        if (rangeCovered(state.paintedRanges, nextOffset, nextEnd)) return;
        if (loadFailed
          && state.lastFailedRange
          && state.lastFailedRange.start === nextOffset
          && state.lastFailedRange.end === nextEnd) {
          // Same range just failed; let the user-driven path (scroll
          // or the refresh button) trigger another attempt instead
          // of looping in place.
          return;
        }
        ensureLoaded(s, e);
      });
    return state.pageInflight;
  }

  async function _loadPage(state, offset, limit) {
    // Try SQLite first. listMessagesForView is positional and only
    // returns rows whose query_view_items position falls inside
    // [offset, offset+limit). A "complete" cache hit for this
    // window has min(limit, total - offset) rows; anything less
    // means query_view_items is sparse here (interrupted indexer,
    // partial sync, never-visited page) and we still need to go
    // to the network even though the cache wasn't empty.
    const cached = await repo.listMessagesForView({
      accountId: authStore.accountId,
      folderId: state.folderId,
      sort: state.sortProp,
      offset,
      limit,
    });
    if (state !== folderState) return;
    const expectedFromTotal = state.total > 0
      ? Math.max(0, Math.min(limit, state.total - offset))
      : null;
    const cacheIsComplete = expectedFromTotal === null
      ? cached.length === limit
      : cached.length >= expectedFromTotal;
    if (cacheIsComplete) {
      if (cached.length > 0) _splice(state, offset, cached);
      const covered = expectedFromTotal === null
        ? cached.length
        : Math.max(cached.length, expectedFromTotal);
      addRange(state.paintedRanges, offset, offset + covered);
      return;
    }

    // Cache miss or partial: fetch from JMAP, then re-read the page
    // positionally. ensureFolderWindow writes both query_view_items
    // and messages, so the second read is the one that produces UI
    // rows.
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
    if (rows.length > 0) _splice(state, offset, rows);
    // Always mark the requested range as covered up to the
    // server's authoritative end. If the server reported fewer
    // rows than `limit` because we're near the tail of a small
    // folder, marking [offset, offset+expected) as covered keeps
    // ensureLoaded from spinning on positions that genuinely
    // don't exist.
    const newExpected = state.total > 0
      ? Math.max(0, Math.min(limit, state.total - offset))
      : rows.length;
    addRange(state.paintedRanges, offset, offset + Math.max(rows.length, newExpected));
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
   * from SQLite. Triggered by table-touched broadcasts after read/
   * flag changes and after query_view_items has been updated by a
   * queryChanges pass. Does not fetch new pages.
   *
   * The query_views.total is the authoritative count for the open
   * view (it tracks Email/query / Email/queryChanges totals). We
   * read it via queryViewProgress here so a remote delete that
   * shrank the view propagates into state.total / totalForFolder
   * even when folder.total_emails (the Mailbox total) hasn't caught
   * up yet. Trailing entries inside painted ranges are cleared and
   * state.rows is trimmed so the virtualizer's row count tracks the
   * actual content, not the pre-delete cache shape.
   */
  async function refreshLoadedPages() {
    const state = folderState;
    if (!repo || !state || state.folderId !== currentFolderId.value) return;

    try {
      const progress = await repo.queryViewProgress({
        accountId: authStore.accountId,
        folderId: state.folderId,
        sort: state.sortProp,
      });
      if (state !== folderState) return;
      if (Number.isFinite(progress?.total)) {
        const newTotal = Number(progress.total);
        if (newTotal !== state.total) {
          state.total = newTotal;
          totalForFolder.value = newTotal;
        }
      }
    } catch (err) {
      console.warn('[mail-store] queryViewProgress in refresh failed', err);
    }

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
      for (let i = rows.length; i < limit; i += 1) {
        state.rows[offset + i] = undefined;
      }
      if (rows.length > 0) _splice(state, offset, rows);
    }

    // Trim painted ranges that extend past the (possibly shrunken)
    // total so future ensureLoaded calls don't keep marking dead
    // positions as covered.
    if (state.total > 0) {
      for (let i = state.paintedRanges.length - 1; i >= 0; i -= 1) {
        const r = state.paintedRanges[i];
        if (r.start >= state.total) {
          state.paintedRanges.splice(i, 1);
        } else if (r.end > state.total) {
          r.end = state.total;
        }
      }
    }

    // Drop trailing undefined slots from state.rows so messages
    // length (and the virtualizer row count) reflects what's
    // actually paint-ready. Without this trim a shrunk view keeps
    // rendering placeholder rows at the old tail forever.
    let len = state.rows.length;
    while (len > 0 && state.rows[len - 1] === undefined) len -= 1;
    if (len !== state.rows.length) {
      state.rows.length = len;
    }
    messages.value = state.rows.slice();

    // Prune the multi-select set: a delete (local or peer) may have
    // dropped one of the selected ids out of the query view. Mirrors
    // Overture's SelectionController.contentWasUpdated.
    if (selectedIds.value.size > 0) {
      const live = new Set();
      for (const row of state.rows) {
        if (row?.id != null) live.add(row.id);
      }
      let removed = 0;
      const next = new Set(selectedIds.value);
      for (const id of next) {
        if (!live.has(id)) {
          next.delete(id);
          removed += 1;
        }
      }
      if (removed) selectedIds.value = next;
    }

    // If the view grew (new mail extended state.total beyond the
    // last painted position) load the new tail through the same
    // ensureLoaded path so the message at the head is visible
    // without waiting for the MessageList virtualizer to notice
    // the rowCount change and re-pump.
    if (state.total > 0 && state === folderState) {
      const lastPainted = state.paintedRanges.reduce(
        (acc, r) => Math.max(acc, r.end),
        0,
      );
      if (lastPainted < state.total) {
        await ensureLoaded(0, Math.min(state.total, PAGE_SIZE));
      }
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

  /**
   * Optimistically mark a message $seen locally and push the change
   * to the server in the background. The optimistic write to SQLite
   * makes the row un-bold in the message list immediately; the
   * outbox round trip (Email/set with keywords/$seen=true) is
   * fire-and-forget so the click doesn't sit on the network.
   *
   * If the push fails (transport error, server rejection), the
   * pending_mutations row is left in 'conflicted' status. Stalwart
   * fires an Email StateChange whenever keywords actually change on
   * the server — that path lives in JmapBackend._onStateChange ->
   * syncEmailChanges and writes is_seen from the authoritative
   * server keywords set, so a conflicted local optimistic patch will
   * naturally get reconciled the next time anything touches the
   * email server-side. Same mechanism handles peer-device read
   * actions: another client marks a message read, Stalwart pushes
   * Email state, syncEmailChanges fetches the updated keywords, and
   * the MESSAGES broadcast triggers refreshLoadedPages here.
   */
  async function markRead(messageId) {
    return _setSeen(messageId, true);
  }

  /**
   * Mirror of markRead. The bulk action uses _setSeen directly with
   * `seen=false` for each id; this wrapper exists so single-row
   * callers (toolbar in MessageView) match the markRead shape.
   */
  async function markUnread(messageId) {
    return _setSeen(messageId, false);
  }

  async function _setSeen(messageId, seen) {
    if (!repo || authStore.accountId == null) return;
    const local = messages.value.find((m) => m?.id === messageId);
    const currentSeen = Number(local?.is_seen ?? 0) === 1;
    if (currentSeen === seen) return;
    const keywordsJson = JSON.parse(local?.keywords_json ?? '{}');
    if (seen) {
      keywordsJson[KEYWORD.SEEN] = true;
    } else {
      delete keywordsJson[KEYWORD.SEEN];
    }
    await repo.replaceMessageKeywords(messageId, Object.keys(keywordsJson), JSON.stringify(keywordsJson));
    // Queue the server-side write. The worker-side OutboxRunner picks
    // this row up via the onMutationInserted hook fired by
    // PENDING_MUTATION_INSERT, so we do NOT have to call runMutation
    // / drainOutbox here. Fire-and-forget by design: the optimistic
    // patch above already un-bolded the row in the list and the
    // runner handles retry + backoff on the server side.
    await repo.insertPendingMutation({
      accountId: authStore.accountId,
      mutationType: 'setKeywords',
      targetMessageId: messageId,
      requestJson: JSON.stringify(
        seen ? { add: [KEYWORD.SEEN], remove: [] } : { add: [], remove: [KEYWORD.SEEN] },
      ),
      optimisticPatchJson: JSON.stringify({ is_seen: seen ? 1 : 0 }),
    });
  }

  /**
   * Bulk mark-seen. Fires the per-id mutations sequentially through
   * the same outbox path single-row markRead uses, so each row gets
   * its own pending_mutations entry and Stalwart sees a clean
   * setKeywords per Email — no special-case batched Email/set
   * required.
   *
   * Returns the number of rows whose state actually changed (so the
   * toolbar can show "marked N as read").
   */
  async function markManySeen(ids, seen) {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    let changed = 0;
    for (const id of ids) {
      const before = messages.value.find((m) => m?.id === id);
      const wasSeen = Number(before?.is_seen ?? 0) === 1;
      if (wasSeen === seen) continue;
      try {
        await _setSeen(id, seen);
        changed += 1;
      } catch (err) {
        console.warn('[mail-store] markManySeen item failed', { id, err: err?.message ?? err });
      }
    }
    return changed;
  }

  /**
   * Delete a message. The mutation runs end-to-end inside the sync
   * backend: the outbox issues Email/set and, on success, applies the
   * resulting state to local SQLite (folder_messages, query_view_items,
   * query_views.total) before returning. Once we await that round
   * trip, a MESSAGES broadcast has already fired and refreshLoadedPages
   * has reconciled the visible list against the new cache state.
   *
   * The store deliberately does NOT optimistically mutate state.rows,
   * paintedRanges, or totalForFolder. Doing so would race against the
   * broadcast-driven refresh and re-introduce the desync bug where the
   * UI splice gets overwritten by a stale SQLite read.
   */
  async function destroyMessage(messageId) {
    if (!repo || authStore.accountId == null) return;
    // Defensive: if the message no longer exists locally (e.g. a
    // previous delete attempt already wiped it but the UI still
    // shows it because the user clicked before the row re-rendered),
    // treat the delete as already-satisfied. Otherwise we would
    // INSERT a pending_mutations row with a dangling target_message_id
    // and trigger "FOREIGN KEY constraint failed".
    const exists = await repo.call('db.query', {
      sql: 'SELECT id FROM messages WHERE id = ? AND account_id = ? LIMIT 1',
      params: [messageId, authStore.accountId],
    });
    if (!exists?.length) {
      if (selectedMessageId.value === messageId) {
        selectedMessageId.value = null;
        messageBody.value = null;
      }
      return;
    }
    const mutation = await repo.insertPendingMutation(buildDeleteMutation(messageId));
    const result = typeof repo.runMutation === 'function'
      ? await repo.runMutation(authStore.accountId, mutation.id)
      : await repo.drainOutbox(authStore.accountId);
    if ((result?.failed ?? 0) > 0 || (result?.attempted ?? 0) === 0) {
      const detail = await loadMutationError(mutation.id);
      const message = describeMutationFailure(result, detail);
      const err = new Error(message);
      err.result = result;
      err.detail = detail;
      error.value = message;
      console.warn('[mail-store] destroyMessage failed', { messageId, result, detail });
      throw err;
    }
    if (selectedMessageId.value === messageId) {
      selectedMessageId.value = null;
      messageBody.value = null;
    }
    if (selectedIds.value.has(messageId)) {
      const next = new Set(selectedIds.value);
      next.delete(messageId);
      selectedIds.value = next;
    }
  }

  /**
   * Bulk delete. Same one-row-per-mutation policy as markManySeen,
   * for the same reason: each Email/set is small, the outbox is
   * already happy to drain a queue of them, and we get per-id
   * failure reporting for free. Returns { succeeded, failed }.
   */
  async function destroyMessages(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
      return { succeeded: 0, failed: 0 };
    }
    let succeeded = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await destroyMessage(id);
        succeeded += 1;
      } catch (err) {
        failed += 1;
        console.warn('[mail-store] destroyMessages item failed', { id, err: err?.message ?? err });
      }
    }
    return { succeeded, failed };
  }

  function clearSelection() {
    if (selectedIds.value.size === 0) return;
    selectedIds.value = new Set();
  }

  async function loadMutationError(mutationId) {
    if (!repo || mutationId == null) return null;
    try {
      const rows = await repo.call('db.query', {
        sql: `SELECT mutation_type, local_status, error_json
                FROM pending_mutations WHERE id = ?`,
        params: [mutationId],
      });
      return rows?.[0] ?? null;
    } catch {
      return null;
    }
  }

  function describeMutationFailure(result, detail) {
    if (detail?.error_json) {
      try {
        const parsed = JSON.parse(detail.error_json);
        const errType = parsed?.type ?? 'error';
        return `Could not delete message (${errType}).`;
      } catch {
        // fall through
      }
    }
    if ((result?.attempted ?? 0) === 0) {
      return 'Could not delete message (no sync backend available).';
    }
    return 'Could not delete message.';
  }

  function buildDeleteMutation(messageId) {
    const trash = folders.value.find((f) => f.role === FOLDER_ROLE.TRASH);
    const current = currentFolder.value;
    if (trash && current?.id != null && current.id !== trash.id) {
      return {
        accountId: authStore.accountId,
        mutationType: 'moveToFolders',
        targetMessageId: messageId,
        requestJson: JSON.stringify({
          addFolderIds: [trash.id],
          removeFolderIds: [current.id],
        }),
      };
    }

    return {
      accountId: authStore.accountId,
      mutationType: 'destroy',
      targetMessageId: messageId,
      requestJson: JSON.stringify({}),
    };
  }

  /**
   * Nuke the current folder's local view cache and rebuild from the
   * server. Bound to the toolbar refresh button.
   *
   * The point of this is to be the user's recovery path when local
   * SQLite state has drifted from the server: ghost messages, stale
   * positions, broken painted ranges, anything. We drop the entire
   * mailbox-window query_views row (FK cascade removes its
   * query_view_items and query_view_ranges), reset the in-memory
   * folder state, and re-run syncFolderWindow from position 0. The
   * spinner stays up the whole time so the user can see it working.
   *
   * Re-fetching every page that was previously painted (the previous
   * behaviour) was not enough: a JOIN-with-messages that returned
   * ghosts would just re-paint the same ghosts because nothing had
   * cleared query_view_items. The nuke is the only way to guarantee
   * the next paint matches the server.
   */
  async function refresh() {
    if (!repo || authStore.accountId == null || !folderState) return;
    const state = folderState;
    state.lastFailedRange = null;
    isLoading.value = true;
    try {
      await repo.ensureFolderTree(authStore.accountId);

      await repo.resetViewForFolder(authStore.accountId, state.folderId);
      state.rows = [];
      state.paintedRanges = [];
      state.total = 0;
      state.requestedRange = null;
      state.pageInflight = null;
      if (state === folderState) {
        totalForFolder.value = 0;
        messages.value = [];
      }

      const result = await repo.ensureFolderWindow(
        authStore.accountId,
        state.folderId,
        { offset: 0, limit: PAGE_SIZE },
      );
      if (state !== folderState) return;
      if (Number.isFinite(result?.total)) {
        state.total = Number(result.total);
        totalForFolder.value = state.total;
      }
      await ensureLoaded(0, PAGE_SIZE);
    } catch (err) {
      console.warn('[mail-store] refresh failed', err);
      error.value = err?.message ?? String(err);
    } finally {
      if (folderState === state) {
        isLoading.value = false;
      }
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
    selectedIds,
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
    markUnread,
    markManySeen,
    destroyMessage,
    destroyMessages,
    clearSelection,
    refresh,
  };
});
