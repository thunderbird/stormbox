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

export type DirectoryResizePane = 'list' | 'rail';

export const DIRECTORY_RESIZER_WIDTH = 6;
export const DIRECTORY_COLUMN_MIN_WIDTHS = {
  detail: 240,
  list: 280,
  rail: 180,
} as const;

const DIRECTORY_COLUMN_DEFAULT_WIDTHS = {
  detail: 640,
  list: 360,
  rail: 240,
} as const;

const DIRECTORY_COLUMN_MAX_WIDTHS = {
  list: 720,
  rail: 420,
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

export function useDirectoryColumnResize(options: DirectoryColumnResizeOptions) {
  const railWidth = ref<number>(DIRECTORY_COLUMN_DEFAULT_WIDTHS.rail);
  const listWidth = ref<number>(DIRECTORY_COLUMN_DEFAULT_WIDTHS.list);
  let usingDefaultWidths = true;

  const columnStyle = computed(() => ({
    '--contacts-column-resizer-width': `${DIRECTORY_RESIZER_WIDTH}px`,
    '--contacts-rail-width': `${railWidth.value}px`,
    '--directory-detail-min-width': `${DIRECTORY_COLUMN_MIN_WIDTHS.detail}px`,
    '--directory-list-min-width': `${DIRECTORY_COLUMN_MIN_WIDTHS.list}px`,
    '--directory-list-width': `${listWidth.value}px`,
    '--directory-resizer-width': `${DIRECTORY_RESIZER_WIDTH}px`,
  }));

  function availableWidth(): number {
    return options.rootEl.value?.clientWidth
      || (typeof window === 'undefined' ? 0 : window.innerWidth);
  }

  function maxRailWidth(candidateListWidth: number = listWidth.value): number {
    const directoryReserve = options.detailVisible.value
      ? candidateListWidth
        + DIRECTORY_RESIZER_WIDTH
        + DIRECTORY_COLUMN_MIN_WIDTHS.detail
      : DIRECTORY_COLUMN_MIN_WIDTHS.list;
    return Math.min(
      DIRECTORY_COLUMN_MAX_WIDTHS.rail,
      availableWidth() - DIRECTORY_RESIZER_WIDTH - directoryReserve,
    );
  }

  function maxListWidth(candidateRailWidth: number = railWidth.value): number {
    const railReserve = options.layout.value === 'desktop'
      ? candidateRailWidth + DIRECTORY_RESIZER_WIDTH
      : 0;
    const detailReserve = options.detailVisible.value
      ? DIRECTORY_COLUMN_MIN_WIDTHS.detail + DIRECTORY_RESIZER_WIDTH
      : 0;
    return Math.min(
      DIRECTORY_COLUMN_MAX_WIDTHS.list,
      availableWidth() - railReserve - detailReserve,
    );
  }

  function defaultListWidth(): number {
    const railReserve = options.layout.value === 'desktop'
      ? railWidth.value + DIRECTORY_RESIZER_WIDTH
      : 0;
    return clamp(
      availableWidth()
        - railReserve
        - DIRECTORY_RESIZER_WIDTH
        - DIRECTORY_COLUMN_DEFAULT_WIDTHS.detail,
      DIRECTORY_COLUMN_MIN_WIDTHS.list,
      DIRECTORY_COLUMN_MAX_WIDTHS.list,
    );
  }

  function paneCanResize(pane: DirectoryResizePane): boolean {
    if (pane === 'rail') return options.layout.value === 'desktop';
    return options.layout.value !== 'phone' && options.detailVisible.value;
  }

  const {
    activeResizePane,
    clampPane,
    onResizeHandleKeydown,
    startColumnResize,
  } = useColumnResize<DirectoryResizePane>({
    panes: {
      list: {
        canResize: () => paneCanResize('list'),
        get: () => listWidth.value,
        max: (widths) => maxListWidth(widths.rail),
        min: () => DIRECTORY_COLUMN_MIN_WIDTHS.list,
        set: (width) => {
          listWidth.value = width;
        },
        storageKey: 'list',
      },
      rail: {
        canResize: () => paneCanResize('rail'),
        get: () => railWidth.value,
        max: (widths) => maxRailWidth(widths.list),
        min: () => DIRECTORY_COLUMN_MIN_WIDTHS.rail,
        set: (width) => {
          railWidth.value = width;
        },
        storageKey: 'rail',
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
    if (options.layout.value === 'desktop') {
      clampPane('rail');
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
    maxRailWidth,
    onResizeHandleKeydown,
    railWidth,
    startColumnResize,
  };
}
