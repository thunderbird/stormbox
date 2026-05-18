import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory.js';
import { makeHandlers } from '../../../src/db/handlers.js';
import { DB_RPC } from '../../../src/db/protocol.js';
import { SERVICE_KIND } from '../../../src/constants/states.js';
import { JmapBackend } from '../../../src/sync/backends/jmap/backend.js';
import { JmapTransport, JMAP_CAPS } from '../../../src/sync/backends/jmap/transport.js';
import { FakeWebSocket } from './_fake-ws.js';
import { MockTransport } from './_mock-transport.js';

const SESSION = {
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
        [JMAP_CAPS.MAIL]: {},
        [JMAP_CAPS.SUBMISSION]: {},
        [JMAP_CAPS.CONTACTS]: {},
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

function makeJmapHandlers(scenario) {
  return async (url, init) => {
    if (!init || init.method !== 'POST') {
      // Session fetch (GET).
      return jsonResponse(scenario.session ?? SESSION);
    }
    const body = JSON.parse(init.body);
    const responses = [];
    for (const [methodName, params, callId] of body.methodCalls) {
      const handler = scenario[methodName];
      if (!handler) {
        throw new Error(`Scenario has no handler for ${methodName}`);
      }
      const payload = await handler(params, callId);
      responses.push([methodName, payload, callId]);
    }
    return jsonResponse({ methodResponses: responses });
  };
}

function jsonResponse(body, init = {}) {
  return {
    ok: init.status == null || (init.status >= 200 && init.status < 300),
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

let engine;
let handlers;

beforeEach(async () => {
  FakeWebSocket._reset();
  engine = await bootTestEngine();
  handlers = makeHandlers(engine);
});

afterEach(async () => {
  await engine.close();
});

describe('JmapBackend.start', () => {
  it('ingests session, syncs mailboxes/identities/contacts, opens WS', async () => {
    const scenario = {
      'Mailbox/get': () => ({
        list: [
          { id: 'mb-inbox', name: 'Inbox', role: 'inbox' },
          { id: 'mb-sent', name: 'Sent', role: 'sent' },
        ],
        state: 'mb-1',
      }),
      'Identity/get': () => ({
        list: [{ id: 'id-1', name: 'Tester', email: 'tester@example.com' }],
        state: 'id-1',
      }),
      'AddressBook/get': () => ({
        list: [{ id: 'ab-default', name: 'Default', isDefault: true }],
        state: 'ab-1',
      }),
      'ContactCard/query': () => ({ ids: ['c-1'], total: 1, state: 'cc-1' }),
      'ContactCard/get': () => ({
        list: [{
          id: 'c-1',
          addressBookId: 'ab-default',
          uid: 'u-1',
          fullName: 'Jane Doe',
          emails: [{ email: 'jane@example.com', isDefault: true }],
        }],
        state: 'cc-1',
      }),
    };
    const fetchMock = vi.fn(makeJmapHandlers(scenario));
    const transport = new JmapTransport({
      sessionUrl: 'https://mail.example.com/.well-known/jmap',
      getAuthHeader: async () => 'Bearer test',
      fetch: fetchMock,
      WebSocketImpl: FakeWebSocket,
    });
    const backend = new JmapBackend({
      transport,
      serverOrigin: 'https://mail.example.com',
      handlers,
    });

    const startPromise = backend.start();
    // Start opens the WS once mailboxes/identities/contacts are synced;
    // wait for it and feed a successful open.
    queueMicrotask(async () => {
      const ws = await FakeWebSocket._waitForInstance();
      ws._open();
    });
    await startPromise;
    // start() resolves as soon as folders are populated. Identities,
    // contacts, and the WebSocket bootstrap continue in the background;
    // wait for that chain before checking their effects.
    await backend.bootstrapped();

    const accounts = await handlers[DB_RPC.ACCOUNT_LIST]();
    expect(accounts).toHaveLength(1);
    const folders = await handlers[DB_RPC.FOLDER_LIST]({ accountId: accounts[0].id });
    expect(folders.map((f) => f.role).sort()).toEqual(['inbox', 'sent']);
    const identities = await handlers[DB_RPC.IDENTITY_LIST]({ accountId: accounts[0].id });
    expect(identities).toHaveLength(1);
    const addressbooks = await handlers[DB_RPC.ADDRESSBOOK_LIST]({ accountId: accounts[0].id });
    expect(addressbooks).toHaveLength(1);
    expect(addressbooks[0].service_kind).toBe(SERVICE_KIND.JMAP_CONTACTS);
    const auto = await handlers[DB_RPC.CONTACT_AUTOCOMPLETE]({
      accountId: accounts[0].id,
      prefix: 'ja',
    });
    expect(auto.find((m) => m.email === 'jane@example.com')).toBeTruthy();

    await backend.stop();
  });

  it('keeps going on HTTP if the WebSocket open fails', async () => {
    const scenario = {
      'Mailbox/get': () => ({ list: [], state: 'mb' }),
      'Identity/get': () => ({ list: [], state: 'id' }),
      'AddressBook/get': () => ({ list: [], state: 'ab' }),
      'ContactCard/query': () => ({ ids: [], total: 0, state: 'cc' }),
      'ContactCard/get': () => ({ list: [], state: 'cc' }),
    };
    const fetchMock = vi.fn(makeJmapHandlers(scenario));
    const transport = new JmapTransport({
      sessionUrl: 'https://mail.example.com/.well-known/jmap',
      getAuthHeader: async () => 'Bearer test',
      fetch: fetchMock,
      WebSocketImpl: FakeWebSocket,
    });
    const backend = new JmapBackend({
      transport,
      serverOrigin: 'https://mail.example.com',
      handlers,
    });

    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const startPromise = backend.start();
    queueMicrotask(async () => {
      const ws = await FakeWebSocket._waitForInstance();
      ws._error({ message: 'boom' });
    });
    await startPromise;
    await backend.bootstrapped();
    consoleWarn.mockRestore();
    await backend.stop();
  });
});

describe('JmapBackend.ensureMessageBodies', () => {
  it('maps local message ids to remote ids, skips already-fetched bodies, and fetches in one batch', async () => {
    const accountResult = await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'Tester',
      primaryEmail: 'tester@example.com',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'acct-1',
      isPrimary: true,
    });
    const account = accountResult.row;
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [{ remoteId: 'mb-inbox', name: 'Inbox', role: 'inbox' }],
    });
    await handlers[DB_RPC.THREAD_UPSERT_MANY]({
      accountId: account.id,
      threads: [{ remoteId: 't-1' }, { remoteId: 't-2' }],
    });
    const threads = await handlers[DB_RPC.QUERY]({
      sql: 'SELECT id, remote_id FROM threads WHERE account_id = ?',
      params: [account.id],
    });
    const threadId = (remoteId) => threads.find((t) => t.remote_id === remoteId).id;
    await handlers[DB_RPC.MESSAGE_UPSERT_MANY]({
      accountId: account.id,
      messages: [
        {
          remoteId: 'e-1',
          threadId: threadId('t-1'),
          remoteThreadId: 't-1',
          subject: 'one',
          preview: 'p1',
          receivedAt: Date.now(),
          sentAt: Date.now(),
          hasAttachment: false,
          keywordsJson: '{}',
          keywords: [],
          isSeen: false,
          isFlagged: false,
          isAnswered: false,
          isDraft: false,
          isForwarded: false,
          isJunk: false,
          addresses: [],
        },
        {
          remoteId: 'e-2',
          threadId: threadId('t-2'),
          remoteThreadId: 't-2',
          subject: 'two',
          preview: 'p2',
          receivedAt: Date.now(),
          sentAt: Date.now(),
          hasAttachment: false,
          keywordsJson: '{}',
          keywords: [],
          isSeen: false,
          isFlagged: false,
          isAnswered: false,
          isDraft: false,
          isForwarded: false,
          isJunk: false,
          addresses: [],
        },
      ],
    });
    const messages = await handlers[DB_RPC.QUERY]({
      sql: 'SELECT id, remote_id FROM messages WHERE account_id = ? ORDER BY remote_id',
      params: [account.id],
    });

    const transport = new MockTransport();
    let seenIds = null;
    transport.handle('Email/get', (params) => {
      seenIds = params.ids;
      return {
        state: 'es-1',
        list: params.ids.map((id) => ({
          id,
          blobId: `blob-${id}`,
          threadId: id === 'e-1' ? 't-1' : 't-2',
          mailboxIds: { 'mb-inbox': true },
          keywords: {},
          bodyStructure: { partId: `body-${id}`, type: 'text/plain', size: 12 },
          textBody: [{ partId: `body-${id}` }],
          htmlBody: [],
          attachments: [],
          bodyValues: {
            [`body-${id}`]: { value: `hello ${id}`, isTruncated: false },
          },
        })),
      };
    });
    const backend = new JmapBackend({
      transport,
      serverOrigin: 'https://mail.example.com',
      handlers,
      options: { useWebSocket: false },
    });
    backend.account = {
      id: account.id,
      remote_account_id: account.remote_account_id,
    };

    const result = await backend.ensureMessageBodies(messages.map((m) => m.id));
    expect(result.fetched).toBe(2);
    expect(seenIds).toEqual(['e-1', 'e-2']);
    const bodies = await handlers[DB_RPC.QUERY]({
      sql: 'SELECT kind, value FROM body_values ORDER BY value',
      params: [],
    });
    expect(bodies.map((b) => b.value)).toEqual(['hello e-1', 'hello e-2']);

    seenIds = null;
    const second = await backend.ensureMessageBodies(messages.map((m) => m.id));
    expect(second.fetched).toBe(0);
    expect(seenIds).toBeNull();
  });
});

