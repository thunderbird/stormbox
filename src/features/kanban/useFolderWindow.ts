/**
 * Positional message window for one folder, independent of the mail
 * store's single "open folder". Reads the same cache-first path the
 * store uses (`listMessagesForView` → `ensureFolderWindow` on a miss)
 * so a kanban column shows exactly the rows the folder list would, and
 * re-reads its loaded pages whenever the worker broadcasts a MESSAGES
 * change. No JMAP calls are made from here; the sync layer owns those.
 */

import {
  computed, onBeforeUnmount, ref, shallowRef, watch, type Ref,
} from 'vue';

import { getRepositoryAsync } from '../../composables/useRepository';
import { TABLE_FAMILIES } from '../../db/protocol';
import { useAuthStore } from '../../stores/auth-store';
import { useMailStore } from '../../stores/mail-store';
import type { FolderRow, MessageRow } from '../../types';

export const FOLDER_WINDOW_PAGE_SIZE = 100;
/**
 * Upper bound on the rows a column pulls in for the Quick Filter. The
 * filter matches over loaded rows only, so this caps the SQLite/JMAP
 * paging a keystroke can trigger on a large folder; the column says when
 * the bound was hit.
 */
export const QUICK_FILTER_MAX_ROWS = 500;

type Repo = Awaited<ReturnType<typeof getRepositoryAsync>>;

interface FolderWindowOptions {
  /**
   * While true, MESSAGES broadcasts are noted but not acted on; the
   * loaded prefix is re-read once when the window is resumed. Used for
   * columns that are mounted but hidden.
   */
  paused?: Ref<boolean>;
}

interface WindowState {
  folderId: number;
  rows: Array<MessageRow | undefined>;
  total: number;
  /** Positions [0, loadedEnd) are backed by rows (pages are contiguous). */
  loadedEnd: number;
  everLoaded: boolean;
  needsFreshWindow: boolean;
  inflight: Promise<void> | null;
  requestedEnd: number;
}

