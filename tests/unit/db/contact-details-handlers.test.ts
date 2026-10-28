import { describe, expect, it, vi } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers, noopBroadcaster } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';

async function setup() {
  const engine = await bootTestEngine();
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
  return { engine, handlers: makeHandlers(engine, noopBroadcaster()) };
}

describe('contact detail handlers', () => {
  it('round-trips keyed details and keeps organization evidence out of list rows', async () => {
    const { engine, handlers } = await setup();
    await handlers[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: 1,
      contacts: [{
        addressbookIds: [10],
        remoteId: 'card-1',
        uid: 'uid-1',
        fullName: 'Ada Lovelace',
        displayName: 'Ada Lovelace',
        givenName: 'Ada',
        familyName: 'Lovelace',
        organization: 'Analytical Engines',
        rawJson: '{"id":"card-1","x-unknown":true}',
        emails: [
          {
            mapKey: 'email-home',
            email: 'home@example.com',
            label: 'Personal inbox',
            contexts: ['private'],
            pref: null,
            isPreferred: false,
          },
          {
            mapKey: 'email-work',
            email: 'work@example.com',
            label: null,
            contexts: ['work'],
            pref: 1,
            isPreferred: true,
          },
        ],
        phones: [{
          mapKey: 'phone-work',
          value: 'tel:+15551234',
          label: null,
          contexts: ['work'],
          features: ['voice', 'mobile'],
          pref: 2,
        }],
        links: [{
          mapKey: 'site',
          value: 'https://example.com',
          label: 'Portfolio',
          contexts: ['work'],
          pref: null,
        }],
        anniversaries: [
          {
            mapKey: 'birthday',
            kind: 'birth',
            date: { kind: 'partial', year: 1815, month: 12, day: 10 },
          },
          {
            mapKey: 'memorial',
            kind: 'death',
            date: { kind: 'timestamp', utc: '1852-11-27T00:00:00Z' },
          },
        ],
        notes: [{ mapKey: 'note-main', value: 'First programmer' }],
        organizations: [
          {
            mapKey: 'org-main',
            name: 'Analytical Engines',
            contexts: ['work'],
            units: [
              { value: 'Research' },
              { value: 'Mathematics' },
            ],
          },
          {
            mapKey: 'org-secondary',
            name: 'Royal Society',
            contexts: [],
            units: [],
          },
        ],
        titles: [
          {
            mapKey: 'title-main',
            value: 'Programmer',
            kind: 'title',
            organizationMapKey: 'org-main',
          },
          {
            mapKey: 'role-main',
            value: 'Researcher',
            kind: 'role',
            organizationMapKey: 'org-main',
          },
        ],
      }],
    });

    const list = await handlers[DB_RPC.CONTACT_LIST]({ accountId: 1 });
    expect(list).toEqual([{
      id: expect.any(Number),
      remote_id: 'card-1',
      uid: 'uid-1',
      addressbook_ids: [10],
      display_name: 'Ada Lovelace',
      email: 'work@example.com',
      photo: null,
    }]);
    expect(list[0]).not.toHaveProperty('organization');

    const detail = await handlers[DB_RPC.CONTACT_GET]({
      accountId: 1,
      contactId: list[0].id,
    });
    expect(detail).toMatchObject({
      id: list[0].id,
      remote_id: 'card-1',
      addressbook_ids: [10],
      display_name: 'Ada Lovelace',
      full_name: 'Ada Lovelace',
      emails: [
        {
          mapKey: 'email-home',
          value: 'home@example.com',
          label: 'Personal inbox',
          contexts: ['private'],
          pref: null,
          isPreferred: false,
          position: 0,
        },
        {
          mapKey: 'email-work',
          value: 'work@example.com',
          label: null,
          contexts: ['work'],
          pref: 1,
          isPreferred: true,
          position: 1,
        },
      ],
      phones: [{
        mapKey: 'phone-work',
        position: 0,
        value: 'tel:+15551234',
        label: null,
        contexts: ['work'],
        features: ['voice', 'mobile'],
        pref: 2,
      }],
      links: [{
        mapKey: 'site',
        position: 0,
        value: 'https://example.com',
        label: 'Portfolio',
        contexts: ['work'],
        pref: null,
      }],
      anniversaries: [
        {
          mapKey: 'birthday',
          position: 0,
          kind: 'birth',
          date: { kind: 'partial', year: 1815, month: 12, day: 10 },
        },
        {
          mapKey: 'memorial',
          position: 1,
          kind: 'death',
          date: { kind: 'timestamp', utc: '1852-11-27T00:00:00Z' },
        },
      ],
      notes: [{ mapKey: 'note-main', position: 0, value: 'First programmer' }],
      organizations: [
        {
          mapKey: 'org-main',
          position: 0,
          name: 'Analytical Engines',
          contexts: ['work'],
          units: [
            { position: 0, value: 'Research' },
            { position: 1, value: 'Mathematics' },
          ],
        },
        {
          mapKey: 'org-secondary',
          position: 1,
          name: 'Royal Society',
          contexts: [],
          units: [],
        },
      ],
      titles: [
        {
          mapKey: 'title-main',
          position: 0,
          value: 'Programmer',
          kind: 'title',
          organizationMapKey: 'org-main',
        },
        {
          mapKey: 'role-main',
          position: 1,
          value: 'Researcher',
          kind: 'role',
          organizationMapKey: 'org-main',
        },
      ],
    });
    const matches = await handlers[DB_RPC.CONTACT_AUTOCOMPLETE]({
      accountId: 1,
      prefix: 'researcher',
      limit: 10,
    });
    expect(matches.map((match) => match.email)).toContain('work@example.com');
    await engine.close();
  });

  it('batch-clears normalized detail rows once per upsert chunk', async () => {
    const { engine, handlers } = await setup();
    const runSpy = vi.spyOn(engine as any, '_runRaw');
    const contacts = Array.from({ length: 12 }, (_, index) => ({
      addressbookIds: [10],
      remoteId: `card-${index}`,
      displayName: `Person ${index}`,
      emails: [],
      phones: [],
      links: [],
      anniversaries: [],
      notes: [],
      organizations: [],
      titles: [],
    }));

    await handlers[DB_RPC.CONTACT_UPSERT_MANY]({ accountId: 1, contacts });

    const detailClears = runSpy.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => /^DELETE FROM contact_(?:emails|phones|links|anniversaries|notes|organizations|titles)\b/
        .test(sql.trim()));
    expect(detailClears).toHaveLength(7);
    expect(detailClears.every((sql) => sql.includes('contact_id IN ('))).toBe(true);

    runSpy.mockRestore();
    await engine.close();
  });
});
