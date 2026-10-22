<script setup lang="ts">
import {
  VueDatePicker,
  type InternalModelValue,
  type ModelValue,
} from '@vuepic/vue-datepicker';
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
} from 'vue';

import { useModalFocus } from '../composables/useModalFocus';
import {
  detectTimeZone,
  instantToWallTime,
  isUsableTimeZone,
  pickerValueToWallTime,
  resolveCustomSchedule,
  scheduleClockWindowFromReference,
  type ServerClockReferenceLike,
  wallTimeToPickerValue,
} from '../utils/schedule-time';
import AppButton from './AppButton.vue';

const props = defineProps<{
  busy: boolean;
  error?: string | null;
  maxDelayedSend: number;
  serverClockReference: ServerClockReferenceLike | null;
  sessionId: string;
  timeZone: string;
}>();

const emit = defineEmits<{
  'clear-error': [];
  close: [];
  select: [targetAt: string, timeZone: string];
}>();

const dialogEl = ref<HTMLElement | null>(null);
useModalFocus(dialogEl, {
  containTab: true,
  onDefault: submit,
  restoreFocus: false,
});

const selectedTimeZone = computed(() =>
  isUsableTimeZone(props.timeZone) ? props.timeZone : detectTimeZone(),
);
const localError = ref<string | null>(null);
const internalPickerValue = ref<InternalModelValue>(null);
const internalInvalidMessage = ref<string | null>(null);
const currentTimeMs = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | null = null;
const overlayOpeners = new Map<string, HTMLElement>();
const pickerConfig = { closeOnAutoApply: false, onInternalKeydown: onPickerKeydown };
const timeConfig = {
  enableTimePicker: true,
  enableSeconds: false,
  is24: false,
  minutesIncrement: 1,
  timePickerInline: true,
};

function pickerValueAt(instantMs: number): string | null {
  const wall = instantToWallTime(instantMs, selectedTimeZone.value);
  return wall ? wallTimeToPickerValue(wall) : null;
}

function initialPickerValue(): string | null {
  const now = currentTimeMs.value;
  const clock = scheduleClockWindowFromReference(props.serverClockReference, now);
  const latest = clock.lowerMs + props.maxDelayedSend * 1_000;
  const nextQuarterHour = Math.ceil((clock.upperMs + 15 * 60_000) / (15 * 60_000))
    * 15 * 60_000;
  const target = Math.min(nextQuarterHour, latest);
  return pickerValueAt(target);
}

const pickerValue = ref<ModelValue>(initialPickerValue());
const minPickerDate = computed(() => {
  const clock = scheduleClockWindowFromReference(
    props.serverClockReference,
    currentTimeMs.value,
  );
  return pickerValueAt(clock.upperMs);
});
const maxPickerDate = computed(() => {
  const clock = scheduleClockWindowFromReference(
    props.serverClockReference,
    currentTimeMs.value,
  );
  return pickerValueAt(clock.lowerMs + props.maxDelayedSend * 1_000);
});
const selectedValue = computed(() => internalPickerValue.value ?? pickerValue.value);
const customResolution = computed(() => {
  const wallTime = pickerValueToWallTime(selectedValue.value);
  if (!wallTime) {
    return {
      ok: false as const,
      reason: 'invalidWallTime' as const,
      message: 'Choose a valid date and time.',
    };
  }
  return resolveCustomSchedule({
    wallTime,
    timeZone: selectedTimeZone.value,
    maxDelayedSend: props.maxDelayedSend,
    serverClockReference: props.serverClockReference,
    localNowMs: currentTimeMs.value,
  });
});
const displayedError = computed(() => {
  if (localError.value) return localError.value;
  if (props.error) return props.error;
  if (internalInvalidMessage.value) return internalInvalidMessage.value;
  const resolution = customResolution.value;
  if (resolution && !resolution.ok && 'message' in resolution) {
    return resolution.message;
  }
  return null;
});
const showResolvedStatus = computed(() =>
  !displayedError.value && customResolution.value.ok);
const resolvedStatus = computed(() =>
  (customResolution.value.ok ? customResolution.value : null));
function close(): void {
  if (!props.busy) emit('close');
}

