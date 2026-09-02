<script setup lang="ts">
import {
  computed, nextTick, onBeforeUnmount, ref, watch,
} from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import { RefreshCw } from '@lucide/vue';

import MessageBulkActions from '../../components/MessageBulkActions.vue';
import MessageListRow from '../../components/MessageListRow.vue';
import SelectableListHeader from '../../components/SelectableListHeader.vue';
import { useListSelection } from '../../composables/useListSelection';
import { useMessageDragDrop } from '../../composables/useMessageDragDrop';
import { provideSenderAvatars } from '../../composables/useSenderAvatars';
import {
  registerMessageListCommands,
  type MessageListNavigationCommand,
} from '../../composables/useThunderbirdShortcuts';
import { useMailStore } from '../../stores/mail-store';
import type { FolderRow, MessageRow } from '../../types';
import { folderPresentation } from '../../utils/folder-presentation';
import { folderShowsRecipients } from '../../utils/message-row-presentation';
import { messageMatchesQuickFilter, normalizeFilterText } from '../../utils/quick-filter';
import KanbanColumnPicker from './KanbanColumnPicker.vue';
import { useKanbanStore, type KanbanMovedDetail } from './kanban-store';
import { useFolderWindow, FOLDER_WINDOW_PAGE_SIZE, QUICK_FILTER_MAX_ROWS } from './useFolderWindow';

/**
 * One kanban column: a folder's messages rendered with the shared
 * MessageListRow, a header that is either the primary column's fixed
 * folder title or a folder picker, and a drop target that moves dragged
 * messages into this column's folder.
 *
 * Selection works as in MessageList (checkbox, Shift/Ctrl-click, Ctrl+A,
 * Space, Esc, Shift+Arrow) and the header swaps to the same bulk actions
 * while rows are checked. The board holds one selection at a time, keyed
 * by folder, so a drag or bulk action always has a single source folder.
 *
 * Keyboard: the scroller is the focusable listbox (aria-activedescendant
 * points at the cursor row); Arrow/Home/End move the cursor and open the
 * row, Enter re-opens it. The column that last had focus also owns the
 * app's f/b/n/p/Home/End shortcuts, so they keep working after focus
 * moves to the message pane.
 */
const props = withDefaults(defineProps<{
  folderId: number | null;
  /** The primary column: follows the sidebar selection, no picker. */
  fixed?: boolean;
  label: string;
  excludeFolderIds?: number[];
  quickFilterQuery?: string;
  /** Mounted but hidden: hold broadcast refreshes until shown again. */
  paused?: boolean;
  /**
   * The picked folder is the one the primary column shows right now, so
   * this column stays empty (with an explanation) until either changes.
   */
  shadowed?: boolean;
}>(), {
  fixed: false,
  excludeFolderIds: () => [],
  quickFilterQuery: '',
  paused: false,
  shadowed: false,
});

const emit = defineEmits<{
  (e: 'update:folderId', folderId: number | null): void;
  (e: 'open', message: MessageRow, folderId: number): void;
  /** Rows left `sourceFolderId` for `targetFolderId`; the board refreshes both columns. */
  (e: 'moved', detail: KanbanMovedDetail): void;
}>();

const mailStore = useMailStore();
const kanbanStore = useKanbanStore();
provideSenderAvatars();
const {
  draggedIds,
  sourceFolderId: dragSourceFolderId,
  isDragging,
  startMessageDrag,
  endMessageDrag,
  hasMessageDrag,
  readMessageDrop,
  setDropEffect,
} = useMessageDragDrop();

// A shadowed column loads nothing; its header still names the pick.
const folderIdRef = computed(() => (props.shadowed ? null : props.folderId));
const activeFolderId = () => folderIdRef.value;
const pausedRef = computed(() => props.paused);
const fw = useFolderWindow(folderIdRef, { paused: pausedRef });

const pickedFolder = computed<FolderRow | null>(() => (props.folderId == null
  ? null
  : (mailStore.folders as FolderRow[]).find((f) => Number(f.id) === Number(props.folderId)) ?? null));
