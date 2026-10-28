import { computed, shallowRef, watch } from 'vue';
import { enUS } from 'date-fns/locale/en-US';
import type { Locale } from 'date-fns';
import type { AriaLabelsConfig, ActionRowConfig } from '@vuepic/vue-datepicker';
import { locale } from '../i18n';
import { t, formatDate } from '../i18n/messages';

const loaders = import.meta.glob('../../node_modules/date-fns/locale/*.js');

export function useDatePickerLocale() {
  const dateLocale = shallowRef<Locale>(enUS);
  watch(locale, async (value, _, onCleanup) => {
    let cancelled = false;
    onCleanup(() => { cancelled = true; });
    const candidates = [value, value.split('-')[0]];
    const name = candidates.find((candidate) => loaders[`../../node_modules/date-fns/locale/${candidate}.js`]);
    dateLocale.value = enUS;
    if (!name) return;
    try {
      const module = await loaders[`../../node_modules/date-fns/locale/${name}.js`]() as Record<string, Locale>;
      if (!cancelled) dateLocale.value = module[Object.keys(module)[0]];
    } catch { /* Keep the built-in calendar locale when an optional chunk is unavailable. */ }
  }, { immediate: true });
  const ariaLabels = computed<Partial<AriaLabelsConfig>>(() => ({
    toggleOverlay: t('datePicker.toggleOverlay'),
    menu: t('datePicker.menu'),
    input: t('datePicker.input'),
    openYearsOverlay: t('datePicker.openYearsOverlay'),
    openMonthsOverlay: t('datePicker.openMonthsOverlay'),
    nextMonth: t('datePicker.nextMonth'),
    prevMonth: t('datePicker.prevMonth'),
    nextYear: t('datePicker.nextYear'),
    prevYear: t('datePicker.prevYear'),
    clearInput: t('datePicker.clearInput'),
    calendarIcon: t('datePicker.calendarIcon'),
    openTimePicker: t('datePicker.openTimePicker'),
    closeTimePicker: t('datePicker.closeTimePicker'),
    amPmButton: t('datePicker.amPmButton'),
    timePicker: t('datePicker.timePicker'),
    incrementValue: (type) => t('datePicker.increment', { type: t(`datePicker.${type}`) }),
    decrementValue: (type) => t('datePicker.decrement', { type: t(`datePicker.${type}`) }),
    openTpOverlay: (type) => t('datePicker.openTimeOverlay', { type: t(`datePicker.${type}`) }),
    timeOverlay: (type) => t('datePicker.timeOverlay', { type: t(`datePicker.${type}`) }),
    monthPicker: (overlay) => t(overlay ? 'datePicker.monthOverlay' : 'datePicker.monthPicker'),
    yearPicker: (overlay) => t(overlay ? 'datePicker.yearOverlay' : 'datePicker.yearPicker'),
    day: ({ value }) => formatDate(value, { dateStyle: 'full' }),
    weekDay: (day) => formatDate(new Date(2024, 0, 7 + day), { weekday: 'long' }),
  }));
  const actionRow = computed<Partial<ActionRowConfig>>(() => ({
    selectBtnLabel: t('datePicker.select'),
    cancelBtnLabel: t('datePicker.cancel'),
    nowBtnLabel: t('datePicker.now'),
  }));
  return { dateLocale, ariaLabels, actionRow };
}