function submit(): void {
  if (props.busy || internalInvalidMessage.value) return;
  currentTimeMs.value = Date.now();
  localError.value = null;
  const wallTime = pickerValueToWallTime(selectedValue.value);
  if (!wallTime) {
    localError.value = 'Choose a valid date and time.';
    return;
  }
  const resolution = resolveCustomSchedule({
    wallTime,
    timeZone: selectedTimeZone.value,
    maxDelayedSend: props.maxDelayedSend,
    serverClockReference: props.serverClockReference,
    localNowMs: currentTimeMs.value,
  });
  if ('message' in resolution) {
    localError.value = resolution.message;
    return;
  }
  emit('select', resolution.targetAt, selectedTimeZone.value);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !event.defaultPrevented) {
    event.preventDefault();
    event.stopPropagation();
    const overlay = dialogEl.value?.querySelector<HTMLElement>('[role="listbox"]');
    if (overlay) {
      // Inline overlays also receive Escape when focus has moved outside them.
      if (!overlay.contains(event.target as Node)) {
        overlay.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', bubbles: true, cancelable: true,
        }));
      }
      return;
    }
    close();
  }
}

function onPickerKeydown(event: KeyboardEvent): false | void {
  if (event.key === 'Escape') {
    onKeydown(event);
    return false;
  }
}

async function onOverlayToggle({ open, overlay }: { open: boolean; overlay: string }): Promise<void> {
  if (open) {
    if (document.activeElement instanceof HTMLElement) {
      overlayOpeners.set(overlay, document.activeElement);
    }
    await nextTick();
    const listbox = dialogEl.value?.querySelector<HTMLElement>('[role="listbox"]');
    const target = listbox?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]:not([aria-disabled="true"])')
      ?? listbox?.querySelector<HTMLElement>('[role="option"]:not([aria-disabled="true"])');
    target?.focus({ preventScroll: true });
  } else {
    const opener = overlayOpeners.get(overlay);
    overlayOpeners.delete(overlay);
    await nextTick();
    // The picker's arrow navigation restores focus over two animation frames.
    await nextTick();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    if (overlayOpeners.size === 0 && opener?.isConnected && dialogEl.value?.contains(opener)) {
      opener.focus({ preventScroll: true });
    }
  }
}

function updatePickerValue(value: ModelValue): void {
  pickerValue.value = value;
  internalPickerValue.value = null;
  localError.value = null;
  internalInvalidMessage.value = null;
  emit('clear-error');
}

function onInternalModelChange(value: InternalModelValue): void {
  // Inline time controls can re-emit the same wall time after a parent render.
  if (value instanceof Date && internalPickerValue.value instanceof Date
    && Object.is(value.getTime(), internalPickerValue.value.getTime())) return;
  internalPickerValue.value = value;
  internalInvalidMessage.value = null;
  localError.value = null;
  emit('clear-error');
}

function onInvalidDate(date: Date): void {
  const wallTime = pickerValueToWallTime(date);
  if (!wallTime) {
    internalInvalidMessage.value = 'Choose a valid date and time.';
    return;
  }
  const resolution = resolveCustomSchedule({
    wallTime,
    timeZone: selectedTimeZone.value,
    maxDelayedSend: props.maxDelayedSend,
    serverClockReference: props.serverClockReference,
    localNowMs: currentTimeMs.value,
  });
  internalInvalidMessage.value = 'message' in resolution ? resolution.message : null;
}

function onInvalidSelect(): void {
  internalInvalidMessage.value = 'Choose a valid date and time.';
}

onMounted(() => {
  clockTimer = setInterval(() => {
    currentTimeMs.value = Date.now();
  }, 30_000);
});

onBeforeUnmount(() => {
  if (clockTimer != null) clearInterval(clockTimer);
  clockTimer = null;
});
</script>

