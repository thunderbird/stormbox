<script setup lang="ts">
import {
  computed, onBeforeUnmount, onMounted, ref, watch,
} from 'vue';
import {
  Circle, Plus, RefreshCw, Star, X,
} from '@lucide/vue';

import { useMailStore } from '../stores/mail-store';
import { useBulkActionItems } from '../composables/useBulkActionItems';
import { useListSelection } from '../composables/useListSelection';
import {
  useMessageDragDrop,
  useMessageDropTarget,
} from '../composables/useMessageDragDrop';
import { useMessageListFilters } from '../composables/useMessageListFilters';
import { useMessageListHeader } from '../composables/useMessageListHeader';
import { useMessageListViewport } from '../composables/useMessageListViewport';
import { provideSenderAvatars } from '../composables/useSenderAvatars';
import {
  registerMessageListCommands,
  type MessageListNavigationCommand,
} from '../composables/useThunderbirdShortcuts';
import { folderShowsRecipients } from '../utils/message-row-presentation';
import { isScheduledMessage } from '../utils/scheduled-message';
import type { CachedRow } from '../stores/mail-store-types';
import type { FolderRow } from '../types';
import MessageBulkActions from './MessageBulkActions.vue';
import MessageListHeaderTitle from './MessageListHeaderTitle.vue';
import MessageListMoreMenu from './MessageListMoreMenu.vue';
import MessageListRow from './MessageListRow.vue';
import SelectableListHeader from './SelectableListHeader.vue';

const mailStore = useMailStore();

/**
 * One message list column. The primary column follows the folder the
 * folder list selects (`mailStore.currentFolderId`) and carries the
 * "add column" control; every other column picks its own folder from
 * the dropdown at the start of its header and can be removed. Apart
 * from that, every column is the same list: the folder's cached window,
 * the shared one-row header, selection, keyboard navigation and bulk
 * actions.
 */
const props = withDefaults(defineProps<{
  /** Folder to list; omitted means the primary column's folder. */
  folderId?: number | null;
  /** Stable per-column key that keeps row DOM ids unique across columns. */
  listId?: string;
  /** 1-based position, for the region label. */
  columnIndex?: number;
  primary?: boolean;
  quickFilterQuery?: string;
  canAddColumn?: boolean;
}>(), {
  folderId: undefined,
  listId: '',
  columnIndex: 1,
  primary: true,
  quickFilterQuery: '',
  canAddColumn: true,
});

const emit = defineEmits<{
  'add-column': [];
  'remove-column': [];
  'change-folder': [folderId: number];
}>();

// Failed avatar domains are remembered for this list's lifetime and
// shared by its rows; a remount (mail → contacts → mail) retries them.
provideSenderAvatars();

const folderId = computed<number | null>(() => (
  props.folderId === undefined ? mailStore.currentFolderId : props.folderId
));
const folder = computed<FolderRow | null>(() => mailStore.folderById(folderId.value));
const folderName = computed(() => folder.value?.name ?? 'Mail');
const regionLabel = computed(() => (
  folder.value
    ? `${folder.value.name} messages, column ${props.columnIndex}`
    : `Column ${props.columnIndex}, no folder chosen`
));
const rowDomIdPrefix = computed(() => (props.listId ? `msg-row-${props.listId}-` : 'msg-row-'));
const listboxId = computed(() => (props.listId ? `msg-listbox-${props.listId}` : 'msg-listbox'));

// Every column binds its folder's cached window; the store keeps the
// bound folders fresh on broadcasts and asks the sync layer to keep
// reconciling them on push. The release runs on change and unmount.
watch(folderId, (id, _previous, onCleanup) => {
  if (id == null) return;
  const release = mailStore.bindFolderView(id);
  onCleanup(release);
}, { immediate: true });

const view = computed(() => mailStore.folderView(folderId.value));
const messages = computed<CachedRow[]>(() => view.value.messages);
const isLoading = computed(() => view.value.isLoading);
const listSort = computed(() => mailStore.sortForFolder(folderId.value));

