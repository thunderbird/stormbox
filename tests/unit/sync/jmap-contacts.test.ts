import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { SERVICE_KIND } from '../../../src/constants/states';
import {
  syncAddressBooks,
  syncContacts,
  syncContactCardChanges,
  createContactCard,
  updateContactCard,
  deleteContactCard,
} from '../../../src/sync/backends/jmap/contacts';
import { MockTransport } from './_mock-transport';

let engine;
let handlers;
let account;

beforeEach(async () => {
  engine = await bootTestEngine();
  handlers = makeHandlers(engine);
  account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
    displayName: 'T',
    primaryEmail: 't@example.com',
    serverOrigin: 'https://mail.example.com',
    remoteAccountId: 'acct-1',
    isPrimary: true,
  })).row;
});

afterEach(async () => {
  await engine.close();
});

describe('syncAddressBooks', () => {
  it('upserts addressbooks tagged with service_kind=jmap-contacts', async () => {
    const transport = new MockTransport();
    transport.handle('AddressBook/get', () => ({
      list: [
        { id: 'ab-default', name: 'Default', isDefault: true, isSubscribed: true },
        { id: 'ab-shared', name: 'Shared', isDefault: false, isSubscribed: true },
      ],
      state: 'ab-1',
    }));
    const result = await syncAddressBooks({ transport, account, handlers });
    expect(result.count).toBe(2);
    const list = await handlers[DB_RPC.ADDRESSBOOK_LIST]({ accountId: account.id });
    expect(list).toHaveLength(2);
    for (const ab of list) {
      expect(ab.service_kind).toBe(SERVICE_KIND.JMAP_CONTACTS);
    }
    const stateRow = await handlers[DB_RPC.SYNC_STATE_GET]({
      accountId: account.id,
      objectType: 'AddressBook',
    });
    expect(stateRow.state).toBe('ab-1');
  });
});

describe('syncContacts', () => {
  it('queries ids, fetches cards, and persists contact + emails', async () => {
    // Pre-seed an addressbook so contacts can resolve.
    await handlers[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'ab-default', name: 'Default', isDefault: true }],
    });

    const transport = new MockTransport();
    transport.handle('ContactCard/query', () => ({
      ids: ['c-1', 'c-2'],
      total: 2,
      state: 'cc-1',
    }));
    transport.handle('ContactCard/get', (params) => ({
      list: params.ids.map((id) => ({
        id,
        addressBookId: 'ab-default',
        uid: `uid-${id}`,
        name: { given: 'Jane', surname: 'Doe' },
        fullName: id === 'c-1' ? 'Jane Doe' : 'Jay Doe',
        emails: [
          { email: id === 'c-1' ? 'jane@example.com' : 'jay@example.com', label: 'home', isDefault: true },
        ],
      })),
      state: 'cc-1',
    }));

    const result = await syncContacts({ transport, account, handlers });
    expect(result.fetched).toBe(2);

    const rows = await engine.all(
      `SELECT c.display_name, ce.email, ce.is_preferred
         FROM contacts c JOIN contact_emails ce ON ce.contact_id = c.id
        WHERE c.account_id = ? ORDER BY c.display_name`,
      [account.id],
    );
    expect(rows.map((r) => r.display_name)).toEqual(['Jane Doe', 'Jay Doe']);
    expect(rows.find((r) => r.display_name === 'Jane Doe').email).toBe('jane@example.com');
    expect(Number(rows[0].is_preferred)).toBe(1);
  });

  it('skips cards whose addressbook is not yet synced locally', async () => {
    const transport = new MockTransport();
    transport.handle('ContactCard/query', () => ({ ids: ['c-1'], total: 1, state: 'cc' }));
    transport.handle('ContactCard/get', () => ({
      list: [{
        id: 'c-1',
        addressBookId: 'ab-unknown',
        uid: 'u-1',
        fullName: 'Stranger',
        emails: [{ email: 'unknown@example.com' }],
      }],
      state: 'cc',
    }));
    await syncContacts({ transport, account, handlers });
    const list = await engine.all('SELECT * FROM contacts WHERE account_id = ?', [account.id]);
    expect(list).toHaveLength(0);
  });

  it('parses the JSContact map shape Stalwart serves (addressBookIds, emails map, name.full)', async () => {
    await handlers[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'book-e', name: 'Trusted senders', isDefault: false }],
    });

    const transport = new MockTransport();
    transport.handle('ContactCard/query', () => ({ ids: ['d'], total: 1, state: 'cc-map' }));
    transport.handle('ContactCard/get', () => ({
      list: [{
        '@type': 'Card',
        version: '1.0',
        id: 'd',
        kind: 'individual',
        name: { full: 'Ada Lovelace' },
        emails: { e1: { '@type': 'EmailAddress', address: 'ada@example.com', pref: 1 } },
        organizations: { o1: { name: 'Analytical Engines' } },
        addressBookIds: { 'book-e': true },
      }],
      state: 'cc-map',
    }));

    const result = await syncContacts({ transport, account, handlers });
    expect(result.fetched).toBe(1);

    const row = await engine.get(
      `SELECT c.display_name, c.organization, c.remote_id, ce.email, ce.is_preferred
         FROM contacts c JOIN contact_emails ce ON ce.contact_id = c.id
        WHERE c.account_id = ?`,
      [account.id],
    );
    expect(row.display_name).toBe('Ada Lovelace');
    expect(row.organization).toBe('Analytical Engines');
    expect(row.remote_id).toBe('d');
    expect(row.email).toBe('ada@example.com');
    expect(Number(row.is_preferred)).toBe(1);
  });
});

