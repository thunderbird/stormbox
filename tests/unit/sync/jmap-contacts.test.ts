import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { SERVICE_KIND } from '../../../src/constants/states';
import {
  syncAddressBooks,
  syncContacts,
  syncContactCardChanges,
  createContactCard,
  createTrustedContactCards,
  updateContactCard,
  deleteContactCard,
} from '../../../src/sync/backends/jmap/contacts';
import { processMutationRow } from '../../../src/sync/backends/jmap/outbox';
import { MockTransport } from './_mock-transport';

function jmapCalls(transport, method) {
  const out = [];
  for (const req of transport.requests) {
    for (const [m, params] of req.methodCalls) {
      if (m === method) out.push(params);
    }
  }
  return out;
}

function countMethod(transport, name) {
  return transport.requests.filter(
    (r) => r.methodCalls.some(([m]) => m === name),
  ).length;
}

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

describe('syncAddressBooks', () => {
  it('upserts addressbooks tagged with service_kind=jmap-contacts', async () => {
    const transport = new MockTransport();
    transport.handle('AddressBook/get', () => ({
      list: [
        { id: 'ab-default', name: 'Default', isDefault: true, isSubscribed: true },
        { id: 'ab-shared', name: 'Shared', isDefault: false, isSubscribed: true },
      ],
      state: 'ab-1',
    }));
    const result = await syncAddressBooks({ transport, account, handlers });
    expect(result.count).toBe(2);
    const list = await handlers[DB_RPC.ADDRESSBOOK_LIST]({ accountId: account.id });
    expect(list).toHaveLength(2);
    for (const ab of list) {
      expect(ab.service_kind).toBe(SERVICE_KIND.JMAP_CONTACTS);
    }
    const stateRow = await handlers[DB_RPC.SYNC_STATE_GET]({
      accountId: account.id,
      objectType: 'AddressBook',
    });
    expect(stateRow.state).toBe('ab-1');
  });

  it('retires a book the server has stopped listing', async () => {
    // CS-4.8. Upsert-only left a deleted book on offer as a place to file
    // new contacts, where every save would fail against a book the server
    // does not have.
    const transport = new MockTransport();
    let books = [
      { id: 'ab-default', name: 'Default', isDefault: true },
      { id: 'ab-shared', name: 'Shared' },
    ];
    transport.handle('AddressBook/get', () => ({ list: books, state: 'ab-1' }));
    await syncAddressBooks({ transport, account, handlers });

    books = [{ id: 'ab-default', name: 'Default', isDefault: true }];
    const result = await syncAddressBooks({ transport, account, handlers });

    expect(result.retired).toBe(1);
    const list = await handlers[DB_RPC.ADDRESSBOOK_LIST]({ accountId: account.id });
    expect(list.map((ab: any) => ab.remote_id)).toEqual(['ab-default']);
  });

  it('takes an empty list as an answer', async () => {
    // The empty case is the one an upsert cannot express, and it is real:
    // an account whose last address book was deleted.
    const transport = new MockTransport();
    let books: any[] = [{ id: 'ab-default', name: 'Default', isDefault: true }];
    transport.handle('AddressBook/get', () => ({ list: books, state: 'ab-1' }));
    await syncAddressBooks({ transport, account, handlers });

    books = [];
    await syncAddressBooks({ transport, account, handlers });

    const list = await handlers[DB_RPC.ADDRESSBOOK_LIST]({ accountId: account.id });
    expect(list).toEqual([]);
  });

  it('keeps every book when the response cannot be read', async () => {
    // A missing response is not an empty account, and treating it as one
    // would retire the whole address book over a bad reply.
    const transport = new MockTransport();
    transport.handle('AddressBook/get', () => ({
      list: [{ id: 'ab-default', name: 'Default', isDefault: true }],
      state: 'ab-1',
    }));
    await syncAddressBooks({ transport, account, handlers });

    transport.handle('AddressBook/get', () => null);
    const result = await syncAddressBooks({ transport, account, handlers });

    expect(result.retired).toBe(0);
    const list = await handlers[DB_RPC.ADDRESSBOOK_LIST]({ accountId: account.id });
    expect(list).toHaveLength(1);
  });

  it('leaves another service\'s books alone', async () => {
    // Snapshots are scoped to the service that answered. A CardDAV book is
    // not absent from a JMAP response in any meaningful sense.
    await handlers[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: 'carddav',
      addressbooks: [{ remoteId: 'dav-1', name: 'From CardDAV' }],
    });
    const transport = new MockTransport();
    transport.handle('AddressBook/get', () => ({
      list: [{ id: 'ab-default', name: 'Default', isDefault: true }],
      state: 'ab-1',
    }));

    await syncAddressBooks({ transport, account, handlers });

    const list = await handlers[DB_RPC.ADDRESSBOOK_LIST]({ accountId: account.id });
    expect(list.map((ab: any) => ab.remote_id).sort()).toEqual(['ab-default', 'dav-1']);
  });
});

