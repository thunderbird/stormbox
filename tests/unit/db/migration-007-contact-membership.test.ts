import { describe, expect, it } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';

/**
 * The v7 rebuild of `contacts`, against the data it has to carry forward.
 *
 * A migration that rewrites existing rows cannot be judged by the schema it
 * leaves behind. What matters is what survives it: a fresh database proves
 * nothing, so each case here builds a v6 database, fills it the way the old
 * code would have, and then runs the migration.
 */

/** A v6 database with an account and two address books. */
async function legacyEngine() {
  const engine = await bootTestEngine({ upTo: 6 });
  const version = await engine.get('PRAGMA user_version');
  expect(Number(version?.user_version), 'the fixture must predate v7').toBe(6);

  await engine.run(
    `INSERT INTO accounts(
       id, display_name, primary_email, server_origin, remote_account_id,
       created_at, updated_at
     ) VALUES (1, 'Me', 'me@example.com', 'https://mail.example.com', 'acct-1', 0, 0)`,
  );
  for (const [id, name] of [[10, 'Personal'], [11, 'Work']] as const) {
    await engine.run(
      `INSERT INTO addressbooks(id, account_id, service_kind, remote_id, name, updated_at)
       VALUES (?, 1, 'jmap_contacts', ?, ?, 0)`,
      [id, `ab-${id}`, name],
    );
  }
  return engine;
}

async function legacyContact(engine: any, {
  id, book, remoteId, name, email,
}: { id: number; book: number; remoteId: string; name: string; email: string }) {
  await engine.run(
    `INSERT INTO contacts(
       id, account_id, addressbook_id, remote_id, display_name, full_name, updated_at
     ) VALUES (?, 1, ?, ?, ?, ?, 0)`,
    [id, book, remoteId, name, name],
  );
  await engine.run(
    `INSERT INTO contact_emails(contact_id, position, email, is_preferred)
     VALUES (?, 0, ?, 1)`,
    [id, email],
  );
}

/** Apply everything from v7 onwards. */
async function upgrade(engine: any) {
  await engine.runMigrations();
}

