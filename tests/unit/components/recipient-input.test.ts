// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';

import RecipientInput from '../../../src/components/RecipientInput.vue';
import type { RecipientEntry } from '../../../src/stores/compose-store';
import type { AutocompleteCandidate } from '../../../src/stores/contacts-store';

/**
 * The recipient control: what makes a pill, what a pill does, and what the
 * suggestion list is allowed to do while the user is still typing.
 *
 * Mounted directly rather than through ComposeDialog, so a failure names
 * the control rather than the dialog around it. The `entries` prop is
 * re-applied from the emitted value the way a parent binding would, since
 * most of the behaviour here is about what happens to what is already
 * committed.
 */
function mountControl(options: {
  entries?: RecipientEntry[];
  query?: (
    prefix: string, limit: number, exclude: string[],
  ) => Promise<AutocompleteCandidate[]>;
  forget?: (email: string) => Promise<boolean>;
  browseAll?: () => Promise<AutocompleteCandidate[]>;
  taken?: string[];
  debounceMs?: number;
} = {}) {
  const wrapper = mount(RecipientInput, {
    attachTo: document.body,
    props: {
      label: 'To',
      inputId: 'compose-to',
      entries: options.entries ?? [],
      debounceMs: options.debounceMs ?? 0,
      ...(options.query ? { query: options.query } : {}),
      ...(options.forget ? { forget: options.forget } : {}),
      ...(options.browseAll ? { browseAll: options.browseAll } : {}),
      ...(options.taken ? { taken: options.taken } : {}),
      // A parent holds the committed recipients, so the control sees its
      // own emissions come back as props.
      'onUpdate:entries': (entries: RecipientEntry[]) => wrapper.setProps({ entries }),
    },
  });
  return wrapper;
}

const input = (wrapper: any) => wrapper.get('input[role="combobox"]');
const pills = (wrapper: any) => wrapper.findAll('.pill').map((pill: any) => ({
  text: pill.find('.pill__text').text(),
  invalid: pill.classes('pill--invalid'),
}));
const options = (wrapper: any) => wrapper.findAll('[role="option"]')
  .map((option: any) => option.find('.ac-email').text());
/** The option elements themselves, for asserting on what is inside a row. */
const optionRows = (wrapper: any) => wrapper.findAll('[role="option"]');

/** Let the debounce fire and the query it issued settle. */
async function settle(wrapper: any) {
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  await flushPromises();
  await nextTick();
  return wrapper;
}

async function type(wrapper: any, value: string) {
  const field = input(wrapper);
  field.element.value = value;
  // Typing leaves the caret after what was typed, and the control reads it
  // to tell a separator from a comma inside a display name.
  field.element.setSelectionRange(value.length, value.length);
  await field.trigger('input');
  return field;
}

async function typeAndCommit(wrapper: any, value: string, key = 'Enter') {
  const field = await type(wrapper, value);
  await field.trigger('keydown', { key });
  await nextTick();
  return field;
}

function pasteInto(wrapper: any, pasted: string) {
  const event = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: () => pasted },
  });
  input(wrapper).element.dispatchEvent(event);
  return nextTick();
}

