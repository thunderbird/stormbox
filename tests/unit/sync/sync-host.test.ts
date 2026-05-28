import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { makeSyncRpcHandlers } from '../../../src/sync/sync-host';
import { JMAP_CAPS } from '../../../src/sync/backends/jmap/transport';
import { FakeWebSocket } from './_fake-ws';
import { resolveResultRefs } from './_mock-transport';

const SESSION = {
  apiUrl: 'https://mail.example.com/jmap',
  downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}',
  uploadUrl: 'https://mail.example.com/jmap/upload/{accountId}/',
  username: 'tester@example.com',
  state: 'session-state',
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
    [JMAP_CAPS.CORE]: {},
    [JMAP_CAPS.MAIL]: {},
    [JMAP_CAPS.WEBSOCKET]: {
      url: 'wss://mail.example.com/jmap/ws/',
      supportsPush: true,
    },
  },
};

const SCENARIO = {
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
  'AddressBook/get': () => ({ list: [{ id: 'ab-default', name: 'Default', isDefault: true }], state: 'ab-1' }),
  'ContactCard/query': () => ({ ids: ['c-1'], total: 1, state: 'cc-1' }),
  'ContactCard/get': () => ({
    list: [{ id: 'c-1', addressBookId: 'ab-default', uid: 'u-1', fullName: 'Jane', emails: [{ email: 'jane@example.com' }] }],
    state: 'cc-1',
  }),
  'Email/query': () => ({
    ids: ['e-1'], total: 1, queryState: 'qs', canCalculateChanges: true, position: 0,
  }),
  'Email/get': (params) => {
    if (params.fetchTextBodyValues || params.fetchHTMLBodyValues) {
      return {
        list: params.ids.map((id) => ({
          id,
          blobId: `blob-${id}`,
          threadId: 'thr-1',
          mailboxIds: { 'mb-inbox': true },
          keywords: {},
          bodyStructure: { partId: `body-${id}`, type: 'text/plain', size: 5 },
          textBody: [{ partId: `body-${id}` }],
          htmlBody: [],
          attachments: [],
          bodyValues: { [`body-${id}`]: { value: `body for ${id}`, isTruncated: false } },
        })),
        state: 'es',
      };
    }
    return {
      list: params.ids.map((id) => ({
        id,
        blobId: `blob-${id}`,
        threadId: 'thr-1',
        mailboxIds: { 'mb-inbox': true },
        keywords: {},
        size: 1,
        receivedAt: '2026-05-01T12:00:00Z',
        sentAt: '2026-05-01T12:00:00Z',
        messageId: [`<${id}@example.com>`],
        from: [{ email: 'from@example.com' }],
        to: [{ email: 'to@example.com' }],
        sender: [{ email: 'sender@example.com' }],
        subject: 's',
        preview: 'p',
        hasAttachment: false,
      })),
      state: 'es',
    };
  },
};