describe('createContactCard', () => {
  it('creates a card in the default book when no card exists for the email', async () => {
    const transport = new MockTransport();
    transport.handle('ContactCard/query', () => ({ ids: [], total: 0 }));
    transport.handle('AddressBook/get', () => ({
      list: [
        { id: 'book-default', name: 'Contacts', isDefault: true },
        { id: 'book-trusted', name: 'Trusted senders', isDefault: false },
      ],
    }));
    let created: any = null;
    transport.handle('ContactCard/set', (params) => {
      created = params.create?.c1;
      return { created: { c1: { id: 'new-1' } } };
    });

    const result = await createContactCard({
      transport, account, emails: ['grace@example.com'], name: 'Grace Hopper',
    });
    expect(result).toEqual({ ok: true, id: 'new-1' });
    expect(created.addressBookIds).toEqual({ 'book-default': true });
    expect(created.emails.e1.address).toBe('grace@example.com');
    expect(created.name.full).toBe('Grace Hopper');
  });

  it('builds a multi-email map from the address list', async () => {
    const transport = new MockTransport();
    transport.handle('ContactCard/query', () => ({ ids: [], total: 0 }));
    transport.handle('AddressBook/get', () => ({
      list: [{ id: 'book-default', name: 'Contacts', isDefault: true }],
    }));
    let created: any = null;
    transport.handle('ContactCard/set', (params) => {
      created = params.create?.c1;
      return { created: { c1: { id: 'new-2' } } };
    });
    const result = await createContactCard({
      transport, account, emails: ['a@example.com', 'b@example.com'], name: 'Multi',
    });
    expect(result.ok).toBe(true);
    expect(Object.values(created.emails).map((e: any) => e.address))
      .toEqual(['a@example.com', 'b@example.com']);
  });

  it('is idempotent: reports alreadyExists without creating a duplicate', async () => {
    const transport = new MockTransport();
    transport.handle('ContactCard/query', () => ({ ids: ['existing'], total: 1 }));
    const result = await createContactCard({
      transport, account, emails: ['dup@example.com'],
    });
    expect(result).toEqual({ ok: true, alreadyExists: true });
    const didSet = transport.requests.some((r) =>
      r.methodCalls.some(([m]) => m === 'ContactCard/set'));
    expect(didSet).toBe(false);
  });
});

describe('updateContactCard', () => {
  // A card with extra fields the editor never shows, plus per-email
  // metadata, to prove the merge never silently erases anything.
  function cardWithExtras() {
    return {
      '@type': 'Card',
      id: 'd',
      name: { full: 'Old Name', given: 'Old', surname: 'Name' },
      emails: {
        e1: { '@type': 'EmailAddress', address: 'keep@example.com', contexts: { work: true }, pref: 1 },
        e2: { '@type': 'EmailAddress', address: 'drop@example.com' },
      },
      phones: { p1: { '@type': 'Phone', number: '+15551234' } },
      organizations: { o1: { name: 'ACME' } },
      addressBookIds: { 'book-e': true },
    };
  }

  function withCard(card: any) {
    const transport = new MockTransport();
    let update: any = null;
    transport.handle('ContactCard/get', () => ({ list: [card] }));
    transport.handle('ContactCard/set', (params) => {
      update = params.update;
      return { updated: { d: null } };
    });
    return { transport, getUpdate: () => update };
  }

  it('merges emails: keeps metadata for survivors, drops removed, adds new', async () => {
    const { transport, getUpdate } = withCard(cardWithExtras());
    const result = await updateContactCard({
      transport,
      account,
      remoteId: 'd',
      emails: ['keep@example.com', 'fresh@example.com'],
      name: 'Old Name',
    });
    expect(result).toEqual({ ok: true });

    const emails = Object.values(getUpdate().d.emails) as any[];
    const kept = emails.find((e) => e.address === 'keep@example.com');
    expect(kept.contexts).toEqual({ work: true });
    expect(kept.pref).toBe(1);
    expect(emails.some((e) => e.address === 'fresh@example.com')).toBe(true);
    expect(emails.some((e) => e.address === 'drop@example.com')).toBe(false);
  });

  it('never includes untouched fields in the patch (no silent erasure)', async () => {
    const { transport, getUpdate } = withCard(cardWithExtras());
    await updateContactCard({
      transport, account, remoteId: 'd', emails: ['keep@example.com'], name: 'Old Name',
    });
    // PatchObject only carries `emails`; name is unchanged so it is
    // omitted, and phones/organizations/addressBookIds are never sent,
    // so the server leaves them intact.
    expect(Object.keys(getUpdate().d)).toEqual(['emails']);
  });

  it('changes only name.full and preserves other name components', async () => {
    const { transport, getUpdate } = withCard(cardWithExtras());
    await updateContactCard({
      transport, account, remoteId: 'd', emails: ['keep@example.com'], name: 'New Name',
    });
    expect(getUpdate().d.name).toEqual({ full: 'New Name', given: 'Old', surname: 'Name' });
  });

  it('reports notFound when the card no longer exists', async () => {
    const transport = new MockTransport();
    transport.handle('ContactCard/get', () => ({ list: [] }));
    const result = await updateContactCard({
      transport, account, remoteId: 'd', emails: ['x@example.com'],
    });
    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('notFound');
  });

  it('reports an error when the server refuses the update', async () => {
    const transport = new MockTransport();
    transport.handle('ContactCard/get', () => ({ list: [cardWithExtras()] }));
    transport.handle('ContactCard/set', () => ({
      updated: {},
      notUpdated: { d: { type: 'forbidden' } },
    }));
    const result = await updateContactCard({
      transport, account, remoteId: 'd', emails: ['x@example.com'],
    });
    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('notUpdated');
  });
});

