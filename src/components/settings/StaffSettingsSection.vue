<script setup lang="ts">
/**
 * Staff-only rows of the settings dialog: a "Bolt colors" palette switch,
 * a "Refresh beacons" button that restarts the current announcement round
 * (OB-3.7), and a feature-code textbox that turns on a registered feature
 * flag for the signed-in account (`feature-flags-store`).
 */
import { computed, ref, watch } from 'vue';

import { useFeatureBeaconsStore } from '../../stores/feature-beacons-store';
import { featureForCode, useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useSettingsStore } from '../../stores/settings-store';

const emit = defineEmits<{
  close: [];
}>();

const beaconStore = useFeatureBeaconsStore();
const settingsStore = useSettingsStore();
const featureFlags = useFeatureFlagsStore();
const boltPalette = computed(() => settingsStore.get('palette') === 'bolt');
const code = ref('');
const failure = ref<string | null>(null);
const canSubmit = computed(() => code.value.trim().length > 0);

// A rejected code is only wrong until the user edits it.
watch(code, () => { failure.value = null; });

function togglePalette() {
  void settingsStore.update({ palette: boltPalette.value ? 'classic' : 'bolt' });
}

// The beacon layer stays hidden behind this dialog, so closing it shows
// the restarted round at once.
function refreshBeacons() {
  beaconStore.restart();
  emit('close');
}

function submitCode() {
  if (!canSubmit.value) return;
  if (featureForCode(code.value) == null) {
    failure.value = 'Unknown feature code.';
    return;
  }
  failure.value = null;
  if (featureFlags.activate(code.value)) code.value = '';
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

    <div class="settings-dialog__row">
      <div class="settings-dialog__row-text">
        <span class="settings-dialog__row-title">Feature beacons</span>
        <span class="settings-dialog__row-hint">Bring back this round's new-feature dots and the New pill as if you had never seen them.</span>
      </div>
      <button
        type="button"
        class="settings-dialog__btn"
        data-refresh-beacons
        @click="refreshBeacons"
      >
        Refresh beacons
      </button>
    </div>

    <form class="settings-dialog__section settings-dialog__section--flush" @submit.prevent="submitCode">
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
          :aria-describedby="failure ? 'feature-code-error' : undefined"
          data-feature-code
        />
      </label>
      <p
        v-if="failure"
        id="feature-code-error"
        class="settings-dialog__error"
        role="alert"
      >{{ failure }}</p>
      <div class="settings-dialog__actions">
        <button
          type="submit"
          class="settings-dialog__btn settings-dialog__btn--primary"
          :disabled="!canSubmit"
          data-feature-code-submit
        >Activate</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.settings-dialog__section--flush {
  padding: 0;
}
</style>
