import { describe, expect, it, vi } from 'vitest';

import { DB_RPC } from '../../../src/db/protocol';
import { Repository } from '../../../src/db/repository';
import { dispatchRpc } from '../../../src/db/rpc-dispatch';

describe('OIDC auth update RPC', () => {
  it('carries a bearer snapshot through the repository MessagePort', async () => {
    const channel = new MessageChannel();
    const handler = vi.fn(async (params) => ({ updated: true, params }));
    const handlers = { [DB_RPC.SYNC_UPDATE_ACCOUNT_AUTH]: handler };
    const broadcastChannel = {
      addEventListener: vi.fn(),
    };
    channel.port2.addEventListener('message', async (event) => {
      channel.port2.postMessage(await dispatchRpc(event.data, handlers));
    });
    channel.port1.start();
    channel.port2.start();
    const repo = new Repository(
      channel.port1,
      broadcastChannel as unknown as BroadcastChannel,
    );

    await expect(repo.updateSyncAccountAuth(42, {
      token: 'rotated-token',
      issuedAt: 2_000,
      expiresAt: 62_000,
    })).resolves.toMatchObject({ updated: true });
    expect(handler).toHaveBeenCalledWith({
      accountId: 42,
      token: 'rotated-token',
      issuedAt: 2_000,
      expiresAt: 62_000,
    }, {});

    channel.port1.close();
    channel.port2.close();
  });
});
