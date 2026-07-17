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

import { getRepositoryAsync } from '../composables/useRepository';
import { useAuthStore } from './auth-store';
import { useBodyPrefetch } from '../composables/useBodyPrefetch';
import { buildInlineImageDataUrl, isInlineImageType } from '../utils/message-html';
import { parseOneAddress } from '../utils/address-list';
import { folderCapabilities } from '../utils/folder-capabilities';
import { TABLE_FAMILIES } from '../db/protocol';
import { MUTATION_TYPE } from '../constants/states';
import type { JmapViewSort, MailboxRole, MutationType } from '../constants/states';
import type { AccountRow, FolderRow, MessageRow, QueryViewProgress } from '../types';
import type { Repository } from '../db/repository';
import type { CachedRow, FolderCache } from './mail-store-types';

interface MutationOutcome {
  attempted: number;
  succeeded: number;
  failed: number;
  error?: any;
  result?: {
    succeededIds?: Array<number | string>;
    errors?: Record<string, any>;
    created?: Record<string, { remoteId: string; folderId?: number | null }>;
  };
}

interface MoveResult { succeeded: number; failed: number; skipped: number }

interface PendingMutationInsert {
  accountId: number;
  mutationType: MutationType;
  targetMessageId: number | null;
  requestJson: string;
  optimisticPatchJson?: string | null;
}

interface RefreshSelectionSnapshot {
  id: number;
  remoteId: string | null;
  index: number;
}

/**
 * Reactive state for an in-flight bulk move/destroy. The UI binds to
 * this to render the BulkOperationOverlay, which blocks other input
 * for the duration of the operation. `total` is set once when the
 * batch starts; `completed` ticks up after each successful chunk.
 *
 * `kind` lets the overlay copy itself differently for delete vs
 * move; `label` is the destination/scope name (e.g. "Archive" or
 * "Trash") so the user knows where their messages are going.
 */
export interface BulkOperationState {
  active: boolean;
  kind: 'move' | 'copy' | 'destroy' | null;
  label: string;
  total: number;
  completed: number;
}

// Page size for both Email/query/get round trips and the SQLite
// positional reads. ~100 metadata records per Email/get is well below
// the ~50KB-per-record envelope and fits in one WS frame.
const PAGE_SIZE = 100;

/**
 * Maximum number of messages that the store sends to the outbox in a
 * single Email/set call. JMAP servers advertise their own
 * `maxObjectsInSet` cap (RFC 8620 §5). Local Stalwart advertises and
 * enforces 500; every successful Email/set chunk is mirrored by one
 * matching SQLite transaction, so this value controls both the server
 * write size and the local cache apply size.
 */
const BULK_OPERATION_BATCH_SIZE = 500;