// One selection and one keyboard cursor exist across all columns, each
// attributed to a folder. This column sees them only while they belong
// to its folder, and claims them for its folder when it writes.
const EMPTY_SELECTION: Set<number> = new Set();
const selectedIds = computed<Set<number>>({
  get: () => (
    folderId.value != null && Number(mailStore.selectionFolderId) === Number(folderId.value)
      ? mailStore.selectedIds
      : EMPTY_SELECTION
  ),
  set: (ids) => {
    mailStore.setSelection(folderId.value, ids);
  },
});
const focusedMessageId = computed<number | null>({
  get: () => (
    folderId.value != null && Number(mailStore.focusedFolderId) === Number(folderId.value)
      ? mailStore.focusedMessageId
      : null
  ),
  set: (id) => {
    mailStore.setFocusedMessage(id, folderId.value);
  },
});
/** The open message when it was opened from this column's folder. */
const openMessageId = computed<number | null>(() => (
  folderId.value != null
  && mailStore.selectedMessageId != null
  && Number(mailStore.openMessageFolderId) === Number(folderId.value)
    ? mailStore.selectedMessageId
    : null
));

function openMessage(id: number | null) {
  mailStore.selectMessage(id, id == null ? undefined : folderId.value);
}

const {
  unreadOnly,
  flaggedOnly,
  quickFilterActive,
  denseLocalFilterActive,
  visibleMessages,
  selectAllTargetMessages,
  toggleUnreadFilter,
  toggleFlaggedFilter,
} = useMessageListFilters({
  messages,
  quickFilterQuery: computed(() => props.quickFilterQuery),
  openMessageId,
  selectedIds,
  closeOpenMessage: () => openMessage(null),
  expandFolderView: () => { void mailStore.expandFolderViewIntoMemory(folderId.value); },
});

// Virtualizer count is the FOLDER TOTAL, not loaded count. That way
// the scrollbar reflects reality from the very first round trip and
// the user can scroll into "unloaded" territory; placeholders render
// there until ensureLoaded() pulls the matching page. Dense filters
// use their materialized row count.
const folderRowCount = computed(() => Math.max(
  view.value.total ?? 0,
  messages.value.length,
));
const rowCount = computed(() => (denseLocalFilterActive.value ? visibleMessages.value.length : folderRowCount.value));

const {
  selectionCount,
  hasSelection,
  isSelected,
  handleCheckboxClick,
  handleKeyDown: rawHandleKeyDown,
  selectNone,
  setFocused,
} = useListSelection({
  rows: visibleMessages,
  total: computed(() => rowCount.value),
  selectedIds,
  // The keyboard cursor is the store's focusedMessageId, so the global
  // list commands and arrow navigation share one source of truth, and
  // the scroll-follow watcher below tracks it.
  focusedId: focusedMessageId,
});

const {
  draggedIds,
  startMessageDrag,
  endMessageDrag,
} = useMessageDragDrop();

// Rows dragged from another column land in this column's folder under
// the same rules as a drop on the folder list. A drag from this very
// folder is a no-op with no highlight.
const {
  dropState,
  onDragEnter: onColumnDragEnter,
  onDragOver: onColumnDragOver,
  onDragLeave: onColumnDragLeave,
  onDrop: onColumnDrop,
} = useMessageDropTarget({
  targetFolderId: () => folderId.value,
  transferMode: (target, source) => mailStore.transferModeForFolder(target, source),
  drop: (ids, sourceFolderId) => mailStore.moveMessages(ids, folderId.value!, { sourceFolderId }),
});

function handleKeyDown(event) {
  if (event.defaultPrevented) return;
  if ((event.metaKey || event.ctrlKey) && (event.key === 'a' || event.key === 'A')) {
    event.preventDefault();
    selectAllForCurrentFilter();
    return;
  }
  // Widget-scoped so the page keeps Home/End when the list is not focused.
  if ((event.key === 'Home' || event.key === 'End')
      && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    navigateMessageList(event.key === 'Home' ? 'first' : 'last');
    return;
  }
  const result = rawHandleKeyDown(event);
  // Plain Arrow nav also drives the preview pane (caller decides;
  // composable only knows about focus/selection, not body loads).
  if (result.consumed && result.focusChanged && result.focusedId != null
      && !event.shiftKey) {
    openMessage(result.focusedId);
  }
}

