import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import {
  syncIdentities,
  syncIdentityById,
} from '../../../src/sync/backends/jmap/identities';
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

  it('stores every Identity field without collapsing nullable values', async () => {
    const transport = new MockTransport();
    transport.handle('Identity/get', () => ({
      list: [{
        id: 'id-1',
        name: '',
        email: 'tester@example.com',
        replyTo: [
          { name: null, email: 'first@example.com' },
          { name: 'Second', email: 'second@example.com' },
        ],
        bcc: [],
        textSignature: '',
        htmlSignature: null,
        mayDelete: false,
      }],
      state: 'is-1',
    }));

    await syncIdentities({ transport, account, handlers });

    const [row] = await handlers[DB_RPC.IDENTITY_LIST]({ accountId: account.id });
    expect(row).toMatchObject({
      name: '',
      bcc_json: '[]',
      text_signature: '',
      html_signature: null,
      may_delete: 0,
      reply_to: [
        { name: null, email: 'first@example.com' },
        { name: 'Second', email: 'second@example.com' },
      ],
      bcc: [],
    });
    expect(JSON.parse(row.reply_to_json)).toEqual([
      { name: null, email: 'first@example.com' },
      { name: 'Second', email: 'second@example.com' },
    ]);
  });

  it('targeted repair upserts only the requested id and never sweeps', async () => {
    await handlers[DB_RPC.IDENTITY_UPSERT_MANY]({
      accountId: account.id,
      snapshot: true,
      identities: [
        {
          remoteId: 'id-target',
          name: 'Old target',
          email: 'target@example.com',
          replyTo: null,
          bcc: null,
          textSignature: null,
          htmlSignature: null,
          mayDelete: true,
          rawJson: '{}',
        },
        {
          remoteId: 'id-unrelated',
          name: 'Unrelated',
          email: 'other@example.com',
          replyTo: null,
          bcc: null,
          textSignature: null,
          htmlSignature: null,
          mayDelete: false,
          rawJson: '{}',
        },
      ],
    });
    const transport = new MockTransport();
    transport.handle('Identity/get', (params) => {
      expect(params.ids).toEqual(['id-target']);
      return {
        list: [{
          id: 'id-target',
          name: 'Updated target',
          email: 'target@example.com',
          replyTo: [],
          bcc: [{ name: null, email: 'audit@example.com' }],
          textSignature: 'Target',
          htmlSignature: '<div>Target</div>',
          mayDelete: true,
        }],
        state: 'is-2',
      };
    });

    const repaired = await syncIdentityById({
      transport,
      account,
      handlers,
      remoteId: 'id-target',
    });

    expect(repaired).toMatchObject({
      remote_id: 'id-target',
      name: 'Updated target',
      bcc: [{ name: null, email: 'audit@example.com' }],
    });
    const list = await handlers[DB_RPC.IDENTITY_LIST]({ accountId: account.id });
    expect(list.map((identity: any) => identity.remote_id).sort())
      .toEqual(['id-target', 'id-unrelated']);
  });

  it('does not sweep from a structurally partial account response', async () => {
    const transport = new MockTransport();
    transport.handle('Identity/get', () => ({
      list: [
        { id: 'id-primary', name: '', email: 'tester@example.com' },
        { id: 'id-alias', name: '', email: 'alias@example.com' },
      ],
      state: 'is-1',
    }));
    await syncIdentities({ transport, account, handlers });

    transport.handle('Identity/get', () => ({
      list: [{ id: 'id-primary', name: '', email: 'tester@example.com' }],
      notFound: ['response-was-truncated'],
      state: 'is-2',
    }));
    const result = await syncIdentities({ transport, account, handlers });

    expect(result).toMatchObject({ complete: false, removed: 0 });
    const list = await handlers[DB_RPC.IDENTITY_LIST]({ accountId: account.id });
    expect(list.map((identity: any) => identity.remote_id).sort())
      .toEqual(['id-alias', 'id-primary']);
  });

  it('keeps a name:null identity usable while withholding an authoritative sweep', async () => {
    await handlers[DB_RPC.IDENTITY_UPSERT_MANY]({
      accountId: account.id,
      snapshot: true,
      identities: [
        { remoteId: 'id-primary', name: 'Old', email: 'tester@example.com' },
        { remoteId: 'id-keep', name: 'Keep', email: 'keep@example.com' },
      ],
    });
    const transport = new MockTransport();
    transport.handle('Identity/get', () => ({
      list: [
        { id: 'id-primary', name: 'Updated', email: 'tester@example.com' },
        { id: 'id-bad', name: null, email: 'bad@example.com' },
      ],
      state: 'is-unparseable',
    }));

    const result = await syncIdentities({ transport, account, handlers });

    expect(result).toMatchObject({ complete: false, removed: 0 });
    const list = await handlers[DB_RPC.IDENTITY_LIST]({ accountId: account.id });
    expect(list.map((identity: any) => identity.remote_id).sort())
      .toEqual(['id-bad', 'id-keep', 'id-primary']);
    expect(list.find((identity: any) => identity.remote_id === 'id-bad'))
      .toMatchObject({ name: '', email: 'bad@example.com' });
  });

  it('withholds sweeping when another full-response entry is unparseable', async () => {
    await handlers[DB_RPC.IDENTITY_UPSERT_MANY]({
      accountId: account.id,
      snapshot: true,
      identities: [
        { remoteId: 'id-primary', name: 'Old', email: 'tester@example.com' },
        { remoteId: 'id-keep', name: 'Keep', email: 'keep@example.com' },
      ],
    });
    const transport = new MockTransport();
    transport.handle('Identity/get', () => ({
      list: [
        { id: 'id-primary', name: 'Updated', email: 'tester@example.com' },
        {
          id: 'id-invalid',
          name: 'Invalid',
          email: 'invalid@example.com',
          replyTo: 'not-an-address-array',
        },
      ],
      state: 'is-unparseable',
    }));

    const result = await syncIdentities({ transport, account, handlers });

    expect(result).toMatchObject({ complete: false, removed: 0 });
    const list = await handlers[DB_RPC.IDENTITY_LIST]({ accountId: account.id });
    expect(list.map((identity: any) => identity.remote_id).sort())
      .toEqual(['id-keep', 'id-primary']);
  });

  it('drops an identity the server has stopped offering', async () => {
    // An alias removed server-side stayed in the From picker forever,
    // because an upsert has no way to express an absence.
    const transport = new MockTransport();
    let identities = [
      { id: 'id-primary', name: '', email: 'tester@example.com' },
      { id: 'id-alias', name: '', email: 'alias@example.com' },
    ];
    transport.handle('Identity/get', () => ({ list: identities, state: 'is-1' }));
    await syncIdentities({ transport, account, handlers });

    identities = [{ id: 'id-primary', name: '', email: 'tester@example.com' }];
    const result = await syncIdentities({ transport, account, handlers });

    expect(result.removed).toBe(1);
    const list = await handlers[DB_RPC.IDENTITY_LIST]({ accountId: account.id });
    expect(list.map((i: any) => i.email)).toEqual(['tester@example.com']);
  });

  it('accepts an empty list as the answer it is', async () => {
    const transport = new MockTransport();
    let identities: any[] = [{ id: 'id-primary', name: '', email: 'tester@example.com' }];
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
      list: [{ id: 'id-primary', name: '', email: 'tester@example.com' }],
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
