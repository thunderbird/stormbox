<script setup lang="ts">
/**
 * Staff-only rows of the settings dialog. A "Bolt colors" palette switch
 * on top; below it, until the account has unlocked the feature, a single
 * code textbox, and afterwards an on/off switch for the board with a
 * retry when the sample-folder seed failed.
 *
 * Opening the section warms the board chunk, the seed module and the
 * audio clip, so when the code is accepted everything visible starts in
 * the same frame and only the network work runs afterwards. The
 * celebration itself is hosted by `KanbanCelebration`, which outlives
 * this dialog.
 */
import {
  computed, onMounted, ref, watch,
} from 'vue';

import { useMailStore } from '../../stores/mail-store';
import { useSettingsStore } from '../../stores/settings-store';
import { isUnlockCode, useKanbanStore } from './kanban-store';
import { preloadCelebrationAudio } from './celebration/audio';

const emit = defineEmits<{
  close: [];
}>();

const kanban = useKanbanStore();
const mailStore = useMailStore();
const settingsStore = useSettingsStore();
const boltPalette = computed(() => settingsStore.get('palette') === 'bolt');
const code = ref('');
const failure = ref<string | null>(null);
const canSubmit = computed(() => code.value.trim().length > 0);

const seedModule = () => import('./kanban-seed');
const boardModule = () => import('./KanbanBoard.vue');

onMounted(() => {
  preloadCelebrationAudio();
  if (!kanban.unlocked) {
    void seedModule().catch(() => {});
    void boardModule().catch(() => {});
  }
});

// A rejected code is only wrong until the user edits it.
watch(code, () => { failure.value = null; });

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

function submit() {
  if (kanban.unlocked) return;
  if (!canSubmit.value) return;
  if (!isUnlockCode(code.value)) {
    failure.value = 'Unknown feature code.';
    return;
  }
  failure.value = null;
  if (kanban.unlock()) {
    kanban.requestCelebration();
    runSeed();
  }
  emit('close');
}

function toggleEnabled() {
  kanban.setEnabled(!kanban.enabled);
}

function togglePalette() {
  void settingsStore.update({ palette: boltPalette.value ? 'classic' : 'bolt' });
}
</script>

<template>
  <div class="settings-dialog__section" data-staff-settings>
    <div class="settings-dialog__row">
      <div class="settings-dialog__row-text">
        <span id="palette-toggle-label" class="settings-dialog__row-title">Bolt colors</span>
        <span class="settings-dialog__row-hint">Cyan accent, Bolt surfaces and a taller nav bar. Off restores the previous blue palette and nav bar height.</span>
      </div>
      <button
        type="button"
        class="settings-dialog__switch"
        role="switch"
        :aria-checked="boltPalette"
        aria-labelledby="palette-toggle-label"
        data-palette-toggle
        @click="togglePalette"
      >
        <span class="settings-dialog__switch-knob" aria-hidden="true" />
      </button>
    </div>

    <form v-if="!kanban.unlocked" class="settings-dialog__section settings-dialog__section--flush" @submit.prevent="submit">
      <label class="settings-dialog__field">
        <span>Feature code</span>
        <input
          v-model="code"
          type="text"
          class="settings-dialog__input"
          autocomplete="off"
          spellcheck="false"
          placeholder="Enter a feature code"
          :aria-invalid="failure ? 'true' : undefined"
          :aria-describedby="failure ? 'kanban-unlock-error' : undefined"
          data-kanban-unlock-code
        />
      </label>
      <p
        v-if="failure"
        id="kanban-unlock-error"
        class="settings-dialog__error"
        role="alert"
      >{{ failure }}</p>
      <div class="settings-dialog__actions">
        <button
          type="submit"
          class="settings-dialog__btn settings-dialog__btn--primary"
          :disabled="!canSubmit"
          data-kanban-unlock-submit
        >Activate</button>
      </div>
    </form>

    <template v-else>
      <div class="settings-dialog__row">
        <div class="settings-dialog__row-text">
          <span id="kanban-toggle-label" class="settings-dialog__row-title">Kanban board</span>
          <span class="settings-dialog__row-hint">Show the current folder and two folders of your choice side by side.</span>
        </div>
        <button
          type="button"
          class="settings-dialog__switch"
          role="switch"
          :aria-checked="kanban.enabled"
          aria-labelledby="kanban-toggle-label"
          data-kanban-toggle
          @click="toggleEnabled"
        >
          <span class="settings-dialog__switch-knob" aria-hidden="true" />
        </button>
      </div>
      <p v-if="kanban.seedState === 'running'" class="settings-dialog__hint">Setting up your sample folders…</p>
      <p v-else-if="kanban.seedState === 'failed'" class="settings-dialog__error" role="alert">
        Sample folders could not be created{{ kanban.seedError ? `: ${kanban.seedError}` : '.' }}
      </p>
      <div v-if="kanban.seedState === 'failed'" class="settings-dialog__actions">
        <button
          type="button"
          class="settings-dialog__btn"
          data-kanban-seed-retry
          @click="runSeed"
        >Retry setup</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.settings-dialog__section--flush {
  padding: 0;
}
</style>
