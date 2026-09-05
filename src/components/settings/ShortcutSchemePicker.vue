<script setup lang="ts">
/**
 * Segmented radiogroup for the `shortcutScheme` setting. Writes through
 * the settings store, so every shortcut hint on screen follows the pick.
 */
import { computed } from 'vue';

import { SHORTCUT_SCHEME_VALUES, type ShortcutScheme } from '../../constants/settings';
import { SHORTCUT_SCHEME_LABELS } from '../../constants/shortcuts';
import { useSettingsStore } from '../../stores/settings-store';

defineProps<{
  /** Id of the element that names the group. */
  labelledBy: string;
}>();

const settingsStore = useSettingsStore();
const scheme = computed(() => settingsStore.get('shortcutScheme'));

const options = SHORTCUT_SCHEME_VALUES.map((value) => ({
  value,
  label: SHORTCUT_SCHEME_LABELS[value],
}));

function select(next: ShortcutScheme) {
  if (next === scheme.value) return;
  void settingsStore.update({ shortcutScheme: next }).catch((error) => {
    console.warn('[settings] shortcut scheme update failed', error);
  });
}

// Arrow keys move the checked radio, per the WAI-ARIA radiogroup pattern.
function onKeydown(event: KeyboardEvent) {
  let step = 0;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') step = 1;
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') step = -1;
  if (step === 0) return;
  event.preventDefault();
  const count = SHORTCUT_SCHEME_VALUES.length;
  const index = SHORTCUT_SCHEME_VALUES.indexOf(scheme.value);
  const next = SHORTCUT_SCHEME_VALUES[(index + step + count) % count];
  select(next);
  (event.currentTarget as HTMLElement | null)
    ?.querySelector<HTMLElement>(`[data-shortcut-scheme="${next}"]`)
    ?.focus();
}
</script>

<template>
  <div
    class="scheme-picker"
    role="radiogroup"
    :aria-labelledby="labelledBy"
    @keydown="onKeydown"
  >
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="scheme-picker__option"
      role="radio"
      :aria-checked="option.value === scheme"
      :tabindex="option.value === scheme ? 0 : -1"
      :data-shortcut-scheme="option.value"
      @click="select(option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>

<style scoped>
.scheme-picker {
  display: inline-flex;
  flex-shrink: 0;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--text) 6%, transparent);
}
.scheme-picker__option {
  padding: 4px 12px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
  transition: background 0.15s ease, color 0.15s ease;
}
.scheme-picker__option:hover {
  color: var(--text);
}
.scheme-picker__option:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.scheme-picker__option[aria-checked="true"] {
  background: var(--accent);
  color: #fff;
}
</style>
