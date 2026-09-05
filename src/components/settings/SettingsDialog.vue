<script setup lang="ts">
/**
 * The gear dialog. Every user gets the shortcut scheme picker and the
 * "follow system theme" switch. Staff additionally get a "Staff settings"
 * section below a rule; that section is an async chunk so non-staff never
 * download the kanban feature, fireworks or audio it carries.
 */
import {
  computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref,
} from 'vue';
import { X } from '@lucide/vue';

import { useModalFocus } from '../../composables/useModalFocus';
import { shortcutHint, type ShortcutAction } from '../../constants/shortcuts';
import { useAuthStore } from '../../stores/auth-store';
import { useSettingsStore } from '../../stores/settings-store';
import { isComposingKeyEvent } from '../../utils/keyboard';
import ShortcutSchemePicker from './ShortcutSchemePicker.vue';

const StaffSettingsSection = defineAsyncComponent(
  () => import('../../features/kanban/StaffSettingsSection.vue'),
);

defineProps<{
  /** The color scheme currently on screen; kept when "follow system" turns off. */
  appliedTheme: 'dark' | 'light';
}>();

const emit = defineEmits<{
  close: [];
}>();

const authStore = useAuthStore();
const settingsStore = useSettingsStore();
const dialogEl = ref<HTMLElement | null>(null);

useModalFocus(dialogEl, { containTab: true });

const followSystemTheme = computed(() => settingsStore.get('theme') === 'system');
const shortcutScheme = computed(() => settingsStore.get('shortcutScheme'));

const SAMPLE_ACTIONS: ReadonlyArray<{ action: ShortcutAction; label: string }> = [
  { action: 'compose', label: 'new message' },
  { action: 'reply', label: 'reply' },
  { action: 'archive', label: 'archive' },
  { action: 'quickFilter', label: 'Quick Filter' },
];

const schemeHint = computed(() => SAMPLE_ACTIONS
  .flatMap(({ action, label }) => {
    const keys = shortcutHint(action, shortcutScheme.value);
    return keys ? [`${keys} ${label}`] : [];
  })
  .join(' · '));

function toggleFollowSystemTheme(applied: 'dark' | 'light') {
  const theme = followSystemTheme.value ? applied : 'system';
  void settingsStore.update({ theme }).catch((error) => {
    console.warn('[settings] theme update failed', error);
  });
}

function onWindowKeydown(event: KeyboardEvent) {
  if (isComposingKeyEvent(event)) return;
  if (event.key === 'Escape') emit('close');
}

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown);
});
</script>

<template>
  <Teleport to="body">
    <div class="settings-dialog" role="presentation" @click.self="emit('close')">
      <section
        ref="dialogEl"
        class="settings-dialog__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        tabindex="-1"
        data-settings-dialog
      >
        <header class="settings-dialog__header">
          <h2 id="settings-dialog-title">Settings</h2>
          <button
            type="button"
            class="settings-dialog__close"
            aria-label="Close settings"
            @click="emit('close')"
          >
            <X :size="18" :stroke-width="2" aria-hidden="true" />
          </button>
        </header>

        <div class="settings-dialog__section">
          <div class="settings-dialog__row">
            <div class="settings-dialog__row-text">
              <span id="settings-shortcuts-label" class="settings-dialog__row-title">Keyboard shortcuts</span>
              <span class="settings-dialog__row-hint">{{ schemeHint }}</span>
            </div>
            <ShortcutSchemePicker labelled-by="settings-shortcuts-label" />
          </div>

          <div class="settings-dialog__row">
            <div class="settings-dialog__row-text">
              <span id="settings-system-theme-label" class="settings-dialog__row-title">Follow system theme</span>
              <span class="settings-dialog__row-hint">Match your device's light or dark setting. Off adds a light/dark button to the top bar.</span>
            </div>
            <button
              type="button"
              class="settings-dialog__switch"
              role="switch"
              :aria-checked="followSystemTheme"
              aria-labelledby="settings-system-theme-label"
              data-system-theme-toggle
              @click="toggleFollowSystemTheme(appliedTheme)"
            >
              <span class="settings-dialog__switch-knob" aria-hidden="true" />
            </button>
          </div>
        </div>

        <template v-if="authStore.isStaff">
          <hr class="settings-dialog__rule">
          <h3 class="settings-dialog__subtitle">Staff settings</h3>
          <StaffSettingsSection @close="emit('close')" />
        </template>
      </section>
    </div>
  </Teleport>
</template>

<style>
/* Unscoped: the staff section is a separate component but shares the
   dialog's row, switch and button styles. */
.settings-dialog {
  position: fixed;
  inset: 0;
  z-index: 130;
  display: grid;
  place-items: center;
  padding: 16px;
  background: color-mix(in srgb, #000 55%, transparent);
}
.settings-dialog__panel {
  width: min(460px, 100%);
  max-height: calc(100vh - 32px);
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--panel);
  color: var(--text);
  box-shadow: 0 24px 60px color-mix(in srgb, #000 40%, transparent);
}
.settings-dialog__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px 8px;
}
.settings-dialog__header h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}
.settings-dialog__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.settings-dialog__close:hover,
.settings-dialog__close:focus-visible {
  background: var(--rowHover);
  border-color: var(--border);
  color: var(--text);
  outline: none;
}
.settings-dialog__section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 6px 18px 16px;
}
.settings-dialog__rule {
  margin: 0 18px;
  border: 0;
  border-top: 1px solid var(--border-soft);
}
.settings-dialog__subtitle {
  margin: 14px 18px 0;
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.settings-dialog__field {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--muted);
}
.settings-dialog__field > span {
  flex-shrink: 0;
  width: 84px;
}
.settings-dialog__input {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 13px;
}
.settings-dialog__input:focus-visible {
  outline: none;
  border-color: var(--accent);
}
.settings-dialog__error {
  margin: 0;
  font-size: 12px;
  color: #d93025;
}
.settings-dialog__hint {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
.settings-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
.settings-dialog__btn {
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
}
.settings-dialog__btn:hover:not(:disabled) { background: var(--rowHover); }
.settings-dialog__btn:disabled { opacity: 0.55; cursor: default; }
.settings-dialog__btn--primary {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}
.settings-dialog__btn--primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 88%, #000);
}

.settings-dialog__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 6px 0;
}
.settings-dialog__row-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.settings-dialog__row-title {
  font-size: 14px;
  font-weight: 600;
}
.settings-dialog__row-hint {
  font-size: 12px;
  color: var(--muted);
}
.settings-dialog__switch {
  position: relative;
  flex-shrink: 0;
  width: 42px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--text) 12%, transparent);
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.settings-dialog__switch:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.settings-dialog__switch[aria-checked="true"] {
  background: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 80%, #000);
}
.settings-dialog__switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px color-mix(in srgb, #000 30%, transparent);
  transition: transform 0.15s ease;
}
.settings-dialog__switch[aria-checked="true"] .settings-dialog__switch-knob {
  transform: translateX(18px);
}
</style>