const CONTACTS: AutocompleteCandidate[] = [
  { name: 'Bob', email: 'bob@example.com', source: 'contact' },
  { name: 'Bobbie', email: 'bobbie@example.com', source: 'history' },
];

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('RecipientInput committing', () => {
  it('commits a typed address as a pill', async () => {
    const wrapper = mountControl();

    await typeAndCommit(wrapper, 'Alice <alice@example.com>');

    expect(wrapper.emitted('update:entries')?.at(-1)?.[0])
      .toEqual([{ name: 'Alice', email: 'alice@example.com' }]);
    expect(pills(wrapper)).toEqual([{ text: 'Alice', invalid: false }]);
    expect(input(wrapper).element.value).toBe('');
  });

  it.each([',', ';'])('commits on %s, which is what the key means', async (key) => {
    const wrapper = mountControl();

    await typeAndCommit(wrapper, 'alice@example.com', key);

    expect(pills(wrapper)).toEqual([{ text: 'alice@example.com', invalid: false }]);
  });

  it.each([',', ';'])('leaves %s alone inside a display name', async (key) => {
    // "Smith, Alice" is one recipient. Committing at the comma would cut it
    // in half and leave an unreadable fragment where a name was being typed.
    const wrapper = mountControl();

    const field = await type(wrapper, '"Smith');
    const event = new window.KeyboardEvent('keydown', { key, cancelable: true });
    field.element.dispatchEvent(event);
    await nextTick();

    expect(event.defaultPrevented, 'the character has to reach the field').toBe(false);
    expect(wrapper.emitted('update:entries')).toBeUndefined();
    expect(pills(wrapper)).toEqual([]);
  });

  it('commits on a comma once the display name is closed', async () => {
    const wrapper = mountControl();

    await typeAndCommit(wrapper, '"Smith, Alice" <alice@example.com>', ',');

    expect(pills(wrapper)).toEqual([{ text: 'Smith, Alice', invalid: false }]);
    expect(wrapper.emitted('update:entries')?.at(-1)?.[0])
      .toEqual([{ name: 'Smith, Alice', email: 'alice@example.com' }]);
  });

  it('keeps text that parses to no recipient at all', async () => {
    // An empty group is legal and contributes nobody, but the text was
    // typed and clearing the field silently reads as the control eating it.
    const wrapper = mountControl();

    await typeAndCommit(wrapper, 'Team:;');

    expect(pills(wrapper)).toEqual([{ text: 'Team:;', invalid: true }]);
  });

  it('lets a stray separator go without a word', async () => {
    const wrapper = mountControl();

    await typeAndCommit(wrapper, ' , ');

    expect(pills(wrapper)).toEqual([]);
    expect(wrapper.emitted('update:entries')).toBeUndefined();
  });

  it('commits what is still in the field when focus leaves it', async () => {
    // Typing an address and clicking Send is the ordinary way to send a
    // message; an entry that only counts once Enter is pressed loses it.
    const wrapper = mountControl();

    await type(wrapper, 'alice@example.com');
    await input(wrapper).trigger('blur');
    await nextTick();

    expect(pills(wrapper)).toEqual([{ text: 'alice@example.com', invalid: false }]);
  });

  it('keeps an entry that is not an address, marked as more than a colour', async () => {
    const wrapper = mountControl();

    await typeAndCommit(wrapper, 'not an address');

    expect(wrapper.emitted('update:entries')?.at(-1)?.[0])
      .toEqual([{ text: 'not an address', invalid: true }]);
    const pill = wrapper.get('.pill--invalid');
    // Colour is not a message (WCAG 1.4.1): the glyph and the accessible
    // name both have to say what the pill is.
    expect(pill.find('.pill__warning').exists()).toBe(true);
    expect(pill.get('.pill__label').attributes('aria-invalid')).toBe('true');
    expect(pill.get('.pill__label').attributes('aria-label'))
      .toContain('not a valid address');
  });

  it('commits every address of a multi-address entry, fragments in place', async () => {
    const wrapper = mountControl();

    await typeAndCommit(wrapper, 'alice@example.com, rubbish, bob@example.com');

    expect(pills(wrapper)).toEqual([
      { text: 'alice@example.com', invalid: false },
      { text: 'rubbish', invalid: true },
      { text: 'bob@example.com', invalid: false },
    ]);
  });

  it('does not commit the same address twice', async () => {
    const wrapper = mountControl({ entries: [{ email: 'alice@example.com' }] });

    await typeAndCommit(wrapper, 'ALICE@example.com');

    expect(pills(wrapper)).toEqual([{ text: 'alice@example.com', invalid: false }]);
  });

  it('treats a punycode respelling as the recipient already committed', async () => {
    // One address, two legal spellings (CS-3.5): the pill holds the Unicode
    // domain, the second commit types its IDNA form. A plain lower-case
    // comparison sees two different strings and mints a second pill for the
    // same mailbox.
    const wrapper = mountControl({ entries: [{ email: 'jane@münchen.de' }] });

    await typeAndCommit(wrapper, 'jane@xn--mnchen-3ya.de');

    expect(pills(wrapper)).toEqual([{ text: 'jane@münchen.de', invalid: false }]);
  });

  it('commits nothing from an empty field', async () => {
    const wrapper = mountControl();

    await typeAndCommit(wrapper, '   ');

    expect(wrapper.emitted('update:entries')).toBeUndefined();
  });
});