const folderName = computed(() => fw.folder.value?.name ?? pickedFolder.value?.name ?? '');
const columnLabel = computed(() => folderName.value || props.label);
const folderIcon = computed(() => (fw.folder.value ? folderPresentation(fw.folder.value) : null));
const showsRecipients = computed(() => folderShowsRecipients(fw.folder.value));
const emptySlot = computed(() => props.folderId == null || props.shadowed);

const filterNeedle = computed(() => normalizeFilterText(props.quickFilterQuery));
const filterActive = computed(() => filterNeedle.value.length > 0);
const visibleRows = computed<Array<MessageRow | undefined>>(() => {
  if (!filterActive.value) return fw.rows.value;
  return fw.rows.value.filter((row) => row && messageMatchesQuickFilter(row, filterNeedle.value));
});
const rowCount = computed(() => (filterActive.value
  ? visibleRows.value.length
  : Math.max(fw.total.value, fw.rows.value.length)));
// Header pill: the folder's size, or the match count while filtering.
const countLabel = computed(() => (filterActive.value
  ? `${rowCount.value} matching`
  : `${fw.total.value} messages`));
const countText = computed(() => String(filterActive.value ? rowCount.value : fw.total.value));

const ROW_HEIGHT = 64;
const scrollEl = ref<HTMLElement | null>(null);
const virtualizer = useVirtualizer(computed(() => ({
  count: rowCount.value,
  getScrollElement: () => scrollEl.value,
  estimateSize: () => ROW_HEIGHT,
  overscan: 6,
  getItemKey: (i: number) => visibleRows.value[i]?.id ?? `_ph_${i}`,
})));
const totalSize = computed(() => virtualizer.value.getTotalSize());
const virtualItems = computed(() => virtualizer.value.getVirtualItems());

watch(virtualItems, (items) => {
  if (filterActive.value || !items.length || activeFolderId() == null) return;
  const last = items[items.length - 1].index;
  void fw.ensureRange(items[0].index, last + 1);
});

// The Quick Filter matches over loaded rows, so pull the folder in up to
// QUICK_FILTER_MAX_ROWS; beyond that the column says the scan was capped.
const filterScanEnd = computed(() => Math.min(
  Math.max(fw.total.value, FOLDER_WINDOW_PAGE_SIZE),
  QUICK_FILTER_MAX_ROWS,
));
const filterCapped = computed(() => filterActive.value && fw.total.value > QUICK_FILTER_MAX_ROWS);
watch([filterActive, filterScanEnd], ([active, end]) => {
  if (active && activeFolderId() != null) void fw.ensureRange(0, end);
}, { immediate: true });

function isDraggingMessage(messageId: number): boolean {
  return draggedIds.value.includes(Number(messageId));
}

// --- Selection ---------------------------------------------------------

const EMPTY_SELECTION = new Set<number>();
// The column's view of the board-wide selection: its own folder's ids,
// or nothing while another column holds it. Writing claims it.
const selectedIds = computed<Set<number>>({
  get: () => {
    const folderId = activeFolderId();
    if (folderId == null || Number(kanbanStore.selectionFolderId) !== Number(folderId)) {
      return EMPTY_SELECTION;
    }
    return kanbanStore.selectedIds as Set<number>;
  },
  set: (next) => {
    const folderId = activeFolderId();
    if (folderId == null) return;
    kanbanStore.setSelection(folderId, next);
  },
});
const cursorId = ref<number | null>(null);
const {
  focusedIndex: cursorIndex,
  hasSelection,
  selectionCount,
  isSelected,
  handleCheckboxClick,
  handleKeyDown: rawHandleKeyDown,
  selectAllLoaded,
  selectNone,
  retainOnly,
} = useListSelection<MessageRow, number>({
  rows: visibleRows,
  total: rowCount,
  selectedIds,
  focusedId: cursorId,
});
const allLoadedSelected = computed(() => {
  if (!hasSelection.value) return false;
  const loaded = visibleRows.value.filter((row): row is MessageRow => row != null);
  return loaded.length > 0 && loaded.every((row) => selectedIds.value.has(row.id));
});

