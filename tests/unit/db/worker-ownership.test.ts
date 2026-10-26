import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectRepository, createRepository } from '../../../src/db/repository';
import { DATABASE_UNAVAILABLE_MESSAGE } from '../../../src/db/availability';
import { claimDatabaseOwnership, DATABASE_OWNER_LOCK, needsFirefoxLockWorkaround } from '../../../src/db/worker-ownership';
import { RPC_RESPONSE, WORKER_RESTARTED } from '../../../src/db/rpc-dispatch';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Firefox ownership policy', () => {
  it.each([
    ['Mozilla/5.0 Gecko/20100101 Firefox/158.0', true],
    ['Mozilla/5.0 Gecko/20100101 Firefox/161.0 Waterfox/6', true],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Safari/537.36', false],
    ['Mozilla/5.0 AppleWebKit/605.1.15 FxiOS/158.0 Mobile/15 Safari/604.1', false],
    ['Mozilla/5.0 Chrome/148.0 Electron/40.0 Safari/537.36', false],
  ])('selects Gecko workers only: %s', (ua, expected) => {
    expect(needsFirefoxLockWorkaround(ua)).toBe(expected);
  });

  it('requests ownership once while waiting, and retires a superseded waiter', async () => {
    vi.useFakeTimers();
    let receive: (event: any) => void;
    const channel = {
      addEventListener: vi.fn((_, handler) => { receive = handler; }),
      removeEventListener: vi.fn(), postMessage: vi.fn(),
    };
    const locks = { request: vi.fn((_, { signal }) => new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    })) };
    const superseded = vi.fn();
    const owner = claimDatabaseOwnership({ channel: channel as any, locks: locks as any,
      url: 'old.js', startedAt: 1, id: 'old', superseded });
    const rejected = expect(owner.ready).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(2500);
    expect(locks.request).toHaveBeenCalledTimes(1);
    expect(locks.request.mock.calls[0][0]).toBe(DATABASE_OWNER_LOCK);
    receive({ data: { type: 'worker.database-owner', url: 'older.js', startedAt: 0, id: 'older' } });
    expect(superseded).not.toHaveBeenCalled();
    receive({ data: { type: 'worker.database-owner', url: 'new.js', startedAt: 2, id: 'new' } });
    await rejected;
    expect(superseded).toHaveBeenCalledExactlyOnceWith('new.js');
    owner.stop();
  });
});

function connection(ua = 'Gecko/20100101 Firefox/158.0') {
  vi.stubGlobal('navigator', { userAgent: ua });
  vi.stubGlobal('SharedWorker', class {});
  vi.stubGlobal('MessageChannel', class {});
  vi.stubGlobal('indexedDB', {});
  const channel = { addEventListener: vi.fn(), close: vi.fn() };
  vi.stubGlobal('BroadcastChannel', vi.fn(function () { return channel; }));
  const port = { addEventListener: vi.fn(), postMessage: vi.fn(), start: vi.fn(), close: vi.fn() };
  const options = { worker: { port } as any, workerUrl: 'https://stormbox.test/current.js', onWorkerRestart: vi.fn() };
  return { port, options, channel };
}

describe('database startup recovery', () => {
  it('times out independently of an unresponsive worker and closes pending RPCs', async () => {
    vi.useFakeTimers();
    const { port, options } = connection();
    const ready = connectRepository(options, 1000);
    const rejected = expect(ready).rejects.toThrow(DATABASE_UNAVAILABLE_MESSAGE);
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(port.close).toHaveBeenCalledOnce();
  });

  it('clears the deadline after a successful Firefox boot', async () => {
    vi.useFakeTimers();
    const { port, options } = connection();
    const ready = connectRepository(options, 1000);
    const request = port.postMessage.mock.calls[0][0];
    port.addEventListener.mock.calls[0][1]({ data: { type: RPC_RESPONSE, id: request.id, result: { instanceId: 'one' } } });
    await expect(ready).resolves.toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports recovery instructions and retains the cause when database boot fails', async () => {
    const { port, options } = connection();
    const ready = connectRepository(options);
    const request = port.postMessage.mock.calls[0][0];
    port.addEventListener.mock.calls[0][1]({ data: { type: RPC_RESPONSE, id: request.id, error: { message: 'Database boot failed' } } });
    await expect(ready).rejects.toMatchObject({ message: DATABASE_UNAVAILABLE_MESSAGE, cause: { message: 'Database boot failed' } });
    expect(port.close).toHaveBeenCalledOnce();
  });

  it.each(['timeout', 'worker error'])('receives retirement after a startup %s', async (failure) => {
    vi.useFakeTimers();
    const { port, options, channel } = connection();
    const ready = connectRepository(options, 1000);
    const rejected = expect(ready).rejects.toThrow(DATABASE_UNAVAILABLE_MESSAGE);
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(1000);
    else {
      const request = port.postMessage.mock.calls[0][0];
      port.addEventListener.mock.calls[0][1]({ data: { type: RPC_RESPONSE, id: request.id, error: { message: 'Superseded' } } });
    }
    await rejected;
    expect(port.close).toHaveBeenCalledOnce();
    expect(channel.close).not.toHaveBeenCalled();
    const receive = channel.addEventListener.mock.calls[0][1];
    receive({ data: { type: WORKER_RESTARTED, workerUrl: 'https://stormbox.test/unrelated.js' } });
    expect(options.onWorkerRestart).not.toHaveBeenCalled();
    receive({ data: { type: WORKER_RESTARTED, workerUrl: options.workerUrl, replacementWorkerUrl: 'https://stormbox.test/new.js' } });
    expect(options.onWorkerRestart).toHaveBeenCalledOnce();
    expect(channel.close).toHaveBeenCalledOnce();
  });

  it('closes the notification channel on explicit repository shutdown', () => {
    const { options, channel, port } = connection();
    createRepository(options).close();
    expect(port.close).toHaveBeenCalledOnce();
    expect(channel.close).toHaveBeenCalledOnce();
  });

  it('keeps non-Firefox startup unchanged', async () => {
    const { port, options } = connection('Chrome/148.0');
    await connectRepository(options);
    expect(port.postMessage).not.toHaveBeenCalled();
  });

  it('reloads retiring clients but leaves the replacement connected', () => {
    const { options } = connection();
    const repo = createRepository(options);
    repo._onBroadcast({ data: { type: WORKER_RESTARTED, replacementWorkerUrl: options.workerUrl } });
    repo._onBroadcast({ data: { type: WORKER_RESTARTED, replacementWorkerUrl: 'https://stormbox.test/intermediate.js' } });
    repo._onBroadcast({ data: { type: WORKER_RESTARTED, workerUrl: 'https://stormbox.test/old.js' } });
    expect(options.onWorkerRestart).not.toHaveBeenCalled();
    repo._onBroadcast({ data: { type: WORKER_RESTARTED, workerUrl: options.workerUrl, replacementWorkerUrl: 'https://stormbox.test/new.js' } });
    expect(options.onWorkerRestart).toHaveBeenCalledOnce();
    repo.close();
  });
});