describe('RecipientInput pills', () => {
  it('reopens a pill as an editable form of the same recipient', async () => {
    // A mistyped address is corrected where it is: retyping the whole thing
    // is what the pill was supposed to save. The text is the canonical
    // spelling of what the pill stands for rather than the keystrokes that
    // produced it — see CS-3.16 — so this types a real entry rather than
    // handing in a parsed one, which would assert nothing but the formatter.
    const wrapper = mountControl();
    await typeAndCommit(wrapper, '"Smith,  Alice" <alice@example.com> (sales)');
    expect(pills(wrapper)).toHaveLength(1);

    await wrapper.get('.pill__label').trigger('click');
    await nextTick();

    expect(pills(wrapper)).toEqual([]);
    expect(input(wrapper).element.value).toBe('"Smith,  Alice" <alice@example.com>');
    expect(wrapper.emitted('update:entries')?.at(-1)?.[0]).toEqual([]);
  });

  it('reopens to something that commits back to the same recipient', async () => {
    // The guarantee the canonical form has to keep: reopening and
    // re-committing a pill changes nothing about who is addressed.
    const wrapper = mountControl();
    await typeAndCommit(wrapper, '"Alice" <alice@example.com>');
    const committed = wrapper.emitted('update:entries')?.at(-1)?.[0];

    await wrapper.get('.pill__label').trigger('click');
    await nextTick();
    await input(wrapper).trigger('keydown', { key: 'Enter' });

    expect(wrapper.emitted('update:entries')?.at(-1)?.[0]).toEqual(committed);
  });

  it('reopens an invalid pill as exactly what was typed', async () => {
    const wrapper = mountControl({
      entries: [{ text: 'alice@@example.com', invalid: true }],
    });

    await wrapper.get('.pill__label').trigger('click');
    await nextTick();

    expect(input(wrapper).element.value).toBe('alice@@example.com');
  });

  it('keeps a half-typed entry when a pill is reopened beside it', async () => {
    const wrapper = mountControl({ entries: [{ email: 'alice@example.com' }] });

    await type(wrapper, 'bo');
    await wrapper.get('.pill__label').trigger('click');
    await nextTick();

    expect(input(wrapper).element.value).toBe('alice@example.com, bo');
  });

  it('removes a pill and leaves focus somewhere usable', async () => {
    const wrapper = mountControl({
      entries: [{ email: 'alice@example.com' }, { email: 'bob@example.com' }],
    });

    await wrapper.findAll('.pill__remove')[0].trigger('click');
    await nextTick();
    await flushPromises();

    expect(pills(wrapper)).toEqual([{ text: 'bob@example.com', invalid: false }]);
    // Removing the element that held focus would otherwise drop focus to
    // the document, which leaves a keyboard user nowhere (CS-3.9).
    expect(document.activeElement).not.toBe(document.body);
    expect(wrapper.element.contains(document.activeElement)).toBe(true);
  });

  it('names each recipient and its address for a screen reader', async () => {
    const wrapper = mountControl({
      entries: [{ name: 'Alice', email: 'alice@example.com' }],
    });

    expect(wrapper.get('.pill__label').attributes('aria-label'))
      .toBe('Alice <alice@example.com>. Activate to edit.');
    expect(wrapper.get('.pill__remove').attributes('aria-label'))
      .toBe('Remove Alice <alice@example.com>');
  });

  it('reopens the last recipient on backspace from an empty field', async () => {
    const wrapper = mountControl({
      entries: [{ email: 'alice@example.com' }, { email: 'bob@example.com' }],
    });

    await input(wrapper).trigger('keydown', { key: 'Backspace' });
    await nextTick();

    expect(pills(wrapper)).toEqual([{ text: 'alice@example.com', invalid: false }]);
    expect(input(wrapper).element.value).toBe('bob@example.com');
  });

  it('leaves the pills alone when backspace has text to delete', async () => {
    const wrapper = mountControl({ entries: [{ email: 'alice@example.com' }] });

    await type(wrapper, 'bo');
    await input(wrapper).trigger('keydown', { key: 'Backspace' });
    await nextTick();

    expect(pills(wrapper)).toEqual([{ text: 'alice@example.com', invalid: false }]);
  });
});

