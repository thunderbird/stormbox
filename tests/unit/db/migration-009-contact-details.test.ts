import { describe, expect, it } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';

async function legacyDetailEngine() {
  const engine = await bootTestEngine({ upTo: 8 });
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
       id, account_id, remote_id, uid, full_name, display_name, organization,
       raw_json, sync_generation, is_deleted, updated_at
     ) VALUES (
       20, 1, 'card-1', 'legacy-uid', 'Legacy Person', 'Legacy Person', 'Legacy Org',
       '{"id":"card-1","x-unknown":{"kept":true}}', 12, 0, 99
     )`,
  );
  await engine.run(
    `INSERT INTO contact_emails(
       contact_id, account_id, position, email, email_key, label, is_preferred
     ) VALUES (20, 1, 0, 'legacy@example.com', 'legacy@example.com', 'Work', 1)`,
  );
  await engine.run(
    `INSERT INTO addressbook_contacts(contact_id, addressbook_id) VALUES (20, 10)`,
  );
  await engine.run(
    `INSERT INTO contact_search_tokens(contact_id, account_id, token)
     VALUES (20, 1, 'legacy')`,
  );
  await engine.run(
    `INSERT INTO pending_mutations(
       id, account_id, mutation_type, request_json, created_at, updated_at
     ) VALUES
       (30, 1, 'createContact', '{"uid":"pending-contact"}', 1, 1),
       (31, 1, 'updateIdentity', '{"remoteId":"identity-1"}', 2, 2)`,
  );
  await engine.run(
    `INSERT INTO identities(
       id, account_id, remote_id, name, email, reply_to_json, raw_json, updated_at
     ) VALUES (
       40, 1, 'identity-1', NULL, 'me@example.com',
       '[{"name":null,"email":"reply@example.com"}]',
       '{"id":"identity-1","name":null,"email":"me@example.com","replyTo":[{"name":null,"email":"reply@example.com"}],"bcc":[],"textSignature":"","htmlSignature":"<div></div>","mayDelete":false}',
       3
     )`,
  );
  await engine.run(
    `INSERT INTO recipient_usage(account_id, email_key, send_count, last_sent_at)
     VALUES (1, 'legacy@example.com', 3, 99)`,
  );
  await engine.run(
    `INSERT INTO sync_states(account_id, object_type, scope, state, updated_at)
     VALUES
       (1, 'ContactCard', '', 'stale-contact-state', 1),
       (1, 'AddressBook', '', 'keep-addressbook-state', 1)`,
  );
  return engine;
}

describe('migration 009: keyed contact details', () => {
  it('invalidates cached contacts while preserving durable independent state', async () => {
    const engine = await legacyDetailEngine();

    await engine.runMigrations({ upTo: 9 });

    expect(Number((await engine.get('PRAGMA user_version'))?.user_version)).toBe(9);
    for (const table of [
      'contacts',
      'contact_emails',
      'addressbook_contacts',
      'contact_search_tokens',
      'contact_phones',
      'contact_links',
      'contact_anniversaries',
      'contact_notes',
      'contact_organizations',
      'contact_organization_units',
      'contact_titles',
    ]) {
      expect(Number((await engine.get(`SELECT COUNT(*) AS count FROM ${table}`))?.count))
        .toBe(0);
    }
    expect(await engine.all(
      'SELECT id, remote_id FROM addressbooks',
    )).toEqual([{ id: 10, remote_id: 'book-1' }]);
    expect(await engine.all(
      'SELECT id, mutation_type, request_json FROM pending_mutations ORDER BY id',
    )).toEqual([
      {
        id: 30,
        mutation_type: 'createContact',
        request_json: '{"uid":"pending-contact"}',
      },
      {
        id: 31,
        mutation_type: 'updateIdentity',
        request_json: '{"remoteId":"identity-1"}',
      },
    ]);
    expect(await engine.all(
      `SELECT remote_id, name, reply_to_json, bcc_json, text_signature,
              html_signature, may_delete
         FROM identities`,
    )).toEqual([{
      remote_id: 'identity-1',
      name: '',
      reply_to_json: '[{"name":null,"email":"reply@example.com"}]',
      bcc_json: '[]',
      text_signature: '',
      html_signature: '<div></div>',
      may_delete: 0,
    }]);
    expect(await engine.all(
      'SELECT email_key, send_count, last_sent_at FROM recipient_usage',
    )).toEqual([{
      email_key: 'legacy@example.com',
      send_count: 3,
      last_sent_at: 99,
    }]);
    expect(await engine.all(
      'SELECT object_type, state FROM sync_states ORDER BY object_type',
    )).toEqual([{
      object_type: 'AddressBook',
      state: 'keep-addressbook-state',
    }]);
    expect(await engine.all('PRAGMA foreign_key_check')).toEqual([]);
    await engine.close();
  });

  it('cascades every normalized detail table from its contact', async () => {
    const engine = await legacyDetailEngine();
    await engine.runMigrations();
    await engine.run(
      `INSERT INTO contacts(
         id, account_id, remote_id, display_name, is_deleted, updated_at
       ) VALUES (20, 1, 'card-new', 'Fresh Person', 0, 100)`,
    );
    await engine.run(
      `INSERT INTO contact_emails(
         contact_id, account_id, position, email, email_key, is_preferred
       ) VALUES (20, 1, 0, 'fresh@example.com', 'fresh@example.com', 1)`,
    );
    await engine.run(
      `INSERT INTO addressbook_contacts(contact_id, addressbook_id) VALUES (20, 10)`,
    );
    await engine.run(
      `INSERT INTO contact_search_tokens(contact_id, account_id, token)
       VALUES (20, 1, 'fresh')`,
    );
    await engine.run(
      `INSERT INTO contact_organizations(
         contact_id, position, map_key, name, contexts_json
       ) VALUES (20, 0, 'org1', 'Example', '["work"]')`,
    );
    await engine.run(
      `INSERT INTO contact_organization_units(
         contact_id, organization_position, position, value
       ) VALUES (20, 0, 0, 'Research')`,
    );
    await engine.run(
      `INSERT INTO contact_phones(
         contact_id, position, map_key, value, contexts_json, features_json
       ) VALUES (20, 0, 'phone1', 'tel:+15551234', '[]', '["voice"]')`,
    );
    await engine.run(
      `INSERT INTO contact_links(
         contact_id, position, map_key, value, contexts_json
       ) VALUES (20, 0, 'link1', 'https://example.com', '[]')`,
    );
    await engine.run(
      `INSERT INTO contact_anniversaries(
         contact_id, position, map_key, kind, date_kind, date_year, date_month, date_day
       ) VALUES (20, 0, 'date1', 'birth', 'partial', 2000, 2, 29)`,
    );
    await engine.run(
      `INSERT INTO contact_notes(contact_id, position, map_key, value)
       VALUES (20, 0, 'note1', 'Hello')`,
    );
    await engine.run(
      `INSERT INTO contact_titles(
         contact_id, position, map_key, value, kind, organization_map_key
       ) VALUES (20, 0, 'title1', 'Engineer', 'title', 'org1')`,
    );

    await engine.run('DELETE FROM contacts WHERE id = 20');

    for (const table of [
      'contact_emails',
      'contact_phones',
      'contact_links',
      'contact_anniversaries',
      'contact_notes',
      'contact_organizations',
      'contact_organization_units',
      'contact_titles',
      'addressbook_contacts',
      'contact_search_tokens',
    ]) {
      expect(Number((await engine.get(`SELECT COUNT(*) AS count FROM ${table}`))?.count))
        .toBe(0);
    }
    expect(await engine.all('PRAGMA foreign_key_check')).toEqual([]);
    await engine.close();
  });

  it('accepts month-only partial dates and rejects day without month', async () => {
    const engine = await legacyDetailEngine();
    await engine.runMigrations();
    await engine.run(
      `INSERT INTO contacts(
         id, account_id, remote_id, display_name, is_deleted, updated_at
       ) VALUES (20, 1, 'card-new', 'Fresh Person', 0, 100)`,
    );

    await expect(engine.run(
      `INSERT INTO contact_anniversaries(
         contact_id, position, map_key, kind, date_kind, date_year, date_month, date_day
       ) VALUES (20, 0, 'month-only', 'birth', 'partial', NULL, 5, NULL)`,
    )).resolves.toBeDefined();
    await expect(engine.run(
      `INSERT INTO contact_anniversaries(
         contact_id, position, map_key, kind, date_kind, date_year, date_month, date_day
       ) VALUES (20, 1, 'day-only', 'birth', 'partial', NULL, NULL, 12)`,
    )).rejects.toThrow();

    await engine.close();
  });
});
