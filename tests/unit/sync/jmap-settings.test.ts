import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import {
  pushSettings,
  SETTINGS_FILE_NAME,
  syncSettingsFromServer,
} from '../../../src/sync/backends/jmap/settings';
import { processMutationRow } from '../../../src/sync/backends/jmap/outbox';
import { JMAP_CAPS } from '../../../src/sync/backends/jmap/transport';
import { MockTransport, mockSession } from './_mock-transport';

const REMOTE_ACCOUNT_ID = 'settings-account';

function markedDocument(settings: Record<string, unknown>, stamps: Record<string, number>) {
  return {
    owner: 'stormbox',
    documentType: 'user-settings',
    version: 1,
    settings,
    updatedAt: stamps,
  };
}

function makeTransport(
  initialDocument: any | null,
  initialParentId: string | null = 'thundermail-folder',
  legacyDocument: any | null = null,
) {
  const transport = new MockTransport(mockSession({
    capabilities: { [JMAP_CAPS.FILENODE]: {} },
    accounts: {
      [REMOTE_ACCOUNT_ID]: {
        accountCapabilities: {
          [JMAP_CAPS.FILENODE]: { mayCreateTopLevelFileNode: true },
        },
      },
    },
  })) as any;
  const state = {
    version: 1,
    folder: {
      id: 'thundermail-folder',
      parentId: null,
      name: 'thundermail',
      blobId: null,
      type: null,
      myRights: { mayRead: true, mayWrite: true },
    } as any,
    node: initialDocument == null
      ? null
      : {
        id: 'settings-node',
        parentId: initialParentId,
        nodeType: 'file',
        name: SETTINGS_FILE_NAME,
        blobId: 'initial-blob',
        type: 'application/json',
        myRights: { mayRead: true, mayModifyContent: true },
      } as any,
    legacyNode: legacyDocument == null
      ? null
      : {
        id: 'legacy-settings-node',
        parentId: null,
        nodeType: 'file',
        name: SETTINGS_FILE_NAME,
        blobId: 'legacy-blob',
        type: 'application/json',
        myRights: { mayRead: true, mayModifyContent: true },
      } as any,
    blobs: new Map<string, string>(
      [
        ...(initialDocument == null
          ? []
          : [['initial-blob', JSON.stringify(initialDocument)] as [string, string]]),
        ...(legacyDocument == null
          ? []
          : [['legacy-blob', JSON.stringify(legacyDocument)] as [string, string]]),
      ],
    ),
    setCalls: 0,
  };

  transport.download = async ({ blobId }) =>
    new TextEncoder().encode(state.blobs.get(blobId)!);
  transport.handleUpload(({ body }) => {
    const blobId = `uploaded-${state.blobs.size + 1}`;
    state.blobs.set(blobId, body);
    return { accountId: REMOTE_ACCOUNT_ID, blobId, type: 'application/json', size: body.length };
  });
  transport.handle('FileNode/query', ({ filter }) => {
    const nodes = [state.folder, state.node, state.legacyNode].filter(Boolean);
    return {
      accountId: REMOTE_ACCOUNT_ID,
      queryState: `query-${state.version}`,
      ids: nodes
        .filter((node) => node.name === filter?.name)
        .map((node) => node.id),
    };
  });
  transport.handle('FileNode/get', ({ ids }) => ({
    accountId: REMOTE_ACCOUNT_ID,
    state: `state-${state.version}`,
    list: [state.folder, state.node, state.legacyNode]
      .filter((node) => node && ids.includes(node.id)),
    notFound: [],
  }));
  transport.handle('FileNode/set', ({ create, update, destroy, ifInState }) => {
    state.setCalls += 1;
    if (ifInState !== `state-${state.version}`) {
      throw new Error('test supplied stale state unexpectedly');
    }
    const response: any = {
      accountId: REMOTE_ACCOUNT_ID,
      oldState: `state-${state.version}`,
      newState: `state-${state.version + 1}`,
    };
    if (create) {
      state.node = {
        id: 'settings-node',
        ...create.document,
        myRights: { mayRead: true, mayModifyContent: true },
      };
      response.created = { document: { id: state.node.id } };
    }
    if (update) {
      response.updated = {};
      for (const [id, patch] of Object.entries<any>(update)) {
        if (state.node?.id === id) {
          state.node = { ...state.node, ...patch };
          response.updated[id] = null;
        } else if (state.legacyNode?.id === id) {
          state.legacyNode = { ...state.legacyNode, ...patch };
          response.updated[id] = null;
        }
      }
    }
    if (destroy) {
      response.destroyed = [];
      for (const id of destroy) {
        if (state.legacyNode?.id === id) {
          state.legacyNode = null;
          response.destroyed.push(id);
        }
      }
    }
    state.version += 1;
    return response;
  });
  return { transport, state };
}