describe('RecipientInput suggestions', () => {
  it('offers matches and takes the highlighted one on Enter', async () => {
    const query = vi.fn(async () => CONTACTS);
    const wrapper = mountControl({ query });

    await type(wrapper, 'bo');
    await settle(wrapper);
    expect(options(wrapper)).toEqual(['bob@example.com', 'bobbie@example.com']);

    await input(wrapper).trigger('keydown', { key: 'ArrowDown' });
    await input(wrapper).trigger('keydown', { key: 'ArrowDown' });
    await input(wrapper).trigger('keydown', { key: 'Enter' });
    await nextTick();

    expect(pills(wrapper)).toEqual([{ text: 'Bobbie', invalid: false }]);
  });

  it('commits what was typed when Enter finds nothing highlighted', async () => {
    // CS-3.8: explicit input wins. Enter taking the first match instead
    // silently addresses somebody the user did not choose.
    const query = vi.fn(async () => CONTACTS);
    const wrapper = mountControl({ query });

    await type(wrapper, 'bob@elsewhere.example');
    await settle(wrapper);
    expect(options(wrapper).length).toBeGreaterThan(0);

    await input(wrapper).trigger('keydown', { key: 'Enter' });
    await nextTick();

    expect(pills(wrapper)).toEqual([{ text: 'bob@elsewhere.example', invalid: false }]);
  });

  it('takes a suggestion on a click without losing the field first', async () => {
    const query = vi.fn(async () => CONTACTS);
    const wrapper = mountControl({ query });

    await type(wrapper, 'bo');
    await settle(wrapper);
    await wrapper.findAll('[role="option"]')[0].trigger('click');
    await nextTick();

    expect(pills(wrapper)).toEqual([{ text: 'Bob', invalid: false }]);
    expect(document.activeElement).toBe(input(wrapper).element);
  });

  it('moves the highlight with the arrow keys and wraps at both ends', async () => {
    const query = vi.fn(async () => CONTACTS);
    const wrapper = mountControl({ query });
    await type(wrapper, 'bo');
    await settle(wrapper);

    const field = input(wrapper);
    expect(field.attributes('aria-activedescendant')).toBeUndefined();

    await field.trigger('keydown', { key: 'ArrowDown' });
    expect(field.attributes('aria-activedescendant')).toBe('compose-to-option-0');
    await field.trigger('keydown', { key: 'ArrowDown' });
    expect(field.attributes('aria-activedescendant')).toBe('compose-to-option-1');
    await field.trigger('keydown', { key: 'ArrowDown' });
    expect(field.attributes('aria-activedescendant')).toBe('compose-to-option-0');
    await field.trigger('keydown', { key: 'ArrowUp' });
    expect(field.attributes('aria-activedescendant')).toBe('compose-to-option-1');
    expect(wrapper.findAll('[role="option"]')[1].attributes('aria-selected')).toBe('true');
  });

  it('says how many matches there are, for a reader that cannot see them', async () => {
    const query = vi.fn(async () => CONTACTS);
    const wrapper = mountControl({ query });

    await type(wrapper, 'bo');
    await settle(wrapper);

    expect(wrapper.get('[role="status"]').text()).toBe('2 suggestions available');
    const field = input(wrapper);
    expect(field.attributes('aria-expanded')).toBe('true');
    expect(field.attributes('aria-controls')).toBe('compose-to-listbox');
    expect(wrapper.get('#compose-to-listbox').attributes('role')).toBe('listbox');
  });

  it('closes the list on Escape and keeps the key from anything above', async () => {
    const query = vi.fn(async () => CONTACTS);
    const wrapper = mountControl({ query });
    const above = vi.fn();
    document.body.addEventListener('keydown', above);

    await type(wrapper, 'bo');
    await settle(wrapper);
    await input(wrapper).trigger('keydown', { key: 'Escape' });
    await nextTick();

    expect(input(wrapper).attributes('aria-expanded')).toBe('false');
    // The dialog closes on Escape, and dismissing a list the user opened
    // must not also throw away the message.
    expect(above).not.toHaveBeenCalled();

    // With no list open the key is not this control's business.
    await input(wrapper).trigger('keydown', { key: 'Escape' });
    expect(above).toHaveBeenCalledTimes(1);
    document.body.removeEventListener('keydown', above);
  });

  it('waits for typing to pause before it asks', async () => {
    const query = vi.fn(async () => CONTACTS);
    const wrapper = mountControl({ query, debounceMs: 50 });

    await type(wrapper, 'b');
    await type(wrapper, 'bo');
    await type(wrapper, 'bob');
    expect(query).not.toHaveBeenCalled();

    await new Promise((resolve) => { setTimeout(resolve, 80); });
    await flushPromises();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('bob', 10, []);
  });

  it('asks for nothing until there are two characters to ask about', async () => {
    const query = vi.fn(async () => CONTACTS);
    const wrapper = mountControl({ query });

    await type(wrapper, 'b');
    await settle(wrapper);

    expect(query).not.toHaveBeenCalled();
    expect(wrapper.get('[role="status"]').text()).toBe('');
  });

  it('discards an answer that is no longer the question', async () => {
    // CS-3.10: answers arrive in whatever order the worker returns them,
    // and an earlier one landing later would replace the list for what the
    // user has since typed.
    const pending: Array<(value: AutocompleteCandidate[]) => void> = [];
    const query = vi.fn(() => new Promise<AutocompleteCandidate[]>((resolve) => {
      pending.push(resolve);
    }));
    const wrapper = mountControl({ query });

    await type(wrapper, 'bo');
    await settle(wrapper);
    await type(wrapper, 'bobbie');
    await settle(wrapper);
    expect(pending).toHaveLength(2);

    pending[1]([CONTACTS[1]]);
    await flushPromises();
    await nextTick();
    pending[0]([CONTACTS[0]]);
    await flushPromises();
    await nextTick();

    expect(options(wrapper)).toEqual(['bobbie@example.com']);
  });

  it.each([
    ['Escape dismisses it', async (wrapper: any) => {
      await input(wrapper).trigger('keydown', { key: 'Escape' });
    }],
    ['the field is left', async (wrapper: any) => {
      await input(wrapper).trigger('blur');
    }],
    ['a suggestion is taken', async (wrapper: any) => {
      await input(wrapper).trigger('keydown', { key: 'ArrowDown' });
      await input(wrapper).trigger('keydown', { key: 'Enter' });
    }],
  ])('does not reopen the list after %s', async (_case, dismiss) => {
    // An answer that lands after the list is dismissed used to reopen it,
    // under a field that may no longer have focus. An expanded combobox
    // without focus is also a state the dialog cannot be closed from: the
    // shortcut handler stands down for it and the control never gets the
    // key.
    const pending: Array<(value: AutocompleteCandidate[]) => void> = [];
    const query = vi.fn(() => new Promise<AutocompleteCandidate[]>((resolve) => {
      pending.push(resolve);
    }));
    const wrapper = mountControl({ query });

    await type(wrapper, 'bo');
    await settle(wrapper);
    pending[0](CONTACTS);
    await settle(wrapper);
    expect(input(wrapper).attributes('aria-expanded')).toBe('true');

    // A second query is in flight when the list stops being wanted.
    await type(wrapper, 'bob');
    await settle(wrapper);
    await dismiss(wrapper);
    expect(input(wrapper).attributes('aria-expanded')).toBe('false');

    pending[1](CONTACTS);
    await settle(wrapper);

    expect(input(wrapper).attributes('aria-expanded')).toBe('false');
    expect(options(wrapper)).toEqual([]);
  });

  it('does not ask again for text that has already been committed', async () => {
    // Picking a suggestion with the mouse deliberately does not blur, so
    // nothing else cancels the debounce: the pending query would land after
    // the pill and reopen the list over an empty field.
    const query = vi.fn(async () => CONTACTS);
    const wrapper = mountControl({ query, debounceMs: 40 });

    await type(wrapper, 'bo');
    await input(wrapper).trigger('keydown', { key: 'Enter' });
    await new Promise((resolve) => { setTimeout(resolve, 80); });
    await flushPromises();
    await nextTick();

    expect(query).not.toHaveBeenCalled();
    expect(input(wrapper).attributes('aria-expanded')).toBe('false');
  });

  it('says when there is nothing to suggest', async () => {
    // Emptying a live region announces nothing at all: a screen reader
    // speaks a change, not a clearing, so silence reads as "still waiting".
    const wrapper = mountControl({ query: async () => [] });

    await type(wrapper, 'zz');
    await settle(wrapper);

    expect(wrapper.get('[role="status"]').text()).toBe('No suggestions for zz');
  });

  it('says when the address book has nothing to show', async () => {
    const wrapper = mountControl({ browseAll: async () => [] });

    await wrapper.get('.recipient-input__browse').trigger('click');
    await settle(wrapper);

    expect(wrapper.get('[role="status"]').text()).toBe('No contacts to show');
  });

  it('does not pass a broken lookup off as an empty address book', async () => {
    // "No suggestions" is a fact about the address book. A user told that
    // stops typing a name it really holds and writes the address out by hand,
    // so a failure has to read as a failure.
    const wrapper = mountControl({
      query: async () => { throw new Error('worker gone'); },
    });

    await type(wrapper, 'zz');
    await settle(wrapper);

    expect(wrapper.get('[role="status"]').text()).toBe('Suggestions are unavailable');
    expect(options(wrapper), 'and no stale list is left to accept with Enter').toHaveLength(0);
  });

  it('says when the address book itself could not be read', async () => {
    const wrapper = mountControl({
      browseAll: async () => { throw new Error('worker gone'); },
    });

    await wrapper.get('.recipient-input__browse').trigger('click');
    await settle(wrapper);

    expect(wrapper.get('[role="status"]').text()).toBe('Contacts are unavailable');
  });

  it('keeps the list to itself when a lookup fails', async () => {
    // A rejected query used to leave the previous list up with its
    // highlight, so Enter accepted a suggestion for text long since
    // replaced — a wrong recipient, arrived at by pressing Enter.
    let fail = false;
    const query = vi.fn(async () => {
      if (fail) throw new Error('worker gone');
      return CONTACTS;
    });
    const wrapper = mountControl({ query });

    await type(wrapper, 'bo');
    await settle(wrapper);
    await input(wrapper).trigger('keydown', { key: 'ArrowDown' });
    expect(options(wrapper)).toHaveLength(2);

    fail = true;
    await type(wrapper, 'bobb');
    await settle(wrapper);

    expect(options(wrapper)).toEqual([]);
    expect(input(wrapper).attributes('aria-expanded')).toBe('false');
    await input(wrapper).trigger('keydown', { key: 'Enter' });
    expect(pills(wrapper)).toEqual([{ text: 'bobb', invalid: true }]);
  });

  it('reopens a dismissed list on the way down', async () => {
    // The combobox pattern expects Down to bring the popup back; without it
    // the only way back to the suggestions is to type another character.
    const query = vi.fn(async () => CONTACTS);
    const wrapper = mountControl({ query });

    await type(wrapper, 'bo');
    await settle(wrapper);
    await input(wrapper).trigger('keydown', { key: 'Escape' });
    expect(options(wrapper)).toEqual([]);

    await input(wrapper).trigger('keydown', { key: 'ArrowDown' });
    await settle(wrapper);

    expect(options(wrapper)).toEqual(['bob@example.com', 'bobbie@example.com']);
  });

  it('does not offer a recipient the message already has', async () => {
    const query = vi.fn(async () => CONTACTS);
    const wrapper = mountControl({
      query,
      entries: [{ email: 'bob@example.com' }],
      taken: [' Bobbie@Example.com '],
    });

    await type(wrapper, 'bo');
    await settle(wrapper);

    expect(options(wrapper)).toEqual([]);
    expect(input(wrapper).attributes('aria-expanded')).toBe('false');
  });

  it('shows at most ten matches, however many the source returns', async () => {
    const many = Array.from({ length: 40 }, (_, idx) => ({
      name: `Contact ${idx}`,
      email: `contact${idx}@example.com`,
      source: 'contact' as const,
    }));
    const query = vi.fn(async () => many);
    const wrapper = mountControl({ query });

    await type(wrapper, 'co');
    await settle(wrapper);

    expect(query).toHaveBeenCalledWith('co', 10, []);
    expect(options(wrapper)).toHaveLength(10);
  });

  it('tells the query which addresses are already entered (CS-3.7)', async () => {
    const query = vi.fn(async () => [] as AutocompleteCandidate[]);
    const wrapper = mountControl({
      query,
      entries: [{ name: 'Bob', email: 'bob@example.com' }],
      taken: ['carol@example.com'],
    });

    await type(wrapper, 'da');
    await settle(wrapper);

    // Both this field's own pills and the sibling fields' go with the
    // query, so an address already entered does not spend one of the ten
    // places and then get filtered out of the answer.
    expect(query).toHaveBeenCalledWith('da', 10, ['bob@example.com', 'carol@example.com']);
  });
});

