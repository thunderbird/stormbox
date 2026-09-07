import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
} from 'vue';
import type { SpotlightId } from '../constants/feature-tour';

/**
 * One phase of a spotlight. `targets` are CSS selectors; the overlay draws one
 * ring around the union of each selector's matches. When no primary selector
 * matches anything (for example a folder tree with no favorites yet), the
 * first `fallbackTargets` selector that matches is ringed instead.
 *
 * `stage` selectors are left undimmed by the scrim without being ringed, so a
 * surface the targets live on (the composer card) stays readable while only
 * the control itself is highlighted.
 *
 * `caption` is read out in the tour caption for the whole step. With `press`
 * set, a simulated pointer travels to that control and presses it before
 * `prepare` applies the change the press stands for, so the user sees which
 * control caused what happened next.
 */
export interface SpotlightStep {
  caption: string;
  targets: string[];
  fallbackTargets?: string[];
  stage?: string[];
  durationMs: number;
  press?: string;
  prepare?: () => Promise<void> | void;
}

export interface SpotlightScript {
  steps: SpotlightStep[];
  /** Dim everything outside the rings and stage (default true); rings alone otherwise. */
  dim?: boolean;
  cleanup?: () => Promise<void> | void;
}

export type SpotlightScripts = Record<SpotlightId, SpotlightScript>;

export interface SpotlightPointer {
  selector: string;
  pressing: boolean;
}

export interface SpotlightProgress {
  caption: string;
  index: number;
  count: number;
}

/** Phase lengths in ms; all but `hold` collapse to zero under reduced motion. */
export const SPOTLIGHT_TIMING = {
  /** Pointer glide from its previous position to the pressed control. */
  pointerTravelMs: 750,
  /** Pressed state on the control before `prepare` fires. */
  pointerPressMs: 240,
  /** Wait after `prepare` so the UI it changed finishes animating before the ring lands. */
  settleMs: 480,
} as const;

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

// Unmatched primary selectors are dropped; with none matched the first
// matching fallback is used. When nothing matches at all the declared targets
// are kept so the step is still observable (the overlay has nothing to ring).
function resolveTargets(step: SpotlightStep): string[] {
  if (typeof document === 'undefined') return step.targets;
  const matched = step.targets.filter((selector) => document.querySelector(selector) != null);
  if (matched.length > 0) return matched;
  const fallback = (step.fallbackTargets ?? [])
    .find((selector) => document.querySelector(selector) != null);
  return fallback ? [fallback] : step.targets;
}

function selectorExists(selector: string): boolean {
  return typeof document !== 'undefined' && document.querySelector(selector) != null;
}

/**
 * Runs scripted spotlights. Each step: optional pointer travel and press (the
 * pressed control is ringed while the pointer travels to it), `prepare`, a
 * settle pause, then its targets ring for `durationMs` while the caption
 * shows the step text. Rings are cleared the moment a press or `prepare`
 * changes the UI, so nothing stays highlighted in a space its control has
 * left. `run` is cancellable at any await point; cancellation and natural
 * completion both run the script's cleanup exactly once.
 */
