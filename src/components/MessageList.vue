<script setup lang="ts">
import {
  computed, nextTick, onBeforeUnmount, onMounted, ref, watch, watchPostEffect,
} from 'vue';
import { storeToRefs } from 'pinia';
import { useVirtualizer } from '@tanstack/vue-virtual';
import {
  Paperclip, Star, RefreshCw, MailOpen, Mail, Trash2, X,
} from '@lucide/vue';

import { useMailStore } from '../stores/mail-store';
import { useListSelection } from '../composables/useListSelection';
import { useMessageDragDrop } from '../composables/useMessageDragDrop';
import { SENDER_AVATAR_PROXY_URL } from '../defines';
import { senderAvatarFor, shortFrom } from '../utils/sender-avatar';
import archiveIcon from '../assets/icons/tb-folder-archive.svg?raw';
import junkIcon from '../assets/icons/tb-folder-spam.svg?raw';

const mailStore = useMailStore();

const props = defineProps({
  quickFilterQuery: { type: String, default: '' },
});

const folderName = computed(() => mailStore.currentFolder?.name ?? 'Mail');

// storeToRefs preserves reactivity on raw refs in the setup store —
// useListSelection needs the actual ref<Set> so it can replace the
// Set instance when it mutates (the `_bump()` pattern), and a plain
// `mailStore.selectedIds` access returns the unwrapped value.
const { messages, selectedIds, focusedMessageId } = storeToRefs(mailStore);

const unreadOnly = ref(false);
const quickFilterNeedle = computed(() => normalizeFilterText(props.quickFilterQuery));
const quickFilterActive = computed(() => quickFilterNeedle.value.length > 0);
const denseLocalFilterActive = computed(() => unreadOnly.value || quickFilterActive.value);
// Per R-2.8 (specs/001-mvp-scope/spec.md) and the project constitution,
// the open folder's canonical message set is the mailbox-window query
// view (query_view_items + messages) exposed through
// mailStore.messages. Both All and Unread derive from that single
// source; Unread is a dense local filter over it and must never read
// from a broader projection like folder_messages — that would let the
// Unread count exceed the All count and violate the user-facing
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
  mailStore.totalForFolder ?? 0,
  mailStore.messages.length,
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
  // shortcut handler (F/B/N/P via selectMessage) and arrow nav share
  // one source of truth and the scroll-follow watcher below tracks it.
  focusedId: focusedMessageId,
});

const {
  draggedIds,
  startMessageDrag,
  endMessageDrag,
} = useMessageDragDrop();

function handleKeyDown(event) {
  if ((event.metaKey || event.ctrlKey) && (event.key === 'a' || event.key === 'A')) {
    event.preventDefault();
    selectAllForCurrentFilter();
    return;
  }
  const result = rawHandleKeyDown(event);
  // Plain Arrow nav also drives the preview pane (caller decides;
  // composable only knows about focus/selection, not body loads).
  if (result.consumed && result.focusChanged && result.focusedId != null
      && !event.shiftKey) {
    mailStore.selectMessage(result.focusedId);
  }
}

const CARD_LAYOUT_WIDTH = 360;
const ROW_HEIGHT = 64;
const CARD_ROW_HEIGHT = 112;
const msgListEl = ref<HTMLElement | null>(null);
const selectAllEl = ref<HTMLInputElement | null>(null);
const scrollEl = ref(null);
const listWidth = ref(0);
const failedAvatarDomains = ref<Set<string>>(new Set());
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

function fireLoad(first: number, last: number) {
  lastPrefetch = performance.now();
  mailStore.ensureLoaded(first, last + 1);
  // Window-driven body prefetch. Safe to call before metadata has
  // landed: it skips undefined slots and the next throttled tick
  // after ensureLoaded fills them will pick them up. Click-time
  // fetches that collide with this background work are deduped in
  // the JMAP backend's in-flight body map.
  mailStore.enqueueVisibleBodyPrefetch(first, last + 1);
}

watch(virtualItems, (items) => {
  if (denseLocalFilterActive.value) return;
  if (!items.length) return;
  const folderId = mailStore.currentFolderId;
  if (folderId == null) return;
  const first = items[0].index;
  const last = items[items.length - 1].index;
  // Always update the requested range so the inflight-page chain in
  // mail-store can re-pump against the latest visible window.
  mailStore.setRequestedRange(folderId, first, last + 1);

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
    if (mailStore.currentFolderId == null) return;
    const latestItems = virtualizer.value.getVirtualItems();
    if (!latestItems.length) return;
    fireLoad(latestItems[0].index, latestItems[latestItems.length - 1].index);
  }, THROTTLE_MS - sinceLast + 10);
});