describe('RecipientInput forgetting a suggestion (CS-3.13)', () => {
  const LEARNED: AutocompleteCandidate[] = [
    { name: 'Dana Learned', email: 'dana@example.com', source: 'history' },
    { name: 'Dana Contact', email: 'dana.contact@example.com', source: 'contact' },
  ];

  async function openList(forget: any) {
    const wrapper = mountControl({ query: async () => LEARNED, forget });
    await type(wrapper, 'dana');
    await settle(wrapper);
    return wrapper;
  }

  it('offers to forget a learned address but not a contact', async () => {
    const wrapper = await openList(vi.fn(async () => true));
    const rows = optionRows(wrapper);
    expect(rows[0].find('.ac-forget').exists()).toBe(true);
    // A contact is in the address book because the user put it there;
    // "remove this suggestion" would misdescribe what the control does.
    expect(rows[1].find('.ac-forget').exists()).toBe(false);
  });

  it('removes the suggestion from the open list once it is forgotten', async () => {
    const forget = vi.fn(async () => true);
    const wrapper = await openList(forget);

    await optionRows(wrapper)[0].get('.ac-forget').trigger('click');
    await settle(wrapper);

    expect(forget).toHaveBeenCalledWith('dana@example.com');
    expect(options(wrapper)).toHaveLength(1);
    expect(wrapper.text()).not.toContain('Dana Learned');
    // A shorter list is not an announcement of what left it.
    expect(wrapper.get('[role="status"]').text())
      .toContain('dana@example.com removed from suggestions');
  });

  it('leaves the list alone when the removal did not apply, and says so', async () => {
    const wrapper = await openList(vi.fn(async () => false));
    await optionRows(wrapper)[0].get('.ac-forget').trigger('click');
    await settle(wrapper);
    expect(options(wrapper)).toHaveLength(2);
    // Pressing ✕ and watching the row stay put is not an answer.
    expect(wrapper.get('[role="status"]').text())
      .toContain('dana@example.com could not be removed');
  });

  it('survives a failed removal without dropping the row', async () => {
    const wrapper = await openList(vi.fn(async () => { throw new Error('worker gone'); }));
    await optionRows(wrapper)[0].get('.ac-forget').trigger('click');
    await settle(wrapper);
    expect(wrapper.get('[role="status"]').text())
      .toContain('dana@example.com could not be removed');
    expect(options(wrapper)).toHaveLength(2);
  });

  it('forgets the highlighted suggestion on Shift+Delete', async () => {
    const forget = vi.fn(async () => true);
    const wrapper = await openList(forget);
    const field = input(wrapper);

    await field.trigger('keydown', { key: 'ArrowDown' });
    await field.trigger('keydown', { key: 'Delete', shiftKey: true });
    await settle(wrapper);

    // The ✕ is not focusable, so this is the whole keyboard route to it.
    expect(forget).toHaveBeenCalledWith('dana@example.com');
    expect(options(wrapper)).toHaveLength(1);
  });

  it('leaves plain Delete to the text field', async () => {
    const forget = vi.fn(async () => true);
    const wrapper = await openList(forget);
    const field = input(wrapper);

    await field.trigger('keydown', { key: 'ArrowDown' });
    await field.trigger('keydown', { key: 'Delete' });
    await settle(wrapper);

    expect(forget).not.toHaveBeenCalled();
  });

  it('does not offer removal at all without a way to do it', async () => {
    const wrapper = mountControl({ query: async () => LEARNED });
    await type(wrapper, 'dana');
    await settle(wrapper);
    expect(wrapper.find('.ac-forget').exists()).toBe(false);
  });
});

