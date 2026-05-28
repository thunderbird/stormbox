import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { SERVICE_KIND } from '../../../src/constants/states';
import {
  syncAddressBooks,
  syncContacts,
  syncContactCardChanges,
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
