/**
 * Keyboard shortcut tables for the mail UI, one per `shortcutScheme`.
 *
 * The handler (`useThunderbirdShortcuts`) resolves a key event to a
 * `ShortcutAction` through `resolveShortcut`; the UI renders the same
 * table through `shortcutHint` / `shortcutAria`, so what is shown always
 * matches what is bound.
 *
 * Web bindings are single keys, so the browser keeps its chords (Ctrl+N/R/L,
 * Ctrl+Shift+Del); Ctrl/⌘+K is the one chord taken, as an alternate Quick
 * Filter key. Ctrl/⌘+A and Home/End stay with the focused list (`listScoped`)
 * so the page keeps them everywhere else. Thunderbird bindings reproduce the
 * desktop client:
 * https://support.mozilla.org/kb/keyboard-shortcuts-thunderbird
 */

import type { ShortcutScheme } from './settings';
import {
  isMacPlatform,
  matchesShortcut,
  shortcutModifierAria,
  shortcutModifierLabel,
  type ShortcutSpec,
} from '../utils/keyboard';

export type ShortcutAction =
  | 'compose'
  | 'reply'
  | 'replyAll'
  | 'forward'
  | 'quickFilter'
  | 'archive'
  | 'toggleRead'
  | 'toggleStar'
  /** Digits 1–9: toggle the nth tag in definition order (MK-4.2); the digit is `binding.key`. */
  | 'toggleTag'
  /** `0`: remove every tag from the target (MK-4.2). */
  | 'clearTags'
  | 'openTagMenu'
  | 'delete'
  | 'deleteForever'
  | 'selectAll'
  | 'clearSelection'
  | 'next'
  | 'previous'
  | 'nextUnread'
  | 'previousUnread'
  | 'first'
  | 'last';

export interface ShortcutBinding extends ShortcutSpec {
  /** Bound only on macOS. */
  macOnly?: boolean;
  /** Match regardless of Shift, for keys that need it on some layouts (`/`). */
  ignoreShift?: boolean;
  /** Still fires while a text field has focus. */
  inEditable?: boolean;
  /** Show in hints only on this platform (the binding itself works on both). */
  hintPlatform?: 'mac' | 'other';
  /** Handled by the focused message list (`MessageList.handleKeyDown`), never globally. */
  listScoped?: boolean;
  /** Text shown for the key in hints, for a binding that stands for a range. */
  hintLabel?: string;
  /** Left out of hints; another binding of the action stands for it. */
  hiddenHint?: boolean;
}

export type ShortcutTable = Partial<Record<ShortcutAction, readonly ShortcutBinding[]>>;

/**
 * `1`–`9`, shown in hints as one range. Shift is ignored because some
 * layouts (AZERTY) put the digits on the shifted row; Shift+digit on a
 * US layout reports a symbol, so it cannot match by accident.
 */
const TAG_DIGIT_BINDINGS: readonly ShortcutBinding[] = [
  { key: '1', hintLabel: '1–9', ignoreShift: true },
  ...['2', '3', '4', '5', '6', '7', '8', '9'].map((key) => ({ key, hiddenHint: true, ignoreShift: true })),
];

const WEB_SHORTCUTS: ShortcutTable = {
  compose: [{ key: 'c' }],
  reply: [{ key: 'r' }],
  replyAll: [{ key: 'r', shift: true }],
  forward: [{ key: 'f' }],
  quickFilter: [{ key: '/', ignoreShift: true }, { key: 'k', mod: true, inEditable: true }],
  archive: [{ key: 'a' }],
  toggleRead: [{ key: 'm' }],
  toggleStar: [{ key: 's' }],
  toggleTag: TAG_DIGIT_BINDINGS,
  clearTags: [{ key: '0', ignoreShift: true }],
  openTagMenu: [{ key: 't' }],
  delete: [
    { key: 'Delete', hintPlatform: 'other' },
    { key: 'Backspace', macOnly: true },
  ],
  deleteForever: [
    { key: 'Delete', shift: true, hintPlatform: 'other' },
    { key: 'Backspace', shift: true, macOnly: true },
  ],
  selectAll: [{ key: 'a', mod: true, listScoped: true }],
  clearSelection: [{ key: 'Escape' }],
  next: [{ key: 'j' }],
  previous: [{ key: 'k' }],
  nextUnread: [{ key: 'n' }],
  previousUnread: [{ key: 'p' }],
  first: [{ key: 'Home', listScoped: true }],
  last: [{ key: 'End', listScoped: true }],
};

