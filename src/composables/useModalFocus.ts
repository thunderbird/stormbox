import { createFocusTrap, type FocusTrap } from 'focus-trap';
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
  initialFocus?: Readonly<Ref<HTMLElement | null>>;
  isolate?: boolean;
  onDefault?: () => void | Promise<void>;
  resolveContainer?: () => HTMLElement | null;
  restoreFocus?: boolean;
  restoreFallback?: () => HTMLElement | null;
  /**
   * Resolves where focus returns on deactivation, replacing the element
   * that was focused at activation. Called at restore time; null skips.
   */
  restoreTo?: () => HTMLElement | null;
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
  let initialReturnFocus: HTMLElement | null = null;
  let listeningSurface: HTMLElement | null = null;
  let trap: FocusTrap | null = null;
  let stopWatching: WatchStopHandle | null = null;
  let generation = 0;
  let activated = false;

  function invokeDefault(event: KeyboardEvent): void {
    if (
      !options.onDefault
      || options.active?.value === false
      || trap?.paused
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

  function restore(): void {
    const saved = returnFocus;
    returnFocus = null;
    if (options.restoreFocus === false) return;
    const restoredGeneration = generation;
    void nextTick(() => {
      if (generation !== restoredGeneration) return;
      const target = options.restoreTo ? options.restoreTo() : saved;
      if (options.restoreTo && !target) return;
      const summary = target?.closest('details:not([open])')
        ?.querySelector<HTMLElement>(':scope > summary');
      for (const candidate of [target, summary, options.restoreFallback?.(), initialReturnFocus]) {
        if (!candidate?.isConnected || candidate === document.body
          || candidate.closest('[inert]')) continue;
        focusModalSurface(candidate);
        if (document.activeElement === candidate) break;
      }
    });
  }

  function deactivate(): void {
    generation += 1;
    trap?.deactivate();
    trap = null;
    if (activated) restore();
    activated = false;
  }

  onMounted(() => {
    stopWatching = watch(
      () => [surface.value, options.active?.value !== false,
        options.resolveContainer?.() ?? surface.value] as const,
      async ([element, active, container]) => {
        listenToSurface(element);
        if (!element || !container || !active) {
          deactivate();
          return;
        }
        if (activated) {
          trap?.updateContainerElements(container);
          return;
        }
        activated = true;
        returnFocus = document.activeElement instanceof HTMLElement
          ? document.activeElement : null;
        if (returnFocus !== document.body) initialReturnFocus ??= returnFocus;
        const activationGeneration = ++generation;
        await nextTick();
        if (generation !== activationGeneration) return;
        if (options.containTab) {
          let initializing = true;
          trap = createFocusTrap(container, {
            initialFocus: () => initializing ? false : (options.resolveContainer?.() ?? element),
            delayInitialFocus: false,
            fallbackFocus: () => options.resolveContainer?.() ?? element,
            escapeDeactivates: false,
            allowOutsideClick: true,
            returnFocusOnDeactivate: false,
            isolateSubtrees: options.isolate ?? element.getAttribute('aria-modal') === 'true',
          });
          trap.activate();
          initializing = false;
        }
        if (options.focusOnActivate !== false) {
          focusModalSurface(options.initialFocus?.value ?? element);
        } else if (!container.contains(document.activeElement)) {
          focusModalSurface(container);
        }
      },
      { flush: 'post', immediate: true },
    );
  });

  onBeforeUnmount(() => {
    stopWatching?.();
    listenToSurface(null);
    deactivate();
  });
}
