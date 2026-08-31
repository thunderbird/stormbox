import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { MUTATION_TYPE } from '../../../src/constants/states';
import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';

let engine: any;
let handlers: Record<string, (params: any) => Promise<any>>;
let accountId: number;

beforeEach(async () => {
  engine = await bootTestEngine();
  handlers = makeHandlers(engine);
  const account = await handlers[DB_RPC.ACCOUNT_UPSERT]({
    displayName: 'Settings User',
    primaryEmail: 'settings@example.com',
    serverOrigin: 'https://mail.example.com',
    remoteAccountId: 'settings-account',
    isPrimary: true,
  });
  accountId = account.row.id;
});

afterEach(async () => {
  await engine.close();
});

describe('settings handlers', () => {
  it('commits a local patch and one push row atomically', async () => {
    await engine.exec(`
      CREATE TRIGGER reject_settings_push
      BEFORE INSERT ON pending_mutations
      WHEN NEW.mutation_type = 'pushSettings'
      BEGIN
        SELECT RAISE(ABORT, 'reject settings push');
      END;
    `);

    await expect(handlers[DB_RPC.SETTINGS_APPLY_PATCH]({
      accountId,
      patch: { theme: 'dark' },
    })).rejects.toThrow(/reject settings push/);
    expect(await engine.get(
      'SELECT COUNT(*) AS count FROM user_settings WHERE account_id = ?',
      [accountId],
    )).toEqual({ count: 0 });
    expect(await engine.get(
      'SELECT COUNT(*) AS count FROM pending_mutations WHERE account_id = ?',
      [accountId],
    )).toEqual({ count: 0 });
  });

  it('reuses and resets the eligible push row', async () => {
    const first = await handlers[DB_RPC.SETTINGS_APPLY_PATCH]({
      accountId,
      patch: { theme: 'dark' },
    });
    await engine.run(
      `UPDATE pending_mutations
          SET local_status = 'retry', attempts = 4, not_before = 999999,
              error_json = '{"type":"serverFail"}'
        WHERE id = ?`,
      [first.mutation.id],
    );

    const second = await handlers[DB_RPC.SETTINGS_APPLY_PATCH]({
      accountId,
      patch: { theme: 'light' },
    });
    expect(second.mutation).toEqual({ id: first.mutation.id, reused: true });
    expect(await engine.get(
      `SELECT COUNT(*) AS count FROM pending_mutations
        WHERE account_id = ? AND mutation_type = ?`,
      [accountId, MUTATION_TYPE.PUSH_SETTINGS],
    )).toEqual({ count: 1 });
    expect(await engine.get(
      `SELECT local_status, attempts, not_before, error_json
         FROM pending_mutations WHERE id = ?`,
      [first.mutation.id],
    )).toEqual({
      local_status: 'pending',
      attempts: 0,
      not_before: null,
      error_json: null,
    });
  });

  it('notifies the outbox only after the transaction is visible', async () => {
    let observed: Promise<any> | null = null;
    handlers = makeHandlers(engine, undefined, {
      onMutationInserted: ({ mutationId }) => {
        observed = Promise.all([
          engine.get('SELECT id FROM pending_mutations WHERE id = ?', [mutationId]),
          engine.get('SELECT doc_json FROM user_settings WHERE account_id = ?', [accountId]),
        ]);
      },
    });
    const result = await handlers[DB_RPC.SETTINGS_APPLY_PATCH]({
      accountId,
      patch: { theme: 'dark' },
    });
    const [mutation, row] = await observed!;
    expect(mutation.id).toBe(result.mutation.id);
    expect(JSON.parse(row.doc_json).settings.theme).toBe('dark');
  });

  it('merges remote values per key and queues one repair', async () => {
    await handlers[DB_RPC.SETTINGS_APPLY_PATCH]({
      accountId,
      patch: { theme: 'dark', localOnly: 'kept' },
    });
    const before = await handlers[DB_RPC.SETTINGS_GET]({ accountId });
    const localStamp = before.doc.updatedAt.theme;
    const result = await handlers[DB_RPC.SETTINGS_MERGE_REMOTE]({
      accountId,
      doc: {
        owner: 'stormbox',
        documentType: 'user-settings',
        version: 1,
        settings: { theme: 'light', remoteOnly: 'added' },
        updatedAt: { theme: localStamp - 1, remoteOnly: localStamp + 1 },
      },
      remoteNodeId: 'node-1',
    });

    expect(result.localNewer).toBe(true);
    expect(result.doc.settings).toEqual({
      theme: 'dark',
      localOnly: 'kept',
      remoteOnly: 'added',
    });
    expect(result.mutation).not.toBeNull();
    expect(await engine.get(
      `SELECT COUNT(*) AS count FROM pending_mutations
        WHERE account_id = ? AND mutation_type = 'pushSettings'
          AND local_status IN ('pending','retry')`,
      [accountId],
    )).toEqual({ count: 1 });
  });
});
