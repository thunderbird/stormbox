// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { nextTick, reactive } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MessageAttachmentBar from '../../../src/components/MessageAttachmentBar.vue';
import type { MessageAttachmentRow } from '../../../src/composables/useMessageAttachments';

function attachmentRow(index = 1): MessageAttachmentRow {
  return reactive({
    key: `part-${index}\u0000blob-${index}`,
    part: {
      part_id: 'part-1',
      blob_id: 'blob-1',
      name: 'report.pdf',
      mime_type: 'application/pdf',
      size: 100,
      disposition: 'attachment',
      cid: null,
      charset: null,
    },
    previewKind: 'pdf-browser',
    pdfViewerToken: 'viewer-token',
    pending: null,
    progress: null,
    error: null,
    failedAction: null,
    previewUrl: null,
    textPreview: null,
    showPreview: false,
    rasterUnavailable: false,
    autoPreviewAttempted: false,
  }) as MessageAttachmentRow;
}

const mounted: Array<ReturnType<typeof mount>> = [];
const observers = new Set<{
  targets: Set<Element>;
  callback: ResizeObserverCallback;
}>();

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    targets = new Set<Element>();

    constructor(public callback: ResizeObserverCallback) {
      observers.add(this);
    }

    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  });
});

afterEach(() => {
  mounted.splice(0).forEach(wrapper => wrapper.unmount());
  observers.clear();
  vi.unstubAllGlobals();
});

function reportHeight(target: Element, height: number) {
  const entry = {
    target,
    borderBoxSize: [{ blockSize: height, inlineSize: 300 }],
    contentRect: { width: 300, height },
  } as unknown as ResizeObserverEntry;
  for (const observer of observers) {
    if (observer.targets.has(target)) observer.callback([entry], {} as ResizeObserver);
  }
}

function listHeight(wrapper: ReturnType<typeof mount>, height: number): void {
  Object.defineProperty(wrapper.get('ul').element, 'scrollHeight', { value: height, configurable: true });
}

async function overflowBar() {
  const rows = [attachmentRow(1), attachmentRow(2), attachmentRow(3)];
  const wrapper = mount(MessageAttachmentBar, { props: { rows, contextKey: 10 }, attachTo: document.body });
  mounted.push(wrapper);
  await nextTick();
  const bar = wrapper.element as HTMLElement;
  bar.style.maxHeight = '100px';
  bar.style.borderTopWidth = '1px';
  listHeight(wrapper, 140);
  reportHeight(wrapper.get('.message-attachment-bar__heading').element, 30);
  reportHeight(wrapper.get('li').element, 44);
  await nextTick();
  return { wrapper, rows };
}

