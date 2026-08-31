import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  CONTACTS_TRASH_MAX_DOCUMENT_BYTES,
  CONTACTS_TRASH_MAX_MEDIA_BYTES,
  aggregateContactsTrashDocuments,
  contactTrashEntryFitsInShard,
  emptyContactsTrashDocument,
  emptyContactsTrashShardDocument,
  mergeContactsTrashDocuments,
  type ContactTrashDocumentEntry,
} from '../../../src/constants/contacts-trash-document';
import { SERVICE_KIND } from '../../../src/constants/states';
import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import {
  CONTACTS_TRASH_FILE_NODE_FOLDER,
  THUNDERMAIL_FILE_NODE_FOLDER,
} from '../../../src/sync/backends/jmap/file-node';
import {
  CONTACTS_TRASH_FILE_NAME,
  contactsTrashSnapshotWriteMaxBytes,
  deleteContactCardsWithTrash,
  pushContactsTrash,
  restoreContactTrash,
  syncContactsTrashFromServer,
} from '../../../src/sync/backends/jmap/contacts-trash';
import { JMAP_CAPS } from '../../../src/sync/backends/jmap/transport';
import {
  createContactUidFromSeed,
  isContactUid,
} from '../../../src/utils/contact-uid';
import { MockTransport } from './_mock-transport';

const THUNDERMAIL_FOLDER_ID = 'thundermail-folder';
const CONTACTS_TRASH_FOLDER_ID = 'contacts-trash-folder';

function fileNodeFolders() {
  return [
    {
      id: THUNDERMAIL_FOLDER_ID,
      name: THUNDERMAIL_FILE_NODE_FOLDER,
      parentId: null,
      blobId: null,
      type: null,
      myRights: { mayRead: true, mayWrite: true },
    },
    {
      id: CONTACTS_TRASH_FOLDER_ID,
      name: CONTACTS_TRASH_FILE_NODE_FOLDER,
      parentId: THUNDERMAIL_FOLDER_ID,
      blobId: null,
      type: null,
      myRights: { mayRead: true, mayWrite: true },
    },
  ];
}

function fileNodeQuery(nodes: any[], {
  filter,
  position = 0,
  limit = 500,
}: any) {
  const matches = nodes.filter((node) => {
    if (typeof filter?.name === 'string') return node.name === filter.name;
    if (typeof filter?.nameMatch === 'string') {
      const pattern = filter.nameMatch.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replaceAll('*', '.*');
      return new RegExp(`^${pattern}$`).test(node.name);
    }
    return true;
  });
  return {
    ids: matches.slice(position, position + limit).map((node) => node.id),
    total: matches.length,
    queryState: 'files-query-1',
  };
}

function entry(overrides: Partial<ContactTrashDocumentEntry> = {}): ContactTrashDocumentEntry {
  return {
    uid: 'uid-1',
    remoteId: 'old-card',
    addressBookIds: ['old-book'],
    trashedAt: 1_000,
    expiresAt: 2_000,
    status: 'trashed',
    updatedAt: 1_000,
    emailKeys: ['person@example.com'],
    displayName: 'Person',
    primaryEmail: 'person@example.com',
    media: [],
    snapshot: {
      id: 'old-card',
      uid: 'uid-1',
      addressBookIds: { 'old-book': true },
      emails: {
        stableEmailKey: {
          '@type': 'EmailAddress',
          address: 'person@example.com',
          customUnknown: true,
        },
      },
      customUnknown: { retained: true },
    },
    ...overrides,
  };
}

function entryWithUid(uid: string): ContactTrashDocumentEntry {
  const value = entry();
  const remoteId = `${uid}-card`;
  return {
    ...value,
    uid,
    remoteId,
    snapshot: {
      ...value.snapshot!,
      id: remoteId,
      uid,
    },
  };
}

describe('contacts trash document merge', () => {
  it('lets an equal-time terminal tombstone beat a stale active snapshot', () => {
    const local = emptyContactsTrashDocument();
    local.entries['uid-1'] = entry();
    const remote = emptyContactsTrashDocument();
    remote.entries['uid-1'] = entry({ status: 'restored', snapshot: null });

    const merged = mergeContactsTrashDocuments(local, remote, 2_000);

    expect(merged.document.entries['uid-1']).toMatchObject({
      status: 'restored',
      snapshot: null,
    });
    expect(merged.localNewer).toBe(false);
  });

  it('retains old tombstones so an older shard cannot resurrect an entry', () => {
    const local = emptyContactsTrashDocument();
    local.entries['uid-1'] = entry({
      status: 'purged',
      snapshot: null,
      updatedAt: 10_000,
    });

    expect(mergeContactsTrashDocuments(
      local,
      emptyContactsTrashDocument(),
      Number.MAX_SAFE_INTEGER,
    ).document.entries['uid-1']).toBeDefined();
  });
});

