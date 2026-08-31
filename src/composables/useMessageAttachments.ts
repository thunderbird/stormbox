import {
  computed,
  onScopeDispose,
  reactive,
  watch,
} from 'vue';
import type { ComputedRef, Ref } from 'vue';

import type { BlobTransferProgress, Repository } from '../db/repository';
import type { BodyAttachmentRow } from '../types';
import {
  attachmentPreviewKind,
  canDecodeRasterBlob,
  decodePlainTextPreview,
  DOWNLOAD_URL_REVOKE_DELAY_MS,
  hasMatchingRasterSignature,
  MAX_RASTER_PREVIEW_BYTES,
  MAX_TEXT_PREVIEW_BYTES,
  sanitizeAttachmentFilename,
  shouldSuppressResolvedCidPart,
} from '../utils/attachment-presentation';
import { getRepositoryAsync } from './useRepository';

type AttachmentOperation = 'preview' | 'download';

const PDF_VIEWER_CHANNEL_PREFIX = 'stormbox-pdf-viewer:';
const PDF_VIEWER_READY_TIMEOUT_MS = 15_000;

export interface MessageAttachmentRow {
  key: string;
  part: BodyAttachmentRow;
  previewKind: ReturnType<typeof attachmentPreviewKind>;
  pdfViewerToken: string;
  pending: AttachmentOperation | null;
  progress: BlobTransferProgress | null;
  error: string | null;
  failedAction: AttachmentOperation | null;
  previewUrl: string | null;
  textPreview: { text: string; truncated: boolean } | null;
  showPreview: boolean;
  rasterUnavailable: boolean;
  autoPreviewAttempted: boolean;
}

interface MessageAttachmentDependencies {
  getRepository?: () => Promise<Pick<Repository, 'downloadAttachment'>>;
}

interface UseMessageAttachmentsOptions {
  messageId: Ref<number | null>;
  accountId: ComputedRef<number | null> | Ref<number | null>;
  attachments: ComputedRef<BodyAttachmentRow[]> | Ref<BodyAttachmentRow[]>;
  resolvedCidPartIds: Ref<ReadonlySet<string>>;
  cidResolutionSettled: Ref<boolean>;
}

function attachmentKey(part: BodyAttachmentRow): string {
  return `${part.part_id}\u0000${part.blob_id ?? ''}`;
}

function operationError(error: any, action: AttachmentOperation): string {
  if (error?.type === 'tooLarge') {
    return action === 'preview'
      ? 'This file is too large to preview safely.'
      : 'This file exceeds the download limit.';
  }
  if (error?.type === 'cancelled' || error?.name === 'AbortError') return '';
  return action === 'preview'
    ? 'Preview failed. Try again or download the file.'
    : 'Download failed. Try again.';
}

