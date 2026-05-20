import { describe, it, expect, beforeEach, vi } from 'vitest';

import { JmapTransport, JMAP_CAPS } from '../../../src/sync/backends/jmap/transport.js';
import { FakeWebSocket } from './_fake-ws.js';

const SESSION = {
  apiUrl: 'https://mail.example.com/jmap',
  downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}',
  uploadUrl: 'https://mail.example.com/jmap/upload/{accountId}/',
  eventSourceUrl: 'https://mail.example.com/jmap/event/',
  primaryAccounts: { [JMAP_CAPS.MAIL]: 'acct-1' },
  capabilities: {
    [JMAP_CAPS.CORE]: {
      maxConcurrentRequests: 4,
      maxObjectsInGet: 500,
      maxCallsInRequest: 16,
    },
    [JMAP_CAPS.MAIL]: { maxMailboxesPerEmail: null },
    [JMAP_CAPS.WEBSOCKET]: {
      url: 'wss://mail.example.com/jmap/ws/',
      supportsPush: true,
    },
  },
  state: 'session-state-aaa',
};

function makeFetch(handlers) {
  return vi.fn(async (url, init) => {
    const handler = handlers[url];
    if (!handler) {
      throw new Error(`Unexpected fetch to ${url}`);
    }
    return handler(init);
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

describe('JmapTransport HTTP', () => {
  let auth;

  beforeEach(() => {
    auth = vi.fn(async () => 'Basic dXNlcjpwYXNz');
  });

  it('fetches and caches the session document', async () => {
    const fetchMock = makeFetch({
      'https://mail.example.com/.well-known/jmap': () => jsonResponse(SESSION),
    });
    const t = new JmapTransport({
      sessionUrl: 'https://mail.example.com/.well-known/jmap',
      getAuthHeader: auth,
      fetch: fetchMock,
    });
    const first = await t.fetchSession();
    const second = await t.fetchSession();
    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('forces a refetch when force=true', async () => {
    const fetchMock = makeFetch({
      'https://mail.example.com/.well-known/jmap': () => jsonResponse(SESSION),
    });
    const t = new JmapTransport({
      sessionUrl: 'https://mail.example.com/.well-known/jmap',
      getAuthHeader: auth,
      fetch: fetchMock,
    });
    await t.fetchSession();
    await t.fetchSession({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws a descriptive error on session fetch failure', async () => {
    const fetchMock = makeFetch({
      'https://mail.example.com/.well-known/jmap': () =>
        jsonResponse({}, { status: 401, statusText: 'Unauthorized' }),
    });
    const t = new JmapTransport({
      sessionUrl: 'https://mail.example.com/.well-known/jmap',
      getAuthHeader: auth,
      fetch: fetchMock,
    });
    await expect(t.fetchSession()).rejects.toThrow(/401/);
  });

  it('issues a method-call request with the provided using/methodCalls', async () => {
    const fetchMock = makeFetch({
      'https://mail.example.com/.well-known/jmap': () => jsonResponse(SESSION),
      'https://mail.example.com/jmap': async (init) => {
        const body = JSON.parse(init.body);
        expect(body.using).toEqual([JMAP_CAPS.CORE, JMAP_CAPS.MAIL]);
        expect(body.methodCalls[0][0]).toBe('Mailbox/get');
        return jsonResponse({
          methodResponses: [['Mailbox/get', { list: [] }, 'm1']],
          sessionState: 'sx',
        });
      },
    });
    const t = new JmapTransport({
      sessionUrl: 'https://mail.example.com/.well-known/jmap',
      getAuthHeader: auth,
      fetch: fetchMock,
    });
    const result = await t.request(
      [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
      [['Mailbox/get', { accountId: 'acct-1' }, 'm1']],
    );
    expect(result.methodResponses[0][0]).toBe('Mailbox/get');
  });

  it('attaches the auth header on every request', async () => {
    const fetchMock = makeFetch({
      'https://mail.example.com/.well-known/jmap': () => jsonResponse(SESSION),
      'https://mail.example.com/jmap': () =>
        jsonResponse({ methodResponses: [], sessionState: 'sx' }),
    });
    const t = new JmapTransport({
      sessionUrl: 'https://mail.example.com/.well-known/jmap',
      getAuthHeader: auth,
      fetch: fetchMock,
    });
    await t.request([JMAP_CAPS.CORE], []);
    const calls = fetchMock.mock.calls;
    for (const [, init] of calls) {
      expect(init.headers.Authorization).toBe('Basic dXNlcjpwYXNz');
    }
  });
});

describe('JmapTransport WebSocket (RFC 8887)', () => {
  let auth;

  beforeEach(() => {
    FakeWebSocket._reset();
    auth = vi.fn(async () => 'Bearer test-token');
  });

  function makeTransport() {
    const fetchMock = makeFetch({
      'https://mail.example.com/.well-known/jmap': () => jsonResponse(SESSION),
    });
    return new JmapTransport({
      sessionUrl: 'https://mail.example.com/.well-known/jmap',
      getAuthHeader: auth,
      fetch: fetchMock,
      WebSocketImpl: FakeWebSocket,
    });
  }

  it('opens a WS connection and sends WebSocketPushEnable with pushState', async () => {
    const t = makeTransport();
    const open = t.openWebSocket(['Mailbox', 'Email'], 'aaa');
    const ws = await FakeWebSocket._waitForInstance();
    ws._open();
    await open;

    expect(ws.url).toBe('wss://mail.example.com/jmap/ws/');
    expect(ws.protocols).toEqual(['jmap']);
    expect(ws.sent).toHaveLength(1);
    const enable = JSON.parse(ws.sent[0]);
    expect(enable['@type']).toBe('WebSocketPushEnable');
    expect(enable.dataTypes).toEqual(['Mailbox', 'Email']);
    expect(enable.pushState).toBe('aaa');
  });

  it('correlates Request/Response by requestId', async () => {
    const t = makeTransport();
    const open = t.openWebSocket(['Email'], null);
    const ws = await FakeWebSocket._waitForInstance();
    ws._open();
    await open;

    const pending = t.wsRequest(['urn:ietf:params:jmap:core'], [['Core/echo', { hi: true }, 'c1']]);
    // The WebSocketPushEnable is at index 0; the JMAP Request is at index 1.
    const request = JSON.parse(ws.sent[1]);
    expect(request['@type']).toBe('Request');
    expect(typeof request.id).toBe('string');

    ws._receive({
      '@type': 'Response',
      requestId: request.id,
      methodResponses: [['Core/echo', { hi: true }, 'c1']],
    });
    const result = await pending as any;
    expect(result.methodResponses[0][0]).toBe('Core/echo');
  });

  it('rejects pending requests with RequestError frames', async () => {
    const t = makeTransport();
    const open = t.openWebSocket(['Email'], null);
    const ws = await FakeWebSocket._waitForInstance();
    ws._open();
    await open;

    const pending = t.wsRequest(['x'], [['Foo/bar', {}, 'a']]);
    const request = JSON.parse(ws.sent[1]);
    ws._receive({
      '@type': 'RequestError',
      requestId: request.id,
      type: 'urn:ietf:params:jmap:error:notRequest',
      status: 400,
      detail: 'something is wrong',
    });
    await expect(pending).rejects.toThrow(/something is wrong/);
  });

  it('delivers StateChange to subscribers and updates lastPushState', async () => {
    const t = makeTransport();
    const open = t.openWebSocket(['Mailbox', 'Email'], null);
    const ws = await FakeWebSocket._waitForInstance();
    ws._open();
    await open;

    const seen = [];
    t.onStateChange((change) => seen.push(change));

    ws._receive({
      '@type': 'StateChange',
      changed: { 'acct-1': { Email: 'state-1' } },
      pushState: 'bbb',
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].changed['acct-1'].Email).toBe('state-1');
    expect(seen[0].pushState).toBe('bbb');
    expect(t.lastPushState).toBe('bbb');
  });

  it('rejects pending requests when the WebSocket closes', async () => {
    const t = makeTransport();
    const open = t.openWebSocket(['Email'], null);
    const ws = await FakeWebSocket._waitForInstance();
    ws._open();
    await open;

    const pending = t.wsRequest(['x'], []);
    ws._close();
    await expect(pending).rejects.toThrow(/closed/);
  });

  it('throws if the server does not advertise the websocket capability', async () => {
    const fetchMock = makeFetch({
      'https://mail.example.com/.well-known/jmap': () =>
        jsonResponse({ ...SESSION, capabilities: {} }),
    });
    const t = new JmapTransport({
      sessionUrl: 'https://mail.example.com/.well-known/jmap',
      getAuthHeader: auth,
      fetch: fetchMock,
      WebSocketImpl: FakeWebSocket,
    });
    await expect(t.openWebSocket(['Email'], null)).rejects.toThrow(/websocket/i);
  });
});