describe('MessageAttachmentBar', () => {
  it('keeps one live status node through progress and exposes terminal errors', async () => {
    const row = attachmentRow();
    const wrapper = mount(MessageAttachmentBar, {
      props: { rows: [row] },
    });
    mounted.push(wrapper);
    const status = wrapper.get('[role="status"]');
    const statusElement = status.element;

    row.pending = 'download';
    row.progress = {
      direction: 'download',
      phase: 'transferring',
      loaded: 0,
      total: 100,
    };
    await nextTick();
    expect(wrapper.get('[role="status"]').element).toBe(statusElement);
    expect(wrapper.get('[role="status"]').text()).toBe('Downloading 0%');

    row.progress = {
      direction: 'download',
      phase: 'complete',
      loaded: 100,
      total: 100,
    };
    await nextTick();
    expect(wrapper.get('[role="status"]').element).toBe(statusElement);
    expect(wrapper.get('[role="status"]').text()).toBe('Download complete 100%');

    row.pending = null;
    row.progress = null;
    row.error = 'Download canceled.';
    await nextTick();
    expect(wrapper.get('[role="status"]').element).toBe(statusElement);
    expect(wrapper.get('[role="status"]').text()).toBe('');
    expect(wrapper.get('[role="alert"]').text()).toBe('Download canceled.');
  });

  it('tracks a complete first row when its progress or error content changes without replacing controls', async () => {
    const row = attachmentRow();
    const wrapper = mount(MessageAttachmentBar, { props: { rows: [row] }, attachTo: document.body });
    mounted.push(wrapper);
    await nextTick();
    const heading = wrapper.get('.message-attachment-bar__heading').element;
    const entry = wrapper.get('li').element;
    const download = wrapper.get('button[aria-label="Download report.pdf"]').element as HTMLButtonElement;
    download.focus();
    reportHeight(heading, 30);
    reportHeight(entry, 44);
    await nextTick();
    const bar = wrapper.element as HTMLElement;
    expect(bar.style.getPropertyValue('--attachment-heading-height')).toBe('30px');
    expect(bar.style.getPropertyValue('--attachment-first-row-height')).toBe('44px');

    row.error = 'Download failed. Please check your connection and try again.';
    row.failedAction = 'download';
    await nextTick();
    reportHeight(entry, 96);
    await nextTick();
    expect(bar.style.getPropertyValue('--attachment-first-row-height')).toBe('96px');
    expect(wrapper.get('li').element).toBe(entry);
    expect(wrapper.get('button[aria-label="Download report.pdf"]').element).toBe(download);
    expect(document.activeElement).toBe(download);
    expect(wrapper.get('[role="alert"]').text()).toBe(row.error);
  });

  it('measures the new first row when attachments change while retaining the list shell', async () => {
    const wrapper = mount(MessageAttachmentBar, { props: { rows: [attachmentRow()] } });
    mounted.push(wrapper);
    await nextTick();
    const list = wrapper.get('ul').element;
    const firstEntry = wrapper.get('li').element;
    reportHeight(firstEntry, 40);
    await nextTick();

    const replacement = attachmentRow();
    replacement.key = 'other-part\u0000other-blob';
    await wrapper.setProps({ rows: [replacement] });
    await nextTick();
    const replacementEntry = wrapper.get('li').element;
    expect(replacementEntry).not.toBe(firstEntry);
    expect(wrapper.get('ul').element).toBe(list);
    reportHeight(replacementEntry, 72);
    await nextTick();
    expect((wrapper.element as HTMLElement).style.getPropertyValue('--attachment-first-row-height')).toBe('72px');

    await wrapper.setProps({ rows: [] });
    expect(wrapper.find('section').exists()).toBe(false);
    await wrapper.setProps({ rows: [attachmentRow()] });
    await nextTick();
    reportHeight(wrapper.get('li').element, 54);
    await nextTick();
    expect((wrapper.element as HTMLElement).style.getPropertyValue('--attachment-first-row-height')).toBe('54px');
  });

  it('keeps measuring the surviving first row when preceding inline attachments disappear', async () => {
    const inline = attachmentRow();
    inline.key = 'inline-part\u0000inline-blob';
    const attachment = attachmentRow();
    const wrapper = mount(MessageAttachmentBar, { props: { rows: [inline, attachment] } });
    mounted.push(wrapper);
    await nextTick();
    const retainedEntry = wrapper.findAll('li')[1]!.element;

    await wrapper.setProps({ rows: [attachment] });
    await nextTick();
    expect(wrapper.get('li').element).toBe(retainedEntry);
    reportHeight(retainedEntry, 72);
    await nextTick();
    expect((wrapper.element as HTMLElement).style.getPropertyValue('--attachment-first-row-height')).toBe('72px');
  });

  it('collapses overflowing lists to one accessible row and restores the same controls on expansion', async () => {
    const { wrapper } = await overflowBar();
    const list = wrapper.get('ul').element as HTMLElement;
    const entries = wrapper.findAll('li');
    const secondDownload = entries[1]!.get('button').element;
    const toggle = wrapper.get('.message-attachment-bar__toggle');
    expect(toggle.isVisible()).toBe(true);
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(toggle.attributes('aria-controls')).toBe(list.id);
    list.scrollTop = 70;
    (secondDownload as HTMLButtonElement).focus();

    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(toggle.text()).toBe('Expand');
    expect(list.scrollTop).toBe(0);
    expect(entries[0]!.attributes('aria-hidden')).toBeUndefined();
    expect(entries[1]!.attributes('aria-hidden')).toBe('true');
    expect(entries[1]!.attributes('inert')).toBeDefined();
    expect(entries[1]!.classes()).toContain('message-attachment-row--collapsed');
    expect(wrapper.classes()).toContain('message-attachment-bar--collapsed');
    expect(document.activeElement).toBe(toggle.element);

    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(entries[1]!.attributes('aria-hidden')).toBeUndefined();
    expect(entries[1]!.attributes('inert')).toBeUndefined();
    expect(entries[1]!.get('button').element).toBe(secondDownload);
  });

  it('resets expansion and scroll for a new message or attachment set without resetting on progress', async () => {
    const { wrapper, rows } = await overflowBar();
    const list = wrapper.get('ul').element as HTMLElement;
    const firstEntry = wrapper.get('li').element;
    const toggle = wrapper.get('.message-attachment-bar__toggle');
    await toggle.trigger('click');

    rows[0]!.pending = 'download';
    rows[0]!.progress = { direction: 'download', phase: 'transferring', loaded: 5, total: 100 };
    await nextTick();
    reportHeight(firstEntry, 60);
    await nextTick();
    expect(toggle.attributes('aria-expanded')).toBe('false');

    list.scrollTop = 40;
    await wrapper.setProps({ contextKey: 11 });
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(list.scrollTop).toBe(0);
    expect(wrapper.get('li').element).toBe(firstEntry);

    await toggle.trigger('click');
    list.scrollTop = 25;
    await wrapper.setProps({ rows: [rows[0]!, attachmentRow(4)] });
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(list.scrollTop).toBe(0);
    expect(wrapper.get('li').element).toBe(firstEntry);
  });

  it('removes unnecessary disclosure after a parent resize and preserves useful keyboard focus', async () => {
    const { wrapper } = await overflowBar();
    const toggle = wrapper.get('.message-attachment-bar__toggle');
    await toggle.trigger('click');
    (toggle.element as HTMLButtonElement).focus();
    expect(document.activeElement).toBe(toggle.element);

    (wrapper.element as HTMLElement).style.maxHeight = '300px';
    reportHeight(wrapper.element.parentElement!, 1500);
    await nextTick();
    expect(toggle.isVisible()).toBe(false);
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(wrapper.findAll('li').every(row => row.attributes('inert') == null)).toBe(true);
    expect(document.activeElement).toBe(wrapper.get('li a').element);
  });

  it('focuses the attachment region when disclosure disappears while the first row is pending', async () => {
    const { wrapper, rows } = await overflowBar();
    const toggle = wrapper.get('.message-attachment-bar__toggle');
    rows[0]!.pending = 'download';
    await nextTick();
    (toggle.element as HTMLButtonElement).focus();

    (wrapper.element as HTMLElement).style.maxHeight = '300px';
    reportHeight(wrapper.element.parentElement!, 1500);
    await nextTick();
    expect(toggle.isVisible()).toBe(false);
    expect(document.activeElement === wrapper.element).toBe(true);
  });

  it('leaves existing attachment focus in place when resizing removes disclosure', async () => {
    const { wrapper } = await overflowBar();
    const download = wrapper.get('li button').element as HTMLButtonElement;
    download.focus();

    (wrapper.element as HTMLElement).style.maxHeight = '300px';
    reportHeight(wrapper.element.parentElement!, 1500);
    await nextTick();
    expect(wrapper.get('.message-attachment-bar__toggle').isVisible()).toBe(false);
    expect(document.activeElement).toBe(download);
  });

  it('shows disclosure when a later row grows beyond an initially fitting list', async () => {
    const { wrapper } = await overflowBar();
    const toggle = wrapper.get('.message-attachment-bar__toggle');
    listHeight(wrapper, 60);
    reportHeight(wrapper.findAll('li')[1]!.element, 24);
    await nextTick();
    expect(toggle.isVisible()).toBe(false);

    listHeight(wrapper, 150);
    reportHeight(wrapper.findAll('li')[1]!.element, 90);
    await nextTick();
    expect(toggle.isVisible()).toBe(true);
    expect(toggle.attributes('aria-expanded')).toBe('true');
  });
});
