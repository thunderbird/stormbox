/**
 * Attachment state and upload orchestration for compose sessions: the
 * captured files, per-attempt abort controllers, blob-failure marks, and
 * the per-session upload queue. The compose store instantiates one
 * controller and keeps draft save, send, and send-later for itself; the
 * controller only exposes what those need (blob failures, missing blobs,
 * releasing a captured file).
 */

import type {
  AttachmentLimits,
  BlobTransferProgress,
  Repository,
} from '../db/repository';
import { sanitizeAttachmentFilename } from '../utils/attachment-presentation';
import { randomToken } from '../utils/random-token';

export type ComposeAttachmentSource = 'picker' | 'paste' | 'draft';
export type ComposeAttachmentStatus = 'uploading' | 'ready' | 'failed';

export interface ComposeAttachment {
  clientId: string;
  name: string;
  type: string;
  size: number;
  source: ComposeAttachmentSource;
  status: ComposeAttachmentStatus;
  uploadBlobId: string | null;
  canonicalBlobId: string | null;
  partId: string | null;
  error: string | null;
  progress: number;
}

export interface AttachmentPreflightObligation {
  id: string;
  accountId: number;
}

/** The slice of a compose session the controller reads and writes. */
export interface AttachmentSession {
  id: string;
  error: string | null;
  attachments: ComposeAttachment[];
  attachmentPreflights: AttachmentPreflightObligation[];
  failedSaveMutationId: number | null;
}

export interface ComposeAttachmentControllerDeps {
  sessionById(id: string | null | undefined): AttachmentSession | null;
  sessions(): readonly AttachmentSession[];
  activeSessionId(): string | null;
  accountId(): number | null;
  repo(): Pick<Repository, 'getAttachmentLimits' | 'uploadComposeAttachment'> | null;
  touchSession(sessionId: string): void;
  saveDraft(sessionId: string): Promise<unknown>;
  /** Lifts the autosave block once no attachment holds it any more. */
  unblockAutosave(sessionId: string): void;
}

export interface ComposeAttachmentController {
  isAttachmentBusy(sessionId?: string | null): boolean;
  addAttachments(
    filesInput: readonly File[] | FileList,
    source?: Exclude<ComposeAttachmentSource, 'draft'>,
    sessionId?: string | null,
  ): Promise<boolean>;
  retryAttachment(clientId: string, sessionId?: string | null): Promise<boolean>;
  cancelAttachment(clientId: string, sessionId?: string | null): boolean;
  removeAttachment(clientId: string, sessionId?: string | null): boolean;
  /** Whether any attachment of the session is marked as missing on the server. */
  hasBlobFailure(session: AttachmentSession): boolean;
  /**
   * Marks the given attachments as no longer held by the server and returns
   * whether any of them lacks a captured file to retry from.
   */
  markBlobsMissing(session: AttachmentSession, clientIds: string[]): boolean;
  /** Releases the captured file once the draft holds the attachment canonically. */
  forgetFile(clientId: string): void;
  clearPreflightsOutsideAccount(accountId: number | null): void;
  /** Aborts and forgets every upload of a session being disposed. */
  disposeSession(sessionId: string): void;
  /** Forgets blob-failure marks; per-session state goes through disposeSession. */
  reset(): void;
}

interface UploadRuntime {
  active: number;
  concurrency: number;
  queue: Array<{ clientId: string; totalAttachmentBytes: number }>;
}

function makeAttachmentClientId(): string {
  return `attachment-${randomToken()}`;
}

function makeAttachmentPreflightId(): string {
  return `preflight-${makeAttachmentClientId()}`;
}

