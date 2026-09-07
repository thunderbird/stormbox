<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  ref,
  watch,
} from 'vue';
import { MousePointer2 } from '@lucide/vue';

import { SPOTLIGHT_TIMING, type SpotlightPointer } from '../composables/useFeatureSpotlight';

/**
 * Visual layer for a running spotlight: a scrim that dims everything except
 * the targets and the stage, one ring per target selector (spanning the union
 * of that selector's matches so a section of several rows reads as one
 * highlight), and a simulated pointer that glides to and presses the control
 * a step is about to activate. Stage selectors are cut out of the scrim but
 * not ringed. Rings ease toward their targets each frame, so a step change
 * glides the ring rather than jumping it.
 */
const props = defineProps<{
  /** A spotlight is running; the scrim stays up between steps even with nothing ringed. */
  active: boolean;
  targets: string[];
  stage?: string[];
  pointer?: SpotlightPointer | null;
  /** Draw the scrim outside rings and stage; false leaves the UI at full brightness. */
  dim?: boolean;
  reducedMotion?: boolean;
}>();

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface Ring extends Rect {
  key: number;
  selector: string;
  goal: Rect;
}

interface Point {
  x: number;
  y: number;
}

interface PointerTween {
  from: Point;
  to: Point;
  startedAt: number;
}

const RING_INSET = 6;
const RING_RADIUS = 12;
/* Rings stay this far inside the viewport so the stroke and glow of a ring
   around an edge-to-edge element are never clipped. */
const RING_VIEWPORT_MARGIN = 10;
const STAGE_INSET = 0;
const STAGE_RADIUS = 12;
// Per-frame easing factor toward the goal rect; ~95% of the way in 18 frames.
const RING_EASE = 0.15;
const SCRIM_MASK_ID = 'spotlight-overlay-scrim-mask';

const rings = ref<Ring[]>([]);
const stages = ref<Ring[]>([]);
const pointerPosition = ref<Point | null>(null);
let pointerTween: PointerTween | null = null;
let frame: number | null = null;
let observer: ResizeObserver | null = null;

const stageSelectors = computed(() => props.stage ?? []);
const visible = computed(() => props.active);
const pointerVisible = computed(() => props.pointer != null && pointerPosition.value != null);

function unionRect(selector: string, inset = RING_INSET): Rect | null {
  let top = Infinity;
  let left = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  document.querySelectorAll(selector).forEach((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    top = Math.min(top, rect.top);
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  });
  if (!Number.isFinite(top)) return null;
  top -= inset;
  left -= inset;
  right += inset;
  bottom += inset;
  if (inset > 0) {
    top = Math.max(top, RING_VIEWPORT_MARGIN);
    left = Math.max(left, RING_VIEWPORT_MARGIN);
    right = Math.min(right, window.innerWidth - RING_VIEWPORT_MARGIN);
    bottom = Math.min(bottom, window.innerHeight - RING_VIEWPORT_MARGIN);
  }
  return { top, left, width: right - left, height: bottom - top };
}

