import { describe, expect, it } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers, noopBroadcaster } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';

/**
 * The v10 address key, judged on data that already exists.
 *
 * Before it, contact addresses were compared through `email_lower`, a
 * generated column holding `lower(email)`. SQLite's `lower()` folds A-Z and
 * nothing else, while the lookup key is built in JavaScript, which folds all
 * of Unicode — so the two disagreed for any address carrying an uppercase
 * non-ASCII letter, and such a contact could not be found by its address at
 * all.
 *
 * What this migration can do for existing rows is limited, and the limit is
 * the point of the second case: SQL cannot compute the real key, so the rows
 * carry `lower(email)` until the next contact sync rewrites them. That is not
 * a regression — it is what they had before — and it is why the sync path is
 * where the key really comes from.
 */

async function legacyEngine() {
  const engine = await bootTestEngine({ upTo: 9 });
  const version = await engine.get('PRAGMA user_version');
  expect(Number(version?.user_version), 'the fixture must predate v10').toBe(9);
  await engine.run(
    `INSERT INTO accounts(
       id, display_name, primary_email, server_origin, remote_account_id,
       created_at, updated_at
     ) VALUES (1, 'Me', 'me@example.com', 'https://mail.example.com', 'acct-1', 0, 0)`,
  );
  await engine.run(
    `INSERT INTO addressbooks(id, account_id, service_kind, remote_id, name, updated_at)
     VALUES (10, 1, 'jmap_contacts', 'ab-10', 'Personal', 0)`,
  );
  return engine;
}

async function legacyContact(engine: any, id: number, remoteId: string, email: string) {
  await engine.run(
    `INSERT INTO contacts(
       id, account_id, remote_id, display_name, sync_generation, updated_at
     ) VALUES (?, 1, ?, ?, 1, 0)`,
    [id, remoteId, remoteId],
  );
  await engine.run(
    `INSERT INTO addressbook_contacts(contact_id, addressbook_id) VALUES (?, 10)`,
    [id],
  );
  await engine.run(
    `INSERT INTO contact_emails(contact_id, position, email, is_preferred)
     VALUES (?, 0, ?, 1)`,
    [id, email],
  );
}

describe('migration 010: a comparison key for contact addresses', () => {
  it('gives every address already stored a key to be found by', async () => {
    const engine = await legacyEngine();
    await legacyContact(engine, 1, 'c-ascii', 'Jane.Doe@Example.COM');

    await engine.runMigrations();

    const row = await engine.get(
      'SELECT email, email_key FROM contact_emails WHERE contact_id = 1',
    );
    expect(row.email, 'the address itself is untouched, for display and sending').toBe(
      'Jane.Doe@Example.COM',
    );
    expect(row.email_key).toBe('jane.doe@example.com');
    await engine.close();
  });

  it('is superseded by the sync for an address SQL cannot fold', async () => {
    const engine = await legacyEngine();
    await legacyContact(engine, 1, 'c-unicode', 'JOSÉ@example.com');

    await engine.runMigrations();

    // All SQL can do, and it is wrong in the same way the old column was.
    expect(
      (await engine.get('SELECT email_key FROM contact_emails WHERE contact_id = 1')).email_key,
      'É is beyond what lower() folds',
    ).toBe('josÉ@example.com');

    // The next sync of that card is what puts it right, and contacts are
    // re-persisted wholesale, so it does not wait for the address to change.
    const handlers = makeHandlers(engine, noopBroadcaster());
    await handlers[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: 1,
      contacts: [{
        addressbookIds: [10],
        remoteId: 'c-unicode',
        displayName: 'José',
        emails: [{ email: 'JOSÉ@example.com', isPreferred: true }],
      }],
    });

    const row = await engine.get(
      `SELECT ce.email, ce.email_key FROM contact_emails ce
         JOIN contacts c ON c.id = ce.contact_id
        WHERE c.remote_id = 'c-unicode'`,
    );
    expect(row.email, 'still verbatim').toBe('JOSÉ@example.com');
    expect(row.email_key).toBe('josé@example.com');

    const found = await handlers[DB_RPC.CONTACT_AUTOCOMPLETE]({
      accountId: 1, prefix: 'josé@example.com', limit: 10,
    });
    expect(found.map((r: any) => r.email)).toEqual(['JOSÉ@example.com']);
    await engine.close();
  });

  it('indexes the key, because every keystroke reads it', async () => {
    const engine = await bootTestEngine();
    const plan = await engine.all(
      `EXPLAIN QUERY PLAN
         SELECT contact_id FROM contact_emails WHERE email_key >= 'ja' AND email_key < 'jb'`,
    );
    const detail = plan.map((row: any) => row.detail).join('\n');
    expect(detail, detail).toContain('contact_emails_key_lookup');
    await engine.close();
  });
});
