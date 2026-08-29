import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type ComputedRef,
  type Ref,
} from 'vue';

import type { DirectoryLayout } from '../components/contacts/directory-types';

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
  const activeResizePane = ref<DirectoryResizePane | null>(null);
  let usingDefaultWidths = true;
  let resizeState: {
    pane: DirectoryResizePane;
    startX: number;
    startListWidth: number;
    startRailWidth: number;
  } | null = null;

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

  function clampColumnWidths(): void {
    if (
      usingDefaultWidths
      && options.layout.value !== 'phone'
      && options.detailVisible.value
    ) {
      listWidth.value = defaultListWidth();
    }
    if (options.layout.value === 'desktop') {
      railWidth.value = clamp(
        railWidth.value,
        DIRECTORY_COLUMN_MIN_WIDTHS.rail,
        maxRailWidth(listWidth.value),
      );
    }
    if (options.layout.value !== 'phone') {
      listWidth.value = clamp(
        listWidth.value,
        DIRECTORY_COLUMN_MIN_WIDTHS.list,
        maxListWidth(railWidth.value),
      );
    }
  }

  function saveColumnWidths(): void {
    try {
      window.localStorage?.setItem(options.storageKey, JSON.stringify({
        list: listWidth.value,
        rail: railWidth.value,
      }));
    } catch {
      // The current resize still applies when layout preferences cannot persist.
    }
  }

  function loadColumnWidths(): void {
    try {
      const raw = window.localStorage?.getItem(options.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Number.isFinite(parsed?.rail)) {
        railWidth.value = parsed.rail;
        usingDefaultWidths = false;
      }
      if (Number.isFinite(parsed?.list)) {
        listWidth.value = parsed.list;
        usingDefaultWidths = false;
      }
    } catch {
      // Invalid or unavailable storage falls back to the default widths.
    }
  }

  function paneCanResize(pane: DirectoryResizePane): boolean {
    if (pane === 'rail') return options.layout.value === 'desktop';
    return options.layout.value !== 'phone' && options.detailVisible.value;
  }

  function startColumnResize(pane: DirectoryResizePane, event: PointerEvent): void {
    if (event.button !== 0 || !paneCanResize(pane)) return;
    event.preventDefault();
    usingDefaultWidths = false;
    resizeState = {
      pane,
      startX: event.clientX,
      startListWidth: listWidth.value,
      startRailWidth: railWidth.value,
    };
    activeResizePane.value = pane;
    document.body.classList.add('is-column-resizing');
    window.addEventListener('pointermove', onColumnResizeMove);
    window.addEventListener('pointerup', stopColumnResize, { once: true });
    window.addEventListener('pointercancel', stopColumnResize, { once: true });
  }

  function onColumnResizeMove(event: PointerEvent): void {
    if (!resizeState) return;
    const delta = event.clientX - resizeState.startX;
    if (resizeState.pane === 'rail') {
      railWidth.value = clamp(
        resizeState.startRailWidth + delta,
        DIRECTORY_COLUMN_MIN_WIDTHS.rail,
        maxRailWidth(resizeState.startListWidth),
      );
      return;
    }
    listWidth.value = clamp(
      resizeState.startListWidth + delta,
      DIRECTORY_COLUMN_MIN_WIDTHS.list,
      maxListWidth(railWidth.value),
    );
  }

  function stopColumnResize(): void {
    if (!resizeState && activeResizePane.value == null) return;
    resizeState = null;
    activeResizePane.value = null;
    document.body.classList.remove('is-column-resizing');
    window.removeEventListener('pointermove', onColumnResizeMove);
    window.removeEventListener('pointerup', stopColumnResize);
    window.removeEventListener('pointercancel', stopColumnResize);
    saveColumnWidths();
  }

  function onResizeHandleKeydown(
    pane: DirectoryResizePane,
    event: KeyboardEvent,
  ): void {
    if (
      !paneCanResize(pane)
      || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
    ) {
      return;
    }
    event.preventDefault();
    usingDefaultWidths = false;
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const step = event.shiftKey ? 40 : 10;
    if (pane === 'rail') {
      railWidth.value = clamp(
        railWidth.value + direction * step,
        DIRECTORY_COLUMN_MIN_WIDTHS.rail,
        maxRailWidth(listWidth.value),
      );
    } else {
      listWidth.value = clamp(
        listWidth.value + direction * step,
        DIRECTORY_COLUMN_MIN_WIDTHS.list,
        maxListWidth(railWidth.value),
      );
    }
    saveColumnWidths();
  }

  watch(
    [options.layout, options.detailVisible],
    async () => {
      await nextTick();
      clampColumnWidths();
    },
  );

  onMounted(async () => {
    loadColumnWidths();
    await nextTick();
    clampColumnWidths();
  });

  onBeforeUnmount(stopColumnResize);

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
