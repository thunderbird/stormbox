import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';

import { DB_RPC } from '../../src/db/protocol';
import { THUNDERMAIL_FILE_NODE_FOLDER } from '../../src/sync/backends/jmap/file-node';
import {
  pushSettings,
  SETTINGS_FILE_NAME,
  syncSettingsFromServer,
} from '../../src/sync/backends/jmap/settings';
import {
  callMethod,
  createLiveIntegrationContext,
  FILE_NODE_USING,
} from './helpers/live-jmap';

const FILE_NODE_PROPERTIES = ['id', 'name', 'parentId', 'blobId', 'type'];

describe.sequential('live Stalwart settings document', () => {
  let context: Awaited<ReturnType<typeof createLiveIntegrationContext>>;

  function files(name: string, args: Record<string, unknown>, callId: string) {
    return callMethod(context.transport, FILE_NODE_USING, name, {
      accountId: context.account.remote_account_id,
      ...args,
    }, callId);
  }

  /** Every FileNode in the account; failures print the whole hierarchy. */
  async function allFileNodes(): Promise<any[]> {
    const result = await files('FileNode/get', {
      properties: FILE_NODE_PROPERTIES,
    }, 'hierarchy-all');
    return result.list ?? [];
  }

  /** Settings documents at any location, from this or an interrupted run. */
  async function destroySettingsDocuments() {
    const ids = (await allFileNodes())
      .filter((node) => node.name === SETTINGS_FILE_NAME)
      .map((node) => node.id);
    if (ids.length) {
      await files('FileNode/set', { destroy: ids }, 'cleanup-settings');
    }
  }

  beforeAll(async () => {
    context = await createLiveIntegrationContext();
    await destroySettingsDocuments();
  });

  afterAll(async () => {
    if (!context) return;
    try {
      await destroySettingsDocuments();
    } finally {
      await context.engine.close();
    }
  });

  it('stores the settings document directly under thundermail', async () => {
    await context.handlers[DB_RPC.SETTINGS_APPLY_PATCH]({
      accountId: context.account.id,
      patch: { theme: 'dark' },
    });

    await expect(pushSettings({
      transport: context.transport,
      account: context.account,
      handlers: context.handlers,
    })).resolves.toEqual({ ok: true });

    const allNodes = await allFileNodes();
    const [root] = allNodes.filter((node) =>
      node.name === THUNDERMAIL_FILE_NODE_FOLDER && node.parentId == null);
    expect(root).toBeDefined();
    expect(allNodes.filter((node) => node.name === SETTINGS_FILE_NAME))
      .toEqual([
        expect.objectContaining({
          parentId: root.id,
          type: 'application/json',
        }),
      ]);

    const legacyDocument = {
      owner: 'stormbox',
      documentType: 'user-settings',
      version: 1,
      settings: { theme: 'light', legacyLocation: true },
      updatedAt: {
        theme: Date.now() + 60_000,
        legacyLocation: Date.now() + 60_000,
      },
    };
    const upload = await context.transport.upload({
      accountId: context.account.remote_account_id,
      type: 'application/json',
      body: JSON.stringify(legacyDocument),
    });
    await files('FileNode/set', {
      create: {
        legacy: {
          parentId: null,
          name: SETTINGS_FILE_NAME,
          blobId: upload.blobId,
          type: 'application/json',
        },
      },
    }, 'create-legacy-settings');

    await expect(syncSettingsFromServer({
      transport: context.transport,
      account: context.account,
      handlers: context.handlers,
    })).resolves.toMatchObject({ ok: true, pulled: true, repairQueued: true });
    expect((await allFileNodes()).filter((node) =>
      node.name === SETTINGS_FILE_NAME && node.parentId == null)).toHaveLength(1);

    await expect(pushSettings({
      transport: context.transport,
      account: context.account,
      handlers: context.handlers,
    })).resolves.toEqual({ ok: true });
    expect((await allFileNodes()).filter((node) => node.name === SETTINGS_FILE_NAME))
      .toEqual([
        expect.objectContaining({
          parentId: root.id,
          type: 'application/json',
        }),
      ]);
    expect((await context.handlers[DB_RPC.SETTINGS_GET]({
      accountId: context.account.id,
    })).doc.settings).toMatchObject({
      theme: 'light',
      legacyLocation: true,
    });
  });
});
