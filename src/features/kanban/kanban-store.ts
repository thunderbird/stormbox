/**
 * Feature flag + board preferences for the staff-only Kanban view.
 * Everything persists in localStorage per signed-in account so the flag
 * is a purely client-side switch: with `enabled` false nothing else in
 * Stormbox changes.
 */

import { defineStore } from 'pinia';
import {
  computed, ref, shallowRef, watch,
} from 'vue';

import { useAuthStore } from '../../stores/auth-store';

export const KANBAN_UNLOCK_CODE = 'kanban';
const STORAGE_PREFIX = 'stormbox.kanban';
const STORAGE_VERSION = 'v1';

export type ColumnSlot = 1 | 2;
export type SeedState = 'idle' | 'running' | 'done' | 'failed';

/** A column reporting rows that left its folder (drop or bulk action). */
export interface KanbanMovedDetail {
  ids: number[];
  sourceFolderId: number | null;
  /** Null when the rows were destroyed rather than moved. */
  targetFolderId: number | null;
}

/** Same limits as the shell's message list, which the columns are. */
export const KANBAN_COLUMN_MIN_WIDTH = 280;
export const KANBAN_COLUMN_MAX_WIDTH = 720;
export const KANBAN_DEFAULT_COLUMN_WIDTH = 360;
/** Matches the shell's --column-resizer-width. */
export const KANBAN_RESIZER_WIDTH = 6;
/** Index into `columnWidths`: column one and column two. */
export type ResizableColumn = 0 | 1;

interface PersistedKanbanState {
  unlocked: boolean;
  enabled: boolean;
  /** JMAP mailbox ids for columns 2 and 3; null = not chosen yet. */
  columns: [string | null, string | null];
}

const EMPTY_STATE: PersistedKanbanState = Object.freeze({
  unlocked: false,
  enabled: false,
  columns: [null, null],
}) as PersistedKanbanState;

const EMPTY_SELECTION: ReadonlySet<number> = new Set<number>();

export function isUnlockCode(text: string | null | undefined): boolean {
  return String(text ?? '').trim().toLowerCase() === KANBAN_UNLOCK_CODE;
}

export function kanbanStorageKey(accountId: number): string {
  return `${STORAGE_PREFIX}.${accountId}.${STORAGE_VERSION}`;
}

function readPersisted(accountId: number | null): PersistedKanbanState {
  if (accountId == null || typeof localStorage === 'undefined') return { ...EMPTY_STATE, columns: [null, null] };
  try {
    const raw = localStorage.getItem(kanbanStorageKey(accountId));
    if (!raw) return { ...EMPTY_STATE, columns: [null, null] };
    const parsed = JSON.parse(raw);
    const columns = Array.isArray(parsed?.columns) ? parsed.columns : [];
    return {
      unlocked: parsed?.unlocked === true,
      enabled: parsed?.enabled === true,
      columns: [
        typeof columns[0] === 'string' ? columns[0] : null,
        typeof columns[1] === 'string' ? columns[1] : null,
      ],
    };
  } catch {
    return { ...EMPTY_STATE, columns: [null, null] };
  }
}

function writePersisted(accountId: number, state: PersistedKanbanState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(kanbanStorageKey(accountId), JSON.stringify(state));
  } catch {
    // Storage full or blocked: the flag simply does not survive reload.
  }
}

