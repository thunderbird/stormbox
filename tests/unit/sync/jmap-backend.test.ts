import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory.js';
import { makeHandlers } from '../../../src/db/handlers.js';
import { DB_RPC } from '../../../src/db/protocol.js';
import { SERVICE_KIND } from '../../../src/constants/states.js';
import { JmapBackend } from '../../../src/sync/backends/jmap/backend.js';
import { JmapTransport, JMAP_CAPS } from '../../../src/sync/backends/jmap/transport.js';
import { FakeWebSocket } from './_fake-ws.js';
import { MockTransport, resolveResultRefs } from './_mock-transport.js';

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

function jsonResponse(body: any, init: { status?: number; statusText?: string } = {}) {
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

  it('shares a single Email/get round trip across concurrent callers asking for the same body', async () => {
    // Two callers — typically the EmailDelivery push handler's
    // eager prefetch and a fast user click on the same brand-new
    // message — must not both fire Email/get with body
    // properties. The body_fetched_at SQL filter only dedups across
    // sequential calls; the inflight Map dedups across overlapping
    // ones.
    const account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'Tester',
      primaryEmail: 'tester@example.com',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'acct-1',
      isPrimary: true,
    })).row;
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [{ remoteId: 'mb-inbox', name: 'Inbox', role: 'inbox' }],
    });
    await handlers[DB_RPC.THREAD_UPSERT_MANY]({
      accountId: account.id,
      threads: [{ remoteId: 't-1' }],
    });
    const [thread] = await handlers[DB_RPC.QUERY]({
      sql: 'SELECT id FROM threads WHERE account_id = ?',
      params: [account.id],
    });
    await handlers[DB_RPC.MESSAGE_UPSERT_MANY]({
      accountId: account.id,
      messages: [{
        remoteId: 'e-1',
        threadId: thread.id,
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
      }],
    });
    const [msg] = await handlers[DB_RPC.QUERY]({
      sql: 'SELECT id FROM messages WHERE account_id = ?',
      params: [account.id],
    });

    let inflightResolve;
    const inflightGate = new Promise((r) => { inflightResolve = r; });
    let bodyGetCallCount = 0;
    const transport = new MockTransport();
    transport.handle('Email/get', async (params) => {
      bodyGetCallCount += 1;
      // Hold the response open until the test releases it. While
      // this is awaiting, the second ensureMessageBodies call
      // must see the in-flight promise and piggy-back rather than
      // issuing a parallel Email/get.
      await inflightGate;
      return {
        state: 'es-1',
        list: params.ids.map((id) => ({
          id,
          blobId: `blob-${id}`,
          threadId: 't-1',
          mailboxIds: { 'mb-inbox': true },
          keywords: {},
          bodyStructure: { partId: `body-${id}`, type: 'text/plain', size: 5 },
          textBody: [{ partId: `body-${id}` }],
          htmlBody: [],
          attachments: [],
          bodyValues: { [`body-${id}`]: { value: 'hello', isTruncated: false } },
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

    const first = backend.ensureMessageBodies([msg.id]);
    const second = backend.ensureMessageBodies([msg.id]);
    inflightResolve();
    const [r1, r2] = await Promise.all([first, second]);

    expect(bodyGetCallCount).toBe(1);
    expect(r1.fetched).toBe(1);
    expect(r2.fetched).toBe(1);
    // Inflight map should be drained once both promises settle.
    expect(backend._bodyFetchInflight.size).toBe(0);
  });
});

describe('JmapBackend.ensureMessageBodyForDisplay', () => {
  it('returns cached without Email/get when body_fetched_at is set', async () => {
    const account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'Tester',
      primaryEmail: 'tester@example.com',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'acct-1',
      isPrimary: true,
    })).row;
    await handlers[DB_RPC.THREAD_UPSERT_MANY]({
      accountId: account.id,
      threads: [{ remoteId: 't-1' }],
    });
    const [thread] = await handlers[DB_RPC.QUERY]({
      sql: 'SELECT id FROM threads WHERE account_id = ?',
      params: [account.id],
    });
    await handlers[DB_RPC.MESSAGE_UPSERT_MANY]({
      accountId: account.id,
      messages: [{
        remoteId: 'e-1',
        threadId: thread.id,
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
      }],
    });
    const [msg] = await handlers[DB_RPC.QUERY]({
      sql: 'SELECT id FROM messages WHERE account_id = ?',
      params: [account.id],
    });
    await handlers[DB_RPC.TRANSACTION]({
      statements: [{
        sql: 'UPDATE messages SET body_fetched_at = ? WHERE id = ?',
        params: [Date.now(), msg.id],
      }],
    });

    let bodyGetCalls = 0;
    const transport = new MockTransport();
    transport.handle('Email/get', () => {
      bodyGetCalls += 1;
      return { state: 'es-1', list: [] };
    });
    const backend = new JmapBackend({
      transport,
      serverOrigin: 'https://mail.example.com',
      handlers,
      options: { useWebSocket: false },
    });
    backend.account = { id: account.id, remote_account_id: account.remote_account_id };

    const result = await backend.ensureMessageBodyForDisplay(msg.id);
    expect(result).toEqual({ fetched: 0, cached: true });
    expect(bodyGetCalls).toBe(0);
  });

  it('does not await an in-flight prefetch batch (priority single-id fetch)', async () => {
    const account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'Tester',
      primaryEmail: 'tester@example.com',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'acct-1',
      isPrimary: true,
    })).row;
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
        { remoteId: 'e-1', threadRemote: 't-1' },
        { remoteId: 'e-2', threadRemote: 't-2' },
      ].map(({ remoteId, threadRemote }) => ({
        remoteId,
        threadId: threadId(threadRemote),
        remoteThreadId: threadRemote,
        subject: remoteId,
        preview: 'p',
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
      })),
    });
    const messages = await handlers[DB_RPC.QUERY]({
      sql: 'SELECT id, remote_id FROM messages WHERE account_id = ? ORDER BY remote_id',
      params: [account.id],
    });
    const msgA = messages.find((m) => m.remote_id === 'e-1');

    let batchGateResolve;
    const batchGate = new Promise((r) => { batchGateResolve = r; });
    const seenGets = [];
    const transport = new MockTransport();
    transport.handle('Email/get', async (params) => {
      seenGets.push([...params.ids].sort());
      if (params.ids.length > 1) {
        await batchGate;
      }
      return {
        state: 'es-1',
        list: params.ids.map((id) => ({
          id,
          blobId: `blob-${id}`,
          threadId: id,
          mailboxIds: { 'mb-inbox': true },
          keywords: {},
          bodyStructure: { partId: `body-${id}`, type: 'text/plain', size: 5 },
          textBody: [{ partId: `body-${id}` }],
          htmlBody: [],
          attachments: [],
          bodyValues: { [`body-${id}`]: { value: `hello ${id}`, isTruncated: false } },
        })),
      };
    });
    const backend = new JmapBackend({
      transport,
      serverOrigin: 'https://mail.example.com',
      handlers,
      options: { useWebSocket: false },
    });
    backend.account = { id: account.id, remote_account_id: account.remote_account_id };

    const batchPromise = backend.ensureMessageBodies(messages.map((m) => m.id));
    const displayPromise = backend.ensureMessageBodyForDisplay(msgA.id);
    const displayResult = await displayPromise;

    expect(displayResult.fetched).toBe(1);
    expect(seenGets.some((ids) => ids.length === 1 && ids[0] === 'e-1')).toBe(true);
    expect(backend._bodyFetchInflight.has(msgA.id)).toBe(true);

    batchGateResolve();
    await batchPromise;
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
      // RFC 8620 §3.1.3 result references: method-call params may
      // contain "#name": { resultOf, name, path } objects that the
      // server resolves against earlier responses in the same
      // request. Without this, chained Email/query -> Email/get and
      // Email/queryChanges -> Email/get end up calling the second
      // handler with `params.ids` undefined, so persistEmails sees
      // an empty list and the messages table never gets the new
      // rows. MockTransport already does this for HTTP; we mirror
      // its behaviour over the WS path here.
      const byCallId = new Map();
      for (const [methodName, rawParams, callId] of msg.methodCalls) {
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
        const params = resolveResultRefs(rawParams, byCallId);
        const payload = await handler(params, callId);
        const tuple = [methodName, payload, callId];
        responses.push(tuple);
        byCallId.set(callId, tuple);
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

  it('catches up active query views on startup via Email/queryChanges', async () => {
    // Pre-seed an account + inbox + query_view (with two items) so
    // backend.start() finds an "active" view from the previous
    // session. While we were offline a peer device destroyed e-2;
    // the startup catch-up pass must run Email/queryChanges against
    // each stored view and apply the delta so the stale row drops
    // out before the first repaint.
    const account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'Tester',
      primaryEmail: 'tester@example.com',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'acct-1',
      isPrimary: true,
    })).row;
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [{
        remoteId: 'mb-inbox', name: 'Inbox', role: 'inbox',
        totalEmails: 2, unreadEmails: 0,
      }],
    });
    const inboxRow = await engine.get(
      'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
      [account.id, 'mb-inbox'],
    );
    const ts = Date.now();
    await handlers[DB_RPC.QUERY]({
      sql: `INSERT INTO query_views(
              account_id, view_type, folder_id, filter_json, sort_json,
              collapse_threads, query_state, can_calculate_changes, total,
              created_at, updated_at, last_accessed_at
            ) VALUES (?, 'mailbox-window', ?, ?, ?, 0, 'eqs-1', 1, 2, ?, ?, ?)`,
      params: [
        account.id,
        inboxRow.id,
        JSON.stringify({ inMailbox: 'mb-inbox' }),
        JSON.stringify([{ property: 'receivedAt', isAscending: false }]),
        ts, ts, ts,
      ],
    });
    const seededView = await engine.get(
      `SELECT id FROM query_views WHERE account_id = ? AND folder_id = ?`,
      [account.id, inboxRow.id],
    );
    await handlers[DB_RPC.TRANSACTION]({
      statements: ['e-1', 'e-2'].map((id, i) => ({
        sql: `INSERT INTO query_view_items(view_id, position, message_id, remote_id)
              VALUES (?, ?, NULL, ?)`,
        params: [seededView.id, i, id],
      })),
    });

    let queryChangesCalls = 0;
    const scenario = {
      'Mailbox/get': () => ({
        list: [{ id: 'mb-inbox', name: 'Inbox', role: 'inbox', totalEmails: 1 }],
        state: 'mb-1',
      }),
      'Identity/get': () => ({ list: [], state: 'id' }),
      'AddressBook/get': () => ({ list: [], state: 'ab' }),
      'ContactCard/query': () => ({ ids: [], total: 0, state: 'cc' }),
      'ContactCard/get': () => ({ list: [], state: 'cc' }),
      'Email/queryChanges': (params) => {
        queryChangesCalls += 1;
        expect(params.sinceQueryState).toBe('eqs-1');
        return {
          oldQueryState: 'eqs-1',
          newQueryState: 'eqs-2',
          total: 1,
          removed: ['e-2'],
          added: [],
        };
      },
      'Email/get': () => ({ list: [], state: 'es-1' }),
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

    expect(queryChangesCalls).toBeGreaterThan(0);
    const items = await engine.all(
      'SELECT remote_id FROM query_view_items WHERE view_id = ? ORDER BY position',
      [seededView.id],
    );
    expect(items.map((i) => i.remote_id)).toEqual(['e-1']);

    await backend.stop();
  });

  it('refreshes active query views when EmailDelivery push arrives so new messages land in the list', async () => {
    const emailFixture = (id, overrides = {}) => ({
      id,
      blobId: `blob-${id}`,
      threadId: `thr-${id}`,
      mailboxIds: { 'mb-inbox': true },
      keywords: {},
      size: 100,
      receivedAt: '2026-05-01T12:00:00Z',
      sentAt: '2026-05-01T11:59:00Z',
      messageId: [`<${id}@example.com>`],
      sender: [{ name: 'S', email: 's@example.com' }],
      from: [{ name: 'F', email: 'f@example.com' }],
      to: [{ name: 'T', email: 't@example.com' }],
      subject: `Subject ${id}`,
      preview: `preview ${id}`,
      hasAttachment: false,
      ...overrides,
    });
    let queryChangesCalls = 0;
    const scenario = {
      'Mailbox/get': () => ({
        list: [{
          id: 'mb-inbox', name: 'Inbox', role: 'inbox', totalEmails: 1,
        }],
        state: 'mb-1',
      }),
      'Identity/get': () => ({ list: [], state: 'id' }),
      'AddressBook/get': () => ({ list: [], state: 'ab' }),
      'ContactCard/query': () => ({ ids: [], total: 0, state: 'cc' }),
      'ContactCard/get': () => ({ list: [], state: 'cc' }),
      'Email/query': () => ({
        ids: ['e-1'],
        total: 1,
        queryState: 'eqs-1',
        canCalculateChanges: true,
        position: 0,
      }),
      'Email/get': (params) => ({
        list: (params.ids ?? []).map((id) => emailFixture(id)),
        state: 'es-1',
      }),
      'Email/queryChanges': () => {
        queryChangesCalls += 1;
        return {
          oldQueryState: 'eqs-1',
          newQueryState: 'eqs-2',
          total: 2,
          removed: [],
          added: [{ id: 'e-new', index: 0 }],
        };
      },
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

    // Seed an active query view so _refreshActiveQueryViews has
    // somewhere to run Email/queryChanges. ensureFolderWindow writes
    // query_views + query_view_items for the inbox window.
    const folders = await handlers[DB_RPC.FOLDER_LIST]({ accountId: backend.account.id });
    const inboxRow = folders.find((f) => f.role === 'inbox');
    await backend.ensureFolderWindow(inboxRow.id, { offset: 0, limit: 50 });

    const initialView = await engine.get(
      `SELECT id FROM query_views WHERE account_id = ? AND folder_id = ?`,
      [backend.account.id, inboxRow.id],
    );
    expect(initialView).toBeTruthy();
    const initialItems = await engine.all(
      'SELECT remote_id FROM query_view_items WHERE view_id = ? ORDER BY position',
      [initialView.id],
    );
    expect(initialItems.map((i) => i.remote_id)).toEqual(['e-1']);
    expect(queryChangesCalls).toBe(0);

    // EmailDelivery push: server is telling us new mail arrived. The
    // backend must trigger Email/queryChanges against the inbox view
    // so the new id is appended to query_view_items even though no
    // Email/changes baseline state exists yet.
    ws._receive({
      '@type': 'StateChange',
      changed: { 'acct-1': { EmailDelivery: 'd-1' } },
      pushState: 'push-d',
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(queryChangesCalls).toBeGreaterThan(0);
    const refreshedItems = await engine.all(
      'SELECT remote_id FROM query_view_items WHERE view_id = ? ORDER BY position',
      [initialView.id],
    );
    expect(refreshedItems.map((i) => i.remote_id).sort()).toEqual(['e-1', 'e-new']);

    await backend.stop();
  });

  it('eagerly fetches the body of a newly-delivered message so click-to-read is a local read', async () => {
    // After my push refresh lands the new metadata row, the backend
    // must also fetch the body and persist it into body_values.
    // Doing it now means the user's first click on the new message
    // renders from SQLite without a server round trip — which is
    // exactly the latency the user noticed when push wasn't
    // delivering at all.
    const emailMeta = (id) => ({
      id,
      blobId: `blob-${id}`,
      threadId: `thr-${id}`,
      mailboxIds: { 'mb-inbox': true },
      keywords: {},
      size: 100,
      receivedAt: '2026-05-01T12:00:00Z',
      sentAt: '2026-05-01T11:59:00Z',
      messageId: [`<${id}@example.com>`],
      sender: [{ name: 'S', email: 's@example.com' }],
      from: [{ name: 'F', email: 'f@example.com' }],
      to: [{ name: 'T', email: 't@example.com' }],
      subject: `Subject ${id}`,
      preview: `preview ${id}`,
      hasAttachment: false,
    });
    const emailBody = (id) => ({
      ...emailMeta(id),
      bodyStructure: { partId: `body-${id}`, type: 'text/plain', size: 12 },
      textBody: [{ partId: `body-${id}` }],
      htmlBody: [],
      attachments: [],
      bodyValues: { [`body-${id}`]: { value: `hello ${id}`, isTruncated: false } },
    });

    let metadataGetCalls = 0;
    let bodyGetCalls = 0;
    let lastBodyGetIds = null;
    const scenario = {
      'Mailbox/get': () => ({
        list: [{ id: 'mb-inbox', name: 'Inbox', role: 'inbox', totalEmails: 1 }],
        state: 'mb-1',
      }),
      'Identity/get': () => ({ list: [], state: 'id' }),
      'AddressBook/get': () => ({ list: [], state: 'ab' }),
      'ContactCard/query': () => ({ ids: [], total: 0, state: 'cc' }),
      'ContactCard/get': () => ({ list: [], state: 'cc' }),
      'Email/query': () => ({
        ids: ['e-1'],
        total: 1,
        queryState: 'eqs-1',
        canCalculateChanges: true,
        position: 0,
      }),
      'Email/get': (params) => {
        // fetchTextBodyValues / bodyProperties is what
        // distinguishes a "give me the body" call from a "give me
        // the list metadata" call. Stalwart returns the same
        // envelope shape; we only respond with body data when the
        // body flags are present so the test would notice if the
        // backend re-used the metadata path by mistake.
        const isBodyFetch = params.fetchTextBodyValues === true;
        if (isBodyFetch) {
          bodyGetCalls += 1;
          lastBodyGetIds = params.ids;
          return {
            state: 'es-1',
            list: (params.ids ?? []).map((id) => emailBody(id)),
          };
        }
        metadataGetCalls += 1;
        return {
          state: 'es-1',
          list: (params.ids ?? []).map((id) => emailMeta(id)),
        };
      },
      'Email/queryChanges': () => ({
        oldQueryState: 'eqs-1',
        newQueryState: 'eqs-2',
        total: 2,
        removed: [],
        added: [{ id: 'e-new', index: 0 }],
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

    // Seed the inbox view so _refreshActiveQueryViews has a view
    // to apply queryChanges against.
    const folders = await handlers[DB_RPC.FOLDER_LIST]({ accountId: backend.account.id });
    const inboxRow = folders.find((f) => f.role === 'inbox');
    await backend.ensureFolderWindow(inboxRow.id, { offset: 0, limit: 50 });

    // Baseline: only the initial metadata fetches have happened.
    const baselineMetadataGets = metadataGetCalls;
    expect(bodyGetCalls).toBe(0);

    // Fire EmailDelivery. The backend should: (1) run
    // Email/queryChanges, (2) Email/get the new id's metadata via
    // the back-reference in syncFolderWindowChanges, (3) THEN call
    // Email/get a second time with body properties for that id.
    ws._receive({
      '@type': 'StateChange',
      changed: { 'acct-1': { EmailDelivery: 'd-1' } },
      pushState: 'push-d',
    });
    // Poll instead of a fixed sleep; the chain (queryChanges -> get
    // metadata -> persistEmails -> _prefetchBodiesForNewlyDelivered
    // -> ensureMessageBodies -> get bodies -> persistBodies) takes
    // multiple WS round trips and is timing-sensitive in CI.
    for (let i = 0; i < 100 && bodyGetCalls === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(metadataGetCalls).toBeGreaterThan(baselineMetadataGets);
    expect(bodyGetCalls).toBe(1);
    expect(lastBodyGetIds).toEqual(['e-new']);

    // The body must have actually been persisted (this is the
    // contract that makes click-to-read instant).
    const newMsg = await engine.get(
      'SELECT id, body_fetched_at FROM messages WHERE account_id = ? AND remote_id = ?',
      [backend.account.id, 'e-new'],
    );
    expect(newMsg).toBeTruthy();
    expect(newMsg.body_fetched_at).not.toBeNull();
    const bodyValues = await engine.all(
      'SELECT value FROM body_values WHERE message_id = ?',
      [newMsg.id],
    );
    expect(bodyValues.map((r) => r.value)).toContain('hello e-new');

    await backend.stop();
  });
});
