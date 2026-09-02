<script setup lang="ts">
/**
 * Full-viewport fireworks overlay. Purely decorative: pointer-events are
 * off so the board underneath stays usable while the show runs. Emits
 * `done` when the last particle fades so the owner can unmount it.
 * Under prefers-reduced-motion the show is skipped and `done` fires at
 * once; the audio cue still marks the moment.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';

import { drawFireworks, FireworksShow } from './fireworks-engine';

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Approximate total show length. mm.mp3 runs ~15 s; the last burst fades
// as the music winds down rather than cutting out mid-clip.
const props = withDefaults(defineProps<{ durationMs?: number }>(), { durationMs: 12_000 });
const emit = defineEmits<{ done: [] }>();

const canvasEl = ref<HTMLCanvasElement | null>(null);
let frame: number | null = null;
let show: FireworksShow | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let lastTs = 0;
let cssWidth = 0;
let cssHeight = 0;

// Cap the backing store: a 4K display at DPR 2 would otherwise push
// ~33 MP of fill per frame through the fade pass.
const MAX_DPR = 1.5;

function fitCanvas() {
  const canvas = canvasEl.value;
  if (!canvas) return;
  cssWidth = window.innerWidth;
  cssHeight = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  ctx = canvas.getContext('2d');
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  show?.resize(cssWidth, cssHeight);
}

function tick(ts: number) {
  frame = null;
  if (!show || !ctx) return;
  const dt = lastTs === 0 ? 16 : ts - lastTs;
  lastTs = ts;
  show.step(dt);
  drawFireworks(ctx, show, cssWidth, cssHeight);
  if (show.finished) {
    emit('done');
    return;
  }
  frame = requestAnimationFrame(tick);
}

onMounted(() => {
  if (prefersReducedMotion()) {
    emit('done');
    return;
  }
  fitCanvas();
  if (!ctx) {
    emit('done');
    return;
  }
  show = new FireworksShow(cssWidth, cssHeight, { durationMs: props.durationMs });
  window.addEventListener('resize', fitCanvas);
  frame = requestAnimationFrame(tick);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', fitCanvas);
  if (frame != null) cancelAnimationFrame(frame);
  frame = null;
  show = null;
});
</script>

<template>
  <Teleport to="body">
    <canvas
      ref="canvasEl"
      class="kanban-fireworks"
      aria-hidden="true"
      data-kanban-fireworks
    />
  </Teleport>
</template>

<style scoped>
.kanban-fireworks {
  position: fixed;
  inset: 0;
  z-index: 200;
  pointer-events: none;
}
</style>
