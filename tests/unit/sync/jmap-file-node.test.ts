import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  CONTACTS_TRASH_FILE_NODE_FOLDER,
  discoverJsonFileNodes,
  ensureContactsTrashFileNodeFolder,
  hasFileNodeCapability,
  isFileNodeWriteConflictError,
  moveFileNodes,
  readJsonFileNode,
  retryFileNodeWrite,
  THUNDERMAIL_FILE_NODE_FOLDER,
  writeJsonFileNode,
} from '../../../src/sync/backends/jmap/file-node';
import { JMAP_CAPS } from '../../../src/sync/backends/jmap/transport';
import { MockTransport } from './_mock-transport';

const account = { remote_account_id: 'account-1' };
const marker = { owner: 'stormbox', documentType: 'test-document', version: 1 };
const document = { ...marker, value: 'current' };
const MAX_DOCUMENT_BYTES = 1024;

function session(capability: Record<string, unknown> | null = {}) {
  return {
    capabilities: { [JMAP_CAPS.CORE]: {}, [JMAP_CAPS.FILENODE]: {} },
    accounts: {
      'account-1': {
        accountCapabilities: capability == null
          ? {}
          : { [JMAP_CAPS.FILENODE]: capability },
      },
    },
  };
}

function makeTransport({
  node = null as any,
  content = document as any,
  capability = {} as Record<string, unknown>,
} = {}) {
  const transport = new MockTransport(session(capability)) as any;
  transport.download = vi.fn(async () =>
    new TextEncoder().encode(JSON.stringify(content)));
  transport.handle('FileNode/query', () => ({
    accountId: 'account-1',
    queryState: 'query-1',
    ids: node ? [node.id] : [],
  }));
  transport.handle('FileNode/get', ({ ids }) => ({
    accountId: 'account-1',
    state: 'state-1',
    list: node && ids.includes(node.id) ? [node] : [],
    notFound: [],
  }));
  return transport;
}

function ownedNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'node-1',
    parentId: null,
    nodeType: 'file',
    name: 'document.json',
    blobId: 'blob-1',
    type: 'application/json',
    myRights: { mayRead: true, mayModifyContent: true },
    ...overrides,
  };
}

