import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import worker from '../../../infra/jmap-bridge/src/index';
import { selectRoute, TEST_UPSTREAM_HEADER } from '../../../infra/jmap-bridge/src/routes';

describe('jmap-bridge routes.selectRoute', () => {
  it('selects prod for jmap.thundermail.com', () => {
    expect(selectRoute(new Request('https://jmap.thundermail.com/jmap/ws'))?.upstream)
      .toBe('https://mail.thundermail.com');
  });

  it('selects stage for jmap.stage-thundermail.com', () => {
    expect(selectRoute(new Request('https://jmap.stage-thundermail.com/jmap/ws'))?.upstream)
      .toBe('https://mail.stage-thundermail.com');
  });

  it('defaults workers.dev to stage', () => {
    expect(selectRoute(new Request('https://stormbox-jmap-bridge.x.workers.dev/jmap/ws'))?.upstream)
      .toBe('https://mail.stage-thundermail.com');
  });

  it('lets workers.dev pick prod via the test upstream header', () => {
    const route = selectRoute(new Request('https://stormbox-jmap-bridge.x.workers.dev/jmap/ws', {
      headers: { [TEST_UPSTREAM_HEADER]: 'prod' },
    }));
    expect(route?.upstream).toBe('https://mail.thundermail.com');
  });

  it('returns null for unknown hosts (no open proxy)', () => {
    expect(selectRoute(new Request('https://attacker.example/jmap/ws'))).toBeNull();
    expect(selectRoute(new Request('https://webmail.thundermail.com/jmap/ws'))).toBeNull();
    expect(selectRoute(new Request('https://wsmail.thundermail.com/jmap/ws'))).toBeNull();
  });
});

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

  it('preserves the WebSocket subprotocol and non-credential query parameters', async () => {
    await worker.fetch(new Request('https://jmap.thundermail.com/jmap/ws?access_token=jwt&pushState=resume', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'jmap' },
    }));
    const upstream = fetchMock.mock.calls[0][0] as Request;
    expect(upstream.url).toBe('https://mail.thundermail.com/jmap/ws?pushState=resume');
    expect(upstream.headers.get('Sec-WebSocket-Protocol')).toBe('jmap');
  });

  it('routes workers.dev upgrades to the requested upstream', async () => {
    await worker.fetch(new Request('https://x.workers.dev/jmap/ws?access_token=jwt', {
      headers: { Upgrade: 'websocket', [TEST_UPSTREAM_HEADER]: 'prod' },
    }));
    expect((fetchMock.mock.calls[0][0] as Request).url)
      .toBe('https://mail.thundermail.com/jmap/ws');
  });

  it.each(['GET', 'POST', 'OPTIONS'])('rejects %s without a WebSocket upgrade', async (method) => {
    const response = await worker.fetch(new Request('https://jmap.thundermail.com/jmap/ws?access_token=jwt', {
      method,
    }));
    expect(response.status).toBe(426);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    '/.well-known/jmap', '/jmap/', '/jmap/session',
    '/jmap/upload/u/', '/jmap/download/u/blob/file', '/jmap/eventsource/',
  ])('does not proxy HTTP or WebSocket requests to %s', async (path) => {
    for (const headers of [{}, { Upgrade: 'websocket' }]) {
      const response = await worker.fetch(new Request(`https://jmap.thundermail.com${path}`, {
        headers,
      }));
      expect(response.status).toBe(404);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('refuses to bridge upgrades outside /jmap/ws', async () => {
    const response = await worker.fetch(
      new Request('https://jmap.stage-thundermail.com/anything-else?access_token=x', {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
      }),
    );
    expect(response.status).toBe(404);
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
