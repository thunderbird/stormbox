import { describe, expect, it } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';

describe('migration 008: recipient usage', () => {
  it('adds the keyed usage cache without transient recipient or identity storage', async () => {
    const engine = await bootTestEngine({ upTo: 5 });
    await engine.run(
      `INSERT INTO accounts(
         id, display_name, primary_email, server_origin, remote_account_id,
         created_at, updated_at
       ) VALUES (1, 'Me', 'me@example.com', 'https://mail.example.com', 'acct', 0, 0)`,
    );
    await engine.run(
      `INSERT INTO identities(
         id, account_id, remote_id, name, email, reply_to_json, raw_json, updated_at
       ) VALUES (
         2, 1, 'identity', 'Me', 'me@example.com',
         '[{"email":"reply@example.com"}]', '{"id":"identity"}', 10
       )`,
    );

    // Each unreleased version is inspected so neither discarded schema
    // appears temporarily on the v5-to-v8 upgrade path.
    for (const version of [6, 7, 8]) {
      await engine.runMigrations({ upTo: version });
      expect(Number((await engine.get('PRAGMA user_version'))?.user_version)).toBe(version);
      expect((await engine.all('PRAGMA table_info(identities)'))
        .map((column) => column.name)).not.toContain('bcc_json');
      expect(await engine.get(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'recipient_history'`,
      )).toBeNull();
    }

    expect(await engine.all('SELECT * FROM recipient_usage')).toEqual([]);
    expect((await engine.all('PRAGMA table_info(recipient_usage)'))
      .filter((column) => Number(column.pk) > 0)
      .map((column) => [column.name, Number(column.pk)])).toEqual([
      ['account_id', 1],
      ['email_key', 2],
    ]);
    expect(await engine.get(
      `SELECT id, account_id, remote_id, name, email, reply_to_json, raw_json, updated_at
         FROM identities WHERE id = 2`,
    )).toEqual({
      id: 2,
      account_id: 1,
      remote_id: 'identity',
      name: 'Me',
      email: 'me@example.com',
      reply_to_json: '[{"email":"reply@example.com"}]',
      raw_json: '{"id":"identity"}',
      updated_at: 10,
    });
    await engine.close();
  });
});