watch(
  () => props.quickFilterQuery,
  (next, prev) => {
    if (next !== prev && mailStore.selectedMessageId != null) {
      mailStore.selectMessage(null);
    }
    // The quick filter is a dense local filter over the entire open
    // folder. Pull the full cached canonical view into the buffer so
    // the From / To / Subject match can fire across every cached row,
    // not just the positional window the virtualizer has loaded.
    const becameActive = normalizeFilterText(next).length > 0
      && normalizeFilterText(prev).length === 0;
    if (becameActive) {
      void mailStore.expandFolderViewIntoMemory();
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
    const folderId = mailStore.currentFolderId;
    if (folderId != null && scrollEl.value) {
      mailStore.setScrollTop(folderId, scrollEl.value.scrollTop);
    }
  });
}

// Keep the virtualized viewport following the keyboard cursor. Every
// path that moves the cursor — Arrow and Shift+Arrow (useListSelection),
// the global Thunderbird shortcuts (F/B/N/P/Home/End ->
// selectMessage), a row click, and the neighbour that becomes current
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
const activeRowDomId = computed(() => (mailStore.focusedMessageId == null
  ? undefined
  : `msg-row-${mailStore.focusedMessageId}`));

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
  () => mailStore.focusedMessageId,
  async (messageId) => {
    if (messageId == null) return;
    // Let visibleMessages / virtualizer count settle (e.g. when a
    // delete mutates the row array in the same tick as the cursor
    // move) before resolving the target index.
    await nextTick();
    if (mailStore.focusedMessageId !== messageId) return;
    scrollCursorIntoView(messageId);
  },
);

watch(
  () => mailStore.currentFolderId,
  async (id) => {
    virtualizer.value.measure();
    if (id == null) return;
    // If a dense filter is already active when we switch folders,
    // pull the new folder's full canonical view into the buffer so
    // the filter applies across every cached row, not just the
    // positional window the virtualizer will pull on first paint.
    if (denseLocalFilterActive.value) {
      void mailStore.expandFolderViewIntoMemory();
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
  if (!hadSelection && id === mailStore.selectedMessageId) {
    mailStore.selectMessage(null);
    return;
  }
  mailStore.selectMessage(id);
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
    sourceFolderId: mailStore.currentFolderId,
  });
}

function isDraggingMessage(messageId) {
  const id = Number(messageId);
  return Number.isFinite(id) && draggedIds.value.includes(id);
}

function senderAvatar(fromText) {
  const avatar = senderAvatarFor(fromText, SENDER_AVATAR_PROXY_URL);
  if (avatar.domain && failedAvatarDomains.value.has(avatar.domain)) {
    return { ...avatar, imageUrl: '' };
  }
  return avatar;
}

function onAvatarError(fromText) {
  const { domain } = senderAvatarFor(fromText, SENDER_AVATAR_PROXY_URL);
  if (!domain || failedAvatarDomains.value.has(domain)) return;
  failedAvatarDomains.value = new Set([...failedAvatarDomains.value, domain]);
}

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

