import { describe, expect, it } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';

/**
 * The v9 tables, judged by what they make possible on data that already
 * exists.
 *
 * The token backfill is the part worth testing: a contact synced before v9
 * has to become searchable by name without waiting for a re-sync, and the
 * words have to come out of the name the way a person would type them.
 */

async function legacyEngine() {
  const engine = await bootTestEngine({ upTo: 8 });
  const version = await engine.get('PRAGMA user_version');
  expect(Number(version?.user_version), 'the fixture must predate v9').toBe(8);

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

async function legacyContact(engine: any, {
  id, remoteId, displayName, fullName = null, given = null, family = null,
  organization = null, isDeleted = 0,
}: {
  id: number; remoteId: string; displayName: string; fullName?: string | null;
  given?: string | null; family?: string | null; organization?: string | null;
  isDeleted?: number;
}) {
  await engine.run(
    `INSERT INTO contacts(
       id, account_id, remote_id, display_name, full_name, given_name,
       family_name, organization, is_deleted, updated_at
     ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [id, remoteId, displayName, fullName, given, family, organization, isDeleted],
  );
  await engine.run(
    `INSERT INTO addressbook_contacts(addressbook_id, contact_id) VALUES (10, ?)`,
    [id],
  );
}

async function tokensOf(engine: any, contactId: number) {
  const rows = await engine.all(
    `SELECT token FROM contact_search_tokens WHERE contact_id = ? ORDER BY token`,
    [contactId],
  );
  return rows.map((r: any) => r.token);
}

describe('migration 009 — learned recipients and searchable names', () => {
  it('makes a contact synced before v9 findable by every word of its name', async () => {
    const engine = await legacyEngine();
    await legacyContact(engine, {
      id: 1,
      remoteId: 'c-1',
      displayName: 'Smith, Jane',
      fullName: 'Jane Q. Smith',
      given: 'Jane',
      family: 'Smith',
      organization: 'Acme Widgets',
    });

    await engine.runMigrations();

    const tokens = await tokensOf(engine, 1);
    // Every word of every name field, and no punctuation stuck to any of
    // them: a token of "smith," would be unreachable by anything typed.
    expect(tokens).toContain('smith');
    expect(tokens).toContain('jane');
    expect(tokens).toContain('acme');
    expect(tokens).toContain('widgets');
    expect(tokens.filter((t: string) => /[,.;:()"/]/.test(t))).toEqual([]);
  });

  it('leaves a deleted contact out of the index', async () => {
    const engine = await legacyEngine();
    await legacyContact(engine, { id: 1, remoteId: 'c-1', displayName: 'Live Person' });
    await legacyContact(engine, {
      id: 2, remoteId: 'c-2', displayName: 'Gone Person', isDeleted: 1,
    });

    await engine.runMigrations();

    expect(await tokensOf(engine, 1)).toContain('live');
    expect(await tokensOf(engine, 2)).toEqual([]);
  });

  it('drops a contact\'s tokens with the contact', async () => {
    const engine = await legacyEngine();
    await legacyContact(engine, { id: 1, remoteId: 'c-1', displayName: 'Jane Smith' });

    await engine.runMigrations();
    expect(await tokensOf(engine, 1)).not.toEqual([]);

    await engine.run('PRAGMA foreign_keys = ON');
    await engine.run('DELETE FROM contacts WHERE id = 1');
    expect(await tokensOf(engine, 1)).toEqual([]);
  });

  it('treats one address written two ways as one learned recipient', async () => {
    const engine = await legacyEngine();
    await engine.runMigrations({ upTo: 9 });

    await engine.run(
      `INSERT INTO recipient_history(
         account_id, email, email_key, send_count, created_at, updated_at
       ) VALUES (1, 'Jane@Example.com', 'jane@example.com', 1, 0, 0)`,
    );
    // The key is what is unique, so the same recipient under a different
    // spelling collides rather than becoming a second suggestion.
    await expect(engine.run(
      `INSERT INTO recipient_history(
         account_id, email, email_key, send_count, created_at, updated_at
       ) VALUES (1, 'jane@example.com', 'jane@example.com', 1, 0, 0)`,
    )).rejects.toThrow();
  });
});
