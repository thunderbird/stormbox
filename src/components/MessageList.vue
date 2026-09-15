<script setup lang="ts">
import {
  computed, nextTick, onBeforeUnmount, onMounted, ref, watch,
} from 'vue';
import type { Ref } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import { Plus, RefreshCw, X } from '@lucide/vue';

import { useMailStore } from '../stores/mail-store';
import { MAX_MESSAGE_COLUMNS } from '../stores/message-columns-store';
import { useListSelection } from '../composables/useListSelection';
import {
  useMessageDragDrop,
  useMessageDropTarget,
} from '../composables/useMessageDragDrop';
import { provideSenderAvatars } from '../composables/useSenderAvatars';
import {
  registerMessageListCommands,
  type MessageListNavigationCommand,
} from '../composables/useThunderbirdShortcuts';
import { closeContainingDropdown } from '../utils/dropdown';
import { flattenFolderTree, folderPresentation } from '../utils/folder-presentation';
import { folderShowsRecipients } from '../utils/message-row-presentation';
import { messageMatchesQuickFilter, normalizeFilterText } from '../utils/quick-filter';
import { isScheduledMessage } from '../utils/scheduled-message';
import type { CachedRow } from '../stores/mail-store-types';
import type { FolderRow } from '../types';
import AppDropdown from './AppDropdown.vue';
import MessageBulkActions from './MessageBulkActions.vue';
import MessageListRow from './MessageListRow.vue';
import SelectableListHeader from './SelectableListHeader.vue';

const mailStore = useMailStore();