watchPostEffect(() => {
  if (!selectAllEl.value) return;
  selectAllEl.value.checked = allLoadedSelected.value;
  selectAllEl.value.indeterminate = hasSelection.value && !allLoadedSelected.value;
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
  void mailStore.selectAllLoadedMessages({ unreadOnly: unreadOnly.value });
}

function toggleSelectAll() {
  if (hasSelection.value) {
    selectNone();
  } else {
    selectAllForCurrentFilter();
  }
}

// Bulk actions for the checkbox selection. They live here (not in the
// message view) because multi-selecting hides the reading pane
// entirely; the list header is the only surface that is always
// visible, including in single-column layouts.
const isInJunkFolder = computed(() => mailStore.currentFolder?.role === 'junk');
const bulkWhitelisting = ref(false);

async function bulkMarkRead() {
  await mailStore.markManySeen([...selectedIds.value], true);
}

async function bulkMarkUnread() {
  await mailStore.markManySeen([...selectedIds.value], false);
}

async function bulkArchive() {
  const ids = [...selectedIds.value];
  if (ids.length === 0) return;
  try {
    await mailStore.archiveMessages(ids);
  } catch (err) {
    console.warn('[message-list] bulk archive failed', err?.message ?? err);
  }
}

async function bulkJunk() {
  const ids = [...selectedIds.value];
  if (ids.length === 0) return;
  try {
    await mailStore.junkMessages(ids);
  } catch (err) {
    console.warn('[message-list] bulk junk failed', err?.message ?? err);
  }
}

async function bulkDelete() {
  const ids = [...selectedIds.value];
  if (ids.length === 0) return;
  try {
    await mailStore.destroyMessages(ids);
  } catch (err) {
    console.warn('[message-list] bulk delete failed', err?.message ?? err);
  }
}

async function bulkWhitelist() {
  const ids = [...selectedIds.value];
  if (ids.length === 0 || bulkWhitelisting.value) return;
  bulkWhitelisting.value = true;
  try {
    await mailStore.whitelistSenders(ids);
  } catch (err) {
    console.warn('[message-list] bulk whitelist failed', err?.message ?? err);
  } finally {
    bulkWhitelisting.value = false;
  }
}

function toggleUnreadFilter() {
  mailStore.selectMessage(null);
  unreadOnly.value = !unreadOnly.value;
  if (unreadOnly.value) {
    // Unread filters every cached row in the folder, not just the
    // positional window. Pull the full canonical view into the
    // buffer so the filter count and rendered rows reflect the
    // whole folder. This is a local SQLite read, never a JMAP call.
    void mailStore.expandFolderViewIntoMemory();
  }
}

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.valueOf())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' });
}

function messagePassesActiveFilters(row, { includeSticky = true } = {}) {
  if (row?.id == null) return false;
  if (
    includeSticky
    && (row.id === mailStore.selectedMessageId || selectedIds.value.has(row.id))
  ) {
    return true;
  }
  if (unreadOnly.value && Number(row.is_seen) !== 0) return false;
  if (quickFilterActive.value && !messageMatchesQuickFilter(row)) return false;
  return true;
}

function messageMatchesQuickFilter(row) {
  const needle = quickFilterNeedle.value;
  if (!needle) return true;
  return [row?.from_text, row?.to_text, row?.subject]
    .some((value) => normalizeFilterText(value).includes(needle));
}

function normalizeFilterText(value) {
  return String(value ?? '').trim().toLowerCase();
}
</script>

