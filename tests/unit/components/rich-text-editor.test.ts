// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

import RichTextEditor from '../../../src/components/RichTextEditor.vue';

interface EditorContent {
  html: string;
  text: string;
}

interface OriginState {
  id: string;
  present: boolean;
  touched: boolean;
}

let mountedWrapper: ReturnType<typeof mount> | null = null;

function firstTextNode(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) return node as Text;
  for (const child of node.childNodes) {
    const match = firstTextNode(child);
    if (match) return match;
  }
  return null;
}

function selectEditorText(editor: HTMLElement, start = 0, end = 5) {
  const text = firstTextNode(editor);
  expect(text?.nodeValue).toBeTruthy();

  editor.focus();
  const range = document.createRange();
  range.setStart(text!, start);
  range.setEnd(text!, end);

  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

function selectBetween(startNode: Node, start: number, endNode: Node, end: number) {
  const range = document.createRange();
  range.setStart(startNode, start);
  range.setEnd(endNode, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

async function mountEditor(
  initialHtml = 'hello world',
  props: Record<string, unknown> = {},
) {
  const wrapper = mount(RichTextEditor, {
    attachTo: document.body,
    props: {
      accessibleLabel: 'Message body',
      contentKey: 'first',
      initialHtml,
      ...props,
    },
  });
  mountedWrapper = wrapper;
  await nextTick();
  return wrapper;
}

function latestUpdate(wrapper: ReturnType<typeof mount>): EditorContent | null {
  const updates = wrapper.emitted('update') ?? [];
  return (updates.at(-1)?.[0] as EditorContent | undefined) ?? null;
}

function latestOriginStates(wrapper: ReturnType<typeof mount>): OriginState[] {
  const updates = wrapper.emitted('tracked-origin-state') ?? [];
  return (updates.at(-1)?.[0] as OriginState[] | undefined) ?? [];
}

async function pasteImageIntoEditor(
  editor: HTMLElement,
  wrapper: ReturnType<typeof mount>,
) {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const file = new File([bytes], 'paste.png', { type: 'image/png' });
  const clipboardData = {
    items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
    types: ['Files'],
    getData: () => '',
  };
  // Squire converts an image-only paste into its pasteImage event.
  const pasteEvent = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(pasteEvent, 'clipboardData', { value: clipboardData });
  editor.dispatchEvent(pasteEvent);

  for (let i = 0; i < 50 && !/<img[^>]+src="data:image\/png/i.test(
    latestUpdate(wrapper)?.html ?? '',
  ); i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    await nextTick();
  }
}

afterEach(() => {
  mountedWrapper?.unmount();
  mountedWrapper = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('RichTextEditor content contract', () => {
  it('sanitizes initial HTML without emitting an update', async () => {
    const wrapper = await mountEditor(
      '<p onclick="window.bad = true">Safe<script>window.bad = true</script></p>',
    );
    const content = (wrapper.vm as any).getContent() as EditorContent;

    expect(content.html).toContain('Safe');
    expect(content.html).not.toMatch(/script|onclick/i);
    expect(wrapper.emitted('update')).toBeUndefined();
  });

  it('resets from a changed content key without emitting an update', async () => {
    const wrapper = await mountEditor('<p>First</p>');
    const editor = wrapper.get('.editor').element;

    await wrapper.setProps({
      contentKey: 'second',
      initialHtml: '<p>Second</p>',
    });
    await nextTick();
    await nextTick();

    expect(wrapper.get('.editor').element).toBe(editor);
    expect(wrapper.get('.editor').text()).toContain('Second');
    expect(wrapper.get('.editor').text()).not.toContain('First');
    expect(wrapper.emitted('update')).toBeUndefined();
  });

  it('exposes focus, get, and non-emitting set APIs', async () => {
    const wrapper = await mountEditor('<p>First</p>');
    const api = wrapper.vm as any;

    api.setContent('<p>Replacement</p>');
    api.focus();

    expect(api.getContent()).toMatchObject({
      html: expect.stringContaining('Replacement'),
      text: expect.stringContaining('Replacement'),
    });
    expect(document.activeElement).toBe(wrapper.get('.editor').element);
    expect(wrapper.emitted('update')).toBeUndefined();
  });

  it('emits serialized HTML and derived text as one paired value', async () => {
    const wrapper = await mountEditor();
    const editor = wrapper.get('.editor').element as HTMLElement;
    editor.innerHTML = '<div>Paired value</div>';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();

    expect(latestUpdate(wrapper)).toEqual({
      html: '<div>Paired value</div>',
      text: 'Paired value',
    });
    expect(Object.keys(latestUpdate(wrapper)!)).toEqual(['html', 'text']);
  });

  it('preserves block and br boundaries in emitted plain text', async () => {
    const wrapper = await mountEditor();
    const editor = wrapper.get('.editor').element as HTMLElement;
    editor.innerHTML = '<div>First<br>Second</div><div>Third</div>';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();

    expect(latestUpdate(wrapper)).toEqual({
      html: '<div>First<br>Second</div><div>Third</div>',
      text: 'First\nSecond\nThird',
    });
  });

  it('strips Squire ZWSP fixers while preserving intentional Unicode joins', async () => {
    const wrapper = await mountEditor();
    const editor = wrapper.get('.editor').element as HTMLElement;
    editor.innerHTML = '<div>Family 👨‍👩‍👧‍👦</div><div><b>\u200B</b><br></div>';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();

    expect(latestUpdate(wrapper)).toEqual({
      html: '<div>Family 👨‍👩‍👧‍👦</div><div><b></b><br></div>',
      text: 'Family 👨‍👩‍👧‍👦',
    });
  });

  it('reports exact UTF-8 byte lengths and limit validity', async () => {
    const wrapper = await mountEditor('<p>é</p>', {
      maxSerializedUtf8Bytes: 1024,
    });
    const api = wrapper.vm as any;
    const content = api.getContent() as EditorContent;

    expect(api.getValidation()).toEqual({
      valid: true,
      htmlBytes: new TextEncoder().encode(content.html).byteLength,
      textBytes: new TextEncoder().encode(content.text).byteLength,
      maxSerializedUtf8Bytes: 1024,
    });

    await wrapper.setProps({ maxSerializedUtf8Bytes: 1 });
    expect(api.getValidation().valid).toBe(false);
    expect(wrapper.emitted('update')).toBeUndefined();
  });
});

describe('RichTextEditor tracked origins', () => {
  const trackedHtml = '<p>Before signature</p>'
    + '<div data-stormbox-origin="signature">'
    + '<p>Signature text</p></div>'
    + '<p>After signature</p>';

  it('preserves a rich initial origin and leading editable block', async () => {
    const wrapper = await mountEditor(
      '<div><br></div><div data-stormbox-origin="signature">'
      + '<div>Rich <strong>signature</strong></div></div>',
    );
    const editor = wrapper.get('.editor').element as HTMLElement;
    const marker = editor.querySelector<HTMLElement>('[data-stormbox-origin="signature"]');

    expect(editor.firstElementChild?.querySelector('br')).not.toBeNull();
    expect(marker?.parentElement).toBe(editor);
    expect(marker?.querySelector('strong, b')?.textContent).toBe('signature');
    expect((wrapper.vm as any).getContent().html)
      .toContain('data-stormbox-origin="signature"');
  });

  it('keeps an untouched marker through formatting outside its region', async () => {
    const wrapper = await mountEditor(trackedHtml);
    const editor = wrapper.get('.editor').element as HTMLElement;
    const before = firstTextNode(editor.querySelector('p')!)!;
    editor.focus();
    selectBetween(before, 0, before, 6);

    await wrapper.get('[aria-label="Bold"]').trigger('pointerdown');
    await wrapper.get('[aria-label="Bold"]').trigger('click');
    await nextTick();

    expect(latestUpdate(wrapper)?.html).toContain('data-stormbox-origin="signature"');
    expect(latestOriginStates(wrapper)).toContainEqual({
      id: 'signature',
      present: true,
      touched: false,
    });
  });

  it('marks formatting inside or across a tracked region as touched', async () => {
    const wrapper = await mountEditor(trackedHtml);
    const editor = wrapper.get('.editor').element as HTMLElement;
    const marker = editor.querySelector<HTMLElement>('[data-stormbox-origin="signature"]')!;
    const signatureText = firstTextNode(marker)!;
    editor.focus();
    selectBetween(signatureText, 0, signatureText, 9);

    await wrapper.get('[aria-label="Italic"]').trigger('pointerdown');
    await wrapper.get('[aria-label="Italic"]').trigger('click');
    await nextTick();

    expect(latestOriginStates(wrapper)).toContainEqual({
      id: 'signature',
      present: true,
      touched: true,
    });
    expect(latestUpdate(wrapper)?.html)
      .toContain('data-stormbox-origin-touched="true"');

    const reset = (wrapper.vm as any).setContent(trackedHtml) as EditorContent;
    expect(reset.html).not.toContain('data-stormbox-origin-touched');
    const first = firstTextNode(editor.querySelector('p')!)!;
    const last = firstTextNode(editor.querySelectorAll('p')[2])!;
    selectBetween(first, 2, last, 5);
    await wrapper.get('[aria-label="Underline"]').trigger('pointerdown');
    await wrapper.get('[aria-label="Underline"]').trigger('click');
    await nextTick();

    expect(latestOriginStates(wrapper)).toContainEqual({
      id: 'signature',
      present: true,
      touched: true,
    });
  });

  it('treats removal of a tracked marker as a touched origin', async () => {
    const wrapper = await mountEditor(trackedHtml);
    const editor = wrapper.get('.editor').element as HTMLElement;
    editor.querySelector('[data-stormbox-origin="signature"]')?.remove();
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();

    expect(latestOriginStates(wrapper)).toContainEqual({
      id: 'signature',
      present: false,
      touched: true,
    });
    expect(latestUpdate(wrapper)?.html).not.toContain('data-stormbox-');
  });

  it('retains touched metadata and the marker through undo and redo', async () => {
    const wrapper = await mountEditor(trackedHtml);
    const editor = wrapper.get('.editor').element as HTMLElement;
    const marker = editor.querySelector<HTMLElement>('[data-stormbox-origin="signature"]')!;
    const signatureText = firstTextNode(marker)!;
    editor.focus();
    selectBetween(signatureText, 0, signatureText, 9);
    await wrapper.get('[aria-label="Bold"]').trigger('pointerdown');
    await wrapper.get('[aria-label="Bold"]').trigger('click');
    await nextTick();

    for (const key of ['z', 'y']) {
      editor.dispatchEvent(new KeyboardEvent('keydown', {
        key,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }));
      await nextTick();
      const html = (wrapper.vm as any).getContent().html as string;
      expect(html).toContain('data-stormbox-origin="signature"');
      expect(html).toContain('data-stormbox-origin-touched="true"');
    }
  });

  it('updates tracked content without moving an outside caret or clearing undo', async () => {
    const wrapper = await mountEditor(trackedHtml);
    const editor = wrapper.get('.editor').element as HTMLElement;
    const before = firstTextNode(editor.querySelector('p')!)!;
    editor.focus();
    selectBetween(before, 7, before, 7);
    const nextHtml = trackedHtml.replace('Signature text', 'Replacement signature');

    (wrapper.vm as any).updateTrackedContent('signature', nextHtml);
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    const selection = window.getSelection()!;
    expect(selection.anchorNode).toBe(before);
    expect(selection.anchorOffset).toBe(7);
    expect(editor.innerHTML).toContain('Replacement signature');

    editor.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }));
    await nextTick();
    expect((wrapper.vm as any).getContent().html).toContain('Signature text');
  });
});

describe('RichTextEditor toolbar', () => {
  it('applies inline formatting to selected editor text', async () => {
    const wrapper = await mountEditor();
    const editor = wrapper.get('.editor').element as HTMLElement;

    selectEditorText(editor);
    await wrapper.get('[aria-label="Bold"]').trigger('pointerdown');
    await wrapper.get('[aria-label="Bold"]').trigger('click');
    await nextTick();

    expect(latestUpdate(wrapper)?.html).toMatch(/<b\b[^>]*>hello<\/b>/i);
  });

  it('depresses toolbar buttons when selected text has that format', async () => {
    const wrapper = await mountEditor('<p><b>hello</b> world</p>');
    const editor = wrapper.get('.editor').element as HTMLElement;

    selectEditorText(editor);
    await nextTick();

    expect(wrapper.get('[aria-label="Bold"]').classes()).toContain('active');
  });

  it('formats root-level text typed into an empty editor', async () => {
    const wrapper = await mountEditor('');
    const editor = wrapper.get('.editor').element as HTMLElement;
    editor.textContent = 'hello world';

    selectEditorText(editor);
    await wrapper.get('[aria-label="Bold"]').trigger('pointerdown');
    await wrapper.get('[aria-label="Bold"]').trigger('click');
    await nextTick();

    expect(latestUpdate(wrapper)?.html)
      .toMatch(/<div><b\b[^>]*>hello<\/b> world<\/div>/i);
  });

  it('keeps the selected range when applying color controls', async () => {
    const wrapper = await mountEditor();
    const editor = wrapper.get('.editor').element as HTMLElement;
    const colorInput = wrapper.get('input[aria-label="Text color"]');

    selectEditorText(editor);
    await colorInput.trigger('pointerdown');
    (colorInput.element as HTMLInputElement).value = '#ff0000';
    await colorInput.trigger('input');
    await nextTick();

    expect(latestUpdate(wrapper)?.html).toContain('color:#ff0000');
    expect(latestUpdate(wrapper)?.html).toContain('hello');
  });

  it('supports basic word-style keyboard shortcuts', async () => {
    const wrapper = await mountEditor();
    const editor = wrapper.get('.editor').element as HTMLElement;

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
    expect(latestUpdate(wrapper)?.html).toMatch(/<i\b[^>]*>hello<\/i>/i);
    expect(wrapper.get('[aria-label="Italic"]').classes()).toContain('active');
  });

  it('advertises every formatting command that has a keyboard shortcut', async () => {
    const wrapper = await mountEditor();
    const shortcuts = [
      ['Bold', 'Control+B', 'Bold (Ctrl+B)'],
      ['Italic', 'Control+I', 'Italic (Ctrl+I)'],
      ['Underline', 'Control+U', 'Underline (Ctrl+U)'],
      ['Insert or remove link', 'Control+K', 'Insert or remove link (Ctrl+K)'],
      ['Undo', 'Control+Z', 'Undo (Ctrl+Z)'],
      [
        'Redo',
        'Control+Y Control+Shift+Z',
        'Redo (Ctrl+Y / Ctrl+Shift+Z)',
      ],
    ];

    shortcuts.forEach(([label, ariaKeyShortcuts, title]) => {
      const control = wrapper.get(`[aria-label="${label}"]`);
      expect(control.attributes('aria-keyshortcuts')).toBe(ariaKeyShortcuts);
      expect(control.attributes('title')).toBe(title);
    });
  });

  it('advertises macOS shortcuts with the Command modifier', async () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const wrapper = await mountEditor();

    expect(wrapper.get('[aria-label="Bold"]').attributes()).toMatchObject({
      'aria-keyshortcuts': 'Meta+B',
      title: 'Bold (⌘+B)',
    });
    expect(wrapper.get('[aria-label="Redo"]').attributes()).toMatchObject({
      'aria-keyshortcuts': 'Meta+Y Meta+Shift+Z',
      title: 'Redo (⌘+Y / ⌘+Shift+Z)',
    });
  });

  it('inlines a pasted image as a data URL', async () => {
    const wrapper = await mountEditor('<p>hello</p>');
    const editor = wrapper.get('.editor').element as HTMLElement;

    await pasteImageIntoEditor(editor, wrapper);

    expect(latestUpdate(wrapper)?.html)
      .toMatch(/<img[^>]+src="data:image\/png;base64,/i);
    expect(latestUpdate(wrapper)?.html).toMatch(/text-align:\s*center/i);
  });

  it('re-aligns a pasted image with toolbar alignment controls', async () => {
    const wrapper = await mountEditor('<p>hello</p>');
    const editor = wrapper.get('.editor').element as HTMLElement;

    await pasteImageIntoEditor(editor, wrapper);
    expect(latestUpdate(wrapper)?.html).toMatch(/text-align:\s*center/i);

    await wrapper.get('[aria-label="Align right"]').trigger('pointerdown');
    await wrapper.get('[aria-label="Align right"]').trigger('click');
    await nextTick();

    expect(latestUpdate(wrapper)?.html).toMatch(/text-align:\s*right/i);
    expect(latestUpdate(wrapper)?.html).not.toMatch(/text-align:\s*center/i);
  });

  it('opens one toolbar dropdown at a time', async () => {
    const wrapper = await mountEditor();
    const dropdowns = wrapper.get('.compose-toolbar').findAll('details');
    expect(dropdowns.length).toBeGreaterThanOrEqual(3);
    const [font, size] = dropdowns;

    font.element.open = true;
    await font.trigger('toggle');
    size.element.open = true;
    await size.trigger('toggle');

    expect(size.element.open).toBe(true);
    expect(font.element.open).toBe(false);
  });

  it('moves rightmost toolbar groups into More as width shrinks', async () => {
    const wrapper = await mountEditor();
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
    (wrapper.get('.toolbar-more').element as any).getBoundingClientRect = () =>
      ({ width: 70 } as DOMRect);

    window.dispatchEvent(new Event('resize'));
    await nextTick();
    await nextTick();

    expect(wrapper.find('[data-toolbar-group="alignment"]').exists()).toBe(false);
    expect(wrapper.find('[data-toolbar-group="lists"]').exists()).toBe(false);
    expect(wrapper.find('[data-toolbar-group="insert"]').exists()).toBe(true);
    expect(wrapper.get('.toolbar-more .toolbar-more__menu').text()).toContain('Align left');
    expect(wrapper.get('.toolbar-more .toolbar-more__menu').text()).toContain('Bulleted list');
  });
});
