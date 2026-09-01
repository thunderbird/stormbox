import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { ADDRESSBOOK_ERROR } from '../../../src/constants/addressbook-errors';
import { ADDRESSBOOK_PHASE, SERVICE_KIND } from '../../../src/constants/states';
import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import {
  inventoryAddressBook,
  syncAddressBooks,
  syncContacts,
} from '../../../src/sync/backends/jmap/contacts';
import {
  MUTATION_TYPES,
  processMutationRow,
} from '../../../src/sync/backends/jmap/outbox';
import { MockTransport } from './_mock-transport';

let engine: any;
let handlers: any;
let account: any;

beforeEach(async () => {
  engine = await bootTestEngine();
  handlers = makeHandlers(engine);
  account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
    displayName: 'Address Book Test',
    primaryEmail: 'addressbooks@example.com',
    serverOrigin: 'https://mail.example.com',
    remoteAccountId: 'acct-1',
    isPrimary: true,
  })).row;
});

afterEach(async () => {
  await engine.close();
});

function transportSession(
  mayCreateAddressBook: boolean | null = true,
  maxObjectsInGet = 2,
) {
  return {
    capabilities: {
      'urn:ietf:params:jmap:core': {
        maxObjectsInGet,
        maxObjectsInSet: 500,
        maxSizeUpload: 50_000_000,
      },
    },
    accounts: {
      'acct-1': {
        accountCapabilities: {
          'urn:ietf:params:jmap:contacts': mayCreateAddressBook === undefined
            || mayCreateAddressBook === null
            ? {}
            : { mayCreateAddressBook },
        },
      },
    },
  };
}

function makeBook(
  id: string,
  name: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    name,
    description: null,
    sortOrder: 0,
    isDefault: false,
    isSubscribed: true,
    myRights: {
      mayRead: true,
      mayWrite: true,
      mayDelete: true,
    },
    ...overrides,
  };
}

function makeCard(
  id: string,
  addressBookIds: string[],
  overrides: Record<string, unknown> = {},
) {
  return {
    '@type': 'Card',
    id,
    version: '1.0',
    name: { full: id },
    addressBookIds: Object.fromEntries(addressBookIds.map((bookId) => [bookId, true])),
    ...overrides,
  };
}

function addressBookServer({
  books = [makeBook('book-personal', 'Personal', { isDefault: true })],
  cards = [],
  maxObjectsInGet = 2,
}: {
  books?: any[];
  cards?: any[];
  maxObjectsInGet?: number;
} = {}) {
  const transport = new MockTransport(transportSession(true, maxObjectsInGet));
  const state = {
    books: [...books],
    cards: [...cards],
    addressBookState: 1,
    queryState: 'contacts-query-1',
  };
  transport.handle('AddressBook/get', () => ({
    list: state.books,
    state: `addressbooks-${state.addressBookState}`,
  }));
  transport.handle('ContactCard/query', (params) => {
    const filtered = params.filter?.inAddressBook
      ? state.cards.filter(
          (card) => card.addressBookIds?.[params.filter.inAddressBook] === true,
        )
      : state.cards;
    const position = Number(params.position ?? 0);
    const limit = Number(params.limit ?? maxObjectsInGet);
    return {
      ids: filtered.slice(position, position + limit).map((card) => card.id),
      position,
      limit,
      total: filtered.length,
      queryState: state.queryState,
    };
  });
  transport.handle('ContactCard/get', (params) => ({
    list: state.cards.filter((card) => params.ids.includes(card.id)),
  }));
  return { transport, state };
}

async function queueRow(mutationType: string, request: any) {
  const inserted = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
    accountId: account.id,
    mutationType,
    targetMessageId: null,
    requestJson: JSON.stringify(request),
  });
  return reload(inserted.id);
}

function reload(id: number) {
  return handlers[DB_RPC.QUERY]({
    sql: 'SELECT * FROM pending_mutations WHERE id = ?',
    params: [id],
  }).then((rows: any[]) => rows[0]);
}

