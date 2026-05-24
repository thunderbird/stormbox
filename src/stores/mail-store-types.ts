/**
 * Types shared between mail-store and the helpers it delegates to.
 * Lives outside mail-store.ts so the helpers can import the type
 * without pulling the whole 1.7k-line module into their dependency
 * graph.
 */

import type { JmapViewSort } from '../constants/states';
import type { MessageRow } from '../types';

export type CachedRow = MessageRow | undefined;

export interface FolderCache {
  folderId: number;
  total: number;
  rows: CachedRow[];
  paintedRanges: Array<{ start: number; end: number }>;
  sortProp: JmapViewSort;
  scrollTop: number;
  pageInflight: Promise<void> | null;
  requestedRange: { start: number; end: number } | null;
  needsFreshWindow?: boolean;
  didInitialBodyPrefetch?: boolean;
  lastFailedRange?: { start: number; end: number } | null;
  /**
   * Set after a single drift-driven rebuild attempt during this
   * folder visit so a persistent server-vs-membership disagreement
   * cannot loop the canonical view through endless resets. Cleared
   * by invalidateFolderStateForFreshWindow (refresh button, move to
   * dest) so a manual recovery path can try again.
   */
  driftRebuildAttempted?: boolean;
  driftCheckInflight?: Promise<void> | null;
  /**
   * Single-flight guard for expandFolderViewIntoMemory. The Unread
   * and quick filters need every cached row in the canonical view —
   * not just the positional window the virtualizer happens to have
   * pulled — so the filter can match across the whole folder. Two
   * parallel filter toggles on the same folder should coalesce into
   * one SQLite read and one reactive assignment.
   */
  expandInflight?: Promise<void> | null;
}