function makeFetch(trackBodyGets = null) {
  return vi.fn(async (url, init) => {
    if (!init || init.method !== 'POST') {
      return jsonResponse(SESSION);
    }
    const body = JSON.parse(init.body);
    const responses = [];
    const byCallId = new Map();
    for (const [methodName, rawParams, callId] of body.methodCalls) {
      const handler = SCENARIO[methodName];
      if (!handler) {
        throw new Error(`No handler for ${methodName}`);
      }
      const params = resolveResultRefs(rawParams, byCallId);
      if (trackBodyGets && methodName === 'Email/get' && params.fetchTextBodyValues) {
        trackBodyGets.push([...params.ids]);
      }
      const payload = await handler(params, callId);
      const tuple = [methodName, payload, callId];
      responses.push(tuple);
      byCallId.set(callId, tuple);
    }
    return jsonResponse({ methodResponses: responses });
  });
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
let allHandlers;

beforeEach(async () => {
  FakeWebSocket._reset();
  engine = await bootTestEngine();
  handlers = makeHandlers(engine);
  const syncHandlers = makeSyncRpcHandlers({
    handlers,
    fetch: makeFetch() as any,
    WebSocketImpl: FakeWebSocket as any,
  });
  allHandlers = { ...handlers, ...syncHandlers };
});

afterEach(async () => {
  await engine.close();
});

describe('SYNC_START_ACCOUNT', () => {
  it('boots a JmapBackend and returns the local account id', async () => {
    const startPromise = allHandlers[DB_RPC.SYNC_START_ACCOUNT]({
      sessionUrl: 'https://mail.example.com/.well-known/jmap',
      serverOrigin: 'https://mail.example.com',
      auth: { kind: 'bearer', token: 'tok' },
      useWebSocket: true,
    });
    queueMicrotask(async () => {
      const ws = await FakeWebSocket._waitForInstance();
      ws._open();
    });
    const result = await startPromise;
    expect(typeof result.accountId).toBe('number');

    const accounts = await handlers[DB_RPC.ACCOUNT_LIST]();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe(result.accountId);

    const folders = await handlers[DB_RPC.FOLDER_LIST]({ accountId: result.accountId });
    expect(folders).toHaveLength(2);

    await allHandlers[DB_RPC.SYNC_STOP_ACCOUNT]({ accountId: result.accountId });
  });

  it('routes ensure* calls through the SyncClient to the registered backend', async () => {
    const start = allHandlers[DB_RPC.SYNC_START_ACCOUNT]({
      sessionUrl: 'https://mail.example.com/.well-known/jmap',
      serverOrigin: 'https://mail.example.com',
      auth: { kind: 'basic', username: 'u', password: 'p' },
      useWebSocket: false,
    });
    const { accountId } = await start;

    const inbox = await handlers[DB_RPC.FOLDER_BY_ROLE]({ accountId, role: 'inbox' });
    expect(inbox).not.toBeNull();

    await allHandlers[DB_RPC.SYNC_ENSURE_FOLDER_WINDOW]({
      accountId,
      folderId: inbox.id,
      range: { offset: 0, limit: 50 },
    });

    const messages = await handlers[DB_RPC.MESSAGE_LIST_FOR_FOLDER]({ folderId: inbox.id });
    expect(messages.map((m) => m.remote_id)).toEqual(['e-1']);
  });
});

describe('SYNC_MESSAGE_BODY_FOR_DISPLAY', () => {
  it('returns a cached body without a body Email/get', async () => {
    const bodyGets = [];
    handlers = makeHandlers(engine);
    const syncHandlers = makeSyncRpcHandlers({
      handlers,
      fetch: makeFetch(bodyGets) as any,
      WebSocketImpl: FakeWebSocket as any,
    });
    allHandlers = { ...handlers, ...syncHandlers };

    const { accountId } = await allHandlers[DB_RPC.SYNC_START_ACCOUNT]({
      sessionUrl: 'https://mail.example.com/.well-known/jmap',
      serverOrigin: 'https://mail.example.com',
      auth: { kind: 'basic', username: 'u', password: 'p' },
      useWebSocket: false,
    });
    const inbox = await handlers[DB_RPC.FOLDER_BY_ROLE]({ accountId, role: 'inbox' });
    await allHandlers[DB_RPC.SYNC_ENSURE_FOLDER_WINDOW]({
      accountId,
      folderId: inbox.id,
      range: { offset: 0, limit: 10 },
    });
    const [message] = await handlers[DB_RPC.MESSAGE_LIST_FOR_FOLDER]({ folderId: inbox.id });
    const ts = Date.now();
    await handlers[DB_RPC.TRANSACTION]({
      statements: [
        {
          sql: `UPDATE messages SET body_fetched_at = ? WHERE id = ?`,
          params: [ts, message.id],
        },
        {
          sql: `INSERT INTO body_values(message_id, part_id, kind, value, is_truncated, fetched_at, last_accessed_at)
                VALUES (?, 'text', 'text', ?, 0, ?, ?)`,
          params: [message.id, 'cached plain', ts, ts],
        },
      ],
    });

    const body = await allHandlers[DB_RPC.SYNC_MESSAGE_BODY_FOR_DISPLAY]({
      accountId,
      messageId: message.id,
    });

    expect(body).toEqual({ text: 'cached plain', html: '', attachments: [] });
    expect(bodyGets).toHaveLength(0);

    await allHandlers[DB_RPC.SYNC_STOP_ACCOUNT]({ accountId });
  });

  it('issues one body Email/get on cache miss, then serves SQLite on repeat', async () => {
    const bodyGets = [];
    handlers = makeHandlers(engine);
    const syncHandlers = makeSyncRpcHandlers({
      handlers,
      fetch: makeFetch(bodyGets) as any,
      WebSocketImpl: FakeWebSocket as any,
    });
    allHandlers = { ...handlers, ...syncHandlers };

    const { accountId } = await allHandlers[DB_RPC.SYNC_START_ACCOUNT]({
      sessionUrl: 'https://mail.example.com/.well-known/jmap',
      serverOrigin: 'https://mail.example.com',
      auth: { kind: 'basic', username: 'u', password: 'p' },
      useWebSocket: false,
    });
    const inbox = await handlers[DB_RPC.FOLDER_BY_ROLE]({ accountId, role: 'inbox' });
    await allHandlers[DB_RPC.SYNC_ENSURE_FOLDER_WINDOW]({
      accountId,
      folderId: inbox.id,
      range: { offset: 0, limit: 10 },
    });
    const [message] = await handlers[DB_RPC.MESSAGE_LIST_FOR_FOLDER]({ folderId: inbox.id });

    const first = await allHandlers[DB_RPC.SYNC_MESSAGE_BODY_FOR_DISPLAY]({
      accountId,
      messageId: message.id,
    });
    expect(first).toEqual({ text: 'body for e-1', html: '', attachments: [] });
    expect(bodyGets).toEqual([['e-1']]);

    const second = await allHandlers[DB_RPC.SYNC_MESSAGE_BODY_FOR_DISPLAY]({
      accountId,
      messageId: message.id,
    });
    expect(second).toEqual({ text: 'body for e-1', html: '', attachments: [] });
    expect(bodyGets).toEqual([['e-1']]);

    await allHandlers[DB_RPC.SYNC_STOP_ACCOUNT]({ accountId });
  });
});