describe('contacts trash FileNode sync', () => {
  it('discovers and merges lifecycle records from multiple shards', async () => {
    const engine = await bootTestEngine();
    try {
      const handlers = makeHandlers(engine);
      const account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
        displayName: 'Shard User',
        primaryEmail: 'shards@example.com',
        serverOrigin: 'https://mail.example.com',
        remoteAccountId: 'shard-account',
        isPrimary: true,
      })).row;
      const active = emptyContactsTrashShardDocument();
      active.entries.active = entry({
        expiresAt: Date.now() + 60_000,
        updatedAt: 10_000,
      });
      const terminal = emptyContactsTrashShardDocument();
      terminal.entries.terminal = entry({
        status: 'restored',
        snapshot: null,
        updatedAt: 20_000,
      });
      const names = [
        'stormbox-contacts-trash-00000000-0000-4000-8000-000000000001.json',
        'stormbox-contacts-trash-00000000-0000-4000-8000-000000000002.json',
      ];
      const shardNodes = names.map((name, index) => ({
        id: `node-${index}`,
        name,
        parentId: null,
        nodeType: 'file',
        blobId: `blob-${index}`,
        type: 'application/json',
        myRights: { mayRead: true, mayModifyContent: true },
      }));
      const nodes = [...fileNodeFolders(), ...shardNodes];
      const documents = new Map([
        ['blob-0', active],
        ['blob-1', terminal],
      ]);
      const transport = new MockTransport({
        capabilities: {
          [JMAP_CAPS.CORE]: {
            maxObjectsInGet: 2,
            maxObjectsInSet: 2,
            maxSizeUpload: 50_000_000,
          },
          [JMAP_CAPS.FILENODE]: {},
        },
        accounts: {
          'shard-account': {
            accountCapabilities: { [JMAP_CAPS.FILENODE]: {} },
          },
        },
      }) as any;
      let fileState = 1;
      transport.download = vi.fn(async ({ blobId }: any) =>
        new TextEncoder().encode(JSON.stringify(documents.get(blobId))));
      transport.handle('FileNode/query', (args) => ({
        ...fileNodeQuery(nodes, args),
        queryState: `files-query-${fileState}`,
      }));
      transport.handle('FileNode/get', ({ ids }) => ({
        list: nodes.filter((node) => ids.includes(node.id)),
        notFound: [],
        state: `files-${fileState}`,
      }));
      transport.handle('FileNode/set', ({ update }) => {
        const updated: Record<string, null> = {};
        for (const [id, patch] of Object.entries<any>(update ?? {})) {
          const node = nodes.find((candidate) => candidate.id === id);
          if (!node) continue;
          Object.assign(node, patch);
          updated[id] = null;
        }
        fileState += 1;
        return {
          oldState: `files-${fileState - 1}`,
          newState: `files-${fileState}`,
          updated,
        };
      });

      const result = await syncContactsTrashFromServer({
        transport,
        account,
        handlers,
      });

      expect(result).toMatchObject({
        ok: true,
        pulled: true,
        document: {
          entries: {
            'uid-1': { status: 'restored', snapshot: null },
          },
        },
      });
      expect(await handlers[DB_RPC.CONTACT_TRASH_LIST]({ accountId: account.id }))
        .toEqual([]);
      expect(transport.download).toHaveBeenCalledTimes(2);
      expect(shardNodes.every((node) =>
        node.parentId === null)).toBe(true);
      expect(result).toMatchObject({ repairQueued: true });
      expect(transport.requests.flatMap((request) => request.methodCalls)
        .some(([name]) => name === 'FileNode/set')).toBe(false);

      await expect(pushContactsTrash({
        transport,
        account,
        handlers,
      })).resolves.toMatchObject({ ok: true });
      expect(shardNodes.every((node) =>
        node.parentId === CONTACTS_TRASH_FOLDER_ID)).toBe(true);
      expect(transport.download).toHaveBeenCalledTimes(4);

      await syncContactsTrashFromServer({ transport, account, handlers });
      expect(transport.download).toHaveBeenCalledTimes(4);

      shardNodes[1].blobId = 'blob-1-changed';
      documents.set('blob-1-changed', terminal);
      await syncContactsTrashFromServer({ transport, account, handlers });
      expect(transport.download).toHaveBeenCalledTimes(5);
      expect(transport.download).toHaveBeenLastCalledWith(expect.objectContaining({
        blobId: 'blob-1-changed',
      }));
    } finally {
      await engine.close();
    }
  });

  it('merges duplicate shard locations before removing the root copy', async () => {
    const engine = await bootTestEngine();
    try {
      const handlers = makeHandlers(engine);
      const account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
        displayName: 'Duplicate Shard User',
        primaryEmail: 'duplicate-shard@example.com',
        serverOrigin: 'https://mail.example.com',
        remoteAccountId: 'duplicate-shard-account',
        isPrimary: true,
      })).row;
      const fileName =
        'stormbox-contacts-trash-00000000-0000-4000-8000-000000000001.json';
      const rootDocument = emptyContactsTrashShardDocument();
      rootDocument.entries.root = entryWithUid('uid-root');
      const currentDocument = emptyContactsTrashShardDocument();
      currentDocument.entries.current = entryWithUid('uid-current');
      const blobs = new Map([
        ['root-blob', JSON.stringify(rootDocument)],
        ['current-blob', JSON.stringify(currentDocument)],
      ]);
      const nodes = [
        ...fileNodeFolders(),
        {
          id: 'root-shard',
          name: fileName,
          parentId: null,
          blobId: 'root-blob',
          type: 'application/json',
          myRights: { mayRead: true, mayWrite: true },
        },
        {
          id: 'current-shard',
          name: fileName,
          parentId: CONTACTS_TRASH_FOLDER_ID,
          blobId: 'current-blob',
          type: 'application/json',
          myRights: { mayRead: true, mayWrite: true },
        },
      ];
      let state = 1;
      const transport = new MockTransport({
        capabilities: {
          [JMAP_CAPS.CORE]: {
            maxObjectsInGet: 500,
            maxObjectsInSet: 500,
            maxSizeUpload: 50_000_000,
          },
          [JMAP_CAPS.FILENODE]: {},
        },
        accounts: {
          [account.remote_account_id]: {
            accountCapabilities: { [JMAP_CAPS.FILENODE]: {} },
          },
        },
      }) as any;
      transport.download = async ({ blobId }: any) =>
        new TextEncoder().encode(blobs.get(blobId)!);
      transport.handleUpload(({ body }: any) => {
        const blobId = `merged-${blobs.size}`;
        blobs.set(blobId, body);
        return { blobId, type: 'application/json', size: body.length };
      });
      transport.handle('FileNode/query', (args) => ({
        ...fileNodeQuery(nodes, args),
        queryState: `query-${state}`,
      }));
      transport.handle('FileNode/get', ({ ids }) => ({
        state: `state-${state}`,
        list: (ids ?? nodes.map((node) => node.id))
          .flatMap((id: string) => nodes.filter((node) => node.id === id)),
        notFound: [],
      }));
      transport.handle('FileNode/set', ({ update = {}, destroy = [] }) => {
        const updated: Record<string, null> = {};
        for (const [id, patch] of Object.entries<any>(update)) {
          const node = nodes.find((candidate) => candidate.id === id);
          if (!node) continue;
          Object.assign(node, patch);
          updated[id] = null;
        }
        for (const id of destroy) {
          const index = nodes.findIndex((node) => node.id === id);
          if (index >= 0) nodes.splice(index, 1);
        }
        state += 1;
        return {
          oldState: `state-${state - 1}`,
          newState: `state-${state}`,
          updated,
          destroyed: destroy,
        };
      });

      await expect(pushContactsTrash({
        transport,
        account,
        handlers,
      })).resolves.toMatchObject({ ok: true });

      const shards = nodes.filter((node) => node.name === fileName);
      expect(shards).toHaveLength(1);
      expect(shards[0]).toMatchObject({
        id: 'current-shard',
        parentId: CONTACTS_TRASH_FOLDER_ID,
      });
      expect(JSON.parse(blobs.get(shards[0].blobId)!).entries).toMatchObject({
        root: { uid: 'uid-root' },
        current: { uid: 'uid-current' },
      });
    } finally {
      await engine.close();
    }
  });

  it('queries the dedicated document independently of settings', async () => {
    const engine = await bootTestEngine();
    try {
      const handlers = makeHandlers(engine);
      const account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
        displayName: 'Sync User',
        primaryEmail: 'sync@example.com',
        serverOrigin: 'https://mail.example.com',
        remoteAccountId: 'sync-account',
        isPrimary: true,
      })).row;
      const transport = new MockTransport({
        capabilities: {
          [JMAP_CAPS.CORE]: {
            maxObjectsInGet: 500,
            maxObjectsInSet: 500,
            maxSizeUpload: 50_000_000,
          },
          [JMAP_CAPS.FILENODE]: {},
        },
        accounts: {
          'sync-account': {
            accountCapabilities: { [JMAP_CAPS.FILENODE]: {} },
          },
        },
      });
      const nodes = fileNodeFolders();
      transport.handle('FileNode/query', (args) => fileNodeQuery(nodes, args));
      transport.handle('FileNode/get', ({ ids }) => ({
        list: nodes.filter((node) => ids.includes(node.id)),
        notFound: [],
        state: 'files-1',
      }));

      await expect(syncContactsTrashFromServer({
        transport,
        account,
        handlers,
      })).resolves.toMatchObject({ ok: true, pulled: false });
      const query = transport.requests
        .flatMap((request) => request.methodCalls)
        .find((call) => call[0] === 'FileNode/query'
          && call[1]?.filter?.nameMatch);
      expect(query?.[1]?.filter).toEqual({
        nameMatch: 'stormbox-contacts-trash*.json',
      });
    } finally {
      await engine.close();
    }
  });

  it.each([
    ['active', {
      ...entry({ uid: 'bad-active', remoteId: 'bad-active-card' }),
      media: undefined,
    }],
    ['tombstone', {
      ...entry({
        uid: 'bad-tombstone',
        remoteId: 'bad-tombstone-card',
        status: 'purged',
      }),
      snapshot: { shouldNotSurvive: true },
      media: [],
    }],
  ])('rejects a malformed remote %s entry without changing either document', async (
    _kind,
    malformed,
  ) => {
    const engine = await bootTestEngine();
    try {
      const handlers = makeHandlers(engine);
      const account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
        displayName: 'Sync User',
        primaryEmail: 'sync@example.com',
        serverOrigin: 'https://mail.example.com',
        remoteAccountId: 'sync-account',
        isPrimary: true,
      })).row;
      await handlers[DB_RPC.CONTACT_TRASH_PUT_ENTRIES]({
        accountId: account.id,
        entries: [entry({ uid: 'local-only' })],
      });
      const before = await handlers[DB_RPC.CONTACT_TRASH_GET_DOCUMENT]({
        accountId: account.id,
      });
      const remote = emptyContactsTrashDocument() as any;
      remote.entries[malformed.uid] = malformed;
      const transport = new MockTransport({
        capabilities: {
          [JMAP_CAPS.CORE]: {
            maxObjectsInGet: 500,
            maxObjectsInSet: 500,
            maxSizeUpload: 50_000_000,
          },
          [JMAP_CAPS.FILENODE]: {},
        },
        accounts: {
          'sync-account': {
            accountCapabilities: { [JMAP_CAPS.FILENODE]: {} },
          },
        },
      }) as any;
      transport.download = async () =>
        new TextEncoder().encode(JSON.stringify(remote));
      const nodes = [
        ...fileNodeFolders(),
        {
          id: 'trash-node',
          name: CONTACTS_TRASH_FILE_NAME,
          parentId: null,
          nodeType: 'file',
          blobId: 'trash-blob',
          type: 'application/json',
          myRights: { mayRead: true, mayModifyContent: true },
        },
      ];
      transport.handle('FileNode/query', (args) => fileNodeQuery(nodes, args));
      transport.handle('FileNode/get', ({ ids }) => ({
        list: nodes.filter((node) => ids.includes(node.id)),
        notFound: [],
        state: 'files-1',
      }));

      await expect(syncContactsTrashFromServer({
        transport,
        account,
        handlers,
      })).resolves.toMatchObject({
        ok: false,
        error: { type: 'invalidDocument', terminal: true },
      });
      await expect(pushContactsTrash({
        transport,
        account,
        handlers,
      })).resolves.toMatchObject({
        ok: false,
        error: { type: 'invalidDocument', terminal: true },
      });
      expect(await handlers[DB_RPC.CONTACT_TRASH_GET_DOCUMENT]({
        accountId: account.id,
      })).toEqual(before);
      expect(transport.requests.flatMap((request) => request.methodCalls)
        .some(([name]) => name === 'FileNode/set')).toBe(false);
      expect(transport.uploads).toHaveLength(0);
    } finally {
      await engine.close();
    }
  });

  it('preflights one-entry shard size without relying on media limits', () => {
    const value = entry({
      uid: 'uid-large',
      displayName: 'x'.repeat(1_024),
    });
    expect(contactTrashEntryFitsInShard(value, 512)).toBe(false);
    expect(CONTACTS_TRASH_MAX_DOCUMENT_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe('contacts trash write limit', () => {
  it('uses the lower of the configured shard and live upload limits', () => {
    const transport = new MockTransport();
    transport.session.capabilities[JMAP_CAPS.CORE].maxSizeUpload = 20 * 1024 ** 2;
    expect(contactsTrashSnapshotWriteMaxBytes(transport)).toBe(20 * 1024 ** 2);

    transport.session.capabilities[JMAP_CAPS.CORE].maxSizeUpload = 30 * 1024 ** 2;
    expect(contactsTrashSnapshotWriteMaxBytes(transport)).toBe(25 * 1024 ** 2);
  });
});

describe('contacts trash restore', () => {
  let engine: any;
  let handlers: Record<string, (params: any) => Promise<any>>;
  let account: any;

  beforeEach(async () => {
    engine = await bootTestEngine();
    handlers = makeHandlers(engine);
    account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'Restore User',
      primaryEmail: 'restore@example.com',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'restore-account',
      isPrimary: true,
    })).row;
    await handlers[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{
        remoteId: 'new-book',
        name: 'New',
        isDefault: true,
        mayWrite: true,
      }],
    });
    await handlers[DB_RPC.CONTACT_TRASH_PUT_ENTRIES]({
      accountId: account.id,
      entries: [entry()],
    });
  });

  afterEach(async () => {
    await engine.close();
  });

  function transport() {
    const mock = new MockTransport({
      capabilities: {
        [JMAP_CAPS.CORE]: {
          maxObjectsInGet: 500,
          maxObjectsInSet: 500,
          maxSizeUpload: 50_000_000,
        },
        [JMAP_CAPS.CONTACTS]: {},
      },
    });
    let create: Record<string, any> | null = null;
    mock.handle('AddressBook/get', () => ({
      state: 'books-1',
      list: [{ id: 'new-book', myRights: { mayWrite: true } }],
    }));
    mock.handle('ContactCard/query', () => ({
      queryState: 'cards-1',
      ids: [],
      total: 0,
    }));
    mock.handle('ContactCard/set', (request) => {
      create = request.create;
      return {
        oldState: 'cards-1',
        newState: 'cards-2',
        created: { 'restore-1': { id: 'new-card' } },
      };
    });
    return {
      mock,
      get create() {
        return create;
      },
    };
  }

  it('requires an explicit destination when no original book remains writable', async () => {
    const server = transport();

    const result = await restoreContactTrash({
      transport: server.mock,
      account,
      handlers,
      trashIds: [1],
    });

    expect(result.destinationRequiredTrashIds).toEqual([1]);
    expect(server.create).toBeNull();
  });

  it('recreates the full snapshot without id in the explicit destination', async () => {
    const server = transport();

    const result = await restoreContactTrash({
      transport: server.mock,
      account,
      handlers,
      trashIds: [1],
      destinationAddressBookRemoteId: 'new-book',
    });

    expect(result).toMatchObject({
      succeededTrashIds: [1],
      restoredRemoteIds: ['new-card'],
      destinationRequiredTrashIds: [],
      failures: [],
    });
    expect(server.create?.['restore-1']).toMatchObject({
      uid: 'uid-1',
      addressBookIds: { 'new-book': true },
      customUnknown: { retained: true },
      emails: {
        stableEmailKey: {
          customUnknown: true,
        },
      },
    });
    expect(server.create?.['restore-1']).not.toHaveProperty('id');
  });

  it('resolves bulk UIDs in bounded query/get calls and isolates duplicates', async () => {
    await handlers[DB_RPC.CONTACT_TRASH_PUT_ENTRIES]({
      accountId: account.id,
      entries: [
        entry({
          uid: 'uid-2',
          remoteId: 'old-card-2',
          snapshot: {
            id: 'old-card-2',
            uid: 'uid-2',
            addressBookIds: { 'old-book': true },
          },
        }),
        entry({
          uid: 'uid-3',
          remoteId: 'old-card-3',
          snapshot: {
            id: 'old-card-3',
            uid: 'uid-3',
            addressBookIds: { 'old-book': true },
          },
        }),
      ],
    });
    const rows = await handlers[DB_RPC.CONTACT_TRASH_LIST]({ accountId: account.id });
    const ids = new Map(rows.map((row: any) => [row.uid, Number(row.id)]));
    const mock = new MockTransport({
      capabilities: {
        [JMAP_CAPS.CORE]: {
          maxCallsInRequest: 8,
          maxObjectsInGet: 4,
          maxObjectsInSet: 4,
          maxSizeUpload: 50_000_000,
        },
        [JMAP_CAPS.CONTACTS]: {},
      },
    });
    mock.handle('ContactCard/query', ({ filter }) => {
      const uids = filter.operator === 'OR'
        ? filter.conditions.map((condition: any) => condition.uid)
        : [filter.uid];
      const remoteIds = uids.flatMap((uid: string) =>
        uid === 'uid-1'
          ? ['existing-1']
          : (uid === 'uid-2' ? ['duplicate-a', 'duplicate-b'] : []));
      return {
        queryState: 'cards-1',
        ids: remoteIds,
        total: remoteIds.length,
      };
    });
    mock.handle('ContactCard/get', ({ ids: remoteIds }) => ({
      state: 'cards-1',
      list: remoteIds.map((id: string) => ({
        id,
        uid: id === 'existing-1' ? 'uid-1' : 'uid-2',
      })),
      notFound: [],
    }));
    mock.handle('AddressBook/get', () => ({
      state: 'books-1',
      list: [{ id: 'new-book', myRights: { mayWrite: true } }],
    }));
    mock.handle('ContactCard/set', ({ create }) => ({
      oldState: 'cards-1',
      newState: 'cards-2',
      created: Object.fromEntries(
        Object.keys(create).map((key) => [key, { id: `created-${key}` }]),
      ),
    }));

    const result = await restoreContactTrash({
      transport: mock,
      account,
      handlers,
      trashIds: [ids.get('uid-1'), ids.get('uid-2'), ids.get('uid-3')],
      destinationAddressBookRemoteId: 'new-book',
    });

    expect(result.succeededTrashIds).toEqual([
      ids.get('uid-1'),
      ids.get('uid-3'),
    ]);
    expect(result.failures).toEqual([{
      trashId: ids.get('uid-2'),
      errorType: 'ambiguousUid',
    }]);
    const queryRequests = mock.requests.filter((request) =>
      request.methodCalls.some(([name]) => name === 'ContactCard/query'));
    const getRequests = mock.requests.filter((request) =>
      request.methodCalls.some(([name]) => name === 'ContactCard/get'));
    expect(queryRequests).toHaveLength(2);
    expect(queryRequests.every((request) => request.methodCalls.length === 1)).toBe(true);
    expect(queryRequests[0].methodCalls[0][1].filter).toEqual({
      operator: 'OR',
      conditions: [{ uid: 'uid-1' }, { uid: 'uid-2' }],
    });
    expect(queryRequests[1].methodCalls[0][1].filter).toEqual({ uid: 'uid-3' });
    expect(getRequests).toHaveLength(1);
  });

  it('does not report a corrupt active snapshot as already restored', async () => {
    const [row] = await handlers[DB_RPC.CONTACT_TRASH_LIST]({ accountId: account.id });
    await engine.run(
      'UPDATE contacts_trash SET snapshot_json = ? WHERE id = ?',
      ['{broken', row.id],
    );
    const mock = new MockTransport({
      capabilities: {
        [JMAP_CAPS.CORE]: {
          maxObjectsInGet: 8,
          maxObjectsInSet: 8,
          maxSizeUpload: 50_000_000,
        },
        [JMAP_CAPS.CONTACTS]: {},
      },
    });

    const result = await restoreContactTrash({
      transport: mock,
      account,
      handlers,
      trashIds: [row.id],
    });

    expect(result.succeededTrashIds).toEqual([]);
    expect(result.failures).toEqual([{
      trashId: row.id,
      errorType: 'invalidTrashSnapshot',
    }]);
    expect(await handlers[DB_RPC.CONTACT_TRASH_LIST]({
      accountId: account.id,
    })).toHaveLength(1);
    expect(mock.requests).toHaveLength(0);
  });

  it('preserves blob media without @type and leaves URI media untouched', async () => {
    const originalBytes = new Uint8Array([1, 4, 9, 16]);
    let originalBlobAvailable = true;
    let card: any = {
      '@type': 'Card',
      id: 'media-card',
      uid: 'uid-media',
      addressBookIds: { 'new-book': true },
      name: { full: 'Media Person' },
      media: {
        avatar: {
          kind: 'photo',
          blobId: 'original-media',
          mediaType: 'image/png',
        },
        profile: {
          '@type': 'Media',
          kind: 'link',
          uri: 'https://example.com/profile',
          mediaType: 'text/html',
        },
      },
    };
    const fileNodes = new Map<string, any>();
    let fileState = 1;
    const jsonBlobs = new Map<string, string>();
    const uploadedMedia = new Map<string, Uint8Array>();
    const mediaDownloadLimits: Array<number | undefined> = [];
    const mock = new MockTransport({
      capabilities: {
        [JMAP_CAPS.CORE]: {
          maxObjectsInGet: 8,
          maxObjectsInSet: 8,
          maxSizeUpload: 50_000_000,
        },
        [JMAP_CAPS.CONTACTS]: {},
        [JMAP_CAPS.FILENODE]: {},
      },
      accounts: {
        [account.remote_account_id]: {
          accountCapabilities: {
            [JMAP_CAPS.FILENODE]: { mayCreateTopLevelFileNode: true },
          },
        },
      },
    }) as any;
    mock.download = async ({ blobId, maxBytes }: any) => {
      if (jsonBlobs.has(blobId)) {
        return new TextEncoder().encode(jsonBlobs.get(blobId)!);
      }
      if (blobId === 'original-media' && originalBlobAvailable) {
        mediaDownloadLimits.push(maxBytes);
        return originalBytes;
      }
      const uploaded = uploadedMedia.get(blobId);
      if (uploaded) return uploaded;
      throw new Error(`blob ${blobId} is unavailable`);
    };
    mock.handleUpload(({ type, body }: any) => {
      if (type === 'application/json') {
        const blobId = `json-${jsonBlobs.size + 1}`;
        jsonBlobs.set(blobId, body);
        return { accountId: account.remote_account_id, blobId, type, size: body.length };
      }
      const blobId = `restored-media-${uploadedMedia.size + 1}`;
      uploadedMedia.set(blobId, new Uint8Array(body));
      return { accountId: account.remote_account_id, blobId, type, size: body.byteLength };
    });
    mock.handle('AddressBook/get', () => ({
      state: 'books-1',
      list: [{ id: 'new-book', myRights: { mayWrite: true } }],
    }));
    mock.handle('ContactCard/get', ({ ids }) => ({
      state: 'cards-1',
      list: card && ids.includes(card.id) ? [structuredClone(card)] : [],
      notFound: card ? [] : ids,
    }));
    mock.handle('ContactCard/query', ({ filter }) => ({
      queryState: 'cards-2',
      ids: card?.uid === filter.uid ? [card.id] : [],
      total: card?.uid === filter.uid ? 1 : 0,
    }));
    mock.handle('ContactCard/set', ({ create = {}, destroy = [] }) => {
      if (destroy.includes('media-card')) {
        card = null;
        originalBlobAvailable = false;
        return {
          oldState: 'cards-1',
          newState: 'cards-2',
          destroyed: ['media-card'],
        };
      }
      const [key, created] = Object.entries<any>(create)[0] ?? [];
      if (key) {
        card = { ...structuredClone(created), id: 'restored-media-card' };
        return {
          oldState: 'cards-2',
          newState: 'cards-3',
          created: { [key]: { id: card.id } },
        };
      }
      return { oldState: 'cards-2', newState: 'cards-2' };
    });
    mock.handle('FileNode/query', (args) => ({
      ...fileNodeQuery([...fileNodes.values()], args),
      queryState: `files-${fileState}`,
    }));
    mock.handle('FileNode/get', ({ ids }) => ({
      state: `files-${fileState}`,
      list: (ids ?? [...fileNodes.keys()]).flatMap((id: string) => {
        const node = fileNodes.get(id);
        return node ? [node] : [];
      }),
      notFound: [],
    }));
    mock.handle('FileNode/set', ({ create, update }) => {
      const response: any = {
        oldState: `files-${fileState}`,
        newState: `files-${fileState + 1}`,
      };
      if (create) {
        response.created = {};
        for (const [key, value] of Object.entries<any>(create)) {
          const node = {
            id: `file-node-${fileNodes.size + 1}`,
            ...value,
            myRights: { mayRead: true, mayWrite: true, mayModifyContent: true },
          };
          fileNodes.set(node.id, node);
          response.created[key] = { id: node.id };
        }
      } else if (update) {
        response.updated = {};
        for (const [id, patch] of Object.entries<any>(update)) {
          const node = fileNodes.get(id);
          if (!node) continue;
          fileNodes.set(id, { ...node, ...patch });
          response.updated[id] = null;
        }
      }
      fileState += 1;
      return response;
    });

    const deleted = await deleteContactCardsWithTrash({
      transport: mock,
      account,
      handlers,
      targets: [{ contactId: 99, remoteId: 'media-card' }],
      sourceAddressBookRemoteId: null,
    });
    expect(deleted).toMatchObject({
      complete: true,
      result: { destroyedContactIds: [99], failures: [] },
    });
    expect(mediaDownloadLimits).toEqual([CONTACTS_TRASH_MAX_MEDIA_BYTES]);
    await expect(mock.download({
      accountId: account.remote_account_id,
      blobId: 'original-media',
    })).rejects.toThrow(/unavailable/);
    const trash = await handlers[DB_RPC.CONTACT_TRASH_LIST]({ accountId: account.id });
    const mediaRow = trash.find((row: any) => row.uid === 'uid-media');
    const detail = await handlers[DB_RPC.CONTACT_TRASH_GET]({
      accountId: account.id,
      trashId: mediaRow.id,
    });
    expect(detail.media).toEqual([{
      blobId: 'original-media',
      mediaType: 'image/png',
      base64: 'AQQJEA==',
    }]);

    const restored = await restoreContactTrash({
      transport: mock,
      account,
      handlers,
      trashIds: [mediaRow.id],
    });

    expect(restored.failures).toEqual([]);
    expect(restored.restoredRemoteIds).toEqual(['restored-media-card']);
    expect(card.media.avatar.blobId).toBe('restored-media-1');
    expect(card.media.profile).toEqual({
      '@type': 'Media',
      kind: 'link',
      uri: 'https://example.com/profile',
      mediaType: 'text/html',
    });
    expect(uploadedMedia.get('restored-media-1')).toEqual(originalBytes);
  });

  it('keeps the card live when media preservation fails', async () => {
    const card = {
      '@type': 'Card',
      id: 'unreadable-media-card',
      uid: 'uid-unreadable-media',
      addressBookIds: { 'new-book': true },
      name: { full: 'Unreadable Media' },
      media: {
        avatar: {
          '@type': 'Media',
          blobId: 'lost-media',
          mediaType: 'image/png',
        },
      },
    };
    const mock = new MockTransport({
      capabilities: {
        [JMAP_CAPS.CORE]: {
          maxObjectsInGet: 8,
          maxObjectsInSet: 8,
          maxSizeUpload: 50_000_000,
        },
        [JMAP_CAPS.CONTACTS]: {},
      },
    }) as any;
    mock.download = async () => {
      throw new Error('media download failed');
    };
    mock.handle('AddressBook/get', () => ({
      state: 'books-1',
      list: [{ id: 'new-book', myRights: { mayWrite: true } }],
    }));
    mock.handle('ContactCard/get', () => ({
      state: 'cards-1',
      list: [card],
      notFound: [],
    }));

    const deleted = await deleteContactCardsWithTrash({
      transport: mock,
      account,
      handlers,
      targets: [{ contactId: 100, remoteId: card.id }],
      sourceAddressBookRemoteId: null,
    });

    expect(deleted).toMatchObject({
      complete: true,
      result: {
        destroyedContactIds: [],
        failures: [{
          contactId: 100,
          errorType: 'mediaPreservationFailed',
          message: 'media download failed',
        }],
      },
    });
    expect(mock.requests.flatMap((request) => request.methodCalls)
      .some(([name]) => name === 'ContactCard/set')).toBe(false);
    expect((await handlers[DB_RPC.CONTACT_TRASH_LIST]({ accountId: account.id }))
      .some((row: any) => row.uid === card.uid)).toBe(false);
  });
});

