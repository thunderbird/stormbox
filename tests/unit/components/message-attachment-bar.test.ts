// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { nextTick, reactive } from 'vue';
import { describe, expect, it } from 'vitest';

import MessageAttachmentBar from '../../../src/components/MessageAttachmentBar.vue';
import type { MessageAttachmentRow } from '../../../src/composables/useMessageAttachments';

function attachmentRow(): MessageAttachmentRow {
  return reactive({
    key: 'part-1\u0000blob-1',
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

describe('MessageAttachmentBar progress status', () => {
  it('keeps one live status node through progress and exposes terminal errors', async () => {
    const row = attachmentRow();
    const wrapper = mount(MessageAttachmentBar, {
      props: { rows: [row] },
    });
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
});
