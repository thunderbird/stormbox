import {
  onBeforeUnmount,
  onMounted,
  ref,
} from 'vue';

export interface ColumnResizePaneOptions<Pane extends string> {
  canResize?: () => boolean;
  get: () => number;
  max: (widths: Readonly<Record<Pane, number>>) => number;
  min: () => number;
  set: (width: number) => void;
  storageKey: string;
}

export interface UseColumnResizeOptions<Pane extends string> {
  onLoad?: () => void;
  onUserResize?: () => void;
  panes: Record<Pane, ColumnResizePaneOptions<Pane>>;
  storageKey: string;
}

interface ColumnResizeState<Pane extends string> {
  pane: Pane;
  startX: number;
  widths: Record<Pane, number>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

export function useColumnResize<Pane extends string>(
  options: UseColumnResizeOptions<Pane>,
) {
  const paneKeys = Object.keys(options.panes) as Pane[];
  const activeResizePane = ref<Pane | null>(null);
  let resizeState: ColumnResizeState<Pane> | null = null;

  function widths(): Record<Pane, number> {
    return paneKeys.reduce((values, pane) => {
      values[pane] = options.panes[pane].get();
      return values;
    }, {} as Record<Pane, number>);
  }

  function paneCanResize(pane: Pane): boolean {
    return options.panes[pane].canResize?.() !== false;
  }

  function clampPane(
    pane: Pane,
    snapshot: Readonly<Record<Pane, number>> = widths(),
  ): number {
    const paneOptions = options.panes[pane];
    const width = clamp(
      paneOptions.get(),
      paneOptions.min(),
      paneOptions.max(snapshot),
    );
    paneOptions.set(width);
    return width;
  }

  function saveWidths(): void {
    try {
      const stored = paneKeys.reduce<Record<string, number>>((values, pane) => {
        const paneOptions = options.panes[pane];
        values[paneOptions.storageKey] = paneOptions.get();
        return values;
      }, {});
      window.localStorage?.setItem(options.storageKey, JSON.stringify(stored));
    } catch {
      // The current resize still applies when layout preferences cannot persist.
    }
  }

  function loadWidths(): void {
    try {
      const raw = window.localStorage?.getItem(options.storageKey);
      if (!raw) return;
      const stored = JSON.parse(raw) as Record<string, unknown>;
      let loaded = false;
      for (const pane of paneKeys) {
        const paneOptions = options.panes[pane];
        const value = stored?.[paneOptions.storageKey];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        paneOptions.set(value);
        loaded = true;
      }
      if (loaded) options.onLoad?.();
    } catch {
      // Invalid or unavailable storage falls back to the configured widths.
    }
  }

  function stopColumnResize(): void {
    if (!resizeState && activeResizePane.value == null) return;
    resizeState = null;
    activeResizePane.value = null;
    document.body.classList.remove('is-column-resizing');
    window.removeEventListener('pointermove', onColumnResizeMove);
    window.removeEventListener('pointerup', stopColumnResize);
    window.removeEventListener('pointercancel', stopColumnResize);
    saveWidths();
  }

  function onColumnResizeMove(event: PointerEvent): void {
    if (!resizeState) return;
    const paneOptions = options.panes[resizeState.pane];
    paneOptions.set(clamp(
      resizeState.widths[resizeState.pane] + event.clientX - resizeState.startX,
      paneOptions.min(),
      paneOptions.max(resizeState.widths),
    ));
  }

  function startColumnResize(pane: Pane, event: PointerEvent): void {
    if (event.button !== 0 || !paneCanResize(pane)) return;
    event.preventDefault();
    options.onUserResize?.();
    resizeState = {
      pane,
      startX: event.clientX,
      widths: widths(),
    };
    activeResizePane.value = pane;
    document.body.classList.add('is-column-resizing');
    window.addEventListener('pointermove', onColumnResizeMove);
    window.addEventListener('pointerup', stopColumnResize, { once: true });
    window.addEventListener('pointercancel', stopColumnResize, { once: true });
  }

  function onResizeHandleKeydown(pane: Pane, event: KeyboardEvent): void {
    if (
      !paneCanResize(pane)
      || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
    ) {
      return;
    }
    event.preventDefault();
    options.onUserResize?.();
    const snapshot = widths();
    const paneOptions = options.panes[pane];
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const step = event.shiftKey ? 40 : 10;
    paneOptions.set(clamp(
      snapshot[pane] + direction * step,
      paneOptions.min(),
      paneOptions.max(snapshot),
    ));
    saveWidths();
  }

  onMounted(loadWidths);
  onBeforeUnmount(stopColumnResize);

  return {
    activeResizePane,
    clampPane,
    onResizeHandleKeydown,
    startColumnResize,
  };
}
