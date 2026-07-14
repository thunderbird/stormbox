import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { SERVICE_KIND } from '../../../src/constants/states';
import { ingestSession } from '../../../src/sync/backends/jmap/session';
import { JMAP_CAPS } from '../../../src/sync/backends/jmap/transport';

let engine;
let handlers;

beforeEach(async () => {
  engine = await bootTestEngine();
  handlers = makeHandlers(engine);
});

afterEach(async () => {
  await engine.close();
});

const SESSION_TEMPLATE = {
  apiUrl: 'https://mail.example.com/jmap',
  downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}',
  uploadUrl: 'https://mail.example.com/jmap/upload/{accountId}/',
  eventSourceUrl: 'https://mail.example.com/jmap/event/',
  username: 'tester@example.com',
  state: 'session-state-aaa',
  accounts: {
    'acct-1': {
      name: 'Tester',
      isPersonal: true,
      isReadOnly: false,
      accountCapabilities: {
        [JMAP_CAPS.MAIL]: { maxMailboxesPerEmail: null },
        [JMAP_CAPS.SUBMISSION]: {},
        [JMAP_CAPS.CONTACTS]: { mayCreateAddressBook: true },
      },
    },
  },
  primaryAccounts: {
    [JMAP_CAPS.MAIL]: 'acct-1',
    [JMAP_CAPS.CONTACTS]: 'acct-1',
  },
  capabilities: {
    [JMAP_CAPS.CORE]: { maxConcurrentRequests: 4 },
    [JMAP_CAPS.MAIL]: {},
    [JMAP_CAPS.WEBSOCKET]: {
      url: 'wss://mail.example.com/jmap/ws/',
      supportsPush: true,
    },
  },
};

describe('ingestSession', () => {
  it('creates the account row from the primary mail account', async () => {
    const { account } = await ingestSession({
      session: SESSION_TEMPLATE,
      serverOrigin: 'https://mail.example.com',
      handlers,
    });
    expect(account.display_name).toBe('Tester');
    expect(account.primary_email).toBe('tester@example.com');
    expect(account.server_origin).toBe('https://mail.example.com');
    expect(account.remote_account_id).toBe('acct-1');
    expect(Number(account.is_primary)).toBe(1);
  });

  it('creates one account_services row per advertised data service', async () => {
    const { account, services } = await ingestSession({
      session: SESSION_TEMPLATE,
      serverOrigin: 'https://mail.example.com',
      handlers,
    });
    expect(services.map((s) => s.serviceKind).sort()).toEqual([
      SERVICE_KIND.JMAP_CONTACTS,
      SERVICE_KIND.JMAP_MAIL,
    ]);

    const rows = await engine.all(
      'SELECT service_kind, api_url, websocket_url, supports_websocket_push FROM account_services WHERE account_id = ?',
      [account.id],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.api_url).toBe('https://mail.example.com/jmap');
      expect(row.websocket_url).toBe('wss://mail.example.com/jmap/ws/');
      expect(Number(row.supports_websocket_push)).toBe(1);
    }
  });

  it('replaces capabilities on each ingest (no duplicates)', async () => {
    const { account } = await ingestSession({
      session: SESSION_TEMPLATE,
      serverOrigin: 'https://mail.example.com',
      handlers,
    });
    let caps = await engine.all(
      'SELECT service_kind, capability FROM account_capabilities WHERE account_id = ? ORDER BY service_kind, capability',
      [account.id],
    );
    const before = caps.length;

    await ingestSession({
      session: SESSION_TEMPLATE,
      serverOrigin: 'https://mail.example.com',
      handlers,
    });
    caps = await engine.all(
      'SELECT service_kind, capability FROM account_capabilities WHERE account_id = ?',
      [account.id],
    );
    expect(caps.length).toBe(before);
  });

  it('skips contacts service when the server does not advertise it', async () => {
    const session = {
      ...SESSION_TEMPLATE,
      accounts: {
        'acct-1': {
          ...SESSION_TEMPLATE.accounts['acct-1'],
          accountCapabilities: { [JMAP_CAPS.MAIL]: {} },
        },
      },
      primaryAccounts: { [JMAP_CAPS.MAIL]: 'acct-1' },
    };
    const { services } = await ingestSession({
      session,
      serverOrigin: 'https://mail.example.com',
      handlers,
    });
    expect(services.map((s) => s.serviceKind)).toEqual([SERVICE_KIND.JMAP_MAIL]);
  });

  it('throws when the session has no primary mail account', async () => {
    const session = { ...SESSION_TEMPLATE, primaryAccounts: {}, accounts: {} };
    await expect(ingestSession({
      session,
      serverOrigin: 'https://mail.example.com',
      handlers,
    })).rejects.toThrow(/primary mail account/);
  });

  describe('shared accounts (RFC 8620 §1.6.2 / RFC 9670)', () => {
    const SHARED_SESSION = {
      ...SESSION_TEMPLATE,
      accounts: {
        ...SESSION_TEMPLATE.accounts,
        'acct-shared': {
          name: 'other@example.com',
          isPersonal: false,
          isReadOnly: false,
          accountCapabilities: { [JMAP_CAPS.MAIL]: {} },
        },
        'acct-nomail': {
          name: 'calendar-only',
          isPersonal: false,
          isReadOnly: false,
          accountCapabilities: { 'urn:ietf:params:jmap:calendars': {} },
        },
      },
    };

    it('upserts every other mail-capable account as a non-primary row', async () => {
      const { account, sharedAccounts } = await ingestSession({
        session: SHARED_SESSION,
        serverOrigin: 'https://mail.example.com',
        handlers,
      });
      expect(Number(account.is_primary)).toBe(1);
      expect(Number(account.is_personal)).toBe(1);

      expect(sharedAccounts).toHaveLength(1);
      const shared = sharedAccounts[0];
      expect(shared.remote_account_id).toBe('acct-shared');
      expect(shared.display_name).toBe('other@example.com');
      expect(Number(shared.is_primary)).toBe(0);
      expect(Number(shared.is_personal)).toBe(0);

      const rows = await engine.all('SELECT remote_account_id FROM accounts ORDER BY id');
      expect(rows.map((r) => r.remote_account_id)).toEqual(['acct-1', 'acct-shared']);
    });

    it('skips non-mail accounts entirely', async () => {
      const { sharedAccounts } = await ingestSession({
        session: SHARED_SESSION,
        serverOrigin: 'https://mail.example.com',
        handlers,
      });
      expect(sharedAccounts.map((a) => a.remote_account_id)).not.toContain('acct-nomail');
    });

    it('is idempotent: re-ingesting does not duplicate shared account rows', async () => {
      await ingestSession({ session: SHARED_SESSION, serverOrigin: 'https://mail.example.com', handlers });
      await ingestSession({ session: SHARED_SESSION, serverOrigin: 'https://mail.example.com', handlers });
      const rows = await engine.all('SELECT COUNT(*) AS n FROM accounts');
      expect(Number(rows[0].n)).toBe(2);
    });
  });
});
