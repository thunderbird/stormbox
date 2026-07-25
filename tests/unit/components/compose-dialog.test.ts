// @vitest-environment happy-dom

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import ComposeDialog from '../../../src/components/ComposeDialog.vue';
import { useComposeStore } from '../../../src/stores/compose-store';
import { useContactsStore } from '../../../src/stores/contacts-store';

function firstTextNode(node) {
  if (node.nodeType === Node.TEXT_NODE) return node;
  for (const child of node.childNodes) {
    const match = firstTextNode(child);
    if (match) return match;
  }
  return null;
}

function selectEditorText(editor, start = 0, end = 5) {
  const text = firstTextNode(editor);
  expect(text?.nodeValue).toBeTruthy();

  editor.focus();
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);

  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

async function mountOpenCompose(htmlBody = 'hello world') {
  const composeStore = useComposeStore();
  composeStore.identities = [{
    id: 1,
    name: 'Sender',
    email: 'sender@example.com',
  } as any];
  composeStore.open({ htmlBody });

  const wrapper = mount(ComposeDialog, { attachTo: document.body });
  await nextTick();
  return { wrapper, composeStore };
}

async function pasteImageIntoEditor(editor, composeStore) {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const file = new File([bytes], 'paste.png', { type: 'image/png' });
  const clipboardData = {
    items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
    types: ['Files'],
    getData: () => '',
  };
  // Squire's real paste handler detects the image-only clipboard,
  // preventDefaults, and fires its 'pasteImage' custom event, which our
  // component listens for. Drive that whole path with a paste event.
  const pasteEvent = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(pasteEvent, 'clipboardData', { value: clipboardData });
  editor.dispatchEvent(pasteEvent);

  // FileReader.readAsDataURL is async; poll until the draft picks it up.
  for (let i = 0; i < 50 && !/<img[^>]+src="data:image\/png/i.test(composeStore.draft.htmlBody); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await nextTick();
  }
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('ComposeDialog rich text toolbar', () => {
  it('initializes Squire when compose opens after the component is already mounted', async () => {
    const composeStore = useComposeStore();
    composeStore.identities = [{
      id: 1,
      name: 'Sender',
      email: 'sender@example.com',
    } as any];

    const wrapper = mount(ComposeDialog, { attachTo: document.body });
    composeStore.open({ htmlBody: 'hello world' });
    await nextTick();
    await nextTick();

    const editor = wrapper.get('.editor').element;
    selectEditorText(editor);
    await wrapper.get('[aria-label="Bold"]').trigger('pointerdown');
    await wrapper.get('[aria-label="Bold"]').trigger('click');
    await nextTick();

    expect(composeStore.draft.htmlBody).toMatch(/<b\b[^>]*>hello<\/b>/i);
  });

  it('applies inline formatting to the selected editor text from toolbar buttons', async () => {
    const { wrapper, composeStore } = await mountOpenCompose();
    const editor = wrapper.get('.editor').element;

    selectEditorText(editor);
    await wrapper.get('[aria-label="Bold"]').trigger('pointerdown');
    await wrapper.get('[aria-label="Bold"]').trigger('click');
    await nextTick();

    expect(composeStore.draft.htmlBody).toMatch(/<b\b[^>]*>hello<\/b>/i);
  });

  it('depresses toolbar buttons when selected text already has that format', async () => {
    const { wrapper } = await mountOpenCompose('<p><b>hello</b> world</p>');
    const editor = wrapper.get('.editor').element;

    selectEditorText(editor);
    await nextTick();

    expect(wrapper.get('[aria-label="Bold"]').classes()).toContain('active');
  });

  it('formats root-level text typed into an empty editor', async () => {
    const { wrapper, composeStore } = await mountOpenCompose('');
    const editor = wrapper.get('.editor').element;
    editor.textContent = 'hello world';

    selectEditorText(editor);
    await wrapper.get('[aria-label="Bold"]').trigger('pointerdown');
    await wrapper.get('[aria-label="Bold"]').trigger('click');
    await nextTick();

    expect(composeStore.draft.htmlBody).toMatch(/<div><b\b[^>]*>hello<\/b> world<\/div>/i);
  });

  it('keeps the selected range when applying color controls', async () => {
    const { wrapper, composeStore } = await mountOpenCompose();
    const editor = wrapper.get('.editor').element;
    const colorInput = wrapper.get('input[aria-label="Text color"]');

    selectEditorText(editor);
    await colorInput.trigger('pointerdown');
    (colorInput.element as HTMLInputElement).value = '#ff0000';
    await colorInput.trigger('input');
    await nextTick();

    expect(composeStore.draft.htmlBody).toContain('color:#ff0000');
    expect(composeStore.draft.htmlBody).toContain('hello');
  });

  it('supports basic word-style keyboard shortcuts', async () => {
    const { wrapper, composeStore } = await mountOpenCompose();
    const editor = wrapper.get('.editor').element;

    selectEditorText(editor);
    const event = new window.KeyboardEvent('keydown', {
      key: 'i',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(event);
    await nextTick();

    expect(event.defaultPrevented).toBe(true);
    expect(composeStore.draft.htmlBody).toMatch(/<i\b[^>]*>hello<\/i>/i);
    expect(wrapper.get('[aria-label="Italic"]').classes()).toContain('active');
  });

  it('inlines a pasted image as a data: URL via the squire pasteImage hook', async () => {
    const { wrapper, composeStore } = await mountOpenCompose('<p>hello</p>');
    const editor = wrapper.get('.editor').element as HTMLElement;

    await pasteImageIntoEditor(editor, composeStore);

    expect(composeStore.draft.htmlBody).toMatch(/<img[^>]+src="data:image\/png;base64,/i);
    // Pasted images default to centered, applied to the containing block
    // (text-align) so the toolbar alignment buttons can re-align them.
    expect(composeStore.draft.htmlBody).toMatch(/text-align:\s*center/i);
  });

  it('re-aligns a pasted image with the toolbar alignment buttons', async () => {
    const { wrapper, composeStore } = await mountOpenCompose('<p>hello</p>');
    const editor = wrapper.get('.editor').element as HTMLElement;

    await pasteImageIntoEditor(editor, composeStore);
    expect(composeStore.draft.htmlBody).toMatch(/text-align:\s*center/i);

    await wrapper.get('[aria-label="Align right"]').trigger('pointerdown');
    await wrapper.get('[aria-label="Align right"]').trigger('click');
    await nextTick();

    expect(composeStore.draft.htmlBody).toMatch(/text-align:\s*right/i);
    expect(composeStore.draft.htmlBody).not.toMatch(/text-align:\s*center/i);
  });

  it('moves rightmost toolbar groups into More as width shrinks', async () => {
    const { wrapper } = await mountOpenCompose();
    const toolbar = wrapper.get('.compose-toolbar').element;
    const groupWidths = {
      style: 116,
      font: 180,
      insert: 70,
      lists: 130,
      alignment: 130,
    };

    Object.defineProperty(toolbar, 'clientWidth', { configurable: true, value: 500 });
    toolbar.querySelectorAll('[data-toolbar-group]').forEach((group: any) => {
      group.getBoundingClientRect = () => ({
        width: groupWidths[group.dataset.toolbarGroup as keyof typeof groupWidths],
      } as DOMRect);
    });
    (wrapper.get('.toolbar-more').element as any).getBoundingClientRect = () => ({ width: 70 } as DOMRect);

    window.dispatchEvent(new Event('resize'));
    await nextTick();
    await nextTick();

    expect(wrapper.find('[data-toolbar-group="alignment"]').exists()).toBe(false);
    expect(wrapper.find('[data-toolbar-group="lists"]').exists()).toBe(false);
    expect(wrapper.find('[data-toolbar-group="insert"]').exists()).toBe(true);
    expect(wrapper.get('.toolbar-more__menu').text()).toContain('Align left');
    expect(wrapper.get('.toolbar-more__menu').text()).toContain('Bulleted list');
  });
});

describe('ComposeDialog recipient fields', () => {
  const rowLabels = (wrapper: any) => wrapper.findAll('.row label').map((l: any) => l.text());
  const recipientRow = (wrapper: any, label: string) => wrapper
    .findAll('.row')
    .find((row: any) => row.find('label').text() === label);
  const recipientInput = (wrapper: any, label: string) => recipientRow(wrapper, label)
    .find('input');
  const pills = (wrapper: any, label: string) => recipientRow(wrapper, label)
    .findAll('.pill')
    .map((pill: any) => ({
      text: pill.find('.pill__text').text(),
      invalid: pill.classes('pill--invalid'),
    }));

  /**
   * Wait out the control's suggestion debounce and let the query settle.
   * Real time rather than fake, because other tests in this file poll on
   * real timers and swapping them out globally would stall those.
   */
  async function suggestionsSettled() {
    await new Promise((resolve) => { setTimeout(resolve, 160); });
    await flushPromises();
    await nextTick();
  }

  /** Type into a field and commit it the way Enter does. */
  async function enterRecipient(wrapper: any, label: string, value: string) {
    const input = recipientInput(wrapper, label);
    input.element.value = value;
    await input.trigger('input');
    await input.trigger('keydown', { key: 'Enter' });
    await nextTick();
    return input;
  }

  it('opens with To only, and reveals Cc and then Bcc on request', async () => {
    // Three empty fields on every new message is why Cc and Bcc were left
    // out to begin with; they appear when there is a reason for them.
    const { wrapper } = await mountOpenCompose();
    expect(rowLabels(wrapper)).toEqual(['From', 'To', 'Subject']);

    await wrapper.get('.recipient-add').trigger('click');
    expect(rowLabels(wrapper)).toEqual(['From', 'To', 'Cc', 'Subject']);

    await wrapper.get('.recipient-add').trigger('click');
    expect(rowLabels(wrapper)).toEqual(['From', 'To', 'Cc', 'Bcc', 'Subject']);
    expect(wrapper.find('.recipient-add').exists()).toBe(false);
  });

  it('shows Cc already filled by a reply-all without being asked', async () => {
    const composeStore = useComposeStore();
    composeStore.identities = [{ id: 1, email: 'sender@example.com' } as any];
    composeStore.open({
      to: [{ email: 'alice@example.com' }],
      cc: [{ name: 'Bob', email: 'bob@example.com' }],
    });
    const wrapper = mount(ComposeDialog, { attachTo: document.body });
    await nextTick();

    expect(rowLabels(wrapper)).toEqual(['From', 'To', 'Cc', 'Subject']);
    expect(pills(wrapper, 'Cc')).toEqual([{ text: 'Bob', invalid: false }]);
  });

  it('turns committed text into the draft addresses', async () => {
    const { wrapper, composeStore } = await mountOpenCompose();

    await enterRecipient(wrapper, 'To', '"Smith, Alice" <alice@example.com>, bob@example.com');

    expect(composeStore.draft.to).toEqual([
      { name: 'Smith, Alice', email: 'alice@example.com' },
      { email: 'bob@example.com' },
    ]);
    expect(pills(wrapper, 'To')).toEqual([
      { text: 'Smith, Alice', invalid: false },
      { text: 'bob@example.com', invalid: false },
    ]);
  });

  it('leaves what the user is typing alone', async () => {
    // An entry becomes a pill when the user says it is finished, not while
    // it is half-written: reformatting mid-word rewrites what is being
    // typed, and committing early makes a pill of `ali`.
    const { wrapper, composeStore } = await mountOpenCompose();
    const input = recipientInput(wrapper, 'To');

    input.element.value = 'ali';
    await input.trigger('input');
    await nextTick();

    expect(input.element.value).toBe('ali');
    expect(pills(wrapper, 'To')).toEqual([]);
    expect(composeStore.draft.to).toEqual([]);
  });

  it('commits an unreadable entry as an invalid pill that refuses the send', async () => {
    const { wrapper, composeStore } = await mountOpenCompose();

    await enterRecipient(wrapper, 'To', 'alice@example.com, not an address');

    expect(pills(wrapper, 'To')).toEqual([
      { text: 'alice@example.com', invalid: false },
      { text: 'not an address', invalid: true },
    ]);
    expect(composeStore.rejectedRecipients.to).toEqual(['not an address']);
    expect(composeStore.draft.to).toEqual([{ email: 'alice@example.com' }]);
  });

  it('adds a chosen suggestion beside the recipients already committed', async () => {
    const { wrapper, composeStore } = await mountOpenCompose();
    const contactsStore = useContactsStore();
    contactsStore.autocomplete = vi.fn(async () => [
      { name: 'Bob', email: 'bob@example.com', source: 'contact' },
    ]) as any;
    await enterRecipient(wrapper, 'To', '"Smith, Alice" <alice@example.com>');

    const input = recipientInput(wrapper, 'To');
    input.element.value = 'bo';
    await input.trigger('input');
    await suggestionsSettled();

    await wrapper.get('.autocomplete__option').trigger('click');
    await nextTick();

    expect(pills(wrapper, 'To')).toEqual([
      { text: 'Smith, Alice', invalid: false },
      { text: 'Bob', invalid: false },
    ]);
    expect(composeStore.draft.to).toEqual([
      { name: 'Smith, Alice', email: 'alice@example.com' },
      { name: 'Bob', email: 'bob@example.com' },
    ]);
  });

  it('re-reads the fields when a reply replaces the draft', async () => {
    const { wrapper, composeStore } = await mountOpenCompose();
    const input = recipientInput(wrapper, 'To');
    input.element.value = 'typing@example.com';
    await input.trigger('input');

    composeStore.open({ to: [{ name: 'Alice', email: 'alice@example.com' }] });
    await nextTick();

    expect(pills(wrapper, 'To')).toEqual([{ text: 'Alice', invalid: false }]);
    // The half-typed entry belonged to the message that was replaced.
    expect(recipientInput(wrapper, 'To').element.value).toBe('');
  });

  it('does not offer a contact who is already a recipient in another field', async () => {
    const { wrapper } = await mountOpenCompose();
    const contactsStore = useContactsStore();
    contactsStore.autocomplete = vi.fn(async () => [
      { name: 'Bob', email: 'bob@example.com', source: 'contact' },
      { name: 'Bobbie', email: 'bobbie@example.com', source: 'contact' },
    ]) as any;
    await enterRecipient(wrapper, 'To', 'bob@example.com');
    await wrapper.get('.recipient-add').trigger('click');

    const cc = recipientInput(wrapper, 'Cc');
    cc.element.value = 'bob';
    await cc.trigger('input');
    await suggestionsSettled();

    const offered = recipientRow(wrapper, 'Cc')
      .findAll('.autocomplete__option .ac-email')
      .map((el: any) => el.text());
    expect(offered).toEqual(['bobbie@example.com']);
  });
});

describe('ComposeDialog send control', () => {
  const footerButtons = (wrapper: any) => wrapper.findAll('footer button').map((b: any) => b.text());

  it('offers Send while the outcome of the draft is still open', async () => {
    const { wrapper } = await mountOpenCompose();
    expect(footerButtons(wrapper)).toContain('Send');
  });

  it('withdraws Send once a send has ended with an unknown outcome', async () => {
    // Re-sending would build a new message with a new Message-ID, which
    // the duplicate guard cannot match against the one that may already
    // be out. The only safe controls left are Discard and looking in
    // Sent (CS-1.9).
    const { wrapper, composeStore } = await mountOpenCompose();
    composeStore.outcomeUnknown = true;
    await nextTick();

    expect(footerButtons(wrapper)).not.toContain('Send');
    expect(footerButtons(wrapper)).toContain('Discard');
  });
});