/** Ctrl+A / header checkbox: every row, paging in up to the filter cap. */
async function selectAllRows() {
  const folderId = activeFolderId();
  if (folderId == null) return;
  if (!filterActive.value) {
    await fw.ensureRange(0, Math.min(Math.max(fw.total.value, 1), QUICK_FILTER_MAX_ROWS));
  }
  if (activeFolderId() === folderId) selectAllLoaded();
}

function toggleSelectAll() {
  if (hasSelection.value) {
    selectNone();
  } else {
    void selectAllRows();
  }
}

// Rows that left the folder leave the selection, but only once the
// window is settled: during a rebuild an absent row may just be unpaged.
watch([fw.rows, fw.settled], ([rows, settled]) => {
  if (!settled || !hasSelection.value) return;
  const live = new Set<number>();
  for (const row of rows) if (row) live.add(row.id);
  retainOnly(live);
});

// The selection belongs to the folder shown; swapping folders drops it.
watch(folderIdRef, (_next, prev) => {
  if (prev != null) kanbanStore.clearSelection(prev);
});

const canWhitelist = computed(() => {
  const folder = fw.folder.value;
  return folder?.role === 'junk'
    && (mailStore.primaryFolders as FolderRow[]).some((f) => Number(f.id) === Number(folder.id));
});
const whitelisting = ref(false);

function roleFolderId(role: string): number | null {
  const source = fw.folder.value;
  if (!source) return null;
  const match = (mailStore.folders as FolderRow[]).find(
    (f) => f.account_id === source.account_id && f.role === role,
  );
  return match?.id ?? null;
}

type BulkRun = (ids: number[], rows: MessageRow[], folderId: number) => Promise<unknown>;

/**
 * Run a store bulk action on the selection with this column's folder as
 * the source. Actions that move rows out report the destination so the
 * board refreshes both columns; the selection is pruned as rows leave.
 */
async function runBulk(run: BulkRun, movesTo: string | null | false) {
  const folderId = activeFolderId();
  const ids = [...selectedIds.value];
  if (folderId == null || ids.length === 0) return;
  const rows = fw.rows.value.filter((row): row is MessageRow => row != null && selectedIds.value.has(row.id));
  try {
    await run(ids, rows, folderId);
  } catch (err) {
    console.warn('[kanban] bulk action failed', err);
  } finally {
    if (movesTo !== false) {
      emit('moved', { ids, sourceFolderId: folderId, targetFolderId: movesTo == null ? null : roleFolderId(movesTo) });
    }
  }
}

function bulkArchive() {
  return runBulk((ids, _rows, sourceFolderId) => mailStore.archiveMessages(ids, { sourceFolderId }), 'archive');
}
function bulkJunk() {
  return runBulk((ids, rows, sourceFolderId) => mailStore.junkMessages(ids, { sourceFolderId, rows }), 'junk');
}
function bulkDelete() {
  return runBulk(
    (ids, _rows, sourceFolderId) => mailStore.destroyMessages(ids, { sourceFolderId }),
    fw.folder.value?.role === 'trash' ? null : 'trash',
  );
}
function bulkMarkRead() {
  return runBulk((ids, rows) => mailStore.markManySeen(ids, true, { rows }), false);
}
function bulkMarkUnread() {
  return runBulk((ids, rows) => mailStore.markManySeen(ids, false, { rows }), false);
}
async function bulkWhitelist() {
  if (whitelisting.value) return;
  whitelisting.value = true;
  try {
    await runBulk(
      (ids, rows, sourceFolderId) => mailStore.whitelistSenders(ids, { sourceFolderId, rows }),
      'inbox',
    );
  } finally {
    whitelisting.value = false;
  }
}

// --- Keyboard cursor -------------------------------------------------

const activeRowDomId = computed(() => (cursorId.value == null || cursorIndex.value < 0
  ? undefined
  : `msg-row-${cursorId.value}`));

// Same model as MessageList: the painted row is the one being read. The
// keyboard cursor is only an anchor for navigation and is never painted,
// so no column highlights a row while the message pane is closed.
function isFocusedRow(messageId: number): boolean {
  return mailStore.selectedMessageId === messageId && mailStore.currentFolderId === activeFolderId();
}