describe('syncContacts', () => {
  /**
   * A server with nothing to report since the checkpoint. A full sync ends
   * with a catch-up over the window it spent paging, so every one of these
   * cases reaches ContactCard/changes whether or not it is what is being
   * tested.
   */
  /** The contacts the account still has, in a stable order. */
  async function liveRemoteIds(): Promise<string[]> {
    const rows = await engine.all(
      'SELECT remote_id FROM contacts WHERE account_id = ? AND is_deleted = 0 ORDER BY remote_id',
      [account.id],
    );
    return rows.map((row: any) => row.remote_id);
  }

  function nothingChanged(transport: MockTransport) {
    transport.handle('ContactCard/changes', ({ sinceState }) => ({
      oldState: sinceState,
      newState: sinceState,
      created: [],
      updated: [],
      destroyed: [],
      hasMoreChanges: false,
    }));
  }

  it('queries ids, fetches cards, and persists contact + emails', async () => {
    // Pre-seed an addressbook so contacts can resolve.
    await handlers[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'ab-default', name: 'Default', isDefault: true }],
    });

    const transport = new MockTransport();
    transport.handle('ContactCard/query', () => ({
      ids: ['c-1', 'c-2'],
      total: 2,
      queryState: 'query-state-not-a-checkpoint',
    }));
    transport.handle('ContactCard/get', (params) => ({
      list: params.ids.map((id) => ({
        id,
        addressBookId: 'ab-default',
        uid: `uid-${id}`,
        name: { given: 'Jane', surname: 'Doe' },
        fullName: id === 'c-1' ? 'Jane Doe' : 'Jay Doe',
        emails: [
          { email: id === 'c-1' ? 'jane@example.com' : 'jay@example.com', label: 'home', isDefault: true },
        ],
      })),
      state: 'cc-1',
    }));

    nothingChanged(transport);
    const result = await syncContacts({ transport, account, handlers });
    expect(result.fetched).toBe(2);

    const rows = await engine.all(
      `SELECT c.display_name, ce.email, ce.is_preferred
         FROM contacts c JOIN contact_emails ce ON ce.contact_id = c.id
        WHERE c.account_id = ? ORDER BY c.display_name`,
      [account.id],
    );
    expect(rows.map((r) => r.display_name)).toEqual(['Jane Doe', 'Jay Doe']);
    expect(rows.find((r) => r.display_name === 'Jane Doe').email).toBe('jane@example.com');
    expect(Number(rows[0].is_preferred)).toBe(1);
  });

  it('pages through the query until every contact is fetched', async () => {
    await handlers[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'ab-default', name: 'Default', isDefault: true }],
    });

    // 7 contacts, page size 3 -> pages of 3 + 3 + 1.
    const total = 7;
    const allIds = Array.from({ length: total }, (_, i) => `c-${i}`);
    const transport = new MockTransport();
    const positions: number[] = [];
    transport.handle('ContactCard/query', (params) => {
      positions.push(params.position);
      return {
        ids: allIds.slice(params.position, params.position + params.limit),
        position: params.position,
        total,
        queryState: 'query-state-not-a-checkpoint',
      };
    });
    let getPage = 0;
    transport.handle('ContactCard/get', (params) => ({
      list: params.ids.map((id) => ({
        id,
        addressBookId: 'ab-default',
        fullName: `Contact ${id}`,
        emails: [{ email: `${id}@example.com` }],
      })),
      // The state moves on under the paging, as a live server's would.
      state: `cc-paged-${(getPage += 1)}`,
    }));

    nothingChanged(transport);
    const result = await syncContacts({ transport, account, handlers, pageSize: 3 });
    expect(result.fetched).toBe(total);
    expect(result.total).toBe(total);
    // The checkpoint is the state the *first* page was read from, so a
    // change made while the later pages were in flight is replayed by a
    // catch-up rather than lost between them.
    expect(result.state).toBe('cc-paged-1');
    expect(positions).toEqual([0, 3, 6]);

    const row = await engine.get(
      'SELECT COUNT(*) AS n FROM contacts WHERE account_id = ? AND is_deleted = 0',
      [account.id],
    );
    expect(row.n).toBe(total);

    // Each page is one chained query+get round trip, not two requests,
    // followed by the single catch-up that closes the paging window.
    const paging = transport.requests.filter(
      (req) => req.methodCalls[0][0] === 'ContactCard/query',
    );
    expect(paging).toHaveLength(3);
    for (const req of paging) {
      expect(req.methodCalls.map(([m]) => m)).toEqual(['ContactCard/query', 'ContactCard/get']);
    }
    expect(transport.requests.at(-1).methodCalls.map(([m]) => m))
      .toEqual(['ContactCard/changes']);
  });

  it('clamps the page size to the session maxObjectsInGet', async () => {
    await handlers[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'ab-default', name: 'Default', isDefault: true }],
    });

    const transport = new MockTransport({
      capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 2 } },
    });
    const limits: number[] = [];
    const allIds = ['c-0', 'c-1', 'c-2'];
    transport.handle('ContactCard/query', (params) => {
      limits.push(params.limit);
      return {
        ids: allIds.slice(params.position, params.position + params.limit),
        position: params.position,
        total: allIds.length,
        queryState: 'query-state-not-a-checkpoint',
      };
    });
    transport.handle('ContactCard/get', (params) => ({
      list: params.ids.map((id) => ({
        id,
        addressBookId: 'ab-default',
        fullName: `Contact ${id}`,
        emails: [{ email: `${id}@example.com` }],
      })),
    }));

    nothingChanged(transport);
    const result = await syncContacts({ transport, account, handlers, pageSize: 500 });
    expect(result.fetched).toBe(3);
    expect(limits).toEqual([2, 2]);
  });

  it('skips cards whose addressbook is not yet synced locally', async () => {
    const transport = new MockTransport();
    transport.handle('ContactCard/query', () => ({ ids: ['c-1'], total: 1, queryState: 'qs' }));
    transport.handle('ContactCard/get', () => ({
      list: [{
        id: 'c-1',
        addressBookId: 'ab-unknown',
        uid: 'u-1',
        fullName: 'Stranger',
        emails: [{ email: 'unknown@example.com' }],
      }],
      state: 'cc',
    }));
    nothingChanged(transport);
    await syncContacts({ transport, account, handlers });
    const list = await engine.all('SELECT * FROM contacts WHERE account_id = ?', [account.id]);
    expect(list).toHaveLength(0);
  });

  it('parses the JSContact map shape Stalwart serves (addressBookIds, emails map, name.full)', async () => {
    await handlers[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'book-e', name: 'Trusted senders', isDefault: false }],
    });

    const transport = new MockTransport();
    transport.handle('ContactCard/query', () => ({ ids: ['d'], total: 1, queryState: 'qs' }));
    transport.handle('ContactCard/get', () => ({
      list: [{
        '@type': 'Card',
        version: '1.0',
        id: 'd',
        kind: 'individual',
        name: { full: 'Ada Lovelace' },
        emails: { e1: { '@type': 'EmailAddress', address: 'ada@example.com', pref: 1 } },
        organizations: { o1: { name: 'Analytical Engines' } },
        addressBookIds: { 'book-e': true },
      }],
      state: 'cc-map',
    }));

    nothingChanged(transport);
    const result = await syncContacts({ transport, account, handlers });
    expect(result.fetched).toBe(1);

    const row = await engine.get(
      `SELECT c.display_name, c.organization, c.remote_id, ce.email, ce.is_preferred
         FROM contacts c JOIN contact_emails ce ON ce.contact_id = c.id
        WHERE c.account_id = ?`,
      [account.id],
    );
    expect(row.display_name).toBe('Ada Lovelace');
    expect(row.organization).toBe('Analytical Engines');
    expect(row.remote_id).toBe('d');
    expect(row.email).toBe('ada@example.com');
    expect(Number(row.is_preferred)).toBe(1);
  });

  it('removes a contact the server no longer has', async () => {
    // CS-4.2: a full sync is authoritative. Without a sweep a card deleted
    // on another device stays in the address book and in autocomplete for
    // as long as the account lives, because `changes` will never name a
    // card it has already forgotten.
    await handlers[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'ab-default', name: 'Default', isDefault: true }],
    });
    let serverCards = ['c-1', 'c-2'];
    const transport = new MockTransport();
    transport.handle('ContactCard/query', () => ({
      ids: serverCards,
      total: serverCards.length,
      queryState: 'qs',
    }));
    transport.handle('ContactCard/get', (params) => ({
      list: params.ids.map((id) => ({
        id,
        addressBookId: 'ab-default',
        fullName: `Contact ${id}`,
        emails: [{ email: `${id}@example.com` }],
      })),
      state: `state-${serverCards.length}`,
    }));
    nothingChanged(transport);

    await syncContacts({ transport, account, handlers });
    expect(await liveRemoteIds()).toEqual(['c-1', 'c-2']);

    serverCards = ['c-1'];
    const result = await syncContacts({ transport, account, handlers });

    expect(result.swept).toBe(1);
    expect(await liveRemoteIds()).toEqual(['c-1']);
  });

  it('sweeps nothing when the paging did not finish', async () => {
    // The dangerous half of an authoritative sync: a run that stopped after
    // one page knows nothing about the cards it never asked for, and must
    // not read its own ignorance as a deletion.
    await handlers[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'ab-default', name: 'Default', isDefault: true }],
    });
    const allIds = ['c-0', 'c-1', 'c-2', 'c-3'];
    const transport = new MockTransport();
    transport.handle('ContactCard/query', (params) => ({
      ids: allIds.slice(params.position, params.position + params.limit),
      position: params.position,
      total: allIds.length,
      queryState: 'qs',
    }));
    transport.handle('ContactCard/get', (params) => ({
      list: params.ids.map((id) => ({
        id,
        addressBookId: 'ab-default',
        fullName: `Contact ${id}`,
        emails: [{ email: `${id}@example.com` }],
      })),
      state: 'state-full',
    }));
    nothingChanged(transport);
    await syncContacts({ transport, account, handlers, pageSize: 2 });
    expect(await liveRemoteIds()).toEqual(allIds);

    // Now the connection drops after the first page of the next sync.
    let pages = 0;
    transport.handle('ContactCard/query', (params) => {
      pages += 1;
      if (pages > 1) throw new Error('connection lost');
      return {
        ids: allIds.slice(params.position, params.position + params.limit),
        position: params.position,
        total: allIds.length,
        queryState: 'qs',
      };
    });

    await expect(syncContacts({ transport, account, handlers, pageSize: 2 }))
      .rejects.toThrow(/connection lost/);

    expect(await liveRemoteIds(), 'an interrupted sync deletes nothing').toEqual(allIds);
  });

  it('replays what changed while it was paging', async () => {
    // The checkpoint is the state the first page was read from, so a card
    // deleted during the sync is caught by the catch-up rather than sitting
    // in the gap between the pages and the checkpoint.
    await handlers[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'ab-default', name: 'Default', isDefault: true }],
    });
    const transport = new MockTransport();
    transport.handle('ContactCard/query', () => ({
      ids: ['c-1', 'c-2'],
      total: 2,
      queryState: 'qs',
    }));
    transport.handle('ContactCard/get', (params) => ({
      list: params.ids.map((id) => ({
        id,
        addressBookId: 'ab-default',
        fullName: `Contact ${id}`,
        emails: [{ email: `${id}@example.com` }],
      })),
      state: 'state-1',
    }));
    transport.handle('ContactCard/changes', ({ sinceState }) => ({
      oldState: sinceState,
      newState: 'state-2',
      created: [],
      updated: [],
      destroyed: ['c-2'],
      hasMoreChanges: false,
    }));

    const result = await syncContacts({ transport, account, handlers });

    expect(await liveRemoteIds()).toEqual(['c-1']);
    expect(result.state, 'the checkpoint moves on to where the catch-up ended')
      .toBe('state-2');
  });

  it('checkpoints the object state, which is the only one changes accepts', async () => {
    // The checkpoint used to be read from the query response's `state`, a
    // field no server sends — a query answers with `queryState` (RFC 8620
    // §5.5), and only the object state from `get` can be handed to
    // `changes` (§5.2). Nothing was therefore ever written, and every
    // contact push fell back to resyncing the whole account.
    await handlers[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'ab-default', name: 'Default', isDefault: true }],
    });
    const transport = new MockTransport();
    transport.handle('ContactCard/query', () => ({
      ids: ['c-1'],
      total: 1,
      queryState: 'query-state-not-a-checkpoint',
    }));
    transport.handle('ContactCard/get', (params) => ({
      list: params.ids.map((id) => ({
        id,
        addressBookId: 'ab-default',
        fullName: 'Ada',
        emails: [{ email: 'ada@example.com' }],
      })),
      state: 'object-state-1',
    }));

    nothingChanged(transport);
    const result = await syncContacts({ transport, account, handlers });

    expect(result.state).toBe('object-state-1');
    const saved = await handlers[DB_RPC.SYNC_STATE_GET]({
      accountId: account.id,
      objectType: 'ContactCard',
    });
    expect(saved?.state, 'a full sync must leave a checkpoint to resume from')
      .toBe('object-state-1');
  });

  /** An address book and two cards already synced and settled. */
  async function seedTwoContacts() {
    await handlers[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'ab-default', name: 'Default', isDefault: true }],
    });
    const books = await handlers[DB_RPC.ADDRESSBOOK_LIST]({ accountId: account.id });
    await handlers[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: account.id,
      generation: 1,
      contacts: ['c-1', 'c-2'].map((remoteId) => ({
        addressbookIds: [books[0].id],
        remoteId,
        displayName: remoteId,
        emails: [{ email: `${remoteId}@example.com` }],
      })),
    });
  }

  /** A get that answers for whatever ids it is handed. */
  function answerGets(transport: MockTransport, book = 'ab-default') {
    transport.handle('ContactCard/get', (params) => ({
      list: params.ids.map((id) => ({
        id, addressBookId: book, fullName: id, emails: [{ email: `${id}@example.com` }],
      })),
      state: 'object-state-1',
    }));
  }

  /** Three cards already synced, so a sweep has something to lose. */
  async function seedContacts(remoteIds: string[]) {
    await handlers[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'ab-default', name: 'Default', isDefault: true }],
    });
    const books = await handlers[DB_RPC.ADDRESSBOOK_LIST]({ accountId: account.id });
    await handlers[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: account.id,
      generation: 1,
      contacts: remoteIds.map((remoteId) => ({
        addressbookIds: [books[0].id],
        remoteId,
        displayName: remoteId,
        emails: [{ email: `${remoteId}@example.com` }],
      })),
    });
  }

  it('keeps a card the query named and the get withheld', async () => {
    // CS-4.2. `notFound` is the documented answer for ids a get did not
    // return (RFC 8620 §5.1), and it arrives without anything being wrong: a
    // server capping objects in a get below the ids its own query returned, a
    // permission change between the two method calls, or a destroy landing
    // between them. Only the last makes a local deletion correct, and this
    // code cannot tell them apart, so it must not delete.
    //
    // The page reads as complete on every count the loop keeps: the ids were
    // all named, the cursor advanced by all of them, and `total` is reached.
    // Only the number of cards actually returned differs.
    await seedContacts(['c-a', 'c-b']);
    const transport = new MockTransport();
    transport.handle('ContactCard/query', () => ({
      ids: ['c-a', 'c-b'], total: 2, position: 0, queryState: 'q-1',
    }));
    transport.handle('ContactCard/get', (params) => ({
      list: params.ids.filter((id: string) => id !== 'c-b').map((id: string) => ({
        id, addressBookId: 'ab-default', fullName: id, emails: [{ email: `${id}@example.com` }],
      })),
      notFound: ['c-b'],
      state: 'object-state-1',
    }));
    nothingChanged(transport);

    const result = await syncContacts({ transport, account, handlers });

    expect(await liveRemoteIds(), 'a card the get withheld is not a card the server lost')
      .toEqual(['c-a', 'c-b']);
    expect(result.swept, 'nothing may be removed on a reading this incomplete').toBe(0);
    // And the gap has to stay transient: the card is missing from this pass,
    // so a checkpoint here would make the next sync incremental, and
    // `changes` never names a card nothing modified.
    const checkpoint = await handlers[DB_RPC.SYNC_STATE_GET]({
      accountId: account.id,
      objectType: 'ContactCard',
    });
    expect(checkpoint?.state ?? null, 'no checkpoint past a card this pass never saw')
      .toBeNull();
  });

  it('starts over rather than sweeping when the card list moves under the cursor', async () => {
    // CS-4.2, and the case has to be one where drift actually costs a card,
    // or the test passes against code with no drift detection at all.
    //
    // The server holds [A, B, C] and serves A. A is then deleted elsewhere, so
    // B slides from index 1 to index 0 and the next page — position 1 — serves
    // C. B is never fetched, so never stamped, and a sweep would delete a card
    // the server still has. `changes` cannot save it: nothing modified B.
    await seedContacts(['c-a', 'c-b', 'c-c']);
    const transport = new MockTransport();
    let pass = 1;
    let served = 0;
    transport.handle('ContactCard/query', ({ position }) => {
      if (pass === 1) {
        served += 1;
        if (served === 1) {
          return { ids: ['c-a'], total: 3, position: 0, queryState: 'q-1' };
        }
        // A is gone; the list is now [B, C] under a new query state.
        pass = 2;
        return { ids: ['c-c'], total: 2, position: 1, queryState: 'q-2' };
      }
      const list = ['c-b', 'c-c'];
      return {
        ids: list.slice(position, position + 1),
        total: 2,
        position,
        queryState: 'q-2',
      };
    });
    answerGets(transport);
    nothingChanged(transport);

    const result = await syncContacts({ transport, account, handlers, pageSize: 1 });

    // The exact end state, because it is what separates the two worlds: with
    // drift detection the restarted pass reads [B, C] and sweeps A, which
    // really was deleted. Without it, the first pass reads A then C, never
    // sees B, and sweeps B instead — leaving ['c-a', 'c-c']. A count of
    // fetched cards is 2 either way and cannot tell them apart.
    expect(await liveRemoteIds(), 'the card that slid past the cursor must survive')
      .toEqual(['c-b', 'c-c']);
    expect(result.swept, 'and the card that really went is the one removed').toBe(1);
    expect(
      countMethod(transport, 'ContactCard/query'),
      'a restart means the list is read again, not carried on from mid-way',
    ).toBeGreaterThan(2);
  });

  it('gives up sweeping rather than paging forever against a moving list', async () => {
    await seedTwoContacts();
    const transport = new MockTransport();
    let page = 0;
    transport.handle('ContactCard/query', () => {
      page += 1;
      return { ids: ['c-1'], total: 2, position: 0, queryState: `q-${page}` };
    });
    answerGets(transport);
    nothingChanged(transport);

    const result = await syncContacts({ transport, account, handlers, pageSize: 1 });

    expect(result.unstable, 'the caller should learn the list never settled').toBe(true);
    expect(result.swept).toBe(0);
    expect(await liveRemoteIds(), 'an unsettled account keeps what it had')
      .toEqual(['c-1', 'c-2']);
  });

  it('refuses to read a failed page as an account with no contacts', async () => {
    // `pickResponse` answers null for a method-level error as well as an
    // absent slot, so an unguarded read turns one failed round trip into an
    // empty result — and the sweep behind it into a deletion of the entire
    // address book.
    await seedTwoContacts();
    const transport = new MockTransport();
    transport.handle('ContactCard/query', () => ({
      ids: ['c-1', 'c-2'], total: 2, queryState: 'q-1',
    }));
    transport.handle('ContactCard/get', () => null);
    nothingChanged(transport);

    await expect(syncContacts({ transport, account, handlers }))
      .rejects.toThrow(/ContactCard\/get/);
    expect(await liveRemoteIds(), 'a failed page must leave the contacts alone')
      .toEqual(['c-1', 'c-2']);
  });

  it('refuses to read an unanswered query as an account with no contacts', async () => {
    await seedTwoContacts();
    const transport = new MockTransport();
    transport.handle('ContactCard/query', () => null);
    transport.handle('ContactCard/get', () => ({ list: [], state: 's' }));
    nothingChanged(transport);

    await expect(syncContacts({ transport, account, handlers }))
      .rejects.toThrow(/ContactCard\/query/);
    expect(await liveRemoteIds()).toEqual(['c-1', 'c-2']);
  });

  it('keeps paging when the server caps the page below what was asked for', async () => {
    // RFC 8620 §5.5 lets the server clamp `limit` and requires it to return
    // the limit it enforced. Measuring a short page against what we asked
    // for rather than what it agreed to give reads a capped server as an
    // account that ran out of contacts after one page — and the sweep
    // deletes the remainder. Stalwart's cap is 5000 against a 500 page, so
    // only a tighter-configured instance reaches this.
    await seedTwoContacts();
    const transport = new MockTransport();
    transport.handle('ContactCard/query', ({ position }) => ({
      // Asked for 500 a page; this server will only ever give one.
      ids: position === 0 ? ['c-1'] : ['c-2'],
      total: 2,
      position,
      limit: 1,
      queryState: 'q-1',
    }));
    answerGets(transport);
    nothingChanged(transport);

    const result = await syncContacts({ transport, account, handlers });

    expect(result.fetched, 'both pages should be read').toBe(2);
    expect(await liveRemoteIds(), 'and nothing swept for being past a short page')
      .toEqual(['c-1', 'c-2']);
  });

  it('does not sweep a card it could not file for want of its address book', async () => {
    // The card is plainly on the server — it came back in this very page —
    // but no local book matches, so it goes unstamped. Sweeping then reads
    // it as absent and deletes it, and the `changes` catch-up cannot bring
    // it back because nothing modified it.
    await seedTwoContacts();
    const transport = new MockTransport();
    transport.handle('ContactCard/query', () => ({
      ids: ['c-1', 'c-2'], total: 2, queryState: 'q-1',
    }));
    transport.handle('ContactCard/get', (params) => ({
      list: params.ids.map((id) => ({
        id,
        // c-2 has been re-filed into a book this account has not synced.
        addressBookId: id === 'c-2' ? 'ab-unknown' : 'ab-default',
        fullName: id,
        emails: [{ email: `${id}@example.com` }],
      })),
      state: 'object-state-1',
    }));
    nothingChanged(transport);

    const result = await syncContacts({ transport, account, handlers });

    expect(result.swept).toBe(0);
    expect(await liveRemoteIds(), 'an unfiled card is not an absent one')
      .toEqual(['c-1', 'c-2']);
  });

  it('will not sweep across pages the server gave it no way to tie together', async () => {
    // A query state is what makes several pages one list. Without one, drift
    // is undetectable — and initialising the stored state to the same value
    // that means "the server sent none" is how the whole check quietly stops
    // running while appearing to pass.
    // `c-stale` is held locally and absent from the server's list, so a sweep
    // has something to delete. Asserting `swept === 0` against a list where
    // every card gets stamped would pass with no check running at all.
    await seedContacts(['c-a', 'c-b', 'c-stale']);
    const transport = new MockTransport();
    transport.handle('ContactCard/query', ({ position }) => ({
      ids: ['c-a', 'c-b'].slice(position, position + 1),
      total: 2,
      position,
    }));
    answerGets(transport);
    nothingChanged(transport);

    const result = await syncContacts({ transport, account, handlers, pageSize: 1 });

    expect(result.fetched, 'both pages are still read').toBe(2);
    expect(result.swept, 'but nothing may be removed on an unverifiable reading').toBe(0);
    expect(await liveRemoteIds(), 'including a card this pass could not account for')
      .toContain('c-stale');
  });

  it('still sweeps a single-page account that reports no query state', async () => {
    // The other half of the rule, and the common case: one request cannot
    // drift, because the query and the get are answered together. Refusing to
    // sweep here would mean a deletion on the server never arrives locally
    // for any account small enough to fit in one page.
    await seedContacts(['c-a', 'c-b']);
    const transport = new MockTransport();
    transport.handle('ContactCard/query', () => ({
      ids: ['c-a'], total: 1, position: 0,
    }));
    answerGets(transport);
    nothingChanged(transport);

    const result = await syncContacts({ transport, account, handlers });

    expect(result.swept, 'the card the server no longer has must go').toBe(1);
    expect(await liveRemoteIds()).toEqual(['c-a']);
  });

  it('ignores a limit larger than the one it asked for', async () => {
    // Clamping only ever reduces. A server reporting its configured ceiling
    // while serving the page requested would otherwise make every page look
    // short of it, ending the pass after one page and sweeping the rest.
    await seedContacts(['c-a', 'c-b']);
    const transport = new MockTransport();
    transport.handle('ContactCard/query', ({ position }) => ({
      ids: ['c-a', 'c-b'].slice(position, position + 1),
      position,
      limit: 5_000,
      queryState: 'q-1',
    }));
    answerGets(transport);
    nothingChanged(transport);

    const result = await syncContacts({ transport, account, handlers, pageSize: 1 });

    expect(result.fetched, 'the second page must still be asked for').toBe(2);
    expect(await liveRemoteIds()).toEqual(['c-a', 'c-b']);
  });

  it('stops rather than paging forever against a cursor that never moves', async () => {
    // A server that keeps echoing position 0 while serving full pages makes
    // every page look like a full page, and a stable query state means no
    // restart fires either. Nothing else in the loop breaks the tie.
    await seedContacts(['c-a', 'c-b']);
    const transport = new MockTransport();
    let pages = 0;
    transport.handle('ContactCard/query', () => {
      pages += 1;
      if (pages > 50) throw new Error('paged without terminating');
      return { ids: ['c-a'], position: 0, queryState: 'q-1' };
    });
    answerGets(transport);
    nothingChanged(transport);

    const result = await syncContacts({ transport, account, handlers, pageSize: 1 });

    expect(pages, 'it must give up quickly, not spin').toBeLessThan(50);
    expect(result.swept, 'and sweep nothing on a reading it could not finish').toBe(0);
  });

  it('leaves no checkpoint when a card could not be filed', async () => {
    // Suppressing the sweep keeps the card from being deleted, but a
    // checkpoint makes the next sync incremental — and `changes` never names
    // a card nothing modified, so the local gap would be permanent instead of
    // lasting until the address book arrives.
    //
    // The checkpoint seeded here is the point: a full sync runs with one
    // already on disk — `changes` asking for a rebuild, or the
    // `SYNC_ENSURE_CONTACTS` RPC — so declining to *write* one is not the same
    // as leaving none behind. Without the seed this passes either way.
    await seedContacts(['c-a']);
    await handlers[DB_RPC.SYNC_STATE_SET]({
      accountId: account.id,
      objectType: 'ContactCard',
      state: 'checkpoint-from-an-earlier-sync',
    });
    const transport = new MockTransport();
    transport.handle('ContactCard/query', () => ({
      ids: ['c-a', 'c-b'], total: 2, queryState: 'q-1',
    }));
    transport.handle('ContactCard/get', (params) => ({
      list: params.ids.map((id) => ({
        id,
        addressBookId: id === 'c-b' ? 'ab-unknown' : 'ab-default',
        fullName: id,
        emails: [{ email: `${id}@example.com` }],
      })),
      state: 'object-state-1',
    }));
    nothingChanged(transport);

    const result = await syncContacts({ transport, account, handlers });

    expect(result.needsFullSync, 'the caller has to know to read the list again').toBe(true);
    const saved = await handlers[DB_RPC.SYNC_STATE_GET]({
      accountId: account.id,
      objectType: 'ContactCard',
    });
    expect(saved?.state ?? null, 'a checkpoint here would strand the unfiled card')
      .toBeNull();
  });

  it('drops the checkpoint when the catch-up cannot be calculated', async () => {
    // The baseline is the first page's state, so without a catch-up the
    // window spent paging is unaccounted for. Keeping a checkpoint that
    // implies otherwise would let the next delta resume from a state the
    // cache never reached.
    await seedTwoContacts();
    const transport = new MockTransport();
    transport.handle('ContactCard/query', () => ({
      ids: ['c-1'], total: 1, queryState: 'q-1',
    }));
    answerGets(transport);
    // A server that cannot calculate the delta answers with an error, which
    // reaches the reader as a response it cannot use.
    transport.handle('ContactCard/changes', () => null);

    const result = await syncContacts({ transport, account, handlers });

    expect(result.needsFullSync, 'the caller has to know to rebuild').toBe(true);
    const saved = await handlers[DB_RPC.SYNC_STATE_GET]({
      accountId: account.id,
      objectType: 'ContactCard',
    });
    expect(saved?.state ?? null, 'no checkpoint is better than a false one').toBeNull();
  });
});

