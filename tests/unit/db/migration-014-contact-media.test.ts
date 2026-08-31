import {
  describe,
  expect,
  it,
} from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';

describe('migration 014: contact media', () => {
  it('adds media without invalidating contact ids used by pending mutations', async () => {
    const engine = await bootTestEngine({ upTo: 13 });
    await engine.run(
      `INSERT INTO accounts(
         id, display_name, primary_email, server_origin, remote_account_id,
         created_at, updated_at
       ) VALUES (1, 'Me', 'me@example.com', 'https://mail.example.com', 'acct-1', 0, 0)`,
    );
    await engine.run(
      `INSERT INTO contacts(
         id, account_id, remote_id, display_name, raw_json, is_deleted, updated_at
       ) VALUES (20, 1, 'card-1', 'Photo Contact', '{"media":{}}', 0, 1)`,
    );
    await engine.run(
      `INSERT INTO sync_states(account_id, object_type, scope, state, updated_at)
       VALUES
         (1, 'ContactCard', '', 'stale-contact-state', 1),
         (1, 'AddressBook', '', 'keep-addressbook-state', 1)`,
    );
    await engine.run(
      `INSERT INTO pending_mutations(
         account_id, mutation_type, request_json, created_at, updated_at
       ) VALUES (1, 'updateContact', '{"contactId":20}', 1, 1)`,
    );

    await engine.runMigrations({ upTo: 14 });

    expect(Number((await engine.get('PRAGMA user_version'))?.user_version)).toBe(14);
    expect(await engine.all('SELECT id FROM contacts')).toEqual([{ id: 20 }]);
    expect(await engine.all(
      'SELECT request_json FROM pending_mutations',
    )).toEqual([{ request_json: '{"contactId":20}' }]);
    expect(await engine.all(
      'SELECT object_type, state FROM sync_states ORDER BY object_type',
    )).toEqual([{ object_type: 'AddressBook', state: 'keep-addressbook-state' }]);

    await engine.run(
      `INSERT INTO contacts(
         id, account_id, remote_id, display_name, is_deleted, updated_at
       ) VALUES (21, 1, 'card-2', 'Fresh Photo', 0, 2)`,
    );
    await engine.run(
      `INSERT INTO contact_media(
         contact_id, position, map_key, kind, uri, media_type, pref
       ) VALUES (21, 0, 'avatar', 'photo', 'data:image/png;base64,AA==', 'image/png', 1)`,
    );
    await engine.run('DELETE FROM contacts WHERE id = 21');

    expect(await engine.all('SELECT * FROM contact_media')).toEqual([]);
    expect(await engine.all('PRAGMA foreign_key_check')).toEqual([]);
    await engine.close();
  });
});