export const useMailStore = defineStore('mail', () => {
  const authStore = useAuthStore();

  const folders = ref<FolderRow[]>([]);
  const currentFolderId = ref<number | null>(null);
  // Bound to the current folder's positional `rows` array. Indices
  // we haven't fetched are `undefined`, so the virtualiser renders
  // skeleton placeholders for them and the scrollbar reflects the
  // true total.
  const messages = ref<CachedRow[]>([]);
  const totalForFolder = ref(0);
  const folderProgress = ref<Map<number, QueryViewProgress>>(new Map());
  const selectedMessageId = ref<number | null>(null);
  // Keyboard "cursor": the active row, as a stable id. Single source of
  // truth for which row the keyboard is on, written by every navigation
  // path (Arrow/Shift+Arrow via useListSelection, F/B/N/P/Home/End via
  // useThunderbirdShortcuts -> selectMessage, click, and delete/archive
  // auto-advance). MessageList drives scroll-follow and
  // aria-activedescendant off this. It coincides with selectedMessageId
  // on plain nav/click but intentionally diverges during a Shift+Arrow
  // range extension, where the cursor advances without changing the
  // previewed message.
  const focusedMessageId = ref<number | null>(null);
  // Multi-select set, distinct from `selectedMessageId` (which is the
  // "focused / previewed" row). Ports Overture's split between
  // SelectionController (set) and SingleSelectionController (current).
  // The Set instance is replaced (not mutated in place) by helpers so
  // Vue's reactivity picks up changes — same pattern useListSelection
  // uses.
  const selectedIds = ref<Set<number>>(new Set());
  const isLoading = ref(false);
  const error = ref<string | null>(null);
  // Transient success confirmation (e.g. "Whitelisted sender"). Cleared
  // automatically after a few seconds; rendered by StoreErrorToast.
  const notice = ref<string | null>(null);
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  function setNotice(message: string) {
    notice.value = message;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      notice.value = null;
      noticeTimer = null;
    }, 5000);
  }

  // Bulk move/destroy progress. Mutates as the chunked drain advances
  // so the BulkOperationOverlay can render a live progress bar. Reset
  // back to inactive when the operation finishes (success or failure)
  // so the overlay disappears.
  const bulkOperation = ref<BulkOperationState>({
    active: false,
    kind: null,
    label: '',
    total: 0,
    completed: 0,
  });

  // Body prefetch + display-fetch queue. Owns its own ids/token
  // state and the messageBody ref; the store reaches into it
  // through nextDisplayToken() / loadBodyForDisplay() during
  // selectMessage and broadcasts.
  const bodyPrefetch = useBodyPrefetch({
    getRepo: () => repo,
    getAccountId: () => authStore.accountId ?? null,
    isSelected: (messageId) => selectedMessageId.value === messageId,
  });
  const messageBody = bodyPrefetch.messageBody;

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
   * See {@link FolderCache} for shape details.
   */
  const folderStates: Map<number, FolderCache> = new Map();
  let folderState: FolderCache | null = null;

  let repo: Repository | null = null;
  let unsubscribe: (() => void) | null = null;

  // Single-flight + re-run flag for refreshLoadedPages so a burst of
  // MESSAGES broadcasts coalesces into one cache re-read at the end
  // of the storm, not N partial reads that the user sees as the row
  // count ticking down one at a time. See refreshLoadedPages().
  let refreshLoadedPagesInflight: Promise<void> | null = null;
  let refreshLoadedPagesDirty = false;
  // Mirror of the same coalescing for refreshFolderProgress. The
  // metadata indexer fires a MESSAGES broadcast every chunk (every
  // ~250ms while indexing a large folder). Without coalescing, every
  // broadcast triggers a new refreshFolderProgress that reassigns
  // folders.value to a fresh array of fresh objects, forcing the
  // FolderTree to re-render the entire DOM on each cycle. That
  // re-render storm made it impossible for the user (and Playwright)
  // to interact with the folder list during indexing: clicks would
  // hit elements that were about to be replaced.
  let refreshFolderProgressInflight: Promise<void> | null = null;
  let refreshFolderProgressDirty = false;
  const staleFolderIds = new Set<number>();
  let manualRefreshFolderId: number | null = null;

  const currentFolder = computed(
    () => folders.value.find((f) => f.id === currentFolderId.value) ?? null,
  );

  // Accounts visible in this session: the signed-in (primary) account
  // plus any shared accounts (RFC 9670) the server advertised. Loaded
  // alongside folders so the sidebar can group shared folders by owner.
  const accounts = ref<AccountRow[]>([]);

  const sharedAccounts = computed(
    () => accounts.value.filter((a) => a.id !== authStore.accountId),
  );

  // Folders belonging to the signed-in account. Role-based lookups and
  // the main sidebar tree must not match folders from shared accounts.
  const primaryFolders = computed(
    () => folders.value.filter((f) => f.account_id === authStore.accountId),
  );

  /**
   * Primary-account folders the sidebar should render. Role (system)
   * folders always show — hiding your own Inbox would strand you — but
   * unsubscribing a user folder hides it, matching Thunderbird's and
   * Roundcube's folder-pane behaviour. NULL is_subscribed (server never
   * reported the property) is treated as subscribed so folders never
   * vanish just because the flag is unknown.
   */
  const sidebarPrimaryFolders = computed(
    () => primaryFolders.value.filter(
      (f) => f.role != null || Number(f.is_subscribed ?? 1) !== 0,
    ),
  );

  /**
   * Shared folders grouped per owning account for the sidebar. Only
   * subscribed folders are listed (RFC 8621 §2: clients may display
   * just the subscribed subset of shared mailboxes and offer a
   * separate UI to manage the full set — that UI is the folder
   * subscriptions dialog, which reads `folders` unfiltered).
   */
  const sharedFolderGroups = computed(() => sharedAccounts.value
    .map((account) => ({
      account,
      folders: folders.value.filter(
        (f) => f.account_id === account.id && Number(f.is_subscribed) === 1,
      ),
    }))
    .filter((group) => group.folders.length > 0));

  const inbox = computed(
    () => primaryFolders.value.find((f) => f.role === 'inbox') ?? null,
  );

  /**
   * Account that owns a folder, for repository calls that scope query
   * views by account. Folders from shared accounts carry that
   * account's local id; fall back to the signed-in account.
   */
  function accountIdForFolder(folderId: number | null | undefined): number | null {
    const folder = folders.value.find((f) => Number(f.id) === Number(folderId));
    return folder?.account_id ?? authStore.accountId ?? null;
  }

  /**
   * Drop every piece of session-scoped state. Safe to call without a
   * detach: just zeroes the refs and the per-folder cache. Used by
   * the accountId watch on logout and exposed as $reset for callers
   * that want an explicit knob.
   */
  function $reset() {
    folders.value = [];
    accounts.value = [];
    messages.value = [];
    currentFolderId.value = null;
    totalForFolder.value = 0;
    selectedMessageId.value = null;
    focusedMessageId.value = null;
    selectedIds.value = new Set();
    folderProgress.value = new Map();
    folderStates.clear();
    folderState = null;
    isLoading.value = false;
    error.value = null;
    notice.value = null;
    if (noticeTimer) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    resetBulkOperation();
    bodyPrefetch.clear();
    refreshLoadedPagesInflight = null;
    refreshLoadedPagesDirty = false;
    refreshFolderProgressInflight = null;
    refreshFolderProgressDirty = false;
    staleFolderIds.clear();
    folderDeleteMailboxHasEmailIds.clear();
    manualRefreshFolderId = null;
  }

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
          $reset();
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
    $reset();
  }

  function onTablesTouched(tables: string[]) {
    if (tables.includes(TABLE_FAMILIES.FOLDERS)) {
      refreshFolders();
    }
    if (tables.includes(TABLE_FAMILIES.MESSAGES)) {
      const manualRefreshOwnsCurrentFolder = manualRefreshFolderId != null
        && Number(currentFolderId.value) === manualRefreshFolderId;
      if (currentFolderId.value != null && !manualRefreshOwnsCurrentFolder) {
        refreshLoadedPages();
      }
      refreshFolderProgress();
      if (selectedMessageId.value != null && !manualRefreshOwnsCurrentFolder) {
        // Re-issue a display load using a fresh token so a stale
        // in-flight Email/get for the same id cannot land after
        // this broadcast did and clobber the new body.
        void bodyPrefetch.loadBodyForDisplay(selectedMessageId.value, bodyPrefetch.nextDisplayToken());
      }
    }
  }

  // Optimistic isSubscribed values for folders whose mutation is still
  // in flight. refreshFolders re-applies these on top of DB reads so a
  // FOLDERS broadcast from an earlier mutation in the same batch can't
  // momentarily resurrect the old value of a later one (which made
  // cascaded unsubscribes flash every child through the sidebar).
  const optimisticSubscriptions = new Map<number, 0 | 1>();

  async function refreshFolders() {
    if (!repo || authStore.accountId == null) {
      folders.value = [];
      accounts.value = [];
      return;
    }
    try {
      // Load the primary account's folders plus any shared accounts'
      // folders. Accounts are ordered primary-first by the handler, so
      // the concatenated folder list keeps the user's own folders at
      // the top.
      const allAccounts: AccountRow[] = await repo.listAccounts();
      const primary = allAccounts.find((a) => a.id === authStore.accountId) ?? null;
      const visibleAccounts = primary
        ? allAccounts.filter((a) => a.id === primary.id || a.server_origin === primary.server_origin)
        : allAccounts;
      const folderLists = await Promise.all(
        visibleAccounts.map((a) => repo!.listFolders(a.id)),
      );
      accounts.value = visibleAccounts;
      const rows = folderLists.flat();
      // Keep in-flight optimistic subscription flips on top of the DB
      // read: a broadcast from one batch member must not resurrect the
      // stale value of another still waiting on the server.
      if (optimisticSubscriptions.size > 0) {
        for (const row of rows) {
          const pending = optimisticSubscriptions.get(row.id);
          if (pending != null) row.is_subscribed = pending;
        }
      }
      folders.value = rows;
      await refreshFolderProgress();
    } catch (err) {
      error.value = err?.message ?? String(err);
      console.error('[mail-store] refreshFolders failed', err);
    }
  }

  /**
   * Public coalescing wrapper around _refreshFolderProgress. The
   * metadata indexer fires MESSAGES every ~250ms while filling a
   * large folder; running the full progress sweep on every broadcast
   * keeps FolderTree's DOM in a permanent re-render state and breaks
   * folder clicks during heavy indexing.
   *
   * Single-flight + dirty-flag means a burst of N broadcasts produces
   * at most two sweeps: the one that was inflight when the burst
   * started, plus a single trailing re-run that covers everything
   * that happened during the inflight sweep.
   */
  function refreshFolderProgress() {
    if (refreshFolderProgressInflight) {
      refreshFolderProgressDirty = true;
      return refreshFolderProgressInflight;
    }
    refreshFolderProgressInflight = (async () => {
      try {
        do {
          refreshFolderProgressDirty = false;
          await _refreshFolderProgress();
        } while (refreshFolderProgressDirty);
      } finally {
        refreshFolderProgressInflight = null;
      }
    })();
    return refreshFolderProgressInflight;
  }

  /**
   * Read queryViewProgress for every folder, then propagate index
   * coverage onto the folder objects so FolderTree can render the
   * indexing percent badge. Skips folders.value reassignment when
   * nothing actually changed so a no-op progress sweep doesn't
   * trigger a redundant FolderTree re-render — important for
   * Playwright stability during indexer storms.
   */
  async function _refreshFolderProgress() {
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
        accountId: folder.account_id ?? authStore.accountId,
        folderId: folder.id,
        sort: _sortPropFor(folder),
      });
      next.set(folder.id, progress);
    }));
    folderProgress.value = next;
    let changed = false;
    const remapped = folders.value.map((folder) => {
      const progress = next.get(folder.id);
      if (!progress) return folder;
      const total = progress.total ?? folder.index_total ?? null;
      const covered = progress.covered ?? folder.index_covered ?? null;
      const percent = progress.percent ?? folder.index_percent ?? null;
      if (
        folder.index_total === total
        && folder.index_covered === covered
        && folder.index_percent === percent
      ) {
        return folder;
      }
      changed = true;
      return {
        ...folder,
        index_total: total,
        index_covered: covered,
        index_percent: percent,
      };
    });
    // Only reassign folders.value when at least one folder's index
    // numbers actually changed. Reassigning unconditionally rebuilds
    // every FolderNode in the tree on every broadcast, which is the
    // DOM-churn pattern Playwright cannot lock onto.
    if (changed) folders.value = remapped;
  }

  function _sortPropFor(folder: { role?: MailboxRole | null } | null | undefined): JmapViewSort {
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
  function selectFolder(folderId: number | null) {
    // Switch synchronously so the FolderTree highlight and the
    // MessageList rebind in the same tick. Any awaited work below
    // could race against another selectFolder call from a rapid
    // click, leaving currentFolderId on one folder and folderState
    // on another — keeping this function sync avoids that class of
    // bug entirely.
    currentFolderId.value = folderId;
    selectedMessageId.value = null;
    focusedMessageId.value = null;
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
    if (staleFolderIds.has(Number(folderId))) {
      invalidateFolderStateForFreshWindow(folderId);
    }
    folderState = state;
    totalForFolder.value = state.total;
    messages.value = state.rows;
    isLoading.value = state.paintedRanges.length === 0;
    void reconcileSelectedFolderViewState(state);

    // Prime page 0 once for first-time visits. Fire and forget:
    // the MessageList's virtualItems watch will re-pump
    // ensureLoaded for whatever range is visible, and selectFolder
    // returning synchronously means a rapid switch doesn't sit on
    // an old folder's pending load.
    if (state.paintedRanges.length === 0 && authStore.accountId != null && repo) {
      ensureLoaded(0, PAGE_SIZE);
    }
    void checkAndRepairFolderViewDrift(state);
  }

  /**
   * One-shot folder-view consistency check, fired when a folder opens.
   *
   * The constitution makes `query_views` + `query_view_items` the
   * canonical UI source for the open folder; `folder_messages` is a
   * separate membership projection used by mutation/apply paths. If
   * the two disagree (e.g. peer-side syncEmailChanges added 1400 rows
   * to folder_messages but the local query view still says 14 total),
   * neither projection can be displayed honestly alongside the other.
   *
   * Rather than render a hybrid count, we treat the local query view
   * as stale, invalidate it, and let the existing
   * resetViewForFolder + ensureFolderWindow path rebuild it from the
   * server. After the rebuild the server-confirmed query-view total
   * is canonical for both All and Unread, even if it disagrees with
   * folder_messages — folder_messages is then the stale projection
   * and will catch up via subsequent syncs.
   *
   * Guarded by `driftRebuildAttempted` so a persistent disagreement
   * (server actually says 14, membership still has 1400 stale rows
   * from an earlier full index) cannot loop the canonical view
   * through endless resets.
   */
  async function checkAndRepairFolderViewDrift(state: FolderCache) {
    if (!repo || authStore.accountId == null) return;
    if (state.folderId !== currentFolderId.value || folderState !== state) return;
    if (state.needsFreshWindow) return;
    if (state.driftCheckInflight) return state.driftCheckInflight;
    if (state.driftRebuildAttempted) return;

    state.driftCheckInflight = (async () => {
      try {
        const consistency = await repo.checkFolderViewConsistency({
          accountId: accountIdForFolder(state.folderId),
          folderId: state.folderId,
          sort: state.sortProp,
        });
        if (state !== folderState || state.folderId !== currentFolderId.value) return;
        const queryViewTotal = Number(consistency?.queryViewTotal ?? 0);
        const queryViewExists = !!consistency?.queryViewExists;
        const membershipTotal = Number(consistency?.membershipTotal ?? 0);
        const membershipUnread = Number(consistency?.membershipUnread ?? 0);

        // No query view yet (first open of a folder we haven't synced)
        // is not drift — _loadPage will fetch it.
        if (!queryViewExists) return;

        // Drift signal: local membership knows about strictly more
        // rows than the canonical query view does. Either the query
        // view total is stale (server actually has those rows but our
        // queryChanges hasn't caught up) or membership is stale (peer
        // delete that left orphan folder_messages rows). Either way
        // the right answer is to rebuild the canonical view from
        // server and let one source win.
        const driftDetected = membershipTotal > queryViewTotal
          || membershipUnread > queryViewTotal;
        if (!driftDetected) return;

        state.driftRebuildAttempted = true;
        console.warn('[mail-store] folder view drift detected, rebuilding from server', {
          folderId: state.folderId,
          queryViewTotal,
          membershipTotal,
          membershipUnread,
        });
        try {
          await repo.resetViewForFolder(accountIdForFolder(state.folderId), state.folderId);
        } catch (err) {
          console.warn('[mail-store] resetViewForFolder during drift repair failed', err);
        }
        if (state !== folderState || state.folderId !== currentFolderId.value) return;
        invalidateFolderStateForFreshWindow(state.folderId);
        await ensureLoaded(0, PAGE_SIZE);
      } catch (err) {
        console.warn('[mail-store] checkFolderViewConsistency failed', err);
      } finally {
        state.driftCheckInflight = null;
      }
    })();
    return state.driftCheckInflight;
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
  async function ensureLoaded(start: number, end: number) {
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
    if (state.total > 0 && !state.needsFreshWindow) {
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

  async function _loadPage(state: FolderCache, offset: number, limit: number) {
    // Try SQLite first. listMessagesForView is positional and only
    // returns rows whose query_view_items position falls inside
    // [offset, offset+limit). A stale destination view deliberately
    // skips this cache hit: its query_view_items may still contain a
    // complete old page, but the server-side query state is known to
    // have changed.
    if (!state.needsFreshWindow) {
      const cached = await repo.listMessagesForView({
        accountId: accountIdForFolder(state.folderId),
        folderId: state.folderId,
        sort: state.sortProp,
        offset,
        limit,
      });
      if (state !== folderState) return;
      const expectedFromTotal = state.total > 0
        ? Math.max(0, Math.min(limit, state.total - offset))
        : null;
      const materializedRows = cached.filter(Boolean);
      const cacheIsComplete = expectedFromTotal === null
        ? materializedRows.length === limit
        : materializedRows.length >= expectedFromTotal;
      if (cacheIsComplete) {
        if (cached.length > 0) _splice(state, offset, cached);
        const covered = expectedFromTotal === null
          ? cached.length
          : Math.max(cached.length, expectedFromTotal);
        addRange(state.paintedRanges, offset, offset + covered);
        return;
      }
    }

    // Cache miss or partial: fetch from JMAP, then re-read the page
    // positionally. ensureFolderWindow writes both query_view_items
    // and messages, so the second read is the one that produces UI
    // rows.
    const result = await repo.ensureFolderWindow(accountIdForFolder(state.folderId), state.folderId, {
      offset,
      limit,
    });
    if (state !== folderState) return;
    state.needsFreshWindow = false;
    staleFolderIds.delete(state.folderId);
    if (Number.isFinite(result?.total)) {
      state.total = Number(result.total);
      totalForFolder.value = state.total;
    }
    const rows = await repo.listMessagesForView({
      accountId: accountIdForFolder(state.folderId),
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
  function _splice(state: FolderCache, offset: number, rows: MessageRow[]) {
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

  function rangeCovered(ranges: Array<{ start: number; end: number }>, start: number, end: number): boolean {
    if (end <= start) return true;
    for (const range of ranges) {
      if (start >= range.start && end <= range.end) return true;
    }
    return false;
  }

  function addRange(ranges: Array<{ start: number; end: number }>, start: number, end: number) {
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
   * Public coalescing wrapper around _refreshLoadedPages. A burst of
   * MESSAGES broadcasts (e.g. the per-id apply* helpers called inside
   * the outbox for a bulk delete) all need to result in the cache
   * being re-read, but the USER does not want to see N partial
   * intermediate states. We single-flight the underlying refresh and
   * re-run it once at the end if more broadcasts arrived while we
   * were busy. Net effect: one re-read after the storm settles, so
   * the message list shrinks in one step instead of one row per
   * broadcast.
   *
   * Returns a promise that resolves once the cache state visible to
   * the UI has caught up to every broadcast received up to the call.
   */
  function refreshLoadedPages() {
    if (refreshLoadedPagesInflight) {
      refreshLoadedPagesDirty = true;
      return refreshLoadedPagesInflight;
    }
    refreshLoadedPagesInflight = (async () => {
      try {
        do {
          refreshLoadedPagesDirty = false;
          await _refreshLoadedPages();
        } while (refreshLoadedPagesDirty);
      } finally {
        refreshLoadedPagesInflight = null;
      }
    })();
    return refreshLoadedPagesInflight;
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
   *
   * Always call through refreshLoadedPages (above) so concurrent
   * broadcast bursts coalesce into one re-read pass.
   */
  async function _refreshLoadedPages() {
    const state = folderState;
    if (!repo || !state || state.folderId !== currentFolderId.value) return;
    const beforeRows = state.rows.slice();

    try {
      const progress = await repo.queryViewProgress({
        accountId: accountIdForFolder(state.folderId),
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
      if (progress?.stale) {
        invalidateFolderStateForFreshWindow(state.folderId);
        await ensureLoaded(0, PAGE_SIZE);
        return;
      }
    } catch (err) {
      console.warn('[mail-store] queryViewProgress in refresh failed', err);
    }

    for (const range of state.paintedRanges) {
      const offset = range.start;
      const limit = range.end - range.start;
      const rows = await repo.listMessagesForView({
        accountId: accountIdForFolder(state.folderId),
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

    const removedIds = removedMessageIds(beforeRows, state.rows);
    const nextPreviewId = nextPreviewIdAfterRemoval(removedIds, beforeRows);

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

    applyPreviewAfterRemoval(nextPreviewId);

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
  function setScrollTop(folderId: number, scrollTop: number) {
    const state = folderStates.get(folderId);
    if (state) state.scrollTop = scrollTop;
  }

  function getScrollTop(folderId: number): number {
    return folderStates.get(folderId)?.scrollTop ?? 0;
  }

  // Tracked separately from ensureLoaded args so the inflight-page
  // .finally can re-pump against the *latest* visible range.
  function setRequestedRange(folderId: number | null, start: number, end: number) {
    const state = folderStates.get(folderId);
    if (state) state.requestedRange = { start, end };
  }

  /**
   * Pull every cached row in the open folder's canonical query view
   * into `messages.value` so a dense local filter (Unread, quick
   * filter) can see the whole folder instead of just the positional
   * window the virtualizer has populated.
   *
   * This is a SQLite read against `query_view_items` + `messages` for
   * the open folder. It never fetches from JMAP. If the canonical
   * view is sparse — rows beyond what the indexer has covered are not
   * in `query_view_items` yet — the buffer expands to whatever IS
   * cached and leaves trailing positions undefined for the
   * placeholder skeletons; this is the same shape default scrolling
   * already produces.
   *
   * Single-flight per folder so two filter toggles in quick
   * succession coalesce into one read. The MessagePort RPC for a
   * 50K-row folder runs in roughly 1-2 seconds on this VFS; users
   * see the cost only when they actively engage a dense filter, and
   * never on plain scrolling.
   */
  function expandFolderViewIntoMemory() {
    const state = folderState;
    if (!repo || authStore.accountId == null) return Promise.resolve();
    if (!state || state.folderId !== currentFolderId.value) return Promise.resolve();
    if (state.expandInflight) return state.expandInflight;
    const total = Math.max(0, Number(state.total) || 0);
    if (total === 0) return Promise.resolve();
    // Nothing to expand: the buffer already covers every position the
    // canonical view knows about.
    if (rangeCovered(state.paintedRanges, 0, total)) return Promise.resolve();

    state.expandInflight = (async () => {
      try {
        const rows = await repo.listMessagesForView({
          accountId: accountIdForFolder(state.folderId),
          folderId: state.folderId,
          sort: state.sortProp,
          offset: 0,
          limit: total,
        });
        if (state !== folderState || state.folderId !== currentFolderId.value) return;
        if (!Array.isArray(rows) || rows.length === 0) return;
        _splice(state, 0, rows);
        // Mark the canonical span as painted. If the cache is sparse,
        // mark only what we actually got; the indexer or a later
        // scroll will fill the rest through ensureLoaded.
        addRange(state.paintedRanges, 0, rows.length);
      } catch (err) {
        console.warn('[mail-store] expandFolderViewIntoMemory failed', err);
      } finally {
        state.expandInflight = null;
      }
    })();
    return state.expandInflight;
  }

  /**
   * Select every row in the open folder's canonical query view.
   *
   * Reads from `query_view_items` (via listMessagesForView) so the
   * selection set matches what All Mail can actually render. When the
   * Unread filter is on, we still source from the same canonical
   * view: a row that is not in the query view is not in the folder
   * from the user's perspective, even if it lingers in
   * `folder_messages`. Treating Unread as a strict subset of All is
   * required by R-2.8 and avoids the split-source bug where Unread
   * could appear to outnumber All.
   */
  async function selectAllLoadedMessages({ unreadOnly = false }: { unreadOnly?: boolean } = {}): Promise<number> {
    const state = folderState;
    let rows: CachedRow[] = messages.value;

    if (repo && authStore.accountId != null && state && state.folderId === currentFolderId.value) {
      const limit = Math.max(
        Number(state.total) || 0,
        state.rows.length,
        messages.value.length,
      );
      if (limit > 0) {
        const cachedRows = await repo.listMessagesForView({
          accountId: accountIdForFolder(state.folderId),
          folderId: state.folderId,
          sort: state.sortProp,
          offset: 0,
          limit,
        });
        if (state !== folderState || state.folderId !== currentFolderId.value) {
          return selectedIds.value.size;
        }
        rows = cachedRows;
      }
    }

    const next = new Set<number>();
    for (const row of rows) {
      const id = Number(row?.id);
      if (!Number.isFinite(id)) continue;
      if (unreadOnly && Number(row?.is_seen) !== 0) continue;
      next.add(id);
    }
    if (next.size === 0) return 0;
    selectedIds.value = next;
    return next.size;
  }

  function invalidateFolderStateForFreshWindow(folderId: number | string) {
    const id = Number(folderId);
    if (!Number.isFinite(id)) return;
    staleFolderIds.add(id);
    const state = folderStates.get(id);
    if (!state) return;
    const folderRow = folders.value.find((f) => Number(f.id) === id);
    const knownTotal = Number(folderRow?.index_total ?? folderRow?.total_emails ?? 0) || 0;
    state.rows = [];
    state.paintedRanges = [];
    state.total = knownTotal;
    state.requestedRange = null;
    state.pageInflight = null;
    state.lastFailedRange = null;
    state.didInitialBodyPrefetch = false;
    state.expandInflight = null;
    state.needsFreshWindow = true;
    if (folderState === state) {
      totalForFolder.value = state.total;
      messages.value = [];
      isLoading.value = true;
    }
  }

  async function reconcileSelectedFolderViewState(state: FolderCache | null) {
    if (!repo || authStore.accountId == null || !state) return;
    if (state.folderId !== currentFolderId.value || folderState !== state) return;
    if (state.needsFreshWindow) return;
    try {
      const progress = await repo.queryViewProgress({
        accountId: accountIdForFolder(state.folderId),
        folderId: state.folderId,
        sort: state.sortProp,
      });
      if (state.folderId !== currentFolderId.value || folderState !== state) return;
      if (progress?.stale) {
        invalidateFolderStateForFreshWindow(state.folderId);
        await ensureLoaded(0, PAGE_SIZE);
        return;
      }
      if (Number.isFinite(progress?.total)) {
        const newTotal = Number(progress.total);
        if (newTotal !== state.total) {
          state.total = newTotal;
          totalForFolder.value = state.total;
        }
      }
      if (state.paintedRanges.length > 0) {
        await refreshLoadedPages();
      }
    } catch (err) {
      console.warn('[mail-store] reconcileSelectedFolderViewState failed', err);
    }
  }

  function maybePrefetchInitialBodies(state: FolderCache) {
    const folder = folders.value.find((f) => f.id === state.folderId);
    const isSmallFolder = Number(state.total ?? 0) <= PAGE_SIZE;
    const shouldPrefetch = folder?.role === 'inbox' || isSmallFolder;
    if (!shouldPrefetch || state.didInitialBodyPrefetch) return;
    state.didInitialBodyPrefetch = true;
    bodyPrefetch.enqueueInitialPrefetch(state.rows);
  }

  function nearbyMessageIds(messageId: number): number[] {
    const idx = messages.value.findIndex((row) => row?.id === messageId);
    if (idx < 0) return [messageId];
    const order = [idx, idx + 1, idx + 2, idx - 1];
    return order
      .map((i) => messages.value[i]?.id)
      .filter((id): id is number => id != null);
  }

  /**
   * Prefetch bodies for the virtualizer's visible window. Called
   * from MessageList every time the user pauses scrolling (the
   * watcher is throttled to 100 ms there). Delegates to the
   * body-prefetch composable, which dedupes against its in-flight
   * queue and skips rows whose body is already cached.
   */
  function enqueueVisibleBodyPrefetch(start: number, end: number) {
    bodyPrefetch.enqueueVisibleBodyPrefetch(start, end, messages.value);
  }

  /**
   * Open a message. The store only declares which message to show;
   * the body-prefetch composable owns the actual Email/get path
   * (including the token guard against fast selection churn) and
   * the cache vs network decision.
   */
  function selectMessage(messageId: number | null) {
    selectedMessageId.value = messageId;
    // Plain nav/click/global-shortcut/delete-advance all couple the
    // cursor to the preview. Shift+Arrow range extension is the one
    // path that moves the cursor without calling selectMessage.
    focusedMessageId.value = messageId;
    if (messageId == null || authStore.accountId == null) {
      bodyPrefetch.messageBody.value = null;
      return;
    }

    const token = bodyPrefetch.nextDisplayToken();
    bodyPrefetch.messageBody.value = null;
    void bodyPrefetch.loadBodyForDisplay(messageId, token);

    if (!_isSeenInList(messageId)) {
      markRead(messageId).catch((err) => {
        console.warn('[mail-store] markRead failed', err);
      });
    }

    const neighbors = nearbyMessageIds(messageId).filter((id) => id !== messageId);
    if (neighbors.length > 0) {
      bodyPrefetch.enqueueBodyPrefetch(neighbors);
    }
  }

  function _isSeenInList(messageId: number): boolean {
    const m = messages.value.find((row) => row?.id === messageId);
    return !!m && Number(m.is_seen) === 1;
  }

  /**
   * Resolve an inline message part (a cid: image) to a data: URL the
   * message viewer can render. The blob download runs in the worker
   * (which holds the authenticated transport). We only resolve parts the
   * server typed as an image and build the URL through
   * buildInlineImageDataUrl, which enforces a safe MIME type, validates
   * the base64, and sanitises SVG. Returns null on any failure or for a
   * non-image part, so the viewer leaves the original reference in place.
   */
  async function loadInlineImageUrl(
    blobId: string,
    mimeType: string | null = null,
    name: string | null = null,
  ): Promise<string | null> {
    if (!repo || authStore.accountId == null || !blobId) return null;
    if (!isInlineImageType(mimeType)) return null;
    try {
      const result = await repo.downloadBlob(authStore.accountId, {
        blobId,
        type: mimeType,
        name,
      });
      if (!result?.base64) return null;
      return buildInlineImageDataUrl(result.base64, mimeType);
    } catch (err) {
      console.warn('[mail-store] inline image download failed', err);
      return null;
    }
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
  async function markRead(messageId: number) {
    return _setSeen(messageId, true);
  }

  /**
   * Mirror of markRead. The bulk action uses _setSeen directly with
   * `seen=false` for each id; this wrapper exists so single-row
   * callers (toolbar in MessageView) match the markRead shape.
   */
  async function markUnread(messageId: number) {
    return _setSeen(messageId, false);
  }

  async function _setSeen(messageId: number, seen: boolean) {
    if (!repo || authStore.accountId == null) return;
    const local = messages.value.find((m) => m?.id === messageId);
    const currentSeen = Number(local?.is_seen ?? 0) === 1;
    if (currentSeen === seen) return;
    const keywordsJson = JSON.parse(local?.keywords_json ?? '{}');
    if (seen) {
      keywordsJson.$seen = true;
    } else {
      delete keywordsJson.$seen;
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
      mutationType: MUTATION_TYPE.SET_KEYWORDS,
      targetMessageId: messageId,
      requestJson: JSON.stringify(
        seen ? { add: ['$seen'], remove: [] } : { add: [], remove: ['$seen'] },
      ),
      optimisticPatchJson: JSON.stringify({ is_seen: seen ? 1 : 0 }),
    });
  }

  /**
   * Bulk mark-seen. Matches the same chunk invariant as move/delete:
   * one optimistic keyword transaction and one pending mutation per
   * chunk, then the outbox sends one Email/set update for that chunk.
   *
   * Returns the number of rows whose state actually changed (so the
   * toolbar can show "marked N as read").
   */
  async function markManySeen(ids: number[], seen: boolean): Promise<number> {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    if (!repo || authStore.accountId == null) return 0;
    let changed = 0;
    const normalized = normalizeMessageIds(ids);
    for (let i = 0; i < normalized.length; i += BULK_OPERATION_BATCH_SIZE) {
      const chunk = normalized.slice(i, i + BULK_OPERATION_BATCH_SIZE);
      const optimisticItems: Array<{ messageId: number; keywords: string[]; keywordsJson: string }> = [];
      const changedIds: number[] = [];
      for (const id of chunk) {
        const before = messages.value.find((m) => m?.id === id);
        const wasSeen = Number(before?.is_seen ?? 0) === 1;
        if (wasSeen === seen) continue;
        const keywordsJson = JSON.parse(before?.keywords_json ?? '{}');
        if (seen) {
          keywordsJson.$seen = true;
        } else {
          delete keywordsJson.$seen;
        }
        optimisticItems.push({
          messageId: id,
          keywords: Object.keys(keywordsJson),
          keywordsJson: JSON.stringify(keywordsJson),
        });
        changedIds.push(id);
      }
      if (changedIds.length === 0) continue;
      try {
        if (typeof repo.replaceMessageKeywordsMany === 'function') {
          await repo.replaceMessageKeywordsMany(optimisticItems);
        } else {
          for (const item of optimisticItems) {
            await repo.replaceMessageKeywords(item.messageId, item.keywords, item.keywordsJson);
          }
        }
        await repo.insertPendingMutation({
          accountId: authStore.accountId,
          mutationType: MUTATION_TYPE.SET_KEYWORDS,
          targetMessageId: changedIds.length === 1 ? changedIds[0] : null,
          requestJson: JSON.stringify(
            seen
              ? { messageIds: changedIds, add: ['$seen'], remove: [] }
              : { messageIds: changedIds, add: [], remove: ['$seen'] },
          ),
          optimisticPatchJson: JSON.stringify({ is_seen: seen ? 1 : 0 }),
        });
        changed += changedIds.length;
      } catch (err) {
        console.warn('[mail-store] markManySeen chunk failed', {
          ids: changedIds,
          err: err?.message ?? err,
        });
      }
    }
    return changed;
  }

  async function toggleManySeen(ids: number[]): Promise<number> {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    const first = messages.value.find((m) => m?.id === ids[0]);
    const seen = Number(first?.is_seen ?? 0) === 1;
    return markManySeen(ids, !seen);
  }

  async function archiveMessages(ids: number[]) {
    const messageIds = normalizeMessageIds(ids);
    const source = currentFolder.value;
    if (!source) {
      error.value = 'Cannot archive messages because the current folder is no longer available.';
      return { succeeded: 0, failed: messageIds.length, skipped: 0 };
    }
    const archive = folders.value.find(
      (folder) => folder.account_id === source.account_id && folder.role === 'archive',
    );
    if (!archive?.id) {
      error.value = 'No archive folder is configured.';
      return { succeeded: 0, failed: 0, skipped: 0 };
    }
    return moveMessages(ids, archive.id);
  }

  /**
   * Mark one or more messages as junk: flag them with $junk (dropping
   * any $notjunk) and move them to the Junk folder. The inverse of
   * whitelistSenders' rescue step, minus the sender trust — marking a
   * message as junk deliberately does not touch contacts. The keyword
   * write is optimistic locally plus one queued setKeywords for the
   * batch; the visible effect is the move.
   */
  async function junkMessages(ids: number[]): Promise<MoveResult> {
    if (!repo || authStore.accountId == null) return { succeeded: 0, failed: 0, skipped: 0 };
    const messageIds = normalizeMessageIds(ids);
    if (messageIds.length === 0) return { succeeded: 0, failed: 0, skipped: 0 };
    const source = currentFolder.value;
    if (!source) {
      error.value = 'Cannot mark messages as junk because the current folder is no longer available.';
      return { succeeded: 0, failed: messageIds.length, skipped: 0 };
    }
    const junk = folders.value.find(
      (folder) => folder.account_id === source.account_id && folder.role === 'junk',
    );
    if (!junk?.id) {
      error.value = 'No junk folder is configured.';
      return { succeeded: 0, failed: 0, skipped: 0 };
    }
    try {
      assertCanMoveToFolder(source, junk);
    } catch {
      return { succeeded: 0, failed: messageIds.length, skipped: 0 };
    }

    const rows = messageIds
      .map((id) => messages.value.find((m) => m?.id === id))
      .filter((row): row is CachedRow => row != null);
    if (rows.length === 0) return { succeeded: 0, failed: 0, skipped: messageIds.length };
    const junkIds = rows.map((r) => r.id);

    const optimisticItems = rows.map((row) => {
      const keywordsJson = JSON.parse(row.keywords_json ?? '{}');
      delete keywordsJson.$notjunk;
      keywordsJson.$junk = true;
      return {
        messageId: row.id,
        keywords: Object.keys(keywordsJson),
        keywordsJson: JSON.stringify(keywordsJson),
      };
    });
    if (typeof repo.replaceMessageKeywordsMany === 'function') {
      await repo.replaceMessageKeywordsMany(optimisticItems);
    } else {
      for (const item of optimisticItems) {
        await repo.replaceMessageKeywords(item.messageId, item.keywords, item.keywordsJson);
      }
    }
    await repo.insertPendingMutation({
      accountId: authStore.accountId,
      mutationType: MUTATION_TYPE.SET_KEYWORDS,
      targetMessageId: junkIds.length === 1 ? junkIds[0] : null,
      requestJson: JSON.stringify({ messageIds: junkIds, add: ['$junk'], remove: ['$notjunk'] }),
    });

    const result = await moveMessages(junkIds, junk.id);
    if (result.succeeded > 0) {
      setNotice(result.succeeded === 1
        ? 'Marked as junk'
        : `Marked ${result.succeeded} messages as junk`);
    }
    return result;
  }

  /**
   * Parse a `"Display Name <user@host>"` (or bare `user@host`) From
   * header into its display name and address. Reuses the shared
   * address parser so the angle-bracket / quoted-name handling stays
   * in one place. Returns null when no address can be recovered or the
   * token does not look like an address (we only whitelist real
   * addresses).
   */
  function parseSender(fromText: string | null | undefined): { name: string | null; email: string } | null {
    const parsed = parseOneAddress(String(fromText ?? ''));
    if (!parsed) return null;
    const email = parsed.email.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return null;
    return { name: parsed.name?.trim() || null, email };
  }

  /**
   * Whitelist the senders of one or more Junk messages and rescue the
   * messages (Strategy C from whitelist-in-webmail-notes.md):
   *
   *   1. Trust the senders for future mail — queue one whitelistSender
   *      mutation carrying the unique sender addresses; the outbox adds a
   *      ContactCard per address in the "Trusted senders" address book so
   *      Stalwart's trustContacts / card_is_ham delivers future
   *      authenticated mail from them to the Inbox, and reconciles the
   *      contacts cache once.
   *   2. Rescue the messages — remove $junk / add $notjunk (optimistic +
   *      one queued setKeywords for the batch) and move Junk → Inbox,
   *      since contact trust only applies at ingest time for future mail.
   *
   * A message whose From header yields no address is still rescued; its
   * sender is just skipped for trust. Only meaningful from the Junk
   * folder; the UI gates the action on the junk role. Surfaces a
   * transient success notice when the senders were trusted and the
   * messages moved, or an error when the messages moved but the trust
   * write did not apply.
   */
  async function whitelistSenders(ids: number[]): Promise<MoveResult> {
    if (!repo || authStore.accountId == null) return { succeeded: 0, failed: 0, skipped: 0 };
    const messageIds = normalizeMessageIds(ids);
    if (messageIds.length === 0) return { succeeded: 0, failed: 0, skipped: 0 };
    const source = currentFolder.value;
    if (!source) {
      error.value = 'Cannot move these messages because the current folder is no longer available.';
      return { succeeded: 0, failed: messageIds.length, skipped: 0 };
    }
    const target = folders.value.find(
      (folder) => folder.account_id === source.account_id && folder.role === 'inbox',
    );
    if (!target?.id) {
      error.value = 'No Inbox folder is configured.';
      return { succeeded: 0, failed: 0, skipped: 0 };
    }
    try {
      assertCanMoveToFolder(source, target);
    } catch {
      return { succeeded: 0, failed: messageIds.length, skipped: 0 };
    }

    // Gather the live rows and the unique senders to trust (deduped by
    // address, case-insensitively). Rows with an unparseable From are
    // still rescued below; they just contribute no trusted sender.
    const rows: CachedRow[] = [];
    const sendersByEmail = new Map<string, { name: string | null; email: string }>();
    for (const id of messageIds) {
      const row = messages.value.find((m) => m?.id === id);
      if (!row) continue;
      rows.push(row);
      const sender = parseSender(row.from_text);
      if (sender && !sendersByEmail.has(sender.email.toLowerCase())) {
        sendersByEmail.set(sender.email.toLowerCase(), sender);
      }
    }
    if (rows.length === 0) return { succeeded: 0, failed: 0, skipped: messageIds.length };
    const rescueIds = rows.map((r) => r.id);
    const senders = [...sendersByEmail.values()];

    // 1) Trust every unique sender in a single mutation, run it, and
    //    capture whether the trust write applied — the whole point of the
    //    action is that future mail is trusted, so we must not claim
    //    success when only the message move happened.
    let trusted = true;
    if (senders.length > 0) {
      const trustMutation = await repo.insertPendingMutation({
        accountId: authStore.accountId,
        mutationType: MUTATION_TYPE.WHITELIST_SENDER,
        targetMessageId: null,
        requestJson: JSON.stringify({ senders }),
      });
      const trustResult = typeof repo.runMutation === 'function' && trustMutation?.id != null
        ? await repo.runMutation(authStore.accountId, trustMutation.id)
        : await repo.drainOutbox(authStore.accountId);
      // A run that attempted nothing is not a success; mirror runChunkedMutation.
      trusted = (trustResult?.failed ?? 0) === 0
        && ((trustResult?.attempted ?? 0) > 0 || (trustResult?.succeeded ?? 0) > 0);
    }

    // 2a) Rescue the selected messages' spam keywords: one optimistic
    //     transaction plus one queued setKeywords for the whole batch.
    const optimisticItems = rows.map((row) => {
      const keywordsJson = JSON.parse(row.keywords_json ?? '{}');
      delete keywordsJson.$junk;
      keywordsJson.$notjunk = true;
      return {
        messageId: row.id,
        keywords: Object.keys(keywordsJson),
        keywordsJson: JSON.stringify(keywordsJson),
      };
    });
    if (typeof repo.replaceMessageKeywordsMany === 'function') {
      await repo.replaceMessageKeywordsMany(optimisticItems);
    } else {
      for (const item of optimisticItems) {
        await repo.replaceMessageKeywords(item.messageId, item.keywords, item.keywordsJson);
      }
    }
    await repo.insertPendingMutation({
      accountId: authStore.accountId,
      mutationType: MUTATION_TYPE.SET_KEYWORDS,
      targetMessageId: rescueIds.length === 1 ? rescueIds[0] : null,
      requestJson: JSON.stringify({ messageIds: rescueIds, add: ['$notjunk'], remove: ['$junk'] }),
    });

    // 2b) Move them all out of Junk into the Inbox (the visible effect).
    const result = await moveMessages(rescueIds, target.id);
    if (result.succeeded > 0) {
      const movedPhrase = result.succeeded === 1
        ? 'moved to Inbox'
        : `moved ${result.succeeded} messages to Inbox`;
      if (senders.length === 0) {
        setNotice(`Moved ${result.succeeded} ${result.succeeded === 1 ? 'message' : 'messages'} to Inbox`);
      } else if (trusted) {
        const who = senders.length === 1
          ? (senders[0].name ?? senders[0].email)
          : `${senders.length} senders`;
        setNotice(`Whitelisted ${who} — ${movedPhrase}`);
      } else {
        // Messages moved, but the trust write did not apply — don't claim
        // the senders were whitelisted.
        const what = result.succeeded === 1
          ? 'Moved to Inbox'
          : `Moved ${result.succeeded} messages to Inbox`;
        const who = senders.length === 1
          ? (senders[0].name ?? senders[0].email)
          : 'the senders';
        error.value = `${what}, but ${who} could not be added to your trusted contacts — future mail from them may still be treated as junk.`;
      }
    }
    return result;
  }

  /**
   * Whitelist the sender of a single Junk message and rescue it to the
   * Inbox. Strict about the sender: when the From header yields no
   * address there is nothing to whitelist, so it reports that rather than
   * silently moving the message. Shares the batch work with
   * whitelistSenders.
   */
  async function whitelistSender(messageId: number): Promise<MoveResult> {
    if (!repo || authStore.accountId == null) return { succeeded: 0, failed: 0, skipped: 0 };
    const row = messages.value.find((m) => m?.id === messageId);
    if (!row) return { succeeded: 0, failed: 0, skipped: 0 };
    if (!parseSender(row.from_text)) {
      error.value = 'Could not determine the sender to whitelist.';
      return { succeeded: 0, failed: 0, skipped: 0 };
    }
    return whitelistSenders([messageId]);
  }

  /**
   * Delete one or more messages. Single-row delete from the open
   * message and multi-select bulk delete go through the same path,
   * each chunk being a one-row pending_mutations entry whose
   * request_json carries `messageIds: [...]`.
   *
   * For batches above BULK_OPERATION_BATCH_SIZE the dispatch is split
   * into multiple chunks: each chunk is one Email/set, runs through
   * the outbox sequentially, and ticks `bulkOperation.completed` so
   * the BulkOperationOverlay can show progress. Splitting matters
   * because a single Email/set with 500+ ids exceeds Stalwart's batch
   * handler and gets silently dropped (the user previously saw a
   * useless `noResponse` after eight backoff retries). Sequential
   * chunks also keep the per-chunk failure window small so a
   * recoverable error doesn't drag every id with it.
   *
   * The outbox runs Email/set, applies the local cache update per id
   * (folder_messages, query_view_items, query_views.total), and
   * returns once everything is persisted; the cache is authoritative
   * before this RPC resolves. The store then splices the deleted ids
   * out of messages.value synchronously rather than waiting for the
   * MESSAGES broadcast hop (which can be late or, in some Firefox
   * builds, never arrives).
   *
   * Returns once the round trip is complete; the caller can re-read
   * mailStore.messages right after for the post-delete state.
   */
  async function destroyMessages(ids: number[], { permanent = false }: { permanent?: boolean } = {}) {
    if (!repo || authStore.accountId == null) return;
    if (!Array.isArray(ids) || ids.length === 0) return;
    const source = currentFolder.value;
    if (!source) {
      error.value = 'Cannot delete messages because the current folder is no longer available.';
      return;
    }
    const sourceCapabilities = folderCapabilities(source, authStore.accountId);
    if (!sourceCapabilities.mayRemoveItems) {
      error.value = 'You do not have permission to remove messages from this folder.';
      return;
    }
    // Drop ids that no longer exist in messages (e.g. a previous
    // delete attempt already wiped them but the UI still shows them
    // because the user clicked before the row re-rendered). The
    // PENDING_MUTATION_INSERT FK check would null the target out,
    // but skipping them here keeps the pending row clean and avoids
    // an extra outbox dispatch for nothing.
    const liveIds = await filterExistingMessageIds(ids, source.account_id);
    if (liveIds.length === 0) {
      clearSelectionFor(ids);
      return;
    }
    const trashTarget = permanent
      ? null
      : folders.value.find(
        (folder) => folder.account_id === source.account_id && folder.role === 'trash',
      ) ?? null;
    if (!permanent && source.role !== 'trash' && !trashTarget) {
      error.value = 'No Trash folder is configured for this account.';
      return;
    }
    if (
      trashTarget
      && trashTarget.id !== source.id
      && !folderCapabilities(trashTarget, authStore.accountId).mayAddItems
    ) {
      error.value = 'You do not have permission to move messages to this account’s Trash folder.';
      return;
    }
    const overlayLabel = permanent
      ? 'Deleting messages permanently'
      : (trashTarget?.name ? `Moving messages to ${trashTarget.name}` : 'Deleting messages');
    const succeededIds = await runChunkedMutation({
      liveIds,
      kind: 'destroy',
      label: overlayLabel,
      buildMutation: (chunkIds) => (
        permanent ? buildPermanentDeleteMutation(chunkIds) : buildDeleteMutation(chunkIds)
      ),
      failureAction: 'delete',
    });
    if (succeededIds.length === 0) return;
    const nextPreviewId = nextPreviewIdAfterRemoval(succeededIds);
    // The outbox already updated the cache (folder_messages,
    // query_view_items, query_views.total) before runMutation
    // resolved. Doing one more refreshLoadedPages here used to add
    // 200-400 ms of round-trip latency to every delete on top of
    // the JMAP call (which against a local Stalwart is ~2 ms).
    // Instead, trust the success result: splice the rows out of
    // messages.value synchronously, and let the eventual MESSAGES
    // broadcast confirm in the background through the coalescing
    // refreshLoadedPages path.
    spliceMessagesOut(succeededIds);
    if (trashTarget?.id != null && trashTarget.id !== currentFolder.value?.id) {
      await refreshFolders();
      invalidateFolderStateForFreshWindow(trashTarget.id);
    } else {
      await refreshFolders();
    }
    clearSelectionFor(succeededIds);
    applyPreviewAfterRemoval(nextPreviewId);
  }

  /**
   * Synchronous, RPC-free removal of the given message ids from
   * the current folder's in-memory state. Called right after a
   * successful destroy/move mutation so the UI updates instantly
   * without waiting for the broadcast-triggered refreshLoadedPages
   * (which would do a full SQLite re-read just to land back at
   * the same state we already know).
   *
   * Mirrors the row compaction that QUERY_VIEW_APPLY_CHANGES did
   * server-side: rows are spliced out, total decrements, and
   * painted ranges shrink to match. Other tabs / other sources of
   * change still come through the broadcast + refreshLoadedPages
   * path; this only short-circuits the self-induced case.
   */
  function spliceMessagesOut(ids: number[]) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const state = folderState;
    if (!state) return;
    const toRemove = new Set<number>();
    for (const id of ids) {
      if (Number.isFinite(id)) toRemove.add(Number(id));
    }
    if (toRemove.size === 0) return;
    let removed = 0;
    for (let i = state.rows.length - 1; i >= 0; i -= 1) {
      const row = state.rows[i];
      if (row?.id != null && toRemove.has(Number(row.id))) {
        state.rows.splice(i, 1);
        removed += 1;
      }
    }
    if (removed === 0) return;
    state.total = Math.max(0, Number(state.total ?? 0) - removed);
    // Painted ranges shrink from the right; if a range ends past
    // the new total clamp it, and drop any range that is now empty.
    for (let i = state.paintedRanges.length - 1; i >= 0; i -= 1) {
      const range = state.paintedRanges[i];
      if (range.end > state.total) range.end = Math.max(range.start, state.total);
      if (range.end <= range.start) state.paintedRanges.splice(i, 1);
    }
    if (folderState === state) {
      totalForFolder.value = state.total;
      messages.value = state.rows.slice();
    }
  }

  function removedMessageIds(beforeRows: CachedRow[], afterRows: CachedRow[]): number[] {
    const after = new Set<number>();
    for (const row of afterRows ?? []) {
      if (row?.id != null) after.add(Number(row.id));
    }
    const removed: number[] = [];
    for (const row of beforeRows ?? []) {
      if (row?.id == null) continue;
      const id = Number(row.id);
      if (Number.isFinite(id) && !after.has(id)) removed.push(id);
    }
    return [...new Set(removed)];
  }

  function nextPreviewIdAfterRemoval(ids: number | number[], rows: CachedRow[] = folderState?.rows ?? messages.value): number | null | undefined {
    const removed = new Set(normalizeMessageIds(ids));
    if (removed.size === 0) return undefined;

    const previewWasRemoved = selectedMessageId.value != null
      && removed.has(Number(selectedMessageId.value));
    let checkboxSelectionWasRemoved = false;
    if (selectedMessageId.value == null && selectedIds.value.size > 0) {
      for (const id of selectedIds.value) {
        if (removed.has(Number(id))) {
          checkboxSelectionWasRemoved = true;
          break;
        }
      }
    }
    if (!previewWasRemoved && !checkboxSelectionWasRemoved) return undefined;

    let firstRemovedIndex = -1;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (row?.id != null && removed.has(Number(row.id))) {
        firstRemovedIndex = i;
        break;
      }
    }
    if (firstRemovedIndex < 0) return null;

    for (let i = firstRemovedIndex + 1; i < rows.length; i += 1) {
      const row = rows[i];
      if (row?.id != null && !removed.has(Number(row.id))) return Number(row.id);
    }
    for (let i = firstRemovedIndex - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (row?.id != null && !removed.has(Number(row.id))) return Number(row.id);
    }
    return null;
  }

  function applyPreviewAfterRemoval(nextPreviewId: number | null | undefined) {
    if (nextPreviewId === undefined) return;
    selectMessage(nextPreviewId ?? null);
  }

  /**
   * Single-row delete is the N=1 case of destroyMessages. Kept as a
   * named export so the open-message Delete button and any other
   * single-target caller stay readable.
   */
  async function destroyMessage(messageId: number, options: { permanent?: boolean } = {}) {
    return destroyMessages([messageId], options);
  }

  async function permanentlyDestroyMessages(ids: number[]) {
    return destroyMessages(ids, { permanent: true });
  }

  /**
   * Move one or more messages from the currently-open folder into a
   * target folder. The outbox already knows how to apply moveToFolders
   * locally after Email/set succeeds; the store's job is to validate
   * the source/target pair, enqueue the mutation, and compact the
   * current painted rows once the cache has changed.
   *
   * For batches above BULK_OPERATION_BATCH_SIZE the dispatch is
   * chunked: see runChunkedMutation. The first chunk that fails
   * stops the operation and surfaces an error; chunks that already
   * succeeded are reflected in the splice + return value so the
   * caller (and the user) can see the partial outcome.
   */
  async function moveMessages(ids: number[], targetFolderId: number): Promise<MoveResult> {
    if (!repo || authStore.accountId == null) {
      return { succeeded: 0, failed: 0, skipped: 0 };
    }
    const messageIds = normalizeMessageIds(ids);
    if (messageIds.length === 0) {
      return { succeeded: 0, failed: 0, skipped: 0 };
    }
    const source = currentFolder.value;
    const target = findFolder(targetFolderId);
    assertCanMoveToFolder(source, target);
    if (Number(source.id) === Number(target.id)) {
      return { succeeded: 0, failed: 0, skipped: messageIds.length };
    }

    const liveIds = await filterExistingMessageIds(messageIds, source.account_id);
    if (liveIds.length === 0) {
      clearSelectionFor(messageIds);
      return { succeeded: 0, failed: 0, skipped: messageIds.length };
    }

    const mode = source.account_id === target.account_id ? 'move' : 'copy';
    let succeededIds: number[];
    try {
      succeededIds = await runChunkedMutation({
        liveIds,
        kind: mode,
        label: target.name
          ? `${mode === 'copy' ? 'Copying' : 'Moving'} messages to ${target.name}`
          : `${mode === 'copy' ? 'Copying' : 'Moving'} messages`,
        buildMutation: (chunkIds) => buildMoveMutation(chunkIds, target.id, source.id),
        failureAction: mode,
      });
    } catch (err: any) {
      if (mode !== 'copy') throw err;
      const partial = normalizeMessageIds(err?.succeededIds ?? []);
      return {
        succeeded: partial.length,
        failed: Math.max(0, liveIds.length - partial.length),
        skipped: messageIds.length - liveIds.length,
      };
    }

    if (succeededIds.length === 0) {
      return { succeeded: 0, failed: 0, skipped: messageIds.length - liveIds.length };
    }

    const nextPreviewId = mode === 'move' ? nextPreviewIdAfterRemoval(succeededIds) : undefined;
    if (mode === 'move') spliceMessagesOut(succeededIds);
    await refreshFolders();
    invalidateFolderStateForFreshWindow(target.id);
    if (mode === 'move') clearSelectionFor(succeededIds);
    applyPreviewAfterRemoval(nextPreviewId);
    return {
      succeeded: succeededIds.length,
      failed: 0,
      skipped: messageIds.length - liveIds.length,
    };
  }

  async function moveMessage(messageId: number, targetFolderId: number): Promise<boolean> {
    const result = await moveMessages([messageId], targetFolderId);
    return result.succeeded === 1;
  }

  function canMoveToFolder(targetFolderId: number): boolean {
    return transferModeForFolder(targetFolderId) != null;
  }

  function transferModeForFolder(targetFolderId: number): 'move' | 'copy' | null {
    const source = currentFolder.value;
    const target = findFolder(targetFolderId);
    try {
      assertCanMoveToFolder(source, target);
    } catch {
      return null;
    }
    if (Number(source.id) === Number(target.id)) return null;
    return source.account_id === target.account_id ? 'move' : 'copy';
  }

  async function filterExistingMessageIds(
    ids: number[],
    accountId: number = authStore.accountId!,
  ): Promise<number[]> {
    if (!repo || !Array.isArray(ids) || ids.length === 0) return [];
    const numeric = normalizeMessageIds(ids);
    if (numeric.length === 0) return [];
    return repo.filterExistingMessageIds(accountId, numeric);
  }

  function clearSelectionFor(ids: number | number[]) {
    const normalized = normalizeMessageIds(ids);
    if (normalized.length === 0) return;
    const set = new Set(normalized);
    if (selectedMessageId.value != null && set.has(Number(selectedMessageId.value))) {
      selectedMessageId.value = null;
      messageBody.value = null;
    }
    if (focusedMessageId.value != null && set.has(Number(focusedMessageId.value))) {
      focusedMessageId.value = null;
    }
    if (selectedIds.value.size > 0) {
      let changed = false;
      const next = new Set(selectedIds.value);
      for (const id of normalized) {
        if (next.delete(id)) changed = true;
      }
      if (changed) selectedIds.value = next;
    }
  }

  function clearSelection() {
    if (selectedIds.value.size === 0) return;
    selectedIds.value = new Set();
  }

  async function loadMutationError(mutationId: number | null | undefined) {
    if (!repo || mutationId == null) return null;
    try {
      return await repo.getPendingMutationError(mutationId);
    } catch {
      return null;
    }
  }

  /**
   * Drive the outbox through one or more chunks for a bulk move or
   * destroy. Each chunk is its own pending_mutations row (and its own
   * Email/set round trip), so the JMAP request size never exceeds
   * BULK_OPERATION_BATCH_SIZE regardless of how many ids the user
   * selected. Progress (`bulkOperation.completed`) ticks up after
   * each chunk so the BulkOperationOverlay shows live feedback.
   *
   * Stops on the first failed chunk and rethrows: any chunks that
   * already succeeded are persisted (the outbox already applied them
   * locally), and the failed chunk's pending_mutations row stays
   * `conflicted` so the user can see the error without losing the
   * partial progress. Returns the array of ids whose chunks
   * succeeded so the caller can splice them out of the list.
   */
  async function runChunkedMutation(args: {
    liveIds: number[];
    kind: 'move' | 'copy' | 'destroy';
    label: string;
    buildMutation: (chunkIds: number[]) => PendingMutationInsert;
    failureAction: 'delete' | 'move' | 'copy';
  }): Promise<number[]> {
    const { liveIds, kind, label, buildMutation, failureAction } = args;
    const useOverlay = liveIds.length > BULK_OPERATION_BATCH_SIZE;
    if (useOverlay) {
      bulkOperation.value = {
        active: true,
        kind,
        label,
        total: liveIds.length,
        completed: 0,
      };
    }
    const succeededIds: number[] = [];
    try {
      for (let i = 0; i < liveIds.length; i += BULK_OPERATION_BATCH_SIZE) {
        const chunkIds = liveIds.slice(i, i + BULK_OPERATION_BATCH_SIZE);
        const mutation = await repo!.insertPendingMutation(buildMutation(chunkIds));
        const result = typeof repo!.runMutation === 'function'
          ? await repo!.runMutation(authStore.accountId!, mutation.id)
          : await repo!.drainOutbox(authStore.accountId!);
        if ((result?.failed ?? 0) > 0 || (result?.attempted ?? 0) === 0) {
          const partialIds = normalizeMessageIds(result?.result?.succeededIds ?? [])
            .filter((id) => chunkIds.includes(id) && !succeededIds.includes(id));
          succeededIds.push(...partialIds);
          const detail = await loadMutationError(mutation.id);
          const message = describeChunkedFailure({
            result,
            detail,
            action: failureAction,
            succeeded: succeededIds.length,
            total: liveIds.length,
          });
          const err = new Error(message) as Error & { result?: any; detail?: any };
          err.result = result;
          err.detail = detail;
          (err as Error & { succeededIds?: number[] }).succeededIds = [...succeededIds];
          error.value = message;
          console.warn(`[mail-store] ${kind}Messages failed`, {
            ids: chunkIds,
            result,
            detail,
            succeededBefore: succeededIds.length,
            total: liveIds.length,
          });
          throw err;
        }
        succeededIds.push(...chunkIds);
        if (useOverlay) {
          bulkOperation.value = {
            ...bulkOperation.value,
            completed: succeededIds.length,
          };
        }
      }
      return succeededIds;
    } finally {
      if (useOverlay) {
        resetBulkOperation();
      }
    }
  }

  function resetBulkOperation() {
    bulkOperation.value = {
      active: false,
      kind: null,
      label: '',
      total: 0,
      completed: 0,
    };
  }

  function describeChunkedFailure({
    result, detail, action, succeeded, total,
  }: {
    result: MutationOutcome | null | undefined;
    detail: { error_json?: string | null } | null | undefined;
    action: string;
    succeeded: number;
    total: number;
  }): string {
    const base = describeMutationFailure(result, detail, action);
    if (total <= BULK_OPERATION_BATCH_SIZE || succeeded <= 0) return base;
    const trimmed = base.endsWith('.') ? base.slice(0, -1) : base;
    return `${trimmed} (${succeeded} of ${total} succeeded).`;
  }

  function describeMutationFailure(
    result: MutationOutcome | null | undefined,
    detail: { error_json?: string | null } | null | undefined,
    action: string = 'delete',
  ): string {
    if (detail?.error_json) {
      try {
        const parsed = JSON.parse(detail.error_json);
        const errType = parsed?.type ?? 'error';
        return `Could not ${action} message (${errType}).`;
      } catch {
        // fall through
      }
    }
    if ((result?.attempted ?? 0) === 0) {
      return `Could not ${action} message (no sync backend available).`;
    }
    return `Could not ${action} message.`;
  }

  /**
   * Build the pending_mutations row for deleting one or more
   * messages. The request_json always carries `messageIds: [...]`
   * so the outbox dispatches a single Email/set regardless of how
   * many ids are queued; target_message_id is set only for the N=1
   * case so the OutboxRunner's per-target lock still serialises a
   * single-message delete behind any prior setKeywords on the same
   * id. For bulk deletes (N>1) target_message_id stays null and
   * the row gets a row-id lock instead.
   */
  function buildDeleteMutation(messageIds: number | number[]): PendingMutationInsert {
    const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
    const current = currentFolder.value;
    const trash = current == null
      ? null
      : folders.value.find(
        (folder) => folder.account_id === current.account_id && folder.role === 'trash',
      );
    const target = ids.length === 1 ? ids[0] : null;
    if (trash && current?.id != null && current.id !== trash.id) {
      return {
        accountId: authStore.accountId,
        mutationType: MUTATION_TYPE.MOVE_TO_FOLDERS,
        targetMessageId: target,
        requestJson: JSON.stringify({
          messageIds: ids,
          addFolderIds: [trash.id],
          removeFolderIds: [current.id],
        }),
      };
    }
    return {
      accountId: authStore.accountId,
      mutationType: MUTATION_TYPE.DESTROY,
      targetMessageId: target,
      requestJson: JSON.stringify({ messageIds: ids }),
    };
  }

  function buildPermanentDeleteMutation(messageIds: number | number[]): PendingMutationInsert {
    const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
    const target = ids.length === 1 ? ids[0] : null;
    return {
      accountId: authStore.accountId,
      mutationType: MUTATION_TYPE.DESTROY,
      targetMessageId: target,
      requestJson: JSON.stringify({ messageIds: ids }),
    };
  }

  function buildMoveMutation(messageIds: number[], targetFolderId: number, sourceFolderId: number): PendingMutationInsert {
    const ids = normalizeMessageIds(messageIds);
    const source = findFolder(sourceFolderId);
    const target = findFolder(targetFolderId);
    const crossAccount = source != null && target != null && source.account_id !== target.account_id;
    const request = crossAccount
      ? {
        messageIds: ids,
        addFolderIds: [Number(targetFolderId)],
      }
      : {
        messageIds: ids,
        addFolderIds: [Number(targetFolderId)],
        removeFolderIds: [Number(sourceFolderId)],
      };
    return {
      accountId: authStore.accountId!,
      mutationType: crossAccount
        ? MUTATION_TYPE.COPY_TO_FOLDERS
        : MUTATION_TYPE.MOVE_TO_FOLDERS,
      targetMessageId: ids.length === 1 ? ids[0] : null,
      requestJson: JSON.stringify(request),
    };
  }

  function findFolder(folderId: number | null | undefined): FolderRow | null {
    const localId = Number(folderId);
    if (!Number.isFinite(localId)) return null;
    return folders.value.find((f) => Number(f.id) === localId) ?? null;
  }

  function normalizeMessageIds(ids: number | number[] | null | undefined): number[] {
    const raw = Array.isArray(ids) ? ids : [ids];
    const out = raw
      .map(Number)
      .filter((id) => Number.isFinite(id));
    return [...new Set(out)];
  }

  function assertCanMoveToFolder(source: FolderRow | null | undefined, target: FolderRow | null): asserts source is FolderRow {
    if (!source?.id) {
      throwMoveError('Cannot move message without a source folder.');
    }
    if (!target || Number(target.is_deleted) === 1) {
      throwMoveError('Cannot move message to that folder.');
    }
    if (Number(source.id) === Number(target.id)) {
      return;
    }
    const sourceCapabilities = folderCapabilities(source, authStore.accountId);
    const targetCapabilities = folderCapabilities(target, authStore.accountId);
    if (source.account_id === target.account_id && !sourceCapabilities.mayRemoveItems) {
      throwMoveError('Cannot move messages out of this folder.');
    }
    if (source.account_id !== target.account_id && !sourceCapabilities.mayReadItems) {
      throwMoveError('Cannot copy messages from this folder.');
    }
    if (!targetCapabilities.mayAddItems) {
      throwMoveError(`Cannot ${source.account_id === target.account_id ? 'move' : 'copy'} messages into that folder.`);
    }
  }

  function throwMoveError(message: string): never {
    error.value = message;
    throw new Error(message);
  }

  function snapshotRefreshSelection(state: FolderCache): RefreshSelectionSnapshot | null {
    const selectedId = Number(selectedMessageId.value);
    if (!Number.isFinite(selectedId)) return null;
    const index = state.rows.findIndex((row) => row?.id === selectedId);
    if (index < 0) return null;
    return {
      id: selectedId,
      remoteId: state.rows[index]?.remote_id ?? null,
      index,
    };
  }

  function selectRefreshSelectionIfLoaded(state: FolderCache, snapshot: RefreshSelectionSnapshot): boolean {
    const restored = state.rows.some((row) =>
      row?.id === snapshot.id && (!snapshot.remoteId || row.remote_id === snapshot.remoteId),
    );
    if (restored) selectMessage(snapshot.id);
    return restored;
  }

  async function restoreSelectionAfterRefresh(state: FolderCache, snapshot: RefreshSelectionSnapshot | null) {
    if (!snapshot || !repo || authStore.accountId == null) return;
    if (state !== folderState || state.folderId !== currentFolderId.value) return;

    if (selectRefreshSelectionIfLoaded(state, snapshot)) return;

    if (!snapshot.remoteId) {
      clearRefreshSelectionIfUnchanged(snapshot);
      return;
    }

    let anchorResult: any;
    try {
      anchorResult = await repo.ensureFolderWindow(
        accountIdForFolder(state.folderId),
        state.folderId,
        {
          anchor: snapshot.remoteId,
          anchorOffset: 0,
          limit: 1,
          sortProp: state.sortProp === 'sent' ? 'sentAt' : 'receivedAt',
        },
      );
    } catch (err) {
      console.warn('[mail-store] refresh selection restore failed', err);
      return;
    }

    if (state !== folderState || state.folderId !== currentFolderId.value) return;
    const ids = Array.isArray(anchorResult?.ids)
      ? anchorResult.ids.map((id) => String(id))
      : [];
    if (!ids.includes(snapshot.remoteId)) {
      clearRefreshSelectionIfUnchanged(snapshot);
      return;
    }
    if (Number.isFinite(anchorResult?.total)) {
      state.total = Number(anchorResult.total);
      totalForFolder.value = state.total;
    }

    const position = Number(anchorResult?.position);
    const offset = Number.isFinite(position)
      ? Math.max(0, position)
      : Math.max(0, snapshot.index);
    await ensureLoaded(offset, offset + 1);
    if (state !== folderState || state.folderId !== currentFolderId.value) return;

    if (selectRefreshSelectionIfLoaded(state, snapshot)) return;
    clearRefreshSelectionIfUnchanged(snapshot);
  }

  function clearRefreshSelectionIfUnchanged(snapshot: RefreshSelectionSnapshot) {
    if (selectedMessageId.value === snapshot.id) {
      selectMessage(null);
    }
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
    const refreshSelection = snapshotRefreshSelection(state);
    state.lastFailedRange = null;
    isLoading.value = true;
    manualRefreshFolderId = state.folderId;
    try {
      await repo.ensureFolderTree(authStore.accountId);

      await repo.resetViewForFolder(accountIdForFolder(state.folderId), state.folderId);
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
        accountIdForFolder(state.folderId),
        state.folderId,
        { offset: 0, limit: PAGE_SIZE },
      );
      if (state !== folderState) return;
      if (Number.isFinite(result?.total)) {
        state.total = Number(result.total);
        totalForFolder.value = state.total;
      }
      // The manual refresh is the user's explicit recovery path; let
      // the next folder open re-check for drift with a clean slate.
      state.driftRebuildAttempted = false;
      await ensureLoaded(0, PAGE_SIZE);
      await restoreSelectionAfterRefresh(state, refreshSelection);
    } catch (err) {
      console.warn('[mail-store] refresh failed', err);
      error.value = err?.message ?? String(err);
    } finally {
      if (manualRefreshFolderId === state.folderId) {
        manualRefreshFolderId = null;
      }
      if (folderState === state) {
        isLoading.value = false;
      }
    }
  }

  // Folder ids with an in-flight subscription mutation. The dialog
  // disables the toggle while pending: the OutboxRunner serialises
  // rows by target_message_id only, so two rapid toggles on the same
  // folder would otherwise race each other on the server.
  const subscriptionPendingFolderIds = ref<Set<number>>(new Set());

  /**
   * Set the subscription (JMAP Mailbox isSubscribed) of one or more
   * folders. All affected rows flip optimistically in a single
   * reactive pass, so the sidebar repaints once — straight to the
   * final state — instead of stepping through every intermediate
   * combination while the per-mailbox mutations land sequentially.
   * Returns true when the server accepted every change; on any
   * failure the folder list is reloaded from the DB to reconcile.
   */
  async function setFolderSubscriptions(
    folderIds: number[],
    isSubscribed: boolean,
  ): Promise<boolean> {
    if (!repo || authStore.accountId == null) return false;
    const requestedIds = [...new Set(folderIds.map(Number))]
      .filter(Number.isFinite)
      .filter((id) => {
        const folder = folders.value.find((candidate) => candidate.id === id);
        return folder != null
          && folderCapabilities(folder, authStore.accountId).maySubscribe;
      });
    const omittedPendingIds = requestedIds.filter(
      (id) => subscriptionPendingFolderIds.value.has(id),
    );
    const ids = requestedIds.filter(
      (id) => !subscriptionPendingFolderIds.value.has(id),
    );
    if (ids.length === 0) return false;
    const target: 0 | 1 = isSubscribed ? 1 : 0;
    const previous = new Map<number, { subscribed: 0 | 1 | null; starred: 0 | 1 }>();
    for (const id of ids) {
      optimisticSubscriptions.set(id, target);
      const row = folders.value.find((f) => f.id === id);
      if (row) {
        previous.set(id, {
          subscribed: row.is_subscribed,
          starred: row.is_starred,
        });
        row.is_subscribed = target;
        if (!isSubscribed) row.is_starred = 0;
      }
    }
    subscriptionPendingFolderIds.value = new Set([
      ...subscriptionPendingFolderIds.value,
      ...ids,
    ]);
    try {
      const mutation = await repo.insertPendingMutation({
        accountId: authStore.accountId,
        mutationType: MUTATION_TYPE.SET_MAILBOX_SUBSCRIPTION,
        targetMessageId: null,
        requestJson: JSON.stringify({
          operations: ids.map((folderId) => ({ folderId, isSubscribed })),
        }),
      });
      const result: MutationOutcome = typeof repo.runMutation === 'function' && mutation?.id != null
        ? await repo.runMutation(authStore.accountId, mutation.id)
        : await repo.drainOutbox(authStore.accountId);
      const succeeded = new Set(
        (result?.result?.succeededIds ?? (
          (result?.failed ?? 0) === 0 && (result?.succeeded ?? 0) > 0 ? ids : []
        )).map(Number),
      );
      for (const id of ids) {
        if (succeeded.has(id)) continue;
        const snapshot = previous.get(id);
        const row = folders.value.find((folder) => folder.id === id);
        if (snapshot && row) {
          row.is_subscribed = snapshot.subscribed;
          row.is_starred = snapshot.starred;
        }
      }
      const allOk = omittedPendingIds.length === 0 && succeeded.size === ids.length;
      if (!allOk) {
        if (omittedPendingIds.length > 0 && succeeded.size === ids.length) {
          error.value = 'Some folders already have a subscription change in progress.';
        } else {
          const detail = mutation?.id != null ? await loadMutationError(mutation.id) : null;
          error.value = describeMutationFailure(
            result,
            detail,
            isSubscribed ? 'subscribe to' : 'unsubscribe from',
          ).replace('message', 'folder');
        }
      }
      return allOk;
    } catch (err) {
      for (const [id, snapshot] of previous) {
        const row = folders.value.find((folder) => folder.id === id);
        if (row) {
          row.is_subscribed = snapshot.subscribed;
          row.is_starred = snapshot.starred;
        }
      }
      error.value = err?.message ?? String(err);
      return false;
    } finally {
      for (const id of ids) optimisticSubscriptions.delete(id);
      const next = new Set(subscriptionPendingFolderIds.value);
      for (const id of ids) next.delete(id);
      subscriptionPendingFolderIds.value = next;
    }
  }

  /** Single-folder convenience wrapper around setFolderSubscriptions. */
  function setFolderSubscription(folderId: number, isSubscribed: boolean): Promise<boolean> {
    return setFolderSubscriptions([folderId], isSubscribed);
  }

  /**
   * Toggle a folder's client-local star (priority pin at the top of
   * the folder list). Purely a SQLite preference — no JMAP mutation —
   * so it applies optimistically and the FOLDERS broadcast reconciles
   * other tabs.
   */
  async function setFoldersStarred(folderIds: number[], isStarred: boolean): Promise<boolean> {
    if (!repo) return false;
    const target = isStarred ? 1 : 0;
    const rows = [...new Set(folderIds.map(Number))]
      .map((id) => folders.value.find((folder) => folder.id === id))
      .filter((folder): folder is FolderRow => (
        folder != null
        && !folderCapabilities(folder, authStore.accountId).isSystemProtected
        && (!isStarred || folderCapabilities(folder, authStore.accountId).mayStar)
      ));
    if (rows.length === 0) return false;
    const previous = new Map(rows.map((folder) => [folder.id, folder.is_starred]));
    for (const folder of rows) folder.is_starred = target;
    try {
      await repo.setFoldersStarred(rows.map((folder) => folder.id), isStarred);
      return true;
    } catch (err) {
      for (const folder of rows) folder.is_starred = previous.get(folder.id) ?? 0;
      error.value = err?.message ?? String(err);
      return false;
    }
  }

  async function setFolderStarred(folderId: number, isStarred: boolean): Promise<boolean> {
    return setFoldersStarred([folderId], isStarred);
  }

  // ----- folder create / rename / move / delete ------------------------

  /** Folder ids with an in-flight rename/move/delete mutation. */
  const folderEditPendingIds = ref<Set<number>>(new Set());
  // A destructive retry is legal only after the server rejected this
  // exact folder with mailboxHasEmail. Ancestors pruned for dependency
  // safety still receive their own non-destructive probe first.
  const folderDeleteMailboxHasEmailIds = new Set<number>();
  /** True while a createFolder mutation is in flight. */
  const folderCreatePending = ref(false);

  interface FolderOpResult {
    ok: boolean;
    /** Machine-readable failure cause for flows the UI branches on. */
    reason?: string;
    succeededIds?: Array<number | string>;
    errors?: Record<string, any>;
  }

  function folderOpFailure(detail: { error_json?: string | null } | null, fallback: string): FolderOpResult {
    let reason = fallback;
    if (detail?.error_json) {
      try {
        const parsed = JSON.parse(detail.error_json);
        // notUpdated/notCreated/notDestroyed wrap the JMAP SetError;
        // surface the inner type (e.g. mailboxHasEmail, forbidden) so
        // the dialog can branch on it.
        reason = parsed?.detail?.type ?? parsed?.type ?? fallback;
        // The server reports a nesting-depth violation as a generic
        // invalidProperties on parentId; the description is the only
        // way to tell it apart from other bad-property rejections.
        const description = String(parsed?.detail?.description ?? '');
        if (reason === 'invalidProperties' && /too deep/i.test(description)) {
          reason = 'tooDeep';
        }
      } catch {
        // fall through
      }
    }
    return { ok: false, reason };
  }

  async function runFolderMutation(
    mutationType: MutationType,
    request: Record<string, unknown>,
    action: string,
  ): Promise<FolderOpResult> {
    if (!repo || authStore.accountId == null) {
      return { ok: false, reason: 'noBackend' };
    }
    const mutation = await repo.insertPendingMutation({
      accountId: authStore.accountId,
      mutationType,
      targetMessageId: null,
      requestJson: JSON.stringify(request),
    });
    const result: MutationOutcome = typeof repo.runMutation === 'function' && mutation?.id != null
      ? await repo.runMutation(authStore.accountId, mutation.id)
      : await repo.drainOutbox(authStore.accountId);
    if ((result?.failed ?? 0) > 0 || (result?.succeeded ?? 0) === 0) {
      const detail = mutation?.id != null ? await loadMutationError(mutation.id) : null;
      const failure = folderOpFailure(detail, 'serverFail');
      error.value = describeMutationFailure(result, detail, action).replace('message', 'folder');
      return {
        ...failure,
        succeededIds: result.result?.succeededIds ?? [],
        errors: result.result?.errors ?? result.error?.result?.errors ?? {},
      };
    }
    const success: FolderOpResult = { ok: true };
    if (result.result?.succeededIds) success.succeededIds = result.result.succeededIds;
    if (result.result?.errors) success.errors = result.result.errors;
    return success;
  }

  function siblingNameTaken(accountId: number, parentFolderId: number | null, name: string, excludeFolderId?: number): boolean {
    const target = name.trim().toLowerCase();
    return folders.value.some((f) =>
      f.account_id === accountId
      && Number(f.is_deleted) !== 1
      && f.id !== excludeFolderId
      && (f.parent_id ?? null) === (parentFolderId ?? null)
      && f.name?.trim().toLowerCase() === target);
  }

  /**
   * Create a mailbox, top-level (parentFolderId null: always on the
   * signed-in account) or as a child of any folder the user may create
   * under (own folders, or shared folders granting mayCreateChild).
   */
  async function createFolder({ name, parentFolderId = null }: { name: string; parentFolderId?: number | null }): Promise<FolderOpResult> {
    const trimmed = (name ?? '').trim();
    if (!trimmed) return { ok: false, reason: 'invalidName' };
    if (folderCreatePending.value) return { ok: false, reason: 'pending' };
    const parent = parentFolderId != null
      ? folders.value.find((f) => f.id === parentFolderId) ?? null
      : null;
    if (parentFolderId != null && !parent) return { ok: false, reason: 'unknownFolder' };
    if (
      parent != null
      && !folderCapabilities(parent, authStore.accountId).mayCreateChild
    ) {
      return { ok: false, reason: 'forbidden' };
    }
    const targetAccountId = parent?.account_id ?? authStore.accountId;
    if (targetAccountId != null && siblingNameTaken(targetAccountId, parent?.id ?? null, trimmed)) {
      error.value = `A folder named “${trimmed}” already exists here.`;
      return { ok: false, reason: 'duplicateName' };
    }
    folderCreatePending.value = true;
    try {
      return await runFolderMutation(
        MUTATION_TYPE.CREATE_MAILBOX,
        { operations: [{ clientId: 'c1', name: trimmed, parentFolderId }] },
        'create',
      );
    } catch (err) {
      error.value = err?.message ?? String(err);
      return { ok: false, reason: 'serverFail' };
    } finally {
      folderCreatePending.value = false;
    }
  }

  /**
   * Rename and/or move a folder. Pass `parentFolderId` (possibly null
   * for top level) only when the parent should change.
   */
  async function updateFolder(
    folderId: number,
    changes: { name?: string; parentFolderId?: number | null },
  ): Promise<FolderOpResult> {
    const id = Number(folderId);
    const folder = folders.value.find((f) => f.id === id);
    if (!folder) return { ok: false, reason: 'unknownFolder' };
    const capabilities = folderCapabilities(folder, authStore.accountId);
    if (capabilities.isSystemProtected) return { ok: false, reason: 'systemFolder' };
    if (!capabilities.mayRename) return { ok: false, reason: 'forbidden' };
    if (folderEditPendingIds.value.has(id)) return { ok: false, reason: 'pending' };

    const parentProvided = Object.prototype.hasOwnProperty.call(changes, 'parentFolderId');
    const request: Record<string, unknown> = { folderId: id };
    const nextName = changes.name?.trim();
    if (nextName && nextName !== folder.name) request.name = nextName;
    if (parentProvided && (changes.parentFolderId ?? null) !== (folder.parent_id ?? null)) {
      const nextParentId = changes.parentFolderId ?? null;
      if (nextParentId != null) {
        // Walk up from the destination: moving under yourself or a
        // descendant would detach the subtree into a cycle.
        let cursor = folders.value.find((f) => f.id === nextParentId) ?? null;
        while (cursor) {
          if (cursor.id === id) return { ok: false, reason: 'parentLoop' };
          cursor = folders.value.find((f) => f.id === cursor!.parent_id) ?? null;
        }
        const parent = folders.value.find((f) => f.id === nextParentId);
        if (!parent || parent.account_id !== folder.account_id) {
          return { ok: false, reason: 'unknownFolder' };
        }
        if (!folderCapabilities(parent, authStore.accountId).mayCreateChild) {
          return { ok: false, reason: 'forbidden' };
        }
      } else if (folder.account_id !== authStore.accountId) {
        return { ok: false, reason: 'forbidden' };
      }
      request.parentFolderId = nextParentId;
    }
    if (request.name == null && !('parentFolderId' in request)) {
      return { ok: true };
    }
    const finalName = (request.name as string | undefined) ?? folder.name;
    const finalParent = 'parentFolderId' in request
      ? (request.parentFolderId as number | null)
      : (folder.parent_id ?? null);
    if (siblingNameTaken(folder.account_id, finalParent, finalName, id)) {
      error.value = `A folder named “${finalName}” already exists here.`;
      return { ok: false, reason: 'duplicateName' };
    }

    folderEditPendingIds.value = new Set([...folderEditPendingIds.value, id]);
    try {
      return await runFolderMutation(
        MUTATION_TYPE.UPDATE_MAILBOX,
        { operations: [request] },
        'rename',
      );
    } catch (err) {
      error.value = err?.message ?? String(err);
      return { ok: false, reason: 'serverFail' };
    } finally {
      const next = new Set(folderEditPendingIds.value);
      next.delete(id);
      folderEditPendingIds.value = next;
    }
  }

  /**
   * Delete a folder. First attempt always sends
   * onDestroyRemoveEmails: false; a mailboxHasEmail rejection is
   * returned as { ok: false, reason: 'mailboxHasEmail' } so the dialog
   * can show the escalated warning and call again with
   * removeEmails: true after explicit confirmation (RFC 8621 §2.5).
   *
   * skipChildCheck is for the bulk-delete path: the dialog deletes a
   * fully-selected subtree deepest-first, and the local folders ref may
   * not have refreshed between the sequential deletes, so the client-
   * side "has children" guard would false-positive on the parent. The
   * server still enforces mailboxHasChild, so this only skips the
   * local pre-check, not the real constraint.
   */
  async function deleteFolders(
    folderIds: number[],
    { removeEmails = false, skipChildCheck = false }: {
      removeEmails?: boolean;
      skipChildCheck?: boolean;
    } = {},
  ): Promise<FolderOpResult> {
    const ids = [...new Set(folderIds.map(Number).filter(Number.isFinite))];
    if (ids.length === 0) return { ok: false, reason: 'unknownFolder' };
    const selected = new Set(ids);
    const rows = new Map(ids.map((id) => [
      id,
      folders.value.find((folder) => folder.id === id) ?? null,
    ]));
    for (const [id, folder] of rows) {
      if (!folder) return { ok: false, reason: 'unknownFolder' };
      const capabilities = folderCapabilities(folder, authStore.accountId);
      if (capabilities.isSystemProtected) return { ok: false, reason: 'systemFolder' };
      if (!capabilities.mayDelete) return { ok: false, reason: 'forbidden' };
      if (
        removeEmails
        && folderDeleteMailboxHasEmailIds.has(id)
        && !capabilities.mayDeleteWithMail
      ) {
        return { ok: false, reason: 'forbidden' };
      }
      if (folderEditPendingIds.value.has(id)) return { ok: false, reason: 'pending' };
      if (!skipChildCheck && folders.value.some(
        (candidate) => candidate.parent_id === id
          && Number(candidate.is_deleted) !== 1
          && !selected.has(candidate.id),
      )) {
        error.value = 'Move or delete its subfolders first.';
        return { ok: false, reason: 'mailboxHasChild' };
      }
    }

    const depthMemo = new Map<number, number>();
    const depthOf = (id: number): number => {
      const cached = depthMemo.get(id);
      if (cached != null) return cached;
      const parentId = rows.get(id)?.parent_id;
      const depth = parentId != null && selected.has(parentId) ? depthOf(parentId) + 1 : 0;
      depthMemo.set(id, depth);
      return depth;
    };
    const byDepth = new Map<number, number[]>();
    for (const id of ids) {
      const depth = depthOf(id);
      const layer = byDepth.get(depth) ?? [];
      layer.push(id);
      byDepth.set(depth, layer);
    }

    folderEditPendingIds.value = new Set([...folderEditPendingIds.value, ...ids]);
    const succeededIds: number[] = [];
    const errors: Record<string, any> = {};
    const blocked = new Set<number>();
    const blockAncestors = (id: number) => {
      let parentId = rows.get(id)?.parent_id ?? null;
      while (parentId != null && selected.has(parentId)) {
        blocked.add(parentId);
        parentId = rows.get(parentId)?.parent_id ?? null;
      }
    };
    try {
      const depths = [...byDepth.keys()].sort((a, b) => b - a);
      for (const depth of depths) {
        const layer = (byDepth.get(depth) ?? []).filter((id) => !blocked.has(id));
        for (const id of byDepth.get(depth) ?? []) {
          if (blocked.has(id)) errors[String(id)] = { type: 'childFailed' };
        }
        if (layer.length === 0) continue;
        let result = await runFolderMutation(
          MUTATION_TYPE.DESTROY_MAILBOX,
          {
            operations: layer.map((folderId) => ({
              folderId,
              onDestroyRemoveEmails: removeEmails
                && folderDeleteMailboxHasEmailIds.has(folderId),
            })),
          },
          'delete',
        );
        let confirmed = new Set(
          (result.succeededIds ?? (result.ok ? layer : [])).map(Number),
        );
        const layerErrors: Record<string, any> = { ...(result.errors ?? {}) };
        if (!result.ok && Object.keys(layerErrors).length === 0) {
          for (const id of layer) {
            if (!confirmed.has(id)) layerErrors[String(id)] = { type: result.reason ?? 'serverFail' };
          }
        }
        const newlyDestructive = removeEmails
          ? layer.filter((id) => {
            const failure = layerErrors[String(id)];
            const reason = failure?.detail?.type ?? failure?.type;
            return reason === 'mailboxHasEmail'
              && !folderDeleteMailboxHasEmailIds.has(id);
          })
          : [];
        if (newlyDestructive.length > 0) {
          for (const id of newlyDestructive) folderDeleteMailboxHasEmailIds.add(id);
          const retry = await runFolderMutation(
            MUTATION_TYPE.DESTROY_MAILBOX,
            {
              operations: newlyDestructive.map((folderId) => ({
                folderId,
                onDestroyRemoveEmails: true,
              })),
            },
            'delete',
          );
          for (const id of newlyDestructive) delete layerErrors[String(id)];
          const retried = new Set(
            (retry.succeededIds ?? (retry.ok ? newlyDestructive : [])).map(Number),
          );
          confirmed = new Set([...confirmed, ...retried]);
          for (const id of newlyDestructive) {
            if (!retried.has(id)) {
              layerErrors[String(id)] = retry.errors?.[String(id)]
                ?? { type: retry.reason ?? 'serverFail' };
            }
          }
          result = retry;
        }
        succeededIds.push(...layer.filter((id) => confirmed.has(id)));
        for (const id of confirmed) folderDeleteMailboxHasEmailIds.delete(id);
        for (const id of layer) {
          if (confirmed.has(id)) continue;
          const failure = layerErrors[String(id)] ?? { type: result.reason ?? 'serverFail' };
          errors[String(id)] = failure;
          const reason = failure?.detail?.type ?? failure?.type;
          if (reason === 'mailboxHasEmail') folderDeleteMailboxHasEmailIds.add(id);
          blockAncestors(id);
        }
      }
      if (succeededIds.includes(currentFolderId.value ?? -1)) {
        const fallback = inbox.value?.id ?? null;
        if (fallback != null) selectFolder(fallback);
      }
      const failures = Object.values(errors) as any[];
      if (failures.length === 0) {
        error.value = null;
        return { ok: true, succeededIds };
      }
      const reasons = failures.map((failure) =>
        failure?.detail?.type ?? failure?.type ?? 'serverFail');
      const actionableReasons = reasons.filter((reason) => reason !== 'childFailed');
      const reason = actionableReasons.find((value) => value !== 'mailboxHasEmail')
        ?? actionableReasons[0]
        ?? reasons[0];
      const escalationOnly = actionableReasons.length > 0
        && actionableReasons.every((value) => value === 'mailboxHasEmail');
      error.value = escalationOnly
        ? null
        : `Could not delete folder (${reason}).`;
      return { ok: false, reason, succeededIds, errors };
    } catch (err) {
      error.value = err?.message ?? String(err);
      return { ok: false, reason: 'serverFail', succeededIds, errors };
    } finally {
      const next = new Set(folderEditPendingIds.value);
      for (const id of ids) next.delete(id);
      folderEditPendingIds.value = next;
    }
  }

  async function deleteFolder(
    folderId: number,
    options: { removeEmails?: boolean; skipChildCheck?: boolean } = {},
  ): Promise<FolderOpResult> {
    const result = await deleteFolders([folderId], options);
    return result.ok
      ? { ok: true }
      : { ok: false, reason: result.reason };
  }

  return {
    folders,
    accounts,
    sharedAccounts,
    primaryFolders,
    sidebarPrimaryFolders,
    sharedFolderGroups,
    subscriptionPendingFolderIds,
    setFolderSubscription,
    setFolderSubscriptions,
    setFolderStarred,
    setFoldersStarred,
    folderEditPendingIds,
    folderCreatePending,
    createFolder,
    updateFolder,
    deleteFolder,
    deleteFolders,
    currentFolderId,
    currentFolder,
    inbox,
    messages,
    totalForFolder,
    selectedMessageId,
    focusedMessageId,
    selectedIds,
    messageBody,
    isLoading,
    error,
    notice,
    bulkOperation,
    $reset,
    attach,
    detach,
    refreshFolders,
    selectFolder,
    selectMessage,
    loadInlineImageUrl,
    ensureLoaded,
    enqueueVisibleBodyPrefetch,
    setScrollTop,
    getScrollTop,
    setRequestedRange,
    expandFolderViewIntoMemory,
    selectAllLoadedMessages,
    markRead,
    markUnread,
    markManySeen,
    toggleManySeen,
    destroyMessage,
    destroyMessages,
    permanentlyDestroyMessages,
    moveMessage,
    moveMessages,
    archiveMessages,
    junkMessages,
    whitelistSender,
    whitelistSenders,
    canMoveToFolder,
    transferModeForFolder,
    clearSelection,
    refresh,
  };
});