describe('createContactCard', () => {
  it('creates a card in the default book when no card exists for the email', async () => {
    const transport = new MockTransport();
    transport.handle('ContactCard/query', () => ({ ids: [], total: 0 }));
    transport.handle('AddressBook/get', () => ({
      list: [
        { id: 'book-default', name: 'Contacts', isDefault: true },
        { id: 'book-trusted', name: 'Trusted senders', isDefault: false },
      ],
    }));
    let created: any = null;
    transport.handle('ContactCard/set', (params) => {
      created = params.create?.c1;
      return { created: { c1: { id: 'new-1' } } };
    });

    const result = await createContactCard({
      transport, account, emails: ['grace@example.com'], name: 'Grace Hopper',
    });
    expect(result).toEqual({ ok: true, id: 'new-1' });
    expect(created.addressBookIds).toEqual({ 'book-default': true });
    expect(created.emails.e1.address).toBe('grace@example.com');
    expect(created.name.full).toBe('Grace Hopper');
  });

  it('builds a multi-email map from the address list', async () => {
    const transport = new MockTransport();
    transport.handle('ContactCard/query', () => ({ ids: [], total: 0 }));
    transport.handle('AddressBook/get', () => ({
      list: [{ id: 'book-default', name: 'Contacts', isDefault: true }],
    }));
    let created: any = null;
    transport.handle('ContactCard/set', (params) => {
      created = params.create?.c1;
      return { created: { c1: { id: 'new-2' } } };
    });
    const result = await createContactCard({
      transport, account, emails: ['a@example.com', 'b@example.com'], name: 'Multi',
    });
    expect(result.ok).toBe(true);
    expect(Object.values(created.emails).map((e: any) => e.address))
      .toEqual(['a@example.com', 'b@example.com']);
  });

  it('is idempotent: reports alreadyExists without creating a duplicate', async () => {
    const transport = new MockTransport();
    transport.handle('ContactCard/query', () => ({ ids: ['existing'], total: 1 }));
    const result = await createContactCard({
      transport, account, emails: ['dup@example.com'],
    });
    expect(result).toEqual({ ok: true, alreadyExists: true });
    const didSet = transport.requests.some((r) =>
      r.methodCalls.some(([m]) => m === 'ContactCard/set'));
    expect(didSet).toBe(false);
  });
});