function openRow(row: MessageRow) {
  const folderId = activeFolderId();
  if (folderId == null) return;
  cursorId.value = row.id;
  emit('open', row, folderId);
}

function moveCursorTo(index: number) {
  if (activeFolderId() == null || index < 0 || index >= rowCount.value) return;
  virtualizer.value.scrollToIndex(index, { align: 'auto' });
  const row = visibleRows.value[index];
  if (row) {
    openRow(row);
    return;
  }
  // Not paged in yet: fetch it; the next keypress lands on it.
  void fw.ensureRange(index, index + 1);
}

function stepCursor(direction: 1 | -1, unreadOnly = false) {
  const rows = visibleRows.value;
  if (rows.length === 0) return;
  let index = cursorIndex.value;
  if (index < 0) index = direction > 0 ? -1 : rows.length;
  for (index += direction; index >= 0 && index < rows.length; index += direction) {
    const row = rows[index];
    if (!row) {
      if (!unreadOnly) moveCursorTo(index);
      return;
    }
    if (!unreadOnly || Number(row.is_seen) === 0) {
      moveCursorTo(index);
      return;
    }
  }
}

function cursorToBoundary(direction: 1 | -1) {
  const rows = visibleRows.value;
  for (
    let index = direction > 0 ? 0 : rows.length - 1;
    direction > 0 ? index < rows.length : index >= 0;
    index += direction
  ) {
    if (rows[index]) {
      moveCursorTo(index);
      return;
    }
  }
}

function navigate(command: MessageListNavigationCommand): void {
  switch (command) {
    case 'first':
      cursorToBoundary(1);
      return;
    case 'last':
      cursorToBoundary(-1);
      return;
    case 'next':
      stepCursor(1);
      return;
    case 'nextUnread':
      stepCursor(1, true);
      return;
    case 'previous':
      stepCursor(-1);
      return;
    case 'previousUnread':
      stepCursor(-1, true);
      return;
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

let unregisterCommands: (() => void) | null = null;
/** Make this column the target of the app's list shortcuts. */
function claimShortcuts() {
  unregisterCommands?.();
  unregisterCommands = registerMessageListCommands({
    navigate,
    selectAll: () => { void selectAllRows(); },
  });
}

function onScrollerFocus() {
  claimShortcuts();
  if (cursorIndex.value < 0) {
    const first = visibleRows.value.findIndex(Boolean);
    if (first >= 0) cursorId.value = visibleRows.value[first]!.id;
  }
}

function isSelectionKey(event: KeyboardEvent): boolean {
  if (event.key === 'Escape' || event.key === ' ' || event.key === 'Spacebar') return true;
  return event.shiftKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp');
}

function onKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.altKey) return;
  claimShortcuts();
  if (event.ctrlKey || event.metaKey) {
    if (event.key === 'a' || event.key === 'A') {
      event.preventDefault();
      void selectAllRows();
    }
    return;
  }
  // Esc clears, Space toggles the cursor row, Shift+Arrow extends the
  // range while moving the cursor without opening anything.
  if (isSelectionKey(event)) {
    const result = rawHandleKeyDown(event);
    if (result.consumed && result.focusChanged && cursorIndex.value >= 0) {
      virtualizer.value.scrollToIndex(cursorIndex.value, { align: 'auto' });
    }
    return;
  }
  switch (event.key) {
    case 'ArrowDown':
      stepCursor(1);
      break;
    case 'ArrowUp':
      stepCursor(-1);
      break;
    case 'Home':
      cursorToBoundary(1);
      break;
    case 'End':
      cursorToBoundary(-1);
      break;
    case 'Enter': {
      const row = cursorIndex.value >= 0 ? visibleRows.value[cursorIndex.value] : undefined;
      if (!row) return;
      openRow(row);
      break;
    }
    default:
      return;
  }
  event.preventDefault();
}

