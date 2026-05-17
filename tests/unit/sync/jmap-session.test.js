import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory.js';
import { makeHandlers } from '../../../src/db/handlers.js';
import { DB_RPC } from '../../../src/db/protocol.js';
import { SERVICE_KIND } from '../../../src/constants/states.js';
import { ingestSession } from '../../../src/sync/backends/jmap/session.js';
import { JMAP_CAPS } from '../../../src/sync/backends/jmap/transport.js';

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
});