describe('createTrustedContactCards', () => {
  function setup({ existingIds = [], existingCards = [] } = {}) {
    const transport = new MockTransport();
    transport.handle('ContactCard/query', () => ({ ids: existingIds, total: existingIds.length }));
    transport.handle('ContactCard/get', () => ({ list: existingCards }));
    transport.handle('AddressBook/get', () => ({
      list: [{ id: 'book-trusted', name: 'Trusted senders', isDefault: false }],
    }));
    let created: any = null;
    transport.handle('ContactCard/set', (params) => {
      created = params.create;
      const out: Record<string, any> = {};
      for (const key of Object.keys(params.create ?? {})) out[key] = { id: `new-${key}` };
      return { created: out };
    });
    return { transport, getCreated: () => created };
  }

  it('trusts every unique sender in one ContactCard/set and de-dupes by address', async () => {
    const { transport, getCreated } = setup();
    const result = await createTrustedContactCards({
      transport,
      account,
      senders: [
        { email: 'a@x.com', name: 'Alice' },
        { email: 'A@X.com', name: 'Alice dup' },
        { email: 'b@y.com', name: 'Bob' },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.created).toBe(2);

    const created = getCreated();
    expect(Object.values(created).map((c: any) => c.emails.e1.address))
      .toEqual(['a@x.com', 'b@y.com']);
    Object.values(created).forEach((c: any) => {
      expect(c.addressBookIds).toEqual({ 'book-trusted': true });
    });

    // Proper batch: one book lookup and one create regardless of N.
    expect(countMethod(transport, 'AddressBook/get')).toBe(1);
    expect(countMethod(transport, 'ContactCard/set')).toBe(1);
    expect(countMethod(transport, 'ContactCard/query')).toBe(1);
  });

  it('skips addresses that already have a card and only creates the rest', async () => {
    const { transport, getCreated } = setup({
      existingIds: ['existing-1'],
      existingCards: [{ id: 'existing-1', emails: { e1: { address: 'a@x.com' } } }],
    });
    const result = await createTrustedContactCards({
      transport,
      account,
      senders: [{ email: 'a@x.com', name: 'Alice' }, { email: 'b@y.com', name: 'Bob' }],
    });
    expect(result.ok).toBe(true);
    expect(result.created).toBe(1);
    expect(Object.values(getCreated()).map((c: any) => c.emails.e1.address)).toEqual(['b@y.com']);
  });

  it('reports alreadyTrusted and issues no create when every sender exists', async () => {
    const { transport } = setup({
      existingIds: ['e1', 'e2'],
      existingCards: [
        { id: 'e1', emails: { e1: { address: 'a@x.com' } } },
        { id: 'e2', emails: { e1: { address: 'b@y.com' } } },
      ],
    });
    const result = await createTrustedContactCards({
      transport,
      account,
      senders: [{ email: 'a@x.com' }, { email: 'b@y.com' }],
    });
    expect(result).toEqual({ ok: true, created: 0, alreadyTrusted: true });
    expect(countMethod(transport, 'ContactCard/set')).toBe(0);
    expect(countMethod(transport, 'AddressBook/get')).toBe(0);
  });

  it('fails without touching the server when no valid sender is provided', async () => {
    const transport = new MockTransport();
    const result = await createTrustedContactCards({
      transport, account, senders: [{ email: '   ' }, { email: null }],
    });
    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('invalidArguments');
    expect(transport.requests).toHaveLength(0);
  });
});

describe('updateContactCard', () => {
  // A card with extra fields the editor never shows, plus per-email
  // metadata, to prove the merge never silently erases anything.
  function cardWithExtras() {
    return {
      '@type': 'Card',
      id: 'd',
      name: { full: 'Old Name', given: 'Old', surname: 'Name' },
      emails: {
        e1: { '@type': 'EmailAddress', address: 'keep@example.com', contexts: { work: true }, pref: 1 },
        e2: { '@type': 'EmailAddress', address: 'drop@example.com' },
      },
      phones: { p1: { '@type': 'Phone', number: '+15551234' } },
      organizations: { o1: { name: 'ACME' } },
      addressBookIds: { 'book-e': true },
    };
  }

  function withCard(card: any) {
    const transport = new MockTransport();
    let update: any = null;
    transport.handle('ContactCard/get', () => ({ list: [card] }));
    transport.handle('ContactCard/set', (params) => {
      update = params.update;
      return { updated: { d: null } };
    });
    return { transport, getUpdate: () => update };
  }

  it('merges emails: keeps metadata for survivors, drops removed, adds new', async () => {
    const { transport, getUpdate } = withCard(cardWithExtras());
    const result = await updateContactCard({
      transport,
      account,
      remoteId: 'd',
      emails: ['keep@example.com', 'fresh@example.com'],
      name: 'Old Name',
    });
    expect(result).toEqual({ ok: true });

    const emails = Object.values(getUpdate().d.emails) as any[];
    const kept = emails.find((e) => e.address === 'keep@example.com');
    expect(kept.contexts).toEqual({ work: true });
    expect(kept.pref).toBe(1);
    expect(emails.some((e) => e.address === 'fresh@example.com')).toBe(true);
    expect(emails.some((e) => e.address === 'drop@example.com')).toBe(false);
  });

  it('never includes untouched fields in the patch (no silent erasure)', async () => {
    const { transport, getUpdate } = withCard(cardWithExtras());
    await updateContactCard({
      transport, account, remoteId: 'd', emails: ['keep@example.com'], name: 'Old Name',
    });
    // PatchObject only carries `emails`; name is unchanged so it is
    // omitted, and phones/organizations/addressBookIds are never sent,
    // so the server leaves them intact.
    expect(Object.keys(getUpdate().d)).toEqual(['emails']);
  });

  it('changes only name.full and preserves other name components', async () => {
    const { transport, getUpdate } = withCard(cardWithExtras());
    await updateContactCard({
      transport, account, remoteId: 'd', emails: ['keep@example.com'], name: 'New Name',
    });
    expect(getUpdate().d.name).toEqual({ full: 'New Name', given: 'Old', surname: 'Name' });
  });

  it('reports notFound when the card no longer exists', async () => {
    const transport = new MockTransport();
    transport.handle('ContactCard/get', () => ({ list: [] }));
    const result = await updateContactCard({
      transport, account, remoteId: 'd', emails: ['x@example.com'],
    });
    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('notFound');
  });

  it('does not call a refused read a card that no longer exists', async () => {
    // `notFound` is terminal in the outbox runner: the row is retired as
    // conflicted and the user is told the edit cannot be made. A method-level
    // error deserves the backoff instead, so the two must not collapse into
    // one answer.
    const transport = new MockTransport();
    transport.handle('ContactCard/get', () => null);
    const result = await updateContactCard({
      transport, account, remoteId: 'd', emails: ['x@example.com'],
    });
    expect(result.ok).toBe(false);
    expect(result.error.type, 'a refused read is worth retrying').toBe('serverFail');
  });

  it('reports an error when the server refuses the update', async () => {
    const transport = new MockTransport();
    transport.handle('ContactCard/get', () => ({ list: [cardWithExtras()] }));
    transport.handle('ContactCard/set', () => ({
      updated: {},
      notUpdated: { d: { type: 'forbidden' } },
    }));
    const result = await updateContactCard({
      transport, account, remoteId: 'd', emails: ['x@example.com'],
    });
    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('notUpdated');
  });
});

describe('deleteContactCard', () => {
  it('destroys the card by remote id', async () => {
    const transport = new MockTransport();
    let destroyed: any = null;
    transport.handle('ContactCard/set', (params) => {
      destroyed = params.destroy;
      return { destroyed: params.destroy };
    });
    const result = await deleteContactCard({ transport, account, remoteId: 'd' });
    expect(result).toEqual({ ok: true });
    expect(destroyed).toEqual(['d']);
  });

  it('treats an already-gone card as success', async () => {
    const transport = new MockTransport();
    transport.handle('ContactCard/set', () => ({
      destroyed: [],
      notDestroyed: { d: { type: 'notFound' } },
    }));
    const result = await deleteContactCard({ transport, account, remoteId: 'd' });
    expect(result).toEqual({ ok: true });
  });
});

describe('syncContactCardChanges', () => {
  beforeEach(async () => {
    await handlers[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'ab-default', name: 'Default', isDefault: true }],
    });
    const ab = await engine.get(
      'SELECT id FROM addressbooks WHERE account_id = ? AND remote_id = ?',
      [account.id, 'ab-default'],
    );
    await handlers[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: account.id,
      contacts: [
        {
          addressbookId: ab.id,
          remoteId: 'c-1',
          fullName: 'Jane Doe',
          displayName: 'Jane Doe',
          emails: [{ email: 'jane@example.com', isPreferred: true }],
        },
        {
          addressbookId: ab.id,
          remoteId: 'c-2',
          fullName: 'Jay Doe',
          displayName: 'Jay Doe',
          emails: [{ email: 'jay@example.com' }],
        },
      ],
    });
  });

  it('applies created/updated by re-fetching cards and soft-deletes destroyed', async () => {
    const transport = new MockTransport();
    transport.handle('ContactCard/changes', () => ({
      oldState: 'cc-0',
      newState: 'cc-1',
      hasMoreChanges: false,
      created: ['c-3'],
      updated: ['c-1'],
      destroyed: ['c-2'],
    }));
    transport.handle('ContactCard/get', (params) => ({
      list: params.ids.map((id) => ({
        id,
        addressBookId: 'ab-default',
        uid: `uid-${id}`,
        fullName: id === 'c-1' ? 'Jane Doe (Updated)' : 'New Person',
        emails: [{ email: `${id}@new.example.com` }],
      })),
      state: 'cc-1',
    }));

    const result = await syncContactCardChanges({
      transport, account, handlers, sinceState: 'cc-0',
    });
    expect(result.newState).toBe('cc-1');
    expect(result.created).toEqual(['c-3']);

    const updated = await engine.get(
      'SELECT display_name FROM contacts WHERE account_id = ? AND remote_id = ?',
      [account.id, 'c-1'],
    );
    expect(updated.display_name).toBe('Jane Doe (Updated)');

    const created = await engine.get(
      'SELECT display_name FROM contacts WHERE account_id = ? AND remote_id = ?',
      [account.id, 'c-3'],
    );
    expect(created.display_name).toBe('New Person');

    const destroyed = await engine.get(
      'SELECT is_deleted FROM contacts WHERE account_id = ? AND remote_id = ?',
      [account.id, 'c-2'],
    );
    expect(Number(destroyed.is_deleted)).toBe(1);
  });

  it('follows hasMoreChanges across pages and persists each page state', async () => {
    const transport = new MockTransport();
    const seenStates: string[] = [];
    transport.handle('ContactCard/changes', (params) => {
      seenStates.push(params.sinceState);
      if (params.sinceState === 'cc-0') {
        return {
          oldState: 'cc-0',
          newState: 'cc-1',
          hasMoreChanges: true,
          created: ['c-3'],
          updated: [],
          destroyed: [],
        };
      }
      return {
        oldState: 'cc-1',
        newState: 'cc-2',
        hasMoreChanges: false,
        created: ['c-4'],
        updated: ['c-1'],
        destroyed: ['c-2'],
      };
    });
    transport.handle('ContactCard/get', (params) => ({
      list: params.ids.map((id) => ({
        id,
        addressBookId: 'ab-default',
        fullName: `Person ${id}`,
        emails: [{ email: `${id}@new.example.com` }],
      })),
    }));

    const result = await syncContactCardChanges({
      transport, account, handlers, sinceState: 'cc-0',
    });
    expect(result.needsFullSync).toBe(false);
    expect(seenStates).toEqual(['cc-0', 'cc-1']);
    expect(result.newState).toBe('cc-2');
    expect(result.created).toEqual(['c-3', 'c-4']);
    expect(result.updated).toEqual(['c-1']);
    expect(result.destroyed).toEqual(['c-2']);

    const stateRow = await handlers[DB_RPC.SYNC_STATE_GET]({
      accountId: account.id,
      objectType: 'ContactCard',
    });
    expect(stateRow.state).toBe('cc-2');

    const gone = await engine.get(
      'SELECT is_deleted FROM contacts WHERE account_id = ? AND remote_id = ?',
      [account.id, 'c-2'],
    );
    expect(Number(gone.is_deleted)).toBe(1);
  });

  it('does not advance past a changed card it could not file', async () => {
    // The mirror of what the full sync does with `skipped`. A card filed in a
    // book this account has not synced cannot be stored, so it is missing
    // locally; advancing the checkpoint over it makes that permanent, because
    // `changes` names what was modified and nothing will modify it again.
    const transport = new MockTransport();
    transport.handle('ContactCard/changes', () => ({
      oldState: 'cc-0',
      newState: 'cc-1',
      hasMoreChanges: false,
      created: ['c-elsewhere'],
      updated: [],
      destroyed: [],
    }));
    transport.handle('ContactCard/get', () => ({
      list: [{
        id: 'c-elsewhere',
        addressBookId: 'ab-not-synced-here',
        fullName: 'Filed Elsewhere',
        emails: [{ email: 'elsewhere@example.com' }],
      }],
      state: 'cc-1',
    }));

    const result = await syncContactCardChanges({
      transport, account, handlers, sinceState: 'cc-0',
    });

    expect(
      await engine.get(
        'SELECT id FROM contacts WHERE account_id = ? AND remote_id = ?',
        [account.id, 'c-elsewhere'],
      ),
      'the card could not be filed, so it is not here',
    ).toBeFalsy();
    expect(result.needsFullSync, 'a delta that dropped a card asks for a rebuild').toBe(true);
    const stateRow = await handlers[DB_RPC.SYNC_STATE_GET]({
      accountId: account.id,
      objectType: 'ContactCard',
    });
    expect(stateRow?.state ?? null, 'and it does not checkpoint past the card it dropped')
      .not.toBe('cc-1');
  });

  it('does not advance past changed cards it was refused', async () => {
    // The state is persisted after the cards are fetched, so a refused
    // read-back that is swallowed costs the delta permanently: those ids
    // are named once and never again, and the next catch-up starts from a
    // state the cache never actually reached.
    const transport = new MockTransport();
    transport.handle('ContactCard/changes', () => ({
      oldState: 'cc-0',
      newState: 'cc-1',
      hasMoreChanges: false,
      created: [],
      updated: ['c-1'],
      destroyed: [],
    }));
    transport.handle('ContactCard/get', () => null);

    await expect(syncContactCardChanges({
      transport, account, handlers, sinceState: 'cc-0',
    })).rejects.toThrow(/ContactCard\/get/);

    const stateRow = await handlers[DB_RPC.SYNC_STATE_GET]({
      accountId: account.id,
      objectType: 'ContactCard',
    });
    expect(
      stateRow?.state ?? null,
      'the checkpoint must not move past a page that was never applied',
    ).not.toBe('cc-1');
  });

  it('requests a full sync when the server reports more changes without advancing state', async () => {
    const transport = new MockTransport();
    transport.handle('ContactCard/changes', () => ({
      oldState: 'cc-stuck',
      newState: 'cc-stuck',
      hasMoreChanges: true,
      created: [],
      updated: [],
      destroyed: [],
    }));
    const result = await syncContactCardChanges({
      transport, account, handlers, sinceState: 'cc-stuck',
    });
    expect(result.needsFullSync).toBe(true);
    expect(countMethod(transport, 'ContactCard/changes')).toBe(1);
  });
});