describe('migration 007: contact membership', () => {
  it('keeps every contact and every address', async () => {
    const engine = await legacyEngine();
    await legacyContact(engine, {
      id: 100, book: 10, remoteId: 'card-a', name: 'Ada', email: 'ada@example.com',
    });
    await legacyContact(engine, {
      id: 101, book: 11, remoteId: 'card-b', name: 'Grace', email: 'grace@example.com',
    });

    await upgrade(engine);

    const rows = await engine.all(
      `SELECT c.remote_id, c.display_name, ce.email
         FROM contacts c JOIN contact_emails ce ON ce.contact_id = c.id
        ORDER BY c.remote_id`,
    );
    expect(rows).toEqual([
      { remote_id: 'card-a', display_name: 'Ada', email: 'ada@example.com' },
      { remote_id: 'card-b', display_name: 'Grace', email: 'grace@example.com' },
    ]);
    await engine.close();
  });

  it('carries each contact into the book it was filed under', async () => {
    const engine = await legacyEngine();
    await legacyContact(engine, {
      id: 100, book: 10, remoteId: 'card-a', name: 'Ada', email: 'ada@example.com',
    });
    await legacyContact(engine, {
      id: 101, book: 11, remoteId: 'card-b', name: 'Grace', email: 'grace@example.com',
    });

    await upgrade(engine);

    const membership = await engine.all(
      `SELECT c.remote_id, ac.addressbook_id
         FROM addressbook_contacts ac JOIN contacts c ON c.id = ac.contact_id
        ORDER BY c.remote_id`,
    );
    expect(membership).toEqual([
      { remote_id: 'card-a', addressbook_id: 10 },
      { remote_id: 'card-b', addressbook_id: 11 },
    ]);
    await engine.close();
  });

  it('folds a card duplicated across books into one contact in both', async () => {
    // The old uniqueness key included the book, so one card filed in two
    // books was two rows — the duplication this migration exists to undo.
    const engine = await legacyEngine();
    await legacyContact(engine, {
      id: 100, book: 10, remoteId: 'card-a', name: 'Ada', email: 'ada@example.com',
    });
    await legacyContact(engine, {
      id: 200, book: 11, remoteId: 'card-a', name: 'Ada', email: 'ada@example.com',
    });

    await upgrade(engine);

    const contacts = await engine.all('SELECT id, remote_id FROM contacts');
    expect(contacts, 'one card is one contact').toEqual([{ id: 100, remote_id: 'card-a' }]);
    const books = await engine.all(
      'SELECT addressbook_id FROM addressbook_contacts WHERE contact_id = 100 ORDER BY addressbook_id',
    );
    expect(books, 'and it is still in both books').toEqual([
      { addressbook_id: 10 },
      { addressbook_id: 11 },
    ]);
    await engine.close();
  });

  it('leaves no address behind pointing at a contact that is gone', async () => {
    // The emails of a folded duplicate must not survive as orphans: they
    // would be invisible to every join and would come back as ghosts if the
    // id were ever reused.
    const engine = await legacyEngine();
    await legacyContact(engine, {
      id: 100, book: 10, remoteId: 'card-a', name: 'Ada', email: 'ada@example.com',
    });
    await legacyContact(engine, {
      id: 200, book: 11, remoteId: 'card-a', name: 'Ada', email: 'ada@example.com',
    });

    await upgrade(engine);

    const orphans = await engine.all(
      `SELECT contact_id FROM contact_emails
        WHERE contact_id NOT IN (SELECT id FROM contacts)`,
    );
    expect(orphans).toEqual([]);
    await engine.close();
  });

  it('starts every carried-forward contact at generation zero', async () => {
    // Zero is older than any generation a sync will allocate, so the first
    // full sync after the upgrade re-stamps what the server still has and
    // sweeps what it does not.
    const engine = await legacyEngine();
    await legacyContact(engine, {
      id: 100, book: 10, remoteId: 'card-a', name: 'Ada', email: 'ada@example.com',
    });

    await upgrade(engine);

    const row = await engine.get('SELECT sync_generation FROM contacts WHERE id = 100');
    expect(row.sync_generation).toBe(0);
    await engine.close();
  });

  it('upgrades an empty database without complaint', async () => {
    const engine = await legacyEngine();

    await upgrade(engine);

    // `_` is a single-character wildcard in LIKE, hence the escape: without
    // it this matches every table and passes for the wrong reason.
    const tables = await engine.all(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE '\\_%' ESCAPE '\\'`,
    );
    expect(tables, 'the scratch tables must not outlive the migration').toEqual([]);
    await engine.close();
  });

  it('still cascades addresses when a contact is deleted', async () => {
    // The rebuild drops and recreates contact_emails; a foreign key that
    // came back without its cascade would leak a row per deleted contact.
    const engine = await legacyEngine();
    await legacyContact(engine, {
      id: 100, book: 10, remoteId: 'card-a', name: 'Ada', email: 'ada@example.com',
    });
    await upgrade(engine);

    await engine.run('DELETE FROM contacts WHERE id = 100');

    const left = await engine.all('SELECT contact_id FROM contact_emails');
    expect(left).toEqual([]);
    const membership = await engine.all('SELECT contact_id FROM addressbook_contacts');
    expect(membership, 'membership goes with the contact too').toEqual([]);
    await engine.close();
  });

  it('drops a contact from a book that is removed, and keeps the contact', async () => {
    const engine = await legacyEngine();
    await legacyContact(engine, {
      id: 100, book: 10, remoteId: 'card-a', name: 'Ada', email: 'ada@example.com',
    });
    await upgrade(engine);
    await engine.run(
      'INSERT INTO addressbook_contacts(contact_id, addressbook_id) VALUES (100, 11)',
    );

    await engine.run('DELETE FROM addressbooks WHERE id = 11');

    const books = await engine.all(
      'SELECT addressbook_id FROM addressbook_contacts WHERE contact_id = 100',
    );
    expect(books).toEqual([{ addressbook_id: 10 }]);
    const contact = await engine.get('SELECT remote_id FROM contacts WHERE id = 100');
    expect(contact?.remote_id, 'a card outlives any one book it was in').toBe('card-a');
    await engine.close();
  });
});
