import { afterEach, describe, expect, it, vi } from 'vitest';

const { closeStorage, stopSync } = vi.hoisted(() => ({
  closeStorage: vi.fn(), stopSync: vi.fn(),
}));
vi.mock('../../../src/db/bootstrap-idb', () => ({
  bootProductionEngine: async () => ({ close: closeStorage }),
}));
vi.mock('../../../src/db/handlers', () => ({ makeHandlers: () => ({}) }));
vi.mock('../../../src/sync/sync-host', () => ({
  makeSyncRpcHandlers: ({ registerShutdown }) => {
    queueMicrotask(() => registerShutdown(stopSync));
    return {};
  },
}));
vi.mock('../../../src/db/worker-log', () => ({
  attachWorkerLogger: vi.fn(), wlog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { DB_RPC } from '../../../src/db/protocol';
import { RPC_REQUEST, RPC_RESPONSE, WORKER_RESTARTED } from '../../../src/db/rpc-dispatch';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe('shared worker restart wiring', () => {
  it.each(['none', 'cleanup', 'broadcast'])('replies and closes even after %s fails', async (failure) => {
    vi.useFakeTimers();
    vi.resetModules();
    closeStorage.mockImplementation(async () => { if (failure === 'cleanup') throw new Error('Close failed'); });
    stopSync.mockResolvedValue(undefined);
    const events: string[] = [];
    const worker = { addEventListener: vi.fn(), close: vi.fn(() => events.push('close')) };
    vi.stubGlobal('self', worker);
    vi.stubGlobal('BroadcastChannel', class {
      postMessage(message) {
        expect(message.type).toBe(WORKER_RESTARTED);
        events.push('broadcast');
        if (failure === 'broadcast') throw new Error('Broadcast failed');
      }
    });
    await import('../../../src/db/shared-worker');
    const connect = worker.addEventListener.mock.calls.find(([type]) => type === 'connect')![1];
    const port = {
      start: vi.fn(), addEventListener: vi.fn(),
      postMessage: vi.fn((message) => {
        expect(message).toEqual({ type: RPC_RESPONSE, id: 1, result: null });
        events.push('response');
      }),
    };
    connect({ ports: [port] });
    const receive = port.addEventListener.mock.calls[0][1];
    receive({ data: { type: RPC_REQUEST, id: 1, method: DB_RPC.WORKER_RESTART } });
    if (failure === 'broadcast') {
      await expect(vi.runAllTimersAsync()).rejects.toThrow('Broadcast failed');
    } else {
      await vi.runAllTimersAsync();
    }
    expect(stopSync).toHaveBeenCalledOnce();
    expect(closeStorage).toHaveBeenCalledOnce();
    expect(events).toEqual(['response', 'broadcast', 'close']);
  });
});
