// @vitest-environment happy-dom

import { describe, it, expect } from 'vitest';

import {
  isDeleteKey,
  isEditableTarget,
  isModKey,
  matchesShortcut,
} from '../../../src/utils/keyboard';

function keyEvent(
  key: string,
  init: Partial<KeyboardEventInit> = {},
): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, ...init });
}

describe('keyboard utils', () => {
  it('isModKey uses ctrl on non-Mac platforms', () => {
    expect(isModKey(keyEvent('n', { ctrlKey: true }))).toBe(true);
    expect(isModKey(keyEvent('n', { metaKey: true }))).toBe(false);
  });

  it('matchesShortcut respects mod/shift/alt flags', () => {
    const event = keyEvent('r', { ctrlKey: true, shiftKey: true });
    expect(matchesShortcut(event, { key: 'r', mod: true, shift: true })).toBe(true);
    expect(matchesShortcut(event, { key: 'r', mod: true, shift: false })).toBe(false);
  });

  it('matchesShortcut is case-insensitive for letter keys', () => {
    const event = keyEvent('A', { ctrlKey: true });
    expect(matchesShortcut(event, { key: 'a', mod: true })).toBe(true);
  });

  it('isEditableTarget detects form fields but not plain divs', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    expect(isEditableTarget(input)).toBe(true);

    const div = document.createElement('div');
    document.body.appendChild(div);
    expect(isEditableTarget(div)).toBe(false);

    input.remove();
    div.remove();
  });

  it('isEditableTarget does not treat checkbox inputs as text fields', () => {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    document.body.appendChild(checkbox);
    expect(isEditableTarget(checkbox)).toBe(false);
    checkbox.remove();
  });

  it('isDeleteKey matches Delete and Backspace', () => {
    expect(isDeleteKey(keyEvent('Delete'))).toBe(true);
    expect(isDeleteKey(keyEvent('Backspace'))).toBe(true);
    expect(isDeleteKey(keyEvent('a'))).toBe(false);
  });
});
