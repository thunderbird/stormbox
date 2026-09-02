<script setup lang="ts">
/**
 * Staff-only gear in the top bar. Opens the unlock dialog and, on the
 * first unlock, fires the celebration and seeds the sample folders. The
 * board itself is mounted by App.vue off `kanban.enabled`.
 *
 * Ordering matters for the "no lag" feel: opening the dialog warms the
 * board chunk, the seed module and the audio clip, so when the code is
 * accepted everything visible starts in the same frame and only the
 * network work (folder + mail creation) runs afterwards.
 */
import { ref } from 'vue';
import { Settings } from '@lucide/vue';

import { useMailStore } from '../../stores/mail-store';
import { useKanbanStore } from './kanban-store';
import KanbanUnlockDialog from './KanbanUnlockDialog.vue';
import CelebrationVolume from './celebration/CelebrationVolume.vue';
import FireworksOverlay from './celebration/FireworksOverlay.vue';
import {
  playCelebrationAudio,
  preloadCelebrationAudio,
  whenCelebrationAudioEnds,
} from './celebration/audio';

const kanban = useKanbanStore();
const mailStore = useMailStore();
const open = ref(false);
const celebrating = ref(false);
const soundPlaying = ref(false);

const seedModule = () => import('./kanban-seed');
const boardModule = () => import('./KanbanBoard.vue');

function warmUp() {
  preloadCelebrationAudio();
  if (!kanban.unlocked) {
    void seedModule().catch(() => {});
    void boardModule().catch(() => {});
  }
}

function openDialog() {
  warmUp();
  open.value = true;
}

function runSeed() {
  if (kanban.seedState === 'running') return;
  kanban.setSeedState('running');
  void seedModule()
    .then((mod) => mod.seedKanbanFolders())
    .then(() => kanban.setSeedState('done'))
    .catch((err) => {
      const message = err?.message ?? String(err);
      console.warn('[kanban] seeding failed', err);
      kanban.setSeedState('failed', message);
      // The dialog closed on unlock, so the failure is surfaced in the
      // app's error toast as well as in the dialog on its next open.
      mailStore.error = `Sample folders could not be created: ${message}`;
    });
}

function onFirstUnlock() {
  soundPlaying.value = true;
  void playCelebrationAudio().then(whenCelebrationAudioEnds).then(() => {
    soundPlaying.value = false;
  });
  celebrating.value = true;
  runSeed();
}
</script>

<template>
  <button
    class="quick-filter__action"
    type="button"
    aria-label="Staff settings"
    title="Staff settings"
    data-staff-gear
    @click="openDialog"
  >
    <Settings :size="18" :stroke-width="1.75" aria-hidden="true" />
  </button>
  <KanbanUnlockDialog
    v-if="open"
    @close="open = false"
    @unlock="onFirstUnlock"
    @retry-seed="runSeed"
  />
  <FireworksOverlay v-if="celebrating" @done="celebrating = false" />
  <CelebrationVolume v-if="celebrating || soundPlaying" />
</template>