export function useFeatureSpotlight(scripts: () => SpotlightScripts) {
  const active = ref<SpotlightId | null>(null);
  const step = ref(0);
  const stepCount = ref(0);
  const caption = ref('');
  const targets = shallowRef<string[]>([]);
  const stage = shallowRef<string[]>([]);
  const pointer = shallowRef<SpotlightPointer | null>(null);
  const dim = ref(true);
  const reducedMotion = ref(false);

  let generation = 0;
  let timer: number | null = null;
  let wake: (() => void) | null = null;
  let cleanupCurrent: (() => Promise<void>) | null = null;
  let media: MediaQueryList | null = null;

  const running = computed(() => active.value != null);
  const progress = computed<SpotlightProgress | null>(() => (
    active.value == null
      ? null
      : { caption: caption.value, index: step.value, count: stepCount.value }
  ));

  function onMediaChange(event: MediaQueryListEvent | MediaQueryList) {
    reducedMotion.value = event.matches;
  }

  function clearTimer() {
    if (timer != null) {
      window.clearTimeout(timer);
      timer = null;
    }
    const resume = wake;
    wake = null;
    resume?.();
  }

  function wait(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      wake = resolve;
      timer = window.setTimeout(() => {
        timer = null;
        wake = null;
        resolve();
      }, ms);
    });
  }

  function motionMs(ms: number): number {
    return reducedMotion.value ? 0 : ms;
  }

  async function finish(myGeneration: number) {
    if (myGeneration !== generation) return;
    const cleanup = cleanupCurrent;
    cleanupCurrent = null;
    active.value = null;
    step.value = 0;
    stepCount.value = 0;
    caption.value = '';
    targets.value = [];
    stage.value = [];
    pointer.value = null;
    await cleanup?.();
  }

  async function cancel(): Promise<void> {
    if (active.value == null && cleanupCurrent == null) return;
    generation += 1;
    const myGeneration = generation;
    clearTimer();
    await finish(myGeneration);
  }

  async function run(id: SpotlightId): Promise<void> {
    await cancel();
    const script = scripts()[id];
    generation += 1;
    const myGeneration = generation;
    const isCurrent = () => myGeneration === generation;

    active.value = id;
    step.value = 0;
    stepCount.value = script.steps.length;
    caption.value = script.steps[0]?.caption ?? '';
    targets.value = [];
    stage.value = [];
    pointer.value = null;
    dim.value = script.dim ?? true;
    cleanupCurrent = async () => { await script.cleanup?.(); };

    for (let index = 0; index < script.steps.length; index += 1) {
      const current = script.steps[index];
      step.value = index;
      caption.value = current.caption;

      // The pointer only plays when there is a control to travel to and the
      // user has not asked for reduced motion; the change itself still happens.
      if (current.press && !reducedMotion.value && selectorExists(current.press)) {
        targets.value = [current.press];
        pointer.value = { selector: current.press, pressing: false };
        await wait(SPOTLIGHT_TIMING.pointerTravelMs);
        if (!isCurrent()) return;
        pointer.value = { selector: current.press, pressing: true };
        await wait(SPOTLIGHT_TIMING.pointerPressMs);
        if (!isCurrent()) return;
      }

      if (current.prepare) {
        targets.value = [];
        // The stage is declared before `prepare` so UI it mounts (the
        // composer, the dock) is undimmed from its first frame; the overlay
        // ignores stage selectors with nothing on screen yet.
        stage.value = current.stage ?? [];
        await current.prepare();
        if (!isCurrent()) return;
      }
      pointer.value = null;
      // Two ticks: one for reactive state from `prepare`, one for children
      // (such as the composer) that mount in response to it.
      await nextTick();
      await nextTick();
      if (!isCurrent()) return;
      if (current.prepare) {
        await wait(motionMs(SPOTLIGHT_TIMING.settleMs));
        if (!isCurrent()) return;
      }
      targets.value = resolveTargets(current);
      stage.value = (current.stage ?? []).filter(selectorExists);
      await wait(current.durationMs);
      if (!isCurrent()) return;
    }
    await finish(myGeneration);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || active.value == null || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    void cancel();
  }

  onMounted(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('keydown', onKeydown, true);
    if (typeof window.matchMedia !== 'function') return;
    media = window.matchMedia(REDUCED_MOTION_QUERY);
    reducedMotion.value = media.matches;
    media.addEventListener?.('change', onMediaChange);
  });

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown, true);
    media?.removeEventListener?.('change', onMediaChange);
    media = null;
    void cancel();
  });

  return {
    active,
    step,
    stepCount,
    caption,
    progress,
    targets,
    stage,
    pointer,
    dim,
    running,
    reducedMotion,
    run,
    cancel,
  };
}
