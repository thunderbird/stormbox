// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { computed, defineComponent, h, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { availableLocales, bindDocumentLocale, i18n, localeDirection, resolveLocale, setLocalePreference } from '../../../src/i18n';
import { errorMessage, formatDate, formatNumber, LocalizedError, sourceText, t } from '../../../src/i18n/messages';
import { pluralRule } from '../../../src/i18n/plurals';
import { serializeRpcError } from '../../../src/db/rpc-dispatch';
import { FEATURE_CARDS } from '../../../src/constants/feature-tour';
import { nextCopyName } from '../../../src/utils/copy-name';
import { formatScheduleTarget, wallTimeToUtc } from '../../../src/utils/schedule-time';

function addGerman() {
  if (!availableLocales.includes('de')) availableLocales.push('de');
  i18n.global.setLocaleMessage('de', {
    common: { language: 'Sprache', copyName: '{name} (Kopie {number})', copyMarker: 'Kopie' },
    counts: { messages: '{count} Nachricht | {count} Nachrichten' },
    featureTour: { composeWithConfidence: 'Sicher schreiben' },
    fixture: { parameter: 'Nachricht von {sender}' },
    repository: { databaseConnectionClosed: 'Datenbankverbindung geschlossen.' },
  });
}
afterEach(() => {
  setLocalePreference('en');
  localStorage.clear();
  const index = availableLocales.indexOf('de');
  if (index !== -1) availableLocales.splice(index, 1);
});

describe('localization', () => {
  it('negotiates supported languages without losing regional formatting', () => {
    expect(resolveLocale(['zz-ZZ', 'de-AT', 'en'], ['en', 'de'])).toBe('de-AT');
    expect(resolveLocale(['en-GB'], ['en'])).toBe('en-GB');
    expect(resolveLocale(['invalid_locale'], ['en'])).toBe('en');
    expect(localeDirection('az-Arab')).toBe('rtl');
    expect(localeDirection('ku-Latn')).toBe('ltr');
  });

  it('updates existing computed labels and falls back to English', () => {
    addGerman();
    const label = computed(() => t('common.language'));
    const card = computed(() => FEATURE_CARDS[0].title);
    setLocalePreference('de');
    expect(label.value).toBe('Sprache');
    expect(card.value).toBe('Sicher schreiben');
    expect(t('common.fromHeader', { value: 'Ada' })).toBe('From: Ada');
    setLocalePreference('en');
    expect(label.value).toBe('Language');
  });

  it('persists the preference and synchronizes document language across tabs', async () => {
    addGerman();
    const stop = bindDocumentLocale();
    try {
      setLocalePreference('de');
      expect(localStorage.getItem('stormbox.locale')).toBe('de');
      expect(document.documentElement.lang).toBe('de');
      localStorage.setItem('stormbox.locale', 'en-GB');
      window.dispatchEvent(new StorageEvent('storage', { key: 'stormbox.locale' }));
      await nextTick();
      expect(document.documentElement.lang).toBe('en-GB');
      expect(document.documentElement.dir).toBe('ltr');
    } finally { stop(); }
  });

  it('formats numbers, dates, and plural counts with the selected locale', () => {
    addGerman();
    setLocalePreference('de');
    expect(formatNumber(1234.5)).toBe('1.234,5');
    expect(t('counts.messages', { count: 1234 }, 1234)).toBe('1.234 Nachrichten');
    expect(t('counts.messages', { count: 1 }, 1)).toBe('1 Nachricht');
    expect(formatDate(Date.UTC(2026, 9, 28), { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })).toBe('28. Oktober 2026');
    const rule = pluralRule('ar');
    expect([0, 1, 2, 3, 11, 100].map((n) => rule(n, 6))).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('renders interpolated data as text and preserves localizable RPC errors', () => {
    addGerman();
    setLocalePreference('de');
    const input = '<img src=x onerror=alert(1)>';
    const wrapper = mount(defineComponent(() => () => h('p', t('fixture.parameter', { sender: input }))));
    expect(wrapper.text()).toBe(`Nachricht von ${input}`);
    expect(wrapper.find('img').exists()).toBe(false);
    const error = new LocalizedError('repository.databaseConnectionClosed');
    const wire = JSON.parse(JSON.stringify(serializeRpcError(error)));
    expect(wire.messageKey).toBe('repository.databaseConnectionClosed');
    expect(errorMessage(wire)).toBe('Datenbankverbindung geschlossen.');
    expect(sourceText('repository.databaseConnectionClosed')).toBe('Database connection closed.');
    wrapper.unmount();
  });

  it('keeps schedule instants stable and recognizes earlier English copy names', () => {
    addGerman();
    const before = wallTimeToUtc({ year: 2026, month: 10, day: 28, hour: 12, minute: 0 }, 'Europe/Berlin');
    setLocalePreference('de');
    expect(wallTimeToUtc({ year: 2026, month: 10, day: 28, hour: 12, minute: 0 }, 'Europe/Berlin')).toEqual(before);
    expect(formatScheduleTarget('2026-10-28T12:00:00Z', 'UTC')).toContain('Okt.');
    expect(nextCopyName('Ada (Copy 1)', ['Ada (Copy 1)', 'Ada (Kopie 2)'])).toBe('Ada (Kopie 3)');
  });
});