/**
 * One message list column. The primary column follows the folder the
 * folder list selects (`mailStore.currentFolderId`) and carries the
 * "add column" control; every other column picks its own folder from
 * the dropdown in its title row and can be removed. Apart from that
 * title row, every column is the same list: the folder's cached window,
 * the shared header, selection, keyboard navigation and bulk actions.
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
const folderIcon = computed(() => (folder.value ? folderPresentation(folder.value).icon : ''));
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

const unreadOnly = ref(false);
const flaggedOnly = ref(false);
const quickFilterNeedle = computed(() => normalizeFilterText(props.quickFilterQuery));
const quickFilterActive = computed(() => quickFilterNeedle.value.length > 0);
const denseLocalFilterActive = computed(() => (
  unreadOnly.value || flaggedOnly.value || quickFilterActive.value
));
// Per R-2.8 (specs/001-mvp-scope/spec.md) and the project constitution,
// the folder's canonical message set is the mailbox-window query view
// (query_view_items + messages) exposed through the folder view. All,
// Unread and Starred derive from that single source; Unread and Starred
// are dense local filters over it (they combine as AND) and must never
// read from a broader projection like folder_messages — that would let
// a filter count exceed the All count and violate the user-facing
// invariant.
const visibleMessages = computed(() => {
  if (!denseLocalFilterActive.value) return messages.value;
  return messages.value.filter((row) => messagePassesActiveFilters(row, { includeSticky: true }));
});
const selectAllTargetMessages = computed(() => {
  if (!denseLocalFilterActive.value) return messages.value;
  return messages.value.filter((row) => messagePassesActiveFilters(row, { includeSticky: false }));
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

const CARD_LAYOUT_WIDTH = 360;
const ROW_HEIGHT = 64;
const CARD_ROW_HEIGHT = 112;
const msgListEl = ref<HTMLElement | null>(null);
const scrollEl = ref(null);
const listWidth = ref(0);
const cardLayout = computed(() => listWidth.value > 0 && listWidth.value < CARD_LAYOUT_WIDTH);
let listResizeObserver: ResizeObserver | null = null;

const virtualizer = useVirtualizer(
  computed(() => ({
    count: rowCount.value,
    getScrollElement: () => scrollEl.value,
    estimateSize: () => (cardLayout.value ? CARD_ROW_HEIGHT : ROW_HEIGHT),
    overscan: 8,
    getItemKey: (i) => visibleMessages.value[i]?.id ?? `_ph_${i}`,
  })),
);

const totalSize = computed(() => virtualizer.value.getTotalSize());
const virtualItems = computed(() => virtualizer.value.getVirtualItems());

// Throttle the scroll-driven fetch. 100ms leading-edge guard so a
// fast scroll doesn't fire 50 round trips, PLUS a trailing-edge
// fire so the final visible range after the user releases the
// scrollbar always gets a load.
//
// The trailing edge is what makes the throttle correct rather than
// just leaky. Without it, when the user drags a long distance and
// releases inside the 100ms window after the last fired load, the
// final visible range never gets requested - the watcher only fires
// when virtualItems changes, and a stationary scrollbar produces no
// further changes. mail-store's .finally re-pump cannot save us
// either: it requires a load to actually be inflight when the
// release happens, and with a fast cache that load may complete
// before the user has moved at all.
const THROTTLE_MS = 100;
let lastPrefetch = 0;
let trailingTimer: ReturnType<typeof setTimeout> | null = null;
let unregisterMessageListCommands: (() => void) | null = null;

function fireLoad(first: number, last: number) {
  const id = folderId.value;
  if (id == null) return;
  lastPrefetch = performance.now();
  mailStore.ensureLoaded(first, last + 1, id);
  // Window-driven body prefetch. Safe to call before metadata has
  // landed: it skips undefined slots and the next throttled tick
  // after ensureLoaded fills them will pick them up. Click-time
  // fetches that collide with this background work are deduped in
  // the JMAP backend's in-flight body map.
  mailStore.enqueueVisibleBodyPrefetch(first, last + 1, id);
}

watch(virtualItems, (items) => {
  if (denseLocalFilterActive.value) return;
  if (!items.length) return;
  const id = folderId.value;
  if (id == null) return;
  const first = items[0].index;
  const last = items[items.length - 1].index;
  // Always update the requested range so the inflight-page chain in
  // mail-store can re-pump against the latest visible window.
  mailStore.setRequestedRange(id, first, last + 1);

  const now = performance.now();
  const sinceLast = now - lastPrefetch;

  if (sinceLast >= THROTTLE_MS) {
    if (trailingTimer != null) {
      clearTimeout(trailingTimer);
      trailingTimer = null;
    }
    fireLoad(first, last);
    return;
  }

  // Throttled. Schedule (or refresh) a trailing-edge fire so the
  // final visible range always gets a load even if the user stops
  // scrolling mid-window.
  if (trailingTimer != null) clearTimeout(trailingTimer);
  trailingTimer = setTimeout(() => {
    trailingTimer = null;
    if (folderId.value == null) return;
    const latestItems = virtualizer.value.getVirtualItems();
    if (!latestItems.length) return;
    fireLoad(latestItems[0].index, latestItems[latestItems.length - 1].index);
  }, THROTTLE_MS - sinceLast + 10);
});

watch(
  () => props.quickFilterQuery,
  (next, prev) => {
    if (next !== prev && openMessageId.value != null) {
      openMessage(null);
    }
    // The quick filter is a dense local filter over the entire folder.
    // Pull the full cached canonical view into the buffer so the
    // From / To / Subject match can fire across every cached row,
    // not just the positional window the virtualizer has loaded.
    const becameActive = normalizeFilterText(next).length > 0
      && normalizeFilterText(prev).length === 0;
    if (becameActive) {
      void mailStore.expandFolderViewIntoMemory(folderId.value);
    }
  },
);

// Persist scroll position per folder. rAF-throttled so we don't write
// on every pixel.
let scrollWriteScheduled = false;
function onScroll() {
  if (scrollWriteScheduled) return;
  scrollWriteScheduled = true;
  requestAnimationFrame(() => {
    scrollWriteScheduled = false;
    const id = folderId.value;
    if (id != null && scrollEl.value) {
      mailStore.setScrollTop(id, scrollEl.value.scrollTop);
    }
  });
}

// Keep the virtualized viewport following the keyboard cursor. Every
// path that moves the cursor — Arrow and Shift+Arrow (useListSelection),
// the registered list commands (F/B/N/P/Home/End), a row click, and the
// neighbour that becomes current
// after a delete/archive — funnels through mailStore.focusedMessageId.
// Because the list is virtualized, an off-screen cursor row isn't even
// in the DOM to scroll to, so watching this single source of truth and
// driving the virtualizer is the general fix rather than patching each
// call site. Tracking the cursor (not the previewed selectedMessageId)
// is what lets a Shift+Arrow range extension scroll the viewport too.
// aria-activedescendant target for the scroller's listbox role. The
// cursor row is always scrolled into view, so its <li id> is rendered
// and the reference resolves; undefined clears it when nothing is
// focused.
const activeRowDomId = computed(() => (focusedMessageId.value == null
  ? undefined
  : `${rowDomIdPrefix.value}${focusedMessageId.value}`));

function scrollCursorIntoView(messageId: number) {
  if (!scrollEl.value) return;
  const index = visibleMessages.value.findIndex((row) => row?.id === messageId);
  if (index < 0) return;
  // align: 'auto' is a no-op when the row is already fully visible, so a
  // plain row click never yanks the list; it scrolls only the minimum
  // needed when keyboard nav steps the cursor past a viewport edge.
  virtualizer.value.scrollToIndex(index, { align: 'auto' });
}

watch(
  focusedMessageId,
  async (messageId) => {
    if (messageId == null) return;
    // Let visibleMessages / virtualizer count settle (e.g. when a
    // delete mutates the row array in the same tick as the cursor
    // move) before resolving the target index.
    await nextTick();
    if (focusedMessageId.value !== messageId) return;
    scrollCursorIntoView(messageId);
  },
);

// A folder change restores that folder's remembered scroll position;
// re-picking the primary column's folder in the folder list scrolls
// it back to the top.
watch(
  [folderId, () => mailStore.folderPickCount],
  async ([id, pickCount], [previousId, previousPickCount]) => {
    virtualizer.value.measure();
    if (id == null) return;
    if (id === previousId && pickCount !== previousPickCount) {
      if (!props.primary) return;
      mailStore.setScrollTop(id, 0);
      if (scrollEl.value) scrollEl.value.scrollTop = 0;
      return;
    }
    // If a dense filter is already active when we switch folders,
    // pull the new folder's full canonical view into the buffer so
    // the filter applies across every cached row, not just the
    // positional window the virtualizer will pull on first paint.
    if (denseLocalFilterActive.value) {
      void mailStore.expandFolderViewIntoMemory(id);
    }
    // Wait for the new folder's rows to bind before restoring scroll;
    // the scroller's scrollHeight needs to reflect the new totalSize
    // so the assignment doesn't get clamped.
    await nextTick();
    if (scrollEl.value) {
      scrollEl.value.scrollTop = mailStore.getScrollTop(id);
    }
  },
  { immediate: true },
);

onMounted(() => {
  unregisterMessageListCommands = registerMessageListCommands({
    navigate: navigateMessageList,
    selectAll: selectAllForCurrentFilter,
    folderId: () => folderId.value,
    primary: () => props.primary,
  });
  if (msgListEl.value) {
    listWidth.value = msgListEl.value.clientWidth;
    if (typeof ResizeObserver === 'function') {
      listResizeObserver = new ResizeObserver(([entry]) => {
        listWidth.value = entry.contentRect.width;
      });
      listResizeObserver.observe(msgListEl.value);
    }
  }
  virtualizer.value.measure();
});

onBeforeUnmount(() => {
  unregisterMessageListCommands?.();
  unregisterMessageListCommands = null;
  if (trailingTimer != null) {
    clearTimeout(trailingTimer);
    trailingTimer = null;
  }
  listResizeObserver?.disconnect();
  listResizeObserver = null;
});

watch(cardLayout, async () => {
  await nextTick();
  virtualizer.value.measure();
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

function toggleDenseFilter(filter: Ref<boolean>) {
  openMessage(null);
  filter.value = !filter.value;
  if (filter.value) {
    // Dense filters cover every cached row in the folder, not just the
    // positional window. Pull the full canonical view into the
    // buffer so the filter count and rendered rows reflect the
    // whole folder. This is a local SQLite read, never a JMAP call.
    void mailStore.expandFolderViewIntoMemory(folderId.value);
  }
}

function toggleUnreadFilter() {
  toggleDenseFilter(unreadOnly);
}

function toggleFlaggedFilter() {
  toggleDenseFilter(flaggedOnly);
}

function messagePassesActiveFilters(row, { includeSticky = true } = {}) {
  if (row?.id == null) return false;
  if (
    includeSticky
    && (row.id === openMessageId.value || selectedIds.value.has(row.id))
  ) {
    return true;
  }
  if (unreadOnly.value && Number(row.is_seen) !== 0) return false;
  if (flaggedOnly.value && Number(row.is_flagged) !== 1) return false;
  if (quickFilterActive.value && !messageMatchesQuickFilter(row, quickFilterNeedle.value)) return false;
  return true;
}

// ----- column title row: folder picker and column controls -------------

const addColumnTitle = computed(() => (
  props.canAddColumn
    ? 'Add a message list column'
    : `Up to ${MAX_MESSAGE_COLUMNS} columns can be shown`
));

interface FolderOption {
  folder: FolderRow;
  depth: number;
  icon: string;
  color: string;
}
interface FolderOptionGroup {
  key: string;
  label: string | null;
  options: FolderOption[];
}

function optionsFor(rows: FolderRow[]): FolderOption[] {
  return flattenFolderTree(rows.filter((row) => Number(row.is_deleted) !== 1))
    .map(({ folder: row, depth }) => ({ folder: row, depth, ...folderPresentation(row) }));
}

// The folders the folder list shows (system folders plus subscribed
// ones, then one group per shared account), in structural order with
// the folder list's icons.
const folderOptionGroups = computed<FolderOptionGroup[]>(() => {
  const groups: FolderOptionGroup[] = [{
    key: 'primary',
    label: null,
    options: optionsFor(mailStore.sidebarPrimaryFolders),
  }];
  for (const group of mailStore.sharedFolderGroups) {
    const options = optionsFor(group.folders);
    if (options.length === 0) continue;
    groups.push({
      key: `account-${group.account.id}`,
      label: group.account.display_name ?? group.account.primary_email ?? 'Shared',
      options,
    });
  }
  return groups;
});

const folderTriggerEl = ref<HTMLElement | null>(null);
const folderMenuEl = ref<HTMLElement | null>(null);
const addColumnEl = ref<HTMLButtonElement | null>(null);
const removeColumnEl = ref<HTMLButtonElement | null>(null);

function pickFolder(id: number, event: Event) {
  closeContainingDropdown(event);
  if (id !== folderId.value) emit('change-folder', id);
  folderTriggerEl.value?.focus();
}

function folderOptionButtons(): HTMLButtonElement[] {
  return Array.from(folderMenuEl.value?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
}

// The listbox opens on the chosen folder (or its first option) and the
// arrow keys move between options; Escape and outside clicks are the
// dropdown widget's.
function onFolderMenuToggle(event: Event) {
  const details = event.currentTarget as HTMLDetailsElement | null;
  if (!details?.open) return;
  void nextTick(() => {
    const buttons = folderOptionButtons();
    const selected = buttons.find((button) => button.getAttribute('aria-selected') === 'true');
    (selected ?? buttons[0])?.focus();
  });
}

function onFolderMenuKeydown(event: KeyboardEvent) {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const buttons = folderOptionButtons();
  if (buttons.length === 0) return;
  event.preventDefault();
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  let next: number;
  switch (event.key) {
    case 'ArrowDown':
      next = current < 0 ? 0 : Math.min(buttons.length - 1, current + 1);
      break;
    case 'ArrowUp':
      next = current < 0 ? buttons.length - 1 : Math.max(0, current - 1);
      break;
    case 'Home':
      next = 0;
      break;
    default:
      next = buttons.length - 1;
  }
  buttons[next]?.focus();
}

/** Focus the folder dropdown trigger (a newly added column starts here). */
function focusFolderPicker() {
  folderTriggerEl.value?.focus();
}

