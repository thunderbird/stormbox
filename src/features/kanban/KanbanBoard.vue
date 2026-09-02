<script setup lang="ts">
import {
  computed, nextTick, onBeforeUnmount, onMounted, ref, watch,
} from 'vue';

import { useColumnResize } from '../../composables/useColumnResize';
import { useMailStore } from '../../stores/mail-store';
import type { FolderRow, MessageRow } from '../../types';
import KanbanColumn from './KanbanColumn.vue';
import {
  KANBAN_COLUMN_MAX_WIDTH,
  KANBAN_COLUMN_MIN_WIDTH,
  KANBAN_RESIZER_WIDTH,
  useKanbanStore,
  type ColumnSlot,
  type KanbanMovedDetail,
  type ResizableColumn,
} from './kanban-store';

/**
 * Three-column board that stands in for MessageList while the kanban
 * flag is on. Column one behaves like the plain message list: it shows
 * the folder chosen in the sidebar. Columns two and three show whichever
 * folders the user picked (persisted by JMAP mailbox id so a cache reset
 * does not lose them); a pick that is currently the sidebar folder is
 * shadowed rather than shown twice. In compact mode (a message is open)
 * the rightmost column is hidden and the board takes exactly the width
 * of the two that remain.
 *
 * Widths follow the shell's own panes: column one and column two
 * have draggable handles on their right edge (pointer or arrow keys),
 * column three fills whatever is left, and the board scrolls
 * horizontally once the three no longer fit.
 */
const props = withDefaults(defineProps<{
  compact?: boolean;
  quickFilterQuery?: string;
}>(), {
  compact: false,
  quickFilterQuery: '',
});

const mailStore = useMailStore();
const kanbanStore = useKanbanStore();

// --- Column widths ----------------------------------------------------

const WIDTHS_STORAGE_KEY = 'stormbox.kanban.columnWidths.v1';
type ResizePane = 'inbox' | 'second';
const PANE_COLUMN: Record<ResizePane, ResizableColumn> = { inbox: 0, second: 1 };

const boardEl = ref<HTMLElement | null>(null);

/** Reading-pane minimum the shell declares, read from its CSS variable. */
function messageViewReserve(): number {
  if (!props.compact || !boardEl.value) return 0;
  const raw = getComputedStyle(boardEl.value).getPropertyValue('--message-view-min-width');
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 240;
}

function maxColumnWidth(pane: ResizePane, widths: Readonly<Record<ResizePane, number>>): number {
  // With every column showing the board scrolls sideways, so only the
  // reading pane beside it (compact mode) bounds a column.
  if (!props.compact) return KANBAN_COLUMN_MAX_WIDTH;
  const left = boardEl.value?.getBoundingClientRect().left ?? 0;
  const available = Math.max(0, window.innerWidth - left) - messageViewReserve();
  const other = pane === 'inbox' ? widths.second : widths.inbox;
  return Math.min(KANBAN_COLUMN_MAX_WIDTH, available - other - 2 * KANBAN_RESIZER_WIDTH);
}

function paneOptions(pane: ResizePane) {
  const column = PANE_COLUMN[pane];
  return {
    get: () => kanbanStore.columnWidths[column],
    set: (width: number) => kanbanStore.setColumnWidth(column, width),
    min: () => KANBAN_COLUMN_MIN_WIDTH,
    max: (widths: Readonly<Record<ResizePane, number>>) => maxColumnWidth(pane, widths),
    storageKey: pane,
  };
}

const {
  activeResizePane,
  clampPane,
  onResizeHandleKeydown,
  startColumnResize,
} = useColumnResize<ResizePane>({
  panes: { inbox: paneOptions('inbox'), second: paneOptions('second') },
  storageKey: WIDTHS_STORAGE_KEY,
});

function clampColumnWidths() {
  clampPane('inbox');
  clampPane('second');
}

watch(() => props.compact, async () => {
  await nextTick();
  clampColumnWidths();
});
onMounted(() => {
  clampColumnWidths();
  window.addEventListener('resize', clampColumnWidths);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', clampColumnWidths);
  // Nothing shows the checked rows once the board is gone.
  kanbanStore.clearSelection();
});

const boardStyle = computed(() => ({
  '--kanban-col-1': `${kanbanStore.columnWidths[0]}px`,
  '--kanban-col-2': `${kanbanStore.columnWidths[1]}px`,
  '--kanban-col-min': `${KANBAN_COLUMN_MIN_WIDTH}px`,
  '--kanban-resizer': `${KANBAN_RESIZER_WIDTH}px`,
  width: props.compact ? `${kanbanStore.compactBoardWidth}px` : undefined,
}));

