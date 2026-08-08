import { describe, expect, it } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';

describe('migration 011 recipient usage', () => {
  it('replaces durable recipient history with an empty rebuildable cache', async () => {
    const engine = await bootTestEngine({ upTo: 10 });
    await engine.run(
      `INSERT INTO accounts(
         id, display_name, primary_email, server_origin, remote_account_id,
         created_at, updated_at
       ) VALUES (1, 'Me', 'me@example.com', 'https://mail.example.com', 'acct', 0, 0)`,
    );
    await engine.run(
      `INSERT INTO recipient_history(
         account_id, email, email_key, send_count, last_sent_at, created_at, updated_at
       ) VALUES (1, 'old@example.com', 'old@example.com', 8, 10, 0, 0)`,
    );
    await engine.run(
      `INSERT INTO sync_states(account_id, object_type, scope, state, updated_at)
       VALUES (1, 'RecipientHistoryBackfill', '', '{}', 0)`,
    );

    await engine.runMigrations({ upTo: 11 });

    expect(Number((await engine.get('PRAGMA user_version'))?.user_version)).toBe(11);
    expect(await engine.all('SELECT * FROM recipient_usage')).toEqual([]);
    expect(await engine.get(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'recipient_history'`,
    )).toBeNull();
    expect(await engine.get(
      `SELECT state FROM sync_states
        WHERE object_type = 'RecipientHistoryBackfill'`,
    )).toBeNull();
    await engine.close();
  });
});