/** Focus the column's own control: "+" on the primary column, "×" on the others. */
function focusColumnControl() {
  (props.primary ? addColumnEl.value : removeColumnEl.value)?.focus();
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
    <div class="msg-list__titlebar">
      <template v-if="primary">
        <h2 class="msg-list__title" :title="folderName">
          <span
            v-if="folderIcon"
            class="msg-list__title-icon"
            :style="{ '--folder-tone': folder ? folderPresentation(folder).color : undefined }"
            aria-hidden="true"
            v-html="folderIcon"
          />
          <span class="msg-list__title-name">{{ folder ? folderName : 'Messages' }}</span>
        </h2>
        <button
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
      </template>
      <template v-else>
        <AppDropdown class="msg-list__folder-picker" group="message-columns" @toggle="onFolderMenuToggle">
          <summary
            ref="folderTriggerEl"
            class="app-dropdown__summary msg-list__folder-trigger"
            :class="{ 'msg-list__folder-trigger--empty': !folder }"
            aria-haspopup="listbox"
            :aria-label="folder ? `Folder for column ${columnIndex}: ${folderName}` : `Choose a folder for column ${columnIndex}`"
            :title="folder ? folderName : 'Choose a folder'"
          >
            <span
              v-if="folderIcon"
              class="msg-list__title-icon"
              :style="{ '--folder-tone': folder ? folderPresentation(folder).color : undefined }"
              aria-hidden="true"
              v-html="folderIcon"
            />
            <span class="msg-list__title-name">{{ folder ? folderName : 'Choose a folder…' }}</span>
          </summary>
          <div
            ref="folderMenuEl"
            class="app-dropdown__menu msg-list__folder-menu"
            role="listbox"
            :aria-label="`Folders for column ${columnIndex}`"
            @keydown="onFolderMenuKeydown"
          >
            <div
              v-for="group in folderOptionGroups"
              :key="group.key"
              role="group"
              :aria-label="group.label ?? undefined"
            >
              <div v-if="group.label" class="app-dropdown__heading msg-list__folder-heading" :title="group.label">
                {{ group.label }}
              </div>
              <button
                v-for="option in group.options"
                :key="option.folder.id"
                class="app-dropdown__item msg-list__folder-option"
                type="button"
                role="option"
                :aria-selected="option.folder.id === folderId"
                :style="{ '--folder-tone': option.color, paddingLeft: `${8 + option.depth * 14}px` }"
                @click="pickFolder(option.folder.id, $event)"
              >
                <span class="msg-list__folder-option-icon" aria-hidden="true" v-html="option.icon" />
                <span class="msg-list__folder-option-name">{{ option.folder.name || '(unnamed)' }}</span>
              </button>
            </div>
          </div>
        </AppDropdown>
        <button
          ref="removeColumnEl"
          class="msg-list__column-control msg-list__remove-column"
          type="button"
          title="Remove column"
          :aria-label="`Remove column ${columnIndex}`"
          @click="emit('remove-column')"
        >
          <X :size="18" :stroke-width="1.75" aria-hidden="true" />
        </button>
      </template>
    </div>

    <SelectableListHeader
      class="msg-list__header"
      :all-selected="allLoadedSelected"
      clear-class="msg-list__bulk-action msg-list__bulk-action--ghost"
      count-class="msg-list__count"
      :disabled="folderId == null"
      item-label="messages"
      select-all-class="msg-list__select-all"
      selection-actions-class="msg-list__bulk-actions"
      singular-item-label="message"
      :selected-count="selectionCount"
      :total-count="rowCount"
      @clear-selection="selectNone"
      @toggle-all="toggleSelectAll"
    >
      <template #selection-actions>
        <MessageBulkActions
          :folder="folder"
          :can-whitelist="canWhitelistInJunk"
          :whitelisting="bulkWhitelisting"
          :any-starred="anySelectedStarred"
          :any-scheduled="anySelectedScheduled"
          @archive="bulkArchive"
          @junk="bulkJunk"
          @delete="bulkDelete"
          @cancel-send="bulkCancelSend"
          @toggle-star="bulkToggleStar"
          @mark-read="bulkMarkRead"
          @mark-unread="bulkMarkUnread"
          @whitelist="bulkWhitelist"
        />
      </template>
      <template #normal-actions>
        <div class="msg-list__filters" role="group" aria-label="Message filters">
          <button
            class="msg-list__filter"
            :class="{ 'is-active': unreadOnly }"
            type="button"
            :aria-pressed="unreadOnly"
            :disabled="folderId == null"
            @click="toggleUnreadFilter"
          >
            Unread
          </button>
          <button
            class="msg-list__filter msg-list__filter--starred"
            :class="{ 'is-active': flaggedOnly }"
            type="button"
            :aria-pressed="flaggedOnly"
            :disabled="folderId == null"
            @click="toggleFlaggedFilter"
          >
            Starred
          </button>
        </div>
      </template>
      <template #trailing>
        <button
          class="msg-list__refresh"
          type="button"
          :aria-label="isLoading ? 'Refreshing' : 'Refresh'"
          :title="isLoading ? 'Refreshing…' : 'Refresh'"
          :disabled="folderId == null"
          @click="mailStore.refresh(folderId)"
        >
          <RefreshCw :size="16" :stroke-width="1.75" aria-hidden="true" :class="{ 'is-spinning': isLoading }" />
        </button>
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
  grid-template-rows: auto auto 1fr;
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
/* Title row: folder (static for the primary column, a dropdown for the
   others) at the start, the column control pinned to the end corner.
   The name truncates so the control never wraps out of the corner. */
.msg-list__titlebar {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 42px;
  padding: 4px 8px 4px 12px;
  border-bottom: 1px solid var(--border-soft);
}
.msg-list__title,
.msg-list__folder-picker {
  flex: 1 1 auto;
  min-width: 0;
}
.msg-list__title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.msg-list__title-icon {
  display: block;
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  color: var(--folder-tone, var(--muted));
}
.msg-list__title-icon :deep(svg),
.msg-list__folder-option-icon :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}
.msg-list__title-icon :deep([fill="context-fill"]),
.msg-list__folder-option-icon :deep([fill="context-fill"]) {
  fill: color-mix(in srgb, currentColor 20%, transparent);
}
.msg-list__title-icon :deep([fill="context-stroke"]),
.msg-list__folder-option-icon :deep([fill="context-stroke"]) {
  fill: currentColor;
}
.msg-list__title-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.msg-list__folder-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  min-height: 32px;
  padding: 4px 8px;
  border: 1px solid var(--control-border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
}
.msg-list__folder-trigger:focus-visible {
  border-color: var(--accent);
  outline: none;
}
.msg-list__folder-trigger::after {
  flex-shrink: 0;
}
.msg-list__folder-trigger--empty {
  color: var(--muted);
  font-weight: 500;
}
.msg-list__folder-menu {
  min-width: 220px;
  max-width: min(360px, 80vw);
}
.msg-list__folder-heading {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.msg-list__folder-option {
  width: 100%;
}
.msg-list__folder-option[aria-selected="true"] {
  background: var(--rowActive);
}
.msg-list__folder-option-icon {
  display: block;
  width: 18px;
  height: 18px;
  color: var(--folder-tone, var(--muted));
}
.msg-list__folder-option-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
.msg-list__header {
  container-type: inline-size;
}
/* Select-all, the two filters and Refresh need ~290px; the total count
   (up to ~85px with four digits) goes first when the pane cannot fit it
   too. The selected count stays. */
@container (max-width: 379px) {
  .msg-list__header :deep(.selectable-list-header__count--total) {
    display: none;
  }
}
.msg-list__filters {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
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
