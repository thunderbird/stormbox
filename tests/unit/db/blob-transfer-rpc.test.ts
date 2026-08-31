import { describe, expect, it, vi } from 'vitest';

import { DB_RPC } from '../../../src/db/protocol';
import {
  type BlobTransferProgress,
  Repository,
} from '../../../src/db/repository';
import { serveRpcPort } from '../../../src/db/rpc-dispatch';

function connectRepository(handlers: Record<string, any>) {
  const channel = new MessageChannel();
  const dispose = serveRpcPort(channel.port2, async () => handlers);
  const broadcastChannel = {
    addEventListener: vi.fn(),
  };
  channel.port1.start();
  channel.port2.start();
  const repository = new Repository(
    channel.port1,
    broadcastChannel as unknown as BroadcastChannel,
  );
  return {
    repository,
    close() {
      dispose();
      channel.port1.close();
      channel.port2.close();
    },
  };
}

describe('blob transfer MessagePort RPC', () => {
  it('structured-clones Blob bytes and correlates progress without detaching the source', async () => {
    const seenProgress: BlobTransferProgress[] = [];
    const connected = connectRepository({
      [DB_RPC.SYNC_UPLOAD_COMPOSE_ATTACHMENT]: async (
        { blob, type, totalAttachmentBytes },
        { reportProgress },
      ) => {
        expect(blob).toBeInstanceOf(Blob);
        expect(await blob.text()).toBe('attachment bytes');
        expect(type).toBe('text/plain');
        expect(totalAttachmentBytes).toBe(blob.size);
        reportProgress({
          direction: 'upload',
          phase: 'transferring',
          loaded: blob.size,
          total: blob.size,
        });
        return {
          accountId: 'remote-7',
          blobId: 'blob-7',
          type,
          size: blob.size,
        };
      },
    });
    const source = new File(
      ['attachment bytes'],
      'report.txt',
      { type: 'text/plain' },
    );

    await expect(connected.repository.uploadComposeAttachment(7, source, {
      onProgress: (progress) => seenProgress.push(progress),
    })).resolves.toEqual({
      accountId: 'remote-7',
      blobId: 'blob-7',
      type: 'text/plain',
      size: source.size,
    });
    expect(await source.text()).toBe('attachment bytes');
    expect(source.name).toBe('report.txt');
    expect(seenProgress).toEqual([{
      direction: 'upload',
      phase: 'transferring',
      loaded: source.size,
      total: source.size,
    }]);
    connected.close();
  });

  it('returns Blob downloads and preserves typed errors', async () => {
    const calls: any[] = [];
    const connected = connectRepository({
      [DB_RPC.SYNC_DOWNLOAD_ATTACHMENT]: async (args) => {
        calls.push(args);
        if (args.blobId === 'large' && !args.truncateAtMaxBytes) {
          throw Object.assign(new Error('download exceeds limit'), {
            type: 'tooLarge',
            status: 413,
            maxBytes: 4,
            actualBytes: 5,
          });
        }
        if (args.blobId === 'large') {
          return new Blob(['down'], { type: 'text/plain' });
        }
        return new Blob(['downloaded'], { type: 'text/plain' });
      },
    });

    const downloaded = await connected.repository.downloadAttachment(3, {
      blobId: 'ok',
      type: 'text/plain',
    });
    expect(downloaded).toBeInstanceOf(Blob);
    expect(await downloaded.text()).toBe('downloaded');
    await expect(connected.repository.downloadAttachment(3, {
      blobId: 'large',
      maxBytes: 4,
    })).rejects.toMatchObject({
      type: 'tooLarge',
      status: 413,
      maxBytes: 4,
      actualBytes: 5,
    });
    const prefix = await connected.repository.downloadAttachment(3, {
      blobId: 'large',
      maxBytes: 4,
      truncateAtMaxBytes: true,
    });
    expect(await prefix.text()).toBe('down');
    expect(calls).toEqual([
      expect.objectContaining({
        accountId: 3,
        blobId: 'ok',
        truncateAtMaxBytes: false,
      }),
      expect.objectContaining({
        accountId: 3,
        blobId: 'large',
        maxBytes: 4,
        truncateAtMaxBytes: false,
      }),
      expect.objectContaining({
        accountId: 3,
        blobId: 'large',
        maxBytes: 4,
        truncateAtMaxBytes: true,
      }),
    ]);
    connected.close();
  });

  it('throttles transfer progress before MessagePort delivery and preserves final 100%', async () => {
    const seenProgress: BlobTransferProgress[] = [];
    const connected = connectRepository({
      [DB_RPC.SYNC_DOWNLOAD_ATTACHMENT]: async (_args, { reportProgress }) => {
        reportProgress({
          direction: 'download',
          phase: 'transferring',
          loaded: 0,
          total: 10_000,
        });
        for (let loaded = 1; loaded <= 51; loaded += 1) {
          reportProgress({
            direction: 'download',
            phase: 'transferring',
            loaded,
            total: 10_000,
          });
        }
        reportProgress({
          direction: 'download',
          phase: 'complete',
          loaded: 10_000,
          total: 10_000,
        });
        return new Blob(['done']);
      },
    });

    await connected.repository.downloadAttachment(3, {
      blobId: 'progress',
      onProgress: (progress) => seenProgress.push(progress),
    });

    expect(seenProgress.map(({ phase, loaded }) => [phase, loaded])).toEqual([
      ['transferring', 0],
      ['transferring', 50],
      ['complete', 10_000],
    ]);
    connected.close();
  });

  it('cancels one transfer without affecting another request', async () => {
    let releaseSecond: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let cancelReady: () => void;
    const cancelEntered = new Promise<void>((resolve) => {
      cancelReady = resolve;
    });
    const connected = connectRepository({
      [DB_RPC.SYNC_UPLOAD_COMPOSE_ATTACHMENT]: async (
        { blob, type },
        { signal },
      ) => {
        const value = await blob.text();
        if (value === 'cancel me') {
          return new Promise((_resolve, reject) => {
            const rejectCancelled = () => reject(Object.assign(
              new Error('transfer cancelled'),
              { name: 'AbortError', type: 'cancelled' },
            ));
            signal.addEventListener('abort', rejectCancelled, { once: true });
            cancelReady();
          });
        }
        await secondGate;
        return {
          accountId: 'remote-1',
          blobId: 'other-blob',
          type,
          size: blob.size,
        };
      },
    });
    const controller = new AbortController();
    const cancelled = connected.repository.uploadComposeAttachment(
      1,
      new Blob(['cancel me']),
      { signal: controller.signal },
    );
    const unaffected = connected.repository.uploadComposeAttachment(
      1,
      new Blob(['keep going']),
    );

    await cancelEntered;
    controller.abort();
    releaseSecond();

    await expect(cancelled).rejects.toMatchObject({
      name: 'AbortError',
      type: 'cancelled',
    });
    await expect(unaffected).resolves.toMatchObject({ blobId: 'other-blob' });
    connected.close();
  });
});
