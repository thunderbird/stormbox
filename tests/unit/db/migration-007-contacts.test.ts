import { describe, expect, it } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers, noopBroadcaster } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';

/**
 * The consolidated contact migration against released-v5 data.
 *
 * A migration that rewrites existing rows cannot be judged by the schema it
 * leaves behind. What matters is what survives it: a fresh database proves
 * nothing, so each case builds a v5 database, fills it with the rows the
 * migration must carry forward, and upgrades through v8.
 */

/** A v5 database with an account and two address books. */
async function legacyEngine() {
  const engine = await bootTestEngine({ upTo: 5 });
  const version = await engine.get('PRAGMA user_version');
  expect(Number(version?.user_version), 'the fixture must match the released schema').toBe(5);

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
  id, account = 1, book, remoteId, name, email, updatedAt = 0, isDeleted = 0,
}: {
  id: number; account?: number; book: number; remoteId: string; name: string;
  email: string | null; updatedAt?: number; isDeleted?: number;
}) {
  await engine.run(
    `INSERT INTO contacts(
       id, account_id, addressbook_id, remote_id, display_name, full_name,
       is_deleted, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, account, book, remoteId, name, name, isDeleted, updatedAt],
  );
  if (email === null) return;
  await engine.run(
    `INSERT INTO contact_emails(contact_id, position, email, is_preferred)
     VALUES (?, 0, ?, 1)`,
    [id, email],
  );
}

/** Apply the unreleased v6-v8 migrations. */
async function upgrade(engine: any) {
  await engine.runMigrations();
}

describe('migration 007: consolidated contacts', () => {
  it('upgrades duplicate v5 contacts without losing survivor data or memberships', async () => {
    const engine = await legacyEngine();
    await legacyContact(engine, {
      id: 100,
      book: 10,
      remoteId: 'card-current',
      name: 'Deleted stale name',
      email: 'stale@example.org',
      updatedAt: 3_000,
      isDeleted: 1,
    });
    await legacyContact(engine, {
      id: 200,
      book: 11,
      remoteId: 'card-current',
      name: 'Current name',
      email: 'current@example.org',
      updatedAt: 2_000,
    });
    await legacyContact(engine, {
      id: 300,
      book: 10,
      remoteId: 'card-rescued',
      name: 'Address source',
      email: 'rescued@example.org',
      updatedAt: 1_000,
    });
    await legacyContact(engine, {
      id: 400,
      book: 11,
      remoteId: 'card-rescued',
      name: 'Freshest row',
      email: null,
      updatedAt: 2_000,
    });

    await upgrade(engine);

    expect(Number((await engine.get('PRAGMA user_version'))?.user_version)).toBe(8);
    expect(await engine.all(
      `SELECT c.id, c.remote_id, c.display_name, ce.email
         FROM contacts c
         LEFT JOIN contact_emails ce ON ce.contact_id = c.id
        ORDER BY c.remote_id`,
    )).toEqual([
      {
        id: 200,
        remote_id: 'card-current',
        display_name: 'Current name',
        email: 'current@example.org',
      },
      {
        id: 400,
        remote_id: 'card-rescued',
        display_name: 'Freshest row',
        email: 'rescued@example.org',
      },
    ]);
    expect(await engine.all(
      `SELECT c.remote_id, ac.addressbook_id
         FROM addressbook_contacts ac
         JOIN contacts c ON c.id = ac.contact_id
        ORDER BY c.remote_id, ac.addressbook_id`,
    )).toEqual([
      { remote_id: 'card-current', addressbook_id: 10 },
      { remote_id: 'card-current', addressbook_id: 11 },
      { remote_id: 'card-rescued', addressbook_id: 10 },
      { remote_id: 'card-rescued', addressbook_id: 11 },
    ]);
    expect(await engine.all('PRAGMA foreign_key_check')).toEqual([]);
    await engine.close();
  });

  it('carries each address account through a v5 upgrade', async () => {
    // The same remote card id may exist in several accounts, so the copied
    // address must take the account of its own contact rather than another
    // survivor with the same remote id.
    const engine = await legacyEngine();
    await engine.run(
      `INSERT INTO accounts(
         id, display_name, primary_email, server_origin, remote_account_id,
         created_at, updated_at
       ) VALUES (2, 'Other', 'other@example.com', 'https://mail.example.com', 'acct-2', 0, 0)`,
    );
    await engine.run(
      `INSERT INTO addressbooks(id, account_id, service_kind, remote_id, name, updated_at)
       VALUES (20, 2, 'jmap_contacts', 'ab-20', 'Other book', 0)`,
    );
    await legacyContact(engine, {
      id: 100,
      account: 1,
      book: 10,
      remoteId: 'card-shared-id',
      name: 'First account',
      email: 'first@example.com',
    });
    await legacyContact(engine, {
      id: 200,
      account: 2,
      book: 20,
      remoteId: 'card-shared-id',
      name: 'Second account',
      email: 'second@example.com',
    });

    await upgrade(engine);

    expect(await engine.all(
      `SELECT c.account_id AS contact_account_id,
              ce.account_id AS email_account_id,
              ce.email
         FROM contact_emails ce
         JOIN contacts c ON c.id = ce.contact_id
        ORDER BY c.account_id`,
    )).toEqual([
      {
        contact_account_id: 1,
        email_account_id: 1,
        email: 'first@example.com',
      },
      {
        contact_account_id: 2,
        email_account_id: 2,
        email: 'second@example.com',
      },
    ]);
    await engine.close();
  });

  it('replaces the generated address key with the application-written key schema', async () => {
    const engine = await legacyEngine();
    await legacyContact(engine, {
      id: 100,
      book: 10,
      remoteId: 'card-a',
      name: 'Ada',
      email: 'ada@example.com',
    });

    await upgrade(engine);

    const columns = (await engine.all('PRAGMA table_xinfo(contact_emails)'))
      .map((column) => column.name);
    expect(columns).toContain('account_id');
    expect(columns).toContain('email_key');
    expect(columns).not.toContain('email_lower');

    const indexes = (await engine.all('PRAGMA index_list(contact_emails)'))
      .map((index) => index.name);
    expect(indexes).toContain('contact_emails_key_lookup');
    expect(indexes).not.toContain('contact_emails_lookup');
    const indexedColumns = (await engine.all('PRAGMA index_info(contact_emails_key_lookup)'))
      .map((column) => column.name);
    expect(indexedColumns).toEqual(['account_id', 'email_key', 'contact_id']);
    await engine.close();
  });

  it('leaves migrated lookup representations pending for the full contact sync', async () => {
    const engine = await legacyEngine();
    await legacyContact(engine, {
      id: 100,
      book: 10,
      remoteId: 'card-unicode',
      name: 'École Smith—Jane',
      email: 'JOSÉ@example.com',
    });

    await upgrade(engine);

    // SQLite cannot reproduce `addressKey()` or `nameTokens()`. Keeping the
    // migrated representations empty makes the card invisible rather than
    // assigning it a key or token the application would never produce.
    expect(await engine.get(
      'SELECT email, email_key FROM contact_emails WHERE contact_id = 100',
    )).toEqual({ email: 'JOSÉ@example.com', email_key: null });
    expect(await engine.all(
      'SELECT token FROM contact_search_tokens WHERE contact_id = 100',
    )).toEqual([]);

    const handlers = makeHandlers(engine, noopBroadcaster());
    expect(await handlers[DB_RPC.CONTACT_AUTOCOMPLETE]({
      accountId: 1,
      prefix: 'josé@example.com',
      limit: 10,
    })).toEqual([]);
    expect(await handlers[DB_RPC.CONTACT_AUTOCOMPLETE]({
      accountId: 1,
      prefix: 'école',
      limit: 10,
    })).toEqual([]);
    await engine.close();
  });

  it('repairs migrated lookup data through the real contact upsert handler', async () => {
    const engine = await legacyEngine();
    await legacyContact(engine, {
      id: 100,
      book: 10,
      remoteId: 'card-unicode',
      name: 'École Smith—Jane',
      email: 'JOSÉ@example.com',
    });
    await upgrade(engine);

    // Bootstrap's full contact sync uses this handler. Its Unicode key and
    // token writes are the guarantee provided in place of SQL backfills.
    const handlers = makeHandlers(engine, noopBroadcaster());
    await handlers[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: 1,
      contacts: [{
        addressbookIds: [10],
        remoteId: 'card-unicode',
        displayName: 'École Smith—Jane',
        emails: [{ email: 'JOSÉ@example.com', isPreferred: true }],
      }],
    });

    expect(await engine.get(
      'SELECT email, email_key FROM contact_emails WHERE contact_id = 100',
    )).toEqual({ email: 'JOSÉ@example.com', email_key: 'josé@example.com' });
    expect((await engine.all(
      'SELECT token FROM contact_search_tokens WHERE contact_id = 100 ORDER BY token',
    )).map((row) => row.token)).toEqual(['jane', 'smith', 'école']);

    expect((await handlers[DB_RPC.CONTACT_AUTOCOMPLETE]({
      accountId: 1,
      prefix: 'josé@example.com',
      limit: 10,
    })).map((row) => row.email)).toEqual(['JOSÉ@example.com']);
    expect((await handlers[DB_RPC.CONTACT_AUTOCOMPLETE]({
      accountId: 1,
      prefix: 'école',
      limit: 10,
    })).map((row) => row.email)).toEqual(['JOSÉ@example.com']);

    await engine.run('DELETE FROM contacts WHERE id = 100');
    expect(await engine.all(
      'SELECT contact_id FROM contact_search_tokens WHERE contact_id = 100',
    )).toEqual([]);
    await engine.close();
  });

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
    expect(contacts.map((c: any) => c.remote_id), 'one card is one contact')
      .toEqual(['card-a']);
    const keptId = contacts[0].id;
    const books = await engine.all(
      'SELECT addressbook_id FROM addressbook_contacts WHERE contact_id = ? ORDER BY addressbook_id',
      [keptId],
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

  it('keeps the live copy of a duplicate, not the one with the smaller id', async () => {
    // Duplicates exist because re-filing a card inserted a second row
    // instead of moving the first, so the lower id is the copy left behind.
    // Keeping it by id alone would resurrect a stale name over the current
    // one — and a deleted row over a live one.
    const engine = await legacyEngine();
    await legacyContact(engine, {
      id: 100, book: 10, remoteId: 'card-a', name: 'Old name',
      email: 'old@example.org', updatedAt: 1_000, isDeleted: 1,
    });
    await legacyContact(engine, {
      id: 200, book: 11, remoteId: 'card-a', name: 'Current name',
      email: 'current@example.org', updatedAt: 2_000,
    });

    await upgrade(engine);

    const rows = await engine.all('SELECT id, display_name, is_deleted FROM contacts');
    expect(rows).toEqual([{ id: 200, display_name: 'Current name', is_deleted: 0 }]);
    const emails = await engine.all('SELECT email FROM contact_emails');
    expect(emails, 'the surviving copy keeps its own address')
      .toEqual([{ email: 'current@example.org' }]);
    await engine.close();
  });

  it('takes the addresses of a duplicate when the survivor has none', async () => {
    // Folding two rows together must not leave a contact with no way to
    // reach it. These are copies of one card, so this restores addresses
    // rather than merging two different sets.
    const engine = await legacyEngine();
    await legacyContact(engine, {
      id: 100, book: 10, remoteId: 'card-a', name: 'Ada', email: 'ada@example.org', updatedAt: 1_000,
    });
    await legacyContact(engine, {
      id: 200, book: 11, remoteId: 'card-a', name: 'Ada', email: null, updatedAt: 2_000,
    });

    await upgrade(engine);

    const rows = await engine.all('SELECT id FROM contacts');
    expect(rows, 'the freshest row still wins').toEqual([{ id: 200 }]);
    const emails = await engine.all('SELECT contact_id, email FROM contact_emails');
    expect(emails, 'and it inherits the address rather than losing it')
      .toEqual([{ contact_id: 200, email: 'ada@example.org' }]);
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