function centerOf(rect: Rect): Point {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function viewportCenter(): Point {
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

// Ring slots are keyed by position so a step that swaps one selector for
// another glides the existing ring; only a change in ring count mounts or
// unmounts one. A selector that stops matching loses its ring at once, so a
// ring never sits where a control used to be.
function measureRings(): Ring[] {
  const next: Ring[] = [];
  for (const selector of props.targets) {
    const key = next.length;
    const previous = rings.value[key];
    const goal = unionRect(selector, RING_INSET);
    if (!goal) continue;
    next.push(previous && !props.reducedMotion
      ? { ...previous, key, selector, goal }
      : { ...goal, key, selector, goal });
  }
  return next;
}

// Stage cutouts track their surface exactly: a surface that has gone (the
// composer once minimized) must not leave a lit hole behind, so they neither
// hold a stale rect nor ease.
function measureStages(): Ring[] {
  const next: Ring[] = [];
  for (const selector of stageSelectors.value) {
    const goal = unionRect(selector, STAGE_INSET);
    if (!goal) continue;
    next.push({ ...goal, key: next.length, selector, goal });
  }
  return next;
}

function measure() {
  rings.value = measureRings();
  stages.value = measureStages();
}

function easeRings() {
  rings.value = rings.value.map((ring) => ({
    ...ring,
    top: ring.top + (ring.goal.top - ring.top) * RING_EASE,
    left: ring.left + (ring.goal.left - ring.left) * RING_EASE,
    width: ring.width + (ring.goal.width - ring.width) * RING_EASE,
    height: ring.height + (ring.goal.height - ring.height) * RING_EASE,
  }));
}

function advancePointer(now: number) {
  const tween = pointerTween;
  if (!tween) return;
  const t = Math.min(1, (now - tween.startedAt) / SPOTLIGHT_TIMING.pointerTravelMs);
  const k = easeInOutCubic(t);
  pointerPosition.value = {
    x: tween.from.x + (tween.to.x - tween.from.x) * k,
    y: tween.from.y + (tween.to.y - tween.from.y) * k,
  };
  if (t >= 1) pointerTween = null;
}

function startPointer(selector: string) {
  if (typeof document === 'undefined') return;
  const goal = unionRect(selector);
  if (!goal) {
    pointerPosition.value = null;
    pointerTween = null;
    return;
  }
  const to = centerOf({
    ...goal,
    top: goal.top + RING_INSET,
    left: goal.left + RING_INSET,
    width: goal.width - RING_INSET * 2,
    height: goal.height - RING_INSET * 2,
  });
  // A pointer that has not shown yet in this spotlight starts from the
  // viewport centre so it visibly travels to the control instead of
  // appearing on it; later presses continue from where it last was.
  const from = pointerPosition.value ?? viewportCenter();
  if (props.reducedMotion) {
    pointerPosition.value = to;
    pointerTween = null;
    return;
  }
  pointerTween = { from, to, startedAt: performance.now() };
  pointerPosition.value = from;
}

function stopLoop() {
  if (frame != null) {
    window.cancelAnimationFrame(frame);
    frame = null;
  }
  observer?.disconnect();
  observer = null;
  window.removeEventListener('resize', measure);
  window.removeEventListener('scroll', measure, true);
}

// Targets move while the composer opens, the dock animates, or a space
// switches, so with motion enabled the rings re-measure and ease every frame.
// Reduced motion measures once and then only on resize, scroll, or target
// size changes, snapping straight to the goal.
function startLoop() {
  stopLoop();
  if (typeof window === 'undefined') return;
  measure();
  window.addEventListener('resize', measure);
  window.addEventListener('scroll', measure, true);
  if (props.reducedMotion) {
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(measure);
      [...props.targets, ...stageSelectors.value].forEach((selector) => {
        document.querySelectorAll(selector).forEach((element) => observer?.observe(element));
      });
    }
    return;
  }
  const tick = (now: number) => {
    measure();
    easeRings();
    advancePointer(now);
    frame = window.requestAnimationFrame(tick);
  };
  frame = window.requestAnimationFrame(tick);
}

watch(
  () => [props.active, props.targets, stageSelectors.value, props.reducedMotion] as const,
  () => {
    if (!props.active) {
      stopLoop();
      rings.value = [];
      stages.value = [];
      return;
    }
    startLoop();
  },
  { immediate: true, flush: 'post' },
);

watch(
  () => props.pointer?.selector ?? null,
  (selector) => {
    if (selector) {
      startPointer(selector);
    } else {
      pointerTween = null;
    }
  },
  { immediate: true, flush: 'post' },
);

watch(visible, (isVisible) => {
  if (!isVisible) pointerPosition.value = null;
});

onBeforeUnmount(stopLoop);
</script>

<template>
  <div
    v-if="visible"
    class="spotlight-overlay"
    :class="{ 'spotlight-overlay--static': reducedMotion }"
    aria-hidden="true"
    data-testid="spotlight-overlay"
    :data-targets="targets.join(' ')"
    :data-stage="stageSelectors.length > 0 ? stageSelectors.join(' ') : undefined"
    :data-pointer="pointer?.selector"
    :data-dim="dim === false ? 'false' : undefined"
  >
    <svg v-if="dim !== false" class="spotlight-overlay__scrim" width="100%" height="100%">
      <defs>
        <mask :id="SCRIM_MASK_ID">
          <rect width="100%" height="100%" fill="#fff" />
          <rect
            v-for="area in stages"
            :key="`stage-${area.key}`"
            :x="area.left"
            :y="area.top"
            :width="area.width"
            :height="area.height"
            :rx="STAGE_RADIUS"
            fill="#000"
          />
          <rect
            v-for="ring in rings"
            :key="ring.key"
            :x="ring.left"
            :y="ring.top"
            :width="ring.width"
            :height="ring.height"
            :rx="RING_RADIUS"
            fill="#000"
          />
        </mask>
      </defs>
      <rect
        class="spotlight-overlay__shade"
        width="100%"
        height="100%"
        :mask="`url(#${SCRIM_MASK_ID})`"
      />
    </svg>
    <TransitionGroup name="spotlight-ring" type="transition">
      <span
        v-for="ring in rings"
        :key="ring.key"
        class="spotlight-overlay__ring"
        :data-target="ring.selector"
        :style="{
          top: `${ring.top}px`,
          left: `${ring.left}px`,
          width: `${ring.width}px`,
          height: `${ring.height}px`,
        }"
      />
    </TransitionGroup>
    <div
      class="spotlight-overlay__pointer"
      :class="{
        'spotlight-overlay__pointer--visible': pointerVisible,
        'spotlight-overlay__pointer--pressing': pointer?.pressing,
      }"
      :style="pointerPosition ? { transform: `translate(${pointerPosition.x}px, ${pointerPosition.y}px)` } : undefined"
    >
      <span class="spotlight-overlay__pointer-ripple" />
      <MousePointer2 class="spotlight-overlay__pointer-glyph" :size="24" :stroke-width="1.75" />
    </div>
  </div>
