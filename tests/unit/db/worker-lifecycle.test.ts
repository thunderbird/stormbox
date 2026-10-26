import { afterEach, describe, expect, it, vi } from 'vitest';

import { DB_RPC } from '../../../src/db/protocol';
import { createWorkerLifecycle } from '../../../src/db/worker-lifecycle';
import { wlog } from '../../../src/db/worker-log';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('shared worker lifecycle', () => {
  it('bounds a handoff requested before database initialization finishes', async () => {
    vi.useFakeTimers();
    vi.spyOn(wlog, 'warn').mockImplementation(() => {});
    const boot = deferred();
    const beforeRestart = vi.fn();
    const restart = vi.fn();
    const lifecycle = createWorkerLifecycle({ restart, beforeRestart, ready: () => boot.promise });
    const shutdown = lifecycle.requestRestart();
    expect(beforeRestart).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    await shutdown;
    await vi.runOnlyPendingTimersAsync();
    expect(restart).toHaveBeenCalledOnce();
    boot.resolve();
    await vi.runAllTimersAsync();
    expect(restart).toHaveBeenCalledOnce();
  });

  it('reports the worker lifetime without waiting behind a database request', async () => {
    const waiting = deferred();
    const lifecycle = createWorkerLifecycle({
      restart: vi.fn(), instanceId: 'worker-1', now: () => 2400,
    });
    const handlers = lifecycle.requestHandlers({ query: () => waiting.promise }, {
      stopSync: vi.fn(), closeStorage: vi.fn(),
    });
    const request = handlers.query();
    expect(handlers[DB_RPC.WORKER_STATUS]()).toEqual({
      instanceId: 'worker-1', uptimeMs: 2400,
    });
    waiting.resolve();
    await request;
  });

  it('waits for account startup, settles sync and storage, then closes once', async () => {
    vi.useFakeTimers();
    const startup = deferred();
    const mutation = deferred();
    const backgroundWrite = deferred();
    const events: string[] = [];
    const restart = vi.fn(() => { events.push('restart'); });
    const lifecycle = createWorkerLifecycle({ restart });
    const storage = lifecycle.storageHandlers({ write: () => backgroundWrite.promise });
    const stopSync = vi.fn(async () => { events.push('stop sync'); mutation.resolve(); });
    const closeStorage = vi.fn(async () => { events.push('close storage'); });
    const handlers = lifecycle.requestHandlers({
      [DB_RPC.SYNC_START_ACCOUNT]: () => startup.promise,
      mutation: () => mutation.promise,
    }, { stopSync, closeStorage });

    const startRequest = handlers[DB_RPC.SYNC_START_ACCOUNT]();
    const mutationRequest = handlers.mutation();
    const write = storage.write();
    const reset = handlers[DB_RPC.WORKER_RESTART]();
    expect(handlers[DB_RPC.WORKER_RESTART]()).toBe(reset);
    await expect(handlers.mutation()).rejects.toThrow('restarting');
    expect(stopSync).not.toHaveBeenCalled();
    startup.resolve();
    await startRequest;
    await mutationRequest;
    expect(events).toEqual(['stop sync']);
    expect(closeStorage).not.toHaveBeenCalled();
    backgroundWrite.resolve();
    await write;
    await reset;
    await expect(storage.write()).rejects.toThrow('restarting');
    expect(events).toEqual(['stop sync', 'close storage']);
    await vi.runAllTimersAsync();
    expect(events).toEqual(['stop sync', 'close storage', 'restart']);
    expect(restart).toHaveBeenCalledOnce();
  });

  it.each(['stopSync', 'closeStorage'])('closes once even when %s rejects', async (failingStep) => {
    vi.useFakeTimers();
    const warn = vi.spyOn(wlog, 'warn').mockImplementation(() => {});
    const shutdown = { stopSync: vi.fn().mockResolvedValue(undefined), closeStorage: vi.fn().mockResolvedValue(undefined) };
    shutdown[failingStep].mockRejectedValue(new Error('cleanup failed'));
    const restart = vi.fn();
    const lifecycle = createWorkerLifecycle({ restart });
    const handlers = lifecycle.requestHandlers({}, shutdown);
    const reset = handlers[DB_RPC.WORKER_RESTART]();
    await expect(reset).resolves.toBeUndefined();
    expect(handlers[DB_RPC.WORKER_RESTART]()).toBe(reset);
    expect(shutdown.closeStorage).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(restart).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(restart).toHaveBeenCalledOnce();
  });

  it('allows accepted requests to finish after sync shutdown fails', async () => {
    vi.useFakeTimers();
    vi.spyOn(wlog, 'warn').mockImplementation(() => {});
    const waiting = deferred();
    const closeStorage = vi.fn();
    const handlers = createWorkerLifecycle({ restart: vi.fn() }).requestHandlers({
      query: () => waiting.promise,
    }, {
      stopSync: async () => { throw new Error('Sync stop failed'); }, closeStorage,
    });
    const request = handlers.query();
    const reset = handlers[DB_RPC.WORKER_RESTART]();
    await vi.advanceTimersByTimeAsync(0);
    expect(closeStorage).not.toHaveBeenCalled();
    waiting.resolve();
    await request;
    await reset;
    expect(closeStorage).toHaveBeenCalledOnce();
  });

  it.each(['startup', 'request', 'stopSync', 'storage', 'closeStorage'])('bounds a stalled %s by the cleanup deadline', async (stage) => {
    vi.useFakeTimers();
    vi.spyOn(wlog, 'warn').mockImplementation(() => {});
    const waiting = deferred();
    const restart = vi.fn();
    const lifecycle = createWorkerLifecycle({ restart });
    const storage = lifecycle.storageHandlers({ write: () => waiting.promise });
    const handlers = lifecycle.requestHandlers({
      [DB_RPC.SYNC_START_ACCOUNT]: () => waiting.promise,
      query: () => waiting.promise,
    }, {
      stopSync: async () => { if (stage === 'stopSync') await waiting.promise; },
      closeStorage: async () => { if (stage === 'closeStorage') await waiting.promise; },
    });
    if (stage === 'startup') void handlers[DB_RPC.SYNC_START_ACCOUNT]();
    if (stage === 'request') void handlers.query();
    if (stage === 'storage') void storage.write();
    const reset = handlers[DB_RPC.WORKER_RESTART]();
    await vi.advanceTimersByTimeAsync(4999);
    expect(restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await reset;
    await vi.runOnlyPendingTimersAsync();
    expect(restart).toHaveBeenCalledOnce();
    const onRejected = vi.fn();
    await storage.write().catch(onRejected);
    expect(onRejected).toHaveBeenCalledOnce();
    waiting.resolve();
    await vi.runAllTimersAsync();
    expect(restart).toHaveBeenCalledOnce();
  });
});