describe('whitelist reconcile cost is independent of contact count', () => {
  async function seedLocalContacts(n) {
    await handlers[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [
        { remoteId: 'book-default', name: 'Default', isDefault: true },
        { remoteId: 'book-trusted', name: 'Trusted senders', isDefault: false },
      ],
    });
    const books = await handlers[DB_RPC.ADDRESSBOOK_LIST]({ accountId: account.id });
    const defaultLocal = books.find((b) => b.remote_id === 'book-default').id;
    const contacts = Array.from({ length: n }, (_, i) => ({
      addressbookId: defaultLocal,
      remoteId: `seed-${i}`,
      uid: null,
      etag: null,
      fullName: `Seed ${i}`,
      displayName: `Seed ${i}`,
      givenName: null,
      familyName: null,
      organization: null,
      vcardText: null,
      vcardVersion: null,
      rawJson: '{}',
      isDeleted: false,
      emails: [{ position: 0, email: `seed-${i}@x.invalid`, label: null, isPreferred: true }],
    }));
    await handlers[DB_RPC.CONTACT_UPSERT_MANY]({ accountId: account.id, contacts });
  }

  function countContacts() {
    return engine.get(
      'SELECT COUNT(*) AS n FROM contacts WHERE account_id = ? AND is_deleted = 0',
      [account.id],
    );
  }

  it('batch-whitelisting 200 mails from 150 senders on a 1099-contact book fetches only the 150 new cards', async () => {
    await seedLocalContacts(1099);
    expect((await countContacts()).n).toBe(1099);

    // 200 junk messages multi-selected, from 150 distinct senders (50
    // repeats), as the store's whitelistSenders would hand them off.
    const senders = Array.from({ length: 200 }, (_, i) => ({
      email: `batch-${i % 150}@junk.invalid`,
      name: `Sender ${i % 150}`,
    }));
    expect(new Set(senders.map((s) => s.email)).size).toBe(150);

    // The "server" holds 1099 cards, but the batch whitelist must never
    // pull them: a full ContactCard/query (position/limit) would be the
    // old O(contacts) reconcile; the existence check uses a {email}
    // (OR-of-emails) filter.
    const transport = new MockTransport();
    let fullListQueried = false;
    let setCalls = 0;
    let createdInOneCall = 0;
    transport.handle('ContactCard/query', (params) => {
      if (!params.filter) {
        fullListQueried = true;
        return { ids: Array.from({ length: 1099 }, (_, i) => `seed-${i}`), total: 1099, queryState: 's' };
      }
      return { ids: [], total: 0 }; // existence check: none of the senders carded yet
    });
    transport.handle('AddressBook/get', () => ({
      list: [
        { id: 'book-default', name: 'Default', isDefault: true },
        { id: 'book-trusted', name: 'Trusted senders', isDefault: false },
      ],
    }));
    transport.handle('ContactCard/set', (params) => {
      setCalls += 1;
      const created = {};
      const keys = Object.keys(params.create ?? {});
      createdInOneCall = Math.max(createdInOneCall, keys.length);
      for (const key of keys) created[key] = { id: key }; // distinct ids
      return { created };
    });
    transport.handle('ContactCard/get', (params) => ({
      list: (params.ids ?? []).map((id) => ({
        '@type': 'Card',
        id,
        kind: 'individual',
        name: { full: `Trusted ${id}` },
        emails: { e1: { '@type': 'EmailAddress', address: `wl-${id}@junk.invalid` } },
        addressBookIds: { 'book-trusted': true },
      })),
    }));

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: {
        mutation_type: 'whitelistSender',
        request_json: JSON.stringify({ senders }),
      },
    });
    expect(result.ok).toBe(true);

    // All 150 unique senders trusted in a single batched ContactCard/set
    // (200 mails de-duped to 150 cards, one call, not a per-sender loop).
    expect(setCalls).toBe(1);
    expect(createdInOneCall).toBe(150);

    // The 1099-contact book is never re-pulled...
    expect(fullListQueried).toBe(false);
    // ...only the 150 new trusted cards are fetched.
    const idsFetched = jmapCalls(transport, 'ContactCard/get')
      .reduce((sum, p) => sum + (p.ids?.length ?? 0), 0);
    expect(idsFetched).toBe(150);

    // The 1099 existing contacts are untouched; exactly 150 were added.
    expect((await countContacts()).n).toBe(1249);
  });
});
