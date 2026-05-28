import { describe, it, expect, beforeEach } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { JMAP_CAPS } from '../../../src/sync/backends/jmap/transport';
import { syncQuota } from '../../../src/sync/backends/jmap/quota';

const SESSION = {
  capabilities: {
    [JMAP_CAPS.CORE]: {},
    [JMAP_CAPS.QUOTA]: {},
  },
};

function makeTransport(quotaList) {
  return {
    session: SESSION,
    request: async (_using, methodCalls) => ({
      methodResponses: methodCalls.map(([method]) => [
        method,
        {
          accountId: 'remote-1',
          state: 'q-state',
          list: quotaList,
          notFound: [],
        },
        'q1',
      ]),
    }),
    wsRequest: async () => {
      throw new Error('not used');
    },
  };
}

let engine;
let handlers;

beforeEach(async () => {
  engine = await bootTestEngine();
  handlers = makeHandlers(engine);
  await handlers[DB_RPC.ACCOUNT_UPSERT]({
    displayName: 'Tester',
    primaryEmail: 'tester@example.com',
    serverOrigin: 'https://mail.example.com',
    remoteAccountId: 'remote-1',
    isPrimary: true,
  });
});

describe('syncQuota', () => {
  it('persists octets quota from Quota/get', async () => {
    const account = await handlers[DB_RPC.ACCOUNT_GET_BY_REMOTE]({
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'remote-1',
    });

    await syncQuota({
      transport: makeTransport([{
        id: '0',
        resourceType: 'octets',
        used: 3 * 1024 ** 3,
        hardLimit: 50 * 1024 ** 3,
        scope: 'account',
        name: 'tester@example.com',
        types: ['Email'],
      }]),
      account,
      handlers,
    });

    const row = await handlers[DB_RPC.ACCOUNT_GET]({ accountId: account.id });
    expect(row.quota_used_bytes).toBe(3 * 1024 ** 3);
    expect(row.quota_hard_limit_bytes).toBe(50 * 1024 ** 3);
    expect(row.quota_updated_at).toBeTypeOf('number');
  });

  it('skips when quota capability is absent', async () => {
    const account = await handlers[DB_RPC.ACCOUNT_GET_BY_REMOTE]({
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'remote-1',
    });

    const result = await syncQuota({
      transport: { session: { capabilities: { [JMAP_CAPS.CORE]: {} } } },
      account,
      handlers,
    });

    expect(result.skipped).toBe(true);
    const row = await handlers[DB_RPC.ACCOUNT_GET]({ accountId: account.id });
    expect(row.quota_used_bytes).toBeNull();
  });

  it('clears quota when server returns no disk limit', async () => {
    const account = await handlers[DB_RPC.ACCOUNT_GET_BY_REMOTE]({
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'remote-1',
    });

    await handlers[DB_RPC.ACCOUNT_QUOTA_UPSERT]({
      accountId: account.id,
      usedBytes: 1000,
      hardLimitBytes: 2000,
    });

    await syncQuota({
      transport: makeTransport([]),
      account,
      handlers,
    });

    const row = await handlers[DB_RPC.ACCOUNT_GET]({ accountId: account.id });
    expect(row.quota_used_bytes).toBeNull();
    expect(row.quota_hard_limit_bytes).toBeNull();
  });
});
