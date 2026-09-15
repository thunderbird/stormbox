import {
  computed, nextTick, onBeforeUnmount, onMounted, ref, watch,
} from 'vue';
import type { Ref } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';

import { useMailStore } from '../stores/mail-store';
import type { CachedRow } from '../stores/mail-store-types';

const CARD_LAYOUT_WIDTH = 360;
const ROW_HEIGHT = 64;
const CARD_ROW_HEIGHT = 112;

/**
 * Throttle for the scroll-driven fetch: a 100ms leading-edge guard so a
 * fast scroll does not fire dozens of round trips, plus a trailing-edge
 * fire so the final visible range after the user releases the scrollbar
 * always gets a load. Without the trailing edge, a release inside the
 * window after the last fired load would leave the final range
 * unrequested: the watcher only fires when the visible items change,
 * and the store's in-flight re-pump needs a load to be in flight.
 */
const THROTTLE_MS = 100;

export interface UseMessageListViewportInput {
  /** The list root; its width drives the card layout and the header tiers. */
  listEl: Ref<HTMLElement | null>;
  folderId: Ref<number | null>;
  primary: Ref<boolean>;
  /** Rows the list paints (the window, or the filtered rows). */
  visibleMessages: Ref<CachedRow[]>;
  /** Virtualizer count: the folder total, or the filtered row count. */
  rowCount: Ref<number>;
  /** True while a dense filter owns the row set; positional fetches pause. */
  denseFilterActive: Ref<boolean>;
  /** The keyboard cursor when it belongs to this list. */
  focusedMessageId: Ref<number | null>;
}

/**
 * The virtualised viewport of one list column: row virtualisation with
 * the card layout under 360px, the throttled window fetch and body
 * prefetch, per-folder scroll memory, the cursor kept in view, and the
 * scroll reset when the primary column's folder is re-picked.
 */
export function useMessageListViewport(input: UseMessageListViewportInput) {
  const mailStore = useMailStore();

  const scrollEl = ref<HTMLElement | null>(null);
  const listWidth = ref(0);
  const cardLayout = computed(() => listWidth.value > 0 && listWidth.value < CARD_LAYOUT_WIDTH);
  let listResizeObserver: ResizeObserver | null = null;

  const virtualizer = useVirtualizer(
    computed(() => ({
      count: input.rowCount.value,
      getScrollElement: () => scrollEl.value,
      estimateSize: () => (cardLayout.value ? CARD_ROW_HEIGHT : ROW_HEIGHT),
      overscan: 8,
      getItemKey: (i: number) => input.visibleMessages.value[i]?.id ?? `_ph_${i}`,
    })),
  );

  const totalSize = computed(() => virtualizer.value.getTotalSize());
  const virtualItems = computed(() => virtualizer.value.getVirtualItems());

  let lastPrefetch = 0;
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;

  function fireLoad(first: number, last: number) {
    const id = input.folderId.value;
    if (id == null) return;
    lastPrefetch = performance.now();
    mailStore.ensureLoaded(first, last + 1, id);
    // Window-driven body prefetch. Safe before metadata has landed: it
    // skips undefined slots and the next throttled tick after
    // ensureLoaded fills them picks them up. Click-time fetches that
    // collide with this background work are deduped in the JMAP
    // backend's in-flight body map.
    mailStore.enqueueVisibleBodyPrefetch(first, last + 1, id);
  }

  watch(virtualItems, (items) => {
    if (input.denseFilterActive.value) return;
    if (!items.length) return;
    const id = input.folderId.value;
    if (id == null) return;
    const first = items[0].index;
    const last = items[items.length - 1].index;
    // Always update the requested range so the in-flight page chain in
    // the store can re-pump against the latest visible window.
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
    if (trailingTimer != null) clearTimeout(trailingTimer);
    trailingTimer = setTimeout(() => {
      trailingTimer = null;
      if (input.folderId.value == null) return;
      const latestItems = virtualizer.value.getVirtualItems();
      if (!latestItems.length) return;
      fireLoad(latestItems[0].index, latestItems[latestItems.length - 1].index);
    }, THROTTLE_MS - sinceLast + 10);
  });

  // Scroll position per folder, rAF-throttled.
  let scrollWriteScheduled = false;
  function onScroll() {
    if (scrollWriteScheduled) return;
    scrollWriteScheduled = true;
    requestAnimationFrame(() => {
      scrollWriteScheduled = false;
      const id = input.folderId.value;
      if (id != null && scrollEl.value) {
        mailStore.setScrollTop(id, scrollEl.value.scrollTop);
      }
    });
  }

  function scrollCursorIntoView(messageId: number) {
    if (!scrollEl.value) return;
    const index = input.visibleMessages.value.findIndex((row) => row?.id === messageId);
    if (index < 0) return;
    // align: 'auto' is a no-op when the row is already fully visible, so
    // a plain row click never yanks the list; it scrolls only the minimum
    // needed when keyboard nav steps the cursor past a viewport edge.
    virtualizer.value.scrollToIndex(index, { align: 'auto' });
  }

  // Every path that moves the cursor (Arrow and Shift+Arrow, the list
  // commands, a row click, the neighbour after a delete) funnels
  // through the store's focused id; an off-screen cursor row is not in
  // the DOM, so the virtualizer is driven from this one source.
  watch(input.focusedMessageId, async (messageId) => {
    if (messageId == null) return;
    // Let the row array and the virtualizer count settle (a delete
    // mutates rows in the same tick as the cursor move).
    await nextTick();
    if (input.focusedMessageId.value !== messageId) return;
    scrollCursorIntoView(messageId);
  });

  // A folder change restores that folder's remembered scroll position;
  // re-picking the primary column's folder in the folder list scrolls
  // it back to the top.
  watch(
    [input.folderId, () => mailStore.folderPickCount],
    async ([id, pickCount], [previousId, previousPickCount]) => {
      virtualizer.value.measure();
      if (id == null) return;
      if (id === previousId && pickCount !== previousPickCount) {
        if (!input.primary.value) return;
        mailStore.setScrollTop(id, 0);
        if (scrollEl.value) scrollEl.value.scrollTop = 0;
        return;
      }
      // A dense filter already active when the folder changes needs the
      // new folder's full cached view, not just the first window.
      if (input.denseFilterActive.value) {
        void mailStore.expandFolderViewIntoMemory(id);
      }
      // The scroller's scrollHeight must reflect the new total before the
      // restore, or the assignment is clamped.
      await nextTick();
      if (scrollEl.value) {
        scrollEl.value.scrollTop = mailStore.getScrollTop(id);
      }
    },
    { immediate: true },
  );

  watch(cardLayout, async () => {
    await nextTick();
    virtualizer.value.measure();
  });

  onMounted(() => {
    if (input.listEl.value) {
      listWidth.value = input.listEl.value.clientWidth;
      if (typeof ResizeObserver === 'function') {
        listResizeObserver = new ResizeObserver(([entry]) => {
          listWidth.value = entry.contentRect.width;
        });
        listResizeObserver.observe(input.listEl.value);
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

  return {
    scrollEl,
    listWidth,
    cardLayout,
    totalSize,
    virtualItems,
    onScroll,
  };
}