export function useMessageAttachments(
  options: UseMessageAttachmentsOptions,
  dependencies: MessageAttachmentDependencies = {},
) {
  const getRepository = dependencies.getRepository ?? getRepositoryAsync;
  const states = reactive(new Map<string, MessageAttachmentRow>());
  const controllers = new Set<AbortController>();
  const downloadUrls = new Set<string>();
  const downloadUrlTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let generation = 0;
  let autoPreviewRun = 0;
  let transferMessageId = options.messageId.value;
  // Query refreshes can temporarily hide the selected row without changing
  // which message owns an in-flight attachment transfer.
  let transferAccountId = options.accountId.value;

  function revokeUrl(url: string | null): void {
    if (!url || typeof URL.revokeObjectURL !== 'function') return;
    URL.revokeObjectURL(url);
  }

  function revokeDownloadUrl(url: string): void {
    const timer = downloadUrlTimers.get(url);
    if (timer != null) clearTimeout(timer);
    downloadUrlTimers.delete(url);
    if (!downloadUrls.delete(url)) return;
    revokeUrl(url);
  }

  function disposeState(state: MessageAttachmentRow): void {
    revokeUrl(state.previewUrl);
    state.previewUrl = null;
  }

  function stopOperations(): void {
    for (const controller of controllers) controller.abort();
    controllers.clear();
  }

  function cleanupPreviewUrls(): void {
    for (const state of states.values()) disposeState(state);
  }

  function cleanupDownloadUrls(): void {
    for (const url of [...downloadUrls]) revokeDownloadUrl(url);
  }

  function resetForMessage(): void {
    generation += 1;
    autoPreviewRun += 1;
    stopOperations();
    cleanupPreviewUrls();
    states.clear();
  }

  function syncStates(): void {
    const liveKeys = new Set<string>();
    for (const part of options.attachments.value) {
      const key = attachmentKey(part);
      liveKeys.add(key);
      const existing = states.get(key);
      if (existing) {
        existing.part = part;
        existing.previewKind = attachmentPreviewKind(part);
        continue;
      }
      states.set(key, reactive({
        key,
        part,
        previewKind: attachmentPreviewKind(part),
        pdfViewerToken: globalThis.crypto.randomUUID(),
        pending: null,
        progress: null,
        error: null,
        failedAction: null,
        previewUrl: null,
        textPreview: null,
        showPreview: false,
        rasterUnavailable: false,
        autoPreviewAttempted: false,
      }) as MessageAttachmentRow);
    }
    for (const [key, state] of states) {
      if (liveKeys.has(key)) continue;
      disposeState(state);
      states.delete(key);
    }
  }

  const rows = computed(() => options.attachments.value
    .map((part) => states.get(attachmentKey(part)))
    .filter((state): state is MessageAttachmentRow => state != null)
    .filter((state) => !shouldSuppressResolvedCidPart(
      state.part,
      options.resolvedCidPartIds.value,
    )));

  function operationContext() {
    return {
      generation,
      messageId: transferMessageId,
      accountId: transferAccountId,
    };
  }

  function isCurrent(context: ReturnType<typeof operationContext>): boolean {
    return context.generation === generation
      && context.messageId != null
      && context.messageId === transferMessageId
      && context.messageId === options.messageId.value
      && context.accountId != null
      && context.accountId === transferAccountId
      && (
        options.accountId.value == null
        || context.accountId === options.accountId.value
      );
  }

  function updateProgress(
    state: MessageAttachmentRow,
    operation: AttachmentOperation,
    context: ReturnType<typeof operationContext>,
    progress: BlobTransferProgress,
  ): void {
    if (!isCurrent(context) || states.get(state.key) !== state || state.pending !== operation) {
      return;
    }
    state.progress = progress;
  }

  async function downloadPart(
    state: MessageAttachmentRow,
    operation: AttachmentOperation,
    maxBytes?: number,
    truncateAtMaxBytes = false,
  ): Promise<
    | { blob: Blob; context: ReturnType<typeof operationContext> }
    | { error: any; context: ReturnType<typeof operationContext> }
    | null
  > {
    const context = operationContext();
    if (
      context.messageId == null
      || context.accountId == null
      || !state.part.blob_id
      || state.pending != null
    ) {
      return null;
    }

    const controller = new AbortController();
    controllers.add(controller);
    state.pending = operation;
    state.progress = null;
    state.error = null;
    state.failedAction = null;
    try {
      const repository = await getRepository();
      if (!isCurrent(context)) return null;
      const blob = await repository.downloadAttachment(context.accountId, {
        blobId: state.part.blob_id,
        type: state.part.mime_type || 'application/octet-stream',
        name: state.part.name || 'attachment',
        ...(maxBytes == null ? {} : { maxBytes }),
        ...(truncateAtMaxBytes ? { truncateAtMaxBytes: true } : {}),
        signal: controller.signal,
        onProgress: (progress) => updateProgress(state, operation, context, progress),
      });
      if (!isCurrent(context) || states.get(state.key) !== state) return null;
      return { blob, context };
    } catch (error) {
      if (isCurrent(context) && states.get(state.key) === state) {
        const message = operationError(error, operation);
        if (message) {
          state.error = message;
          state.failedAction = operation;
        }
        return { error, context };
      }
      return null;
    } finally {
      controllers.delete(controller);
    }
  }

  function finishOperation(
    state: MessageAttachmentRow,
    operation: AttachmentOperation,
  ): void {
    if (states.get(state.key) !== state || state.pending !== operation) return;
    state.pending = null;
    state.progress = null;
  }

  async function loadRasterPreview(state: MessageAttachmentRow): Promise<void> {
    if (state.pending != null) return;
    state.autoPreviewAttempted = true;
    try {
      const result = await downloadPart(state, 'preview', MAX_RASTER_PREVIEW_BYTES);
      if (!result) return;
      if ('error' in result) {
        if (result.error?.type === 'tooLarge') {
          state.rasterUnavailable = true;
          state.error = null;
          state.failedAction = null;
        }
        return;
      }
      const { blob, context } = result;
      const valid = await hasMatchingRasterSignature(blob, state.part.mime_type);
      if (!isCurrent(context) || states.get(state.key) !== state) return;
      const decoded = valid ? await canDecodeRasterBlob(blob) : false;
      if (!isCurrent(context) || states.get(state.key) !== state) return;
      if (!valid || !decoded) {
        disposeState(state);
        state.rasterUnavailable = true;
        state.error = null;
        state.failedAction = null;
        return;
      }
      if (typeof URL.createObjectURL !== 'function') {
        state.error = 'Preview is unavailable in this browser.';
        state.failedAction = null;
        state.rasterUnavailable = true;
        return;
      }
      const url = URL.createObjectURL(blob);
      if (!isCurrent(context) || states.get(state.key) !== state) {
        revokeUrl(url);
        return;
      }
      disposeState(state);
      state.previewUrl = url;
      state.showPreview = true;
      state.rasterUnavailable = false;
    } finally {
      finishOperation(state, 'preview');
    }
  }

  async function loadTextPreview(state: MessageAttachmentRow): Promise<void> {
    if (state.pending != null) return;
    try {
      const result = await downloadPart(
        state,
        'preview',
        MAX_TEXT_PREVIEW_BYTES + 1,
        true,
      );
      if (!result || 'error' in result) return;
      const { blob, context } = result;
      const preview = await decodePlainTextPreview(
        blob,
        state.part.charset,
        state.part.size,
      );
      if (!isCurrent(context) || states.get(state.key) !== state) return;
      state.textPreview = preview;
      state.showPreview = true;
    } catch (error) {
      const context = operationContext();
      if (!isCurrent(context) || states.get(state.key) !== state) return;
      state.error = operationError(error, 'preview');
      state.failedAction = 'preview';
    } finally {
      finishOperation(state, 'preview');
    }
  }

  function waitForPdfViewer(channel: BroadcastChannel): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), PDF_VIEWER_READY_TIMEOUT_MS);
      channel.onmessage = (event) => {
        if (event.data?.type !== 'ready') return;
        clearTimeout(timer);
        resolve(true);
      };
    });
  }

  async function openPdf(state: MessageAttachmentRow): Promise<void> {
    if (state.pending != null) return;
    const channel = new BroadcastChannel(
      `${PDF_VIEWER_CHANNEL_PREFIX}${state.pdfViewerToken}`,
    );
    const viewerReady = waitForPdfViewer(channel);
    try {
      const result = await downloadPart(state, 'preview');
      const ready = await viewerReady;
      if (!ready) {
        if (states.get(state.key) === state) {
          state.error = 'The PDF viewer did not open. Try again or download the file.';
          state.failedAction = null;
        }
        return;
      }
      if (!result || 'error' in result) {
        channel.postMessage({
          type: 'error',
          message: 'The PDF could not be loaded. Close this tab and try again.',
        });
        if (states.get(state.key) === state) {
          state.error = 'The PDF could not be opened. Try again or download the file.';
          state.failedAction = null;
        }
        return;
      }
      if (!isCurrent(result.context) || states.get(state.key) !== state) {
        channel.postMessage({
          type: 'error',
          message: 'PDF opening was cancelled.',
        });
        return;
      }
      channel.postMessage({
        type: 'pdf',
        blob: result.blob,
        name: sanitizeAttachmentFilename(state.part.name),
      });
      if (states.get(state.key) === state) {
        state.error = null;
        state.failedAction = null;
      }
    } finally {
      channel.close();
      finishOperation(state, 'preview');
    }
  }

  async function preview(key: string): Promise<void> {
    const state = states.get(key);
    if (!state || state.rasterUnavailable) return;
    if (state.previewUrl || state.textPreview) {
      state.showPreview = !state.showPreview;
      return;
    }
    if (state.previewKind === 'raster-auto') {
      await loadRasterPreview(state);
    } else if (state.previewKind === 'text-on-demand') {
      await loadTextPreview(state);
    } else if (state.previewKind === 'pdf-browser') {
      await openPdf(state);
    }
  }

  async function download(key: string): Promise<void> {
    const state = states.get(key);
    if (!state || state.pending != null) return;
    try {
      const result = await downloadPart(state, 'download');
      if (!result || 'error' in result || typeof URL.createObjectURL !== 'function') return;
      const { blob, context } = result;
      if (!isCurrent(context) || typeof document === 'undefined') return;

      const url = URL.createObjectURL(blob);
      downloadUrls.add(url);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = sanitizeAttachmentFilename(state.part.name);
      anchor.hidden = true;
      document.body.appendChild(anchor);
      try {
        anchor.click();
        const timer = setTimeout(
          () => revokeDownloadUrl(url),
          DOWNLOAD_URL_REVOKE_DELAY_MS,
        );
        downloadUrlTimers.set(url, timer);
      } catch (error) {
        revokeDownloadUrl(url);
        state.error = operationError(error, 'download');
        state.failedAction = 'download';
      } finally {
        anchor.remove();
      }
    } finally {
      finishOperation(state, 'download');
    }
  }

  async function retry(key: string): Promise<void> {
    const state = states.get(key);
    if (!state?.failedAction) return;
    if (state.failedAction === 'download') {
      await download(key);
      return;
    }
    state.autoPreviewAttempted = false;
    await preview(key);
  }

  async function runAutoPreviews(run: number): Promise<void> {
    if (!options.cidResolutionSettled.value) return;
    for (const state of rows.value) {
      if (run !== autoPreviewRun) return;
      if (
        state.previewKind !== 'raster-auto'
        || state.rasterUnavailable
        || state.autoPreviewAttempted
        || state.previewUrl
        || !state.part.blob_id
      ) {
        continue;
      }
      await loadRasterPreview(state);
    }
  }

  function scheduleAutoPreviews(): void {
    const run = (autoPreviewRun += 1);
    queueMicrotask(() => {
      if (run === autoPreviewRun) void runAutoPreviews(run);
    });
  }

  watch([options.messageId, options.accountId], ([nextMessageId, nextAccountId]) => {
    if (nextMessageId !== transferMessageId) {
      transferMessageId = nextMessageId;
      transferAccountId = nextAccountId;
      resetForMessage();
      return;
    }
    if (nextAccountId == null || nextAccountId === transferAccountId) return;

    const hadOwningAccount = transferAccountId != null;
    transferAccountId = nextAccountId;
    if (!hadOwningAccount) return;

    resetForMessage();
    syncStates();
    scheduleAutoPreviews();
  });
  watch(options.attachments, () => {
    syncStates();
    scheduleAutoPreviews();
  }, { immediate: true });
  watch([options.resolvedCidPartIds, options.cidResolutionSettled], scheduleAutoPreviews);

  onScopeDispose(() => {
    resetForMessage();
    cleanupDownloadUrls();
  });

  return {
    rows,
    preview,
    download,
    retry,
  };
}
