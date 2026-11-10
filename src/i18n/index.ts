import { createI18n } from 'vue-i18n';
import english from '../locales/en.json' with { type: 'json' };
import { installTranslator } from './messages';
import { pluralRule } from './plurals';

export const i18n = createI18n({
  legacy: false,
  locale: 'en',
  fallbackLocale: 'en',
  messages: { en: english } as Record<string, any>,
  pluralRules: { en: pluralRule('en') },
  missingWarn: false,
  fallbackWarn: false,
});

installTranslator((key, params, count) => count === undefined
  ? i18n.global.t(key, params)
  : i18n.global.t(key, params, count));
