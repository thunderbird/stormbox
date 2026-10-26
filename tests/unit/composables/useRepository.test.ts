import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createWorker, port } = vi.hoisted(() => {
  const port = { addEventListener: vi.fn(), start: vi.fn(), postMessage: vi.fn() };
  return { port, createWorker: vi.fn(function () { return { port }; }) };
});

vi.mock('../../../src/db/shared-worker.ts?sharedworker&url', () => ({ default: 'https://stormbox.test/worker.js' }));

import { UnsupportedBrowserError } from '../../../src/db/availability';
import { SHARED_WORKER_NAME } from '../../../src/db/protocol';
import { getRepositoryAsync, __resetRepositoryForTests } from '../../../src/composables/useRepository';

beforeEach(() => {
  __resetRepositoryForTests();
  vi.clearAllMocks();
  vi.stubGlobal('SharedWorker', createWorker);
  vi.stubGlobal('BroadcastChannel', class { addEventListener = vi.fn(); });
  vi.stubGlobal('MessageChannel', class {});
  vi.stubGlobal('indexedDB', {});
});

afterEach(() => {
  __resetRepositoryForTests();
  vi.unstubAllGlobals();
});

describe('repository startup', () => {
  it.each(['SharedWorker', 'BroadcastChannel', 'MessageChannel', 'indexedDB'])(
    'reports missing %s before constructing the worker', async (capability) => {
      vi.stubGlobal(capability, undefined);
      const result = getRepositoryAsync();

      await expect(result).rejects.toBeInstanceOf(UnsupportedBrowserError);
      await expect(result).rejects.toThrow(/Stormbox cannot run in this browser\. Missing:/);
      await expect(result).rejects.toThrow(capability === 'indexedDB' ? 'IndexedDB' : capability);
      expect(createWorker).not.toHaveBeenCalled();
    },
  );

  it('constructs and starts one worker for concurrent supported callers', async () => {
    const [first, second] = await Promise.all([getRepositoryAsync(), getRepositoryAsync()]);

    expect(first).toBe(second);
    expect(createWorker).toHaveBeenCalledExactlyOnceWith('https://stormbox.test/worker.js', { type: 'module', name: SHARED_WORKER_NAME });
    expect(port.start).toHaveBeenCalledOnce();
  });
});
