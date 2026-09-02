<script setup lang="ts">
/**
 * The gear dialog. Until the account has unlocked the feature it is a
 * single code textbox; afterwards it is an on/off switch for the board,
 * with a retry when the sample-folder seed failed. Emits `unlock` (first
 * time only), `retry-seed` and `close`; the caller owns the celebration,
 * seeding and flag persistence.
 */
import {
  computed, onBeforeUnmount, onMounted, ref, watch,
} from 'vue';
import { X } from '@lucide/vue';

import { useModalFocus } from '../../composables/useModalFocus';
import { isComposingKeyEvent } from '../../utils/keyboard';
import { isUnlockCode, useKanbanStore } from './kanban-store';

const emit = defineEmits<{
  close: [];
  /** Fired once, inside the accepting user gesture, on the first unlock. */
  unlock: [];
  /** Re-run the sample-folder seed after a failure; never celebrates. */
  'retry-seed': [];
}>();

const kanban = useKanbanStore();
const dialogEl = ref<HTMLElement | null>(null);
const codeEl = ref<HTMLInputElement | null>(null);
const code = ref('');
const failure = ref<string | null>(null);

useModalFocus(dialogEl, {
  containTab: true,
  initialFocus: computed(() => codeEl.value),
  onDefault: submit,
});

const canSubmit = computed(() => code.value.trim().length > 0);

// A rejected code is only wrong until the user edits it.
watch(code, () => { failure.value = null; });

function submit() {
  if (kanban.unlocked) return;
  if (!canSubmit.value) return;
  if (!isUnlockCode(code.value)) {
    failure.value = 'Unknown feature code.';
    return;
  }
  failure.value = null;
  const first = kanban.unlock();
  if (first) emit('unlock');
  emit('close');
}

function toggleEnabled() {
  kanban.setEnabled(!kanban.enabled);
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
    <div class="kanban-unlock" role="presentation" @click.self="emit('close')">
      <section
        ref="dialogEl"
        class="kanban-unlock__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kanban-unlock-title"
        tabindex="-1"
        data-kanban-unlock-dialog
      >
        <header class="kanban-unlock__header">
          <h2 id="kanban-unlock-title">Staff settings</h2>
          <button
            type="button"
            class="kanban-unlock__close"
            aria-label="Close staff settings"
            @click="emit('close')"
          >
            <X :size="18" :stroke-width="2" aria-hidden="true" />
          </button>
        </header>

        <form v-if="!kanban.unlocked" class="kanban-unlock__form" @submit.prevent="submit">
          <label class="kanban-unlock__field">
            <span>Feature code</span>
            <input
              ref="codeEl"
              v-model="code"
              type="text"
              class="kanban-unlock__input"
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
            class="kanban-unlock__error"
            role="alert"
          >{{ failure }}</p>
          <div class="kanban-unlock__actions">
            <button type="button" class="kanban-unlock__btn" @click="emit('close')">Cancel</button>
            <button
              type="submit"
              class="kanban-unlock__btn kanban-unlock__btn--primary"
              :disabled="!canSubmit"
              data-kanban-unlock-submit
            >Activate</button>
          </div>
        </form>

        <div v-else class="kanban-unlock__form">
          <div class="kanban-unlock__row">
            <div class="kanban-unlock__row-text">
              <span id="kanban-toggle-label" class="kanban-unlock__row-title">Kanban board</span>
              <span class="kanban-unlock__row-hint">Show the current folder and two folders of your choice side by side.</span>
            </div>
            <button
              type="button"
              class="kanban-unlock__switch"
              role="switch"
              :aria-checked="kanban.enabled"
              aria-labelledby="kanban-toggle-label"
              data-kanban-toggle
              @click="toggleEnabled"
            >
              <span class="kanban-unlock__switch-knob" aria-hidden="true" />
            </button>
          </div>
          <p v-if="kanban.seedState === 'running'" class="kanban-unlock__hint">Setting up your sample folders…</p>
          <p v-else-if="kanban.seedState === 'failed'" class="kanban-unlock__error" role="alert">
            Sample folders could not be created{{ kanban.seedError ? `: ${kanban.seedError}` : '.' }}
          </p>
          <div class="kanban-unlock__actions">
            <button
              v-if="kanban.seedState === 'failed'"
              type="button"
              class="kanban-unlock__btn"
              data-kanban-seed-retry
              @click="emit('retry-seed')"
            >Retry setup</button>
            <button type="button" class="kanban-unlock__btn" @click="emit('close')">Done</button>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.kanban-unlock {
  position: fixed;
  inset: 0;
  z-index: 130;
  display: grid;
  place-items: center;
  padding: 16px;
  background: color-mix(in srgb, #000 55%, transparent);
}
.kanban-unlock__panel {
  width: min(420px, 100%);
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--panel);
  color: var(--text);
  box-shadow: 0 24px 60px color-mix(in srgb, #000 40%, transparent);
}
.kanban-unlock__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px 8px;
}
.kanban-unlock__header h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}
.kanban-unlock__close {
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
.kanban-unlock__close:hover,
.kanban-unlock__close:focus-visible {
  background: var(--rowHover);
  border-color: var(--border);
  color: var(--text);
  outline: none;
}
.kanban-unlock__form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 6px 18px 16px;
}
.kanban-unlock__field {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--muted);
}
.kanban-unlock__field > span {
  flex-shrink: 0;
  width: 84px;
}
.kanban-unlock__input {
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
.kanban-unlock__input:focus-visible {
  outline: none;
  border-color: var(--accent);
}
.kanban-unlock__error {
  margin: 0;
  font-size: 12px;
  color: #d93025;
}
.kanban-unlock__hint {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
.kanban-unlock__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
.kanban-unlock__btn {
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
}
.kanban-unlock__btn:hover:not(:disabled) { background: var(--rowHover); }
.kanban-unlock__btn:disabled { opacity: 0.55; cursor: default; }
.kanban-unlock__btn--primary {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}
.kanban-unlock__btn--primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 88%, #000);
}

.kanban-unlock__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 6px 0;
}
.kanban-unlock__row-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.kanban-unlock__row-title {
  font-size: 14px;
  font-weight: 600;
}
.kanban-unlock__row-hint {
  font-size: 12px;
  color: var(--muted);
}
.kanban-unlock__switch {
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
.kanban-unlock__switch:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.kanban-unlock__switch[aria-checked="true"] {
  background: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 80%, #000);
}
.kanban-unlock__switch-knob {
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
.kanban-unlock__switch[aria-checked="true"] .kanban-unlock__switch-knob {
  transform: translateX(18px);
}
</style>
