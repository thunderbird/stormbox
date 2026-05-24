import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import worker from '../../../infra/ws-proxy/src/index';

function makeCtx() {
  return {
    waitUntil: vi.fn(),
  };
}

function makeEnv(overrides = {}) {
  return {
    ALLOWED_ORIGINS: 'https://webmail.stage-thundermail.com',
    ...overrides,
  };
}

describe('ws-proxy WebSocket upgrade auth bridge', () => {
  let fetchMock;

  beforeEach(() => {
    // Real Cloudflare runtime returns a 101 Switching Protocols, but
    // the standard Response constructor in vitest disallows that. The
    // proxy just passes the upstream response through, so a 200 here
    // is enough to assert the bridge's request shape (headers + URL).
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rewrites ?access_token=... into an upstream Bearer Authorization header and strips it from the URL', async () => {
    const response = await worker.fetch(
      new Request('https://wsmail.stage-thundermail.com/jmap/ws?access_token=jwt-abc', {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          Cookie: 'session=should-not-leak',
        },
      }),
      makeEnv({ UPSTREAM_BASE_STAGE: 'https://mail.stage-thundermail.com' }),
      makeCtx(),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const upstream = fetchMock.mock.calls[0][0] as Request;
    expect(upstream.url).toBe('https://mail.stage-thundermail.com/jmap/ws');
    expect(upstream.headers.get('Authorization')).toBe('Bearer jwt-abc');
    expect(upstream.headers.get('Cookie')).toBeNull();
  });

  it('rewrites ?basic=... into a Basic auth header', async () => {
    await worker.fetch(
      new Request('https://wsmail.stage-thundermail.com/jmap/ws?basic=dXNlcjpwYXNz', {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
      }),
      makeEnv(),
      makeCtx(),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0][0] as Request).headers.get('Authorization')).toBe('Basic dXNlcjpwYXNz');
  });

  it('rejects an upgrade missing both credentials carriers (401) and conflicting credentials (400)', async () => {
    const missing = await worker.fetch(
      new Request('https://wsmail.stage-thundermail.com/jmap/ws', {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
      }),
      makeEnv(),
      makeCtx(),
    );
    expect(missing.status).toBe(401);

    const both = await worker.fetch(
      new Request('https://wsmail.stage-thundermail.com/jmap/ws?access_token=x&basic=y', {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
      }),
      makeEnv(),
      makeCtx(),
    );
    expect(both.status).toBe(400);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to bridge upgrades that target paths outside /jmap/*', async () => {
    const response = await worker.fetch(
      new Request('https://wsmail.stage-thundermail.com/anything-else?access_token=x', {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
      }),
      makeEnv(),
      makeCtx(),
    );
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ws-proxy JMAP HTTP routing and session rewrite', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('proxies whitelisted JMAP HTTP paths to the configured upstream and strips Origin/Cookie', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', {
      headers: { 'Content-Type': 'application/json' },
    }));

    const response = await worker.fetch(
      new Request('https://wsmail.stage-thundermail.com/jmap/api', {
        method: 'POST',
        headers: {
          Origin: 'https://webmail.stage-thundermail.com',
          Authorization: 'Bearer token',
          Cookie: 'session=do-not-leak',
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
      makeEnv({ UPSTREAM_BASE_STAGE: 'https://mail.stage-thundermail.com' }),
      makeCtx(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin'))
      .toBe('https://webmail.stage-thundermail.com');

    const upstream = fetchMock.mock.calls[0][0] as Request;
    expect(upstream.url).toBe('https://mail.stage-thundermail.com/jmap/api');
    expect(upstream.headers.get('Origin')).toBeNull();
    expect(upstream.headers.get('Cookie')).toBeNull();
    expect(upstream.headers.get('Authorization')).toBe('Bearer token');
  });

  it('rejects HTTP requests to paths outside the JMAP allowlist with 403', async () => {
    const response = await worker.fetch(
      new Request('https://wsmail.stage-thundermail.com/internal/admin'),
      makeEnv(),
      makeCtx(),
    );
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rewrites every upstream origin reference in the JMAP session document to the proxy origin', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      apiUrl: 'https://mail.stage-thundermail.com/jmap/api',
      eventSourceUrl: 'https://mail.stage-thundermail.com/jmap/event-source',
      webSocketUrl: 'wss://mail.stage-thundermail.com/jmap/ws',
      uploadUrl: 'https://mail.stage-thundermail.com/jmap/upload',
    }), { headers: { 'Content-Type': 'application/json' } }));

    const response = await worker.fetch(
      new Request('https://wsmail.stage-thundermail.com/.well-known/jmap', {
        headers: {
          Origin: 'https://webmail.stage-thundermail.com',
          Authorization: 'Bearer token',
        },
      }),
      makeEnv({ UPSTREAM_BASE_STAGE: 'https://mail.stage-thundermail.com' }),
      makeCtx(),
    );

    const body = await response.json();
    // Every upstream URL in the session document must point at the
    // proxy, otherwise the browser tries to talk to Stalwart directly
    // and hits the CORS wall that this whole proxy exists to bypass.
    expect(body.apiUrl).toBe('https://wsmail.stage-thundermail.com/jmap/api');
    expect(body.uploadUrl).toBe('https://wsmail.stage-thundermail.com/jmap/upload');
    expect(body.eventSourceUrl).toBe('https://wsmail.stage-thundermail.com/jmap/event-source');
    expect(body.webSocketUrl).toBe('wss://wsmail.stage-thundermail.com/jmap/ws');
  });
});

describe('ws-proxy CORS preflight', () => {
  it('returns a 204 with permissive headers for OPTIONS on a JMAP path and an allowed Origin', async () => {
    const response = await worker.fetch(
      new Request('https://wsmail.stage-thundermail.com/jmap/api', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://webmail.stage-thundermail.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Authorization, Content-Type',
        },
      }),
      makeEnv(),
      makeCtx(),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin'))
      .toBe('https://webmail.stage-thundermail.com');
    expect(response.headers.get('Access-Control-Allow-Methods'))
      .toMatch(/POST/);
  });

  it('refuses preflight for non-JMAP paths with 403', async () => {
    const response = await worker.fetch(
      new Request('https://wsmail.stage-thundermail.com/internal/admin', {
        method: 'OPTIONS',
        headers: { Origin: 'https://webmail.stage-thundermail.com' },
      }),
      makeEnv(),
      makeCtx(),
    );
    expect(response.status).toBe(403);
  });
});