<template>
  <section
    ref="msgListEl"
    class="msg-list"
    :class="{ 'msg-list--card': cardLayout }"
    aria-label="Messages"
  >
    <header class="msg-list__header">
      <label
        class="msg-list__select-all"
        :class="{ 'is-disabled': rowCount === 0 }"
        :title="rowCount === 0 ? 'No messages to select' : (allLoadedSelected ? 'Deselect all' : 'Select all loaded')"
      >
        <input
          ref="selectAllEl"
          type="checkbox"
          :checked="allLoadedSelected"
          :disabled="rowCount === 0"
          :indeterminate.prop="hasSelection && !allLoadedSelected"
          @change="toggleSelectAll"
        />
      </label>
      <!-- Multi-select swaps the filter buttons for the bulk actions:
           the filters make no sense mid-selection and must not be
           toggled while one is active. -->
      <div
        v-if="hasSelection"
        class="msg-list__bulk-actions"
        role="group"
        aria-label="Selection actions"
      >
        <button
          v-if="isInJunkFolder"
          class="msg-list__bulk-action msg-list__bulk-action--whitelist"
          type="button"
          :disabled="bulkWhitelisting"
          @click="bulkWhitelist"
          title="Whitelist senders and move to Inbox"
          aria-label="Not junk — whitelist senders and move the selected messages to Inbox"
        >
          Not junk
        </button>
        <button class="msg-list__bulk-action" type="button" @click="bulkArchive" title="Archive" aria-label="Archive">
          <span class="msg-list__bulk-icon msg-list__bulk-icon--folder" aria-hidden="true" v-html="archiveIcon" />
        </button>
        <button v-if="!isInJunkFolder" class="msg-list__bulk-action" type="button" @click="bulkJunk" title="Junk" aria-label="Mark as junk">
          <span class="msg-list__bulk-icon msg-list__bulk-icon--folder" aria-hidden="true" v-html="junkIcon" />
        </button>
        <button class="msg-list__bulk-action msg-list__bulk-action--danger" type="button" @click="bulkDelete" title="Delete" aria-label="Delete">
          <Trash2 :size="18" :stroke-width="1.65" />
        </button>
        <button class="msg-list__bulk-action" type="button" @click="bulkMarkRead" title="Mark as read" aria-label="Mark as read">
          <MailOpen :size="16" :stroke-width="1.75" />
        </button>
        <button class="msg-list__bulk-action" type="button" @click="bulkMarkUnread" title="Mark as unread" aria-label="Mark as unread">
          <Mail :size="16" :stroke-width="1.75" />
        </button>
        <button class="msg-list__bulk-action msg-list__bulk-action--ghost" type="button" @click="selectNone" title="Clear selection" aria-label="Clear selection">
          <X :size="16" :stroke-width="1.75" />
        </button>
      </div>
      <div v-else class="msg-list__filters" role="group" aria-label="Message filters">
        <button
          class="msg-list__filter"
          :class="{ 'is-active': unreadOnly }"
          type="button"
          :aria-pressed="unreadOnly"
          @click="toggleUnreadFilter"
        >
          Unread
        </button>
      </div>
      <span v-if="hasSelection" class="msg-list__count">
        {{ selectionCount }} selected
      </span>
      <span v-else-if="rowCount > 0" class="msg-list__count">
        {{ rowCount }} {{ rowCount === 1 ? 'message' : 'messages' }}
      </span>
      <button
        class="msg-list__refresh"
        type="button"
        :aria-label="mailStore.isLoading ? 'Refreshing' : 'Refresh'"
        :title="mailStore.isLoading ? 'Refreshing…' : 'Refresh'"
        @click="mailStore.refresh()"
      >
        <RefreshCw :size="16" :stroke-width="1.75" aria-hidden="true" :class="{ 'is-spinning': mailStore.isLoading }" />
      </button>
    </header>

    <div
      v-if="rowCount > 0"
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
        v-if="mailStore.isLoading && mailStore.messages.length === 0"
        class="msg-list__loader"
      >
        <RefreshCw :size="18" class="is-spinning" />
        <p>Loading {{ folderName }}…</p>
      </div>
      <ol class="msg-list__items" role="presentation" :style="{ height: totalSize + 'px' }">
        <template v-for="v in virtualItems" :key="v.key">
          <li
            v-if="visibleMessages[v.index]"
            :id="`msg-row-${visibleMessages[v.index].id}`"
            :data-index="v.index"
            role="option"
            :aria-selected="isSelected(visibleMessages[v.index].id)"
            :class="{
              'is-focused': mailStore.selectedMessageId === visibleMessages[v.index].id,
              'is-selected': isSelected(visibleMessages[v.index].id),
              'is-dragging': isDraggingMessage(visibleMessages[v.index].id),
              'is-unread': Number(visibleMessages[v.index].is_seen) === 0,
            }"
            :style="{
              position: 'absolute',
              top: '0px',
              left: '0px',
              right: '0px',
              transform: `translateY(${v.start}px)`,
              height: v.size + 'px',
            }"
          >
            <div
              class="msg-list__item"
              tabindex="-1"
              draggable="true"
              @click="onRowClick(v.index, $event)"
              @dragstart="onRowDragStart(visibleMessages[v.index], $event)"
              @dragend="endMessageDrag"
            >
              <div class="msg-list__state">
                <label class="msg-list__check" draggable="false" @click.stop>
                  <input
                    type="checkbox"
                    :checked="isSelected(visibleMessages[v.index].id)"
                    @click="onCheckboxClick(v.index, $event)"
                  />
                </label>
                <span
                  v-if="Number(visibleMessages[v.index].is_seen) === 0"
                  class="msg-list__unread-dot"
                  aria-label="Unread"
                />
              </div>
              <div
                class="msg-list__avatar"
                :style="senderAvatar(visibleMessages[v.index].from_text).style"
                aria-hidden="true"
              >
                <img
                  v-if="senderAvatar(visibleMessages[v.index].from_text).imageUrl"
                  class="msg-list__avatar-image"
                  :src="senderAvatar(visibleMessages[v.index].from_text).imageUrl"
                  alt=""
                  loading="lazy"
                  decoding="async"
                  referrerpolicy="no-referrer"
                  @error="onAvatarError(visibleMessages[v.index].from_text)"
                />
                <span>{{ senderAvatar(visibleMessages[v.index].from_text).initials }}</span>
              </div>
              <div class="msg-list__content">
                <div class="msg-list__summary">
                  <span class="msg-list__from">{{ shortFrom(visibleMessages[v.index].from_text) }}</span>
                  <span class="msg-list__subject">{{ visibleMessages[v.index].subject || '(no subject)' }}</span>
                  <span class="msg-list__icons">
                    <Star v-if="Number(visibleMessages[v.index].is_flagged) === 1" :size="13" :stroke-width="2" class="msg-list__star" />
                    <Paperclip v-if="Number(visibleMessages[v.index].has_attachment) === 1" :size="13" :stroke-width="1.75" class="msg-list__attach" />
                  </span>
                  <span class="msg-list__date">{{ fmtDate(visibleMessages[v.index].received_at) }}</span>
                </div>
                <p v-if="visibleMessages[v.index].preview" class="msg-list__preview">
                  {{ visibleMessages[v.index].preview }}
                </p>
              </div>
            </div>
          </li>
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

    <div v-else-if="mailStore.isLoading" class="msg-list__placeholder">
      <RefreshCw :size="18" class="is-spinning" />
      <p>Loading {{ folderName }}…</p>
    </div>
    <div v-else-if="quickFilterActive" class="msg-list__placeholder">
      <p>No messages matching "{{ props.quickFilterQuery.trim() }}" in {{ folderName }}.</p>
    </div>
    <div v-else-if="unreadOnly" class="msg-list__placeholder">
      <p>No unread messages in {{ folderName }}.</p>
    </div>
    <div v-else-if="mailStore.currentFolderId" class="msg-list__placeholder">
      <p>{{ folderName }} is empty.</p>
    </div>
    <div v-else class="msg-list__placeholder">
      <p>Select a folder to view its messages.</p>
    </div>
  </section>
