// @vitest-environment happy-dom

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import {
  __resetRepositoryForTests,
  __setRepositoryForTests,
} from '../../../src/composables/useRepository';
import { MUTATION_TYPE } from '../../../src/constants/states';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useComposeStore } from '../../../src/stores/compose-store';
import { useMailStore } from '../../../src/stores/mail-store';

const LIMITS = {
  maxSizeUpload: 10,
  maxSizeAttachmentsPerEmail: 20,
  maxConcurrentUpload: 2,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function attachmentStore(overrides: Record<string, unknown> = {}) {
  let mutationId = 0;
  const mutations = new Map<number, any>();
  const repo = {
    subscribe: vi.fn(() => () => {}),
    getAccount: vi.fn(async () => ({ id: 1, primary_email: 'me@example.com' })),
    listIdentities: vi.fn(async () => [{
      id: 1,
      account_id: 1,
      remote_id: 'identity-1',
      name: 'Me',
      email: 'me@example.com',
    }]),
    ensureIdentities: vi.fn(async () => {}),
    getAttachmentLimits: vi.fn(async () => LIMITS),
    uploadComposeAttachment: vi.fn(async (_accountId, file: File) => ({
      accountId: 'remote-1',
      blobId: `upload-${file.name}`,
      type: file.type || 'application/octet-stream',
      size: file.size,
    })),
    insertPendingMutation: vi.fn(async (input: any) => {
      mutationId += 1;
      mutations.set(mutationId, input);
      return { id: mutationId };
    }),
    abandonPendingDraftMutation: vi.fn(async () => ({
      abandoned: 1,
      converted: 0,
      parked: 0,
      inFlight: 0,
      mutationId: null,
    })),
    runMutation: vi.fn(async (_accountId: number, id: number) => {
      const input = mutations.get(id);
      if (input?.mutationType === MUTATION_TYPE.SEND) {
        return { attempted: 1, succeeded: 1, failed: 0, result: { submitted: true } };
      }
      const request = JSON.parse(input.requestJson);
      return {
        attempted: 1,
        succeeded: 1,
        failed: 0,
        result: {
          revision: request.revision,
          emailId: `draft-${id}`,
          localMessageId: id,
          messageId: request.revisionMessageId,
          payloadHash: request.payloadHash,
          attachments: request.attachments.map((attachment: any, index: number) => ({
            ...attachment,
            part_id: `part-${index}`,
            blob_id: `canonical-${attachment.blob_id}`,
          })),
        },
      };
    }),
    ...overrides,
  };
  __setRepositoryForTests(repo);
  const authStore = useAuthStore();
  authStore.accountId = 1;
  const mailStore = useMailStore();
  mailStore.folders = [{
    id: 10,
    account_id: 1,
    remote_id: 'drafts',
    role: 'drafts',
    name: 'Drafts',
  } as any];
  const composeStore = useComposeStore();
  await composeStore.attach();
  await settle();
  return { composeStore, repo };
}

beforeEach(() => {
  setActivePinia(createPinia());
  __resetRepositoryForTests();
});

afterEach(() => {
  useComposeStore().$reset();
  __resetRepositoryForTests();
  vi.useRealTimers();
});

describe('compose attachment limits and scheduling', () => {
  it('treats picker cancellation as a no-op', async () => {
    const { composeStore, repo } = await attachmentStore();
    const sessionId = composeStore.open();

    await expect(composeStore.addAttachments([], 'picker', sessionId)).resolves.toBe(true);

    expect(repo.getAttachmentLimits).not.toHaveBeenCalled();
    expect(repo.uploadComposeAttachment).not.toHaveBeenCalled();
    expect(composeStore.isSessionDirty(sessionId)).toBe(false);
  });

  it('rejects aggregate overflow before starting any upload', async () => {
    const { composeStore, repo } = await attachmentStore();
    const sessionId = composeStore.open();

    await expect(composeStore.addAttachments([
      new File(['123456789'], 'first.bin'),
      new File(['123456789'], 'second.bin'),
      new File(['123'], 'third.bin'),
    ], 'picker', sessionId)).resolves.toBe(false);

    expect(repo.uploadComposeAttachment).not.toHaveBeenCalled();
    expect(composeStore.sessionById(sessionId)?.attachments).toEqual([]);
    expect(composeStore.sessionById(sessionId)?.error).toContain('Nothing was uploaded');
  });

  it('uses semantic attachment identity for dirtiness, not transfer state', async () => {
    const { composeStore } = await attachmentStore();
    const sessionId = composeStore.open({
      attachments: [{
        part_id: 'part-1',
        blob_id: 'canonical-1',
        name: 'report.pdf',
        mime_type: 'application/pdf',
        size: 8,
        disposition: 'attachment',
        cid: null,
        charset: null,
      }],
    });
    const attachment = composeStore.sessionById(sessionId)!.attachments[0];

    expect(composeStore.isSessionDirty(sessionId)).toBe(false);
    expect(composeStore.isSessionMeaningfullyNonEmpty(sessionId)).toBe(true);
    attachment.status = 'uploading';
    attachment.progress = 63;
    attachment.uploadBlobId = 'rotated-upload';
    attachment.canonicalBlobId = 'rotated-canonical';
    expect(composeStore.isSessionDirty(sessionId)).toBe(false);

    attachment.name = 'renamed.pdf';
    expect(composeStore.isSessionDirty(sessionId)).toBe(true);
  });

  it('preserves picker order while honoring the live concurrency limit', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<any>>>();
    let active = 0;
    let maximumActive = 0;
    const uploadComposeAttachment = vi.fn((_accountId, file: File) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const call = deferred<any>();
      pending.set(file.name, call);
      return call.promise.finally(() => {
        active -= 1;
      });
    });
    const { composeStore } = await attachmentStore({ uploadComposeAttachment });
    const sessionId = composeStore.open();

    await composeStore.addAttachments([
      new File(['a'], 'first.txt', { type: 'text/plain' }),
      new File(['b'], 'second.txt', { type: 'text/plain' }),
      new File(['c'], 'third.txt', { type: 'text/plain' }),
    ], 'picker', sessionId);
    expect(uploadComposeAttachment.mock.calls.map((call) => call[1].name))
      .toEqual(['first.txt', 'second.txt']);

    pending.get('first.txt')!.resolve({
      accountId: 'remote-1',
      blobId: 'blob-first',
      type: 'text/plain',
      size: 1,
    });
    await settle();
    expect(uploadComposeAttachment.mock.calls.map((call) => call[1].name))
      .toEqual(['first.txt', 'second.txt', 'third.txt']);
    expect(maximumActive).toBe(2);
    expect(composeStore.sessionById(sessionId)?.attachments.map((attachment) => attachment.name))
      .toEqual(['first.txt', 'second.txt', 'third.txt']);
  });

  it('autosaves text while an attachment is still uploading', async () => {
    vi.useFakeTimers();
    try {
      const upload = deferred<any>();
      const { composeStore, repo } = await attachmentStore({
        uploadComposeAttachment: vi.fn(() => upload.promise),
      });
      const sessionId = composeStore.open();
      await composeStore.addAttachments([new File(['a'], 'pending.txt')], 'picker', sessionId);
      const session = composeStore.sessionById(sessionId)!;
      session.draft.subject = 'Save the text';
      composeStore.touchSession(sessionId);

      await vi.advanceTimersByTimeAsync(2_000);
      await settle();

      expect(repo.insertPendingMutation).toHaveBeenCalledTimes(1);
      const request = JSON.parse(repo.insertPendingMutation.mock.calls[0][0].requestJson);
      expect(request.subject).toBe('Save the text');
      expect(request.attachments).toEqual([]);
      expect(composeStore.isSessionDirty(sessionId)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('compose attachment races and send gating', () => {
  it('blocks send from selection preflight through upload completion', async () => {
    const limits = deferred<typeof LIMITS>();
    const upload = deferred<any>();
    const { composeStore, repo } = await attachmentStore({
      getAttachmentLimits: vi.fn(() => limits.promise),
      uploadComposeAttachment: vi.fn(() => upload.promise),
    });
    const sessionId = composeStore.open({
      to: [{ email: 'recipient@example.com' }],
      subject: 'Deferred attachment',
    });
    const session = composeStore.sessionById(sessionId)!;

    const admission = composeStore.addAttachments([
      new File(['a'], 'report.bin'),
    ], 'picker', sessionId);

    expect(session.attachmentPreflights).toHaveLength(1);
    expect(session.attachments).toEqual([]);
    expect(composeStore.isAttachmentBusy(sessionId)).toBe(true);
    await expect(composeStore.send(sessionId)).resolves.toBe(false);
    expect(session.error).toContain('attachment checks');
    expect(repo.insertPendingMutation.mock.calls
      .some(([input]) => input.mutationType === MUTATION_TYPE.SEND)).toBe(false);

    limits.resolve(LIMITS);
    await expect(admission).resolves.toBe(true);
    expect(session.attachmentPreflights).toEqual([]);
    expect(session.attachments[0]).toMatchObject({ status: 'uploading' });
    expect(composeStore.isAttachmentBusy(sessionId)).toBe(true);
    await expect(composeStore.send(sessionId)).resolves.toBe(false);
    expect(session.error).toContain('finish uploading');

    upload.resolve({
      accountId: 'remote-1',
      blobId: 'upload-report',
      type: 'application/octet-stream',
      size: 1,
    });
    await settle();

    expect(session.attachments[0]).toMatchObject({ status: 'ready' });
    expect(composeStore.isAttachmentBusy(sessionId)).toBe(false);
    await expect(composeStore.send(sessionId)).resolves.toBe(true);
    expect(repo.insertPendingMutation.mock.calls
      .filter(([input]) => input.mutationType === MUTATION_TYPE.SEND)).toHaveLength(1);
  });

  it('clears preflight obligations after lookup failure and stale context', async () => {
    const failedLimits = deferred<typeof LIMITS>();
    const staleLimits = deferred<typeof LIMITS>();
    const closedLimits = deferred<typeof LIMITS>();
    const getAttachmentLimits = vi.fn()
      .mockReturnValueOnce(failedLimits.promise)
      .mockReturnValueOnce(staleLimits.promise)
      .mockReturnValueOnce(closedLimits.promise);
    const { composeStore } = await attachmentStore({ getAttachmentLimits });
    const sessionId = composeStore.open();
    const session = composeStore.sessionById(sessionId)!;

    const failedAdmission = composeStore.addAttachments([
      new File(['a'], 'failed.bin'),
    ], 'picker', sessionId);
    expect(session.attachmentPreflights).toHaveLength(1);
    failedLimits.reject(new Error('offline'));
    await expect(failedAdmission).resolves.toBe(false);
    expect(session.attachmentPreflights).toEqual([]);
    expect(composeStore.isAttachmentBusy(sessionId)).toBe(false);

    const staleAdmission = composeStore.addAttachments([
      new File(['b'], 'stale.bin'),
    ], 'picker', sessionId);
    expect(session.attachmentPreflights).toHaveLength(1);
    useAuthStore().accountId = 2;
    await settle();
    expect(session.attachmentPreflights).toEqual([]);
    staleLimits.resolve(LIMITS);
    await expect(staleAdmission).resolves.toBe(false);
    expect(session.attachments).toEqual([]);

    const closedSessionId = composeStore.open();
    const closedSession = composeStore.sessionById(closedSessionId)!;
    const closedAdmission = composeStore.addAttachments([
      new File(['c'], 'closed.bin'),
    ], 'picker', closedSessionId);
    expect(closedSession.attachmentPreflights).toHaveLength(1);
    expect(composeStore.close(closedSessionId)).toBe(true);
    expect(closedSession.attachmentPreflights).toEqual([]);
    closedLimits.resolve(LIMITS);
    await expect(closedAdmission).resolves.toBe(false);
  });

  it('reuploads an expired temporary blob while its File is still available', async () => {
    let uploadAttempt = 0;
    let saveAttempt = 0;
    const uploadComposeAttachment = vi.fn(async (_accountId, file: File) => {
      uploadAttempt += 1;
      return {
        accountId: 'remote-1',
        blobId: `upload-${uploadAttempt}`,
        type: file.type || 'application/octet-stream',
        size: file.size,
      };
    });
    const runMutation = vi.fn(async () => {
      saveAttempt += 1;
      if (saveAttempt === 1) {
        return {
          attempted: 1,
          succeeded: 0,
          failed: 1,
          errorType: 'blobNotFound',
          result: { attachmentIndexes: [0] },
        };
      }
      return {
        attempted: 1,
        succeeded: 1,
        failed: 0,
        result: {
          revision: 1,
          emailId: 'draft-recovered',
          localMessageId: 1,
          messageId: '<recovered@example.com>',
          payloadHash: 'recovered',
          attachments: [{
            part_id: 'canonical-part',
            blob_id: 'canonical-blob',
            name: 'retry.txt',
            mime_type: 'text/plain',
            size: 1,
            disposition: 'attachment',
            cid: null,
          }],
        },
      };
    });
    const { composeStore } = await attachmentStore({
      uploadComposeAttachment,
      runMutation,
    });
    const sessionId = composeStore.open({ subject: 'Retry expired upload' });
    await composeStore.addAttachments([
      new File(['a'], 'retry.txt', { type: 'text/plain' }),
    ], 'picker', sessionId);
    await settle();
    const attachment = composeStore.sessionById(sessionId)!.attachments[0];

    expect(attachment).toMatchObject({
      status: 'failed',
      uploadBlobId: null,
      canonicalBlobId: null,
    });
    expect(attachment.error).toContain('Retry');
    await expect(composeStore.retryAttachment(attachment.clientId, sessionId))
      .resolves.toBe(true);
    await settle();

    expect(uploadComposeAttachment).toHaveBeenCalledTimes(2);
    expect(composeStore.sessionById(sessionId)?.attachments[0]).toMatchObject({
      status: 'ready',
      canonicalBlobId: 'canonical-blob',
      partId: 'canonical-part',
    });
  });

  it('requires reselection when a reopened draft part returns blobNotFound', async () => {
    const { composeStore } = await attachmentStore({
      runMutation: vi.fn(async () => ({
        attempted: 1,
        succeeded: 0,
        failed: 1,
        errorType: 'blobNotFound',
        result: { attachmentIndexes: [0] },
      })),
    });
    const sessionId = composeStore.open({
      subject: 'Reopened',
      attachments: [{
        part_id: 'part-1',
        blob_id: 'canonical-1',
        name: 'missing.pdf',
        mime_type: 'application/pdf',
        size: 3,
        disposition: 'attachment',
        cid: null,
        charset: null,
      }],
    });
    composeStore.sessionById(sessionId)!.draft.subject = 'Edited reopened draft';

    await expect(composeStore.saveDraft(sessionId, { explicit: true })).resolves.toBe(false);
    const attachment = composeStore.sessionById(sessionId)!.attachments[0];
    expect(attachment).toMatchObject({
      status: 'failed',
      uploadBlobId: null,
      canonicalBlobId: null,
      partId: null,
    });
    expect(attachment.error).toContain('select the file again');
    await expect(composeStore.retryAttachment(attachment.clientId, sessionId))
      .resolves.toBe(false);
    expect(attachment.error).toContain('original file is no longer available');
  });

  it('cancels one upload, retries only that item, and leaves its sibling alone', async () => {
    const attempts = new Map<string, number>();
    const uploadComposeAttachment = vi.fn((
      _accountId,
      file: File,
      options: { signal: AbortSignal },
    ) => new Promise((resolve, reject) => {
      attempts.set(file.name, (attempts.get(file.name) ?? 0) + 1);
      if (file.name === 'keep.txt' || attempts.get(file.name)! > 1) {
        resolve({
          accountId: 'remote-1',
          blobId: `blob-${file.name}`,
          type: 'text/plain',
          size: file.size,
        });
        return;
      }
      options.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      }, { once: true });
    }));
    const { composeStore } = await attachmentStore({ uploadComposeAttachment });
    const sessionId = composeStore.open();
    await composeStore.addAttachments([
      new File(['a'], 'retry.txt', { type: 'text/plain' }),
      new File(['b'], 'keep.txt', { type: 'text/plain' }),
    ], 'picker', sessionId);
    const [retrying, sibling] = composeStore.sessionById(sessionId)!.attachments;

    expect(composeStore.cancelAttachment(retrying.clientId, sessionId)).toBe(true);
    await settle();
    expect(retrying).toMatchObject({ status: 'failed', error: 'Upload canceled.' });
    expect(sibling.status).toBe('ready');

    await expect(composeStore.retryAttachment(retrying.clientId, sessionId)).resolves.toBe(true);
    await settle();
    expect(retrying.status).toBe('ready');
    expect(attempts.get('retry.txt')).toBe(2);
    expect(attempts.get('keep.txt')).toBe(1);
  });

  it('does not resurrect a removed item when its upload or draft save completes', async () => {
    const firstUpload = deferred<any>();
    const secondUpload = deferred<any>();
    const firstSave = deferred<any>();
    let uploadCount = 0;
    const runMutation = vi.fn(() => firstSave.promise);
    const { composeStore } = await attachmentStore({
      uploadComposeAttachment: vi.fn(() => {
        uploadCount += 1;
        return uploadCount === 1 ? firstUpload.promise : secondUpload.promise;
      }),
      runMutation,
    });
    const sessionId = composeStore.open({ subject: 'Race' });
    await composeStore.addAttachments([new File(['a'], 'remove.txt')], 'picker', sessionId);
    const removedId = composeStore.sessionById(sessionId)!.attachments[0].clientId;
    firstUpload.resolve({
      accountId: 'remote-1',
      blobId: 'upload-remove',
      type: 'application/octet-stream',
      size: 1,
    });
    await settle();
    expect(runMutation).toHaveBeenCalledTimes(1);

    await composeStore.addAttachments([new File(['b'], 'survivor.txt')], 'picker', sessionId);
    expect(composeStore.removeAttachment(removedId, sessionId)).toBe(true);
    firstSave.resolve({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      result: {
        revision: 1,
        emailId: 'draft-1',
        localMessageId: 1,
        messageId: '<draft@example.com>',
        payloadHash: 'hash',
        attachments: [{
          part_id: 'part-1',
          blob_id: 'canonical-remove',
          disposition: 'attachment',
          cid: null,
        }],
      },
    });
    secondUpload.resolve({
      accountId: 'remote-1',
      blobId: 'upload-survivor',
      type: 'application/octet-stream',
      size: 1,
    });
    await settle();

    expect(composeStore.sessionById(sessionId)?.attachments.map((attachment) => attachment.name))
      .toEqual(['survivor.txt']);
  });

  it('blocks send with status-specific feedback and serializes only ready attachments', async () => {
    const upload = deferred<any>();
    const { composeStore, repo } = await attachmentStore({
      uploadComposeAttachment: vi.fn(() => upload.promise),
    });
    const sessionId = composeStore.open({
      to: [{ email: 'recipient@example.com' }],
      subject: 'Attachments',
    });
    await composeStore.addAttachments([new File(['a'], 'report.bin')], 'picker', sessionId);

    await expect(composeStore.send(sessionId)).resolves.toBe(false);
    expect(composeStore.sessionById(sessionId)?.error).toContain('finish uploading');

    upload.resolve({
      accountId: 'remote-1',
      blobId: 'upload-report',
      type: 'application/octet-stream',
      size: 1,
    });
    await settle();
    await expect(composeStore.send(sessionId)).resolves.toBe(true);

    const sendInput = repo.insertPendingMutation.mock.calls
      .map(([input]) => input)
      .find((input) => input.mutationType === MUTATION_TYPE.SEND);
    const request = JSON.parse(sendInput.requestJson);
    expect(request.attachments).toEqual([
      expect.objectContaining({ blob_id: expect.stringContaining('canonical-') }),
    ]);
    expect(request.attachmentClientMap).toEqual([
      expect.objectContaining({ clientId: expect.any(String), order: 0 }),
    ]);
  });

  it('distinguishes failed uploads from ready items with missing blob data', async () => {
    const { composeStore } = await attachmentStore();
    const sessionId = composeStore.open({
      to: [{ email: 'recipient@example.com' }],
      subject: 'Broken attachment',
    });
    const session = composeStore.sessionById(sessionId)!;
    session.attachments.push({
      clientId: 'broken',
      name: 'broken.bin',
      type: 'application/octet-stream',
      size: 1,
      source: 'picker',
      status: 'failed',
      uploadBlobId: null,
      canonicalBlobId: null,
      partId: null,
      error: 'Upload failed',
      progress: 0,
    });

    await expect(composeStore.send(sessionId)).resolves.toBe(false);
    expect(session.error).toBe('Retry or remove "broken.bin" before sending.');

    session.attachments[0].status = 'ready';
    await expect(composeStore.send(sessionId)).resolves.toBe(false);
    expect(session.error).toBe(
      '"broken.bin" has no uploaded data. Retry or remove it before sending.',
    );
  });

  it('saves text but keeps the composer open for an uncheckpointed attachment', async () => {
    const upload = deferred<any>();
    const { composeStore } = await attachmentStore({
      uploadComposeAttachment: vi.fn(() => upload.promise),
    });
    const sessionId = composeStore.open({ subject: 'Keep this text' });
    await composeStore.addAttachments([new File(['a'], 'pending.txt')], 'picker', sessionId);

    await expect(composeStore.saveAndClose(sessionId)).resolves.toBe(false);

    expect(composeStore.sessionById(sessionId)?.confirmedRevision).not.toBeNull();
    expect(composeStore.sessionById(sessionId)?.error).toContain('not reached the draft');
  });
});
