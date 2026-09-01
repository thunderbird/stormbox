// @vitest-environment happy-dom

import { flushPromises } from '@vue/test-utils';
import {
  effectScope,
  nextTick,
  ref,
} from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BodyAttachmentRow } from '../../../src/types';
import {
  DOWNLOAD_URL_REVOKE_DELAY_MS,
  MAX_RASTER_PREVIEW_BYTES,
  MAX_TEXT_PREVIEW_BYTES,
} from '../../../src/utils/attachment-presentation';
import { useMessageAttachments } from '../../../src/composables/useMessageAttachments';
import { attachmentPart } from '../_fixtures/rows';

function part(overrides: Partial<BodyAttachmentRow> = {}): BodyAttachmentRow {
  return attachmentPart({ name: 'attachment.bin', ...overrides });
}

function setup(
  attachment: BodyAttachmentRow,
  downloadAttachment: (...args: any[]) => Promise<Blob>,
) {
  const messageId = ref<number | null>(1);
  const accountId = ref<number | null>(7);
  const attachments = ref([attachment]);
  const resolvedCidPartIds = ref<ReadonlySet<string>>(new Set());
  const cidResolutionSettled = ref(true);
  const scope = effectScope();
  let presentation: ReturnType<typeof useMessageAttachments>;
  scope.run(() => {
    presentation = useMessageAttachments({
      messageId,
      accountId,
      attachments,
      resolvedCidPartIds,
      cidResolutionSettled,
    }, {
      getRepository: async () => ({ downloadAttachment } as any),
    });
  });
  return {
    scope,
    messageId,
    accountId,
    attachments,
    presentation: presentation!,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useMessageAttachments object URL lifecycle', () => {
  it.each<[string, number | null]>([
    ['known', MAX_TEXT_PREVIEW_BYTES + 100],
    ['unknown', null],
  ])('requests a truncating lookahead for %s-size text', async (_label, size) => {
    const downloadAttachment = vi.fn(async () => new Blob([
      new Uint8Array(MAX_TEXT_PREVIEW_BYTES + 1).fill(0x78),
    ], { type: 'text/plain' }));
    const { scope, presentation } = setup(part({
      name: 'large.txt',
      mime_type: 'text/plain',
      size,
      charset: 'utf-8',
    }), downloadAttachment);
    await nextTick();

    await presentation.preview(presentation.rows.value[0].key);

    expect(downloadAttachment).toHaveBeenCalledWith(7, expect.objectContaining({
      blobId: 'blob-1',
      maxBytes: MAX_TEXT_PREVIEW_BYTES + 1,
      truncateAtMaxBytes: true,
    }));
    expect(presentation.rows.value[0].textPreview?.text)
      .toHaveLength(MAX_TEXT_PREVIEW_BYTES);
    expect(presentation.rows.value[0].textPreview?.truncated).toBe(true);
    scope.stop();
  });

  it('downgrades an oversized unknown-size raster after a strict bounded attempt', async () => {
    const downloadAttachment = vi.fn(async (_accountId, options) => {
      expect(options.truncateAtMaxBytes).toBeUndefined();
      throw Object.assign(new Error('download exceeds limit'), {
        type: 'tooLarge',
        maxBytes: MAX_RASTER_PREVIEW_BYTES,
      });
    });
    const { scope, presentation } = setup(part({
      name: 'unknown-size.png',
      mime_type: 'image/png',
      size: null,
    }), downloadAttachment);

    await flushPromises();
    await nextTick();

    expect(downloadAttachment).toHaveBeenCalledWith(7, expect.objectContaining({
      blobId: 'blob-1',
      maxBytes: MAX_RASTER_PREVIEW_BYTES,
    }));
    expect(presentation.rows.value[0].rasterUnavailable).toBe(true);
    expect(presentation.rows.value[0].error).toBeNull();
    expect(presentation.rows.value[0].failedAction).toBeNull();
    scope.stop();
  });

  it('revokes raster preview URLs when the selected message changes', async () => {
    const png = new Blob([new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ])], { type: 'image/png' });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
      width: 1,
      height: 1,
      close: vi.fn(),
    })));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:raster-preview');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const {
      scope, messageId, attachments, presentation,
    } = setup(part({
      name: 'photo.png',
      mime_type: 'image/png',
      size: png.size,
    }), async () => png);

    await flushPromises();
    await nextTick();
    expect(presentation.rows.value[0].previewUrl).toBe('blob:raster-preview');

    messageId.value = 2;
    attachments.value = [];
    await nextTick();
    scope.stop();
    expect(revoke).toHaveBeenCalledWith('blob:raster-preview');
  });

  it('sanitizes download names and revokes transient URLs after the save window', async () => {
    vi.useFakeTimers();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    let savedAs = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function captureName() {
      savedAs = this.download;
    });
    const { scope, presentation } = setup(part({
      name: '../../CON\u202e.txt',
    }), async () => new Blob(['download']));
    await nextTick();

    await presentation.download(presentation.rows.value[0].key);

    expect(savedAs).toBe('_CON.txt');
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DOWNLOAD_URL_REVOKE_DELAY_MS);
    expect(revoke).toHaveBeenCalledWith('blob:download');
    scope.stop();
  });

  it('keeps a download URL alive across a message change until its timer expires', async () => {
    vi.useFakeTimers();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:message-download');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const {
      scope, messageId, attachments, presentation,
    } = setup(part({ name: 'report.pdf' }), async () => new Blob(['report']));
    await nextTick();

    await presentation.download(presentation.rows.value[0].key);
    messageId.value = 2;
    attachments.value = [];
    await nextTick();

    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DOWNLOAD_URL_REVOKE_DELAY_MS - 1);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:message-download');
    scope.stop();
  });

  it('keeps an active transfer across a null-to-same-account restoration', async () => {
    let resolveDownload: (blob: Blob) => void = () => {};
    const deferred = new Promise<Blob>((resolve) => {
      resolveDownload = resolve;
    });
    let transferSignal: AbortSignal | undefined;
    const downloadAttachment = vi.fn(async (_accountId, options) => {
      transferSignal = options.signal;
      return deferred;
    });
    const {
      scope, accountId, presentation,
    } = setup(part({
      name: 'notes.txt',
      mime_type: 'text/plain',
      charset: 'utf-8',
    }), downloadAttachment);
    await nextTick();

    const pending = presentation.preview(presentation.rows.value[0].key);
    await flushPromises();
    accountId.value = null;
    await nextTick();

    expect(transferSignal?.aborted).toBe(false);
    accountId.value = 7;
    await nextTick();
    expect(transferSignal?.aborted).toBe(false);

    resolveDownload(new Blob(['restored preview'], { type: 'text/plain' }));
    await pending;

    expect(downloadAttachment).toHaveBeenCalledTimes(1);
    expect(presentation.rows.value[0].textPreview?.text).toBe('restored preview');
    scope.stop();
  });

  it('ignores a stale completion after selection changes', async () => {
    let resolveDownload: (blob: Blob) => void = () => {};
    const deferred = new Promise<Blob>((resolve) => {
      resolveDownload = resolve;
    });
    let transferSignal: AbortSignal | undefined;
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stale');
    const { scope, messageId, attachments, presentation } = setup(
      part({ name: 'stale.pdf' }),
      async (_accountId, options) => {
        transferSignal = options.signal;
        return deferred;
      },
    );
    await nextTick();

    const pending = presentation.download(presentation.rows.value[0].key);
    await flushPromises();
    messageId.value = 2;
    attachments.value = [];
    await nextTick();
    expect(transferSignal?.aborted).toBe(true);
    resolveDownload(new Blob(['old message']));
    await pending;

    expect(createUrl).not.toHaveBeenCalled();
    scope.stop();
  });

  it('cancels an active transfer when the owning account changes', async () => {
    let resolveDownload: (blob: Blob) => void = () => {};
    const deferred = new Promise<Blob>((resolve) => {
      resolveDownload = resolve;
    });
    let transferSignal: AbortSignal | undefined;
    const {
      scope, accountId, presentation,
    } = setup(part({
      name: 'account-bound.txt',
      mime_type: 'text/plain',
      charset: 'utf-8',
    }), async (_accountId, options) => {
      transferSignal = options.signal;
      return deferred;
    });
    await nextTick();

    const pending = presentation.preview(presentation.rows.value[0].key);
    await flushPromises();
    accountId.value = 8;
    await nextTick();

    expect(transferSignal?.aborted).toBe(true);
    resolveDownload(new Blob(['stale account'], { type: 'text/plain' }));
    await pending;
    expect(presentation.rows.value[0].textPreview).toBeNull();
    scope.stop();
  });

  it('revokes a pending download URL when the view is disposed', async () => {
    vi.useFakeTimers();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pending-download');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { scope, presentation } = setup(
      part({ name: 'report.pdf' }),
      async () => new Blob(['report']),
    );
    await nextTick();
    await presentation.download(presentation.rows.value[0].key);

    scope.stop();

    expect(revoke).toHaveBeenCalledWith('blob:pending-download');
  });

  it('downgrades a declared raster with mismatched bytes to row-only download', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn());
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:unsafe');
    const { scope, presentation } = setup(part({
      name: 'not-really.png',
      mime_type: 'image/png',
      size: 8,
    }), async () => new Blob(['<svg/>'], { type: 'image/png' }));

    await flushPromises();
    await nextTick();

    expect(presentation.rows.value[0].rasterUnavailable).toBe(true);
    expect(presentation.rows.value[0].previewUrl).toBeNull();
    expect(createUrl).not.toHaveBeenCalled();
    scope.stop();
  });
});