describe('RecipientInput browsing', () => {
  it('offers the address book when the name is not typeable', async () => {
    const browseAll = vi.fn(async () => CONTACTS);
    const wrapper = mountControl({ browseAll });

    await wrapper.get('.recipient-input__browse').trigger('click');
    await settle(wrapper);

    // No page size: a browse fetch that ends before the address book does
    // silently hides the rest (CS-3.12).
    expect(browseAll).toHaveBeenCalledWith();
    expect(options(wrapper)).toEqual(['bob@example.com', 'bobbie@example.com']);
    expect(wrapper.get('[role="status"]').text()).toBe('Showing 2 contacts');
  });

  it('opens the same list from the keyboard on an empty field', async () => {
    const browseAll = vi.fn(async () => CONTACTS);
    const wrapper = mountControl({ browseAll });

    await input(wrapper).trigger('keydown', { key: 'ArrowDown' });
    await settle(wrapper);

    expect(options(wrapper)).toEqual(['bob@example.com', 'bobbie@example.com']);
  });

  it('shows the whole address book, not a page of it', async () => {
    // The typeahead's 10-match cap keeps suggestions readable; the browse
    // list is a scroll, and every contact must be selectable from it
    // (CS-3.12) — 250 is large enough that any page-sized fetch or render
    // would fall short of it.
    const many = Array.from({ length: 250 }, (_, idx) => ({
      name: `Contact ${idx}`,
      email: `contact${idx}@example.com`,
      source: 'contact' as const,
    }));
    const wrapper = mountControl({ browseAll: async () => many });

    await wrapper.get('.recipient-input__browse').trigger('click');
    await settle(wrapper);

    expect(options(wrapper)).toHaveLength(250);
    expect(wrapper.get('[role="status"]').text()).toBe('Showing 250 contacts');
  });

  it('has no browse control where there is no address book to browse', () => {
    const wrapper = mountControl();
    expect(wrapper.find('.recipient-input__browse').exists()).toBe(false);
  });
});