// Rows can leave the column (moved, filtered out, folder swapped); drop
// the cursor rather than pointing aria-activedescendant at nothing.
watch(visibleRows, async (rows) => {
  if (cursorId.value == null) return;
  await nextTick();
  if (!fw.loading.value && !rows.some((row) => row?.id === cursorId.value)) cursorId.value = null;
});

function firstVisibleIndex(): number {
  return virtualItems.value[0]?.index ?? 0;
}

// Same click model as MessageList: modifier clicks edit the selection,
// a plain click clears it and opens the row.
function onRowClick(index: number, event: MouseEvent) {
  claimShortcuts();
  const row = visibleRows.value[index];
  if (!row) return;
  if (event.shiftKey || event.ctrlKey || event.metaKey) {
    event.preventDefault();
    handleCheckboxClick(index, event, firstVisibleIndex());
    return;
  }
  if (hasSelection.value) selectNone();
  openRow(row);
}

function onCheckboxClick(index: number, event: MouseEvent) {
  event.stopPropagation();
  claimShortcuts();
  handleCheckboxClick(index, event, firstVisibleIndex());
}

// Dragging a checked row carries the whole selection (useListDragDrop
// resolves the id set); an unchecked row drags alone.
function onRowDragStart(row: MessageRow, event: DragEvent) {
  startMessageDrag(event, {
    messageId: row.id,
    selectedIds: selectedIds.value,
    sourceFolderId: activeFolderId(),
  });
}

const dragOver = ref(false);
const dropMode = computed(() => {
  const folderId = folderIdRef.value;
  if (!isDragging.value || !dragOver.value || folderId == null) return null;
  return mailStore.transferModeForFolder(folderId, dragSourceFolderId.value) ?? 'invalid';
});

function onDragEnter(event: DragEvent) {
  const folderId = activeFolderId();
  if (!hasMessageDrag(event) || folderId == null) return;
  dragOver.value = true;
  setDropEffect(event, mailStore.transferModeForFolder(folderId, dragSourceFolderId.value));
}

function onDragOver(event: DragEvent) {
  const folderId = activeFolderId();
  if (!hasMessageDrag(event) || folderId == null) return;
  dragOver.value = true;
  setDropEffect(event, mailStore.transferModeForFolder(folderId, dragSourceFolderId.value));
}

function onDragLeave(event: DragEvent) {
  const current = event.currentTarget as HTMLElement | null;
  if (current?.contains?.(event.relatedTarget as Node | null)) return;
  dragOver.value = false;
}

async function onDrop(event: DragEvent) {
  const targetFolderId = activeFolderId();
  if (!hasMessageDrag(event) || targetFolderId == null) return;
  event.preventDefault();
  const payload = readMessageDrop(event);
  const mode = mailStore.transferModeForFolder(targetFolderId, payload?.sourceFolderId);
  dragOver.value = false;
  try {
    if (payload?.ids?.length && mode) {
      const result = await mailStore.moveMessages(payload.ids, targetFolderId, {
        sourceFolderId: payload.sourceFolderId,
      });
      if (result.succeeded > 0) {
        emit('moved', { ids: payload.ids, sourceFolderId: payload.sourceFolderId, targetFolderId });
      }
    }
  } catch (err) {
    console.warn('[kanban] moveMessages failed', err);
  } finally {
    endMessageDrag();
  }
}

// A drag that ends anywhere (dropped elsewhere or cancelled) must not
// leave this column highlighted.
watch(isDragging, (dragging) => {
  if (!dragging) dragOver.value = false;
});

function onPick(folderId: number | null) {
  emit('update:folderId', folderId);
}

defineExpose({ refreshFromServer: () => fw.refreshFromServer() });

onBeforeUnmount(() => {
  dragOver.value = false;
  unregisterCommands?.();
  unregisterCommands = null;
  kanbanStore.clearSelection(activeFolderId());
});
</script>

