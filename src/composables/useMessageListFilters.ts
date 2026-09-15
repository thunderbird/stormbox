import { computed, ref, watch } from 'vue';
import type { Ref } from 'vue';

import type { CachedRow } from '../stores/mail-store-types';
import { messageMatchesQuickFilter, normalizeFilterText } from '../utils/quick-filter';

export interface UseMessageListFiltersInput {
  /** The folder's positional window (sparse: unfetched positions are undefined). */
  messages: Ref<CachedRow[]>;
  quickFilterQuery: Ref<string>;
  /** The open message when it belongs to this list; kept visible while a filter hides it. */
  openMessageId: Ref<number | null>;
  /** Checked rows of this list; kept visible while a filter hides them. */
  selectedIds: Ref<Set<number>>;
  /** Closes the reading pane before a filter changes what the list shows. */
  closeOpenMessage: () => void;
  /** Pulls the folder's full cached view into the window (a local read). */
  expandFolderView: () => void;
}

/**
 * The list's dense local filters. Per R-2.8 (specs/001-mvp-scope/spec.md)
 * and the project constitution, the folder's canonical message set is
 * the mailbox-window query view exposed through the folder view; All,
 * Unread, Starred and the Quick Filter derive from that single source.
 * Unread and Starred combine as AND and must never read from a broader
 * projection like folder_messages, which would let a filter count
 * exceed the All count.
 */
export function useMessageListFilters(input: UseMessageListFiltersInput) {
  const unreadOnly = ref(false);
  const flaggedOnly = ref(false);
  const quickFilterNeedle = computed(() => normalizeFilterText(input.quickFilterQuery.value));
  const quickFilterActive = computed(() => quickFilterNeedle.value.length > 0);
  const denseLocalFilterActive = computed(() => (
    unreadOnly.value || flaggedOnly.value || quickFilterActive.value
  ));

  function messagePassesActiveFilters(row: CachedRow, { includeSticky = true } = {}): boolean {
    if (row?.id == null) return false;
    if (
      includeSticky
      && (row.id === input.openMessageId.value || input.selectedIds.value.has(row.id))
    ) {
      return true;
    }
    if (unreadOnly.value && Number(row.is_seen) !== 0) return false;
    if (flaggedOnly.value && Number(row.is_flagged) !== 1) return false;
    if (quickFilterActive.value && !messageMatchesQuickFilter(row, quickFilterNeedle.value)) return false;
    return true;
  }

  /** Rows the list paints: the window, or its filtered rows plus the sticky ones. */
  const visibleMessages = computed(() => {
    if (!denseLocalFilterActive.value) return input.messages.value;
    return input.messages.value.filter((row) => messagePassesActiveFilters(row, { includeSticky: true }));
  });
  /** Rows "Select all" targets: the filtered rows without the sticky exception. */
  const selectAllTargetMessages = computed(() => {
    if (!denseLocalFilterActive.value) return input.messages.value;
    return input.messages.value.filter((row) => messagePassesActiveFilters(row, { includeSticky: false }));
  });

  function closeOpenMessageIfFilteredOut() {
    const openId = input.openMessageId.value;
    if (openId == null) return;
    const openRow = input.messages.value.find((row) => row?.id === openId);
    if (!openRow || !messagePassesActiveFilters(openRow, { includeSticky: false })) {
      input.closeOpenMessage();
    }
  }

  function toggleDenseFilter(filter: Ref<boolean>) {
    filter.value = !filter.value;
    closeOpenMessageIfFilteredOut();
    if (filter.value) {
      // Dense filters cover every cached row in the folder, not just the
      // positional window, so the filter count and rendered rows reflect
      // the whole folder. This is a local SQLite read, never a JMAP call.
      input.expandFolderView();
    }
  }

  function toggleUnreadFilter() {
    toggleDenseFilter(unreadOnly);
  }

  function toggleFlaggedFilter() {
    toggleDenseFilter(flaggedOnly);
  }

  // The quick filter is a dense local filter over the entire folder:
  // when it becomes active, pull the full cached view into the window
  // so the From / To / Subject match covers every cached row.
  watch(input.quickFilterQuery, (next, prev) => {
    if (next !== prev) closeOpenMessageIfFilteredOut();
    const becameActive = normalizeFilterText(next).length > 0
      && normalizeFilterText(prev).length === 0;
    if (becameActive) input.expandFolderView();
  });

  return {
    unreadOnly,
    flaggedOnly,
    quickFilterActive,
    denseLocalFilterActive,
    visibleMessages,
    selectAllTargetMessages,
    toggleUnreadFilter,
    toggleFlaggedFilter,
  };
}
