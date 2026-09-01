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
  containTab?: boolean;
  focusOnActivate?: boolean;
  focusableSelector?: string;
  initialFocus?: Readonly<Ref<HTMLElement | null>>;
  onDefault?: () => void | Promise<void>;
  resolveContainer?: () => HTMLElement | null;
  restoreFocus?: boolean;
}

const DEFAULT_FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'summary',
  '[contenteditable="true"]',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

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

  function focusableElements(container: HTMLElement): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>(
      options.focusableSelector ?? DEFAULT_FOCUSABLE_SELECTOR,
    )].filter((element) => {
      if (element.closest('details:not([open])')) return false;
      if (element.closest('[hidden], [aria-hidden="true"]')) return false;
      if (element.getAttribute('aria-disabled') === 'true') return false;
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
  }

  function containTab(event: KeyboardEvent): void {
    if (
      !options.containTab
      || event.defaultPrevented
      || event.key !== 'Tab'
      || options.active?.value === false
    ) {
      return;
    }
    const container = options.resolveContainer?.() ?? listeningSurface;
    if (!container) return;
    const focusable = focusableElements(container);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !focusable.includes(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

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
    listeningSurface?.removeEventListener('keydown', containTab, true);
    listeningSurface = element;
    listeningSurface?.addEventListener('keydown', invokeDefault);
    listeningSurface?.addEventListener('keydown', containTab, true);
  }

  async function activate(): Promise<void> {
    if (options.focusOnActivate === false) return;
    returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    await nextTick();
    focusModalSurface(options.initialFocus?.value ?? surface.value);
  }

  function restore(): void {
    const target = returnFocus;
    returnFocus = null;
    if (
      options.focusOnActivate === false
      || options.restoreFocus === false
      || !target
    ) {
      return;
    }
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
