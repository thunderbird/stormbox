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
import { useSettingsStore } from '../stores/settings-store';
import {
  detectTimeZone,
  instantToWallTime,
  isUsableTimeZone,
  pickerValueToWallTime,
  resolveCustomSchedule,
  scheduleClockWindowFromReference,
  searchTimeZoneOptions,
  type ServerClockReferenceLike,
  wallTimeToPickerValue,
} from '../utils/schedule-time';
import AppButton from './AppButton.vue';
import AppDropdown from './AppDropdown.vue';

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

const settingsStore = useSettingsStore();
const dialogEl = ref<HTMLElement | null>(null);
useModalFocus(dialogEl, {
  containTab: true,
  focusableSelector: [
    'button:not([disabled])',
    'input:not([disabled])',
    'summary:not([aria-disabled="true"])',
    '[href]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(','),
  onDefault: submit,
  restoreFocus: false,
});

const selectedTimeZone = ref(
  isUsableTimeZone(props.timeZone) ? props.timeZone : detectTimeZone(),
);
const zoneSearch = ref('');
const localError = ref<string | null>(null);
const pickerPopupOpen = ref(false);
const internalPickerValue = ref<InternalModelValue>(null);
const internalInvalidMessage = ref<string | null>(null);
const currentTimeMs = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | null = null;
const timeConfig = {
  enableTimePicker: true,
  enableSeconds: false,
  is24: false,
  minutesIncrement: 1,
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
const customResolution = computed(() => {
  const wallTime = pickerValueToWallTime(pickerValue.value);
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
const provisionalResolution = computed(() => {
  if (!pickerPopupOpen.value || internalPickerValue.value == null) return null;
  const wallTime = pickerValueToWallTime(internalPickerValue.value);
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
const activeResolution = computed(() => {
  if (pickerPopupOpen.value && internalPickerValue.value != null) {
    return provisionalResolution.value ?? customResolution.value;
  }
  return customResolution.value;
});
const displayedError = computed(() => {
  if (localError.value) return localError.value;
  if (props.error) return props.error;
  if (internalInvalidMessage.value) return internalInvalidMessage.value;
  const resolution = pickerPopupOpen.value && internalPickerValue.value != null
    ? provisionalResolution.value
    : customResolution.value;
  if (resolution && !resolution.ok && 'message' in resolution) {
    return resolution.message;
  }
  return null;
});
const showResolvedStatus = computed(() =>
  !displayedError.value && activeResolution.value.ok);
const resolvedStatus = computed(() =>
  (activeResolution.value.ok ? activeResolution.value : null));
const zoneOptions = computed(() => searchTimeZoneOptions({
  search: zoneSearch.value,
  currentTimeZone: selectedTimeZone.value,
  limit: 100,
}));

function close(): void {
  if (!props.busy) emit('close');
}

function closeDropdown(event: Event): void {
  const details = (event.currentTarget as HTMLElement).closest('details');
  if (details instanceof HTMLDetailsElement) details.open = false;
}

async function chooseTimeZone(timeZone: string, event: Event): Promise<void> {
  closeDropdown(event);
  if (!isUsableTimeZone(timeZone)) return;
  selectedTimeZone.value = timeZone;
  zoneSearch.value = '';
  localError.value = null;
  emit('clear-error');
  try {
    await settingsStore.update({ timeZone });
  } catch {
    localError.value = 'The time zone could not be synced. Try again.';
  }
}

function submit(): void {
  if (props.busy) return;
  currentTimeMs.value = Date.now();
  localError.value = null;
  const wallTime = pickerValueToWallTime(pickerValue.value);
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
  if (event.key === 'Escape') {
    if (pickerPopupOpen.value) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }
}

function updatePickerValue(value: ModelValue): void {
  pickerValue.value = value;
  localError.value = null;
  internalInvalidMessage.value = null;
  emit('clear-error');
  void nextTick();
}

function onPickerOpen(): void {
  pickerPopupOpen.value = true;
  internalInvalidMessage.value = null;
}

function onPickerClosed(): void {
  pickerPopupOpen.value = false;
  internalPickerValue.value = null;
  internalInvalidMessage.value = null;
}

function onInternalModelChange(value: InternalModelValue): void {
  internalPickerValue.value = value;
  internalInvalidMessage.value = null;
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
        @keydown.capture="onKeydown"
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

        <label class="schedule-dialog__label" :for="`schedule-date-${sessionId}`">
          Send date and time
        </label>
        <VueDatePicker
          class="schedule-dialog__picker"
          :model-value="pickerValue"
          :input-id="`schedule-date-${sessionId}`"
          :min-date="minPickerDate"
          :max-date="maxPickerDate"
          :time-config="timeConfig"
          :clearable="false"
          :disabled="busy"
          :teleport="true"
          timezone="UTC"
          @update:model-value="updatePickerValue"
          @open="onPickerOpen"
          @closed="onPickerClosed"
          @internal-model-change="onInternalModelChange"
          @invalid-date="onInvalidDate"
          @invalid-select="onInvalidSelect"
        />

        <div class="schedule-dialog__zone-field">
          <span class="schedule-dialog__label">Time zone</span>
          <AppDropdown class="schedule-dialog__zone-dropdown" :disabled="busy">
            <summary
              class="app-dropdown__summary schedule-dialog__zone-summary"
              aria-haspopup="listbox"
              :aria-label="`Time zone: ${selectedTimeZone}`"
            >
              {{ selectedTimeZone }}
            </summary>
            <div
              class="app-dropdown__menu schedule-dialog__zone-menu"
            >
              <input
                v-model="zoneSearch"
                class="schedule-dialog__zone-search"
                type="search"
                role="combobox"
                aria-label="Search time zones"
                :aria-controls="`schedule-time-zone-options-${sessionId}`"
                aria-expanded="true"
                autocomplete="off"
              />
              <div
                :id="`schedule-time-zone-options-${sessionId}`"
                class="schedule-dialog__zone-options"
                role="listbox"
                aria-label="IANA time zones"
              >
                <button
                  v-for="option in zoneOptions"
                  :key="option.id"
                  type="button"
                  class="app-dropdown__item schedule-dialog__zone-option"
                  role="option"
                  :aria-selected="option.id === selectedTimeZone"
                  @click="chooseTimeZone(option.id, $event)"
                >
                  {{ option.label }}
                </button>
                <p v-if="zoneOptions.length === 0" class="schedule-dialog__zone-empty">
                  No matching IANA time zone
                </p>
              </div>
            </div>
          </AppDropdown>
        </div>

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
            :disabled="busy || !activeResolution.ok"
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
  background: rgba(13, 22, 42, 0.5);
}

.schedule-dialog {
  display: grid;
  width: min(520px, 100%);
  gap: 12px;
  padding: 20px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 12px;
  background: var(--surface, #fff);
  box-shadow: 0 20px 54px rgba(0, 0, 0, 0.3);
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
.schedule-dialog__error,
.schedule-dialog__zone-empty {
  margin: 0;
}

.schedule-dialog h3 {
  font-size: 18px;
}

.schedule-dialog header p,
.schedule-dialog__resolved,
.schedule-dialog__zone-empty {
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

.schedule-dialog__label {
  color: var(--colour-ti-secondary, var(--text, #111827));
  font-size: 13px;
  font-weight: 600;
}

.schedule-dialog__picker {
  min-width: 0;
}

.schedule-dialog__picker :deep(.dp__input) {
  border-color: var(--border, #d6d9e2);
  background: var(--panel, #fff);
  color: var(--text, #111827);
}

.schedule-dialog__zone-field {
  display: grid;
  gap: 5px;
}

.schedule-dialog__zone-summary {
  display: flex;
  min-height: 34px;
  align-items: center;
  padding: 0 10px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 6px;
  background: var(--panel, #fff);
}

.schedule-dialog__zone-summary::after {
  margin-left: auto;
}

.schedule-dialog__zone-summary:focus:not(:focus-visible) {
  outline: none;
}

.schedule-dialog__zone-summary:focus-visible {
  border-color: var(--accent, #0060df);
  outline: none;
}

.schedule-dialog__zone-menu {
  right: 0;
  min-width: 100%;
}

.schedule-dialog__zone-search {
  width: 100%;
  min-height: 34px;
  padding: 6px 8px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 6px;
  background: var(--surface, #fff);
  color: inherit;
  font: inherit;
}

.schedule-dialog__zone-options {
  display: grid;
  max-height: 190px;
  overflow-y: auto;
}

.schedule-dialog__zone-option {
  grid-template-columns: 1fr;
}

.schedule-dialog__zone-option[aria-selected='true'] {
  font-weight: 600;
}

.schedule-dialog__zone-empty {
  padding: 8px;
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
