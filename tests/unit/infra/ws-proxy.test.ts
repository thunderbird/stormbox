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

  it('uses the prod upstream when the upgrade comes in on the prod host', async () => {
    await worker.fetch(
      new Request('https://wsmail.thundermail.com/jmap/ws?access_token=jwt-prod', {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
      }),
      makeEnv(),
      makeCtx(),
    );

    expect((fetchMock.mock.calls[0][0] as Request).url)
      .toBe('https://mail.thundermail.com/jmap/ws');
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

describe('ws-proxy non-upgrade traffic', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns 426 Upgrade Required for plain HTTP requests and never calls upstream', async () => {
    const response = await worker.fetch(
      new Request('https://wsmail.stage-thundermail.com/jmap/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
      makeEnv(),
      makeCtx(),
    );

    expect(response.status).toBe(426);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 426 for OPTIONS preflights (CORS is not handled here)', async () => {
    const response = await worker.fetch(
      new Request('https://wsmail.stage-thundermail.com/jmap/api', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://webmail.stage-thundermail.com',
          'Access-Control-Request-Method': 'POST',
        },
      }),
      makeEnv(),
      makeCtx(),
    );

    expect(response.status).toBe(426);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
