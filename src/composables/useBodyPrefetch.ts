/**
 * Body prefetch and display-fetch queue, factored out of the
 * mail-store. Keeps the per-folder cache management and the body
 * loader on opposite sides of an explicit interface so each can be
 * read on its own.
 *
 * Owned state:
 *   - bodyQueue:    pending message ids to prefetch in batches
 *   - bodyQueued:   dedupe set so multiple enqueue calls for the
 *                   same id do not stack
 *   - bodyFetchToken: monotonically incrementing token used by the
 *                   display path so a fast selection change drops
 *                   the stale Email/get response
 *   - messageBody: Ref the UI binds to; written from
 *                   loadBodyForDisplay
 *
 * The composable does not subscribe to broadcasts or own selection
 * state. The store calls nextDisplayToken() right before triggering
 * a display load and discards the result if selection has moved.
 */

import { ref } from 'vue';
import type { Ref } from 'vue';

import type { Repository } from '../db/repository';
import type { CachedRow } from '../stores/mail-store-types';
import type { MessageBody } from '../types';

// Body prefetch batch size. Sized to the typical virtualizer
// visible window (~10-15 rows on a 1080p screen plus 8-row overscan,
// ~25) so one Email/get round trip covers everything the user can
// see after a scroll-pause. Per-message wall-clock for an Email/get
// with bodies is ~50 ms; 25 = ~1.5 s per batch, which is bounded by
// the single-concurrency drain so we never pile up parallel batches.
// The worker's body-fetch dedupe map keeps a user click during the
// batch from issuing a duplicate Email/get for the same id.
const BODY_PREFETCH_BATCH = 25;
const INITIAL_BODY_PREFETCH = 5;

export interface BodyPrefetchDeps {
  getRepo: () => Repository | null;
  getAccountId: () => number | null;
  isSelected: (messageId: number) => boolean;
}

export function useBodyPrefetch(deps: BodyPrefetchDeps) {
  const messageBody: Ref<MessageBody | null> = ref(null);

  let bodyFetchToken = 0;
  const bodyQueue: number[] = [];
  const bodyQueued = new Set<number>();
  let bodyPrefetchRunning = false;

  function nextDisplayToken(): number {
    bodyFetchToken += 1;
    return bodyFetchToken;
  }

  function enqueueBodyPrefetch(
    messageIds: Array<number | undefined | null>,
    { priority = false }: { priority?: boolean } = {},
  ) {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return;
    const deduped: number[] = [];
    for (const id of messageIds) {
      if (id == null) continue;
      const numeric = Number(id);
      if (!Number.isFinite(numeric)) continue;
      if (bodyQueued.has(numeric)) continue;
      bodyQueued.add(numeric);
      deduped.push(numeric);
    }
    if (deduped.length === 0) return;
    if (priority) bodyQueue.unshift(...deduped);
    else bodyQueue.push(...deduped);
    drainBodyPrefetchQueue();
  }

  /**
   * Prefetch bodies for the virtualizer's visible window. Called
   * whenever the user pauses scrolling. Skips sparse rows
   * (undefined slots) silently — the next ensureLoaded round trip
   * will fill them and the next scroll-pause will pick them up.
   */
  function enqueueVisibleBodyPrefetch(start: number, end: number, rows: CachedRow[]) {
    const repo = deps.getRepo();
    const accountId = deps.getAccountId();
    if (!repo || accountId == null) return;
    const lo = Math.max(0, Number(start ?? 0));
    const hi = Math.max(lo, Number(end ?? lo));
    if (rows.length === 0 || hi <= lo) return;

    const ids: number[] = [];
    const upper = Math.min(hi, rows.length);
    for (let i = lo; i < upper; i += 1) {
      const row = rows[i];
      if (!row || row.id == null) continue;
      if (row.body_fetched_at != null) continue;
      ids.push(Number(row.id));
    }
    if (ids.length === 0) return;
    enqueueBodyPrefetch(ids);
  }

  /**
   * Prime the first few rows of a freshly-loaded folder. Called by
   * the store from its first-page splice. The caller decides
   * whether the folder qualifies (Inbox, small folders, etc.); this
   * just enqueues.
   */
  function enqueueInitialPrefetch(rows: CachedRow[]) {
    const ids: number[] = [];
    const upper = Math.min(INITIAL_BODY_PREFETCH, rows.length);
    for (let i = 0; i < upper; i += 1) {
      const row = rows[i];
      if (!row || row.id == null) continue;
      ids.push(Number(row.id));
    }
    enqueueBodyPrefetch(ids);
  }

  async function drainBodyPrefetchQueue(): Promise<void> {
    if (bodyPrefetchRunning) return;
    const repo = deps.getRepo();
    const accountId = deps.getAccountId();
    if (!repo || accountId == null) return;
    bodyPrefetchRunning = true;
    try {
      while (bodyQueue.length > 0) {
        const currentRepo = deps.getRepo();
        const currentAccountId = deps.getAccountId();
        if (!currentRepo || currentAccountId == null) break;
        const batch = bodyQueue.splice(0, BODY_PREFETCH_BATCH);
        for (const id of batch) bodyQueued.delete(id);
        await currentRepo.ensureMessageBodies(currentAccountId, batch);
        // Yield so display-path RPCs can interleave between
        // prefetch batches.
        await Promise.resolve();
      }
    } catch (err) {
      console.warn('[body-prefetch] batch failed', err);
    } finally {
      bodyPrefetchRunning = false;
      // Re-arm only if the repo and account are still live; without
      // this guard a logout-after-rearm could fire ensureMessageBodies
      // against a torn-down worker handle.
      if (
        bodyQueue.length > 0
        && deps.getRepo() != null
        && deps.getAccountId() != null
      ) {
        queueMicrotask(() => drainBodyPrefetchQueue());
      }
    }
  }

  /**
   * Load the body for the reading pane via the repository (cache
   * read, then priority fetch on miss). Discards stale responses by
   * comparing token against the current value AND requiring the
   * caller's selection still match.
   */
  async function loadBodyForDisplay(messageId: number, token: number): Promise<void> {
    const repo = deps.getRepo();
    const accountId = deps.getAccountId();
    if (!repo || accountId == null) return;
    try {
      const body = await repo.getMessageBodyForDisplay(accountId, messageId);
      if (token === bodyFetchToken && deps.isSelected(messageId)) {
        messageBody.value = body;
      }
    } catch (err) {
      console.warn('[body-prefetch] getMessageBodyForDisplay failed', err);
    }
  }

  function clear() {
    bodyQueue.length = 0;
    bodyQueued.clear();
    messageBody.value = null;
    bodyFetchToken += 1;
  }

  return {
    messageBody,
    enqueueBodyPrefetch,
    enqueueVisibleBodyPrefetch,
    enqueueInitialPrefetch,
    loadBodyForDisplay,
    nextDisplayToken,
    clear,
  };
}
