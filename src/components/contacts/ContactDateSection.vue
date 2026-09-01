<script setup lang="ts">
import { CalendarDays, Plus, X } from '@lucide/vue';
import {
  VueDatePicker,
  type AriaLabelsConfig,
  type CalendarDay,
  type ModelValue,
  type MonthModel,
} from '@vuepic/vue-datepicker';
import { nextTick, ref } from 'vue';

import { useRepeaterRows } from '../../composables/useRepeaterRows';
import type { ContactAnniversaryKind } from '../../types';
import { closeContainingDropdown } from '../../utils/dropdown';
import AppDropdown from '../AppDropdown.vue';
import AppIconButton from '../AppIconButton.vue';
import {
  contactAnniversaryKindLabel,
  contactDateFromInput,
  createContactEditorAnniversary,
  type ContactEditorAnniversary,
} from './contact-editor';

const props = defineProps<{
  errors?: Record<string, string>;
  modelValue: ContactEditorAnniversary[];
}>();

const emit = defineEmits<{
  'update:modelValue': [dates: ContactEditorAnniversary[]];
}>();

const {
  appendRow: addDate,
  removeRow: removeDate,
  updateRow: updateDate,
} = useRepeaterRows<ContactEditorAnniversary>({
  rows: () => props.modelValue,
  createRow: (position) => ({
    ...createContactEditorAnniversary(),
    position,
  }),
  update: (dates) => emit('update:modelValue', dates),
});

const kinds: ContactAnniversaryKind[] = ['birth', 'wedding', 'death'];
const datePickerTimeConfig = { enableTimePicker: false };
const yearlessAriaLabels: Partial<AriaLabelsConfig> = {
  day: ({ value }: CalendarDay) => value.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
  }),
};
const yearlessDateKeys = ref<Set<string>>(new Set());
const datePickerHandles = new Map<string, {
  setMonthYear: (value: Partial<MonthModel>, instance?: number) => void;
}>();

function chooseKind(
  formKey: string,
  kind: ContactAnniversaryKind,
  event: Event,
): void {
  updateDate(formKey, { kind });
  closeContainingDropdown(event);
}

function errorId(formKey: string): string {
  return `contact-date-error-${formKey}`;
}

function errorFor(formKey: string): string | null {
  return props.errors?.[formKey] ?? null;
}

function setYearless(formKey: string, yearless: boolean): void {
  const next = new Set(yearlessDateKeys.value);
  if (yearless) next.add(formKey);
  else next.delete(formKey);
  yearlessDateKeys.value = next;
}

function setDatePickerHandle(formKey: string, handle: unknown): void {
  if (
    handle
    && typeof handle === 'object'
    && 'setMonthYear' in handle
    && typeof handle.setMonthYear === 'function'
  ) {
    datePickerHandles.set(formKey, handle as {
      setMonthYear: (value: Partial<MonthModel>, instance?: number) => void;
    });
  } else {
    datePickerHandles.delete(formKey);
  }
}

async function updateOpenCalendarYear(formKey: string, year: number): Promise<void> {
  await nextTick();
  datePickerHandles.get(formKey)?.setMonthYear({ year });
}

function isYearless(date: ContactEditorAnniversary): boolean {
  const parsed = contactDateFromInput(date.dateText);
  return yearlessDateKeys.value.has(date.formKey)
    || (parsed?.kind === 'partial' && parsed.year == null);
}

function usesMonthPicker(date: ContactEditorAnniversary): boolean {
  const parsed = contactDateFromInput(date.dateText);
  return parsed?.kind === 'partial'
    && parsed.month != null
    && parsed.day == null;
}

function usesYearPicker(date: ContactEditorAnniversary): boolean {
  const parsed = contactDateFromInput(date.dateText);
  return parsed?.kind === 'partial'
    && parsed.year != null
    && parsed.month == null;
}

function yearlessCalendarYear(date: ContactEditorAnniversary): number {
  const currentYear = new Date().getFullYear();
  const parsed = contactDateFromInput(date.dateText);
  if (parsed?.kind !== 'partial' || parsed.month !== 2 || parsed.day !== 29) {
    return currentYear;
  }
  let leapYear = currentYear;
  while (new Date(leapYear, 1, 29).getMonth() !== 1) leapYear += 1;
  return leapYear;
}

function calendarDisplayYear(date: ContactEditorAnniversary): number {
  const parsed = contactDateFromInput(date.dateText);
  if (parsed?.kind === 'timestamp') return Number(parsed.utc.slice(0, 4));
  return parsed?.year ?? yearlessCalendarYear(date);
}

function yearRange(date: ContactEditorAnniversary): [number, number] {
  if (!isYearless(date)) return [1900, 2100];
  const displayYear = calendarDisplayYear(date);
  return [displayYear, displayYear];
}