</template>

<style scoped>
.msg-list {
  display: grid;
  grid-template-rows: auto 1fr;
  border-right: 1px solid var(--border);
  background: var(--panel);
  min-width: 0;
  min-height: 0;
  height: 100%;
}
.msg-list__header {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 57px;
  padding: 11px 12px;
  border-bottom: 1px solid var(--border);
}
.msg-list__select-all {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  cursor: pointer;
}
.msg-list__select-all.is-disabled {
  cursor: default;
  opacity: 0.72;
}
.msg-list__select-all input {
  width: 14px;
  height: 14px;
  margin: 0;
  cursor: pointer;
  accent-color: var(--accent);
}
.msg-list__select-all input:disabled {
  cursor: default;
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
.msg-list__bulk-actions {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 4px;
  /* Sit next to the select-all checkbox, with a little breathing
     room beyond the header's own gap. */
  margin-inline-start: 8px;
}
.msg-list__bulk-action {
  display: inline-grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--muted);
  width: 34px;
  height: 34px;
  padding: 0;
  border-radius: 8px;
  cursor: pointer;
  font: inherit;
  flex-shrink: 0;
}
.msg-list__bulk-action:hover {
  background: var(--rowHover);
  color: var(--text);
}
.msg-list__bulk-action--danger:hover {
  background: rgba(255, 107, 107, 0.12);
  color: #ff6b6b;
}
.msg-list__bulk-action--ghost { color: var(--muted); }
/* "Not junk" is the contextual, Junk-only primary action; a filled
   accent button set apart from the icon buttons, matching the same
   action in the open-message toolbar. */
