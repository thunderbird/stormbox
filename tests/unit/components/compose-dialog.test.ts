// @vitest-environment happy-dom

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import ComposeDialog from '../../../src/components/ComposeDialog.vue';
import { useComposeStore } from '../../../src/stores/compose-store';

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