function navigateMessageList(command: MessageListNavigationCommand): void {
  switch (command) {
    case 'first':
      navigateToBoundary(1);
      return;
    case 'last':
      navigateToBoundary(-1);
      return;
    case 'next':
      navigateRelative(1, false);
      return;
    case 'nextUnread':
      navigateRelative(1, true);
      return;
    case 'previous':
      navigateRelative(-1, false);
      return;
    case 'previousUnread':
      navigateRelative(-1, true);
      return;
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

function navigateToBoundary(direction: 1 | -1): void {
  const rows = visibleMessages.value;
  for (
    let index = direction > 0 ? 0 : rows.length - 1;
    direction > 0 ? index < rows.length : index >= 0;
    index += direction
  ) {
    const id = rows[index]?.id;
    if (id == null) continue;
    openMessage(id);
    return;
  }
}

function navigateRelative(direction: 1 | -1, unreadOnly: boolean): void {
  const rows = visibleMessages.value;
  if (rows.length === 0) return;
  let index = focusedMessageId.value == null
    ? -1
    : rows.findIndex((row) => row?.id === focusedMessageId.value);
  if (index < 0) index = direction > 0 ? -1 : rows.length;
  for (
    let next = index + direction;
    direction > 0 ? next < rows.length : next >= 0;
    next += direction
  ) {
    const row = rows[next];
    if (row?.id == null) continue;
    if (unreadOnly && Number(row.is_seen) === 1) continue;
    openMessage(row.id);
    return;
  }
}

const msgListEl = ref<HTMLElement | null>(null);
const {
  scrollEl,
  listWidth,
  cardLayout,
  totalSize,
  virtualItems,
  onScroll,
} = useMessageListViewport({
  listEl: msgListEl,
  folderId,
  primary: computed(() => props.primary),
  visibleMessages,
  rowCount,
  denseFilterActive: denseLocalFilterActive,
  focusedMessageId,
});

// aria-activedescendant target for the scroller's listbox role. The
// cursor row is always scrolled into view, so its <li id> is rendered
// and the reference resolves; undefined clears it when nothing is
// focused.
const activeRowDomId = computed(() => (focusedMessageId.value == null
  ? undefined
  : `${rowDomIdPrefix.value}${focusedMessageId.value}`));

let unregisterMessageListCommands: (() => void) | null = null;

onMounted(() => {
  unregisterMessageListCommands = registerMessageListCommands({
    navigate: navigateMessageList,
    selectAll: selectAllForCurrentFilter,
    folderId: () => folderId.value,
    primary: () => props.primary,
  });
});

onBeforeUnmount(() => {
  unregisterMessageListCommands?.();
  unregisterMessageListCommands = null;
});

/**
 * Fastmail interaction model: a plain row-body click opens the
 * message, while modifier row-body clicks participate in the same
 * anchored multi-select model as checkbox clicks.
 */
function onRowClick(index, event) {
  if (event.shiftKey || event.ctrlKey || event.metaKey) {
    event.preventDefault();
    handleCheckboxClick(index, event, firstVisibleIndex());
    return;
  }

  const hadSelection = hasSelection.value;
  const id = setFocused(index);
  if (id == null) return;
  if (hadSelection) {
    selectNone();
  }
  if (!hadSelection && id === openMessageId.value) {
    openMessage(null);
    return;
  }
  openMessage(id);
}

function onCheckboxClick(index, event) {
  event.stopPropagation();
  handleCheckboxClick(index, event, firstVisibleIndex());
}

function firstVisibleIndex() {
  return virtualItems.value[0]?.index ?? 0;
}

function onRowDragStart(message, event) {
  startMessageDrag(event, {
    messageId: message?.id,
    selectedIds: selectedIds.value,
    sourceFolderId: folderId.value,
  });
}

function isDraggingMessage(messageId) {
  const id = Number(messageId);
  return Number.isFinite(id) && draggedIds.value.includes(id);
}

const listShowsRecipients = computed(() => folderShowsRecipients(folder.value));
// Archiving from Archive is a no-op; the row overlay and the bulk toolbar leave it out.
const isArchiveFolder = computed(() => folder.value?.role === 'archive');

const allLoadedSelected = computed(() => {
  const loadedIds = [];
  for (const row of selectAllTargetMessages.value) {
    if (row?.id != null) loadedIds.push(row.id);
  }
  if (loadedIds.length === 0) return false;
  for (const id of loadedIds) {
    if (!selectedIds.value.has(id)) return false;
  }
  return true;
});

function selectAllForCurrentFilter() {
  if (quickFilterActive.value) {
    const next = new Set<number>();
    for (const row of selectAllTargetMessages.value) {
      const id = Number(row?.id);
      if (Number.isFinite(id)) next.add(id);
    }
    selectedIds.value = next;
    return;
  }
  void mailStore.selectAllLoadedMessages({
    unreadOnly: unreadOnly.value,
    flaggedOnly: flaggedOnly.value,
    folderId: folderId.value,
  });
}

function toggleSelectAll() {
  if (hasSelection.value) {
    selectNone();
  } else {
    selectAllForCurrentFilter();
  }
}

/** Every store action names this column's folder as the rows' source. */
const source = computed(() => ({ sourceFolderId: folderId.value }));

// Bulk actions for the checkbox selection. They live here (not in the
// message view) because multi-selecting hides the reading pane
// entirely; the list header is the only surface that is always
// visible, including in single-column layouts.
const canWhitelistInJunk = computed(() => {
  const current = folder.value;
  return current?.role === 'junk'
    && mailStore.primaryFolders.some((candidate) => candidate.id === current.id);
});
const bulkWhitelisting = ref(false);

// Per-row hover actions (star, archive, delete). A pending scheduled
// send has neither archive nor plain delete, so its row gets none;
// anything else in the Scheduled folder is ordinary mail.
function rowHoverActions(message: { scheduled_undo_status?: string | null }) {
  return !isScheduledMessage(message);
}

async function toggleStar(message: { id: number; is_flagged?: number | null }) {
  await mailStore.markManyFlagged([message.id], Number(message.is_flagged) !== 1, source.value);
}

async function archiveOne(id: number) {
  try {
    await mailStore.archiveMessages([id], source.value);
  } catch (err) {
    console.warn('[message-list] archive failed', err?.message ?? err);
  }
}

async function deleteOne(id: number) {
  try {
    await mailStore.destroyMessages([id], source.value);
  } catch (err) {
    console.warn('[message-list] delete failed', err?.message ?? err);
  }
}

async function bulkMarkRead() {
  await mailStore.markManySeen([...selectedIds.value], true, source.value);
}

function isRowSelected(row: CachedRow): boolean {
  return row?.id != null && selectedIds.value.has(row.id);
}

const anySelectedStarred = computed(() => messages.value.some(
  (row) => isRowSelected(row) && Number(row?.is_flagged) === 1,
));

const anySelectedScheduled = computed(() => messages.value.some(
  (row) => isRowSelected(row) && isScheduledMessage(row),
));

async function bulkToggleStar() {
  await mailStore.toggleManyFlagged([...selectedIds.value], source.value);
}

async function bulkMarkUnread() {
  await mailStore.markManySeen([...selectedIds.value], false, source.value);
}

async function bulkArchive() {
  const ids = [...selectedIds.value];
  if (ids.length === 0) return;
  try {
    await mailStore.archiveMessages(ids, source.value);
  } catch (err) {
    console.warn('[message-list] bulk archive failed', err?.message ?? err);
  }
}

async function bulkJunk() {
  const ids = [...selectedIds.value];
  if (ids.length === 0) return;
  try {
    await mailStore.junkMessages(ids, source.value);
  } catch (err) {
    console.warn('[message-list] bulk junk failed', err?.message ?? err);
  }
}

async function bulkDelete() {
  const ids = [...selectedIds.value];
  if (ids.length === 0) return;
  try {
    await mailStore.destroyMessages(ids, source.value);
  } catch (err) {
    console.warn('[message-list] bulk delete failed', err?.message ?? err);
  }
}

/** Cancel the pending sends in the selection; other selected rows are left alone. */
async function bulkCancelSend() {
  const ids = messages.value
    .filter((row) => isRowSelected(row) && isScheduledMessage(row))
    .map((row) => row!.id);
  if (ids.length === 0) return;
  try {
    await mailStore.cancelScheduledSends(ids);
  } catch (err) {
    console.warn('[message-list] bulk cancel send failed', err?.message ?? err);
  }
}

async function bulkWhitelist() {
  const ids = [...selectedIds.value];
  if (ids.length === 0 || bulkWhitelisting.value) return;
  bulkWhitelisting.value = true;
  try {
    await mailStore.whitelistSenders(ids, source.value);
  } catch (err) {
    console.warn('[message-list] bulk whitelist failed', err?.message ?? err);
  } finally {
    bulkWhitelisting.value = false;
  }
}

// ----- header row: title, filters, count, controls and the More menu ----

const bulkActionItems = useBulkActionItems({
  folder,
  canWhitelist: canWhitelistInJunk,
  whitelisting: bulkWhitelisting,
  anyStarred: anySelectedStarred,
  anyScheduled: anySelectedScheduled,
  handlers: {
    archive: bulkArchive,
    junk: bulkJunk,
    delete: bulkDelete,
    cancelSend: bulkCancelSend,
    toggleStar: bulkToggleStar,
    markRead: bulkMarkRead,
    markUnread: bulkMarkUnread,
    whitelist: bulkWhitelist,
  },
});

function refresh() {
  void mailStore.refresh(folderId.value);
}

const {
  tier: headerTier,
  showsCount: headerShowsCount,
  filterLabels: headerFilterLabels,
  showsInlineControls,
  showsMoreMenu,
  moreMenuGroups,
  bulkActions,
  addColumnTitle,
  removeColumnTitle,
} = useMessageListHeader({
  listWidth,
  hasSelection,
  folderId,
  folderName,
  isLoading,
  primary: computed(() => props.primary),
  canAddColumn: computed(() => props.canAddColumn),
  columnIndex: computed(() => props.columnIndex),
  bulkActionItems,
  refresh,
  addColumn: () => emit('add-column'),
  removeColumn: () => emit('remove-column'),
});

const titleEl = ref<InstanceType<typeof MessageListHeaderTitle> | null>(null);
const moreMenuEl = ref<InstanceType<typeof MessageListMoreMenu> | null>(null);
const addColumnEl = ref<HTMLButtonElement | null>(null);
const removeColumnEl = ref<HTMLButtonElement | null>(null);

/** Focus the folder dropdown trigger (a newly added column starts here). */
function focusFolderPicker() {
  titleEl.value?.focusTrigger();
}

/**
 * Focus the column's own control: "+" on the primary column, "×" on
 * the others, or the More menu that holds it in a narrow column.
 */
function focusColumnControl() {
  const inline = props.primary ? addColumnEl.value : removeColumnEl.value;
  if (inline) {
    inline.focus();
    return;
  }
  moreMenuEl.value?.focusTrigger();
}

defineExpose({ focusColumnControl, focusFolderPicker });
</script>

<template>
  <section
    ref="msgListEl"
    class="msg-list"
    :class="{
      'msg-list--card': cardLayout,
      'msg-list--primary': primary,
      'is-drop-valid': dropState === 'move',
      'is-drop-copy': dropState === 'copy',
      'is-drop-invalid': dropState === 'invalid',
    }"
    role="region"
    :aria-label="regionLabel"
    :data-column-id="listId || undefined"
    @dragenter="onColumnDragEnter"
    @dragover="onColumnDragOver"
    @dragleave="onColumnDragLeave"
    @drop="onColumnDrop"
  >
    <SelectableListHeader
      class="msg-list__header"
      :data-header-tier="headerTier"
      :all-selected="allLoadedSelected"
      clear-class="msg-list__bulk-action msg-list__bulk-action--ghost"
      count-class="msg-list__count"
      :disabled="folderId == null"
      item-label="messages"
      select-all-class="msg-list__select-all"
      selection-actions-class="msg-list__bulk-actions"
      singular-item-label="message"
      :selected-count="selectionCount"
      :show-total-count="headerShowsCount"
      :total-count="rowCount"
      @clear-selection="selectNone"
      @toggle-all="toggleSelectAll"
    >
      <template #selection-actions>
        <MessageBulkActions :items="bulkActions.inline" />
      </template>
      <template #normal-actions>
        <MessageListHeaderTitle
          ref="titleEl"
          :primary="primary"
          :folder="folder"
          :folder-id="folderId"
          :column-index="columnIndex"
          :compact="!headerFilterLabels"
          @pick="emit('change-folder', $event)"
        />
        <div
          v-if="folderId != null"
          class="msg-list__filters"
          :class="{ 'msg-list__filters--icons': !headerFilterLabels }"
          role="group"
          aria-label="Message filters"
        >
          <button
            class="msg-list__filter"
            :class="{ 'is-active': unreadOnly }"
            type="button"
            :aria-pressed="unreadOnly"
            aria-label="Unread"
            title="Unread"
            @click="toggleUnreadFilter"
          >
            <Circle v-if="!headerFilterLabels" :size="10" :stroke-width="2" fill="currentColor" aria-hidden="true" />
            <template v-else>Unread</template>
          </button>
          <button
            class="msg-list__filter msg-list__filter--starred"
            :class="{ 'is-active': flaggedOnly }"
            type="button"
            :aria-pressed="flaggedOnly"
            aria-label="Starred"
            title="Starred"
            @click="toggleFlaggedFilter"
          >
            <Star v-if="!headerFilterLabels" :size="16" :stroke-width="1.75" aria-hidden="true" />
            <template v-else>Starred</template>
          </button>
        </div>
      </template>
      <template #trailing>
        <template v-if="showsInlineControls">
          <button
            v-if="folderId != null"
            class="msg-list__refresh"
            type="button"
            :aria-label="isLoading ? 'Refreshing' : 'Refresh'"
            :title="isLoading ? 'Refreshing…' : 'Refresh'"
            @click="refresh"
          >
            <RefreshCw :size="16" :stroke-width="1.75" aria-hidden="true" :class="{ 'is-spinning': isLoading }" />
          </button>
          <button
            v-if="primary"
            ref="addColumnEl"
            class="msg-list__column-control msg-list__add-column"
            type="button"
            :disabled="!canAddColumn"
            :title="addColumnTitle"
            :aria-label="addColumnTitle"
            @click="emit('add-column')"
          >
            <Plus :size="18" :stroke-width="1.75" aria-hidden="true" />
          </button>
          <button
            v-else
            ref="removeColumnEl"
            class="msg-list__column-control msg-list__remove-column"
            type="button"
            title="Remove column"
            :aria-label="removeColumnTitle"
            @click="emit('remove-column')"
          >
            <X :size="18" :stroke-width="1.75" aria-hidden="true" />
          </button>
        </template>
        <MessageListMoreMenu
          v-if="showsMoreMenu"
          ref="moreMenuEl"
          :groups="moreMenuGroups"
          :label="`More actions for column ${columnIndex}`"
        />
      </template>
    </SelectableListHeader>

    <div
      v-if="rowCount > 0"
      :id="listboxId"
      ref="scrollEl"
      class="msg-list__scroller"
      tabindex="0"
      role="listbox"
      aria-label="Messages"
      :aria-activedescendant="activeRowDomId"
      @scroll="onScroll"
      @keydown="handleKeyDown"
    >
      <div
        v-if="isLoading && messages.length === 0"
        class="msg-list__loader"
      >
        <RefreshCw :size="18" class="is-spinning" />
        <p>Loading {{ folderName }}…</p>
      </div>
      <ol class="msg-list__items" role="presentation" :style="{ height: totalSize + 'px' }">
        <template v-for="v in virtualItems" :key="v.key">
          <MessageListRow
            v-if="visibleMessages[v.index]"
            :message="visibleMessages[v.index]"
            :index="v.index"
            :start="v.start"
            :size="v.size"
            :dom-id-prefix="rowDomIdPrefix"
            :focused="openMessageId === visibleMessages[v.index].id"
            :selected="isSelected(visibleMessages[v.index].id)"
            :dragging="isDraggingMessage(visibleMessages[v.index].id)"
            :shows-recipients="listShowsRecipients"
            :sort="listSort"
            :hover-actions="rowHoverActions(visibleMessages[v.index])"
            :archive-action="!isArchiveFolder"
            @row-click="onRowClick(v.index, $event)"
            @checkbox-click="onCheckboxClick(v.index, $event)"
            @dragstart="onRowDragStart(visibleMessages[v.index], $event)"
            @dragend="endMessageDrag"
            @star="toggleStar(visibleMessages[v.index])"
            @archive="archiveOne(visibleMessages[v.index].id)"
            @delete="deleteOne(visibleMessages[v.index].id)"
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

    <div v-else-if="isLoading" class="msg-list__placeholder">
      <RefreshCw :size="18" class="is-spinning" />
      <p>Loading {{ folderName }}…</p>
    </div>
    <div v-else-if="quickFilterActive" class="msg-list__placeholder">
      <p>No messages matching "{{ props.quickFilterQuery.trim() }}" in {{ folderName }}.</p>
    </div>
    <div v-else-if="unreadOnly && flaggedOnly" class="msg-list__placeholder">
      <p>No unread starred messages in {{ folderName }}.</p>
    </div>
    <div v-else-if="unreadOnly" class="msg-list__placeholder">
      <p>No unread messages in {{ folderName }}.</p>
    </div>
    <div v-else-if="flaggedOnly" class="msg-list__placeholder">
      <p>No starred messages in {{ folderName }}.</p>
    </div>
    <div v-else-if="folderId != null" class="msg-list__placeholder">
      <p>{{ folderName }} is empty.</p>
    </div>
    <div v-else-if="primary" class="msg-list__placeholder">
      <p>Select a folder to view its messages.</p>
    </div>
    <div v-else class="msg-list__placeholder">
      <p>Choose a folder above to show its messages here.</p>
    </div>
  </section>
</template>

<style scoped>
.msg-list {
  display: grid;
  /* The header's nowrap row must never size the column: the track is
     the column's width and the header shrinks into it. */
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto 1fr;
  border-right: 1px solid var(--border);
  background: var(--panel);
  min-width: 0;
  min-height: 0;
  height: 100%;
}
/* Drop feedback for rows dragged from another column; same colours as
   the folder list's nodes. A drag from this column's own folder shows
   nothing. */
.msg-list.is-drop-valid {
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent);
}
.msg-list.is-drop-copy {
  box-shadow: inset 0 0 0 2px color-mix(in srgb, #188038 60%, transparent);
}
.msg-list.is-drop-invalid {
  box-shadow: inset 0 0 0 2px color-mix(in srgb, #d93025 55%, transparent);
}
/* One row at every width: the title at the start is the only flexible
   item, so the controls after it keep their place; what has no room
   moves into the More menu (see the tier constants in the script). */
.msg-list__header {
  min-width: 0;
  flex-wrap: nowrap;
}
.msg-list__header :deep(.selectable-list-header__normal-actions) {
  gap: 10px;
}
.msg-list__column-control {
  display: inline-grid;
  flex: 0 0 auto;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.msg-list__column-control:hover,
.msg-list__column-control:focus-visible {
  background: var(--rowHover);
  color: var(--text);
  outline: none;
}
.msg-list__column-control:disabled {
  cursor: default;
  opacity: 0.45;
}
.msg-list__column-control:disabled:hover {
  background: transparent;
  color: var(--muted);
}
.msg-list__filters {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 4px;
}
.msg-list__filters--icons .msg-list__filter {
  display: inline-grid;
  place-items: center;
  width: 34px;
  padding: 0;
}
.msg-list__filter {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  border-radius: 6px;
  min-height: 34px;
  padding: 0 12px;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  box-shadow: none;
}
.msg-list__filter:hover {
  background: var(--rowHover);
  color: var(--text);
  border-color: color-mix(in srgb, var(--border) 70%, var(--text));
}
.msg-list__filter.is-active {
  background: var(--accent);
  color: #fff;
  border-color: color-mix(in srgb, var(--accent) 80%, #000);
  box-shadow: 0 1px 2px color-mix(in srgb, #000 16%, transparent);
}
.msg-list__filter:disabled,
.msg-list__refresh:disabled {
  cursor: default;
  opacity: 0.5;
}
.msg-list__refresh {
  background: transparent;
  border: 0;
  color: var(--muted);
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  cursor: pointer;
  flex-shrink: 0;
}
.msg-list__refresh:hover {
  background: var(--rowHover);
  color: var(--text);
}
.is-spinning {
  animation: msg-spin 1.2s linear infinite;
}
@keyframes msg-spin {
  to { transform: rotate(360deg); }
}

.msg-list__scroller {
  position: relative;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
  contain: strict;
  will-change: scroll-position;
  outline: none;
}
.msg-list__loader {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: var(--panel);
  color: var(--muted);
  font-size: 13px;
}
.msg-list__loader p { margin: 0; }
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
</style>