describe('AddressBook mutations', () => {
  it('fails create closed when the live Session does not grant creation', async () => {
    const transport = new MockTransport(transportSession(null));
    let setCalls = 0;
    transport.handle('AddressBook/set', () => {
      setCalls += 1;
      return { created: { addressbook: { id: 'unexpected' } } };
    });
    const row = await queueRow(MUTATION_TYPES.CREATE_ADDRESSBOOK, {
      operationId: 'create-without-right',
      name: 'Projects',
    });

    await expect(processMutationRow({
      transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({
      ok: false,
      error: {
        type: ADDRESSBOOK_ERROR.PERMISSION_DENIED,
        terminal: true,
      },
    });
    expect(setCalls).toBe(0);
  });

  it('recovers a lost create by exact new-id matching without replay', async () => {
    const server = addressBookServer();
    await handlers[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      snapshot: true,
      addressbooks: [
        {
          remoteId: 'book-personal',
          name: 'Personal',
          isDefault: true,
        },
        {
          remoteId: 'stale-local',
          name: 'Stale',
        },
      ],
    });
    let setCalls = 0;
    let durableCheckpoint: any = null;
    const request = {
      operationId: 'create-recovery',
      name: ' Projects ',
      description: 'Current work',
      sortOrder: 7,
      isSubscribed: false,
      setAsDefault: true,
    };
    const ensured = await handlers[DB_RPC.ADDRESSBOOK_MUTATION_ENSURE]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.CREATE_ADDRESSBOOK,
      operationId: request.operationId,
      requestJson: JSON.stringify(request),
    });
    await expect(handlers[DB_RPC.ADDRESSBOOK_MUTATION_ENSURE]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.CREATE_ADDRESSBOOK,
      operationId: request.operationId,
      requestJson: JSON.stringify(request),
    })).resolves.toMatchObject({
      id: ensured.id,
      reused: true,
    });
    const row = await reload(ensured.id);
    server.transport.handle('AddressBook/set', async (params) => {
      setCalls += 1;
      expect(params.onSuccessSetIsDefault).toBe('#addressbook');
      expect(params.create.addressbook).not.toHaveProperty('isDefault');
      durableCheckpoint = await reload(row.id);
      server.state.books.push(makeBook(
        'book-recovered',
        params.create.addressbook.name,
        {
          description: params.create.addressbook.description,
          sortOrder: params.create.addressbook.sortOrder,
          isSubscribed: params.create.addressbook.isSubscribed,
        },
      ));
      server.state.addressBookState += 1;
      return null;
    });

    await expect(processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({
      ok: true,
      result: {
        ids: ['book-recovered'],
        addressbook: {
          remote_id: 'book-recovered',
          name: 'Projects',
        },
      },
    });

    expect(setCalls).toBe(1);
    expect(durableCheckpoint.phase).toBe(ADDRESSBOOK_PHASE.CREATE_SUBMITTING);
    expect(JSON.parse(durableCheckpoint.server_response_json).addressBook)
      .toMatchObject({
        baselineAddressBooks: [{ id: 'book-personal', name: 'Personal' }],
        requestAddressBook: {
          name: 'Projects',
          description: 'Current work',
          sortOrder: 7,
          isSubscribed: false,
        },
      });
    expect((await handlers[DB_RPC.ADDRESSBOOK_LIST]({ accountId: account.id }))
      .map((book: any) => book.remote_id)
      .sort()).toEqual(['book-personal', 'book-recovered']);
  });

  it('terminals a lost create when exact new-id matching is ambiguous', async () => {
    const server = addressBookServer();
    let setCalls = 0;
    server.transport.handle('AddressBook/set', (params) => {
      setCalls += 1;
      server.state.books.push(
        makeBook('book-match-one', params.create.addressbook.name),
        makeBook('book-match-two', params.create.addressbook.name),
      );
      server.state.addressBookState += 1;
      return null;
    });
    const row = await queueRow(MUTATION_TYPES.CREATE_ADDRESSBOOK, {
      operationId: 'ambiguous-create',
      name: 'Duplicate',
    });

    await expect(processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({
      ok: false,
      error: {
        type: ADDRESSBOOK_ERROR.AMBIGUOUS_CREATE,
        terminal: true,
        detail: {
          reason: 'multipleMatches',
          candidateIds: ['book-match-one', 'book-match-two'],
        },
      },
    });
    expect(setCalls).toBe(1);
    expect((await reload(row.id)).phase)
      .toBe(ADDRESSBOOK_PHASE.CREATE_SUBMITTING);
  });

  it.each([
    ['malformed checkpoint without a phase', null, '{'],
    ['missing create checkpoint', ADDRESSBOOK_PHASE.CREATE_SUBMITTING, null],
    [
      'create checkpoint without its phase',
      null,
      JSON.stringify({
        addressBook: {
          version: 1,
          operation: 'create',
          baselineAddressBooks: [],
          baselineState: 'addressbooks-1',
          requestAddressBook: {
            name: 'Projects',
            description: null,
            sortOrder: 0,
            isSubscribed: true,
          },
        },
      }),
    ],
    [
      'invalid accepted-create checkpoint',
      ADDRESSBOOK_PHASE.CACHE_PENDING,
      JSON.stringify({
        addressBook: {
          version: 1,
          operation: 'create',
          remoteId: 42,
          attempts: 1,
        },
      }),
    ],
  ])('fails closed for %s', async (_label, phase, serverResponseJson) => {
    const server = addressBookServer();
    let setCalls = 0;
    server.transport.handle('AddressBook/set', () => {
      setCalls += 1;
      return { created: { addressbook: { id: 'duplicate-book' } } };
    });
    const row = await queueRow(MUTATION_TYPES.CREATE_ADDRESSBOOK, {
      operationId: 'invalid-checkpoint',
      name: 'Projects',
    });
    await handlers[DB_RPC.QUERY]({
      sql: `UPDATE pending_mutations
               SET phase = ?, server_response_json = ?
             WHERE id = ?`,
      params: [phase, serverResponseJson, row.id],
    });

    await expect(processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row: await reload(row.id),
    })).resolves.toMatchObject({
      ok: false,
      error: {
        type: ADDRESSBOOK_ERROR.AMBIGUOUS_CREATE,
        terminal: true,
        detail: { reason: 'unreadableCheckpoint' },
      },
    });
    expect(setCalls).toBe(0);
  });

  it('sends sparse metadata and default changes without patching isDefault', async () => {
    const server = addressBookServer({
      books: [
        makeBook('book-personal', 'Personal', { isDefault: true }),
        makeBook('book-projects', 'Projects'),
      ],
    });
    await syncAddressBooks({
      transport: server.transport,
      account,
      handlers,
    });
    await handlers[DB_RPC.QUERY]({
      sql: `UPDATE addressbooks SET may_write = 0
             WHERE account_id = ? AND remote_id = 'book-projects'`,
      params: [account.id],
    });
    let wire: any = null;
    server.transport.handle('AddressBook/set', (params) => {
      wire = params;
      server.state.books = server.state.books.map((book) => ({
        ...book,
        isDefault: book.id === 'book-projects',
        ...(book.id === 'book-projects'
          ? params.update['book-projects']
          : {}),
      }));
      server.state.addressBookState += 1;
      return { updated: { 'book-projects': null } };
    });
    const row = await queueRow(MUTATION_TYPES.UPDATE_ADDRESSBOOK, {
      operationId: 'sparse-update',
      remoteId: 'book-projects',
      sortOrder: 42,
      isSubscribed: false,
      setAsDefault: true,
    });

    await expect(processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({ ok: true });

    expect(wire.update).toEqual({
      'book-projects': {
        sortOrder: 42,
        isSubscribed: false,
      },
    });
    expect(wire.update['book-projects']).not.toHaveProperty('isDefault');
    expect(wire.onSuccessSetIsDefault).toBe('book-projects');
    expect(wire.ifInState).toBe('addressbooks-1');
    const cached = (await handlers[DB_RPC.ADDRESSBOOK_LIST]({
      accountId: account.id,
    })).find((book: any) => book.remote_id === 'book-projects');
    expect(cached).toMatchObject({
      sort_order: 42,
      is_subscribed: 0,
      is_default: 1,
    });
  });

  it('classifies a paged inventory and rejects query-state drift', async () => {
    const cards = [
      makeCard('card-exclusive-media', ['book-target'], {
        media: {
          photo: {
            '@type': 'Media',
            kind: 'photo',
            blobId: 'blob-photo',
          },
        },
      }),
      makeCard('card-shared', ['book-target', 'book-other']),
      makeCard('card-exclusive', ['book-target']),
    ];
    const server = addressBookServer({
      books: [
        makeBook('book-target', 'Target'),
        makeBook('book-other', 'Other', { isDefault: true }),
      ],
      cards,
      maxObjectsInGet: 2,
    });
    await syncAddressBooks({
      transport: server.transport,
      account,
      handlers,
    });
    const target = (await handlers[DB_RPC.ADDRESSBOOK_LIST]({
      accountId: account.id,
    })).find((book: any) => book.remote_id === 'book-target');

    await expect(inventoryAddressBook({
      transport: server.transport,
      account,
      handlers,
      addressbookId: target.id,
    })).resolves.toMatchObject({
      total: 3,
      exclusiveCount: 2,
      sharedCount: 1,
      mediaBearingCount: 1,
      contacts: [
        { remoteId: 'card-exclusive', classification: 'exclusive' },
        {
          remoteId: 'card-exclusive-media',
          classification: 'exclusive',
          hasMedia: true,
        },
        { remoteId: 'card-shared', classification: 'shared' },
      ],
    });
    const inventoryQueries = server.transport.requests
      .flatMap((request) => request.methodCalls)
      .filter(([method, params]) =>
        method === 'ContactCard/query' && params.filter?.inAddressBook);
    expect(inventoryQueries.map(([, params]) => params.limit)).toEqual([2, 2, 1]);

    let page = 0;
    server.transport.handle('ContactCard/query', (params) => {
      const ids = cards.map((card) => card.id);
      const position = Number(params.position ?? 0);
      page += 1;
      return {
        ids: ids.slice(position, position + 2),
        position,
        limit: 2,
        total: ids.length,
        queryState: `drift-${page}`,
      };
    });
    await expect(inventoryAddressBook({
      transport: server.transport,
      account,
      handlers,
      addressbookId: target.id,
    })).rejects.toMatchObject({
      type: ADDRESSBOOK_ERROR.STATE_MISMATCH,
    });
  });

  it('requires reconfirmation when a fresh inventory is more destructive', async () => {
    const server = addressBookServer({
      books: [
        makeBook('book-target', 'Target'),
        makeBook('book-other', 'Other', { isDefault: true }),
      ],
      cards: [makeCard('card-one', ['book-target'])],
    });
    await syncAddressBooks({
      transport: server.transport,
      account,
      handlers,
    });
    const target = (await handlers[DB_RPC.ADDRESSBOOK_LIST]({
      accountId: account.id,
    })).find((book: any) => book.remote_id === 'book-target');
    const confirmation = await inventoryAddressBook({
      transport: server.transport,
      account,
      handlers,
      addressbookId: target.id,
    });
    server.state.cards.push(makeCard('card-added', ['book-target']));
    server.state.queryState = 'contacts-query-2';
    let setCalls = 0;
    server.transport.handle('AddressBook/set', () => {
      setCalls += 1;
      return { destroyed: ['book-target'] };
    });
    const row = await queueRow(MUTATION_TYPES.DESTROY_ADDRESSBOOK, {
      operationId: 'delete-escalated',
      addressbookId: target.id,
      confirmationInventory: confirmation,
    });

    await expect(processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({
      ok: false,
      error: {
        type: ADDRESSBOOK_ERROR.CONFIRMATION_STALE,
        terminal: true,
        detail: {
          confirmed: { exclusiveCount: 1 },
          current: { exclusiveCount: 2 },
        },
      },
    });
    expect(setCalls).toBe(0);
  });

  it('verifies absence after response loss and reconciles books and cards', async () => {
    const server = addressBookServer({
      books: [
        makeBook('book-target', 'Target'),
        makeBook('book-other', 'Other', { isDefault: true }),
      ],
      cards: [
        makeCard('card-exclusive', ['book-target']),
        makeCard('card-shared', ['book-target', 'book-other']),
      ],
    });
    await syncAddressBooks({
      transport: server.transport,
      account,
      handlers,
    });
    await syncContacts({
      transport: server.transport,
      account,
      handlers,
    });
    const target = (await handlers[DB_RPC.ADDRESSBOOK_LIST]({
      accountId: account.id,
    })).find((book: any) => book.remote_id === 'book-target');
    const confirmation = await inventoryAddressBook({
      transport: server.transport,
      account,
      handlers,
      addressbookId: target.id,
    });
    let setCalls = 0;
    server.transport.handle('AddressBook/set', (params) => {
      setCalls += 1;
      expect(params.onDestroyRemoveContents).toBe(true);
      server.state.books = server.state.books.filter(
        (book) => book.id !== 'book-target',
      );
      server.state.cards = server.state.cards
        .filter((card) => card.id !== 'card-exclusive')
        .map((card) => ({
          ...card,
          addressBookIds: { 'book-other': true },
        }));
      server.state.addressBookState += 1;
      server.state.queryState = 'contacts-query-after-delete';
      return null;
    });
    const row = await queueRow(MUTATION_TYPES.DESTROY_ADDRESSBOOK, {
      operationId: 'delete-response-loss',
      remoteId: 'book-target',
      confirmationInventory: confirmation,
    });

    await expect(processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({
      ok: false,
      error: { type: ADDRESSBOOK_ERROR.SERVER_UNAVAILABLE },
    });
    expect((await reload(row.id)).phase)
      .toBe(ADDRESSBOOK_PHASE.DESTROY_SUBMITTING);

    await expect(processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({ ok: true });

    expect(setCalls).toBe(1);
    expect((await handlers[DB_RPC.ADDRESSBOOK_LIST]({ accountId: account.id }))
      .map((book: any) => book.remote_id)).toEqual(['book-other']);
    const contacts = await handlers[DB_RPC.CONTACT_LIST]({
      accountId: account.id,
    });
    expect(contacts.map((contact: any) => contact.remote_id))
      .toEqual(['card-shared']);
    expect(contacts[0].addressbook_ids).toHaveLength(1);
  });
});