describe('contacts trash delete recovery', () => {
  let engine: any;
  let handlers: Record<string, (params: any) => Promise<any>>;
  let account: any;

  beforeEach(async () => {
    engine = await bootTestEngine();
    handlers = makeHandlers(engine);
    account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'Delete User',
      primaryEmail: 'delete@example.com',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'delete-account',
      isPrimary: true,
    })).row;
  });

  afterEach(async () => {
    await engine.close();
  });

  function card(id: string) {
    return {
      '@type': 'Card',
      id,
      uid: `uid-${id}`,
      addressBookIds: { 'delete-book': true },
      name: { full: `Person ${id}` },
      emails: {
        email: {
          '@type': 'EmailAddress',
          address: `${id}@example.com`,
        },
      },
    };
  }

  function deleteHarness(initialCards: any[]) {
    const cards = new Map(
      initialCards.map((value) => [value.id, structuredClone(value)]),
    );
    const blobs = new Map<string, string>();
    const fileNodes = new Map<string, any>();
    let fileState = 1;
    let contactState = 1;
    const transport = new MockTransport({
      capabilities: {
        [JMAP_CAPS.CORE]: {
          maxObjectsInGet: 8,
          maxObjectsInSet: 8,
          maxSizeUpload: 50_000_000,
        },
        [JMAP_CAPS.CONTACTS]: {},
        [JMAP_CAPS.FILENODE]: {},
      },
      accounts: {
        [account.remote_account_id]: {
          accountCapabilities: {
            [JMAP_CAPS.FILENODE]: { mayCreateTopLevelFileNode: true },
          },
        },
      },
    }) as any;
    transport.download = vi.fn(async ({ blobId }: any) =>
      new TextEncoder().encode(blobs.get(blobId)!));
    transport.handleUpload(({ body }: any) => {
      const blobId = `trash-blob-${blobs.size + 1}`;
      blobs.set(blobId, body);
      return {
        accountId: account.remote_account_id,
        blobId,
        type: 'application/json',
        size: body.length,
      };
    });
    transport.handle('AddressBook/get', () => ({
      state: 'books-1',
      list: [{ id: 'delete-book', myRights: { mayWrite: true } }],
    }));
    transport.handle('ContactCard/get', ({ ids }: any) => ({
      state: `cards-${contactState}`,
      list: ids.flatMap((id: string) => {
        const value = cards.get(id);
        return value ? [structuredClone(value)] : [];
      }),
      notFound: ids.filter((id: string) => !cards.has(id)),
    }));
    transport.handle('ContactCard/set', ({ update = {}, destroy = [] }: any) => {
      const oldState = `cards-${contactState}`;
      const updated: Record<string, null> = {};
      const notUpdated: Record<string, { type: string }> = {};
      for (const [id, patch] of Object.entries(update)) {
        const existing = cards.get(id);
        if (!existing) {
          notUpdated[id] = { type: 'notFound' };
          continue;
        }
        cards.set(id, { ...existing, ...(patch as Record<string, unknown>) });
        updated[id] = null;
      }
      for (const id of destroy) cards.delete(id);
      contactState += 1;
      return {
        oldState,
        newState: `cards-${contactState}`,
        updated,
        notUpdated,
        destroyed: destroy,
      };
    });
    transport.handle('FileNode/query', (args: any) => ({
      ...fileNodeQuery([...fileNodes.values()], args),
      queryState: `files-${fileState}`,
    }));
    transport.handle('FileNode/get', ({ ids }: any) => ({
      state: `files-${fileState}`,
      list: (ids ?? [...fileNodes.keys()]).flatMap((id: string) => {
        const node = fileNodes.get(id);
        return node ? [node] : [];
      }),
      notFound: [],
    }));
    transport.handle('FileNode/set', ({ create, update }: any) => {
      const response: any = {
        oldState: `files-${fileState}`,
        newState: `files-${fileState + 1}`,
      };
      if (create) {
        response.created = {};
        for (const [key, created] of Object.entries<any>(create)) {
          const node = {
            id: `file-node-${fileNodes.size + 1}`,
            ...created,
            myRights: { mayRead: true, mayWrite: true, mayModifyContent: true },
          };
          fileNodes.set(node.id, node);
          response.created[key] = { id: node.id };
        }
      } else if (update) {
        response.updated = {};
        for (const [id, patch] of Object.entries<any>(update)) {
          const node = fileNodes.get(id);
          if (!node) continue;
          fileNodes.set(id, { ...node, ...patch });
          response.updated[id] = null;
        }
      }
      fileState += 1;
      return response;
    });
    return {
      transport,
      cards,
      deleteCards(ids: string[]) {
        for (const id of ids) cards.delete(id);
        contactState += 1;
      },
      remoteDocument() {
        const trashFolder = [...fileNodes.values()].find((candidate) =>
          candidate.name === CONTACTS_TRASH_FILE_NODE_FOLDER);
        const documents = [...fileNodes.values()].filter((candidate) =>
          candidate.parentId === trashFolder?.id
          && candidate.type === 'application/json')
          .map((node) => JSON.parse(blobs.get(node.blobId)!));
        return documents.length > 0 ? aggregateContactsTrashDocuments(documents) : null;
      },
      remoteEntry(uid: string) {
        const document = this.remoteDocument();
        return document?.entries[uid];
      },
    };
  }

  it('uses a stable synthetic uid when trashing a legacy card', async () => {
    const value = card('missing-uid');
    delete value.uid;
    const server = deleteHarness([value]);
    const phases: string[] = [];

    const result = await deleteContactCardsWithTrash({
      transport: server.transport,
      account,
      handlers,
      targets: [{ contactId: 13, remoteId: value.id }],
      sourceAddressBookRemoteId: null,
      onPhase: async (phase) => {
        phases.push(phase);
      },
    });

    expect(result).toMatchObject({
      complete: true,
      result: {
        destroyedContactIds: [13],
        failures: [],
      },
    });
    const contactSets = server.transport.requests
      .flatMap((request: any) => request.methodCalls)
      .filter(([name]: any) => name === 'ContactCard/set');
    expect(contactSets).toHaveLength(1);
    expect(contactSets[0][1].destroy).toEqual([value.id]);
    expect(phases[0]).toBe('snapshot-saved');
    const [trashed] = await handlers[DB_RPC.CONTACT_TRASH_LIST]({
      accountId: account.id,
    });
    expect(isContactUid(trashed.uid)).toBe(true);
    await expect(createContactUidFromSeed(
      `contacts-trash\0${account.remote_account_id}\0${value.id}`,
    )).resolves.toBe(trashed.uid);
    expect(server.remoteEntry(trashed.uid)).toMatchObject({
      uid: trashed.uid,
      snapshot: expect.objectContaining({
        id: value.id,
        uid: trashed.uid,
      }),
    });
  });

  it('keeps the card live when one entry exceeds the shard byte cap', async () => {
    const value = {
      ...card('oversized-card'),
      extensionData: 'x'.repeat(512),
    };
    const server = deleteHarness([value]);

    const result = await deleteContactCardsWithTrash({
      transport: server.transport,
      account,
      handlers,
      targets: [{ contactId: 12, remoteId: value.id }],
      sourceAddressBookRemoteId: null,
      maxTrashShardBytes: 256,
    });

    expect(result).toMatchObject({
      complete: true,
      result: {
        destroyedContactIds: [],
        failures: [{ contactId: 12, errorType: 'trashSnapshotTooLarge' }],
      },
    });
    expect(server.cards.has(value.id)).toBe(true);
    expect(server.transport.uploads).toHaveLength(0);
  });

  it('retains snapshots after serverPartialFail and converges on retry', async () => {
    const cards = [card('partial-a'), card('partial-b')];
    const server = deleteHarness(cards);
    let partial = true;
    server.transport.handleError('ContactCard/set', ({ destroy }: any) => {
      if (!partial) return null;
      partial = false;
      server.deleteCards([destroy[0]]);
      return { type: 'serverPartialFail' };
    });
    const targets = cards.map((value, index) => ({
      contactId: index + 1,
      remoteId: value.id,
    }));

    const first = await deleteContactCardsWithTrash({
      transport: server.transport,
      account,
      handlers,
      targets,
      sourceAddressBookRemoteId: null,
    });

    expect(first).toMatchObject({
      complete: false,
      error: { type: 'serverPartialFail' },
    });
    expect(first.error).not.toHaveProperty('terminal');
    expect(await handlers[DB_RPC.CONTACT_TRASH_LIST]({
      accountId: account.id,
    })).toHaveLength(2);

    const retry = await deleteContactCardsWithTrash({
      transport: server.transport,
      account,
      handlers,
      targets,
      sourceAddressBookRemoteId: null,
    });

    expect(retry).toMatchObject({
      complete: true,
      result: {
        destroyedContactIds: [1, 2],
        failures: [],
      },
    });
    expect(server.cards.size).toBe(0);
    expect(server.transport.requests.flatMap((request: any) => request.methodCalls)
      .filter(([name]: any) => name === 'ContactCard/set')).toHaveLength(2);
    expect(await handlers[DB_RPC.CONTACT_TRASH_LIST]({
      accountId: account.id,
    })).toHaveLength(2);
  });

  it('tombstones staged snapshots before returning a thrown 403', async () => {
    const value = card('forbidden-card');
    const server = deleteHarness([value]);
    server.transport.handle('ContactCard/set', () => {
      const error: any = new Error('JMAP request failed: 403 Forbidden');
      error.status = 403;
      throw error;
    });

    const result = await deleteContactCardsWithTrash({
      transport: server.transport,
      account,
      handlers,
      targets: [{ contactId: 10, remoteId: value.id }],
      sourceAddressBookRemoteId: null,
    });

    expect(result).toMatchObject({
      complete: false,
      error: {
        type: 'authorizationFailed',
        status: 403,
        terminal: true,
      },
    });
    expect(server.cards.has(value.id)).toBe(true);
    expect(await handlers[DB_RPC.CONTACT_TRASH_LIST]({
      accountId: account.id,
    })).toEqual([]);
    const local = await handlers[DB_RPC.CONTACT_TRASH_GET_DOCUMENT]({
      accountId: account.id,
    });
    expect(local.doc.entries[value.uid]).toMatchObject({
      status: 'purged',
      snapshot: null,
    });
    expect(server.remoteEntry(value.uid)).toMatchObject({
      status: 'purged',
      snapshot: null,
    });
  });

  it('retains snapshots after an ambiguous thrown transport error', async () => {
    const value = card('transport-card');
    const server = deleteHarness([value]);
    let disconnect = true;
    server.transport.handle('ContactCard/set', ({ destroy = [] }: any) => {
      server.deleteCards(destroy);
      if (disconnect) {
        disconnect = false;
        throw new Error('socket lost after write');
      }
      return { destroyed: destroy };
    });

    const first = await deleteContactCardsWithTrash({
      transport: server.transport,
      account,
      handlers,
      targets: [{ contactId: 11, remoteId: value.id }],
      sourceAddressBookRemoteId: null,
    });

    expect(first).toMatchObject({
      complete: false,
      error: {
        type: 'transport',
        message: 'socket lost after write',
      },
    });
    expect(first.error).not.toHaveProperty('terminal');
    const staged = await handlers[DB_RPC.CONTACT_TRASH_GET_DOCUMENT]({
      accountId: account.id,
    });
    expect(staged.doc.entries[value.uid]).toMatchObject({
      status: 'trashed',
      snapshot: expect.objectContaining({ id: value.id }),
    });
    expect(server.remoteEntry(value.uid)).toMatchObject({
      status: 'trashed',
      snapshot: expect.objectContaining({ id: value.id }),
    });

    await expect(deleteContactCardsWithTrash({
      transport: server.transport,
      account,
      handlers,
      targets: [{ contactId: 11, remoteId: value.id }],
      sourceAddressBookRemoteId: null,
    })).resolves.toMatchObject({
      complete: true,
      result: {
        destroyedContactIds: [11],
        failures: [],
      },
    });
  });
});
