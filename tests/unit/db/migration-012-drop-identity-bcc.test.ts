import { describe, expect, it } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';

describe('migration 012 drop identity Bcc', () => {
  it('removes the unused column while preserving identity data', async () => {
    const engine = await bootTestEngine({ upTo: 11 });
    await engine.run(
      `INSERT INTO accounts(
         id, display_name, primary_email, server_origin, remote_account_id,
         created_at, updated_at
       ) VALUES (1, 'Me', 'me@example.com', 'https://mail.example.com', 'acct', 0, 0)`,
    );
    await engine.run(
      `INSERT INTO identities(
         id, account_id, remote_id, name, email, reply_to_json, bcc_json,
         raw_json, updated_at
       ) VALUES (
         2, 1, 'identity', 'Me', 'me@example.com', '[{"email":"reply@example.com"}]',
         '[{"email":"archive@example.com"}]', '{"id":"identity"}', 10
       )`,
    );

    await engine.runMigrations();

    expect(Number((await engine.get('PRAGMA user_version'))?.user_version)).toBe(12);
    expect((await engine.all('PRAGMA table_info(identities)'))
      .map((column) => column.name)).not.toContain('bcc_json');
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
