/**
 * Typed registry for user settings. Storage and sync treat values as
 * opaque JSON; UI reads validate them here.
 */

import { detectTimeZone, isUsableTimeZone } from '../utils/schedule-time';

export const THEME_VALUES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEME_VALUES)[number];

/** 'bolt' = Bolt design-system accent and surfaces; 'classic' = the earlier blue palette. */
export const PALETTE_VALUES = ['bolt', 'classic'] as const;
export type Palette = (typeof PALETTE_VALUES)[number];

/**
 * 'web' = single-letter Gmail-style keys that leave browser shortcuts
 * alone; 'thunderbird' = Thunderbird desktop's Ctrl/⌘ chords.
 */
export const SHORTCUT_SCHEME_VALUES = ['web', 'thunderbird'] as const;
export type ShortcutScheme = (typeof SHORTCUT_SCHEME_VALUES)[number];

export interface Settings {
  /** Color scheme. 'system' follows the OS preference. */
  theme: Theme;
  /** Accent and surface palette applied on top of the color scheme. */
  palette: Palette;
  /** Which keyboard shortcut table the mail UI binds. */
  shortcutScheme: ShortcutScheme;
  /** Client-selected JMAP Identity id used as the default From address. */
  primaryIdentityRemoteId: string | null;
  /** Cached JMAP id for the managed top-level `Scheduled` mailbox. */
  scheduledMailboxRemoteId: string | null;
  /** IANA time zone used to interpret scheduled-send wall times. */
  timeZone: string;
}

export const SETTING_DEFAULTS: Readonly<Settings> = {
  theme: 'system',
  palette: 'classic',
  shortcutScheme: 'web',
  primaryIdentityRemoteId: null,
  scheduledMailboxRemoteId: null,
  timeZone: detectTimeZone(),
};

const SETTING_VALIDATORS: {
  [K in keyof Settings]: (value: unknown) => value is Settings[K];
} = {
  theme: (value): value is Theme => (THEME_VALUES as readonly unknown[]).includes(value),
  palette: (value): value is Palette => (PALETTE_VALUES as readonly unknown[]).includes(value),
  shortcutScheme: (value): value is ShortcutScheme =>
    (SHORTCUT_SCHEME_VALUES as readonly unknown[]).includes(value),
  primaryIdentityRemoteId: (value): value is string | null =>
    value === null || (typeof value === 'string' && value.length > 0),
  scheduledMailboxRemoteId: (value): value is string | null =>
    value === null || (typeof value === 'string' && value.length > 0),
  timeZone: isUsableTimeZone,
};

export function resolveSetting<K extends keyof Settings>(key: K, value: unknown): Settings[K] {
  return SETTING_VALIDATORS[key](value) ? value : SETTING_DEFAULTS[key];
}