describe('deleteContactCard', () => {
  it('destroys the card by remote id', async () => {
    const transport = new MockTransport();
    let destroyed: any = null;
    transport.handle('ContactCard/set', (params) => {
      destroyed = params.destroy;
      return { destroyed: params.destroy };
    });
    const result = await deleteContactCard({ transport, account, remoteId: 'd' });
    expect(result).toEqual({ ok: true });
    expect(destroyed).toEqual(['d']);
  });

  it('treats an already-gone card as success', async () => {
    const transport = new MockTransport();
    transport.handle('ContactCard/set', () => ({
      destroyed: [],
      notDestroyed: { d: { type: 'notFound' } },
    }));
    const result = await deleteContactCard({ transport, account, remoteId: 'd' });
    expect(result).toEqual({ ok: true });
  });
});

describe('syncContactCardChanges', () => {
  beforeEach(async () => {
    await handlers[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [{ remoteId: 'ab-default', name: 'Default', isDefault: true }],
    });
    const ab = await engine.get(
      'SELECT id FROM addressbooks WHERE account_id = ? AND remote_id = ?',
      [account.id, 'ab-default'],
    );
    await handlers[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: account.id,
      contacts: [
        {
          addressbookId: ab.id,
          remoteId: 'c-1',
          fullName: 'Jane Doe',
          displayName: 'Jane Doe',
          emails: [{ email: 'jane@example.com', isPreferred: true }],
        },
        {
          addressbookId: ab.id,
          remoteId: 'c-2',
          fullName: 'Jay Doe',
          displayName: 'Jay Doe',
          emails: [{ email: 'jay@example.com' }],
        },
      ],
    });
  });

  it('applies created/updated by re-fetching cards and soft-deletes destroyed', async () => {
    const transport = new MockTransport();
    transport.handle('ContactCard/changes', () => ({
      oldState: 'cc-0',
      newState: 'cc-1',
      hasMoreChanges: false,
      created: ['c-3'],
      updated: ['c-1'],
      destroyed: ['c-2'],
    }));
    transport.handle('ContactCard/get', (params) => ({
      list: params.ids.map((id) => ({
        id,
        addressBookId: 'ab-default',
        uid: `uid-${id}`,
        fullName: id === 'c-1' ? 'Jane Doe (Updated)' : 'New Person',
        emails: [{ email: `${id}@new.example.com` }],
      })),
      state: 'cc-1',
    }));

    const result = await syncContactCardChanges({
      transport, account, handlers, sinceState: 'cc-0',
    });
    expect(result.newState).toBe('cc-1');
    expect(result.created).toEqual(['c-3']);

    const updated = await engine.get(
      'SELECT display_name FROM contacts WHERE account_id = ? AND remote_id = ?',
      [account.id, 'c-1'],
    );
    expect(updated.display_name).toBe('Jane Doe (Updated)');

    const created = await engine.get(
      'SELECT display_name FROM contacts WHERE account_id = ? AND remote_id = ?',
      [account.id, 'c-3'],
    );
    expect(created.display_name).toBe('New Person');

    const destroyed = await engine.get(
      'SELECT is_deleted FROM contacts WHERE account_id = ? AND remote_id = ?',
      [account.id, 'c-2'],
    );
    expect(Number(destroyed.is_deleted)).toBe(1);
  });
});
