import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import worker from '../../../infra/jmap-bridge/src/index';
import {
  classifyHost, PROD_ROUTE, STAGE_ROUTE, selectRoute, TEST_UPSTREAM_HEADER,
} from '../../../infra/jmap-bridge/src/routes';
import { rewriteHttpHost, rewriteSessionUrls } from '../../../infra/jmap-bridge/src/http';

const STAGE_SESSION_BODY = JSON.stringify({
  capabilities: {
    'urn:ietf:params:jmap:core': { maxSizeUpload: 50_000_000 },
    'urn:ietf:params:jmap:websocket': {
      url: 'wss://mail.stage-thundermail.com:443/jmap/ws',
      supportsPush: true,
    },
  },
  accounts: {
    u: { name: 'sancus@stage-thundermail.com', isPersonal: true },
  },
  primaryAccounts: {
    'urn:ietf:params:jmap:mail': 'u',
  },
  apiUrl: 'https://mail.stage-thundermail.com:443/jmap/',
  downloadUrl:
    'https://mail.stage-thundermail.com:443/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
  uploadUrl: 'https://mail.stage-thundermail.com:443/jmap/upload/{accountId}/',
  eventSourceUrl:
    'https://mail.stage-thundermail.com:443/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}',
});

// ---------------------------------------------------------------------------
// routes.ts
// ---------------------------------------------------------------------------
describe('jmap-bridge routes.selectRoute', () => {
  it('selects prod for jmap.thundermail.com', () => {
    expect(selectRoute(new Request('https://jmap.thundermail.com/jmap/'))?.upstream)
      .toBe('https://mail.thundermail.com');
  });

  it('selects stage for jmap.stage-thundermail.com', () => {
    expect(selectRoute(new Request('https://jmap.stage-thundermail.com/jmap/'))?.upstream)
      .toBe('https://mail.stage-thundermail.com');
  });

  it('defaults workers.dev to stage', () => {
    expect(selectRoute(new Request('https://stormbox-jmap-bridge.x.workers.dev/jmap/'))?.upstream)
      .toBe('https://mail.stage-thundermail.com');
  });

  it('lets workers.dev pick prod via the test upstream header', () => {
    const route = selectRoute(new Request('https://stormbox-jmap-bridge.x.workers.dev/jmap/', {
      headers: { [TEST_UPSTREAM_HEADER]: 'prod' },
    }));
    expect(route?.upstream).toBe('https://mail.thundermail.com');
  });

  it('returns null for unknown hosts (no open proxy)', () => {
    expect(selectRoute(new Request('https://attacker.example/jmap/'))).toBeNull();
    expect(selectRoute(new Request('https://webmail.thundermail.com/jmap/'))).toBeNull();
    expect(selectRoute(new Request('https://wsmail.thundermail.com/jmap/ws'))).toBeNull();
  });
});

describe('jmap-bridge routes.classifyHost', () => {
  it('classifies jmap / workers-dev / unknown', () => {
    expect(classifyHost('jmap.stage-thundermail.com')).toBe('jmap');
    expect(classifyHost('jmap.thundermail.com')).toBe('jmap');
    expect(classifyHost('x.workers.dev')).toBe('workers-dev');
    expect(classifyHost('wsmail.thundermail.com')).toBe('unknown');
    expect(classifyHost('webmail.thundermail.com')).toBe('unknown');
    expect(classifyHost('example.com')).toBe('unknown');
  });
});

