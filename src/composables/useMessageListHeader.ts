import { computed } from 'vue';
import type { Ref } from 'vue';
import { Plus, RefreshCw, X } from '@lucide/vue';

import { MAX_MESSAGE_COLUMNS } from '../stores/message-columns-store';
import { splitBulkActions } from './useBulkActionItems';
import type { BulkActionItem } from './useBulkActionItems';
import type { MoreMenuGroup, MoreMenuItem } from '../components/MessageListMoreMenu.vue';

export type MessageListHeaderTier = 'full' | 'no-count' | 'icon-filters' | 'compact';

/**
 * The header is one row at every width; what does not fit leaves it in
 * a fixed order rather than wrapping. Thresholds are list widths (px),
 * derived from the measured items — 24px header padding, 10px gaps,
 * select-all 34, filter labels 155 (icon-only 72), total count 70–85,
 * Refresh 34, +/× 32, More 32 — so the folder title keeps at least
 * ~90px at each tier. Width 0 means "not measured" (tests, first
 * paint) and shows everything.
 */
export const HEADER_COUNT_MIN_WIDTH = 520;
export const HEADER_FILTER_LABELS_MIN_WIDTH = 440;
export const HEADER_INLINE_CONTROLS_MIN_WIDTH = 340;
/**
 * Bulk row budget: select-all 34, the actions' 8px start margin, Clear
 * 34, "N selected" (up to ~70), More 32, three 10px gaps and the 24px
 * padding leave `width - 232` for the action buttons, 34px each plus a
 * 4px gap.
 */
export const BULK_ROW_FIXED_WIDTH = 232;
export const BULK_ACTION_SLOT_WIDTH = 38;

export interface UseMessageListHeaderInput {
  /** Measured list width; 0 while unknown. */
  listWidth: Ref<number>;
  hasSelection: Ref<boolean>;
  folderId: Ref<number | null>;
  folderName: Ref<string>;
  isLoading: Ref<boolean>;
  primary: Ref<boolean>;
  canAddColumn: Ref<boolean>;
  columnIndex: Ref<number>;
  bulkActionItems: Ref<BulkActionItem[]>;
  refresh: () => void;
  addColumn: () => void;
  removeColumn: () => void;
}

/**
 * Which header controls sit in the row and which move to the More menu
 * at the current width, for the normal and the bulk-selection state.
 */
export function useMessageListHeader(input: UseMessageListHeaderInput) {
  const measured = computed(() => input.listWidth.value > 0);
  const showsCount = computed(() => (
    !measured.value || input.listWidth.value >= HEADER_COUNT_MIN_WIDTH
  ));
  const filterLabels = computed(() => (
    !measured.value || input.listWidth.value >= HEADER_FILTER_LABELS_MIN_WIDTH
  ));
  /** Refresh and +/× sit in the row only in the normal state of a wide enough column. */
  const inlineControls = computed(() => (
    !input.hasSelection.value
    && (!measured.value || input.listWidth.value >= HEADER_INLINE_CONTROLS_MIN_WIDTH)
  ));
  const tier = computed<MessageListHeaderTier>(() => {
    if (!inlineControls.value && !input.hasSelection.value) return 'compact';
    if (!filterLabels.value) return 'icon-filters';
    if (!showsCount.value) return 'no-count';
    return 'full';
  });

  const bulkCapacity = computed(() => (
    measured.value
      ? Math.max(1, Math.floor((input.listWidth.value - BULK_ROW_FIXED_WIDTH) / BULK_ACTION_SLOT_WIDTH))
      : null
  ));
  const bulkActions = computed(() => splitBulkActions(input.bulkActionItems.value, bulkCapacity.value));

  const addColumnTitle = computed(() => (
    input.canAddColumn.value
      ? 'Add a message list column'
      : `Up to ${MAX_MESSAGE_COLUMNS} columns can be shown`
  ));
  const removeColumnTitle = computed(() => `Remove column ${input.columnIndex.value}`);

  const columnControlItem = computed<MoreMenuItem>(() => (input.primary.value
    ? {
      id: 'add-column',
      label: 'Add column',
      icon: Plus,
      disabled: !input.canAddColumn.value,
      run: input.addColumn,
    }
    : {
      id: 'remove-column',
      label: 'Remove column',
      icon: X,
      run: input.removeColumn,
    }));

  /** Groups of the More menu; empty while everything fits in the row. */
  const moreMenuGroups = computed<MoreMenuGroup[]>(() => {
    const groups: MoreMenuGroup[] = [];
    if (input.hasSelection.value && bulkActions.value.overflow.length > 0) {
      groups.push({
        id: 'selection',
        items: bulkActions.value.overflow.map((item) => ({
          id: item.id,
          label: item.label,
          icon: item.icon,
          rawIcon: item.rawIcon,
          disabled: item.disabled,
          danger: item.variant === 'danger',
          run: item.run,
        })),
      });
    }
    // A column without a folder keeps its × in the row: there is nothing
    // else there to make room for.
    if (!inlineControls.value && input.folderId.value != null) {
      groups.push({
        id: 'column',
        label: input.hasSelection.value ? input.folderName.value : undefined,
        items: [
          {
            id: 'refresh',
            label: 'Refresh',
            icon: RefreshCw,
            disabled: input.isLoading.value,
            run: input.refresh,
          },
          columnControlItem.value,
        ],
      });
    }
    return groups;
  });
  const showsMoreMenu = computed(() => moreMenuGroups.value.length > 0);
  /** Whether Refresh and +/× render in the row. */
  const showsInlineControls = computed(() => inlineControls.value || input.folderId.value == null);

  return {
    tier,
    showsCount,
    filterLabels,
    showsInlineControls,
    showsMoreMenu,
    moreMenuGroups,
    bulkActions,
    addColumnTitle,
    removeColumnTitle,
  };
}
