import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  MUTATION_TYPE,
  SERVICE_KIND,
} from '../../../src/constants/states';
import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import {
  DB_RPC,
  TABLE_FAMILIES,
} from '../../../src/db/protocol';
import { processMutationRow } from '../../../src/sync/backends/jmap/outbox';
import { MockTransport } from './_mock-transport';

interface ServerBook {
  id: string;
  name: string;
  writable: boolean;
}

interface ServerCard {
  id: string;
  addressBookIds: Record<string, boolean>;
  name: string;
}

function decodePatchSegment(value: string): string {
  return value.replace(/~1/g, '/').replace(/~0/g, '~');
}

function applyMembershipPatch(
  card: ServerCard,
  patch: Record<string, unknown>,
): void {
  for (const [path, value] of Object.entries(patch)) {
    const prefix = 'addressBookIds/';
    if (!path.startsWith(prefix)) continue;
    const id = decodePatchSegment(path.slice(prefix.length));
    if (value === true) card.addressBookIds[id] = true;
    else if (value == null) delete card.addressBookIds[id];
  }
}

function batchServer(
  books: ServerBook[],
  initialCards: ServerCard[],
  limit = 500,
) {
  const transport = new MockTransport({
    capabilities: {
      'urn:ietf:params:jmap:core': {
        maxObjectsInGet: limit,
        maxObjectsInSet: limit,
      },
    },
  });
  const cards = new Map(initialCards.map((card) => [
    card.id,
    structuredClone(card),
  ]));
  let state = 1;
  let setCalls = 0;
  let failRepairAfterSetCalls = Number.POSITIVE_INFINITY;

  transport.handle('AddressBook/get', () => ({
    list: books.map((book) => ({
      id: book.id,
      name: book.name,
      myRights: { mayWrite: book.writable },
    })),
    state: `books-${state}`,
  }));
  transport.handle('ContactCard/get', ({ ids }) => {
    if (setCalls >= failRepairAfterSetCalls) {
      throw new Error('cache repair unavailable');
    }
    return {
      list: (ids ?? [])
        .map((id: string) => cards.get(id))
        .filter(Boolean)
        .map((card: ServerCard) => ({
          id: card.id,
          addressBookIds: { ...card.addressBookIds },
          name: { full: card.name },
          emails: {
            primary: {
              '@type': 'EmailAddress',
              address: `${card.id}@example.com`,
            },
          },
        })),
      state: `cards-${state}`,
    };
  });
  transport.handle('ContactCard/set', ({ update = {}, destroy = [] }) => {
    setCalls += 1;
    const updated: Record<string, null> = {};
    const destroyed: string[] = [];
    for (const [id, patch] of Object.entries<Record<string, unknown>>(update)) {
      const card = cards.get(id);
      if (!card) continue;
      applyMembershipPatch(card, patch);
      updated[id] = null;
    }
    for (const id of destroy) {
      if (!cards.delete(id)) continue;
      destroyed.push(id);
    }
    state += 1;
    return {
      oldState: `cards-${state - 1}`,
      newState: `cards-${state}`,
      updated,
      destroyed,
    };
  });

  return {
    cards,
    transport,
    get setCalls() {
      return setCalls;
    },
    set failRepair(value: boolean) {
      failRepairAfterSetCalls = value
        ? Math.ceil(cards.size / limit)
        : Number.POSITIVE_INFINITY;
    },
    advanceState() {
      state += 1;
    },
  };
}

