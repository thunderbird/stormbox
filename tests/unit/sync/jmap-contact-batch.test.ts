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
import { aggregateContactsTrashDocuments } from '../../../src/constants/contacts-trash-document';
import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import {
  DB_RPC,
  TABLE_FAMILIES,
} from '../../../src/db/protocol';
import { deleteContactCardsWithTrash } from '../../../src/sync/backends/jmap/contacts-trash';
import { processMutationRow } from '../../../src/sync/backends/jmap/outbox';
import { MockTransport } from './_mock-transport';

interface ServerBook {
  id: string;
  name: string;
  writable: boolean;
}

interface ServerCard {
  id: string;
  uid?: string;
  addressBookIds: Record<string, boolean>;
  name: string;
  customUnknown?: Record<string, unknown>;
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
        maxSizeUpload: 50_000_000,
      },
      'urn:ietf:params:jmap:filenode': {},
    },
    accounts: {
      'acct-1': {
        accountCapabilities: {
          'urn:ietf:params:jmap:filenode': {
            mayCreateTopLevelFileNode: true,
          },
        },
      },
    },
  }) as any;
  const cards = new Map(initialCards.map((card) => [
    card.id,
    structuredClone(card),
  ]));
  let state = 1;
  let setCalls = 0;
  let failRepairAfterSetCalls = Number.POSITIVE_INFINITY;
  let loseNextSetResponse = false;
  let loseNextFileSetResponse = false;
  let fileState = 1;
  const fileNodes = new Map<string, any>();
  const blobs = new Map<string, string>();

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
          ...structuredClone(card),
          id: card.id,
          uid: card.uid ?? `uid-${card.id}`,
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
    if (loseNextSetResponse) {
      loseNextSetResponse = false;
      throw new Error('response lost after ContactCard/set');
    }
    return {
      oldState: `cards-${state - 1}`,
      newState: `cards-${state}`,
      updated,
      destroyed,
    };
  });
  transport.download = async ({ blobId }: any) =>
    new TextEncoder().encode(blobs.get(blobId)!);
  transport.handleUpload(({ body }: any) => {
    const blobId = `trash-blob-${blobs.size + 1}`;
    blobs.set(blobId, body);
    return { accountId: 'acct-1', blobId, type: 'application/json', size: body.length };
  });
  transport.handle('FileNode/query', ({ filter }: any) => {
    const nodes = [...fileNodes.values()].filter((node) =>
      typeof filter?.name === 'string' ? node.name === filter.name : true);
    return {
      accountId: 'acct-1',
      queryState: `file-query-${fileState}`,
      ids: nodes.map((node) => node.id),
      total: nodes.length,
    };
  });
  transport.handle('FileNode/get', ({ ids }: any) => ({
    accountId: 'acct-1',
    state: `file-state-${fileState}`,
    list: (ids ?? [...fileNodes.keys()]).flatMap((id: string) => {
      const node = fileNodes.get(id);
      return node ? [node] : [];
    }),
    notFound: [],
  }));
  transport.handle('FileNode/set', ({ create, update }: any) => {
    const response: any = {
      accountId: 'acct-1',
      oldState: `file-state-${fileState}`,
      newState: `file-state-${fileState + 1}`,
    };
    if (create) {
      response.created = {};
      for (const [key, value] of Object.entries<Record<string, unknown>>(create)) {
        const node = {
          id: `trash-node-${fileNodes.size + 1}`,
          ...value,
          myRights: {
            mayRead: true,
            mayWrite: true,
            mayModifyContent: true,
          },
        };
        fileNodes.set(node.id, node);
        response.created[key] = { id: node.id };
      }
    }
    if (update) {
      response.updated = {};
      for (const [id, patch] of Object.entries<Record<string, unknown>>(update)) {
        const node = fileNodes.get(id);
        if (!node) continue;
        fileNodes.set(id, { ...node, ...patch });
        response.updated[id] = null;
      }
    }
    fileState += 1;
    if (loseNextFileSetResponse) {
      loseNextFileSetResponse = false;
      throw new Error('FileNode response lost after write');
    }
    return response;
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
    loseNextSetResponse() {
      loseNextSetResponse = true;
    },
    loseNextFileSetResponse() {
      loseNextFileSetResponse = true;
    },
    advanceState() {
      state += 1;
    },
    get trashDocument() {
      const documents = [...fileNodes.values()]
        .filter((node) => typeof node.blobId === 'string' && blobs.has(node.blobId))
        .map((node) => JSON.parse(blobs.get(node.blobId)!));
      return documents.length > 0 ? aggregateContactsTrashDocuments(documents) : null;
    },
    get trashShardDocument() {
      const node = [...fileNodes.values()].find((candidate) =>
        typeof candidate.blobId === 'string' && blobs.has(candidate.blobId));
      return node ? JSON.parse(blobs.get(node.blobId)!) : null;
    },
    get trashFileName() {
      return [...fileNodes.values()].find((candidate) =>
        typeof candidate.blobId === 'string' && blobs.has(candidate.blobId))?.name ?? null;
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

function fileSetRequests(transport: MockTransport): any[] {
  return transport.requests.flatMap((request) =>
    request.methodCalls.flatMap(([name, params]) =>
      name === 'FileNode/set'
        && (
          params.create?.document
          || Object.values<any>(params.update ?? {}).some((patch) => patch.blobId)
        )
        ? [params]
        : []));
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
    const [wireRequest] = setRequests(server.transport);
    expect(wireRequest.update['card-1']).toEqual({
      'addressBookIds/source': null,
      'addressBookIds/target': true,
    });
    expect(wireRequest).not.toHaveProperty('destroy');
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
      {
        id: 'card-final',
        addressBookIds: { source: true },
        name: 'Final',
        customUnknown: { stable: true },
      },
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
    const [request] = setRequests(server.transport);
    expect(request.destroy).toEqual(['card-final']);
    expect(request.update).toEqual({
      'card-shared': { 'addressBookIds/source': null },
    });
    expect(request.ifInState).toMatch(/^cards-/);
    expect(server.cards.has('card-final')).toBe(false);
    expect(server.trashShardDocument).toMatchObject({
      owner: 'stormbox',
      documentType: 'contacts-trash',
      version: 2,
    });
    expect(server.trashFileName)
      .toMatch(/^stormbox-contacts-trash-[0-9a-f-]{36}\.json$/i);
    expect(server.trashDocument.entries['uid-card-final']).toMatchObject({
      uid: 'uid-card-final',
      remoteId: 'card-final',
      addressBookIds: ['source'],
      status: 'trashed',
      snapshot: {
        id: 'card-final',
        customUnknown: { stable: true },
      },
    });
    const requestOrder = server.transport.requests.flatMap((request: any) =>
      request.methodCalls.map(([name]: [string]) => name));
    expect(requestOrder.indexOf('FileNode/set'))
      .toBeLessThan(requestOrder.indexOf('ContactCard/set'));
    const cached = await handlers[DB_RPC.CONTACT_LIST]({ accountId: account.id });
    expect(cached.map((contact: any) => contact.remote_id)).toEqual(['card-shared']);
    expect(cached[0].addressbook_ids).toEqual([local.bookIds.get('third')]);
    expect(broadcaster.touch.mock.calls.filter(
      ([family]) => family === TABLE_FAMILIES.CONTACTS,
    )).toHaveLength(1);
  });

  it('checkpoints 128 ordinary deletes in one shard and one ContactCard set', async () => {
    const books = [{ id: 'source', name: 'Source', writable: true }];
    const cards = Array.from({ length: 128 }, (_, index) => ({
      id: `card-${index}`,
      uid: `uid-card-${index}`,
      addressBookIds: { source: true },
      name: `Card ${index}`,
    }));
    const local = await seed(books, cards);
    const server = batchServer(books, cards);

    const result = await deleteContactCardsWithTrash({
      transport: server.transport,
      account,
      handlers,
      targets: cards.map((card) => ({
        contactId: local.contactIds.get(card.id),
        remoteId: card.id,
      })),
      sourceAddressBookRemoteId: 'source',
    });

    expect(result).toMatchObject({
      complete: true,
      result: { failures: [] },
    });
    expect(result.result.destroyedContactIds).toHaveLength(128);
    expect(fileSetRequests(server.transport)).toHaveLength(1);
    expect(setRequests(server.transport)).toHaveLength(1);
    expect(setRequests(server.transport)[0].destroy).toHaveLength(128);
    expect(Object.keys(server.trashShardDocument.entries)).toHaveLength(128);
  });

  it('does not destroy cards whose target group contains a duplicate UID', async () => {
    const books = [{ id: 'source', name: 'Source', writable: true }];
    const cards = ['a', 'b'].map((suffix) => ({
      id: `duplicate-${suffix}`,
      uid: 'shared-uid',
      addressBookIds: { source: true },
      name: `Duplicate ${suffix}`,
    }));
    const local = await seed(books, cards);
    const server = batchServer(books, cards);

    const result = await deleteContactCardsWithTrash({
      transport: server.transport,
      account,
      handlers,
      targets: cards.map((card) => ({
        contactId: local.contactIds.get(card.id),
        remoteId: card.id,
      })),
      sourceAddressBookRemoteId: 'source',
    });

    expect(result.result.failures).toEqual(cards.map((card) => ({
      contactId: local.contactIds.get(card.id),
      errorType: 'ambiguousUid',
    })));
    expect([...server.cards.keys()].sort()).toEqual(['duplicate-a', 'duplicate-b']);
    expect(fileSetRequests(server.transport)).toHaveLength(0);
    expect(setRequests(server.transport)).toHaveLength(0);
  });

  it('preserves an active UID owner and keeps a conflicting live card', async () => {
    const books = [{ id: 'source', name: 'Source', writable: true }];
    const cards = [{
      id: 'new-card',
      uid: 'owned-uid',
      addressBookIds: { source: true },
      name: 'New Card',
    }];
    const local = await seed(books, cards);
    await handlers[DB_RPC.CONTACT_TRASH_PUT_ENTRIES]({
      accountId: account.id,
      entries: [{
        uid: 'owned-uid',
        remoteId: 'old-card',
        addressBookIds: ['source'],
        trashedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        status: 'trashed',
        updatedAt: Date.now(),
        emailKeys: ['old@example.com'],
        displayName: 'Old Card',
        primaryEmail: 'old@example.com',
        snapshot: {
          id: 'old-card',
          uid: 'owned-uid',
          addressBookIds: { source: true },
        },
        media: [],
      }],
    });
    const server = batchServer(books, cards);

    const result = await deleteContactCardsWithTrash({
      transport: server.transport,
      account,
      handlers,
      targets: [{
        contactId: local.contactIds.get('new-card'),
        remoteId: 'new-card',
      }],
      sourceAddressBookRemoteId: 'source',
    });

    expect(result.result.failures).toEqual([{
      contactId: local.contactIds.get('new-card'),
      errorType: 'ambiguousUid',
    }]);
    expect(server.cards.has('new-card')).toBe(true);
    expect((await handlers[DB_RPC.CONTACT_TRASH_GET_DOCUMENT]({
      accountId: account.id,
    })).doc.entries['owned-uid'].remoteId).toBe('old-card');
    expect(setRequests(server.transport)).toHaveLength(0);
  });

  it('splits oversized groups into bounded multi-contact shard checkpoints', async () => {
    const books = [{ id: 'source', name: 'Source', writable: true }];
    const cards = Array.from({ length: 8 }, (_, index) => ({
      id: `large-card-${index}`,
      uid: `uid-large-card-${index}`,
      addressBookIds: { source: true },
      name: `Large Card ${index}`,
      customUnknown: { payload: 'x'.repeat(700) },
    }));
    const local = await seed(books, cards);
    const server = batchServer(books, cards);

    const result = await deleteContactCardsWithTrash({
      transport: server.transport,
      account,
      handlers,
      targets: cards.map((card) => ({
        contactId: local.contactIds.get(card.id),
        remoteId: card.id,
      })),
      sourceAddressBookRemoteId: 'source',
      maxTrashShardBytes: 5_000,
    });

    expect(result).toMatchObject({
      complete: true,
      result: { failures: [] },
    });
    expect(result.result.destroyedContactIds).toHaveLength(8);
    expect(fileSetRequests(server.transport).length).toBeGreaterThan(1);
    expect(fileSetRequests(server.transport).length).toBeLessThan(8);
    expect(setRequests(server.transport)).toHaveLength(fileSetRequests(server.transport).length);
    expect(setRequests(server.transport).every((request) => request.destroy.length > 1)).toBe(true);
  });

  it('never destroys a whole card when the remote trash write is rejected', async () => {
    const books = [{ id: 'source', name: 'Source', writable: true }];
    const cards = [{
      id: 'card-1',
      uid: 'uid-card-1',
      addressBookIds: { source: true },
      name: 'One',
    }];
    const local = await seed(books, cards);
    const server = batchServer(books, cards);
    server.transport.handleError('FileNode/set', { type: 'forbidden' });
    const row = await queue({
      operation: 'scoped-delete',
      contactIds: [local.contactIds.get('card-1')],
      sourceAddressbookId: local.bookIds.get('source'),
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
        destroyedContactIds: [],
        failures: [{ contactId: local.contactIds.get('card-1'), errorType: 'forbidden' }],
      },
    });
    expect(server.cards.has('card-1')).toBe(true);
    expect(setRequests(server.transport)).toHaveLength(0);
    expect(await handlers[DB_RPC.CONTACT_TRASH_LIST]({
      accountId: account.id,
    })).toEqual([]);
    expect(await handlers[DB_RPC.QUERY]({
      sql: 'SELECT COUNT(*) AS count FROM contacts_trash_emails WHERE account_id = ?',
      params: [account.id],
    })).toEqual([{ count: 0 }]);
    expect(await handlers[DB_RPC.CONTACT_AUTOCOMPLETE]({
      accountId: account.id,
      prefix: 'card-1@example.com',
      limit: 10,
      exclude: [],
    })).toEqual([
      expect.objectContaining({ email: 'card-1@example.com' }),
    ]);
  });

  it.each(['notFound', 'invalidProperties'])(
    'rolls back a staged snapshot after final FileNode %s',
    async (errorType) => {
      const books = [{ id: 'source', name: 'Source', writable: true }];
      const cards = [{
        id: 'card-1',
        uid: 'uid-card-1',
        addressBookIds: { source: true },
        name: 'One',
      }];
      const local = await seed(books, cards);
      const server = batchServer(books, cards);
      server.transport.handleError('FileNode/set', { type: errorType });
      const row = await queue({
        operation: 'scoped-delete',
        contactIds: [local.contactIds.get('card-1')],
        sourceAddressbookId: local.bookIds.get('source'),
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
          destroyedContactIds: [],
          failures: [{
            contactId: local.contactIds.get('card-1'),
            errorType,
          }],
        },
      });
      expect(server.cards.has('card-1')).toBe(true);
      expect(setRequests(server.transport)).toHaveLength(0);
      expect(await handlers[DB_RPC.CONTACT_TRASH_LIST]({
        accountId: account.id,
      })).toEqual([]);
    },
  );

  it('retains a staged snapshot after an ambiguous FileNode transport failure', async () => {
    const books = [{ id: 'source', name: 'Source', writable: true }];
    const cards = [{
      id: 'card-1',
      uid: 'uid-card-1',
      addressBookIds: { source: true },
      name: 'One',
    }];
    const local = await seed(books, cards);
    const server = batchServer(books, cards);
    server.transport.handle('FileNode/set', () => {
      throw new Error('FileNode response lost');
    });
    const row = await queue({
      operation: 'scoped-delete',
      contactIds: [local.contactIds.get('card-1')],
      sourceAddressbookId: local.bookIds.get('source'),
    });

    const result = await processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { type: 'transport' },
    });
    expect(server.cards.has('card-1')).toBe(true);
    expect(await handlers[DB_RPC.CONTACT_TRASH_LIST]({
      accountId: account.id,
    })).toEqual([
      expect.objectContaining({ uid: 'uid-card-1' }),
    ]);
    expect(await handlers[DB_RPC.QUERY]({
      sql: `SELECT id, mutation_type
              FROM pending_mutations
             WHERE account_id = ?
             ORDER BY id`,
      params: [account.id],
    })).toEqual([{
      id: row.id,
      mutation_type: MUTATION_TYPE.CONTACT_BATCH,
    }]);
  });

  it('reuses and confirms a dirty staged shard after a lost FileNode response', async () => {
    const books = [{ id: 'source', name: 'Source', writable: true }];
    const cards = [{
      id: 'card-1',
      uid: 'uid-card-1',
      addressBookIds: { source: true },
      name: 'One',
    }];
    const local = await seed(books, cards);
    const server = batchServer(books, cards);
    server.loseNextFileSetResponse();
    const row = await queue({
      operation: 'scoped-delete',
      contactIds: [local.contactIds.get('card-1')],
      sourceAddressbookId: local.bookIds.get('source'),
    });

    await expect(processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({
      ok: false,
      error: { type: 'transport' },
    });
    expect(server.cards.has('card-1')).toBe(true);

    await expect(processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({
      ok: true,
      result: {
        destroyedContactIds: [local.contactIds.get('card-1')],
        failures: [],
      },
    });
    expect(server.cards.has('card-1')).toBe(false);
  });

  it('recovers a lost destroy response from the snapshot and missing card', async () => {
    const books = [{ id: 'source', name: 'Source', writable: true }];
    const cards = [{ id: 'card-1', addressBookIds: { source: true }, name: 'One' }];
    const local = await seed(books, cards);
    const server = batchServer(books, cards);
    server.loseNextSetResponse();
    const row = await queue({
      operation: 'scoped-delete',
      contactIds: [local.contactIds.get('card-1')],
      sourceAddressbookId: local.bookIds.get('source'),
    });

    await expect(processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({
      ok: false,
      error: {
        type: 'transport',
        message: 'response lost after ContactCard/set',
      },
    });
    expect(server.cards.has('card-1')).toBe(false);

    const recovered = await processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    });
    expect(recovered).toMatchObject({
      ok: true,
      result: {
        destroyedContactIds: [local.contactIds.get('card-1')],
        failures: [],
      },
    });
    expect(server.trashDocument.entries['uid-card-1'].status).toBe('trashed');
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

  it('tombstones all staged snapshots whose destroy is terminally rejected', async () => {
    const books = [{ id: 'source', name: 'Source', writable: true }];
    const cards = [1, 2].map((id) => ({
      id: `card-${id}`,
      uid: `uid-card-${id}`,
      addressBookIds: { source: true },
      name: `Card ${id}`,
    }));
    const local = await seed(books, cards);
    const server = batchServer(books, cards);
    server.transport.handle('ContactCard/set', ({ destroy }) => ({
      notDestroyed: Object.fromEntries(destroy.map((id: string) => [
        id,
        { type: id === 'card-1' ? 'forbidden' : 'invalidProperties' },
      ])),
    }));
    const listTrash = vi.fn(handlers[DB_RPC.CONTACT_TRASH_LIST]);
    const trackingHandlers = {
      ...handlers,
      [DB_RPC.CONTACT_TRASH_LIST]: listTrash,
    };
    const row = await queue({
      operation: 'scoped-delete',
      contactIds: cards.map((card) => local.contactIds.get(card.id)),
      sourceAddressbookId: local.bookIds.get('source'),
    });

    const result = await processMutationRow({
      transport: server.transport,
      account,
      handlers: trackingHandlers,
      row,
    });

    expect(result).toMatchObject({
      ok: true,
      result: {
        destroyedContactIds: [],
        failures: [
          {
            contactId: local.contactIds.get('card-1'),
            errorType: 'forbidden',
          },
          {
            contactId: local.contactIds.get('card-2'),
            errorType: 'invalidProperties',
          },
        ],
      },
    });
    expect([...server.cards.keys()].sort()).toEqual(['card-1', 'card-2']);
    expect(listTrash).toHaveBeenCalledTimes(2);
    expect(await handlers[DB_RPC.CONTACT_TRASH_LIST]({
      accountId: account.id,
    })).toEqual([]);
    expect(server.trashDocument.entries['uid-card-1'].status).toBe('purged');
    expect(server.trashDocument.entries['uid-card-2'].status).toBe('purged');
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