function calendarValue(date: ContactEditorAnniversary): ModelValue {
  const parsed = contactDateFromInput(date.dateText);
  if (parsed?.kind === 'partial' && parsed.year != null && parsed.month == null) {
    return parsed.year;
  }
  if (parsed?.kind === 'partial' && parsed.month != null && parsed.day == null) {
    return {
      month: parsed.month - 1,
      year: calendarDisplayYear(date),
    };
  }

  let year: number;
  let month: number;
  let day: number;
  if (parsed?.kind === 'timestamp') {
    [year, month, day] = parsed.utc
      .slice(0, 10)
      .split('-')
      .map(Number) as [number, number, number];
  } else if (
    parsed?.kind === 'partial'
    && parsed.month != null
    && parsed.day != null
  ) {
    year = calendarDisplayYear(date);
    ({ month, day } = parsed);
  } else {
    return null;
  }

  const value = new Date(0);
  value.setHours(12, 0, 0, 0);
  value.setFullYear(year, month - 1, day);
  return value;
}

function calendarStartDate(date: ContactEditorAnniversary): Date | undefined {
  if (!isYearless(date)) return undefined;
  const value = calendarValue(date);
  if (value instanceof Date) return value;
  const start = new Date(0);
  start.setHours(12, 0, 0, 0);
  start.setFullYear(new Date().getFullYear(), new Date().getMonth(), 1);
  return start;
}

function isMonthModel(value: unknown): value is MonthModel {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MonthModel>;
  return Number.isFinite(Number(candidate.month))
    && Number.isFinite(Number(candidate.year));
}

function selectCalendarDate(date: ContactEditorAnniversary, value: unknown): void {
  if (usesYearPicker(date)) {
    const year = Number(value);
    if (!Number.isSafeInteger(year) || year < 0) return;
    updateDate(date.formKey, { dateText: String(year).padStart(4, '0') });
    return;
  }
  if (usesMonthPicker(date)) {
    if (!isMonthModel(value)) return;
    const month = String(Number(value.month) + 1).padStart(2, '0');
    const dateText = isYearless(date)
      ? `--${month}`
      : `${String(value.year).padStart(4, '0')}-${month}`;
    updateDate(date.formKey, { dateText });
    return;
  }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return;
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  updateDate(date.formKey, {
    dateText: isYearless(date) ? `--${month}-${day}` : `${year}-${month}-${day}`,
  });
}

function updateDateText(date: ContactEditorAnniversary, value: string): void {
  const parsed = contactDateFromInput(value);
  if (parsed) {
    setYearless(
      date.formKey,
      parsed.kind === 'partial' && parsed.year == null,
    );
  }
  updateDate(date.formKey, { dateText: value });
}

function toggleYear(date: ContactEditorAnniversary, event: Event): void {
  const includeYear = (event.target as HTMLInputElement).checked;
  const parsed = contactDateFromInput(date.dateText);
  const previousDisplayYear = calendarDisplayYear(date);
  const parsedYear = parsed?.kind === 'timestamp'
    ? Number(parsed.utc.slice(0, 4))
    : parsed?.year;
  const yearlessYear = yearlessCalendarYear(date);
  const displayYear = includeYear
    ? parsedYear ?? yearlessYear
    : yearlessYear;
  setYearless(date.formKey, !includeYear);
  if (displayYear !== previousDisplayYear) {
    void updateOpenCalendarYear(date.formKey, displayYear);
  }

  if (parsed?.kind === 'timestamp') {
    const [, month, day] = parsed.utc.slice(0, 10).split('-');
    if (!includeYear) {
      updateDate(date.formKey, { dateText: `--${month}-${day}` });
    }
    return;
  }
  if (parsed?.kind !== 'partial') return;
  if (parsed.month == null) {
    if (!includeYear) updateDate(date.formKey, { dateText: '' });
    return;
  }

  const month = String(parsed.month).padStart(2, '0');
  const day = parsed.day == null ? '' : `-${String(parsed.day).padStart(2, '0')}`;
  if (!includeYear) {
    updateDate(date.formKey, { dateText: `--${month}${day}` });
    return;
  }
  const restoredYear = yearlessYear;
  updateDate(date.formKey, {
    dateText: `${String(restoredYear).padStart(4, '0')}-${month}${day}`,
  });
}

function calendarYearLabel(date: ContactEditorAnniversary, value: number): string | number {
  return isYearless(date) ? 'No year' : value;
}
</script>