let engine: any;
let handlers: any;
let account: any;
let broadcaster: { touch: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  engine = await bootTestEngine();
  broadcaster = { touch: vi.fn() };
  handlers = makeHandlers(engine, broadcaster);
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

async function seed(
  books: ServerBook[],
  cards: ServerCard[],
): Promise<{
  bookIds: Map<string, number>;
  contactIds: Map<string, number>;
}> {
  await handlers[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
    accountId: account.id,
    serviceKind: SERVICE_KIND.JMAP_CONTACTS,
    addressbooks: books.map((book, index) => ({
      remoteId: book.id,
      name: book.name,
      isDefault: index === 0,
      mayWrite: book.writable,
    })),
  });
  const localBooks = await handlers[DB_RPC.ADDRESSBOOK_LIST]({
    accountId: account.id,
  });
  const bookIds = new Map<string, number>(
    localBooks.map((book: any) => [book.remote_id, Number(book.id)]),
  );
  await handlers[DB_RPC.CONTACT_UPSERT_MANY]({
    accountId: account.id,
    contacts: cards.map((card) => ({
      remoteId: card.id,
      displayName: card.name,
      fullName: card.name,
      addressbookIds: Object.keys(card.addressBookIds).map((id) => bookIds.get(id)),
      emails: [{
        email: `${card.id}@example.com`,
        isPreferred: true,
      }],
      rawJson: JSON.stringify(card),
    })),
  });
  const localContacts = await handlers[DB_RPC.CONTACT_LIST]({
    accountId: account.id,
  });
  const contactIds = new Map<string, number>(
    localContacts.map((contact: any) => [contact.remote_id, Number(contact.id)]),
  );
  return { bookIds, contactIds };
}

async function queue(request: unknown) {
  const inserted = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
    accountId: account.id,
    mutationType: MUTATION_TYPE.CONTACT_BATCH,
    targetMessageId: null,
    requestJson: JSON.stringify(request),
  });
  const rows = await handlers[DB_RPC.QUERY]({
    sql: 'SELECT * FROM pending_mutations WHERE id = ?',
    params: [inserted.id],
  });
  return rows[0];
}

function setRequests(transport: MockTransport): any[] {
  return transport.requests.flatMap((request) =>
    request.methodCalls.flatMap(([name, params]) =>
      name === 'ContactCard/set' ? [params] : []));
}

