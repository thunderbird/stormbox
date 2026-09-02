<script setup lang="ts">
/**
 * Volume pill docked at the bottom of the viewport for as long as the
 * celebration plays. Drives the clip's gain directly; the speaker button
 * mutes and restores the previous level.
 */
import { onBeforeUnmount, ref } from 'vue';
import { Volume1, Volume2, VolumeX } from '@lucide/vue';

import {
  DEFAULT_CELEBRATION_VOLUME,
  getCelebrationVolume,
  onCelebrationVolumeChange,
  setCelebrationVolume,
} from './audio';

const volume = ref(getCelebrationVolume());
const lastAudible = ref(volume.value > 0 ? volume.value : DEFAULT_CELEBRATION_VOLUME);
const stopWatching = onCelebrationVolumeChange((value) => { volume.value = value; });
onBeforeUnmount(stopWatching);

function onInput(event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  if (value > 0) lastAudible.value = value;
  setCelebrationVolume(value);
}

function toggleMute() {
  setCelebrationVolume(volume.value > 0 ? 0 : lastAudible.value);
}
</script>

<template>
  <Teleport to="body">
    <div class="celebration-volume" data-kanban-volume>
      <button
        type="button"
        class="celebration-volume__mute"
        :aria-label="volume > 0 ? 'Mute celebration' : 'Unmute celebration'"
        :aria-pressed="volume === 0"
        data-kanban-volume-mute
        @click="toggleMute"
      >
        <VolumeX v-if="volume === 0" :size="18" aria-hidden="true" />
        <Volume1 v-else-if="volume < 0.5" :size="18" aria-hidden="true" />
        <Volume2 v-else :size="18" aria-hidden="true" />
      </button>
      <input
        class="celebration-volume__slider"
        type="range"
        min="0"
        max="1"
        step="0.01"
        :value="volume"
        aria-label="Celebration volume"
        :aria-valuetext="`${Math.round(volume * 100)}%`"
        data-kanban-volume-slider
        @input="onInput"
      >
      <span class="celebration-volume__value" aria-hidden="true">{{ Math.round(volume * 100) }}%</span>
    </div>
  </Teleport>
</template>

<style scoped>
.celebration-volume {
  position: fixed;
  bottom: 20px;
  left: 50%;
  z-index: 210;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px 8px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel);
  color: var(--text);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  transform: translateX(-50%);
  animation: celebration-volume-in 220ms ease-out;
}
.celebration-volume__mute {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.celebration-volume__mute:hover {
  background: color-mix(in srgb, var(--text) 8%, transparent);
}
.celebration-volume__mute:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.celebration-volume__slider {
  width: 160px;
  accent-color: var(--accent);
}
.celebration-volume__value {
  min-width: 4ch;
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
@keyframes celebration-volume-in {
  from {
    opacity: 0;
    transform: translate(-50%, 12px);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .celebration-volume {
    animation: none;
  }
}
</style>