function resizerLabel(pane: ResizePane): string {
  return pane === 'inbox' ? 'Resize column 1' : 'Resize column 2';
}

// --- Columns ------------------------------------------------------------

/**
 * Folder shown in the primary column: the sidebar's selection. Opening a
 * row from another column also makes that row's folder the store's
 * current folder (MessageView acts on it), which must not drag the
 * primary column along, so those selections are recognised and skipped.
 */
const primaryFolderId = ref<number | null>(mailStore.currentFolderId ?? null);
let boardDrivenFolderId: number | null = null;
watch(() => mailStore.currentFolderId, (folderId) => {
  if (folderId == null) return;
  if (boardDrivenFolderId != null && Number(boardDrivenFolderId) === Number(folderId)) {
    boardDrivenFolderId = null;
    return;
  }
  primaryFolderId.value = Number(folderId);
});

function folderByRemoteId(remoteId: string | null): FolderRow | null {
  if (remoteId == null) return null;
  return (mailStore.primaryFolders as FolderRow[])
    .find((f) => f.remote_id === remoteId && Number(f.is_deleted ?? 0) !== 1) ?? null;
}

const columnFolderIds = computed<[number | null, number | null]>(() => {
  const [a, b] = kanbanStore.columnFolderRemoteIds;
  return [folderByRemoteId(a)?.id ?? null, folderByRemoteId(b)?.id ?? null];
});

function isShadowed(slot: ColumnSlot): boolean {
  const picked = columnFolderIds.value[slot - 1];
  return picked != null && primaryFolderId.value != null && Number(picked) === Number(primaryFolderId.value);
}

function excludeFor(slot: ColumnSlot): number[] {
  const other = columnFolderIds.value[slot === 1 ? 1 : 0];
  return [primaryFolderId.value, other].filter((id): id is number => id != null);
}

function onPickFolder(slot: ColumnSlot, folderId: number | null) {
  const folder = folderId == null ? null
    : (mailStore.primaryFolders as FolderRow[]).find((f) => Number(f.id) === Number(folderId));
  kanbanStore.setColumnFolder(slot, folder?.remote_id ?? null);
}

type ColumnHandle = { refreshFromServer: () => Promise<void> } | null;
const primaryColumn = ref<ColumnHandle>(null);
const secondColumn = ref<ColumnHandle>(null);
const thirdColumn = ref<ColumnHandle>(null);

/**
 * After a drop or bulk action, the columns showing the source and the
 * destination folder each need a server round trip: the store already
 * invalidated their caches, but only the open folder gets re-read
 * automatically.
 */
function onMoved(detail: KanbanMovedDetail) {
  const columns: Array<[number | null, ColumnHandle]> = [
    [primaryFolderId.value, primaryColumn.value],
    [columnFolderIds.value[0], secondColumn.value],
    [columnFolderIds.value[1], thirdColumn.value],
  ];
  const touched = [detail.sourceFolderId, detail.targetFolderId]
    .filter((id): id is number => id != null)
    .map(Number);
  for (const [folderId, handle] of columns) {
    if (folderId != null && touched.includes(Number(folderId))) {
      void handle?.refreshFromServer();
    }
  }
}

const OPEN_ATTEMPTS = 3;
let openToken = 0;

/**
 * Opening a row makes its folder the store's current folder first, so
 * MessageView, mark-as-read, archive/delete and j/k all act on the right
 * list. The row must be in `mailStore.messages` before `selectMessage`
 * (mark-as-read reads keywords from the list), so page its position in.
 */
async function openMessage(row: MessageRow, folderId: number) {
  const token = ++openToken;
  if (mailStore.currentFolderId !== folderId) {
    boardDrivenFolderId = folderId;
    mailStore.selectFolder(folderId);
    await nextTick();
    boardDrivenFolderId = null;
  } else if (mailStore.selectedMessageId === row.id) {
    mailStore.selectMessage(null);
    return;
  }
  const position = Math.max(0, Number((row as { view_position?: number }).view_position ?? 0));
  for (let attempt = 0; attempt < OPEN_ATTEMPTS && !rowInList(row.id); attempt += 1) {
    mailStore.setRequestedRange(folderId, position, position + 1);
    await mailStore.ensureLoaded(position, position + 1);
    if (token !== openToken || mailStore.currentFolderId !== folderId) return;
  }
  // A row that never paged in (moved or deleted underneath the click)
  // must not be selected: selectMessage would mark it read and load a
  // body the list cannot show.
  if (!rowInList(row.id)) return;
  mailStore.selectMessage(row.id);
}

