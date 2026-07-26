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

/**
 * A server that accepts writes.
 *
 * `getFails` breaks the read-back at the transport level: the round trip
 * itself does not complete. `getRefuses` breaks it at the method level,
 * which is what a real server does when it declines one call inside an
 * otherwise successful request — and which reaches the sync code as no
 * answer at all rather than as a thrown error. The two are worth keeping
 * apart: the second shape is the one that used to be read as "the server
 * holds no such card".
 */
function contactServer({ getFails = false, getRefuses = false } = {}) {
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
    if (getRefuses) return null;
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

  it('reads a refused read-back as a failure, not as a card that is not there', async () => {
    // The refusal arrives as a method-level error, which leaves nothing for
    // `pickResponse` to return — indistinguishable, to an unguarded read,
    // from a server answering that it holds no such card. Persisting nothing
    // and reporting success is the CS-4.4 failure this whole group is about,
    // and it is the shape a real server produces: the other cases here fail
    // the round trip itself, which no server does to decline one call.
    const row = await queueRow(MUTATION_TYPES.CREATE_CONTACT, {
      emails: ['ada@example.com'],
      name: 'Ada',
    });
    const { transport } = contactServer({ getRefuses: true });

    const result = await processMutationRow({ transport, account, handlers, row });

    expect(result.ok, 'a cache that never received the card is not a success').toBe(false);
    expect(result.error.type).toBe('cacheReconcileFailed');
    const parked = await reload(row.id);
    expect(parked.phase).toBe(SEND_PHASE.CACHE_PENDING);
    expect(JSON.parse(parked.server_response_json).reconcileIds).toEqual(['card-new']);
    expect(
      await handlers[DB_RPC.CONTACT_LIST]({ accountId: account.id }),
      'and the list says what it honestly knows: nothing',
    ).toEqual([]);
  });

  it('repairs the cache when the server stops refusing the read-back', async () => {
    // The parked row has to be resumable from a refusal, not only from a
    // dropped round trip: that is the sequence a retry actually meets.
    const row = await queueRow(MUTATION_TYPES.CREATE_CONTACT, {
      emails: ['ada@example.com'],
      name: 'Ada',
    });
    const refusing = contactServer({ getRefuses: true });
    await processMutationRow({ transport: refusing.transport, account, handlers, row });

    const relenting = contactServer();
    const retry = await processMutationRow({
      transport: relenting.transport,
      account,
      handlers,
      row: await reload(row.id),
    });

    expect(retry.ok).toBe(true);
    expect(relenting.calls, 'the retry reads; it does not write a second card').toEqual(['get']);
    const contacts = await handlers[DB_RPC.CONTACT_LIST]({ accountId: account.id });
    expect(contacts.map((c: any) => c.email)).toEqual(['ada@example.com']);
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

  it('records the write before reading it back, so a crash cannot reissue it', async () => {
    // Only `send` is held back from replay after a crash; every other row
    // goes straight back to pending. So a contact row that died between a
    // successful ContactCard/set and any durable note of it would come back
    // looking untouched — and create a second card. The phase written
    // before the read-back is what makes the difference, which means it has
    // to be on disk by the time the read-back runs, not after it fails.
    const row = await queueRow(MUTATION_TYPES.CREATE_CONTACT, {
      emails: ['ada@example.com'],
      name: 'Ada',
    });
    const transport = new MockTransport();
    const calls: string[] = [];
    let phaseDuringReadBack: string | null = null;
    transport.handle('AddressBook/get', () => ({
      list: [{ id: 'book-default', name: 'Contacts', isDefault: true }],
      state: 'ab-1',
    }));
    transport.handle('ContactCard/query', () => ({ ids: [], total: 0, queryState: 'qs' }));
    transport.handle('ContactCard/set', () => {
      calls.push('set');
      return { created: { c1: { id: 'card-new' } } };
    });
    transport.handle('ContactCard/get', async () => {
      calls.push('get');
      // Whatever is on disk right now is what a crash would leave behind.
      phaseDuringReadBack = (await reload(row.id))?.phase ?? null;
      throw new Error('the process died here');
    });

    await processMutationRow({ transport, account, handlers, row });

    expect(phaseDuringReadBack, 'the write must be recorded before the read-back')
      .toBe(SEND_PHASE.CACHE_PENDING);

    // Prove it: resume the row exactly as recoverStranded would, and watch
    // the write not happen twice.
    const resumed = contactServer();
    const retry = await processMutationRow({
      transport: resumed.transport,
      account,
      handlers,
      row: await reload(row.id),
    });
    expect(retry.ok).toBe(true);
    expect(resumed.calls, 'the resumed row reads; it does not write again').toEqual(['get']);
    expect(calls.filter((c) => c === 'set'), 'one card, one create').toHaveLength(1);
  });

  it('counts the attempt before the repair, so a crash cannot retry forever', async () => {
    // The bounded case is the one that never reaches a catch block. A crash
    // mid-repair returns the row to pending, and if the count only rose on a
    // thrown error the row would resume at the same number every time —
    // reissuing the repair for as long as it keeps dying.
    const row = await queueRow(MUTATION_TYPES.CREATE_CONTACT, {
      emails: ['ada@example.com'],
      name: 'Ada',
    });
    const transport = new MockTransport();
    let recorded: number | null = null;
    transport.handle('AddressBook/get', () => ({
      list: [{ id: 'book-default', name: 'Contacts', isDefault: true }],
      state: 'ab-1',
    }));
    transport.handle('ContactCard/query', () => ({ ids: [], total: 0, queryState: 'qs' }));
    transport.handle('ContactCard/set', () => ({ created: { c1: { id: 'card-new' } } }));
    transport.handle('ContactCard/get', async () => {
      // Whatever is on disk here is what a crash would leave behind.
      const parked = await reload(row.id);
      recorded = JSON.parse(parked?.server_response_json ?? '{}').attempts ?? null;
      throw new Error('the process died here');
    });

    await processMutationRow({ transport, account, handlers, row });

    expect(recorded, 'the attempt must be on disk before the repair runs').toBe(1);
  });

  it('does not send the row\'s attempt count backwards when it parks', async () => {
    // The bound on a repeated crash is the runner's own column, not the
    // counter in the checkpoint: `CONTACT_CACHE_MAX_ATTEMPTS` is read inside a
    // catch block, and a crash never reaches one. The runner reads
    // `attempts + 1` off the row and gives up at 8. So a checkpoint that reset
    // the column — which this one used to do — pinned every attempt at 1 and
    // made the loop unbounded again, with nothing failing to say so.
    const row = await queueRow(MUTATION_TYPES.CREATE_CONTACT, {
      emails: ['ada@example.com'],
      name: 'Ada',
    });
    await handlers[DB_RPC.QUERY]({
      sql: 'UPDATE pending_mutations SET attempts = ? WHERE id = ?',
      params: [5, row.id],
    });
    const { transport } = contactServer({ getFails: true });

    await processMutationRow({
      transport, account, handlers, row: await reload(row.id),
    });

    const parked = await reload(row.id);
    expect(
      Number(parked.attempts),
      'the column the runner counts with must not be rewound by a checkpoint',
    ).toBeGreaterThanOrEqual(5);
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
