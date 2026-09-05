<script setup lang="ts">
/**
 * Persistent host for the first-unlock celebration: fireworks, the clip
 * and the docked volume pill. Mounted by App.vue for staff sessions so
 * the show survives the settings dialog closing on unlock.
 */
import { ref, watch } from 'vue';

import { useKanbanStore } from './kanban-store';
import CelebrationVolume from './celebration/CelebrationVolume.vue';
import FireworksOverlay from './celebration/FireworksOverlay.vue';
import { playCelebrationAudio, whenCelebrationAudioEnds } from './celebration/audio';

const kanban = useKanbanStore();
const celebrating = ref(false);
const soundPlaying = ref(false);

watch(() => kanban.celebrationRequests, (count, previous) => {
  if (count <= (previous ?? 0)) return;
  soundPlaying.value = true;
  void playCelebrationAudio().then(whenCelebrationAudioEnds).then(() => {
    soundPlaying.value = false;
  });
  celebrating.value = true;
});
</script>

<template>
  <FireworksOverlay v-if="celebrating" @done="celebrating = false" />
  <CelebrationVolume v-if="celebrating || soundPlaying" />
</template>