function rowInList(id: number): boolean {
  return mailStore.messages.some((m) => m?.id === id);
}

defineExpose({ openMessage, columnFolderIds, primaryFolderId });
</script>

<template>
  <section
    ref="boardEl"
    class="kanban-board"
    :class="{ 'kanban-board--compact': compact }"
    :style="boardStyle"
    aria-label="Kanban board"
    data-testid="kanban-board"
  >
    <div class="kanban-board__scroller">
      <KanbanColumn
        ref="primaryColumn"
        class="kanban-board__column"
        :folder-id="primaryFolderId"
        fixed
        label="Column 1"
        :quick-filter-query="quickFilterQuery"
        @open="openMessage"
        @moved="onMoved"
      />
      <div
        class="column-resizer kanban-board__resizer"
        :class="{ 'is-active': activeResizePane === 'inbox' }"
        role="separator"
        :aria-label="resizerLabel('inbox')"
        aria-orientation="vertical"
        :aria-valuemin="KANBAN_COLUMN_MIN_WIDTH"
        :aria-valuemax="KANBAN_COLUMN_MAX_WIDTH"
        :aria-valuenow="kanbanStore.columnWidths[0]"
        tabindex="0"
        data-kanban-resizer="inbox"
        @pointerdown="startColumnResize('inbox', $event)"
        @keydown="onResizeHandleKeydown('inbox', $event)"
      />
      <KanbanColumn
        ref="secondColumn"
        class="kanban-board__column"
        :folder-id="columnFolderIds[0]"
        label="Column 2"
        :exclude-folder-ids="excludeFor(1)"
        :quick-filter-query="quickFilterQuery"
        :shadowed="isShadowed(1)"
        @update:folder-id="onPickFolder(1, $event)"
        @open="openMessage"
        @moved="onMoved"
      />
      <div
        class="column-resizer kanban-board__resizer"
        :class="{ 'is-active': activeResizePane === 'second' }"
        role="separator"
        :aria-label="resizerLabel('second')"
        aria-orientation="vertical"
        :aria-valuemin="KANBAN_COLUMN_MIN_WIDTH"
        :aria-valuemax="KANBAN_COLUMN_MAX_WIDTH"
        :aria-valuenow="kanbanStore.columnWidths[1]"
        tabindex="0"
        data-kanban-resizer="second"
        @pointerdown="startColumnResize('second', $event)"
        @keydown="onResizeHandleKeydown('second', $event)"
      />
      <KanbanColumn
        ref="thirdColumn"
        class="kanban-board__column kanban-board__column--last"
        :folder-id="columnFolderIds[1]"
        label="Column 3"
        :exclude-folder-ids="excludeFor(2)"
        :quick-filter-query="quickFilterQuery"
        :shadowed="isShadowed(2)"
        :paused="compact"
        @update:folder-id="onPickFolder(2, $event)"
        @open="openMessage"
        @moved="onMoved"
      />
    </div>
  </section>
</template>

<style scoped>
.kanban-board {
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: var(--bg);
}
/* Column one | handle | column two | handle | column three (fills). */
.kanban-board__scroller {
  display: grid;
  grid-template-columns:
    var(--kanban-col-1)
    var(--kanban-resizer)
    var(--kanban-col-2)
    var(--kanban-resizer)
    minmax(var(--kanban-col-min), 1fr);
  height: 100%;
  min-height: 0;
  overflow-x: auto;
  overflow-y: hidden;
}
.kanban-board__scroller > .kanban-board__column {
  min-height: 0;
  /* The handles draw the dividers. */
  border-right: 0;
}
.kanban-board__resizer {
  height: 100%;
}
/* A message is open: the third column goes, its handle now separates
 * column two from the reading pane. */
.kanban-board--compact .kanban-board__scroller {
  grid-template-columns:
    var(--kanban-col-1)
    var(--kanban-resizer)
    var(--kanban-col-2)
    var(--kanban-resizer);
  overflow-x: hidden;
}
.kanban-board--compact .kanban-board__column--last {
  display: none;
}
</style>