let engine: any;
let handlers: Record<string, (params: any) => Promise<any>>;
let account: any;

beforeEach(async () => {
  engine = await bootTestEngine();
  handlers = makeHandlers(engine);
  const inserted = await handlers[DB_RPC.ACCOUNT_UPSERT]({
    displayName: 'Settings User',
    primaryEmail: 'settings@example.com',
    serverOrigin: 'https://mail.example.com',
    remoteAccountId: REMOTE_ACCOUNT_ID,
    isPrimary: true,
  });
  account = inserted.row;
});

afterEach(async () => {
  await engine.close();
});

describe('settings sync', () => {
  it('enqueues a missing-document repair without writing remotely during pull', async () => {
    await handlers[DB_RPC.SETTINGS_APPLY_PATCH]({
      accountId: account.id,
      patch: { theme: 'dark' },
    });
    await engine.run('DELETE FROM pending_mutations');
    const { transport, state } = makeTransport(null);

    const result = await syncSettingsFromServer({ transport, account, handlers });

    expect(result).toMatchObject({ ok: true, pulled: false, repairQueued: true });
    expect(state.node).toBeNull();
    expect(transport.uploads).toHaveLength(0);
    expect(await engine.get(
      `SELECT COUNT(*) AS count FROM pending_mutations
        WHERE mutation_type = 'pushSettings'`,
    )).toEqual({ count: 1 });
  });

  it('merges a remote document and queues local-newer repair through the outbox', async () => {
    await handlers[DB_RPC.SETTINGS_APPLY_PATCH]({
      accountId: account.id,
      patch: { theme: 'dark' },
    });
    const local = await handlers[DB_RPC.SETTINGS_GET]({ accountId: account.id });
    await engine.run('DELETE FROM pending_mutations');
    const remoteDocument = markedDocument(
      { theme: 'light', remoteOnly: true },
      { theme: local.doc.updatedAt.theme - 1, remoteOnly: local.doc.updatedAt.theme + 1 },
    );
    const { transport, state } = makeTransport(remoteDocument);

    const result = await syncSettingsFromServer({ transport, account, handlers });

    expect(result).toMatchObject({ ok: true, pulled: true, repairQueued: true });
    expect(state.setCalls).toBe(0);
    const stored = await handlers[DB_RPC.SETTINGS_GET]({ accountId: account.id });
    expect(stored.doc.settings).toEqual({ theme: 'dark', remoteOnly: true });
  });

  it('queues legacy relocation during pull and moves it on push', async () => {
    const remoteDocument = markedDocument({ theme: 'light' }, { theme: 1 });
    const { transport, state } = makeTransport(remoteDocument, null);

    await expect(syncSettingsFromServer({ transport, account, handlers }))
      .resolves.toMatchObject({ ok: true, pulled: true, repairQueued: true });

    expect(state.node.parentId).toBeNull();
    expect(transport.uploads).toHaveLength(0);
    expect(transport.requests.flatMap((request) => request.methodCalls)
      .some(([name]) => name === 'FileNode/set')).toBe(false);

    await expect(pushSettings({ transport, account, handlers }))
      .resolves.toEqual({ ok: true });

    expect(state.node.parentId).toBe(state.folder.id);
    expect(transport.uploads).toHaveLength(1);
    const move = transport.requests.flatMap((request) => request.methodCalls)
      .find(([name, params]) =>
        name === 'FileNode/set' && params.update?.[state.node.id]?.parentId);
    expect(move?.[1].update[state.node.id].parentId).toBe(state.folder.id);
  });

  it('merges duplicate settings locations and removes the legacy node on push', async () => {
    const current = markedDocument({ theme: 'light' }, { theme: 10 });
    const legacy = markedDocument({ theme: 'dark', legacyOnly: true }, {
      theme: 20,
      legacyOnly: 20,
    });
    const { transport, state } = makeTransport(current, 'thundermail-folder', legacy);

    await expect(syncSettingsFromServer({ transport, account, handlers }))
      .resolves.toMatchObject({ ok: true, pulled: true, repairQueued: true });
    expect(state.setCalls).toBe(0);
    expect((await handlers[DB_RPC.SETTINGS_GET]({
      accountId: account.id,
    })).doc.settings).toEqual({ theme: 'dark', legacyOnly: true });

    await expect(pushSettings({ transport, account, handlers }))
      .resolves.toEqual({ ok: true });

    expect(state.legacyNode).toBeNull();
    expect(JSON.parse(state.blobs.get(state.node.blobId)!).settings)
      .toEqual({ theme: 'dark', legacyOnly: true });
    const relocation = transport.requests.flatMap((request) => request.methodCalls)
      .find(([name, params]) =>
        name === 'FileNode/set' && params.destroy?.includes('legacy-settings-node'));
    expect(relocation?.[1].update).toHaveProperty('settings-node');
  });

  it('restarts duplicate-location reads when their collection states differ', async () => {
    const current = markedDocument({ currentOnly: true }, { currentOnly: 10 });
    const legacy = markedDocument({ legacyOnly: true }, { legacyOnly: 20 });
    const concurrent = markedDocument({ concurrentOnly: true }, { concurrentOnly: 30 });
    const { transport, state } = makeTransport(
      current,
      'thundermail-folder',
      legacy,
    );
    let settingsGets = 0;
    transport.handle('FileNode/get', ({ ids }) => {
      const settingsRead = ids.includes('settings-node')
        || ids.includes('legacy-settings-node');
      if (settingsRead) {
        settingsGets += 1;
        if (settingsGets === 2) {
          state.blobs.set('concurrent-blob', JSON.stringify(concurrent));
          state.node.blobId = 'concurrent-blob';
          state.version += 1;
        }
      }
      return {
        accountId: REMOTE_ACCOUNT_ID,
        state: `state-${state.version}`,
        list: [state.folder, state.node, state.legacyNode]
          .filter((node) => node && ids.includes(node.id)),
        notFound: [],
      };
    });

    await expect(pushSettings({ transport, account, handlers }))
      .resolves.toEqual({ ok: true });

    expect(settingsGets).toBe(4);
    expect(JSON.parse(state.blobs.get(state.node.blobId)!).settings).toEqual({
      concurrentOnly: true,
      legacyOnly: true,
    });
    const consolidation = transport.requests.flatMap((request) => request.methodCalls)
      .find(([name, params]) =>
        name === 'FileNode/set' && params.destroy?.includes('legacy-settings-node'));
    expect(consolidation?.[1].ifInState).toBe('state-2');
  });

  it('re-reads and retries a conditional write after stateMismatch', async () => {
    await handlers[DB_RPC.SETTINGS_APPLY_PATCH]({
      accountId: account.id,
      patch: { theme: 'dark' },
    });
    const { transport, state } = makeTransport(markedDocument({}, {}));
    let first = true;
    transport.handleError('FileNode/set', () => {
      if (!first) return null;
      first = false;
      return { type: 'stateMismatch' };
    });

    const result = await pushSettings({ transport, account, handlers });

    expect(result).toEqual({ ok: true });
    expect(state.setCalls).toBe(1);
    expect(transport.requests.filter((request) =>
      request.methodCalls[0][0] === 'FileNode/query'
      && request.methodCalls[0][1].filter?.name === SETTINGS_FILE_NAME)).toHaveLength(4);
    expect(JSON.parse(state.blobs.get(state.node.blobId)!).settings.theme).toBe('dark');
    expect(state.node.parentId).toBe(state.folder.id);
  });

  it('degrades to device-local behavior without account capability', async () => {
    const { transport } = makeTransport(null);
    delete transport.session.accounts[REMOTE_ACCOUNT_ID]
      .accountCapabilities[JMAP_CAPS.FILENODE];
    expect(await syncSettingsFromServer({ transport, account, handlers }))
      .toEqual({ ok: true, skipped: true });
    expect(await pushSettings({ transport, account, handlers }))
      .toEqual({ ok: true, skipped: true });
    expect(transport.requests).toHaveLength(0);
  });

  it('dispatches pushSettings through the modular outbox', async () => {
    const { transport } = makeTransport(null);
    delete transport.session.accounts[REMOTE_ACCOUNT_ID]
      .accountCapabilities[JMAP_CAPS.FILENODE];
    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: {
        id: 1,
        mutation_type: 'pushSettings',
        request_json: '{}',
      },
    });
    expect(result).toEqual({ ok: true, skipped: true });
  });
});
