import {
  describe,
  expect,
  it,
} from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';

describe('migration 010: address-book rights', () => {
  it('adds fail-closed write rights without invalidating contact data', async () => {
    const engine = await bootTestEngine({ upTo: 9 });
    await engine.run(
      `INSERT INTO accounts(
         id, display_name, primary_email, server_origin, remote_account_id,
         created_at, updated_at
       ) VALUES (1, 'Me', 'me@example.com', 'https://mail.example.com', 'acct-1', 0, 0)`,
    );
    await engine.run(
      `INSERT INTO addressbooks(
         id, account_id, service_kind, remote_id, name, updated_at
       ) VALUES (10, 1, 'jmap_contacts', 'book-1', 'Contacts', 0)`,
    );
    await engine.run(
      `INSERT INTO contacts(
         id, account_id, remote_id, display_name, is_deleted, updated_at
       ) VALUES (20, 1, 'card-1', 'Person', 0, 0)`,
    );
    await engine.run(
      'INSERT INTO addressbook_contacts(contact_id, addressbook_id) VALUES (20, 10)',
    );

    await engine.runMigrations();

    expect(Number((await engine.get('PRAGMA user_version'))?.user_version)).toBe(10);
    expect(await engine.get(
      'SELECT remote_id, may_write FROM addressbooks WHERE id = 10',
    )).toEqual({ remote_id: 'book-1', may_write: null });
    expect(Number((await engine.get(
      'SELECT COUNT(*) AS count FROM contacts WHERE id = 20',
    ))?.count)).toBe(1);
    await expect(engine.run(
      'UPDATE addressbooks SET may_write = 2 WHERE id = 10',
    )).rejects.toThrow();
    await engine.close();
  });
});
