import { afterEach, describe, expect, it, vi } from 'vitest';

import { DB_RPC } from '../../../src/db/protocol';
import { Repository } from '../../../src/db/repository';
import { RPC_RESPONSE, WORKER_RESTARTED } from '../../../src/db/rpc-dispatch';

function harness() {
  const port = { addEventListener: vi.fn(), postMessage: vi.fn() };
  const channel = { addEventListener: vi.fn() };
  const restart = vi.fn();
  const repo = new Repository(port as any, channel as any, restart);
  const respond = (result: any = {}, error?: any) => {
    const request = port.postMessage.mock.calls.at(-1)![0];
    repo._onMessage({ data: { type: RPC_RESPONSE, id: request.id, result, error } });
  };
  return { repo, port, respond, restart };
}

afterEach(() => vi.restoreAllMocks());

describe('worker diagnostics', () => {
  it('times message-content round trips, including pending and unsuccessful replies', async () => {
    let clock = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const { repo, respond } = harness();
    expect(repo.getMessageContentTimings()).toMatchObject({ count: 0, lastMs: null, pending: 0 });
    const loading = repo.getMessageBodyForDisplay(1, 2);
    clock = 500;
    expect(repo.getMessageContentTimings()).toMatchObject({ pending: 1, oldestPendingMs: 400 });
    respond({ text: 'cached body' });
    await loading;
    clock = 1000;
    const failed = repo.getMessageBodyForDisplay(1, 3);
    clock = 2000;
    respond(null, { message: 'fetch failed' });
    await expect(failed).rejects.toThrow('fetch failed');
    const query = repo.listAccounts();
    clock = 9000;
    respond([]);
    await query;
    expect(repo.getMessageContentTimings()).toEqual({
      count: 2, lastMs: 1000, averageMs: 700, slowestMs: 1000, pending: 0, oldestPendingMs: null,
    });
  });

  it('bounds the samples to twenty replies', async () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const { repo, respond } = harness();
    for (let i = 1; i <= 25; i += 1) {
      const loading = repo.getMessageBodyForDisplay(1, i);
      clock += i;
      respond();
      await loading;
    }
    expect(repo.getMessageContentTimings()).toMatchObject({
      count: 20, lastMs: 25, averageMs: 15.5, slowestMs: 25,
    });
  });

  it('uses worker control RPCs and reloads only on the worker restart notification', async () => {
    const { repo, port, respond, restart } = harness();
    const status = repo.getWorkerStatus();
    expect(port.postMessage.mock.calls.at(-1)![0].method).toBe(DB_RPC.WORKER_STATUS);
    respond({ instanceId: 'worker-1' });
    await expect(status).resolves.toMatchObject({ instanceId: 'worker-1' });
    const reset = repo.restartWorker();
    expect(port.postMessage.mock.calls.at(-1)![0].method).toBe(DB_RPC.WORKER_RESTART);
    respond();
    await reset;
    expect(restart).not.toHaveBeenCalled();
    repo._onBroadcast({ data: { type: WORKER_RESTARTED } });
    expect(restart).toHaveBeenCalledOnce();
  });
});
