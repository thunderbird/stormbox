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
  createTrustedContactCards,
  updateContactCard,
  deleteContactCard,
} from '../../../src/sync/backends/jmap/contacts';
import { processMutationRow } from '../../../src/sync/backends/jmap/outbox';
import { MockTransport } from './_mock-transport';

function jmapCalls(transport, method) {
  const out = [];
  for (const req of transport.requests) {
    for (const [m, params] of req.methodCalls) {
      if (m === method) out.push(params);
    }
  }
  return out;
}

function countMethod(transport, name) {
  return transport.requests.filter(
    (r) => r.methodCalls.some(([m]) => m === name),
  ).length;
}

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

describe('createTrustedContactCards', () => {
  function setup({ existingIds = [], existingCards = [] } = {}) {
    const transport = new MockTransport();
    transport.handle('ContactCard/query', () => ({ ids: existingIds, total: existingIds.length }));
    transport.handle('ContactCard/get', () => ({ list: existingCards }));
    transport.handle('AddressBook/get', () => ({
      list: [{ id: 'book-trusted', name: 'Trusted senders', isDefault: false }],
    }));
    let created: any = null;
    transport.handle('ContactCard/set', (params) => {
      created = params.create;
      const out: Record<string, any> = {};
      for (const key of Object.keys(params.create ?? {})) out[key] = { id: `new-${key}` };
      return { created: out };
    });
    return { transport, getCreated: () => created };
  }

  it('trusts every unique sender in one ContactCard/set and de-dupes by address', async () => {
    const { transport, getCreated } = setup();
    const result = await createTrustedContactCards({
      transport,
      account,
      senders: [
        { email: 'a@x.com', name: 'Alice' },
        { email: 'A@X.com', name: 'Alice dup' },
        { email: 'b@y.com', name: 'Bob' },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.created).toBe(2);

    const created = getCreated();
    expect(Object.values(created).map((c: any) => c.emails.e1.address))
      .toEqual(['a@x.com', 'b@y.com']);
    Object.values(created).forEach((c: any) => {
      expect(c.addressBookIds).toEqual({ 'book-trusted': true });
    });

    // Proper batch: one book lookup and one create regardless of N.
    expect(countMethod(transport, 'AddressBook/get')).toBe(1);
    expect(countMethod(transport, 'ContactCard/set')).toBe(1);
    expect(countMethod(transport, 'ContactCard/query')).toBe(1);
  });

  it('skips addresses that already have a card and only creates the rest', async () => {
    const { transport, getCreated } = setup({
      existingIds: ['existing-1'],
      existingCards: [{ id: 'existing-1', emails: { e1: { address: 'a@x.com' } } }],
    });
    const result = await createTrustedContactCards({
      transport,
      account,
      senders: [{ email: 'a@x.com', name: 'Alice' }, { email: 'b@y.com', name: 'Bob' }],
    });
    expect(result.ok).toBe(true);
    expect(result.created).toBe(1);
    expect(Object.values(getCreated()).map((c: any) => c.emails.e1.address)).toEqual(['b@y.com']);
  });

  it('reports alreadyTrusted and issues no create when every sender exists', async () => {
    const { transport } = setup({
      existingIds: ['e1', 'e2'],
      existingCards: [
        { id: 'e1', emails: { e1: { address: 'a@x.com' } } },
        { id: 'e2', emails: { e1: { address: 'b@y.com' } } },
      ],
    });
    const result = await createTrustedContactCards({
      transport,
      account,
      senders: [{ email: 'a@x.com' }, { email: 'b@y.com' }],
    });
    expect(result).toEqual({ ok: true, created: 0, alreadyTrusted: true });
    expect(countMethod(transport, 'ContactCard/set')).toBe(0);
    expect(countMethod(transport, 'AddressBook/get')).toBe(0);
  });

  it('fails without touching the server when no valid sender is provided', async () => {
    const transport = new MockTransport();
    const result = await createTrustedContactCards({
      transport, account, senders: [{ email: '   ' }, { email: null }],
    });
    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('invalidArguments');
    expect(transport.requests).toHaveLength(0);
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

describe('whitelist reconcile cost is independent of contact count', () => {
  async function seedLocalContacts(n) {
    await handlers[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
      accountId: account.id,
      serviceKind: SERVICE_KIND.JMAP_CONTACTS,
      addressbooks: [
        { remoteId: 'book-default', name: 'Default', isDefault: true },
        { remoteId: 'book-trusted', name: 'Trusted senders', isDefault: false },
      ],
    });
    const books = await handlers[DB_RPC.ADDRESSBOOK_LIST]({ accountId: account.id });
    const defaultLocal = books.find((b) => b.remote_id === 'book-default').id;
    const contacts = Array.from({ length: n }, (_, i) => ({
      addressbookId: defaultLocal,
      remoteId: `seed-${i}`,
      uid: null,
      etag: null,
      fullName: `Seed ${i}`,
      displayName: `Seed ${i}`,
      givenName: null,
      familyName: null,
      organization: null,
      vcardText: null,
      vcardVersion: null,
      rawJson: '{}',
      isDeleted: false,
      emails: [{ position: 0, email: `seed-${i}@x.invalid`, label: null, isPreferred: true }],
    }));
    await handlers[DB_RPC.CONTACT_UPSERT_MANY]({ accountId: account.id, contacts });
  }

  function countContacts() {
    return engine.get(
      'SELECT COUNT(*) AS n FROM contacts WHERE account_id = ? AND is_deleted = 0',
      [account.id],
    );
  }

  it('whitelisting a sender on a 1000-contact address book fetches only the new card', async () => {
    await seedLocalContacts(1000);
    expect((await countContacts()).n).toBe(1000);

    // The "server" holds 1000 cards, but the whitelist must never pull
    // them: a full ContactCard/query (position/limit) would be the old
    // O(contacts) reconcile; the existence check uses a {email} filter.
    const transport = new MockTransport();
    let fullListQueried = false;
    transport.handle('ContactCard/query', (params) => {
      if (params.position != null || params.limit != null) {
        fullListQueried = true;
        return { ids: Array.from({ length: 1000 }, (_, i) => `seed-${i}`), total: 1000, state: 's' };
      }
      return { ids: [], total: 0 }; // existence check: sender not yet carded
    });
    transport.handle('AddressBook/get', () => ({
      list: [
        { id: 'book-default', name: 'Default', isDefault: true },
        { id: 'book-trusted', name: 'Trusted senders', isDefault: false },
      ],
    }));
    transport.handle('ContactCard/set', (params) => {
      const created = {};
      for (const key of Object.keys(params.create ?? {})) created[key] = { id: 'trusted-new' };
      return { created };
    });
    transport.handle('ContactCard/get', (params) => ({
      list: (params.ids ?? []).map((id) => ({
        '@type': 'Card',
        id,
        kind: 'individual',
        name: { full: 'Spammer' },
        emails: { e1: { '@type': 'EmailAddress', address: 'spammer@junk.invalid' } },
        addressBookIds: { 'book-trusted': true },
      })),
    }));

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: {
        mutation_type: 'whitelistSender',
        request_json: JSON.stringify({ email: 'spammer@junk.invalid', name: 'Spammer' }),
      },
    });
    expect(result.ok).toBe(true);

    // The whole address book was never re-pulled...
    expect(fullListQueried).toBe(false);
    // ...and only the single new trusted card was fetched.
    const idsFetched = jmapCalls(transport, 'ContactCard/get')
      .reduce((sum, p) => sum + (p.ids?.length ?? 0), 0);
    expect(idsFetched).toBe(1);

    // The 1000 existing contacts are untouched; exactly one was added.
    expect((await countContacts()).n).toBe(1001);
  });
});