export function useFolderWindow(folderId: Ref<number | null>, options: FolderWindowOptions = {}) {
  const authStore = useAuthStore();
  const mailStore = useMailStore();

  const rows = shallowRef<Array<MessageRow | undefined>>([]);
  const total = ref(0);
  const loading = ref(false);
  const error = ref<string | null>(null);
  /**
   * True when `rows` backs every requested position (or the folder
   * ends) with no rebuild pending: the only moment a row's absence means
   * it left the folder rather than that its page has not landed yet.
   */
  const settled = ref(false);

  let repo: Repo | null = null;
  let repoPromise: Promise<Repo> | null = null;
  let unsubscribe: (() => void) | null = null;
  let state: WindowState | null = null;
  let refreshInflight: Promise<void> | null = null;
  let refreshDirty = false;
  let missedWhilePaused = false;
  let disposed = false;

  const paused = () => options.paused?.value === true;

  const folder = computed<FolderRow | null>(() => {
    const id = folderId.value;
    if (id == null) return null;
    return mailStore.folders.find((f) => Number(f.id) === Number(id)) ?? null;
  });
  const sortProp = computed(() => mailStore.sortPropFor(folder.value));

  function accountIdFor(): number | null {
    return folder.value?.account_id ?? authStore.accountId ?? null;
  }

  function viewFor(current: WindowState, accountId: number) {
    return { accountId, folderId: current.folderId, sort: sortProp.value };
  }

  async function ensureRepo(): Promise<Repo | null> {
    if (repo) return repo;
    if (!repoPromise) {
      repoPromise = getRepositoryAsync().then((r) => {
        if (!disposed) {
          repo = r;
          unsubscribe = r.subscribe(onTablesTouched);
        }
        return r;
      });
    }
    return repoPromise;
  }

  function publish(current: WindowState) {
    if (state !== current) return;
    rows.value = current.rows.slice();
    total.value = current.total;
    syncSettled(current);
  }

  function syncSettled(current: WindowState) {
    if (state !== current) return;
    settled.value = current.everLoaded && !error.value && !needsMore(current);
  }

  function resetFor(id: number | null) {
    state = id == null ? null : {
      folderId: id,
      rows: [],
      total: Number(folder.value?.total_emails ?? 0) || 0,
      loadedEnd: 0,
      everLoaded: false,
      needsFreshWindow: false,
      inflight: null,
      requestedEnd: FOLDER_WINDOW_PAGE_SIZE,
    };
    rows.value = [];
    total.value = state?.total ?? 0;
    error.value = null;
    loading.value = state != null;
    settled.value = false;
    missedWhilePaused = false;
    if (state) void ensureRange(0, FOLDER_WINDOW_PAGE_SIZE);
  }

  function needsMore(current: WindowState): boolean {
    if (current.needsFreshWindow || !current.everLoaded) return true;
    if (current.loadedEnd >= current.requestedEnd) return false;
    return current.loadedEnd < current.total;
  }

  /** Load pages until positions [0, end) are backed by rows or the folder ends. */
  async function ensureRange(_start: number, end: number): Promise<void> {
    const current = state;
    if (!current) return;
    current.requestedEnd = Math.max(current.requestedEnd, end, FOLDER_WINDOW_PAGE_SIZE);
    if (current.inflight) return current.inflight;
    if (!needsMore(current)) return;
    const accountId = accountIdFor();
    if (accountId == null) return;
    settled.value = false;
    current.inflight = (async () => {
      try {
        const r = await ensureRepo();
        if (!r || state !== current) return;
        const offset = current.needsFreshWindow ? 0 : current.loadedEnd;
        await loadPage(r, current, accountId, offset, FOLDER_WINDOW_PAGE_SIZE);
        if (state === current) error.value = null;
      } catch (err: any) {
        if (state === current) error.value = err?.message ?? String(err);
        console.warn('[kanban] folder window load failed', err);
      } finally {
        current.inflight = null;
        if (state === current) {
          loading.value = false;
          syncSettled(current);
          if (!error.value && needsMore(current)) void ensureRange(0, current.requestedEnd);
        }
      }
    })();
    return current.inflight;
  }

  async function loadPage(
    r: Repo,
    current: WindowState,
    accountId: number,
    offset: number,
    limit: number,
  ): Promise<void> {
    const view = viewFor(current, accountId);
    if (!current.needsFreshWindow) {
      // The cached query view's own total is authoritative for what the
      // cache can serve; folders.total_emails is a server counter that
      // can lag it (or run ahead of it) and is only a fallback.
      const [progress, cached] = await Promise.all([
        r.queryViewProgress(view),
        r.listMessagesForView({ ...view, offset, limit }) as Promise<MessageRow[]>,
      ]);
      if (state !== current) return;
      const viewTotal = Number.isFinite(progress?.total) ? Number(progress.total) : null;
      const knownTotal = viewTotal ?? (current.total > 0 ? current.total : null);
      const expected = knownTotal === null
        ? null
        : Math.max(0, Math.min(limit, knownTotal - offset));
      const materialized = cached.filter(Boolean);
      const complete = expected === null
        ? materialized.length === limit
        : materialized.length >= expected;
      if (complete) {
        if (knownTotal !== null) current.total = knownTotal;
        splice(current, offset, cached);
        current.loadedEnd = Math.max(current.loadedEnd, offset + Math.max(cached.length, expected ?? 0));
        current.everLoaded = true;
        trimToTotal(current);
        publish(current);
        if (progress?.stale) current.needsFreshWindow = true;
        return;
      }
    }
    const result = await r.ensureFolderWindow(accountId, current.folderId, {
      offset,
      limit,
      ...mailStore.jmapSortFor(sortProp.value),
    });
    if (state !== current) return;
    current.needsFreshWindow = false;
    current.everLoaded = true;
    if (Number.isFinite(result?.total)) current.total = Number(result.total);
    const fresh: MessageRow[] = await r.listMessagesForView({ ...view, offset, limit });
    if (state !== current) return;
    if (offset === 0) {
      current.rows = [];
      current.loadedEnd = 0;
    }
    splice(current, offset, fresh);
    const expected = current.total > 0
      ? Math.max(0, Math.min(limit, current.total - offset))
      : fresh.length;
    current.loadedEnd = Math.max(current.loadedEnd, offset + Math.max(fresh.length, expected));
    trimToTotal(current);
    publish(current);
  }

  function splice(current: WindowState, offset: number, page: MessageRow[]) {
    if (current.rows.length < offset + page.length) current.rows.length = offset + page.length;
    for (let i = 0; i < page.length; i += 1) current.rows[offset + i] = page[i];
  }

  function trimToTotal(current: WindowState) {
    if (current.rows.length > current.total) current.rows.length = current.total;
    current.loadedEnd = Math.min(current.loadedEnd, current.total);
  }

  /**
   * Re-read the loaded prefix from SQLite plus the view's total. Runs
   * after MESSAGES broadcasts; single-flighted so a burst collapses into
   * one repaint.
   */
  function refreshLoaded(): Promise<void> {
    if (refreshInflight) {
      refreshDirty = true;
      return refreshInflight;
    }
    refreshInflight = (async () => {
      try {
        do {
          refreshDirty = false;
          await refreshLoadedOnce();
        } while (refreshDirty);
      } catch (err) {
        console.warn('[kanban] folder window refresh failed', err);
      } finally {
        refreshInflight = null;
      }
    })();
    return refreshInflight;
  }

  async function refreshLoadedOnce(): Promise<void> {
    const current = state;
    if (!current) return;
    // A page read that was already in flight when the broadcast arrived
    // may resolve with the pre-commit snapshot; let it (and anything it
    // chains) land, then re-read.
    while (current.inflight) await current.inflight;
    if (state !== current || !current.everLoaded) return;
    const accountId = accountIdFor();
    if (accountId == null) return;
    const r = await ensureRepo();
    if (!r || state !== current) return;
    const view = viewFor(current, accountId);
    const progress = await r.queryViewProgress(view);
    if (state !== current) return;
    if (Number.isFinite(progress?.total)) current.total = Number(progress.total);
    const limit = Math.max(FOLDER_WINDOW_PAGE_SIZE, current.loadedEnd);
    const fresh: MessageRow[] = await r.listMessagesForView({ ...view, offset: 0, limit });
    if (state !== current) return;
    current.rows = fresh.slice();
    current.loadedEnd = Math.min(Math.max(current.loadedEnd, fresh.length), current.total, limit);
    trimToTotal(current);
    publish(current);
    if (progress?.stale) {
      current.needsFreshWindow = true;
      void ensureRange(0, current.requestedEnd);
    }
  }

  /** Server round trip for the first page: used after moves and seeding. */
  async function refreshFromServer(): Promise<void> {
    const current = state;
    if (!current) return;
    current.needsFreshWindow = true;
    loading.value = current.rows.length === 0;
    await ensureRange(0, current.requestedEnd);
  }

  function onTablesTouched(tables: string[]) {
    if (!state || !tables.includes(TABLE_FAMILIES.MESSAGES)) return;
    if (paused()) {
      missedWhilePaused = true;
      return;
    }
    void refreshLoaded();
  }

  watch(folderId, (id) => resetFor(id), { immediate: true });
  if (options.paused) {
    watch(options.paused, (isPaused) => {
      if (isPaused || !missedWhilePaused) return;
      missedWhilePaused = false;
      void refreshLoaded();
    });
  }
  // The folder row can arrive after the id (folders load asynchronously);
  // the sort and account come from it, so start over once it appears.
  watch(
    () => folder.value?.id ?? null,
    (id, prevId) => {
      if (id != null && prevId == null && state?.folderId === Number(id)) resetFor(Number(id));
    },
  );
  void ensureRepo();

  onBeforeUnmount(() => {
    disposed = true;
    unsubscribe?.();
    unsubscribe = null;
    state = null;
  });

  return {
    rows,
    total,
    loading,
    error,
    settled,
    folder,
    sortProp,
    ensureRange,
    refreshFromServer,
    refreshLoaded,
  };
}
