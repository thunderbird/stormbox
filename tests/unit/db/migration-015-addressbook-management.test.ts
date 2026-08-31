import {
  describe,
  expect,
  it,
} from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';

describe('migration 015: address book management', () => {
  it('adds ordering and fail-closed delete rights without replacing books', async () => {
    const engine = await bootTestEngine({ upTo: 14 });
    await engine.run(
      `INSERT INTO accounts(
         id, display_name, primary_email, server_origin, remote_account_id,
         created_at, updated_at
       ) VALUES (1, 'Me', 'me@example.com', 'https://mail.example.com', 'acct-1', 0, 0)`,
    );
    await engine.run(
      `INSERT INTO addressbooks(
         id, account_id, service_kind, remote_id, name, is_default,
         is_subscribed, is_deleted, updated_at
       ) VALUES (20, 1, 'jmap-contacts', 'book-1', 'Personal', 1, 1, 0, 1)`,
    );

    await engine.runMigrations({ upTo: 15 });

    expect(Number((await engine.get('PRAGMA user_version'))?.user_version)).toBe(15);
    expect(await engine.get(
      'SELECT id, sort_order, may_delete FROM addressbooks WHERE id = 20',
    )).toEqual({ id: 20, sort_order: 0, may_delete: null });
    expect(await engine.all('PRAGMA foreign_key_check')).toEqual([]);
    await engine.close();
  });
});
