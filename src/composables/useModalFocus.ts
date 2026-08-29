import {
  nextTick,
  onBeforeUnmount,
  onMounted,
  watch,
  type Ref,
  type WatchStopHandle,
} from 'vue';

interface UseModalFocusOptions {
  active?: Readonly<Ref<boolean>>;
  initialFocus?: Readonly<Ref<HTMLElement | null>>;
  onDefault?: () => void | Promise<void>;
  restoreFocus?: boolean;
}

export function focusModalSurface(element: HTMLElement | null): void {
  element?.focus({ preventScroll: true });
}

/**
 * Keeps modal activation focus on the modal surface rather than visually
 * preselecting an action. Input-first dialogs may provide `initialFocus`.
 */
export function useModalFocus(
  surface: Readonly<Ref<HTMLElement | null>>,
  options: UseModalFocusOptions = {},
): void {
  let returnFocus: HTMLElement | null = null;
  let listeningSurface: HTMLElement | null = null;
  let stopWatchingSurface: WatchStopHandle | null = null;
  let stopWatching: WatchStopHandle | null = null;

  function invokeDefault(event: KeyboardEvent): void {
    if (
      !options.onDefault
      || event.defaultPrevented
      || event.isComposing
      || event.key !== 'Enter'
      || event.repeat
      || event.altKey
      || event.ctrlKey
      || event.metaKey
      || event.shiftKey
      || event.target !== listeningSurface
    ) {
      return;
    }
    event.preventDefault();
    void options.onDefault();
  }

  function listenToSurface(element: HTMLElement | null): void {
    listeningSurface?.removeEventListener('keydown', invokeDefault);
    listeningSurface = element;
    listeningSurface?.addEventListener('keydown', invokeDefault);
  }

  async function activate(): Promise<void> {
    returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    await nextTick();
    focusModalSurface(options.initialFocus?.value ?? surface.value);
  }

  function restore(): void {
    const target = returnFocus;
    returnFocus = null;
    if (options.restoreFocus === false || !target) return;
    void nextTick(() => {
      if (target.isConnected) focusModalSurface(target);
    });
  }

  onMounted(() => {
    stopWatchingSurface = watch(
      surface,
      listenToSurface,
      { flush: 'post', immediate: true },
    );
    if (!options.active) {
      void activate();
      return;
    }
    stopWatching = watch(
      options.active,
      (active) => {
        if (active) void activate();
        else restore();
      },
      { flush: 'post', immediate: true },
    );
  });

  onBeforeUnmount(() => {
    stopWatchingSurface?.();
    stopWatching?.();
    listenToSurface(null);
    restore();
  });
}
