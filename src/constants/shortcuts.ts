/**
 * Keyboard shortcut tables for the mail UI, one per `shortcutScheme`.
 *
 * The handler (`useThunderbirdShortcuts`) resolves a key event to a
 * `ShortcutAction` through `resolveShortcut`; the UI renders the same
 * table through `shortcutHint` / `shortcutAria`, so what is shown always
 * matches what is bound.
 *
 * Web bindings never take a key the browser already uses (Ctrl+N/R/L/A,
 * Home/End). Thunderbird bindings reproduce the desktop client:
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
  | 'markRead'
  | 'markUnread'
  | 'toggleRead'
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
  /** Match regardless of Shift, for keys that need it on some layouts (`*`, `/`). */
  ignoreShift?: boolean;
  /** Second key of a two-key sequence; `prefix` must have been pressed just before. */
  prefix?: string;
  /** Still fires while a text field has focus. */
  inEditable?: boolean;
  /** Show in hints only on this platform (the binding itself works on both). */
  hintPlatform?: 'mac' | 'other';
}

export type ShortcutTable = Partial<Record<ShortcutAction, readonly ShortcutBinding[]>>;

const WEB_SHORTCUTS: ShortcutTable = {
  compose: [{ key: 'c' }],
  reply: [{ key: 'r' }],
  replyAll: [{ key: 'r', shift: true }],
  forward: [{ key: 'f' }],
  quickFilter: [{ key: '/', ignoreShift: true }, { key: 'k', mod: true, inEditable: true }],
  archive: [{ key: 'a' }],
  markRead: [{ key: 'i', shift: true }],
  markUnread: [{ key: 'u' }],
  delete: [
    { key: 'Delete', hintPlatform: 'other' },
    { key: 'Backspace', macOnly: true },
  ],
  deleteForever: [
    { key: 'Delete', shift: true, hintPlatform: 'other' },
    { key: 'Backspace', shift: true, macOnly: true },
  ],
  selectAll: [{ key: 'a', prefix: '*' }],
  clearSelection: [{ key: 'Escape' }],
  next: [{ key: 'j' }],
  previous: [{ key: 'k' }],
  nextUnread: [{ key: 'n' }],
  previousUnread: [{ key: 'p' }],
};

const THUNDERBIRD_SHORTCUTS: ShortcutTable = {
  compose: [{ key: 'n', mod: true }, { key: 'm', mod: true }],
  reply: [{ key: 'r', mod: true }],
  replyAll: [{ key: 'r', mod: true, shift: true }],
  forward: [{ key: 'l', mod: true }],
  quickFilter: [{ key: 'k', mod: true, inEditable: true }],
  archive: [{ key: 'a' }],
  toggleRead: [{ key: 'm' }],
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

/** Keys that start a two-key sequence in the scheme (e.g. `*`). */
export function prefixKeys(scheme: ShortcutScheme): string[] {
  const keys = new Set<string>();
  for (const bindings of Object.values(SHORTCUT_SCHEMES[scheme])) {
    for (const binding of bindings ?? []) {
      if (binding.prefix) keys.add(binding.prefix);
    }
  }
  return [...keys];
}

/** The prefix this event starts, or null. Prefix keys ignore Shift (`*` is Shift+8). */
export function prefixForEvent(event: KeyboardEvent, scheme: ShortcutScheme): string | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  return prefixKeys(scheme).find((key) => event.key === key) ?? null;
}

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

/**
 * The action this event triggers in the scheme. A binding with a `prefix`
 * only matches while that prefix is pending, and wins over the plain
 * binding for the same key (`* a` selects all; `a` alone archives).
 */
export function resolveShortcut(
  event: KeyboardEvent,
  scheme: ShortcutScheme,
  pendingPrefix: string | null = null,
): ResolvedShortcut | null {
  const table = SHORTCUT_SCHEMES[scheme];
  let plain: ResolvedShortcut | null = null;
  for (const [action, bindings] of Object.entries(table) as Array<[ShortcutAction, readonly ShortcutBinding[]]>) {
    for (const binding of bindings) {
      if (!matchesBinding(event, binding)) continue;
      if (binding.prefix) {
        if (binding.prefix === pendingPrefix) return { action, binding };
        continue;
      }
      plain ??= { action, binding };
    }
  }
  return plain;
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
  parts.push(keyHint(binding.key));
  const chord = parts.join('+');
  return binding.prefix ? `${keyHint(binding.prefix)} then ${chord}` : chord;
}

function bindingAria(binding: ShortcutBinding): string {
  const parts: string[] = [];
  if (binding.mod) parts.push(shortcutModifierAria());
  if (binding.shift && !binding.ignoreShift) parts.push('Shift');
  if (binding.alt) parts.push('Alt');
  parts.push(binding.key.length === 1 ? binding.key.toUpperCase() : binding.key);
  const chord = parts.join('+');
  return binding.prefix ? `${binding.prefix} ${chord}` : chord;
}

function visibleBindings(action: ShortcutAction, scheme: ShortcutScheme): ShortcutBinding[] {
  const mac = isMacPlatform();
  return (SHORTCUT_SCHEMES[scheme][action] ?? []).filter((binding) => {
    if (binding.macOnly && !mac) return false;
    if (binding.hintPlatform === 'mac' && !mac) return false;
    if (binding.hintPlatform === 'other' && mac) return false;
    return true;
  });
}

/**
 * Human-readable keys for the action on this platform, e.g. `Ctrl+K`,
 * `⌘+Shift+R`, `/ or ⌘+K`, `* then A`; null when the scheme has none.
 */
export function shortcutHint(action: ShortcutAction, scheme: ShortcutScheme): string | null {
  const bindings = visibleBindings(action, scheme);
  if (bindings.length === 0) return null;
  return bindings.map(bindingHint).join(' or ');
}

/** `aria-keyshortcuts` value for the action; null when the scheme has none. */
export function shortcutAria(action: ShortcutAction, scheme: ShortcutScheme): string | null {
  const bindings = visibleBindings(action, scheme);
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