describe('durable ContactCard batches', () => {
  it('moves with sparse patches while preserving unrelated memberships', async () => {
    const books = [
      { id: 'source', name: 'Source', writable: true },
      { id: 'target', name: 'Target', writable: true },
      { id: 'third', name: 'Third', writable: true },
    ];
    const cards = [{
      id: 'card-1',
      addressBookIds: { source: true, third: true },
      name: 'One',
    }];
    const local = await seed(books, cards);
    const server = batchServer(books, cards);
    const row = await queue({
      operation: 'move',
      contactIds: [local.contactIds.get('card-1')],
      sourceAddressbookId: local.bookIds.get('source'),
      targetAddressbookId: local.bookIds.get('target'),
    });

    const result = await processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    });

    expect(result).toMatchObject({
      ok: true,
      result: {
        succeededContactIds: [local.contactIds.get('card-1')],
        failures: [],
      },
    });
    expect(setRequests(server.transport)[0].update['card-1']).toEqual({
      'addressBookIds/source': null,
      'addressBookIds/target': true,
    });
    expect(Object.keys(server.cards.get('card-1')!.addressBookIds).sort())
      .toEqual(['target', 'third']);
    const [cached] = await handlers[DB_RPC.CONTACT_LIST]({ accountId: account.id });
    expect(new Set(cached.addressbook_ids)).toEqual(new Set([
      local.bookIds.get('target'),
      local.bookIds.get('third'),
    ]));
  });

  it('combines scoped membership removal and final-card destruction', async () => {
    const books = [
      { id: 'source', name: 'Source', writable: true },
      { id: 'third', name: 'Third', writable: true },
    ];
    const cards = [
      { id: 'card-final', addressBookIds: { source: true }, name: 'Final' },
      {
        id: 'card-shared',
        addressBookIds: { source: true, third: true },
        name: 'Shared',
      },
    ];
    const local = await seed(books, cards);
    const row = await queue({
      operation: 'scoped-delete',
      contactIds: [
        local.contactIds.get('card-final'),
        local.contactIds.get('card-shared'),
      ],
      sourceAddressbookId: local.bookIds.get('source'),
    });
    const server = batchServer(books, cards);
    broadcaster.touch.mockClear();

    const result = await processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    });

    expect(result).toMatchObject({
      ok: true,
      result: {
        destroyedContactIds: [local.contactIds.get('card-final')],
        updatedContactIds: [local.contactIds.get('card-shared')],
        failures: [],
      },
    });
    const request = setRequests(server.transport)[0];
    expect(request.destroy).toEqual(['card-final']);
    expect(request.update).toEqual({
      'card-shared': { 'addressBookIds/source': null },
    });
    expect(request.ifInState).toMatch(/^cards-/);
    expect(server.cards.has('card-final')).toBe(false);
    const cached = await handlers[DB_RPC.CONTACT_LIST]({ accountId: account.id });
    expect(cached.map((contact: any) => contact.remote_id)).toEqual(['card-shared']);
    expect(cached[0].addressbook_ids).toEqual([local.bookIds.get('third')]);
    expect(broadcaster.touch.mock.calls.filter(
      ([family]) => family === TABLE_FAMILIES.CONTACTS,
    )).toHaveLength(1);
  });

  it('rebases after stateMismatch and retains a concurrently added membership', async () => {
    const books = [
      { id: 'source', name: 'Source', writable: true },
      { id: 'target', name: 'Target', writable: true },
      { id: 'third', name: 'Third', writable: true },
      { id: 'concurrent', name: 'Concurrent', writable: true },
    ];
    const cards = [{
      id: 'card-1',
      addressBookIds: { source: true, third: true },
      name: 'One',
    }];
    const local = await seed(books, cards);
    const server = batchServer(books, cards);
    let mismatch = true;
    server.transport.handleError('ContactCard/set', () => {
      if (!mismatch) return null;
      mismatch = false;
      server.cards.get('card-1')!.addressBookIds.concurrent = true;
      server.advanceState();
      return { type: 'stateMismatch' };
    });
    const row = await queue({
      operation: 'move',
      contactIds: [local.contactIds.get('card-1')],
      sourceAddressbookId: local.bookIds.get('source'),
      targetAddressbookId: local.bookIds.get('target'),
    });

    await expect(processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({ ok: true });

    expect(setRequests(server.transport)).toHaveLength(2);
    expect(Object.keys(server.cards.get('card-1')!.addressBookIds).sort())
      .toEqual(['concurrent', 'target', 'third']);
    const [cached] = await handlers[DB_RPC.CONTACT_LIST]({ accountId: account.id });
    expect(new Set(cached.addressbook_ids)).toEqual(new Set([
      local.bookIds.get('concurrent'),
      local.bookIds.get('target'),
      local.bookIds.get('third'),
    ]));
  });

  it('checkpoints accepted and terminal cards and retries only unresolved ids', async () => {
    const books = [
      { id: 'source', name: 'Source', writable: true },
      { id: 'target', name: 'Target', writable: true },
    ];
    const cards = [1, 2, 3].map((id) => ({
      id: `card-${id}`,
      addressBookIds: { source: true },
      name: `Card ${id}`,
    }));
    const local = await seed(books, cards);
    const server = batchServer(books, cards);
    let first = true;
    server.transport.handle('ContactCard/set', ({ update }) => {
      const ids = Object.keys(update);
      if (first) {
        first = false;
        applyMembershipPatch(server.cards.get('card-1')!, update['card-1']);
        server.advanceState();
        return {
          updated: { 'card-1': null },
          notUpdated: {
            'card-2': { type: 'forbidden' },
            'card-3': { type: 'serverFail' },
          },
        };
      }
      expect(ids).toEqual(['card-3']);
      applyMembershipPatch(server.cards.get('card-3')!, update['card-3']);
      server.advanceState();
      return { updated: { 'card-3': null } };
    });
    const row = await queue({
      operation: 'move',
      contactIds: cards.map((card) => local.contactIds.get(card.id)),
      sourceAddressbookId: local.bookIds.get('source'),
      targetAddressbookId: local.bookIds.get('target'),
    });

    const firstResult = await processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    });
    expect(firstResult).toMatchObject({
      ok: false,
      error: {
        type: 'serverFail',
        result: {
          succeededContactIds: [local.contactIds.get('card-1')],
          failures: [{
            contactId: local.contactIds.get('card-2'),
            errorType: 'forbidden',
          }],
        },
      },
    });

    const secondResult = await processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    });
    expect(secondResult).toMatchObject({
      ok: true,
      result: {
        succeededContactIds: [
          local.contactIds.get('card-1'),
          local.contactIds.get('card-3'),
        ],
        failures: [{
          contactId: local.contactIds.get('card-2'),
          errorType: 'forbidden',
        }],
      },
    });
    expect(setRequests(server.transport).map((request) =>
      Object.keys(request.update))).toEqual([
      ['card-1', 'card-2', 'card-3'],
      ['card-3'],
    ]);
  });

  it('chunks at the lower get/set server limit and never replays accepted writes', async () => {
    const books = [
      { id: 'source', name: 'Source', writable: true },
      { id: 'target', name: 'Target', writable: true },
    ];
    const cards = [1, 2, 3, 4, 5].map((id) => ({
      id: `card-${id}`,
      addressBookIds: { source: true },
      name: `Card ${id}`,
    }));
    const local = await seed(books, cards);
    const server = batchServer(books, cards, 2);
    server.failRepair = true;
    const row = await queue({
      operation: 'move',
      contactIds: cards.map((card) => local.contactIds.get(card.id)),
      sourceAddressbookId: local.bookIds.get('source'),
      targetAddressbookId: local.bookIds.get('target'),
    });

    await expect(processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({
      ok: false,
      error: { type: 'cacheReconcileFailed' },
    });
    expect(server.setCalls).toBe(3);

    server.failRepair = false;
    await expect(processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({ ok: true });
    expect(server.setCalls).toBe(3);
  });

  it('treats an already-moved card and a missing card as converged', async () => {
    const books = [
      { id: 'source', name: 'Source', writable: true },
      { id: 'target', name: 'Target', writable: true },
      { id: 'third', name: 'Third', writable: true },
    ];
    const localCards = [
      { id: 'card-moved', addressBookIds: { source: true, third: true }, name: 'Moved' },
      { id: 'card-gone', addressBookIds: { source: true }, name: 'Gone' },
    ];
    const local = await seed(books, localCards);
    const server = batchServer(books, [{
      id: 'card-moved',
      addressBookIds: { target: true, third: true },
      name: 'Moved',
    }]);
    const row = await queue({
      operation: 'move',
      contactIds: [
        local.contactIds.get('card-moved'),
        local.contactIds.get('card-gone'),
      ],
      sourceAddressbookId: local.bookIds.get('source'),
      targetAddressbookId: local.bookIds.get('target'),
    });

    const result = await processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    });

    expect(result).toMatchObject({
      ok: true,
      result: {
        updatedContactIds: [local.contactIds.get('card-moved')],
        destroyedContactIds: [local.contactIds.get('card-gone')],
        failures: [],
      },
    });
    expect(setRequests(server.transport)).toEqual([]);
    const cached = await handlers[DB_RPC.CONTACT_LIST]({ accountId: account.id });
    expect(cached.map((contact: any) => contact.remote_id)).toEqual(['card-moved']);
    expect(new Set(cached[0].addressbook_ids)).toEqual(new Set([
      local.bookIds.get('target'),
      local.bookIds.get('third'),
    ]));
  });

  it('fails closed on fresh server rights before issuing ContactCard/set', async () => {
    const localBooks = [
      { id: 'source', name: 'Source', writable: true },
      { id: 'other', name: 'Other', writable: true },
    ];
    const cards = [{
      id: 'card-1',
      addressBookIds: { source: true, other: true },
      name: 'One',
    }];
    const local = await seed(localBooks, cards);
    const server = batchServer([
      localBooks[0],
      { ...localBooks[1], writable: false },
    ], cards);
    const row = await queue({
      operation: 'scoped-delete',
      contactIds: [local.contactIds.get('card-1')],
      sourceAddressbookId: null,
    });

    const result = await processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    });

    expect(result).toMatchObject({
      ok: true,
      result: {
        succeededContactIds: [],
        failures: [{
          contactId: local.contactIds.get('card-1'),
          errorType: 'forbidden',
        }],
      },
    });
    expect(setRequests(server.transport)).toEqual([]);
    expect(server.cards.has('card-1')).toBe(true);
  });
});
