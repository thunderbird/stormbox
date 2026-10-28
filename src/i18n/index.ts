import { computed, ref, watch } from 'vue';
import { createI18n } from 'vue-i18n';
import { installTranslator, formatNumber } from './messages';
import { pluralRule } from './plurals';

const catalogs = import.meta.glob('../locales/*.json', { eager: true, import: 'default' }) as Record<string, Record<string, unknown>>;
export const messages = Object.fromEntries(Object.entries(catalogs)
  .map(([path, catalog]) => [path.split('/').at(-1)!.replace(/\.json$/, ''), catalog]));
export const availableLocales = Object.keys(messages).sort();
export const LOCALE_STORAGE_KEY = 'stormbox.locale';

function canonicalLocale(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try { return Intl.getCanonicalLocales(value)[0] ?? null; } catch { return null; }
}

export function resolveLocale(preferred: readonly string[], available = availableLocales): string {
  for (const value of preferred) {
    const canonical = canonicalLocale(value);
    if (!canonical) continue;
    const exact = available.find((item) => item.toLowerCase() === canonical.toLowerCase());
    if (exact) return canonical;
    const language = canonical.split('-')[0];
    if (available.includes(language)) return canonical;
  }
  return 'en';
}

function storedPreference(): string | null {
  try { return canonicalLocale(globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY)); } catch { return null; }
}
const preference = ref<string | null>(storedPreference());
const browserLanguages = ref<readonly string[]>(globalThis.navigator?.languages ?? ['en']);
export const localePreference = computed(() => preference.value ?? 'auto');
export const locale = computed(() => resolveLocale(preference.value ? [preference.value] : browserLanguages.value));
export const i18n = createI18n({
  legacy: false,
  pluralRules: Object.fromEntries(availableLocales.map((language) => [language, pluralRule(language)])),
  locale: locale.value,
  fallbackLocale: 'en',
  messages: messages as Record<string, any>,
  missingWarn: false,
  fallbackWarn: false,
});
installTranslator((key, params, count) => {
  const formatted = Object.fromEntries(Object.entries(params)
    .map(([name, value]) => [name, typeof value === 'number' ? formatNumber(value) : value]));
  return count === undefined ? i18n.global.t(key, formatted) : i18n.global.t(key, formatted, count);
}, () => locale.value);
watch(locale, (value) => {
  i18n.global.pluralRules[value] = pluralRule(value);
  i18n.global.locale.value = value;
}, { immediate: true, flush: 'sync' });

export function setLocalePreference(value: string): void {
  preference.value = value === 'auto' ? null : canonicalLocale(value);
  try {
    if (preference.value) globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, preference.value);
    else globalThis.localStorage?.removeItem(LOCALE_STORAGE_KEY);
  } catch { /* Session-only preference when browser storage is unavailable. */ }
}

export function localeDirection(value: string): 'ltr' | 'rtl' {
  const script = new Intl.Locale(value).maximize().script;
  return script && ['Arab', 'Hebr', 'Thaa', 'Nkoo', 'Adlm', 'Rohg', 'Syrc'].includes(script) ? 'rtl' : 'ltr';
}

/** Install once per document, including the standalone PDF viewer. */
export function bindDocumentLocale(): () => void {
  const stop = watch(locale, (value) => {
    document.documentElement.lang = value;
    document.documentElement.dir = localeDirection(value);
  }, { immediate: true, flush: 'sync' });
  const onLanguageChange = () => { browserLanguages.value = navigator.languages; };
  const onStorage = (event: StorageEvent) => {
    if (event.key === LOCALE_STORAGE_KEY || event.key === null) preference.value = storedPreference();
  };
  globalThis.addEventListener('languagechange', onLanguageChange);
  globalThis.addEventListener('storage', onStorage);
  return () => {
    stop();
    globalThis.removeEventListener('languagechange', onLanguageChange);
    globalThis.removeEventListener('storage', onStorage);
  };
}
