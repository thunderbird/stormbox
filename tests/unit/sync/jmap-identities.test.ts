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
  it('upserts identities, and keeps no checkpoint it would never read', async () => {
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

    const list = await handlers[DB_RPC.IDENTITY_LIST]({ accountId: account.id });
    expect(list.map((i) => i.email).sort()).toEqual(['alias@example.com', 'tester@example.com']);

    // The server sends a state token and this deliberately drops it. There is
    // no `Identity/changes` call to hand it to — the whole list is re-read
    // when the server says it moved — so storing one would be a write with no
    // reader, and the next person to find it would reasonably assume a delta
    // sync existed somewhere.
    const stateRow = await handlers[DB_RPC.SYNC_STATE_GET]({
      accountId: account.id,
      objectType: 'Identity',
    });
    expect(stateRow ?? null).toBeNull();
  });

  it('stores the reply-to default as a typed field', async () => {
    const transport = new MockTransport();
    transport.handle('Identity/get', () => ({
      list: [{
        id: 'id-1',
        name: 'Tester',
        email: 'tester@example.com',
        replyTo: [{ email: 'replies@example.com' }],
      }],
      state: 'is-1',
    }));

    await syncIdentities({ transport, account, handlers });

    const [row] = await handlers[DB_RPC.IDENTITY_LIST]({ accountId: account.id });
    expect(JSON.parse(row.reply_to_json)).toEqual([{ email: 'replies@example.com' }]);
  });

  it('drops an identity the server has stopped offering', async () => {
    // An alias removed server-side stayed in the From picker forever,
    // because an upsert has no way to express an absence.
    const transport = new MockTransport();
    let identities = [
      { id: 'id-primary', email: 'tester@example.com' },
      { id: 'id-alias', email: 'alias@example.com' },
    ];
    transport.handle('Identity/get', () => ({ list: identities, state: 'is-1' }));
    await syncIdentities({ transport, account, handlers });

    identities = [{ id: 'id-primary', email: 'tester@example.com' }];
    const result = await syncIdentities({ transport, account, handlers });

    expect(result.removed).toBe(1);
    const list = await handlers[DB_RPC.IDENTITY_LIST]({ accountId: account.id });
    expect(list.map((i: any) => i.email)).toEqual(['tester@example.com']);
  });

  it('accepts an empty list as the answer it is', async () => {
    const transport = new MockTransport();
    let identities: any[] = [{ id: 'id-primary', email: 'tester@example.com' }];
    transport.handle('Identity/get', () => ({ list: identities, state: 'is-1' }));
    await syncIdentities({ transport, account, handlers });

    identities = [];
    await syncIdentities({ transport, account, handlers });

    const list = await handlers[DB_RPC.IDENTITY_LIST]({ accountId: account.id });
    expect(list).toEqual([]);
  });

  it('keeps the identities it has when the response cannot be read', async () => {
    const transport = new MockTransport();
    transport.handle('Identity/get', () => ({
      list: [{ id: 'id-primary', email: 'tester@example.com' }],
      state: 'is-1',
    }));
    await syncIdentities({ transport, account, handlers });

    transport.handle('Identity/get', () => null);
    const result = await syncIdentities({ transport, account, handlers });

    expect(result.removed).toBe(0);
    const list = await handlers[DB_RPC.IDENTITY_LIST]({ accountId: account.id });
    expect(list).toHaveLength(1);
  });

  it('leaves another account\'s identities alone', async () => {
    const other = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'Other',
      primaryEmail: 'other@example.com',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'acct-2',
    })).row;
    await handlers[DB_RPC.IDENTITY_UPSERT_MANY]({
      accountId: other.id,
      identities: [{ remoteId: 'id-other', email: 'other@example.com' }],
    });
    const transport = new MockTransport();
    transport.handle('Identity/get', () => ({ list: [], state: 'is-1' }));

    await syncIdentities({ transport, account, handlers });

    const theirs = await handlers[DB_RPC.IDENTITY_LIST]({ accountId: other.id });
    expect(theirs).toHaveLength(1);
  });
});