<template>
  <section
    class="kanban-column"
    :class="{
      'is-drop-move': dropMode === 'move',
      'is-drop-copy': dropMode === 'copy',
      'is-drop-invalid': dropMode === 'invalid',
      'is-empty-slot': emptySlot,
    }"
    :aria-label="columnLabel"
    :data-kanban-column="label"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <SelectableListHeader
      class="kanban-column__header"
      :class="{ 'has-selection': hasSelection }"
      :all-selected="allLoadedSelected"
      :selectable="!emptySlot"
      item-label="messages"
      singular-item-label="message"
      :selected-count="selectionCount"
      :show-total-count="false"
      :total-count="rowCount"
      @clear-selection="selectNone"
      @toggle-all="toggleSelectAll"
    >
      <template #selection-actions>
        <MessageBulkActions
          :folder="fw.folder.value"
          :can-whitelist="canWhitelist"
          :whitelisting="whitelisting"
          @archive="bulkArchive"
          @junk="bulkJunk"
          @delete="bulkDelete"
          @mark-read="bulkMarkRead"
          @mark-unread="bulkMarkUnread"
          @whitelist="bulkWhitelist"
        />
      </template>
      <template #normal-actions>
        <template v-if="fixed">
          <span
            v-if="folderIcon"
            class="kanban-column__fixed-icon"
            :style="{ color: folderIcon.color }"
            aria-hidden="true"
            v-html="folderIcon.icon"
          />
          <h2 class="kanban-column__title">{{ folderName }}</h2>
        </template>
        <KanbanColumnPicker
          v-else
          :model-value="folderId"
          :exclude-folder-ids="excludeFolderIds"
          :label="label"
          @update:model-value="onPick"
        />
      </template>
      <template #trailing>
        <span
          v-if="!emptySlot && !hasSelection"
          class="kanban-column__count"
          :aria-label="countLabel"
        >{{ countText }}</span>
        <RefreshCw
          v-if="fw.loading.value"
          class="kanban-column__spinner is-spinning"
          :size="14"
          aria-hidden="true"
        />
      </template>
    </SelectableListHeader>
    <p
      v-if="filterCapped"
      class="kanban-column__hint"
      data-kanban-filter-hint
    >
      Matches from the first {{ QUICK_FILTER_MAX_ROWS }} of {{ fw.total.value }} messages.
    </p>

    <div v-if="shadowed" class="msg-list__placeholder kanban-column__empty" data-kanban-shadowed>
      <p>{{ folderName }} is open in the first column.</p>
    </div>
    <div v-else-if="folderId == null && fixed" class="msg-list__placeholder">
      <RefreshCw :size="18" class="is-spinning" aria-hidden="true" />
      <p>Loading…</p>
    </div>
    <div v-else-if="folderId == null" class="msg-list__placeholder kanban-column__empty">
      <p>Pick a folder to fill this column.</p>
    </div>
    <div
      v-else-if="rowCount > 0"
      ref="scrollEl"
      class="msg-list__scroller kanban-column__scroller"
      role="listbox"
      tabindex="0"
      :aria-label="`${folderName} messages`"
      :aria-activedescendant="activeRowDomId"
      @focus="onScrollerFocus"
      @keydown="onKeydown"
    >
      <ol class="msg-list__items" role="presentation" :style="{ height: totalSize + 'px' }">
        <template v-for="v in virtualItems" :key="v.key">
          <MessageListRow
            v-if="visibleRows[v.index]"
            :message="visibleRows[v.index]!"
            :index="v.index"
            :start="v.start"
            :size="v.size"
            :focused="isFocusedRow(visibleRows[v.index]!.id)"
            :selected="isSelected(visibleRows[v.index]!.id)"
            :dragging="isDraggingMessage(visibleRows[v.index]!.id)"
            :shows-recipients="showsRecipients"
            :sort="fw.sortProp.value"
            @row-click="onRowClick(v.index, $event)"
            @checkbox-click="onCheckboxClick(v.index, $event)"
            @dragstart="onRowDragStart(visibleRows[v.index]!, $event)"
            @dragend="endMessageDrag"
          />
          <li
            v-else
            :data-index="v.index"
            :data-placeholder="true"
            class="msg-list__item--placeholder"
            :style="{
              position: 'absolute',
              top: '0px',
              left: '0px',
              right: '0px',
              transform: `translateY(${v.start}px)`,
              height: v.size + 'px',
            }"
          >
            <div class="msg-list__skeleton">
              <div class="msg-list__skel-line msg-list__skel-line--from" />
              <div class="msg-list__skel-line msg-list__skel-line--subject" />
              <div class="msg-list__skel-line msg-list__skel-line--preview" />
            </div>
          </li>
        </template>
      </ol>
    </div>
    <div v-else-if="fw.loading.value" class="msg-list__placeholder">
      <RefreshCw :size="18" class="is-spinning" aria-hidden="true" />
      <p>Loading {{ folderName }}…</p>
    </div>
    <div v-else-if="fw.error.value" class="msg-list__placeholder">
      <p>Couldn't load {{ folderName }}.</p>
    </div>
    <div v-else-if="filterActive" class="msg-list__placeholder">
      <p>No messages matching "{{ quickFilterQuery.trim() }}" in {{ folderName }}.</p>
    </div>
    <div v-else class="msg-list__placeholder">
      <p>{{ folderName }} is empty.</p>
    </div>
  </section>
