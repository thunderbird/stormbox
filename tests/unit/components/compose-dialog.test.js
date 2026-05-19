// @vitest-environment happy-dom

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

vi.mock('../../../src/services/auth.js', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import ComposeDialog from '../../../src/components/ComposeDialog.vue';
import { useComposeStore } from '../../../src/stores/compose-store.js';

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
  }];
  composeStore.open({ htmlBody });

  const wrapper = mount(ComposeDialog, { attachTo: document.body });
  await nextTick();
  return { wrapper, composeStore };
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
    }];

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
    colorInput.element.value = '#ff0000';
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
    toolbar.querySelectorAll('[data-toolbar-group]').forEach((group) => {
      group.getBoundingClientRect = () => ({
        width: groupWidths[group.dataset.toolbarGroup],
      });
    });
    wrapper.get('.toolbar-more').element.getBoundingClientRect = () => ({ width: 70 });

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
