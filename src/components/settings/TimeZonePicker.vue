<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';

import { useSettingsStore } from '../../stores/settings-store';
import { closeContainingDropdown } from '../../utils/dropdown';
import { isUsableTimeZone, searchTimeZoneOptions } from '../../utils/schedule-time';
import AppDropdown from '../AppDropdown.vue';

const settingsStore = useSettingsStore();
const timeZone = computed(() => settingsStore.get('timeZone'));
const search = ref('');
const searchEl = ref<HTMLInputElement | null>(null);
const summaryEl = ref<HTMLElement | null>(null);
const saving = ref(false);
const error = ref<string | null>(null);
const options = computed(() => searchTimeZoneOptions({
  search: search.value,
  currentTimeZone: timeZone.value,
  limit: 100,
}));

async function onToggle(event: Event): Promise<void> {
  if (!(event.target instanceof HTMLDetailsElement) || !event.target.open) return;
  search.value = '';
  await nextTick();
  searchEl.value?.focus();
}

async function select(zone: string, event: Event): Promise<void> {
  if (saving.value || !isUsableTimeZone(zone)) return;
  closeContainingDropdown(event);
  summaryEl.value?.focus();
  error.value = null;
  saving.value = true;
  try {
    await settingsStore.update({ timeZone: zone });
  } catch {
    error.value = 'The time zone could not be saved. Try again.';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="time-zone-picker">
    <AppDropdown :disabled="saving" data-time-zone-picker @toggle="onToggle">
      <summary
        ref="summaryEl"
        class="app-dropdown__summary app-dropdown__summary--control time-zone-picker__summary"
        :aria-label="`Time zone: ${timeZone}`"
        :aria-disabled="saving"
      >{{ timeZone }}</summary>
      <div class="app-dropdown__menu time-zone-picker__menu">
        <input
          ref="searchEl"
          v-model="search"
          class="time-zone-picker__search"
          type="search"
          aria-label="Search time zones"
          autocomplete="off"
        />
        <div class="time-zone-picker__options" role="group" aria-label="IANA time zones">
          <button
            v-for="option in options"
            :key="option.id"
            type="button"
            class="app-dropdown__item time-zone-picker__option"
            :aria-pressed="option.id === timeZone"
            @click="select(option.id, $event)"
          >{{ option.label }}</button>
          <p v-if="options.length === 0" class="time-zone-picker__message" role="status">
            No matching IANA time zone
          </p>
        </div>
      </div>
    </AppDropdown>
    <p v-if="saving" class="time-zone-picker__message" role="status">Saving…</p>
    <p v-if="error" class="time-zone-picker__error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.time-zone-picker { min-width: 0; width: 100%; }
.time-zone-picker__summary { display: flex; width: 100%; overflow-wrap: anywhere; }
.time-zone-picker__menu { position: static; margin-top: 6px; min-width: 0; max-height: none; }
.time-zone-picker__search {
  width: 100%;
  min-height: 34px;
  padding: 6px 8px;
  border: 1px solid var(--control-border);
  border-radius: 6px;
  background: var(--surface);
  color: inherit;
  font: inherit;
}
.time-zone-picker__search:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.time-zone-picker__options { display: grid; max-height: 190px; overflow-y: auto; }
.time-zone-picker__option { grid-template-columns: 1fr; overflow-wrap: anywhere; }
.time-zone-picker__option[aria-pressed='true'] { font-weight: 600; }
.time-zone-picker__message, .time-zone-picker__error { margin: 6px 0 0; font-size: 13px; }
.time-zone-picker__message { color: var(--muted); }
.time-zone-picker__error { color: var(--colour-ti-critical, #b3261e); }
</style>
