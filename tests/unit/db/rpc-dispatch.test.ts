import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  RPC_REQUEST,
  RPC_RESPONSE,
  TABLES_TOUCHED,
  dispatchRpc,
  makeBroadcaster,
  makeRpcProgressReporter,
} from '../../../src/db/rpc-dispatch';

describe('dispatchRpc', () => {
  it('returns the handler result wrapped in a response envelope', async () => {
    const handlers = {
      'echo': (params) => Promise.resolve({ echoed: params }),
    };
    const response = await dispatchRpc(
      { type: RPC_REQUEST, id: 7, method: 'echo', params: { hi: 1 } },
      handlers,
    );
    expect(response).toEqual({
      type: RPC_RESPONSE,
      id: 7,
      result: { echoed: { hi: 1 } },
    });
  });

  it('returns an error envelope when the handler throws', async () => {
    const handlers = {
      boom: () => {
        throw new Error('not today');
      },
    };
    const response = await dispatchRpc(
      { type: RPC_REQUEST, id: 1, method: 'boom' },
      handlers,
    );
    expect(response).toEqual({
      type: RPC_RESPONSE,
      id: 1,
      error: {
        name: 'Error',
        message: 'not today',
      },
    });
  });

  it('preserves typed error fields in the response envelope', async () => {
    const handlers = {
      boom: () => {
        throw Object.assign(new Error('too much'), {
          type: 'tooLarge',
          status: 413,
          maxBytes: 5,
          actualBytes: 6,
        });
      },
    };
    const response = await dispatchRpc(
      { type: RPC_REQUEST, id: 3, method: 'boom' },
      handlers,
    );
    expect(response.error).toMatchObject({
      name: 'Error',
      message: 'too much',
      type: 'tooLarge',
      status: 413,
      maxBytes: 5,
      actualBytes: 6,
    });
  });

  it('returns an error envelope for unknown methods', async () => {
    const response = await dispatchRpc(
      { type: RPC_REQUEST, id: 2, method: 'nope' },
      {},
    );
    expect(response.id).toBe(2);
    expect(response.error.message).toMatch(/Unknown RPC method/);
  });

  it('throws on malformed envelopes', async () => {
    await expect(dispatchRpc(null, {})).rejects.toThrow();
    await expect(dispatchRpc({ type: 'something-else' }, {})).rejects.toThrow();
    await expect(
      dispatchRpc({ type: RPC_REQUEST, id: 'not-a-number', method: 'x' }, {}),
    ).rejects.toThrow();
  });
});

describe('makeRpcProgressReporter', () => {
  it('emits start, whole-percent changes, phase changes, and final completion', () => {
    const posted: any[] = [];
    let now = 0;
    const report = makeRpcProgressReporter(
      (progress) => posted.push(progress),
      { now: () => now },
    );

    report({ direction: 'download', phase: 'transferring', loaded: 0, total: 10_000 });
    report({ direction: 'download', phase: 'transferring', loaded: 1, total: 10_000 });
    report({ direction: 'download', phase: 'transferring', loaded: 49, total: 10_000 });
    report({ direction: 'download', phase: 'transferring', loaded: 50, total: 10_000 });
    report({ direction: 'download', phase: 'transferring', loaded: 51, total: 10_000 });
    now = 1;
    report({ direction: 'download', phase: 'processing', loaded: 10_000, total: 10_000 });
    report({ direction: 'download', phase: 'complete', loaded: 10_000, total: 10_000 });

    expect(posted.map(({ phase, loaded }) => [phase, loaded])).toEqual([
      ['transferring', 0],
      ['transferring', 50],
      ['processing', 10_000],
      ['complete', 10_000],
    ]);
    expect(posted.at(-1)).toEqual({
      direction: 'download',
      phase: 'complete',
      loaded: 10_000,
      total: 10_000,
    });
  });

  it('time-throttles unknown-length intermediate progress', () => {
    const posted: any[] = [];
    let now = 0;
    const report = makeRpcProgressReporter(
      (progress) => posted.push(progress),
      { now: () => now, intervalMs: 250 },
    );

    report({ direction: 'download', phase: 'transferring', loaded: 0, total: null });
    now = 100;
    report({ direction: 'download', phase: 'transferring', loaded: 20, total: null });
    now = 250;
    report({ direction: 'download', phase: 'transferring', loaded: 40, total: null });
    report({ direction: 'download', phase: 'complete', loaded: 50, total: 50 });

    expect(posted.map(({ loaded }) => loaded)).toEqual([0, 40, 50]);
  });
});

describe('makeBroadcaster', () => {
  let posted;
  let channel;

  beforeEach(() => {
    posted = [];
    channel = {
      postMessage: (msg) => posted.push(msg),
    };
  });

  it('coalesces multiple touch() calls into a single broadcast per microtask', async () => {
    const b = makeBroadcaster(channel);
    b.touch('messages');
    b.touch('messages');
    b.touch('folders');
    expect(posted).toHaveLength(0);
    await Promise.resolve();
    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe(TABLES_TOUCHED);
    expect(new Set(posted[0].tables)).toEqual(new Set(['messages', 'folders']));
  });

  it('starts a fresh batch after a flush', async () => {
    const b = makeBroadcaster(channel);
    b.touch('messages');
    await Promise.resolve();
    b.touch('threads');
    await Promise.resolve();
    expect(posted).toHaveLength(2);
    expect(posted[0].tables).toEqual(['messages']);
    expect(posted[1].tables).toEqual(['threads']);
  });

  it('does not broadcast when nothing was touched between flushes', async () => {
    const b = makeBroadcaster(channel);
    await Promise.resolve();
    expect(posted).toHaveLength(0);
  });
});