</template>


<style scoped>
.kanban-column {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  border-right: 1px solid var(--border);
  background: var(--panel);
  outline: 2px solid transparent;
  outline-offset: -2px;
  transition: outline-color 120ms ease, background-color 120ms ease;
}
.kanban-column.is-drop-move,
.kanban-column.is-drop-copy {
  outline-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 6%, var(--panel));
}
.kanban-column.is-drop-invalid {
  outline-color: var(--danger, #d93025);
}
/* The shared list header at the column's own height; its select-all box
   lines up with the rows' checkboxes. Narrow columns wrap the count. */
.kanban-column__header {
  --selectable-list-header-min-height: 44px;
  --selectable-list-header-padding: 5px 12px;
  flex-wrap: wrap;
  gap: 8px;
}
.kanban-column__header :deep(.selectable-list-header__selection-actions) {
  margin-inline-start: 0;
}
.kanban-column__fixed-icon {
  display: inline-block;
  flex-shrink: 0;
  width: 16px;
  height: 16px;
}
.kanban-column__fixed-icon :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}
.kanban-column__title {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kanban-column__count {
  flex-shrink: 0;
  min-width: 22px;
  padding: 1px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text) 8%, transparent);
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.kanban-column__spinner {
  flex-shrink: 0;
  color: var(--muted);
}
.kanban-column__hint {
  margin: 0;
  padding: 4px 12px;
  border-bottom: 1px solid var(--border-soft);
  color: var(--muted);
  font-size: 11px;
}
.kanban-column__scroller:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

/* Mirrors MessageList's scroller/list chrome so rows sit identically. */
.msg-list__scroller {
  position: relative;
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
  contain: strict;
  will-change: scroll-position;
  outline: none;
}
.msg-list__items {
  list-style: none;
  margin: 0;
  padding: 0;
  position: relative;
  width: 100%;
}
.msg-list__item--placeholder {
  border-bottom: 1px solid var(--border-soft);
  padding: 10px 14px 10px 22px;
}
.msg-list__skeleton {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  justify-content: center;
}
.msg-list__skel-line {
  height: 10px;
  border-radius: 4px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--text) 6%, transparent) 0%,
    color-mix(in srgb, var(--text) 12%, transparent) 50%,
    color-mix(in srgb, var(--text) 6%, transparent) 100%
  );
  background-size: 200% 100%;
  animation: skel-shimmer 1.4s linear infinite;
}
.msg-list__skel-line--from { width: 35%; }
.msg-list__skel-line--subject { width: 75%; }
.msg-list__skel-line--preview { width: 90%; height: 8px; }
@keyframes skel-shimmer {
  to { background-position: -200% 0; }
}
.msg-list__placeholder {
  margin: 0;
  padding: 32px 24px;
  color: var(--muted);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  text-align: center;
}
.msg-list__placeholder p { margin: 0; }
.is-spinning {
  animation: kanban-spin 1s linear infinite;
}
@keyframes kanban-spin {
  to { transform: rotate(360deg); }
}
</style>