/**
 * Wire the FakeWebSocket so that JMAP Request frames sent through it are
 * dispatched against the same scenario handler map and replied as
 * Response frames. This lets us exercise the WS code path end-to-end
 * without a real socket.
 */
function autoRespondWebSocket(ws, scenario) {
  ws.send = (raw) => {
    ws.sent.push(raw);
    const msg = JSON.parse(raw);
    if (msg['@type'] !== 'Request') return;
    queueMicrotask(async () => {
      const responses = [];
      for (const [methodName, params, callId] of msg.methodCalls) {
        const handler = scenario[methodName];
        if (!handler) {
          ws._receive({
            '@type': 'RequestError',
            requestId: msg.id,
            type: 'noHandler',
            detail: `Scenario has no handler for ${methodName}`,
          });
          return;
        }
        const payload = await handler(params, callId);
        responses.push([methodName, payload, callId]);
      }
      ws._receive({
        '@type': 'Response',
        requestId: msg.id,
        methodResponses: responses,
      });
    });
  };
}

describe('JmapBackend StateChange dispatch', () => {
  it('runs Mailbox/changes when a Mailbox StateChange arrives', async () => {
    let mailboxGetCalls = 0;
    const scenario = {
      'Mailbox/get': (params) => {
        mailboxGetCalls += 1;
        return {
          list: (params.ids ?? ['mb-inbox']).map((id) => ({
            id, name: id === 'mb-inbox' ? 'Inbox' : id, role: id === 'mb-inbox' ? 'inbox' : null,
          })),
          state: mailboxGetCalls === 1 ? 'mb-1' : 'mb-2',
        };
      },
      'Mailbox/changes': () => ({
        oldState: 'mb-1',
        newState: 'mb-2',
        hasMoreChanges: false,
        created: ['mb-archive'],
        updated: [],
        destroyed: [],
      }),
      'Identity/get': () => ({ list: [], state: 'id' }),
      'AddressBook/get': () => ({ list: [], state: 'ab' }),
      'ContactCard/query': () => ({ ids: [], total: 0, state: 'cc' }),
      'ContactCard/get': () => ({ list: [], state: 'cc' }),
    };
    const fetchMock = vi.fn(makeJmapHandlers(scenario));
    const transport = new JmapTransport({
      sessionUrl: 'https://mail.example.com/.well-known/jmap',
      getAuthHeader: async () => 'Bearer test',
      fetch: fetchMock,
      WebSocketImpl: FakeWebSocket,
    });
    const backend = new JmapBackend({
      transport, serverOrigin: 'https://mail.example.com', handlers,
    });

    const startPromise = backend.start();
    queueMicrotask(async () => {
      const ws = await FakeWebSocket._waitForInstance();
      autoRespondWebSocket(ws, scenario);
      ws._open();
    });
    await startPromise;
    await backend.bootstrapped();
    const ws = await FakeWebSocket._waitForInstance();

    // A Mailbox StateChange arrives. The backend should run
    // Mailbox/changes + Mailbox/get for the new id over the WS, and
    // persist mb-archive plus the push state.
    ws._receive({
      '@type': 'StateChange',
      changed: { 'acct-1': { Mailbox: 'mb-2' } },
      pushState: 'push-bbb',
    });
    // Wait long enough for the chained Request/Response microtasks +
    // the fake fetches to settle.
    await new Promise((r) => setTimeout(r, 50));

    const folders = await handlers[DB_RPC.FOLDER_LIST]({ accountId: backend.account.id });
    expect(folders.map((f) => f.remote_id)).toContain('mb-archive');

    const svc = await engine.get(
      `SELECT push_state FROM account_services
        WHERE account_id = ? AND service_kind = ?`,
      [backend.account.id, SERVICE_KIND.JMAP_MAIL],
    );
    expect(svc.push_state).toBe('push-bbb');

    await backend.stop();
  });
});
