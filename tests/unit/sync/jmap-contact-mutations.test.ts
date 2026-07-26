import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { SEND_PHASE, SERVICE_KIND } from '../../../src/constants/states';
import { MUTATION_TYPES, processMutationRow } from '../../../src/sync/backends/jmap/outbox';
import { MockTransport } from './_mock-transport';

/**
 * What a contact mutation says when the server took the write and the local
 * cache did not follow (CS-4.4).
 *
 * The old answer was "success": the card was on the server, the list did not
 * show it, and nothing remembered the difference. These cases pin the two
 * halves of the replacement — the failure is reported, and the retry repairs
 * the cache without repeating the write.
 */

let engine: any;
let handlers: any;
let account: any;

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
  await handlers[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
    accountId: account.id,
    serviceKind: SERVICE_KIND.JMAP_CONTACTS,
    addressbooks: [{ remoteId: 'book-default', name: 'Contacts', isDefault: true }],
  });
});

afterEach(async () => {
  await engine.close();
});

async function queueRow(mutationType: string, request: any) {
  const { id } = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
    accountId: account.id,
    mutationType,
    targetMessageId: null,
    requestJson: JSON.stringify(request),
  });
  return handlers[DB_RPC.QUERY]({
    sql: 'SELECT * FROM pending_mutations WHERE id = ?',
    params: [id],
  }).then((rows: any[]) => rows[0]);
}

function reload(rowId: number) {
  return handlers[DB_RPC.QUERY]({
    sql: 'SELECT * FROM pending_mutations WHERE id = ?',
    params: [rowId],
  }).then((rows: any[]) => rows[0]);
}

/** A server that accepts writes; `getFails` breaks the read-back. */
function contactServer({ getFails = false } = {}) {
  const transport = new MockTransport();
  const calls: string[] = [];
  transport.handle('AddressBook/get', () => ({
    list: [{ id: 'book-default', name: 'Contacts', isDefault: true }],
    state: 'ab-1',
  }));
  transport.handle('ContactCard/query', () => ({ ids: [], total: 0, queryState: 'qs' }));
  transport.handle('ContactCard/set', (params) => {
    calls.push('set');
    if (params.destroy) return { destroyed: params.destroy };
    if (params.update) return { updated: { [Object.keys(params.update)[0]]: null } };
    return { created: { c1: { id: 'card-new' } } };
  });
  transport.handle('ContactCard/get', (params) => {
    calls.push('get');
    if (getFails) throw new Error('cache read failed');
    return {
      list: (params.ids ?? []).map((id: string) => ({
        id,
        addressBookIds: { 'book-default': true },
        name: { full: 'Ada' },
        emails: { e1: { address: 'ada@example.com' } },
      })),
      state: 'cc-1',
    };
  });
  return { transport, calls };
}

describe('a contact write the cache did not follow', () => {
  it('reports the failure instead of a success the list contradicts', async () => {
    const row = await queueRow(MUTATION_TYPES.CREATE_CONTACT, {
      emails: ['ada@example.com'],
      name: 'Ada',
    });
    const { transport } = contactServer({ getFails: true });

    const result = await processMutationRow({ transport, account, handlers, row });

    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('cacheReconcileFailed');
    expect(result.error.result, 'the card is on the server even so')
      .toMatchObject({ applied: true, cached: false });
  });

  it('remembers that the write already happened', async () => {
    const row = await queueRow(MUTATION_TYPES.CREATE_CONTACT, {
      emails: ['ada@example.com'],
      name: 'Ada',
    });
    const { transport } = contactServer({ getFails: true });

    await processMutationRow({ transport, account, handlers, row });

    const parked = await reload(row.id);
    expect(parked.phase).toBe(SEND_PHASE.CACHE_PENDING);
    expect(JSON.parse(parked.server_response_json).reconcileIds).toEqual(['card-new']);
  });

  it('retries the cache alone, leaving the server card as it is', async () => {
    const row = await queueRow(MUTATION_TYPES.CREATE_CONTACT, {
      emails: ['ada@example.com'],
      name: 'Ada',
    });
    const failing = contactServer({ getFails: true });
    await processMutationRow({ transport: failing.transport, account, handlers, row });

    const working = contactServer();
    const retry = await processMutationRow({
      transport: working.transport,
      account,
      handlers,
      row: await reload(row.id),
    });

    expect(retry.ok).toBe(true);
    expect(working.calls, 'the retry reads, it does not write again').toEqual(['get']);
    const contacts = await handlers[DB_RPC.CONTACT_LIST]({ accountId: account.id });
    expect(contacts.map((c: any) => c.email)).toEqual(['ada@example.com']);
  });

  it('does not replay a destroy the server has already carried out', async () => {
    // A destroy replayed against a card that is gone answers notFound,
    // which retires the row as permanently failed — a delete that worked,
    // reported as one that cannot.
    await handlers[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: account.id,
      contacts: [{
        addressbookIds: [1],
        remoteId: 'card-old',
        displayName: 'Ada',
        emails: [{ email: 'ada@example.com' }],
      }],
    });
    const row = await queueRow(MUTATION_TYPES.DELETE_CONTACT, { remoteId: 'card-old' });
    const transport = new MockTransport();
    transport.handle('ContactCard/set', () => ({ destroyed: ['card-old'] }));
    // The local delete fails once, then the row is retried against a server
    // that would report notFound if asked to destroy the card again.
    let deletes = 0;
    const breakingHandlers = {
      ...handlers,
      [DB_RPC.CONTACT_DELETE_LOCAL]: async (params: any) => {
        deletes += 1;
        if (deletes === 1) throw new Error('cache write failed');
        return handlers[DB_RPC.CONTACT_DELETE_LOCAL](params);
      },
    };
    const first = await processMutationRow({
      transport, account, handlers: breakingHandlers, row,
    });
    expect(first.ok).toBe(false);

    transport.handle('ContactCard/set', () => {
      throw new Error('the card is already gone');
    });
    const retry = await processMutationRow({
      transport,
      account,
      handlers: breakingHandlers,
      row: await reload(row.id),
    });

    expect(retry.ok).toBe(true);
    const contacts = await handlers[DB_RPC.CONTACT_LIST]({ accountId: account.id });
    expect(contacts).toEqual([]);
  });

  it('gives up after enough failures, and forces the next sync to rebuild', async () => {
    // A cache that cannot be repaired card-by-card is a cache that should
    // not be trusted to receive a delta: dropping the checkpoint makes the
    // next sync authoritative rather than incremental.
    await handlers[DB_RPC.SYNC_STATE_SET]({
      accountId: account.id,
      objectType: 'ContactCard',
      state: 'state-before',
    });
    const row = await queueRow(MUTATION_TYPES.CREATE_CONTACT, {
      emails: ['ada@example.com'],
      name: 'Ada',
    });
    const { transport } = contactServer({ getFails: true });

    let last: any;
    let current = row;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      last = await processMutationRow({ transport, account, handlers, row: current });
      current = await reload(row.id);
    }

    expect(last.ok).toBe(false);
    expect(last.error.terminal, 'stop asking the runner to try again').toBe(true);
    const checkpoint = await handlers[DB_RPC.SYNC_STATE_GET]({
      accountId: account.id,
      objectType: 'ContactCard',
    });
    expect(checkpoint?.state ?? null).toBeNull();
  });
});