.msg-list__bulk-action--whitelist {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: auto;
  padding: 0 12px;
  margin-inline-end: 6px;
  background: var(--accent);
  color: #fff;
  border: 1px solid color-mix(in srgb, var(--accent) 80%, #000);
  border-radius: 6px;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.25;
  white-space: nowrap;
  box-shadow: 0 1px 2px color-mix(in srgb, #000 16%, transparent);
  transition: filter 0.12s ease, box-shadow 0.12s ease;
}
.msg-list__bulk-action--whitelist:hover {
  background: var(--accent);
  color: #fff;
  filter: brightness(1.04);
  box-shadow: 0 2px 5px color-mix(in srgb, #000 18%, transparent);
}
.msg-list__bulk-action--whitelist:disabled,
.msg-list__bulk-action--whitelist:disabled:hover {
  opacity: 0.5;
  filter: none;
  background: var(--accent);
  color: #fff;
}
.msg-list__bulk-icon--folder {
  width: 20px;
  height: 20px;
  display: block;
}
.msg-list__bulk-icon--folder :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}
.msg-list__bulk-icon--folder :deep([fill="context-fill"]) {
  fill: color-mix(in srgb, currentColor 20%, transparent);
}
.msg-list__bulk-icon--folder :deep([fill="context-stroke"]) {
  fill: currentColor;
}
.msg-list__count {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
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
/* Fastmail model: the focused row (currently being viewed) gets the
 * solid accent background. Selection state is communicated by the
 * checkbox itself; we tint the row very softly so the user can scan
 * a column of selected rows without it competing with the "what
 * am I reading" highlight. */
.msg-list__items li.is-focused .msg-list__item { background: var(--rowActive); }
.msg-list__items li.is-selected .msg-list__item {
  background: color-mix(in srgb, var(--accent) 6%, var(--panel));
}
.msg-list__items li.is-selected.is-focused .msg-list__item {
  background: var(--rowActive);
}
.msg-list__items li.is-dragging .msg-list__item {
  opacity: 0.55;
}
.msg-list__items li.is-unread .msg-list__from,
.msg-list__items li.is-unread .msg-list__subject {
  font-weight: 600;
  color: var(--text);
}

.msg-list__item {
  position: relative;
  display: grid;
  grid-template-columns: 34px 34px minmax(0, 1fr);
  align-items: center;
  column-gap: 10px;
  width: 100%;
  height: 100%;
  text-align: left;
  padding: 7px 14px 7px 12px;
  border: 0;
  background: transparent;
  cursor: pointer;
  border-bottom: 1px solid var(--border-soft);
  font: inherit;
  color: inherit;
  transition: background 0.06s ease;
  /* Stops Shift-click from accidentally selecting subject text as
   * the user extends a range — the native text-selection range
   * appears on top of the row highlight and is very ugly. */
  user-select: none;
  -webkit-user-select: none;
}
.msg-list__item:hover { background: var(--rowHover); }
.msg-list__content {
  min-width: 0;
}

.msg-list__state {
  position: relative;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
}
.msg-list__check {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  border-radius: 6px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.08s ease;
}
.msg-list__check input {
  width: 14px;
  height: 14px;
  margin: 0;
  cursor: pointer;
  accent-color: var(--accent);
}

.msg-list__unread-dot {
  display: block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  transition: opacity 0.08s ease;
  /* Pure visual indicator: never intercept clicks meant for the
   * underlying checkbox (which has inset: 0 within .msg-list__state). */
  pointer-events: none;
}
.msg-list__item:hover .msg-list__check,
.msg-list__items li.is-selected .msg-list__check {
  opacity: 1;
}
.msg-list__item:hover .msg-list__unread-dot,
.msg-list__items li.is-selected .msg-list__unread-dot {
  opacity: 0;
}
.msg-list__avatar {
  position: relative;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  overflow: hidden;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #fff 22%, transparent);
}
.msg-list__avatar-image {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.msg-list__summary {
  display: grid;
  grid-template-columns: minmax(86px, 28%) minmax(0, 1fr) auto auto;
  grid-template-areas: "from subject icons date";
  align-items: baseline;
  column-gap: 8px;
}
.msg-list__from {
  grid-area: from;
  min-width: 0;
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.msg-list__date {
  grid-area: date;
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.msg-list__subject {
  grid-area: subject;
  min-width: 0;
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.msg-list__icons {
  grid-area: icons;
  display: inline-flex;
  gap: 4px;
  color: var(--muted);
  min-width: 0;
}
.msg-list__star { color: #f5b700; }
.msg-list__preview {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--muted);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  line-height: 1.35;
}

.msg-list--card .msg-list__item {
  grid-template-columns: 24px 34px minmax(0, 1fr);
  align-items: start;
  column-gap: 9px;
  padding: 10px 12px;
}
.msg-list--card .msg-list__state {
  width: 24px;
}
.msg-list--card .msg-list__summary {
  grid-template-columns: minmax(0, 1fr) auto auto;
  grid-template-areas:
    "from icons date"
    "subject subject subject";
  row-gap: 2px;
}
.msg-list--card .msg-list__from,
.msg-list--card .msg-list__subject {
  font-size: 13px;
}
.msg-list--card .msg-list__subject {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.3;
}
.msg-list--card .msg-list__preview {
  margin-top: 3px;
  -webkit-line-clamp: 1;
}

@media (max-width: 639px) {
  .msg-list__check {
    opacity: 1;
  }
  .msg-list__unread-dot {
    opacity: 0;
  }
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