describe('jmap-bridge routes.allowedOrigins', () => {
  it('stage allows the stage webmail and local dev origins', () => {
    expect(STAGE_ROUTE.allowedOrigins.has('https://webmail.stage-thundermail.com')).toBe(true);
    expect(STAGE_ROUTE.allowedOrigins.has('https://localhost:3000')).toBe(true);
    expect(STAGE_ROUTE.allowedOrigins.has('http://localhost:3000')).toBe(true);
  });

  it('stage does NOT allow the prod webmail origin', () => {
    expect(STAGE_ROUTE.allowedOrigins.has('https://webmail.thundermail.com')).toBe(false);
  });

  it('prod allows only the prod webmail origin (no dev)', () => {
    expect(PROD_ROUTE.allowedOrigins.has('https://webmail.thundermail.com')).toBe(true);
    expect(PROD_ROUTE.allowedOrigins.has('https://webmail.stage-thundermail.com')).toBe(false);
    expect(PROD_ROUTE.allowedOrigins.has('https://localhost:3000')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// http.ts rewriting helpers
// ---------------------------------------------------------------------------
describe('jmap-bridge http.rewriteSessionUrls', () => {
  it('rewrites HTTP and WS URLs to jmap.*', () => {
    const session = JSON.parse(STAGE_SESSION_BODY);
    const out = rewriteSessionUrls(session, STAGE_ROUTE) as Record<string, any>;

    expect(out.apiUrl).toBe('https://jmap.stage-thundermail.com/jmap/');
    expect(out.downloadUrl).toBe(
      'https://jmap.stage-thundermail.com/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
    );
    expect(out.uploadUrl).toBe('https://jmap.stage-thundermail.com/jmap/upload/{accountId}/');
    expect(out.eventSourceUrl).toBe(
      'https://jmap.stage-thundermail.com/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}',
    );
    expect(out.capabilities['urn:ietf:params:jmap:websocket'].url).toBe(
      'wss://jmap.stage-thundermail.com/jmap/ws',
    );
  });

  it('handles both port-and-no-port forms of the Stalwart host', () => {
    const rewritten = rewriteHttpHost(
      'see https://mail.thundermail.com:443/jmap/ and https://mail.thundermail.com/jmap/api too',
      PROD_ROUTE,
    );
    expect(rewritten).toBe(
      'see https://jmap.thundermail.com/jmap/ and https://jmap.thundermail.com/jmap/api too',
    );
  });

  it('does not corrupt unrelated string fields', () => {
    const session = {
      capabilities: {},
      accounts: { u: { name: 'sancus@stage-thundermail.com', accountCapabilities: {} } },
      primaryAccounts: {},
      apiUrl: 'https://mail.stage-thundermail.com:443/jmap/',
      state: 'cyrus-imap-xyz',
      username: 'sancus@stage-thundermail.com',
    };
    const out = rewriteSessionUrls(session, STAGE_ROUTE) as Record<string, any>;
    expect(out.username).toBe('sancus@stage-thundermail.com');
    expect(out.state).toBe('cyrus-imap-xyz');
    expect(out.accounts.u.name).toBe('sancus@stage-thundermail.com');
    expect(out.apiUrl).toBe('https://jmap.stage-thundermail.com/jmap/');
  });
});

// ---------------------------------------------------------------------------
// WebSocket auth bridge (ws.ts via worker.fetch on jmap.* hosts)
// ---------------------------------------------------------------------------
describe('jmap-bridge WebSocket upgrade auth bridge', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Real Cloudflare returns 101 on WS upgrade, but vitest's Response
    // constructor disallows that status. A 200 here is enough to
    // assert request shape (headers + URL).
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('promotes ?access_token=... to Authorization: Bearer and strips it from the URL', async () => {
    const response = await worker.fetch(
      new Request('https://jmap.stage-thundermail.com/jmap/ws?access_token=jwt-abc', {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          Cookie: 'session=should-not-leak',
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const upstream = fetchMock.mock.calls[0][0] as Request;
    expect(upstream.url).toBe('https://mail.stage-thundermail.com/jmap/ws');
    expect(upstream.headers.get('Authorization')).toBe('Bearer jwt-abc');
    expect(upstream.headers.get('Cookie')).toBeNull();
  });

  it('promotes ?basic=... to Authorization: Basic', async () => {
    await worker.fetch(
      new Request('https://jmap.stage-thundermail.com/jmap/ws?basic=dXNlcjpwYXNz', {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
      }),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0][0] as Request).headers.get('Authorization')).toBe('Basic dXNlcjpwYXNz');
  });

  it('routes jmap.thundermail.com upgrades to the prod Stalwart', async () => {
    await worker.fetch(
      new Request('https://jmap.thundermail.com/jmap/ws?access_token=jwt-prod', {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
      }),
    );
    expect((fetchMock.mock.calls[0][0] as Request).url)
      .toBe('https://mail.thundermail.com/jmap/ws');
  });

  it('rejects missing creds with 401 and conflicting creds with 400', async () => {
    const missing = await worker.fetch(
      new Request('https://jmap.stage-thundermail.com/jmap/ws', {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
      }),
    );
    expect(missing.status).toBe(401);

    const both = await worker.fetch(
      new Request('https://jmap.stage-thundermail.com/jmap/ws?access_token=x&basic=y', {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
      }),
    );
    expect(both.status).toBe(400);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to bridge upgrades that target paths outside /jmap/*', async () => {
    const response = await worker.fetch(
      new Request('https://jmap.stage-thundermail.com/anything-else?access_token=x', {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
      }),
    );
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not route old wsmail.* hosts', async () => {
    const response = await worker.fetch(
      new Request('https://wsmail.stage-thundermail.com/jmap/ws?access_token=x', {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
      }),
    );
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// HTTP proxy CORS handling (jmap.*)
// ---------------------------------------------------------------------------
describe('jmap-bridge HTTP CORS preflight', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('short-circuits OPTIONS preflight from the stage webmail origin (204 with CORS headers)', async () => {
    const response = await worker.fetch(new Request('https://jmap.stage-thundermail.com/jmap/', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://webmail.stage-thundermail.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization, Content-Type',
      },
    }));
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin'))
      .toBe('https://webmail.stage-thundermail.com');
    expect(response.headers.get('vary')).toBe('Origin');
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    expect(response.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(response.headers.get('access-control-max-age')).toBe('3600');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('short-circuits OPTIONS preflight from prod webmail origin against prod bridge', async () => {
    const response = await worker.fetch(new Request('https://jmap.thundermail.com/jmap/', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://webmail.thundermail.com',
        'Access-Control-Request-Method': 'POST',
      },
    }));
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin'))
      .toBe('https://webmail.thundermail.com');
  });

  it('rejects OPTIONS preflight from the prod webmail origin against the stage bridge (403)', async () => {
    const response = await worker.fetch(new Request('https://jmap.stage-thundermail.com/jmap/', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://webmail.thundermail.com',
        'Access-Control-Request-Method': 'POST',
      },
    }));
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects OPTIONS preflight from an unrecognised origin (no allow-*, but Vary: Origin)', async () => {
    const response = await worker.fetch(new Request('https://jmap.thundermail.com/jmap/', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://attacker.example',
        'Access-Control-Request-Method': 'POST',
      },
    }));
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-methods')).toBeNull();
    expect(response.headers.get('vary')).toBe('Origin');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows localhost dev origin on stage but not on prod', async () => {
    const stageResp = await worker.fetch(new Request('https://jmap.stage-thundermail.com/jmap/', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://localhost:3000',
        'Access-Control-Request-Method': 'POST',
      },
    }));
    expect(stageResp.status).toBe(204);
    expect(stageResp.headers.get('access-control-allow-origin')).toBe('https://localhost:3000');

    const prodResp = await worker.fetch(new Request('https://jmap.thundermail.com/jmap/', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://localhost:3000',
        'Access-Control-Request-Method': 'POST',
      },
    }));
    expect(prodResp.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// HTTP proxy forwarding (jmap.*)
// ---------------------------------------------------------------------------
describe('jmap-bridge HTTP proxy forwarding', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards /jmap/ POSTs to upstream and strips CF + cookie headers', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"methodResponses":[]}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await worker.fetch(new Request('https://jmap.thundermail.com/jmap/', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer jwt-abc',
        'Content-Type': 'application/json',
        Origin: 'https://webmail.thundermail.com',
        'CF-Connecting-IP': '1.2.3.4',
        Cookie: 'session=should-not-leak',
      },
      body: '{"using":[],"methodCalls":[]}',
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin'))
      .toBe('https://webmail.thundermail.com');
    expect(response.headers.get('vary')).toBe('Origin');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [upstreamUrl, init] = fetchMock.mock.calls[0];
    expect(upstreamUrl).toBe('https://mail.thundermail.com/jmap/');
    const hdr = new Headers(init.headers);
    expect(hdr.get('authorization')).toBe('Bearer jwt-abc');
    expect(hdr.get('cookie')).toBeNull();
    expect(hdr.get('cf-connecting-ip')).toBeNull();
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
  });

  it('rewrites session URLs on the response stream and adds CORS headers', async () => {
    fetchMock.mockResolvedValueOnce(new Response(STAGE_SESSION_BODY, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await worker.fetch(new Request('https://jmap.stage-thundermail.com/jmap/session', {
      headers: {
        Authorization: 'Basic dXNlcjpwYXNz',
        Origin: 'https://webmail.stage-thundermail.com',
      },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin'))
      .toBe('https://webmail.stage-thundermail.com');
    const session = await response.json();
    expect(session.apiUrl).toBe('https://jmap.stage-thundermail.com/jmap/');
    expect(session.capabilities['urn:ietf:params:jmap:websocket'].url)
      .toBe('wss://jmap.stage-thundermail.com/jmap/ws');
  });

  it('forwards responses without Allow-Origin when origin is unrecognised, but keeps Vary: Origin', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const response = await worker.fetch(new Request('https://jmap.thundermail.com/jmap/', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer jwt',
        'Content-Type': 'application/json',
        Origin: 'https://attacker.example',
      },
      body: '{}',
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('vary')).toBe('Origin');
  });

  it('strips upstream Access-Control-* headers so Stalwart CORS never leaks through', async () => {
    // Stage Stalwart serves `Access-Control-Allow-Origin: *` and a
    // permissive Allow-Methods/Allow-Headers set. The bridge must
    // be the sole source of CORS truth.
    fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, GET, PATCH, PUT, DELETE, HEAD, OPTIONS',
        'access-control-allow-headers': 'Authorization, Content-Type, Accept, X-Requested-With',
      },
    }));
    const response = await worker.fetch(new Request('https://jmap.stage-thundermail.com/jmap/', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer jwt',
        'Content-Type': 'application/json',
        Origin: 'https://webmail.stage-thundermail.com',
      },
      body: '{}',
    }));
    // Bridge sets exactly one Allow-Origin (the recognised one),
    // and strips Stalwart's Allow-Methods / Allow-Headers entirely.
    expect(response.headers.get('access-control-allow-origin'))
      .toBe('https://webmail.stage-thundermail.com');
    expect(response.headers.get('access-control-allow-methods')).toBeNull();
    expect(response.headers.get('access-control-allow-headers')).toBeNull();
    expect(response.headers.get('vary')).toBe('Origin');
  });

  it('strips upstream Access-Control-* even when the request Origin is unrecognised', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',  // Stalwart's permissive default
      },
    }));
    const response = await worker.fetch(new Request('https://jmap.stage-thundermail.com/jmap/session', {
      method: 'GET',
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },  // no Origin
    }));
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('vary')).toBe('Origin');
  });

  it('rewrites absolute Location headers on upstream redirects', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { location: 'https://mail.thundermail.com:443/jmap/session' },
    }));

    const response = await worker.fetch(new Request('https://jmap.thundermail.com/.well-known/jmap'));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://jmap.thundermail.com/jmap/session');
  });

  it('passes relative Location headers through unchanged', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, {
      status: 307,
      headers: { location: '/jmap/session' },
    }));
    const response = await worker.fetch(new Request('https://jmap.thundermail.com/.well-known/jmap'));
    expect(response.headers.get('location')).toBe('/jmap/session');
  });

  it('rejects non-upgrade /jmap/ws requests without forwarding URL credentials', async () => {
    const response = await worker.fetch(new Request('https://jmap.thundermail.com/jmap/ws?access_token=jwt', {
      headers: { Origin: 'https://webmail.thundermail.com' },
    }));
    expect(response.status).toBe(426);
    expect(response.headers.get('access-control-allow-origin'))
      .toBe('https://webmail.thundermail.com');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses paths outside /jmap/* and /.well-known/jmap on jmap.*', async () => {
    const response = await worker.fetch(new Request('https://jmap.thundermail.com/admin', {
      headers: { Origin: 'https://webmail.thundermail.com' },
    }));
    expect(response.status).toBe(404);
    // Still attaches CORS headers so the SPA can read the 404
    expect(response.headers.get('access-control-allow-origin'))
      .toBe('https://webmail.thundermail.com');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses unknown hosts with 404 (does not act as an open proxy)', async () => {
    const response = await worker.fetch(new Request('https://attacker.example/jmap/'));
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes upload bodies through as streams without buffering', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } }));

    const body = new Uint8Array([1, 2, 3, 4, 5]);
    const response = await worker.fetch(new Request('https://jmap.thundermail.com/jmap/upload/u/', {
      method: 'POST',
      headers: { Authorization: 'Bearer jwt', 'Content-Type': 'application/octet-stream' },
      body,
    }));
    expect(response.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).not.toBeNull();
    expect(init.method).toBe('POST');
  });

  it('does not forward a body on GET', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    await worker.fetch(new Request('https://jmap.thundermail.com/jmap/session', {
      method: 'GET',
      headers: { Authorization: 'Bearer jwt' },
    }));
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting dispatch behaviour (one Worker, one bridge hostname shape)
// ---------------------------------------------------------------------------
describe('jmap-bridge workers.dev test mode dispatch', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes Upgrade requests on *.workers.dev through the WS bridge', async () => {
    await worker.fetch(new Request('https://x.workers.dev/jmap/ws?access_token=jwt', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    }));
    expect(fetchMock).toHaveBeenCalledOnce();
    const upstream = fetchMock.mock.calls[0][0] as Request;
    expect(upstream.headers.get('Authorization')).toBe('Bearer jwt');
    expect(upstream.url).toBe('https://mail.stage-thundermail.com/jmap/ws');
  });

  it('routes non-Upgrade requests on *.workers.dev through the HTTP proxy', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    await worker.fetch(new Request('https://x.workers.dev/jmap/', {
      method: 'POST',
      headers: { Authorization: 'Bearer jwt', 'Content-Type': 'application/json' },
      body: '{"using":[],"methodCalls":[]}',
    }));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [upstreamUrl] = fetchMock.mock.calls[0];
    expect(upstreamUrl).toBe('https://mail.stage-thundermail.com/jmap/');
  });

  it('honours X-Jmap-Bridge-Test-Upstream: prod on *.workers.dev', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    await worker.fetch(new Request('https://x.workers.dev/jmap/', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer jwt',
        'Content-Type': 'application/json',
        'X-Jmap-Bridge-Test-Upstream': 'prod',
      },
      body: '{}',
    }));
    const [upstreamUrl] = fetchMock.mock.calls[0];
    expect(upstreamUrl).toBe('https://mail.thundermail.com/jmap/');
  });
});
