import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { SERVICE_KIND } from '../../../src/constants/states';
import { JmapBackend } from '../../../src/sync/backends/jmap/backend';
import { JmapTransport, JMAP_CAPS } from '../../../src/sync/backends/jmap/transport';
import { syncFolderWindow } from '../../../src/sync/backends/jmap/messages';
import { FakeWebSocket } from './_fake-ws';
import { MockTransport, resolveResultRefs } from './_mock-transport';

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
    [JMAP_CAPS.CORE]: {
      maxConcurrentRequests: 4,
      maxObjectsInGet: 500,
      maxObjectsInSet: 500,
    },
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
    // Track when the batch settles so we can assert the display call
    // resolves while the batch is still in flight (without reaching
    // into the backend's private _bodyFetchInflight map).
    let batchSettled = false;
    batchPromise.finally(() => { batchSettled = true; });

    const displayPromise = backend.ensureMessageBodyForDisplay(msgA.id);
    const displayResult = await displayPromise;

    expect(displayResult.fetched).toBe(1);
    expect(seenGets.some((ids) => ids.length === 1 && ids[0] === 'e-1')).toBe(true);
    // The whole point: the priority single-id fetch resolved BEFORE
    // the batch was allowed to complete.
    expect(batchSettled).toBe(false);

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
    // Predicate-poll for the Mailbox/changes -> Mailbox/get pipeline
    // to land mb-archive instead of a fixed 50ms sleep that could rot
    // under CI load.
    await vi.waitFor(async () => {
      const folders = await handlers[DB_RPC.FOLDER_LIST]({ accountId: backend.account.id });
      expect(folders.map((f) => f.remote_id)).toContain('mb-archive');
    });

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
    // Predicate-poll for the push-driven Email/queryChanges to fire
    // instead of relying on a fixed 50ms sleep.
    await vi.waitFor(() => expect(queryChangesCalls).toBeGreaterThan(0));
    const refreshedItems = await engine.all(
      'SELECT remote_id FROM query_view_items WHERE view_id = ? ORDER BY position',
      [initialView.id],
    );
    expect(refreshedItems.map((i) => i.remote_id).sort()).toEqual(['e-1', 'e-new']);

    await backend.stop();
  });

  it('does not race the Email state token across overlapping StateChange frames', async () => {
    // Failure mode: the transport fires StateChange listeners without
    // awaiting them. If two Email pushes arrive while the first
    // _onStateChange is still awaiting Email/changes, both passes
    // independently load sync_states.Email at the same moment, both
    // issue Email/changes with the same sinceState, and only the
    // last write to SYNC_STATE_SET wins. The middle delta can be
    // missed on the next reconnect if the order goes wrong.
    //
    // Contract this test pins: when push frames overlap, the second
    // pass observes the first pass's newState (or coalesces away
    // entirely). It must never re-call Email/changes with the same
    // sinceState the first call used.

    let emailChangesGateResolve;
    const emailChangesGate = new Promise((r) => { emailChangesGateResolve = r; });
    const seenSinceStates = [];
    let emailChangesCallCount = 0;
    const scenario = {
      'Mailbox/get': () => ({ list: [], state: 'mb-1' }),
      'Identity/get': () => ({ list: [], state: 'id' }),
      'AddressBook/get': () => ({ list: [], state: 'ab' }),
      'ContactCard/query': () => ({ ids: [], total: 0, state: 'cc' }),
      'ContactCard/get': () => ({ list: [], state: 'cc' }),
      'Email/changes': async (params) => {
        emailChangesCallCount += 1;
        seenSinceStates.push(params.sinceState);
        if (emailChangesCallCount === 1) {
          await emailChangesGate;
        }
        return {
          accountId: params.accountId,
          oldState: params.sinceState,
          newState: emailChangesCallCount === 1 ? 'es-2' : 'es-3',
          hasMoreChanges: false,
          created: [], updated: [], destroyed: [],
        };
      },
      'Email/get': (params) => ({ state: 'es', list: [], notFound: params.ids ?? [] }),
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

    // The StateChange handler only fires Email/changes when a
    // baseline sync_states.Email row exists (cold-start clients
    // wait for the first full sync to populate it). Seed one
    // directly so we can exercise the changes path on push.
    await handlers[DB_RPC.SYNC_STATE_SET]({
      accountId: backend.account.id,
      objectType: 'Email',
      state: 'es-1',
    });

    ws._receive({
      '@type': 'StateChange',
      changed: { 'acct-1': { Email: 'es-2' } },
      pushState: 'push-1',
    });
    // Wait for the first Email/changes to enter the gated handler.
    await vi.waitFor(() => expect(emailChangesCallCount).toBe(1));

    // Second push arrives while the first pass is still gated.
    ws._receive({
      '@type': 'StateChange',
      changed: { 'acct-1': { Email: 'es-3' } },
      pushState: 'push-2',
    });

    // Under the buggy concurrent path, the second StateChange
    // listener starts a parallel _doStateChange that races to
    // _loadSyncState before the first call has written its new
    // state — try to wait for that second Email/changes to enter
    // the handler, which pins the race window. Under the fixed
    // (serialized) path the second call cannot enter until SC1
    // releases the gate, so this waitFor will time out; the
    // .catch swallows the timeout and the test continues. Either
    // way the assertions below see the eventual call pattern.
    await vi.waitFor(
      () => expect(emailChangesCallCount).toBe(2),
      { timeout: 250 },
    ).catch(() => {});

    emailChangesGateResolve();

    await vi.waitFor(() => expect(emailChangesCallCount).toBe(2), { timeout: 2_000 });
    // Brief drain for the final SYNC_STATE_SET write to land.
    await new Promise((r) => setTimeout(r, 50));

    const persisted = await handlers[DB_RPC.SYNC_STATE_GET]({
      accountId: backend.account.id,
      objectType: 'Email',
      scope: '',
    });

    // Bug exposure #1 (sinceState race): without serialization both
    // passes load sync_states.Email='es-1' before either writes a
    // new state, so the server sees ['es-1', 'es-1']. With
    // serialization the second pass observes the first pass's
    // newState and runs with sinceState='es-2'.
    expect(seenSinceStates).not.toEqual(['es-1', 'es-1']);

    // Bug exposure #2 (write order race): under the current code
    // the slow first call resolves AFTER the fast second call, so
    // sync_states.Email is overwritten with the older 'es-2' even
    // though the server's most recent newState was 'es-3'. On the
    // next reconnect that stale token replays already-applied
    // changes (or worse, misses changes if the server has GC'd it).
    // The fixed code threads newState forward and ends up at es-3.
    expect(persisted?.state).toBe('es-3');

    await backend.stop();
  });

  it('does not race query_views.query_state across overlapping EmailDelivery frames', async () => {
    // Same shape of race, different code path. _refreshActiveQueryViews
    // reads each view's saved query_state at the start of the loop
    // and issues Email/queryChanges with it. Two concurrent passes
    // both read the same query_state, so the second call replays a
    // delta the first call already applied. With per-view uniqueness
    // constraints the apply step doesn't corrupt rows, but it wastes
    // a JMAP round trip per overlapping push and races the
    // query_views.total bookkeeping.
    const emailFixture = (id) => ({
      id, blobId: `blob-${id}`, threadId: `thr-${id}`,
      mailboxIds: { 'mb-inbox': true }, keywords: {},
      size: 100,
      receivedAt: '2026-05-01T12:00:00Z',
      sentAt: '2026-05-01T11:59:00Z',
      messageId: [`<${id}@example.com>`],
      sender: [{ name: 'S', email: 's@example.com' }],
      from: [{ name: 'F', email: 'f@example.com' }],
      to: [{ name: 'T', email: 't@example.com' }],
      subject: `Subject ${id}`, preview: `preview ${id}`,
      hasAttachment: false,
    });

    let queryChangesGateResolve;
    const queryChangesGate = new Promise((r) => { queryChangesGateResolve = r; });
    const seenSinceQueryStates = [];
    let queryChangesCallCount = 0;
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
        ids: ['e-1'], total: 1,
        queryState: 'eqs-1', canCalculateChanges: true, position: 0,
      }),
      'Email/get': (params) => ({
        list: (params.ids ?? []).map((id) => emailFixture(id)),
        state: 'es-1',
      }),
      'Email/queryChanges': async (params) => {
        queryChangesCallCount += 1;
        seenSinceQueryStates.push(params.sinceQueryState);
        if (queryChangesCallCount === 1) {
          await queryChangesGate;
        }
        return {
          oldQueryState: params.sinceQueryState,
          newQueryState: queryChangesCallCount === 1 ? 'eqs-2' : 'eqs-3',
          total: 1 + queryChangesCallCount,
          removed: [],
          added: [{ id: `e-new-${queryChangesCallCount}`, index: 0 }],
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

    // Seed an active inbox query view so _refreshActiveQueryViews
    // has something to run Email/queryChanges against.
    const folders = await handlers[DB_RPC.FOLDER_LIST]({ accountId: backend.account.id });
    const inboxRow = folders.find((f) => f.role === 'inbox');
    await backend.ensureFolderWindow(inboxRow.id, { offset: 0, limit: 50 });
    expect(queryChangesCallCount).toBe(0);

    ws._receive({
      '@type': 'StateChange',
      changed: { 'acct-1': { EmailDelivery: 'd-1' } },
      pushState: 'push-1',
    });
    await vi.waitFor(() => expect(queryChangesCallCount).toBe(1));

    // Second EmailDelivery push while the first refresh is gated.
    ws._receive({
      '@type': 'StateChange',
      changed: { 'acct-1': { EmailDelivery: 'd-2' } },
      pushState: 'push-2',
    });

    // Try-then-release pattern: under the buggy code the second
    // refresh enters Email/queryChanges concurrently with the first
    // and pins the race; under the fixed code it's queued and won't
    // enter until SC1 finishes. The .catch swallows the inevitable
    // timeout in the fixed path so the test still proceeds.
    await vi.waitFor(
      () => expect(queryChangesCallCount).toBe(2),
      { timeout: 250 },
    ).catch(() => {});

    queryChangesGateResolve();

    await vi.waitFor(() => expect(queryChangesCallCount).toBe(2), { timeout: 2_000 });
    // Let trailing writes settle.
    await new Promise((r) => setTimeout(r, 50));

    // Same bug shape: without serialization both refreshes read
    // sinceQueryState='eqs-1' before either writes a new one. The
    // fixed code either coalesces (1 call) or threads the state
    // forward (2 calls with ['eqs-1', 'eqs-2']).
    expect(seenSinceQueryStates).not.toEqual(['eqs-1', 'eqs-1']);

    await backend.stop();
  });

  it('coalesces an EmailDelivery+Email burst into one refresh pass', async () => {
    // Stalwart sends EmailDelivery and Email as separate frames
    // when new mail lands. Today each frame starts an independent
    // _onStateChange invocation, so we run two refresh passes for
    // a single arrival event. With coalescing we should see one
    // pass that handles both type-state updates.
    const emailFixture = (id) => ({
      id, blobId: `blob-${id}`, threadId: `thr-${id}`,
      mailboxIds: { 'mb-inbox': true }, keywords: {},
      size: 100,
      receivedAt: '2026-05-01T12:00:00Z',
      sentAt: '2026-05-01T11:59:00Z',
      messageId: [`<${id}@example.com>`],
      sender: [{ name: 'S', email: 's@example.com' }],
      from: [{ name: 'F', email: 'f@example.com' }],
      to: [{ name: 'T', email: 't@example.com' }],
      subject: `Subject ${id}`, preview: `preview ${id}`,
      hasAttachment: false,
    });
    let queryChangesCallCount = 0;
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
        ids: ['e-1'], total: 1,
        queryState: 'eqs-1', canCalculateChanges: true, position: 0,
      }),
      'Email/changes': (params) => ({
        accountId: params.accountId,
        oldState: params.sinceState,
        newState: 'es-2',
        hasMoreChanges: false,
        created: [], updated: [], destroyed: [],
      }),
      'Email/get': (params) => ({
        list: (params.ids ?? []).map((id) => emailFixture(id)),
        state: 'es-1',
      }),
      'Email/queryChanges': () => {
        queryChangesCallCount += 1;
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

    const folders = await handlers[DB_RPC.FOLDER_LIST]({ accountId: backend.account.id });
    const inboxRow = folders.find((f) => f.role === 'inbox');
    await backend.ensureFolderWindow(inboxRow.id, { offset: 0, limit: 50 });
    expect(queryChangesCallCount).toBe(0);

    // EmailDelivery + Email arrive in the same turn — this is the
    // exact shape Stalwart emits on new-mail delivery.
    ws._receive({
      '@type': 'StateChange',
      changed: { 'acct-1': { EmailDelivery: 'd-1' } },
      pushState: 'push-1',
    });
    ws._receive({
      '@type': 'StateChange',
      changed: { 'acct-1': { Email: 'es-2' } },
      pushState: 'push-2',
    });

    // Wait until the refresh has fired and the new id has landed.
    await vi.waitFor(async () => {
      const items = await engine.all(
        `SELECT remote_id FROM query_view_items
          WHERE view_id IN (SELECT id FROM query_views WHERE account_id = ? AND folder_id = ?)
          ORDER BY position`,
        [backend.account.id, inboxRow.id],
      );
      expect(items.map((i) => i.remote_id)).toContain('e-new');
    });
    // Give any trailing pass a chance to fire.
    await new Promise((r) => setTimeout(r, 50));

    // Bug exposure: without coalescing each frame kicks its own
    // _onStateChange, so the two close-arriving frames produce two
    // _refreshActiveQueryViews passes, each issuing its own
    // Email/queryChanges per active view.
    expect(queryChangesCallCount).toBe(1);

    await backend.stop();
  });

  it('reopens the WebSocket with the last pushState after an unexpected close', async () => {
    // Failure mode: today the transport rejects pending requests
    // on close and sets _ws = null, but nothing reopens the
    // socket. Push notifications stop until the user reloads the
    // tab — which is how we discover the bug, with a message of
    // "new mail isn't arriving".
    const scenario = {
      'Mailbox/get': () => ({ list: [], state: 'mb-1' }),
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
      options: { reconnectBaseDelayMs: 10, reconnectMaxDelayMs: 50 },
    });

    const startPromise = backend.start();
    queueMicrotask(async () => {
      const ws = await FakeWebSocket._waitForInstance();
      autoRespondWebSocket(ws, scenario);
      ws._open();
    });
    await startPromise;
    await backend.bootstrapped();
    const ws1 = await FakeWebSocket._waitForInstance();

    // Establish a pushState so the reopen handshake should resume
    // from it. The transport stores _lastPushState from incoming
    // StateChange frames; we drive one through to set it.
    ws1._receive({
      '@type': 'StateChange',
      changed: { 'acct-1': { Mailbox: 'mb-1' } },
      pushState: 'push-original',
    });
    await backend._stateChangeIdle();

    // Server hangs up unexpectedly (network drop, server restart,
    // proxy timeout, …). Anything other than the client-initiated
    // closeWebSocket() should trigger a reopen.
    ws1._close(1006, 'abnormal');

    // A second WS instance should appear after the configured
    // backoff. Use waitFor so the test isn't sensitive to the
    // exact scheduling of the backoff timer.
    await vi.waitFor(
      () => expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2),
      { timeout: 2_000 },
    );
    const ws2 = FakeWebSocket.instances[1];
    autoRespondWebSocket(ws2, scenario);
    ws2._open();
    // Wait for the WebSocketPushEnable handshake frame.
    await vi.waitFor(() => expect(ws2.sent.length).toBeGreaterThanOrEqual(1));
    const enable = JSON.parse(ws2.sent[0]);
    expect(enable['@type']).toBe('WebSocketPushEnable');
    expect(enable.pushState).toBe('push-original');

    await backend.stop();
  });

  it('does not reopen the WebSocket after an explicit stop()', async () => {
    const scenario = {
      'Mailbox/get': () => ({ list: [], state: 'mb-1' }),
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
      options: { reconnectBaseDelayMs: 10, reconnectMaxDelayMs: 50 },
    });

    const startPromise = backend.start();
    queueMicrotask(async () => {
      const ws = await FakeWebSocket._waitForInstance();
      autoRespondWebSocket(ws, scenario);
      ws._open();
    });
    await startPromise;
    await backend.bootstrapped();
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Explicit teardown. The close listener must NOT schedule a
    // reopen — otherwise sign-out and account-switch flows would
    // immediately re-establish the socket they just tore down.
    await backend.stop();
    // Wait well past the configured backoff window.
    await new Promise((r) => setTimeout(r, 150));

    expect(FakeWebSocket.instances).toHaveLength(1);
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

describe('JmapBackend startup catch-up resilience', () => {
  // These tests cover the "new inbox mail isn't loaded on initial
  // login" report. On a warm relogin the inbox list is painted from
  // the previous session's persisted query_view_items; the only thing
  // that reconciles it against the server before the user manually
  // refreshes is the startup _refreshActiveQueryViews pass
  // (Email/queryChanges per active view). Each test seeds a warm
  // inbox view whose newer item (e-2) the server has since removed and
  // asserts the catch-up reconciles it down to [e-1]. They are RED
  // today because the catch-up either never runs or skips the inbox.

  /**
   * Seed an account + inbox folder + a mailbox-window query view left
   * over from a previous session, containing two items (e-1, e-2).
   * Returns the local ids the assertions need.
   */
  async function seedWarmInbox({ accessedAt = Date.now() } = {}) {
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
        totalEmails: 1, unreadEmails: 0,
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
            ) VALUES (?, 'mailbox-window', ?, ?, ?, 0, 'eqs-inbox', 1, 2, ?, ?, ?)`,
      params: [
        account.id,
        inboxRow.id,
        JSON.stringify({ inMailbox: 'mb-inbox' }),
        JSON.stringify([{ property: 'receivedAt', isAscending: false }]),
        ts, ts, accessedAt,
      ],
    });
    const view = await engine.get(
      'SELECT id FROM query_views WHERE account_id = ? AND folder_id = ?',
      [account.id, inboxRow.id],
    );
    await handlers[DB_RPC.TRANSACTION]({
      statements: ['e-1', 'e-2'].map((id, i) => ({
        sql: `INSERT INTO query_view_items(view_id, position, message_id, remote_id)
              VALUES (?, ?, NULL, ?)`,
        params: [view.id, i, id],
      })),
    });
    return { account, inboxRow, viewId: view.id };
  }

  it('still runs the inbox queryChanges catch-up when identities sync fails on login', async () => {
    // Bug: _continueBootstrap awaits syncIdentities (and syncContacts)
    // BEFORE _refreshActiveQueryViews, with no per-step error
    // isolation. A transient failure on Identity/get (or any contacts
    // call) therefore rejects the whole bootstrap chain and the
    // startup inbox catch-up never runs — so a returning user keeps
    // looking at the previous session's stale inbox (the e-2 the
    // server already removed stays put, and symmetrically newly
    // delivered mail never lands) until they manually hit refresh.
    //
    // The fix must isolate the identities/contacts steps so a failure
    // there cannot suppress the mail-view catch-up.
    const { viewId } = await seedWarmInbox();

    let queryChangesCalls = 0;
    const scenario = {
      'Mailbox/get': () => ({
        list: [{ id: 'mb-inbox', name: 'Inbox', role: 'inbox', totalEmails: 1 }],
        state: 'mb-1',
      }),
      // Simulate a flaky submission/identity endpoint at login time.
      'Identity/get': () => { throw new Error('Identity/get 503'); },
      'AddressBook/get': () => ({ list: [], state: 'ab' }),
      'ContactCard/query': () => ({ ids: [], total: 0, state: 'cc' }),
      'ContactCard/get': () => ({ list: [], state: 'cc' }),
      'Email/queryChanges': (params) => {
        queryChangesCalls += 1;
        return {
          oldQueryState: params.sinceQueryState,
          newQueryState: 'eqs-inbox-2',
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

    // Swallow the expected bootstrap error log so the test output
    // stays clean; the contract under test is the side effect, not
    // the log line.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const startPromise = backend.start();
    // After the fix the bootstrap reaches openWebSocket; feed it an
    // open socket so the catch-up can run over WS. In the buggy path
    // the chain rejects before any socket is created, so this waiter
    // simply stays pending and is harmless.
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
      [viewId],
    );
    expect(items.map((i) => i.remote_id)).toEqual(['e-1']);

    warnSpy.mockRestore();
    errorSpy.mockRestore();
    await backend.stop();
  });

  it('catches up the inbox on login even when five other folders were viewed more recently', async () => {
    // Bug: _refreshActiveQueryViews only refreshes the 5 query_views
    // with the most recent last_accessed_at (ORDER BY ... DESC LIMIT
    // 5). A user who, in their previous session, last browsed five
    // non-inbox folders pushes the inbox out of that window — so on
    // next login the inbox is the one folder that does NOT get a
    // queryChanges catch-up, even though it's the folder that opens by
    // default. New inbox mail therefore doesn't appear until a push
    // frame or a manual refresh.
    //
    // The fix must guarantee the inbox (and/or the folder that will be
    // auto-opened) is always part of the startup catch-up.
    const account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'Tester',
      primaryEmail: 'tester@example.com',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'acct-1',
      isPrimary: true,
    })).row;

    const folderDefs = [
      { remoteId: 'mb-inbox', name: 'Inbox', role: 'inbox' },
      ...Array.from({ length: 5 }, (_, i) => ({
        remoteId: `mb-f${i + 1}`, name: `Folder ${i + 1}`, role: null,
      })),
    ];
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: folderDefs.map((f) => ({ ...f, totalEmails: 1, unreadEmails: 0 })),
    });
    const folderRows = await handlers[DB_RPC.FOLDER_LIST]({ accountId: account.id });
    const byRemote = new Map<string, any>(
      folderRows.map((f: any) => [f.remote_id, f]),
    );

    const baseTs = Date.now();
    // Inbox is the OLDEST-accessed view; the five others are all newer,
    // so a naive "5 most recently accessed" window excludes the inbox.
    const seeds: Array<[string, number, string]> = [
      ['mb-inbox', baseTs - 10_000, 'eqs-inbox'],
      ['mb-f1', baseTs - 5, 'eqs-f1'],
      ['mb-f2', baseTs - 4, 'eqs-f2'],
      ['mb-f3', baseTs - 3, 'eqs-f3'],
      ['mb-f4', baseTs - 2, 'eqs-f4'],
      ['mb-f5', baseTs - 1, 'eqs-f5'],
    ];
    for (const [remote, accessedAt, queryState] of seeds) {
      await handlers[DB_RPC.QUERY]({
        sql: `INSERT INTO query_views(
                account_id, view_type, folder_id, filter_json, sort_json,
                collapse_threads, query_state, can_calculate_changes, total,
                created_at, updated_at, last_accessed_at
              ) VALUES (?, 'mailbox-window', ?, ?, ?, 0, ?, 1, 2, ?, ?, ?)`,
        params: [
          account.id,
          byRemote.get(remote).id,
          JSON.stringify({ inMailbox: remote }),
          JSON.stringify([{ property: 'receivedAt', isAscending: false }]),
          queryState, baseTs, baseTs, accessedAt,
        ],
      });
    }
    const inboxView = await engine.get(
      'SELECT id FROM query_views WHERE account_id = ? AND folder_id = ?',
      [account.id, byRemote.get('mb-inbox').id],
    );
    await handlers[DB_RPC.TRANSACTION]({
      statements: ['e-1', 'e-2'].map((id, i) => ({
        sql: `INSERT INTO query_view_items(view_id, position, message_id, remote_id)
              VALUES (?, ?, NULL, ?)`,
        params: [inboxView.id, i, id],
      })),
    });

    const seenInMailboxes: Array<string | undefined> = [];
    const scenario = {
      'Mailbox/get': () => ({
        // JMAP Mailbox/get returns mailbox `id`s; syncMailboxes maps
        // them to folders.remote_id.
        list: folderDefs.map((f) => ({
          id: f.remoteId, name: f.name, role: f.role, totalEmails: 1,
        })),
        state: 'mb-1',
      }),
      'Identity/get': () => ({ list: [], state: 'id' }),
      'AddressBook/get': () => ({ list: [], state: 'ab' }),
      'ContactCard/query': () => ({ ids: [], total: 0, state: 'cc' }),
      'ContactCard/get': () => ({ list: [], state: 'cc' }),
      'Email/queryChanges': (params) => {
        const inMailbox = params.filter?.inMailbox;
        seenInMailboxes.push(inMailbox);
        if (inMailbox === 'mb-inbox') {
          return {
            oldQueryState: params.sinceQueryState,
            newQueryState: 'eqs-inbox-2',
            total: 1,
            removed: ['e-2'],
            added: [],
          };
        }
        return {
          oldQueryState: params.sinceQueryState,
          newQueryState: `${params.sinceQueryState}-2`,
          total: 0,
          removed: [],
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

    // The inbox view must have been part of the startup catch-up.
    expect(seenInMailboxes).toContain('mb-inbox');
    const items = await engine.all(
      'SELECT remote_id FROM query_view_items WHERE view_id = ? ORDER BY position',
      [inboxView.id],
    );
    expect(items.map((i) => i.remote_id)).toEqual(['e-1']);

    await backend.stop();
  });
});

describe('JmapBackend shared-account reconciliation', () => {
  it('acknowledges push state only after all account work succeeds', async () => {
    const primary = { id: 1, remote_account_id: 'acct-1' };
    const shared = { id: 2, remote_account_id: 'acct-shared' };
    const backend = new JmapBackend({
      transport: new MockTransport(),
      serverOrigin: 'https://mail.example.com',
      handlers,
      options: { useWebSocket: false },
    });
    backend.account = primary;
    backend.sharedAccounts = [shared];
    backend._persistPushState = vi.fn(async () => {});
    backend._scheduleStateChangeRetry = vi.fn();
    backend._syncAccountStateChange = vi.fn()
      .mockRejectedValueOnce(new Error('primary failed'))
      .mockResolvedValueOnce({});

    await backend._doStateChange({
      changed: {
        'acct-1': { Mailbox: 'mb-primary-2' },
        'acct-shared': { EmailDelivery: 'delivery-shared-2' },
      },
      pushState: 'push-next',
    });

    expect(backend._syncAccountStateChange).toHaveBeenCalledTimes(2);
    expect(backend._persistPushState).not.toHaveBeenCalled();
    expect(backend._scheduleStateChangeRetry).toHaveBeenCalledWith({
      changed: {
        'acct-1': { Mailbox: 'mb-primary-2' },
      },
      pushState: 'push-next',
    });
  });

  it('continues with later Session accounts after one account sync fails', async () => {
    const primary = { id: 1, remote_account_id: 'acct-1' };
    const shared = { id: 2, remote_account_id: 'acct-shared' };
    const transport = new MockTransport();
    transport.handle('Mailbox/changes', () => {
      throw new Error('primary mailbox sync failed');
    });
    const backend = new JmapBackend({
      transport,
      serverOrigin: 'https://mail.example.com',
      handlers,
      options: { useWebSocket: false },
    });
    backend.account = primary;
    backend.sharedAccounts = [shared];
    backend._loadSyncStateFor = vi.fn(async () => ({ state: 'mb-primary-1' }));
    backend._refreshActiveQueryViews = vi.fn(async () => {});

    await backend._doStateChange({
      changed: {
        'acct-1': { Mailbox: 'mb-primary-2' },
        'acct-shared': { EmailDelivery: 'delivery-shared-2' },
      },
      pushState: null,
    });

    expect(transport.requests[0].methodCalls[0][0]).toBe('Mailbox/changes');
    expect(backend._refreshActiveQueryViews).toHaveBeenCalledWith(shared);
  });

  it('refreshes primary and shared active views after reconnect', async () => {
    const primary = { id: 1, remote_account_id: 'acct-1' };
    const shared = { id: 2, remote_account_id: 'acct-shared' };
    const transport = new MockTransport() as any;
    transport.lastPushState = 'push-latest';
    transport.openWebSocket = vi.fn(async () => {});
    const backend = new JmapBackend({
      transport,
      serverOrigin: 'https://mail.example.com',
      handlers,
      options: { useWebSocket: true },
    });
    backend.account = primary;
    backend.sharedAccounts = [shared];
    backend._started = true;
    backend._refreshActiveQueryViews = vi.fn(async () => {});

    await backend._reconnect();

    expect(transport.openWebSocket).toHaveBeenCalledWith(
      expect.arrayContaining(['Email', 'EmailDelivery']),
      'push-latest',
    );
    expect(backend._refreshActiveQueryViews).toHaveBeenNthCalledWith(1, primary);
    expect(backend._refreshActiveQueryViews).toHaveBeenNthCalledWith(2, shared);
  });

  it('rejects folders whose shared account is no longer in the Session', async () => {
    const primary = { id: 1, remote_account_id: 'acct-1' };
    const backend = new JmapBackend({
      transport: new MockTransport(),
      serverOrigin: 'https://mail.example.com',
      handlers,
      options: { useWebSocket: false },
    });
    backend.account = primary;
    backend._accountsByLocalId = new Map([[primary.id, primary]]);

    expect(() => backend._accountForFolder({ id: 30, account_id: 2 }))
      .toThrow('belongs to an unavailable account');
  });

  it('handles shared EmailDelivery push with scoped query refresh and body prefetch', async () => {
    const primary = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'Primary',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'acct-1',
      isPrimary: true,
    })).row;
    const shared = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'Shared',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'acct-shared',
      isPrimary: false,
      isPersonal: false,
    })).row;
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: shared.id,
      folders: [{ remoteId: 'shared-inbox', name: 'Shared Inbox', role: 'inbox' }],
    });
    const folder = await engine.get(
      `SELECT * FROM folders WHERE account_id = ? AND remote_id = 'shared-inbox'`,
      [shared.id],
    );
    const metadata = (id) => ({
      id,
      blobId: `blob-${id}`,
      threadId: `thread-${id}`,
      mailboxIds: { 'shared-inbox': true },
      keywords: {},
      size: 10,
      receivedAt: '2026-07-01T12:00:00Z',
      sentAt: '2026-07-01T12:00:00Z',
      messageId: [`<${id}@example.com>`],
      from: [{ email: 'sender@example.com' }],
      to: [{ email: 'recipient@example.com' }],
      subject: id,
      preview: id,
      hasAttachment: false,
    });
    const transport = new MockTransport();
    transport.handle('Email/query', () => ({
      ids: ['shared-old'],
      total: 1,
      queryState: 'shared-q1',
      canCalculateChanges: true,
      position: 0,
    }));
    transport.handle('Email/get', (params) => ({
      list: (params.ids ?? []).map(metadata),
      state: 'shared-es1',
    }));
    await syncFolderWindow({ transport, account: shared, folder, handlers });

    let queryAccountId;
    let bodyAccountId;
    transport.handle('Email/queryChanges', (params) => {
      queryAccountId = params.accountId;
      return {
        oldQueryState: 'shared-q1',
        newQueryState: 'shared-q2',
        total: 2,
        removed: [],
        added: [{ id: 'shared-new', index: 0 }],
      };
    });
    transport.handle('Email/get', (params) => {
      if (params.fetchTextBodyValues === true) bodyAccountId = params.accountId;
      return {
        list: (params.ids ?? []).map((id) => ({
          ...metadata(id),
          ...(params.fetchTextBodyValues === true
            ? {
              bodyStructure: { partId: 'p1', type: 'text/plain', size: 4 },
              textBody: [{ partId: 'p1' }],
              htmlBody: [],
              attachments: [],
              bodyValues: { p1: { value: 'body', isTruncated: false } },
            }
            : {}),
        })),
        state: 'shared-es2',
      };
    });
    const backend = new JmapBackend({
      transport,
      serverOrigin: 'https://mail.example.com',
      handlers,
      options: { useWebSocket: false },
    });
    backend.account = primary;
    backend.sharedAccounts = [shared];
    backend._accountsByLocalId = new Map([
      [primary.id, primary],
      [shared.id, shared],
    ]);
    backend._accountsByRemoteId = new Map([
      [primary.remote_account_id, primary],
      [shared.remote_account_id, shared],
    ]);

    await backend._doStateChange({
      changed: { 'acct-shared': { EmailDelivery: 'delivery-2' } },
      pushState: null,
    });

    expect(queryAccountId).toBe('acct-shared');
    expect(bodyAccountId).toBe('acct-shared');
    const copied = await engine.get(
      `SELECT id, body_fetched_at FROM messages
        WHERE account_id = ? AND remote_id = 'shared-new'`,
      [shared.id],
    );
    expect(copied?.body_fetched_at).not.toBeNull();
    expect(await handlers[DB_RPC.SYNC_STATE_GET]({
      accountId: shared.id,
      objectType: 'Email',
      scope: '',
    })).toBeNull();
  });
});