<template>
  <fieldset class="contact-dates">
    <legend>Dates</legend>
    <div
      v-for="date in modelValue"
      :key="date.formKey"
      class="contact-dates__row"
      :data-field-key="date.formKey"
    >
      <AppDropdown group="contact-date-kinds">
        <summary
          class="app-dropdown__summary app-dropdown__summary--control contact-dates__summary"
          :aria-label="`Choose date kind; current kind ${contactAnniversaryKindLabel(date.kind)}`"
        >
          {{ contactAnniversaryKindLabel(date.kind) }}
        </summary>
        <div class="app-dropdown__menu" role="menu">
          <button
            v-for="kind in kinds"
            :key="kind"
            class="app-dropdown__item"
            type="button"
            role="menuitemradio"
            :aria-checked="date.kind === kind"
            @click="chooseKind(date.formKey, kind, $event)"
          >
            <span aria-hidden="true">{{ date.kind === kind ? '✓' : '' }}</span>
            <span>{{ contactAnniversaryKindLabel(kind) }}</span>
          </button>
        </div>
      </AppDropdown>
      <div class="contact-dates__value">
        <input
          class="contact-editor__input contact-dates__input"
          type="text"
          inputmode="numeric"
          :value="date.dateText"
          placeholder="YYYY-MM-DD or --MM-DD"
          aria-label="Contact date"
          :aria-describedby="errorFor(date.formKey) ? errorId(date.formKey) : undefined"
          :aria-invalid="errorFor(date.formKey) ? 'true' : undefined"
          autocomplete="off"
          @input="updateDateText(
            date,
            ($event.target as HTMLInputElement).value,
          )"
        />
        <VueDatePicker
          :ref="(handle) => setDatePickerHandle(date.formKey, handle)"
          class="contact-dates__datepicker"
          :model-value="calendarValue(date)"
          :aria-labels="isYearless(date) ? yearlessAriaLabels : undefined"
          arrow-navigation
          :auto-apply="true"
          :disable-year-select="isYearless(date)"
          :month-picker="usesMonthPicker(date)"
          :six-weeks="true"
          :start-date="calendarStartDate(date)"
          :teleport="true"
          :time-config="datePickerTimeConfig"
          :year-picker="usesYearPicker(date)"
          :year-range="yearRange(date)"
          @update:model-value="selectCalendarDate(date, $event)"
        >
          <template #trigger>
            <button
              class="contact-dates__calendar"
              type="button"
              aria-label="Choose contact date from calendar"
              title="Choose date from calendar"
            >
              <CalendarDays :size="16" :stroke-width="1.8" aria-hidden="true" />
            </button>
          </template>
          <template #action-extra>
            <div class="contact-dates__menu-footer">
              <label class="contact-dates__include-year">
                <input
                  type="checkbox"
                  data-dp-action-element="0"
                  :checked="!isYearless(date)"
                  @change="toggleYear(date, $event)"
                />
                <span>Include year</span>
              </label>
            </div>
          </template>
          <template #year="{ value }">
            {{ calendarYearLabel(date, value) }}
          </template>
        </VueDatePicker>
      </div>
      <AppIconButton
        class="contact-editor__remove"
        aria-label="Remove date"
        @click="removeDate(date.formKey)"
      >
        <X :size="15" :stroke-width="2" aria-hidden="true" />
      </AppIconButton>
      <p
        v-if="errorFor(date.formKey)"
        :id="errorId(date.formKey)"
        class="contact-dates__error"
        role="alert"
      >
        {{ errorFor(date.formKey) }}
      </p>
    </div>
    <p class="contact-dates__hint">
      YYYY-MM-DD or --M-DD for month and day only.
    </p>
    <button class="contact-editor__add" type="button" @click="addDate">
      <Plus :size="14" :stroke-width="2" aria-hidden="true" />
      <span>Add date</span>
    </button>
  </fieldset>
</template>

<style scoped>
.contact-dates {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: 0;
}

.contact-dates legend {
  margin-bottom: 7px;
  color: var(--muted, #6b7388);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.contact-dates__row {
  display: grid;
  grid-template-columns: auto minmax(160px, 1fr) auto;
  align-items: start;
  gap: 6px;
}

.contact-dates__summary {
  min-width: 104px;
}

.contact-dates__input {
  width: 100%;
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}

.contact-dates__value {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto;
}

.contact-dates__datepicker {
  width: 34px;
}

.contact-dates__calendar {
  display: inline-flex;
  width: 34px;
  height: 34px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--border, #d6d9e2);
  border-left: 0;
  border-radius: 0 6px 6px 0;
  background: var(--panel, #fff);
  color: var(--muted, #6b7388);
  cursor: pointer;
}

.contact-dates__calendar:hover,
.contact-dates__calendar:focus-visible {
  background: var(--rowHover, #f0f1f6);
  color: var(--text, #1a1d24);
  outline: none;
}

.contact-dates__include-year {
  display: inline-flex;
  align-items: center;
  justify-self: start;
  gap: 6px;
  color: var(--muted, #6b7388);
  font-size: 13px;
  cursor: pointer;
}

.contact-dates__menu-footer {
  display: flex;
  min-height: 34px;
  align-items: center;
  justify-content: center;
  padding: 7px 10px;
  border-top: 1px solid var(--border, #d6d9e2);
}

.contact-dates__include-year input {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--accent);
}

.contact-dates__error {
  grid-column: 2 / -1;
  margin: 0;
  color: #c93838;
  font-size: 12px;
}

.contact-dates__hint {
  margin: -2px 0 0;
  color: var(--muted, #6b7388);
  font-size: 11px;
}

@media (max-width: 760px) {
  .contact-dates__row {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .contact-dates__row > .app-dropdown {
    grid-column: 1 / -1;
  }

  .contact-dates__error {
    grid-column: 1 / -1;
  }
}
</style>
