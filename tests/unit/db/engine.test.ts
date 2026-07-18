import { describe, it, expect } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';

describe('Engine migrations', () => {
  it('records the applied migration version via PRAGMA user_version on a fresh database', async () => {
    const engine = await bootTestEngine();
    const row = await engine.get('PRAGMA user_version');
    expect(Number(row?.user_version)).toBe(5);
    await engine.close();
  });

  it('creates every expected table with the right indexes', async () => {
    const engine = await bootTestEngine();
    const tables = await engine.all(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    );
    const names = tables.map((row) => row.name);
    const expected = [
      'accounts',
      'account_capabilities',
      'account_services',
      'addressbooks',
      'body_parts',
      'body_values',
      'contact_emails',
      'contacts',
      'folder_messages',
      'folders',
      'identities',
      'message_addresses',
      'message_keywords',
      'messages',
      'pending_mutations',
      'query_view_items',
      'query_view_ranges',
      'query_views',
      'sync_jobs',
      'sync_states',
      'threads',
    ];
    for (const t of expected) {
      expect(names).toContain(t);
    }

    const indexes = await engine.all(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`,
    );
    const indexNames = indexes.map((row) => row.name);
    const requiredIndexes = [
      'folders_account_parent_sort',
      'folders_account_role',
      'messages_account_received',
      'messages_account_sent',
      'messages_thread',
      'messages_unread',
      'messages_flagged',
      'messages_account_msgid',
      'messages_account_attachment_received',
      'folder_messages_by_folder_received',
      'folder_messages_by_folder_sent',
      'message_addresses_email',
      'message_keywords_keyword',
      'body_parts_attachments',
      'body_values_lru',
      'query_view_items_message',
      'sync_jobs_ready',
      'pending_mutations_ready',
      'query_views_lru',
      'contacts_account_display_name',
      'contacts_account_uid',
      'contact_emails_lookup',
    ];
    for (const idx of requiredIndexes) {
      expect(indexNames).toContain(idx);
    }
    await engine.close();
  });

  it('is idempotent on repeated boots of the same engine', async () => {
    const engine = await bootTestEngine();
    await engine.runMigrations();
    await engine.runMigrations();
    const row = await engine.get('PRAGMA user_version');
    expect(Number(row?.user_version)).toBe(5);
    await engine.close();
  });
});

describe('Engine basic CRUD', () => {
  it('binds 64-bit integers without truncation', async () => {
    const engine = await bootTestEngine();
    const big = 1_700_000_000_000;
    await engine.run(`CREATE TEMP TABLE tmp_big(v INTEGER)`);
    await engine.run(`INSERT INTO tmp_big(v) VALUES (?)`, [big]);
    const row = await engine.get(`SELECT v FROM tmp_big`);
    expect(Number(row.v)).toBe(big);
    await engine.close();
  });

  it('rolls back transactions on throw', async () => {
    const engine = await bootTestEngine();
    await engine.exec('CREATE TEMP TABLE tmp_tx(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const before = await engine.all('SELECT COUNT(*) AS n FROM tmp_tx');
    await expect(
      engine.transaction(async (tx) => {
        await tx.run('INSERT INTO tmp_tx(key, value) VALUES (?, ?)', ['extra', 'x']);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const after = await engine.all('SELECT COUNT(*) AS n FROM tmp_tx');
    expect(Number(after[0].n)).toBe(Number(before[0].n));
    await engine.close();
  });

  it('commits transactions on resolve', async () => {
    const engine = await bootTestEngine();
    await engine.exec('CREATE TEMP TABLE tmp_tx(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    await engine.transaction(async (tx) => {
      await tx.run('INSERT INTO tmp_tx(key, value) VALUES (?, ?)', ['committed', 'yes']);
    });
    const row = await engine.get('SELECT value FROM tmp_tx WHERE key = ?', ['committed']);
    expect(row.value).toBe('yes');
    await engine.close();
  });
});
