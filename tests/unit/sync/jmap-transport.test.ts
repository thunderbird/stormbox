import { describe, it, expect, beforeEach, vi } from 'vitest';

import { JmapTransport, JMAP_CAPS } from '../../../src/sync/backends/jmap/transport';
import { FakeWebSocket } from './_fake-ws';

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

const FAKE_BASIC_AUTH = 'Basic fake-test-auth-not-a-real-secret';

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
    auth = vi.fn(async () => FAKE_BASIC_AUTH);
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

  it('rejects a request with a typed timeout error when the server never responds', async () => {
    // Failure mode: fetch() has no timeout. A server that accepts the
    // POST and then stalls leaves the awaiting caller hung until the OS
    // gives up on the socket. For a send that means compose-store never
    // leaves status SENDING, and Close and Discard — which are gated on
    // exactly that — stay disabled with no way out but a reload.
    const fetchMock = makeFetch({
      'https://mail.example.com/.well-known/jmap': () => jsonResponse(SESSION),
      'https://mail.example.com/jmap': (init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err: any = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      }),
    });
    const t = new JmapTransport({
      sessionUrl: 'https://mail.example.com/.well-known/jmap',
      getAuthHeader: auth,
      fetch: fetchMock,
      httpRequestTimeoutMs: 80,
    });

    const started = Date.now();
    await expect(t.request([JMAP_CAPS.CORE], [['Mailbox/get', {}, 'm1']]))
      .rejects.toMatchObject({
        type: 'httpRequestTimeout',
        message: expect.stringMatching(/timed out/i),
      });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(2_000);
    expect((t as any)._inFlightHttp.size).toBe(0);
  });

  it('applies the deadline to the response body, not just the headers', async () => {
    // fetch() resolves as soon as the headers arrive, so a deadline
    // that stops there leaves a server which sends 200 and then stalls
    // the body hanging in response.json() with the timer cleared.
    const fetchMock = makeFetch({
      'https://mail.example.com/.well-known/jmap': () => jsonResponse(SESSION),
      'https://mail.example.com/jmap': (init) => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err: any = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          });
        }),
      }),
    });
    const t = new JmapTransport({
      sessionUrl: 'https://mail.example.com/.well-known/jmap',
      getAuthHeader: auth,
      fetch: fetchMock,
      httpRequestTimeoutMs: 80,
    });

    await expect(t.request([JMAP_CAPS.CORE], [['Mailbox/get', {}, 'm1']]))
      .rejects.toMatchObject({ type: 'httpRequestTimeout' });
    expect((t as any)._inFlightHttp.size).toBe(0);
  });

  it('abort() cancels an in-flight request with a distinguishable error', async () => {
    // Teardown needs the pending call to settle now, not at the
    // deadline, and the resulting error must not read as a stalled
    // server: recovery treats the two differently.
    const fetchMock = makeFetch({
      'https://mail.example.com/.well-known/jmap': () => jsonResponse(SESSION),
      'https://mail.example.com/jmap': (init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err: any = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      }),
    });
    const t = new JmapTransport({
      sessionUrl: 'https://mail.example.com/.well-known/jmap',
      getAuthHeader: auth,
      fetch: fetchMock,
      httpRequestTimeoutMs: 60_000,
    });

    // Warm the session first. Otherwise request() issues the session
    // fetch as well, and waiting on a size of 1 could be satisfied by
    // that fetch's controller rather than by the parked POST this test
    // means to abort.
    await t.fetchSession();
    const pending = t.request([JMAP_CAPS.CORE], [['Mailbox/get', {}, 'm1']]);
    await vi.waitFor(() => expect((t as any)._inFlightHttp.size).toBe(1));
    t.abort();
    await expect(pending).rejects.toMatchObject({ type: 'transportAborted' });
    expect((t as any)._inFlightHttp.size).toBe(0);
  });

  it('refuses a request issued after abort() instead of sending it', async () => {
    // The abort has to latch, not just cancel what is in flight. A
    // mutation part-way through a multi-call operation reacts to its
    // cancelled call by moving on, and the next call would otherwise be
    // sent after teardown began and hold stop() open for its own
    // deadline.
    let posts = 0;
    const fetchMock = makeFetch({
      'https://mail.example.com/.well-known/jmap': () => jsonResponse(SESSION),
      'https://mail.example.com/jmap': () => {
        posts += 1;
        return jsonResponse({ methodResponses: [['Mailbox/get', { list: [] }, 'm1']] });
      },
    });
    const t = new JmapTransport({
      sessionUrl: 'https://mail.example.com/.well-known/jmap',
      getAuthHeader: auth,
      fetch: fetchMock,
    });

    t.abort();

    await expect(t.request([JMAP_CAPS.CORE], [['Mailbox/get', {}, 'm1']]))
      .rejects.toMatchObject({ type: 'transportAborted' });
    expect(posts, 'no request should reach the server after abort()').toBe(0);
    expect((t as any)._inFlightHttp.size).toBe(0);
  });

  it('refuses a WebSocket request issued after abort() too', async () => {
    // The WebSocket leg has the same exposure: abort() rejects what is
    // pending, and a frame sent afterwards would sit until the 30s
    // WebSocket deadline because stop() closes the socket only after
    // the runner has quiesced.
    const t = new JmapTransport({
      sessionUrl: 'https://mail.example.com/.well-known/jmap',
      getAuthHeader: auth,
      fetch: makeFetch({}),
    });
    const sent: string[] = [];
    (t as any)._ws = {
      OPEN: 1,
      readyState: 1,
      send: (frame: string) => sent.push(frame),
    };

    t.abort();

    await expect(t.wsRequest([JMAP_CAPS.CORE], [['Mailbox/get', {}, 'm1']]))
      .rejects.toMatchObject({ type: 'transportAborted' });
    expect(sent, 'no frame should be sent after abort()').toEqual([]);
  });

  it('leaves a request that completes in time untouched and unregisters it', async () => {
    const fetchMock = makeFetch({
      'https://mail.example.com/.well-known/jmap': () => jsonResponse(SESSION),
      'https://mail.example.com/jmap': () =>
        jsonResponse({ methodResponses: [['Mailbox/get', { list: [] }, 'm1']] }),
    });
    const t = new JmapTransport({
      sessionUrl: 'https://mail.example.com/.well-known/jmap',
      getAuthHeader: auth,
      fetch: fetchMock,
      httpRequestTimeoutMs: 60,
    });
    // Fake timers so the deadline timer's disposal can be observed
    // directly. Waiting past the deadline instead would prove nothing:
    // an armed timer would fire abort() on a controller already removed
    // from _inFlightHttp, leaving every assertion here unchanged.
    vi.useFakeTimers();
    try {
      const result = await t.request([JMAP_CAPS.CORE], [['Mailbox/get', {}, 'm1']]);
      expect(result.methodResponses[0][0]).toBe('Mailbox/get');
      expect((t as any)._inFlightHttp.size).toBe(0);
      expect(
        vi.getTimerCount(),
        'the deadline timer must be cleared once the request settles',
      ).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still honours a caller-supplied AbortSignal', async () => {
    const fetchMock = makeFetch({
      'https://mail.example.com/.well-known/jmap': () => jsonResponse(SESSION),
      'https://mail.example.com/jmap': (init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err: any = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      }),
    });
    const t = new JmapTransport({
      sessionUrl: 'https://mail.example.com/.well-known/jmap',
      getAuthHeader: auth,
      fetch: fetchMock,
    });
    const controller = new AbortController();
    const pending = t.request(
      [JMAP_CAPS.CORE],
      [['Mailbox/get', {}, 'm1']],
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect((t as any)._inFlightHttp.size).toBe(1));
    controller.abort();
    // A caller-driven abort keeps its own AbortError rather than being
    // relabelled as a transport teardown.
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('gives the session fetch a deadline too', async () => {
    // request() awaits fetchSession() when no session is cached, so a
    // stalled session document hangs a send just as surely as a stalled
    // method call.
    const fetchMock = makeFetch({
      'https://mail.example.com/.well-known/jmap': (init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err: any = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      }),
    });
    const t = new JmapTransport({
      sessionUrl: 'https://mail.example.com/.well-known/jmap',
      getAuthHeader: auth,
      fetch: fetchMock,
      httpRequestTimeoutMs: 80,
    });
    await expect(t.fetchSession()).rejects.toMatchObject({ type: 'httpRequestTimeout' });
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
      expect(init.headers.Authorization).toBe(FAKE_BASIC_AUTH);
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

  it('opens no socket once the transport has been aborted', async () => {
    const t = makeTransport();
    t.abort();
    await expect(t.openWebSocket(['Email'], null))
      .rejects.toMatchObject({ type: 'transportAborted' });
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('closes a socket that finished connecting after the abort', async () => {
    // The abort can land while the handshake is in flight, between the
    // constructor and the open event. Keeping that socket would leave an
    // authenticated connection alive for a signed-out account, and the
    // WebSocketPushEnable would go out after teardown.
    const t = makeTransport();
    const open = t.openWebSocket(['Email'], null);
    const ws = await FakeWebSocket._waitForInstance();
    t.abort();
    ws._open();

    await expect(open).rejects.toMatchObject({ type: 'transportAborted' });
    expect(ws.sent, 'nothing may be sent on a socket opened into teardown').toEqual([]);
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    expect((t as any)._ws).toBeNull();
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

  it('rejects a wsRequest with a typed timeout error when the server never replies', async () => {
    // Failure mode: wsRequest stores a pending entry keyed by
    // requestId and only resolves when a matching Response /
    // RequestError frame arrives. If the server holds the
    // connection open but never sends one (slow path, server bug,
    // half-open NAT), the pending promise — and the JMAP method
    // call awaiting it — hangs forever. Browser TCP keepalives
    // can take minutes to tear down the connection, by which point
    // the user has already navigated away.
    const fetchMock = makeFetch({
      'https://mail.example.com/.well-known/jmap': () => jsonResponse(SESSION),
    });
    const t = new JmapTransport({
      sessionUrl: 'https://mail.example.com/.well-known/jmap',
      getAuthHeader: auth,
      fetch: fetchMock,
      WebSocketImpl: FakeWebSocket,
      wsRequestTimeoutMs: 80,
    });
    const open = t.openWebSocket(['Email'], null);
    const ws = await FakeWebSocket._waitForInstance();
    ws._open();
    await open;

    const started = Date.now();
    const pending = t.wsRequest(
      ['urn:ietf:params:jmap:core'],
      [['Core/echo', { hi: true }, 'c1']],
    );
    await expect(pending).rejects.toMatchObject({
      message: expect.stringMatching(/timed out/i),
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2_000);
    expect(elapsed).toBeGreaterThanOrEqual(50);

    // The pending entry must also be removed so the requestId can be
    // re-used and a late-arriving Response does not blow up.
    expect((t as any)._wsPending.size).toBe(0);
  });

  it('clears the wsRequest timeout when the server replies in time', async () => {
    // Negative-space test: a response that arrives before the timeout
    // must clear the timer so the resolved promise is not later
    // overwritten by a spurious timeout rejection.
    const fetchMock = makeFetch({
      'https://mail.example.com/.well-known/jmap': () => jsonResponse(SESSION),
    });
    const t = new JmapTransport({
      sessionUrl: 'https://mail.example.com/.well-known/jmap',
      getAuthHeader: auth,
      fetch: fetchMock,
      WebSocketImpl: FakeWebSocket,
      wsRequestTimeoutMs: 60,
    });
    const open = t.openWebSocket(['Email'], null);
    const ws = await FakeWebSocket._waitForInstance();
    ws._open();
    await open;

    const pending = t.wsRequest(
      ['urn:ietf:params:jmap:core'],
      [['Core/echo', { hi: true }, 'c1']],
    );
    const request = JSON.parse(ws.sent[1]);
    ws._receive({
      '@type': 'Response',
      requestId: request.id,
      methodResponses: [['Core/echo', { hi: true }, 'c1']],
    });
    const result = await pending as any;
    expect(result.methodResponses[0][0]).toBe('Core/echo');

    // Wait past the timeout window. If the timer was not cleared,
    // unhandled-rejection or extra wsPending side-effects would
    // surface here.
    await new Promise((r) => setTimeout(r, 120));
    expect((t as any)._wsPending.size).toBe(0);
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
