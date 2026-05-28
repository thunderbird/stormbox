import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { syncIdentities } from '../../../src/sync/backends/jmap/identities';
import { MockTransport } from './_mock-transport';

let engine;
let handlers;
let account;

beforeEach(async () => {
  engine = await bootTestEngine();
  handlers = makeHandlers(engine);
  account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
    displayName: 'T',
    primaryEmail: 't@example.com',
    serverOrigin: 'https://mail.example.com',
    remoteAccountId: 'acct-1',
    isPrimary: true,
  })).row;
});

afterEach(async () => {
  await engine.close();
});

describe('syncIdentities', () => {
  it('upserts identities and stores the state token', async () => {
    const transport = new MockTransport();
    transport.handle('Identity/get', () => ({
      list: [
        {
          id: 'id-primary',
          name: 'Tester',
          email: 'tester@example.com',
          replyTo: [{ name: 'T', email: 't@example.com' }],
          mayDelete: false,
        },
        {
          id: 'id-alias',
          name: 'Alias',
          email: 'alias@example.com',
          mayDelete: true,
        },
      ],
      state: 'is-1',
    }));

    const result = await syncIdentities({ transport, account, handlers });
    expect(result.count).toBe(2);
    expect(result.state).toBe('is-1');

    const list = await handlers[DB_RPC.IDENTITY_LIST]({ accountId: account.id });
    expect(list.map((i) => i.email).sort()).toEqual(['alias@example.com', 'tester@example.com']);

    const stateRow = await handlers[DB_RPC.SYNC_STATE_GET]({
      accountId: account.id,
      objectType: 'Identity',
    });
    expect(stateRow.state).toBe('is-1');
  });
});
