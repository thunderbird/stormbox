/**
 * Typed registry for user settings. Storage and sync treat values as
 * opaque JSON; UI reads validate them here.
 */

export const THEME_VALUES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEME_VALUES)[number];

export interface Settings {
  /** Color scheme. 'system' follows the OS preference. */
  theme: Theme;
  /** Client-selected JMAP Identity id used as the default From address. */
  primaryIdentityRemoteId: string | null;
}

export const SETTING_DEFAULTS: Readonly<Settings> = {
  theme: 'system',
  primaryIdentityRemoteId: null,
};

const SETTING_VALIDATORS: {
  [K in keyof Settings]: (value: unknown) => value is Settings[K];
} = {
  theme: (value): value is Theme => (THEME_VALUES as readonly unknown[]).includes(value),
  primaryIdentityRemoteId: (value): value is string | null =>
    value === null || (typeof value === 'string' && value.length > 0),
};

export function resolveSetting<K extends keyof Settings>(key: K, value: unknown): Settings[K] {
  return SETTING_VALIDATORS[key](value) ? value : SETTING_DEFAULTS[key];
}
