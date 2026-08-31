import {
  describe,
  expect,
  it,
} from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';

describe('migration 013: contacts trash shards', () => {
  it('preserves the v12 document and projection while adding shard metadata', async () => {
    const engine = await bootTestEngine({ upTo: 12 });
    await engine.run(
      `INSERT INTO accounts(
         id, display_name, primary_email, server_origin, remote_account_id,
         created_at, updated_at
       ) VALUES (1, 'Me', 'me@example.com', 'https://mail.example.com', 'acct-1', 0, 0)`,
    );
    await engine.run(
      `INSERT INTO contacts_trash_documents(
         account_id, doc_json, remote_node_id, updated_at
       ) VALUES (1, '{"version":1}', 'legacy-node', 100)`,
    );
    await engine.run(
      `INSERT INTO contacts_trash(
         id, account_id, uid, prior_remote_id, original_addressbook_ids_json,
         snapshot_json, display_name, primary_email, trashed_at, expires_at,
         status, lifecycle_updated_at, updated_at
       ) VALUES (
         10, 1, 'uid-1', 'card-1', '["book-1"]',
         '{"uid":"uid-1"}', 'Person', 'person@example.com', 100, 200,
         'trashed', 100, 100
       )`,
    );
    await engine.run(
      `INSERT INTO contacts_trash_emails(
         trash_id, account_id, position, email, email_key
       ) VALUES (10, 1, 0, 'Person@Example.com', 'person@example.com')`,
    );

    await engine.runMigrations({ upTo: 13 });

    expect(Number((await engine.get('PRAGMA user_version'))?.user_version)).toBe(13);
    expect(await engine.get(
      `SELECT shard_name, doc_json, remote_node_id, remote_blob_id,
              dirty, local_revision
         FROM contacts_trash_documents
        WHERE account_id = 1`,
    )).toEqual({
      shard_name: 'stormbox-contacts-trash.json',
      doc_json: '{"version":1}',
      remote_node_id: 'legacy-node',
      remote_blob_id: null,
      dirty: 0,
      local_revision: 1,
    });
    expect((await engine.all('PRAGMA table_info(contacts_trash_state)'))
      .map((column) => column.name)).toContain('open_tombstone_shard_name');
    expect(await engine.get(
      `SELECT media_json, projection_fingerprint
         FROM contacts_trash
        WHERE id = 10`,
    )).toEqual({ media_json: '[]', projection_fingerprint: '' });
    expect(await engine.get(
      `SELECT email_key
         FROM contacts_trash_emails
        WHERE trash_id = 10`,
    )).toEqual({ email_key: 'person@example.com' });
    expect((await engine.all('PRAGMA table_info(contacts_trash_emails)'))
      .map((column) => column.name)).not.toContain('email');
    expect(await engine.all('PRAGMA foreign_key_check')).toEqual([]);
    await engine.close();
  });
});
