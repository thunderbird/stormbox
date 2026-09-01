import {
  computed,
  nextTick,
  onMounted,
  ref,
  watch,
  type ComputedRef,
  type Ref,
} from 'vue';

import type { DirectoryLayout } from '../components/contacts/directory-types';
import { useColumnResize } from './useColumnResize';

export type DirectoryResizePane = 'list';

export const DIRECTORY_RESIZER_WIDTH = 6;
export const DIRECTORY_COLUMN_MIN_WIDTHS = {
  detail: 240,
  list: 280,
} as const;

const DIRECTORY_COLUMN_DEFAULT_WIDTHS = {
  detail: 640,
  list: 360,
} as const;

const DIRECTORY_COLUMN_MAX_WIDTHS = {
  list: 720,
} as const;

interface DirectoryColumnResizeOptions {
  detailVisible: ComputedRef<boolean>;
  layout: ComputedRef<DirectoryLayout>;
  rootEl: Ref<HTMLElement | null>;
  storageKey: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

// Sizes the directory list against the detail pane. The address-book rail is
// the shell's sidebar and is sized there (CT-1.3), so the root element here is
// only the list-and-detail area.
export function useDirectoryColumnResize(options: DirectoryColumnResizeOptions) {
  const listWidth = ref<number>(DIRECTORY_COLUMN_DEFAULT_WIDTHS.list);
  let usingDefaultWidths = true;

  const columnStyle = computed(() => ({
    '--directory-detail-min-width': `${DIRECTORY_COLUMN_MIN_WIDTHS.detail}px`,
    '--directory-list-min-width': `${DIRECTORY_COLUMN_MIN_WIDTHS.list}px`,
    '--directory-list-width': `${listWidth.value}px`,
    '--directory-resizer-width': `${DIRECTORY_RESIZER_WIDTH}px`,
  }));

  function availableWidth(): number {
    return options.rootEl.value?.clientWidth
      || (typeof window === 'undefined' ? 0 : window.innerWidth);
  }

  function maxListWidth(): number {
    const detailReserve = options.detailVisible.value
      ? DIRECTORY_COLUMN_MIN_WIDTHS.detail + DIRECTORY_RESIZER_WIDTH
      : 0;
    return Math.min(
      DIRECTORY_COLUMN_MAX_WIDTHS.list,
      availableWidth() - detailReserve,
    );
  }

  function defaultListWidth(): number {
    return clamp(
      availableWidth()
        - DIRECTORY_RESIZER_WIDTH
        - DIRECTORY_COLUMN_DEFAULT_WIDTHS.detail,
      DIRECTORY_COLUMN_MIN_WIDTHS.list,
      DIRECTORY_COLUMN_MAX_WIDTHS.list,
    );
  }

  const {
    activeResizePane,
    clampPane,
    onResizeHandleKeydown,
    startColumnResize,
  } = useColumnResize<DirectoryResizePane>({
    panes: {
      list: {
        canResize: () => options.layout.value !== 'phone' && options.detailVisible.value,
        get: () => listWidth.value,
        max: () => maxListWidth(),
        min: () => DIRECTORY_COLUMN_MIN_WIDTHS.list,
        set: (width) => {
          listWidth.value = width;
        },
        storageKey: 'list',
      },
    },
    storageKey: options.storageKey,
    onLoad: () => {
      usingDefaultWidths = false;
    },
    onUserResize: () => {
      usingDefaultWidths = false;
    },
  });

  function clampColumnWidths(): void {
    if (
      usingDefaultWidths
      && options.layout.value !== 'phone'
      && options.detailVisible.value
    ) {
      listWidth.value = defaultListWidth();
    }
    if (options.layout.value !== 'phone') {
      clampPane('list');
    }
  }

  watch(
    [options.layout, options.detailVisible],
    async () => {
      await nextTick();
      clampColumnWidths();
    },
  );

  onMounted(async () => {
    await nextTick();
    clampColumnWidths();
  });

  return {
    activeResizePane,
    clampColumnWidths,
    columnStyle,
    listWidth,
    maxListWidth,
    onResizeHandleKeydown,
    startColumnResize,
  };
}