describe('JMAP FileNode JSON transport', () => {
  it('discovers top-level collections through bounded query/get pages', async () => {
    const nodes = Array.from({ length: 3 }, (_, index) => ownedNode({
      id: `node-${index}`,
      name: `document-${index}.json`,
    }));
    const transport = new MockTransport({
      ...session(),
      capabilities: {
        [JMAP_CAPS.CORE]: { maxObjectsInGet: 2 },
        [JMAP_CAPS.FILENODE]: {},
      },
    }) as any;
    transport.handle('FileNode/query', ({ position, limit }) => ({
      accountId: 'account-1',
      queryState: 'query-1',
      ids: nodes.slice(position, position + limit).map((node) => node.id),
      total: nodes.length,
    }));
    transport.handle('FileNode/get', ({ ids }) => ({
      accountId: 'account-1',
      state: 'state-1',
      list: nodes.filter((node) => ids.includes(node.id)),
      notFound: [],
    }));

    await expect(discoverJsonFileNodes({
      transport,
      account,
      nameMatch: 'document-*.json',
      acceptName: (name) => /^document-\d+\.json$/.test(name),
    })).resolves.toMatchObject({
      ok: true,
      nodes: [
        { id: 'node-0' },
        { id: 'node-1' },
        { id: 'node-2' },
      ],
    });
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[0].methodCalls[0][1].filter).toEqual({
      nameMatch: 'document-*.json',
    });
    expect(transport.requests.every((request: any) =>
      request.methodCalls[0][1].limit === 2)).toBe(true);
  });

  it('requires the capability on the specific account', async () => {
    const transport = new MockTransport(session(null)) as any;
    expect(hasFileNodeCapability(transport, account)).toBe(false);
    const result = await readJsonFileNode({
      transport,
      account,
      fileName: 'document.json',
      marker,
      maxBytes: MAX_DOCUMENT_BYTES,
    });
    expect(result).toEqual({
      ok: false,
      error: { type: 'unsupported', terminal: true },
    });
    expect(transport.requests).toHaveLength(0);
  });

  it('queries by exact name and validates the top-level owned document', async () => {
    const node = ownedNode();
    const transport = makeTransport({ node });
    const result = await readJsonFileNode({
      transport,
      account,
      fileName: 'document.json',
      marker,
      maxBytes: MAX_DOCUMENT_BYTES,
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'found',
      state: 'state-1',
      document,
    });
    const query = transport.requests[0].methodCalls[0][1];
    expect(query.filter).toEqual({ name: 'document.json' });
    expect(query.limit).toBe(500);
    expect(transport.requests[0].methodCalls[1][1].properties)
      .not.toContain('nodeType');
  });

  it('refuses an unowned or incompatible document', async () => {
    const transport = makeTransport({
      node: ownedNode(),
      content: { ...document, owner: 'another-application' },
    });
    const result = await readJsonFileNode({
      transport,
      account,
      fileName: 'document.json',
      marker,
      maxBytes: MAX_DOCUMENT_BYTES,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { type: 'invalidDocument', terminal: true },
    });
  });

  it('rejects a declared oversized document before downloading it', async () => {
    const transport = makeTransport({
      node: ownedNode({ size: MAX_DOCUMENT_BYTES + 1 }),
    });

    await expect(readJsonFileNode({
      transport,
      account,
      fileName: 'document.json',
      marker,
      maxBytes: MAX_DOCUMENT_BYTES,
    })).resolves.toMatchObject({
      ok: false,
      error: { type: 'tooLarge', terminal: true },
    });
    expect(transport.download).not.toHaveBeenCalled();
  });

  it('rejects oversized bytes returned by a mock that ignores maxBytes', async () => {
    const transport = makeTransport({
      node: ownedNode(),
      content: { ...document, value: 'x'.repeat(128) },
    });

    await expect(readJsonFileNode({
      transport,
      account,
      fileName: 'document.json',
      marker,
      maxBytes: 64,
    })).resolves.toMatchObject({
      ok: false,
      error: { type: 'tooLarge', terminal: true },
    });
    expect(transport.download).toHaveBeenCalledWith(expect.objectContaining({
      maxBytes: 64,
    }));
  });

  it('checks account and node write rights before uploading', async () => {
    const cannotCreate = makeTransport({
      capability: { mayCreateTopLevelFileNode: false },
    });
    const missing = await readJsonFileNode({
      transport: cannotCreate,
      account,
      fileName: 'document.json',
      marker,
      maxBytes: MAX_DOCUMENT_BYTES,
    });
    const create = await writeJsonFileNode({
      transport: cannotCreate,
      account,
      fileName: 'document.json',
      marker,
      document,
      snapshot: missing as any,
    });
    expect(create).toMatchObject({ ok: false, error: { type: 'forbidden' } });
    expect(cannotCreate.uploads).toHaveLength(0);

    const readOnly = makeTransport({
      node: ownedNode({ myRights: { mayRead: true, mayModifyContent: false } }),
    });
    const found = await readJsonFileNode({
      transport: readOnly,
      account,
      fileName: 'document.json',
      marker,
      maxBytes: MAX_DOCUMENT_BYTES,
    });
    const update = await writeJsonFileNode({
      transport: readOnly,
      account,
      fileName: 'document.json',
      marker,
      document,
      snapshot: found as any,
    });
    expect(update).toMatchObject({ ok: false, error: { type: 'forbidden' } });
    expect(readOnly.uploads).toHaveLength(0);
  });

  it('writes conditionally and preserves method-level stateMismatch', async () => {
    const transport = makeTransport({ node: ownedNode() });
    const snapshot = await readJsonFileNode({
      transport,
      account,
      fileName: 'document.json',
      marker,
      maxBytes: MAX_DOCUMENT_BYTES,
    });
    transport.handleError('FileNode/set', ({ ifInState }) =>
      ifInState === 'state-1' ? { type: 'stateMismatch' } : null);

    const result = await writeJsonFileNode({
      transport,
      account,
      fileName: 'document.json',
      marker,
      document,
      snapshot: snapshot as any,
    });
    expect(result).toMatchObject({ ok: false, error: { type: 'stateMismatch' } });
    const set = transport.requests[1].methodCalls[0][1];
    expect(set).toMatchObject({ ifInState: 'state-1', onExists: null });
  });

  it('retries only bounded FileNode write conflicts', async () => {
    expect(isFileNodeWriteConflictError({ type: 'stateMismatch' })).toBe(true);
    expect(isFileNodeWriteConflictError({ type: 'alreadyExists' })).toBe(true);
    expect(isFileNodeWriteConflictError({ type: 'notFound' })).toBe(true);
    expect(isFileNodeWriteConflictError({ type: 'serverFail' })).toBe(false);

    const conflict = vi.fn(async () => ({
      ok: false as const,
      error: { type: 'stateMismatch' as const },
    }));
    await expect(retryFileNodeWrite(conflict)).resolves.toEqual({
      ok: false,
      error: { type: 'stateMismatch' },
    });
    expect(conflict).toHaveBeenCalledTimes(3);

    const terminal = vi.fn(async () => ({
      ok: false as const,
      error: { type: 'serverFail' as const },
    }));
    await retryFileNodeWrite(terminal);
    expect(terminal).toHaveBeenCalledOnce();
  });

  it('preserves create alreadyExists and update notFound errors', async () => {
    const createTransport = makeTransport();
    const missing = await readJsonFileNode({
      transport: createTransport,
      account,
      fileName: 'document.json',
      marker,
      maxBytes: MAX_DOCUMENT_BYTES,
    });
    createTransport.handle('FileNode/set', () => ({
      accountId: 'account-1',
      oldState: 'state-1',
      newState: 'state-1',
      notCreated: { document: { type: 'alreadyExists', existingId: 'other' } },
    }));
    expect(await writeJsonFileNode({
      transport: createTransport,
      account,
      fileName: 'document.json',
      marker,
      document,
      snapshot: missing as any,
    })).toMatchObject({ ok: false, error: { type: 'alreadyExists' } });
    const createRequest = createTransport.requests[1].methodCalls[0][1];
    expect(createRequest.create.document).toMatchObject({
      parentId: null,
      name: 'document.json',
      type: 'application/json',
    });
    expect(createRequest.create.document).not.toHaveProperty('nodeType');

    const updateTransport = makeTransport({ node: ownedNode() });
    const found = await readJsonFileNode({
      transport: updateTransport,
      account,
      fileName: 'document.json',
      marker,
      maxBytes: MAX_DOCUMENT_BYTES,
    });
    updateTransport.handle('FileNode/set', () => ({
      accountId: 'account-1',
      oldState: 'state-1',
      newState: 'state-2',
      notUpdated: { 'node-1': { type: 'notFound' } },
    }));
    expect(await writeJsonFileNode({
      transport: updateTransport,
      account,
      fileName: 'document.json',
      marker,
      document,
      snapshot: found as any,
    })).toMatchObject({ ok: false, error: { type: 'notFound' } });
  });

  it('preserves terminal SetError details instead of collapsing them', async () => {
    const transport = makeTransport({ node: ownedNode() });
    const snapshot = await readJsonFileNode({
      transport,
      account,
      fileName: 'document.json',
      marker,
      maxBytes: MAX_DOCUMENT_BYTES,
    });
    transport.handle('FileNode/set', () => ({
      accountId: 'account-1',
      oldState: 'state-1',
      newState: 'state-1',
      notUpdated: {
        'node-1': {
          type: 'invalidProperties',
          properties: ['blobId'],
        },
      },
    }));

    await expect(writeJsonFileNode({
      transport,
      account,
      fileName: 'document.json',
      marker,
      document,
      snapshot: snapshot as any,
    })).resolves.toMatchObject({
      ok: false,
      error: {
        type: 'invalidProperties',
        terminal: true,
        detail: {
          properties: ['blobId'],
        },
      },
    });
  });

  it('creates the thundermail/contacts_trash hierarchy and writes within it', async () => {
    const transport = new MockTransport(session({
      mayCreateTopLevelFileNode: true,
    })) as any;
    const nodes = new Map<string, any>();
    let state = 1;
    transport.handle('FileNode/query', ({ filter }) => ({
      accountId: 'account-1',
      queryState: `query-${state}`,
      ids: [...nodes.values()]
        .filter((node) => node.blobId != null && node.name === filter.name)
        .map((node) => node.id),
    }));
    transport.handle('FileNode/get', ({ ids }) => ({
      accountId: 'account-1',
      state: `state-${state}`,
      list: (ids ?? [...nodes.keys()]).flatMap((id: string) => {
        const node = nodes.get(id);
        return node ? [node] : [];
      }),
      notFound: [],
    }));
    transport.handle('FileNode/set', ({ create }) => {
      const created: Record<string, { id: string }> = {};
      for (const [key, value] of Object.entries<any>(create ?? {})) {
        const id = `node-${nodes.size + 1}`;
        nodes.set(id, {
          id,
          ...value,
          myRights: { mayRead: true, mayWrite: true },
        });
        created[key] = { id };
      }
      state += 1;
      return {
        accountId: 'account-1',
        oldState: `state-${state - 1}`,
        newState: `state-${state}`,
        created,
      };
    });

    const folder = await ensureContactsTrashFileNodeFolder({
      transport,
      account,
    });
    expect(folder).toMatchObject({
      ok: true,
      node: {
        name: CONTACTS_TRASH_FILE_NODE_FOLDER,
      },
    });
    const root = [...nodes.values()].find((node) =>
      node.name === THUNDERMAIL_FILE_NODE_FOLDER);
    expect(root).toMatchObject({ parentId: null });
    expect(root).not.toHaveProperty('blobId');
    expect(folder.ok && folder.node.parentId).toBe(root.id);

    const missing = await readJsonFileNode({
      transport,
      account,
      fileName: 'document.json',
      marker,
      maxBytes: MAX_DOCUMENT_BYTES,
      parentId: folder.ok ? folder.node.id : '',
    });
    await expect(writeJsonFileNode({
      transport,
      account,
      fileName: 'document.json',
      marker,
      document,
      snapshot: missing as any,
      parentId: folder.ok ? folder.node.id : '',
    })).resolves.toMatchObject({ ok: true });
    expect([...nodes.values()].find((node) => node.name === 'document.json'))
      .toMatchObject({ parentId: folder.ok ? folder.node.id : '' });
  });

  it('moves FileNodes in bounded conditional batches', async () => {
    const transport = new MockTransport({
      ...session(),
      capabilities: {
        [JMAP_CAPS.CORE]: { maxObjectsInSet: 2 },
        [JMAP_CAPS.FILENODE]: {},
      },
    }) as any;
    let state = 1;
    transport.handle('FileNode/set', ({ ifInState, update }) => {
      expect(ifInState).toBe(`state-${state}`);
      const updated = Object.fromEntries(
        Object.keys(update).map((id) => [id, null]),
      );
      state += 1;
      return {
        oldState: `state-${state - 1}`,
        newState: `state-${state}`,
        updated,
      };
    });
    const nodes = Array.from({ length: 3 }, (_, index) => ownedNode({
      id: `move-${index}`,
      name: `move-${index}.json`,
    }));

    await expect(moveFileNodes({
      transport,
      account,
      nodes,
      state: 'state-1',
      parentId: 'destination',
    })).resolves.toMatchObject({ ok: true, state: 'state-3' });

    const sets = transport.requests.flatMap((request) => request.methodCalls)
      .filter(([name]) => name === 'FileNode/set');
    expect(sets).toHaveLength(2);
    expect(sets.map(([, params]) => Object.keys(params.update).length)).toEqual([2, 1]);
  });
});