</template>

<style scoped>
/* Above the composer (50) and below the tour modals (100), whose panel is
   hidden while a spotlight runs and whose caption must stay undimmed. The
   scrim therefore covers the live UI but never the caption. */
.spotlight-overlay {
  position: fixed;
  inset: 0;
  /* Above dialogs the tour opens (folder manager at 120) so the pointer and
     rings stay visible over them; such dialogs are staged so the scrim does
     not cover them. Below the tour caption (130). */
  z-index: 125;
  pointer-events: none;
  animation: spotlight-overlay-in 0.45s ease both;
}
.spotlight-overlay__scrim {
  position: absolute;
  inset: 0;
  display: block;
}
.spotlight-overlay__shade {
  fill: color-mix(in srgb, #000 46%, transparent);
}
/* Solid accent stroke with a white halo inside it and a soft accent glow
 * outside, so the ring reads against both light and dark surfaces. */
.spotlight-overlay__ring {
  position: absolute;
  box-sizing: border-box;
  border: 3px solid var(--accent);
  border-radius: 12px;
  box-shadow:
    inset 0 0 0 2px color-mix(in srgb, #fff 85%, transparent),
    0 0 0 5px color-mix(in srgb, var(--accent) 38%, transparent),
    0 0 22px 4px color-mix(in srgb, var(--accent) 45%, transparent),
    0 14px 40px color-mix(in srgb, #000 30%, transparent);
  animation: spotlight-ring-pulse 1.6s ease-in-out infinite;
}
.spotlight-ring-enter-active,
.spotlight-ring-leave-active {
  transition: opacity 0.3s ease;
}
.spotlight-ring-enter-from,
.spotlight-ring-leave-to {
  opacity: 0;
}

.spotlight-overlay__pointer {
  position: absolute;
  top: 0;
  left: 0;
  opacity: 0;
  transition: opacity 0.25s ease;
  will-change: transform;
}
.spotlight-overlay__pointer--visible {
  opacity: 1;
}
.spotlight-overlay__pointer-glyph {
  position: absolute;
  top: -3px;
  left: -3px;
  color: #111;
  fill: #fff;
  filter: drop-shadow(0 2px 4px color-mix(in srgb, #000 45%, transparent));
  transform-origin: 3px 3px;
  transition: transform 0.12s ease;
}
.spotlight-overlay__pointer--pressing .spotlight-overlay__pointer-glyph {
  transform: scale(0.82);
}
.spotlight-overlay__pointer-ripple {
  position: absolute;
  top: -18px;
  left: -18px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--accent) 90%, #fff);
  opacity: 0;
}
.spotlight-overlay__pointer--pressing .spotlight-overlay__pointer-ripple {
  animation: spotlight-pointer-ripple 0.45s ease-out both;
}

.spotlight-overlay--static,
.spotlight-overlay--static .spotlight-overlay__ring,
.spotlight-overlay--static .spotlight-overlay__pointer-ripple {
  animation: none;
}
.spotlight-overlay--static .spotlight-ring-enter-active,
.spotlight-overlay--static .spotlight-ring-leave-active,
.spotlight-overlay--static .spotlight-overlay__pointer {
  transition: none;
}

@keyframes spotlight-overlay-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes spotlight-ring-pulse {
  0%, 100% {
    box-shadow:
      inset 0 0 0 2px color-mix(in srgb, #fff 85%, transparent),
      0 0 0 5px color-mix(in srgb, var(--accent) 38%, transparent),
      0 0 22px 4px color-mix(in srgb, var(--accent) 45%, transparent),
      0 14px 40px color-mix(in srgb, #000 30%, transparent);
  }
  50% {
    box-shadow:
      inset 0 0 0 2px color-mix(in srgb, #fff 85%, transparent),
      0 0 0 9px color-mix(in srgb, var(--accent) 26%, transparent),
      0 0 30px 8px color-mix(in srgb, var(--accent) 38%, transparent),
      0 14px 40px color-mix(in srgb, #000 30%, transparent);
  }
}
@keyframes spotlight-pointer-ripple {
  from {
    opacity: 0.9;
    transform: scale(0.3);
  }
  to {
    opacity: 0;
    transform: scale(1.4);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spotlight-overlay,
  .spotlight-overlay__ring,
  .spotlight-overlay__pointer-ripple {
    animation: none;
  }
}
</style>