export const useKanbanStore = defineStore('kanban', () => {
  const authStore = useAuthStore();
  const persisted = ref<PersistedKanbanState>(readPersisted(authStore.accountId));
  const seedState = ref<SeedState>('idle');
  const seedError = ref<string | null>(null);
  // Pixel widths of column one and column two; column three fills
  // the rest. Persisted by the board's useColumnResize (like the shell's
  // own panes), held here so the shell can size the list track around
  // the board while a message is open.
  const columnWidths = ref<[number, number]>([KANBAN_DEFAULT_COLUMN_WIDTH, KANBAN_DEFAULT_COLUMN_WIDTH]);
  // The board's checkbox selection: one folder at a time, so a drag or a
  // bulk action always has a single source. Never persisted.
  const selectionFolderId = ref<number | null>(null);
  const selectedIds = shallowRef<ReadonlySet<number>>(EMPTY_SELECTION);

  watch(
    () => authStore.accountId,
    (accountId) => {
      persisted.value = readPersisted(accountId);
      seedState.value = 'idle';
      seedError.value = null;
      clearSelection();
    },
  );

  const unlocked = computed(() => persisted.value.unlocked);
  // The board only ever renders for a signed-in staff session that
  // unlocked it. The staff gate is re-checked here, not only on the gear,
  // so a persisted unlock cannot outlive the staff claim (the same local
  // account reached through a non-staff login sees the plain list).
  const enabled = computed(() =>
    authStore.accountId != null
    && authStore.isStaff
    && persisted.value.unlocked
    && persisted.value.enabled);
  const columnFolderRemoteIds = computed(() => persisted.value.columns);
  /** Board width while a message is open: two columns plus their handles. */
  const compactBoardWidth = computed(() =>
    columnWidths.value[0] + columnWidths.value[1] + 2 * KANBAN_RESIZER_WIDTH);

  function setColumnWidth(column: ResizableColumn, width: number): void {
    if (!Number.isFinite(width)) return;
    const next: [number, number] = [...columnWidths.value];
    next[column] = Math.round(width);
    columnWidths.value = next;
  }

  const hasSelection = computed(() => selectedIds.value.size > 0);

  /** Replace the selection; it moves to `folderId` if another column held it. */
  function setSelection(folderId: number, ids: ReadonlySet<number>): void {
    if (ids.size === 0) {
      clearSelection(folderId);
      return;
    }
    selectionFolderId.value = Number(folderId);
    selectedIds.value = ids;
  }

  /** Clear the selection, or only when `folderId` is the folder that holds it. */
  function clearSelection(folderId?: number | null): void {
    if (folderId != null && Number(selectionFolderId.value) !== Number(folderId)) return;
    selectionFolderId.value = null;
    selectedIds.value = EMPTY_SELECTION;
  }

  function commit(next: PersistedKanbanState): void {
    persisted.value = next;
    if (authStore.accountId != null) writePersisted(authStore.accountId, next);
  }

  /**
   * Turn the feature on. Returns true only on the first unlock for this
   * account, which is the one moment that seeds folders and celebrates.
   */
  function unlock(): boolean {
    const first = !persisted.value.unlocked;
    commit({ ...persisted.value, unlocked: true, enabled: true });
    return first;
  }

  function setEnabled(value: boolean): void {
    if (!persisted.value.unlocked) return;
    commit({ ...persisted.value, enabled: value });
  }

  function setColumnFolder(slot: ColumnSlot, remoteId: string | null): void {
    const columns: [string | null, string | null] = [...persisted.value.columns];
    columns[slot - 1] = remoteId;
    commit({ ...persisted.value, columns });
  }

  /** Fill only the slots that are still empty; user picks always win. */
  function setDefaultColumns(remoteIds: [string | null, string | null]): void {
    const columns: [string | null, string | null] = [...persisted.value.columns];
    let changed = false;
    for (const slot of [0, 1] as const) {
      if (columns[slot] == null && remoteIds[slot] != null) {
        columns[slot] = remoteIds[slot];
        changed = true;
      }
    }
    if (changed) commit({ ...persisted.value, columns });
  }

  function setSeedState(state: SeedState, error: string | null = null): void {
    seedState.value = state;
    seedError.value = error;
  }

  // The unlock happens inside the settings dialog, which closes on
  // success; the fireworks and clip outlive it in `KanbanCelebration`,
  // which watches this counter. Never persisted.
  const celebrationRequests = ref(0);
  function requestCelebration(): void {
    celebrationRequests.value += 1;
  }

  function $reset(): void {
    persisted.value = readPersisted(authStore.accountId);
    seedState.value = 'idle';
    seedError.value = null;
    celebrationRequests.value = 0;
    columnWidths.value = [KANBAN_DEFAULT_COLUMN_WIDTH, KANBAN_DEFAULT_COLUMN_WIDTH];
    clearSelection();
  }

  return {
    unlocked,
    enabled,
    columnFolderRemoteIds,
    columnWidths,
    compactBoardWidth,
    selectionFolderId,
    selectedIds,
    hasSelection,
    setSelection,
    clearSelection,
    seedState,
    seedError,
    celebrationRequests,
    requestCelebration,
    isUnlockCode,
    unlock,
    setEnabled,
    setColumnFolder,
    setColumnWidth,
    setDefaultColumns,
    setSeedState,
    $reset,
  };
});