export function createComposeAttachmentController(
  deps: ComposeAttachmentControllerDeps,
): ComposeAttachmentController {
  const attachmentFiles = new Map<string, File>();
  const attachmentControllers = new Map<string, AbortController>();
  const attachmentAttempts = new Map<string, number>();
  const attachmentBlobFailures = new Set<string>();
  const uploadRuntimes = new Map<string, UploadRuntime>();

  function uploadRuntimeFor(sessionId: string): UploadRuntime {
    let runtime = uploadRuntimes.get(sessionId);
    if (!runtime) {
      runtime = { active: 0, concurrency: 1, queue: [] };
      uploadRuntimes.set(sessionId, runtime);
    }
    return runtime;
  }

  function beginPreflight(session: AttachmentSession, accountId: number): string {
    const id = makeAttachmentPreflightId();
    session.attachmentPreflights.push({ id, accountId });
    return id;
  }

  function finishPreflight(session: AttachmentSession, id: string): void {
    const index = session.attachmentPreflights.findIndex((preflight) => preflight.id === id);
    if (index >= 0) session.attachmentPreflights.splice(index, 1);
  }

  function isAttachmentBusy(sessionId: string | null = deps.activeSessionId()): boolean {
    const session = deps.sessionById(sessionId);
    return !!session && (
      session.attachmentPreflights.length > 0
      || session.attachments.some((attachment) => attachment.status === 'uploading')
    );
  }

  function attachmentLimitError(
    files: readonly File[],
    limits: AttachmentLimits,
    existingBytes: number,
  ): string | null {
    if (![limits.maxSizeUpload, limits.maxSizeAttachmentsPerEmail, limits.maxConcurrentUpload]
      .every((value) => Number.isSafeInteger(value) && value > 0)) {
      return 'The server did not provide valid attachment limits. Nothing was uploaded.';
    }
    const oversized = files.find((file) => file.size > limits.maxSizeUpload);
    if (oversized) {
      return `"${oversized.name || 'attachment'}" is ${oversized.size} bytes; `
        + `the server upload limit is ${limits.maxSizeUpload} bytes.`;
    }
    const selectedBytes = files.reduce((sum, file) => sum + file.size, 0);
    const totalBytes = existingBytes + selectedBytes;
    if (!Number.isSafeInteger(totalBytes)) {
      return 'The selected attachments are too large to measure safely.';
    }
    if (totalBytes > limits.maxSizeAttachmentsPerEmail) {
      return `These attachments total ${totalBytes} bytes; the server message limit is `
        + `${limits.maxSizeAttachmentsPerEmail} bytes. Nothing was uploaded.`;
    }
    return null;
  }

  function attachmentTotalBytes(session: AttachmentSession): number {
    return session.attachments.reduce((total, attachment) => total + attachment.size, 0);
  }

  function hasBlobFailure(session: AttachmentSession): boolean {
    return session.attachments.some((attachment) =>
      attachmentBlobFailures.has(attachment.clientId));
  }

  function unblockRecoveredSave(session: AttachmentSession): void {
    if (hasBlobFailure(session) || session.failedSaveMutationId != null) return;
    deps.unblockAutosave(session.id);
  }

  function uploadErrorMessage(error: any, attachment: ComposeAttachment): string {
    if (error?.name === 'AbortError' || error?.type === 'cancelled') {
      return 'Upload canceled.';
    }
    return error?.message
      ? `Upload failed: ${error.message}`
      : `Could not upload "${sanitizeAttachmentFilename(attachment.name)}".`;
  }

  function updateProgress(
    sessionId: string,
    clientId: string,
    attempt: number,
    progress: BlobTransferProgress,
  ): void {
    if (attachmentAttempts.get(clientId) !== attempt) return;
    const attachment = deps.sessionById(sessionId)?.attachments
      .find((candidate) => candidate.clientId === clientId);
    if (!attachment || attachment.status !== 'uploading') return;
    const total = progress.total && progress.total > 0 ? progress.total : attachment.size;
    attachment.progress = total > 0
      ? Math.min(100, Math.max(0, Math.round((progress.loaded / total) * 100)))
      : progress.phase === 'complete' ? 100 : 0;
  }

  async function runUpload(
    sessionId: string,
    clientId: string,
    totalAttachmentBytes: number,
  ): Promise<void> {
    const runtime = uploadRuntimeFor(sessionId);
    const session = deps.sessionById(sessionId);
    const attachment = session?.attachments.find((candidate) => candidate.clientId === clientId);
    const file = attachmentFiles.get(clientId);
    if (!session || !attachment || attachment.status !== 'uploading' || !file) return;
    runtime.active += 1;
    const attempt = (attachmentAttempts.get(clientId) ?? 0) + 1;
    attachmentAttempts.set(clientId, attempt);
    const controller = new AbortController();
    attachmentControllers.set(clientId, controller);
    try {
      const repo = deps.repo();
      const accountId = deps.accountId();
      if (!repo || accountId == null) {
        throw new Error('Not connected.');
      }
      const result = await repo.uploadComposeAttachment(
        accountId,
        file,
        {
          type: attachment.type,
          totalAttachmentBytes,
          signal: controller.signal,
          onProgress: (progress) => updateProgress(sessionId, clientId, attempt, progress),
        },
      );
      const current = deps.sessionById(sessionId);
      const currentAttachment = current?.attachments
        .find((candidate) => candidate.clientId === clientId);
      if (!currentAttachment
          || attachmentAttempts.get(clientId) !== attempt
          || currentAttachment.status !== 'uploading') return;
      currentAttachment.uploadBlobId = result.blobId;
      currentAttachment.type = result.type || currentAttachment.type;
      currentAttachment.size = result.size;
      currentAttachment.status = 'ready';
      currentAttachment.error = null;
      currentAttachment.progress = 100;
      attachmentBlobFailures.delete(clientId);
      unblockRecoveredSave(current);
      void deps.saveDraft(sessionId);
    } catch (uploadError: any) {
      const currentAttachment = deps.sessionById(sessionId)?.attachments
        .find((candidate) => candidate.clientId === clientId);
      if (!currentAttachment
          || attachmentAttempts.get(clientId) !== attempt
          || currentAttachment.status !== 'uploading') return;
      currentAttachment.status = 'failed';
      currentAttachment.error = uploadErrorMessage(uploadError, currentAttachment);
    } finally {
      if (attachmentControllers.get(clientId) === controller) {
        attachmentControllers.delete(clientId);
      }
      runtime.active = Math.max(0, runtime.active - 1);
      if (uploadRuntimes.get(sessionId) === runtime) {
        pumpUploads(sessionId);
      }
    }
  }

  function pumpUploads(sessionId: string): void {
    const runtime = uploadRuntimes.get(sessionId);
    if (!runtime) return;
    while (runtime.active < runtime.concurrency && runtime.queue.length > 0) {
      const next = runtime.queue.shift()!;
      const attachment = deps.sessionById(sessionId)?.attachments
        .find((candidate) => candidate.clientId === next.clientId);
      if (!attachment || attachment.status !== 'uploading' || !attachmentFiles.has(next.clientId)) {
        continue;
      }
      void runUpload(sessionId, next.clientId, next.totalAttachmentBytes);
    }
  }

  async function addAttachments(
    filesInput: readonly File[] | FileList,
    source: Exclude<ComposeAttachmentSource, 'draft'> = 'picker',
    sessionId: string | null = deps.activeSessionId(),
  ): Promise<boolean> {
    const files = Array.from(filesInput);
    if (files.length === 0) return true;
    const session = deps.sessionById(sessionId);
    const repo = deps.repo();
    const accountId = deps.accountId();
    if (!session || !repo || accountId == null) return false;
    const preflightId = beginPreflight(session, accountId);
    try {
      let limits: AttachmentLimits;
      try {
        limits = await repo.getAttachmentLimits(accountId);
      } catch (limitError: any) {
        if (deps.sessionById(session.id) === session && deps.accountId() === accountId) {
          session.error = limitError?.message
            ? `Could not read attachment limits: ${limitError.message}`
            : 'Could not read attachment limits.';
        }
        return false;
      }
      if (deps.sessionById(session.id) !== session || deps.accountId() !== accountId) return false;
      const limitError = attachmentLimitError(files, limits, attachmentTotalBytes(session));
      if (limitError) {
        session.error = limitError;
        return false;
      }
      const totalAttachmentBytes = attachmentTotalBytes(session)
        + files.reduce((total, file) => total + file.size, 0);
      const added = files.map<ComposeAttachment>((file) => {
        const clientId = makeAttachmentClientId();
        attachmentFiles.set(clientId, file);
        return {
          clientId,
          name: file.name || 'attachment',
          type: file.type || 'application/octet-stream',
          size: file.size,
          source,
          status: 'uploading',
          uploadBlobId: null,
          canonicalBlobId: null,
          partId: null,
          error: null,
          progress: 0,
        };
      });
      session.attachments.push(...added);
      session.error = null;
      deps.touchSession(session.id);
      const runtime = uploadRuntimeFor(session.id);
      runtime.concurrency = limits.maxConcurrentUpload;
      runtime.queue.push(...added.map((attachment) => ({
        clientId: attachment.clientId,
        totalAttachmentBytes,
      })));
      pumpUploads(session.id);
      return true;
    } finally {
      finishPreflight(session, preflightId);
    }
  }

  async function retryAttachment(
    clientId: string,
    sessionId: string | null = deps.activeSessionId(),
  ): Promise<boolean> {
    const session = deps.sessionById(sessionId);
    const attachment = session?.attachments.find((candidate) => candidate.clientId === clientId);
    const file = attachmentFiles.get(clientId);
    const repo = deps.repo();
    const accountId = deps.accountId();
    if (!session || !attachment || attachment.status !== 'failed') return false;
    if (!file) {
      attachment.error = 'The original file is no longer available. Remove it and select it again.';
      return false;
    }
    if (!repo || accountId == null) {
      attachment.error = 'Could not retry while disconnected.';
      return false;
    }
    const preflightId = beginPreflight(session, accountId);
    try {
      const limits = await repo.getAttachmentLimits(accountId);
      if (deps.sessionById(session.id) !== session || deps.accountId() !== accountId) return false;
      const limitError = attachmentLimitError([file], limits, attachmentTotalBytes(session) - file.size);
      if (limitError) {
        attachment.error = limitError;
        return false;
      }
      attachment.status = 'uploading';
      attachment.error = null;
      attachment.progress = 0;
      attachment.uploadBlobId = null;
      const runtime = uploadRuntimeFor(session.id);
      runtime.concurrency = limits.maxConcurrentUpload;
      runtime.queue.push({
        clientId,
        totalAttachmentBytes: attachmentTotalBytes(session),
      });
      pumpUploads(session.id);
      return true;
    } catch (limitError: any) {
      if (deps.sessionById(session.id) === session && deps.accountId() === accountId) {
        attachment.error = limitError?.message
          ? `Could not read attachment limits: ${limitError.message}`
          : 'Could not read attachment limits.';
      }
      return false;
    } finally {
      finishPreflight(session, preflightId);
    }
  }

  function cancelAttachment(
    clientId: string,
    sessionId: string | null = deps.activeSessionId(),
  ): boolean {
    const session = deps.sessionById(sessionId);
    const attachment = session?.attachments.find((candidate) => candidate.clientId === clientId);
    if (!session || !attachment || attachment.status !== 'uploading') return false;
    attachmentAttempts.set(clientId, (attachmentAttempts.get(clientId) ?? 0) + 1);
    attachmentControllers.get(clientId)?.abort();
    attachmentControllers.delete(clientId);
    const runtime = uploadRuntimes.get(session.id);
    if (runtime) {
      runtime.queue = runtime.queue.filter((queued) => queued.clientId !== clientId);
    }
    attachment.status = 'failed';
    attachment.error = 'Upload canceled.';
    pumpUploads(session.id);
    return true;
  }

  function removeAttachment(
    clientId: string,
    sessionId: string | null = deps.activeSessionId(),
  ): boolean {
    const session = deps.sessionById(sessionId);
    if (!session) return false;
    const index = session.attachments.findIndex((attachment) => attachment.clientId === clientId);
    if (index < 0) return false;
    attachmentAttempts.set(clientId, (attachmentAttempts.get(clientId) ?? 0) + 1);
    attachmentControllers.get(clientId)?.abort();
    attachmentControllers.delete(clientId);
    attachmentFiles.delete(clientId);
    attachmentAttempts.delete(clientId);
    attachmentBlobFailures.delete(clientId);
    const runtime = uploadRuntimes.get(session.id);
    if (runtime) {
      runtime.queue = runtime.queue.filter((queued) => queued.clientId !== clientId);
    }
    session.attachments.splice(index, 1);
    unblockRecoveredSave(session);
    deps.touchSession(session.id);
    pumpUploads(session.id);
    return true;
  }

  function markBlobsMissing(session: AttachmentSession, clientIds: string[]): boolean {
    let needsReselection = false;
    for (const clientId of clientIds) {
      const attachment = session.attachments.find((candidate) =>
        candidate.clientId === clientId);
      if (!attachment) continue;
      const canRetry = attachmentFiles.has(clientId);
      attachmentAttempts.set(clientId, (attachmentAttempts.get(clientId) ?? 0) + 1);
      attachmentControllers.get(clientId)?.abort();
      attachmentControllers.delete(clientId);
      attachment.uploadBlobId = null;
      attachment.canonicalBlobId = null;
      attachment.partId = null;
      attachment.status = 'failed';
      attachment.progress = 0;
      attachment.error = canRetry
        ? 'The server no longer has this upload. Retry it.'
        : 'The server no longer has this attachment. Remove it and select the file again.';
      attachmentBlobFailures.add(clientId);
      needsReselection ||= !canRetry;
    }
    return needsReselection;
  }

  function forgetFile(clientId: string): void {
    attachmentFiles.delete(clientId);
  }

  function clearPreflightsOutsideAccount(accountId: number | null): void {
    for (const session of deps.sessions()) {
      for (let index = session.attachmentPreflights.length - 1; index >= 0; index -= 1) {
        if (session.attachmentPreflights[index].accountId !== accountId) {
          session.attachmentPreflights.splice(index, 1);
        }
      }
    }
  }

  function disposeSession(sessionId: string): void {
    const session = deps.sessionById(sessionId);
    session?.attachmentPreflights.splice(0);
    for (const attachment of session?.attachments ?? []) {
      attachmentAttempts.set(
        attachment.clientId,
        (attachmentAttempts.get(attachment.clientId) ?? 0) + 1,
      );
      attachmentControllers.get(attachment.clientId)?.abort();
      attachmentControllers.delete(attachment.clientId);
      attachmentFiles.delete(attachment.clientId);
      attachmentAttempts.delete(attachment.clientId);
      attachmentBlobFailures.delete(attachment.clientId);
    }
    uploadRuntimes.delete(sessionId);
  }

  function reset(): void {
    attachmentBlobFailures.clear();
  }

  return {
    isAttachmentBusy,
    addAttachments,
    retryAttachment,
    cancelAttachment,
    removeAttachment,
    hasBlobFailure,
    markBlobsMissing,
    forgetFile,
    clearPreflightsOutsideAccount,
    disposeSession,
    reset,
  };
}