describe('RecipientInput paste', () => {
  it('commits a pasted list rather than dropping it into the field', async () => {
    const wrapper = mountControl();

    await pasteInto(wrapper, '"Smith, Alice" <alice@example.com>, bob@example.com');

    expect(pills(wrapper)).toEqual([
      { text: 'Smith, Alice', invalid: false },
      { text: 'bob@example.com', invalid: false },
    ]);
    expect(input(wrapper).element.value).toBe('');
  });

  it.each([
    ['newlines', 'alice@example.com\nbob@example.com\r\ncarol@example.com'],
    ['semicolons', 'alice@example.com; bob@example.com; carol@example.com'],
    ['commas', 'alice@example.com, bob@example.com, carol@example.com'],
  ])('splits a paste on %s', async (_label, pasted) => {
    const wrapper = mountControl();

    await pasteInto(wrapper, pasted);

    expect(pills(wrapper).map((pill: any) => pill.text)).toEqual([
      'alice@example.com', 'bob@example.com', 'carol@example.com',
    ]);
  });

  it('keeps what a paste could not read, rather than pasting it as an address', async () => {
    const wrapper = mountControl();

    await pasteInto(wrapper, 'alice@example.com, https://example.com/page, bob@example.com');

    expect(pills(wrapper)).toEqual([
      { text: 'alice@example.com', invalid: false },
      { text: 'https://example.com/page', invalid: true },
      { text: 'bob@example.com', invalid: false },
    ]);
  });

  it('pastes onto the end of what was already typed', async () => {
    const wrapper = mountControl();

    await type(wrapper, 'alice@example.com');
    await pasteInto(wrapper, 'bob@example.com');

    expect(pills(wrapper).map((pill: any) => pill.text))
      .toEqual(['alice@example.com', 'bob@example.com']);
  });
});