<template>
  <Teleport to="body">
    <div class="schedule-dialog__backdrop" @pointerdown.self="close">
      <section
        ref="dialogEl"
        class="schedule-dialog"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="`schedule-dialog-title-${sessionId}`"
        :aria-describedby="`schedule-dialog-zone-${sessionId}`"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <header>
          <div>
            <h3 :id="`schedule-dialog-title-${sessionId}`">Choose a date and time</h3>
            <p :id="`schedule-dialog-zone-${sessionId}`">
              Current time zone: <strong>{{ selectedTimeZone }}</strong>
            </p>
          </div>
          <button
            type="button"
            class="schedule-dialog__close"
            aria-label="Close schedule dialog"
            title="Close"
            :disabled="busy"
            @click="close"
          >×</button>
        </header>

        <VueDatePicker
          class="schedule-dialog__picker"
          :model-value="pickerValue"
          :min-date="minPickerDate"
          :max-date="maxPickerDate"
          :time-config="timeConfig"
          :disabled="busy"
          inline
          auto-apply
          arrow-navigation
          prevent-min-max-navigation
          :transitions="false"
          :config="pickerConfig"
          @overlay-toggle="onOverlayToggle"
          model-type="iso"
          timezone="UTC"
          @update:model-value="updatePickerValue"
          @internal-model-change="onInternalModelChange"
          @invalid-date="onInvalidDate"
          @invalid-select="onInvalidSelect"
        />

        <p
          v-if="displayedError"
          class="schedule-dialog__error"
          role="alert"
        >{{ displayedError }}</p>
        <p
          v-else-if="showResolvedStatus"
          class="schedule-dialog__resolved"
          role="status"
        >
          Sends {{ resolvedStatus.resolvedLabel }}.
          <span v-if="resolvedStatus.ambiguous">
            This time occurs twice; the earlier occurrence will be used.
          </span>
        </p>

        <div class="schedule-dialog__actions">
          <AppButton variant="outline" :disabled="busy" @click="close">
            Cancel
          </AppButton>
          <AppButton
            class="schedule-dialog__submit"
            :disabled="busy || !customResolution.ok || !!internalInvalidMessage"
            @click="submit"
          >
            {{ busy ? 'Setting…' : 'Set send time' }}
          </AppButton>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.schedule-dialog__backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  padding: 16px;
  background: var(--modal-scrim);
  backdrop-filter: var(--modal-scrim-blur);
}

.schedule-dialog {
  display: grid;
  width: min(400px, 100%);
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
  gap: 12px;
  padding: 20px;
  border: 1px solid var(--modal-border);
  border-radius: 12px;
  background: var(--modal-surface);
  box-shadow: var(--modal-shadow);
}

.schedule-dialog:focus {
  outline: none;
}

.schedule-dialog header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.schedule-dialog h3,
.schedule-dialog header p,
.schedule-dialog__resolved,
.schedule-dialog__error {
  margin: 0;
}

.schedule-dialog h3 {
  font-size: 18px;
}

.schedule-dialog header p,
.schedule-dialog__resolved {
  color: var(--muted, #6b7388);
  font-size: 13px;
}

.schedule-dialog__close {
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 24px;
  cursor: pointer;
}

.schedule-dialog__close:focus:not(:focus-visible) {
  outline: none;
}

.schedule-dialog__close:focus-visible {
  border-radius: 4px;
  outline: 2px solid var(--accent, #0060df);
}

.schedule-dialog__picker {
  min-width: 0;
  justify-content: center;
}

.schedule-dialog__picker :deep(.dp--inc-dec-button-inline) {
  min-width: 28px;
  height: 28px;
  justify-content: center;
  border-radius: 4px;
  color: var(--text);
}

.schedule-dialog__picker :deep(.dp--tp-inline-btn-bar) {
  display: none;
}

.schedule-dialog__picker :deep(.dp--inc-dec-button-inline::after) {
  content: '';
  width: 7px;
  height: 7px;
  border-top: 2px solid currentColor;
  border-right: 2px solid currentColor;
  transform: rotate(-45deg);
}

.schedule-dialog__picker :deep(.dp--tp-inline-btn-bottom::after) {
  transform: rotate(135deg);
}

.schedule-dialog__picker :deep(.dp--inc-dec-button-inline:hover) {
  background: var(--rowHover);
}

.schedule-dialog__picker :deep(.dp--inc-dec-button-inline:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.schedule-dialog__error {
  color: var(--colour-ti-critical, #b3261e);
  font-size: 13px;
}

.schedule-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