const THUNDERBIRD_SHORTCUTS: ShortcutTable = {
  compose: [{ key: 'n', mod: true }, { key: 'm', mod: true }],
  reply: [{ key: 'r', mod: true }],
  replyAll: [{ key: 'r', mod: true, shift: true }],
  forward: [{ key: 'l', mod: true }],
  quickFilter: [{ key: 'k', mod: true, inEditable: true }],
  archive: [{ key: 'a' }],
  toggleRead: [{ key: 'm' }],
  toggleStar: [{ key: 's' }],
  toggleTag: TAG_DIGIT_BINDINGS,
  clearTags: [{ key: '0', ignoreShift: true }],
  // No openTagMenu: Thunderbird desktop binds T to "next unread thread",
  // and this table reproduces the desktop client. The toolbar and digits
  // cover tagging there.
  delete: [
    { key: 'Delete', hintPlatform: 'other' },
    { key: 'Backspace', hintPlatform: 'mac' },
  ],
  deleteForever: [
    { key: 'Delete', shift: true, hintPlatform: 'other' },
    { key: 'Backspace', shift: true, hintPlatform: 'mac' },
  ],
  selectAll: [{ key: 'a', mod: true }],
  clearSelection: [{ key: 'Escape' }],
  next: [{ key: 'f' }],
  previous: [{ key: 'b' }],
  nextUnread: [{ key: 'n' }],
  previousUnread: [{ key: 'p' }],
  first: [{ key: 'Home' }],
  last: [{ key: 'End' }],
};

export const SHORTCUT_SCHEMES: Record<ShortcutScheme, ShortcutTable> = {
  web: WEB_SHORTCUTS,
  thunderbird: THUNDERBIRD_SHORTCUTS,
};

export const SHORTCUT_SCHEME_LABELS: Record<ShortcutScheme, string> = {
  web: 'Web',
  thunderbird: 'Thunderbird',
};

function matchesBinding(event: KeyboardEvent, binding: ShortcutBinding): boolean {
  if (binding.macOnly && !isMacPlatform()) return false;
  // Single-key bindings must not fire with a chord modifier held.
  if (!binding.mod && (event.ctrlKey || event.metaKey)) return false;
  const spec: ShortcutSpec = binding.ignoreShift
    ? { ...binding, shift: event.shiftKey }
    : binding;
  return matchesShortcut(event, spec);
}

export interface ResolvedShortcut {
  action: ShortcutAction;
  binding: ShortcutBinding;
}

/** The action this event triggers globally in the scheme; `listScoped` bindings never match here. */
export function resolveShortcut(
  event: KeyboardEvent,
  scheme: ShortcutScheme,
): ResolvedShortcut | null {
  const table = SHORTCUT_SCHEMES[scheme];
  for (const [action, bindings] of Object.entries(table) as Array<[ShortcutAction, readonly ShortcutBinding[]]>) {
    for (const binding of bindings) {
      if (binding.listScoped) continue;
      if (matchesBinding(event, binding)) return { action, binding };
    }
  }
  return null;
}

const KEY_HINTS: Record<string, string> = {
  Delete: 'Del',
  Escape: 'Esc',
  ' ': 'Space',
};

function keyHint(key: string): string {
  if (key.length === 1) return key.toUpperCase();
  return KEY_HINTS[key] ?? key;
}

function bindingHint(binding: ShortcutBinding): string {
  const parts: string[] = [];
  if (binding.mod) parts.push(shortcutModifierLabel());
  if (binding.shift && !binding.ignoreShift) parts.push('Shift');
  if (binding.alt) parts.push('Alt');
  parts.push(binding.hintLabel ?? keyHint(binding.key));
  return parts.join('+');
}

function bindingAria(binding: ShortcutBinding): string {
  const parts: string[] = [];
  if (binding.mod) parts.push(shortcutModifierAria());
  if (binding.shift && !binding.ignoreShift) parts.push('Shift');
  if (binding.alt) parts.push('Alt');
  parts.push(binding.key.length === 1 ? binding.key.toUpperCase() : binding.key);
  return parts.join('+');
}

function visibleBindings(
  action: ShortcutAction,
  scheme: ShortcutScheme,
  { includeHiddenHints = false } = {},
): ShortcutBinding[] {
  const mac = isMacPlatform();
  return (SHORTCUT_SCHEMES[scheme][action] ?? []).filter((binding) => {
    if (binding.hiddenHint && !includeHiddenHints) return false;
    if (binding.macOnly && !mac) return false;
    if (binding.hintPlatform === 'mac' && !mac) return false;
    if (binding.hintPlatform === 'other' && mac) return false;
    return true;
  });
}

/**
 * Human-readable keys for the action on this platform, e.g. `Ctrl+K`,
 * `⌘+Shift+R`, `/ or ⌘+K`; null when the scheme has none.
 */
export function shortcutHint(action: ShortcutAction, scheme: ShortcutScheme): string | null {
  const bindings = visibleBindings(action, scheme);
  if (bindings.length === 0) return null;
  return bindings.map(bindingHint).join(' or ');
}

/** `aria-keyshortcuts` value for the action, every key spelled out; null when the scheme has none. */
export function shortcutAria(action: ShortcutAction, scheme: ShortcutScheme): string | null {
  const bindings = visibleBindings(action, scheme, { includeHiddenHints: true });
  if (bindings.length === 0) return null;
  return bindings.map(bindingAria).join(' ');
}

/** `Label (Keys)` for a toolbar title, or just the label when unbound. */
export function titleWithShortcut(
  label: string,
  action: ShortcutAction,
  scheme: ShortcutScheme,
): string {
  const hint = shortcutHint(action, scheme);
  return hint ? `${label} (${hint})` : label;
}
