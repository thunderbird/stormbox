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
    SENDER_AVATAR_PROXY_ENABLED: 'true',
    SENDER_AVATAR_UPSTREAM_BASE: 'https://geticon.dev/',
    SENDER_AVATAR_FALLBACK_UPSTREAM_BASE: 'https://www.google.com/',
    ...overrides,
  };
}

describe('ws-proxy sender avatars', () => {
  let cacheMatch;
  let cachePut;
  let fetchMock;

  beforeEach(() => {
    cacheMatch = vi.fn().mockResolvedValue(undefined);
    cachePut = vi.fn().mockResolvedValue(undefined);
    fetchMock = vi.fn().mockResolvedValue(new Response('icon', {
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': '4',
      },
    }));
    vi.stubGlobal('caches', {
      default: {
        match: cacheMatch,
        put: cachePut,
      },
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('proxies sender-avatar requests only to geticon.dev with a domain token', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: 'png' }), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('icon', {
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': '4',
        },
      }));

    const ctx = makeCtx();
    const response = await worker.fetch(
      new Request('https://wsmail.stage-thundermail.com/sender-avatar/Example.COM.'),
      makeEnv(),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const metadataRequest = fetchMock.mock.calls[0][0] as Request;
    const upstreamRequest = fetchMock.mock.calls[1][0] as Request;
    expect(metadataRequest.url).toBe('https://geticon.dev/?url=example.com&format=json');
    expect(upstreamRequest.url).toBe('https://geticon.dev/?url=example.com');
    expect(metadataRequest.headers.get('Cookie')).toBeNull();
    expect(upstreamRequest.headers.get('Cookie')).toBeNull();
    expect(cachePut).toHaveBeenCalledOnce();
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    expect((cachePut.mock.calls[0][0] as Request).url).toBe('https://wsmail.stage-thundermail.com/sender-avatar/example.com');
  });

  it('falls back to Google favicons when geticon has no image response', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: 'avatar' }), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('png', {
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': '3',
        },
      }));

    const response = await worker.fetch(
      new Request('https://wsmail.stage-thundermail.com/sender-avatar/ups.com'),
      makeEnv(),
      makeCtx(),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0][0] as Request).url).toBe('https://geticon.dev/?url=ups.com&format=json');
    expect((fetchMock.mock.calls[1][0] as Request).url).toBe('https://www.google.com/s2/favicons?domain=ups.com&sz=64');
  });

  it('rejects clever URL-shaped input before fetching', async () => {
    const response = await worker.fetch(
      new Request('https://wsmail.stage-thundermail.com/sender-avatar/https%3A%2F%2Fevil.example%2Ffavicon.ico'),
      makeEnv(),
      makeCtx(),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when the route is disabled or the primary upstream is not geticon.dev', async () => {
    const disabled = await worker.fetch(
      new Request('https://wsmail.stage-thundermail.com/sender-avatar/example.com'),
      makeEnv({ SENDER_AVATAR_PROXY_ENABLED: 'false' }),
      makeCtx(),
    );
    const badUpstream = await worker.fetch(
      new Request('https://wsmail.stage-thundermail.com/sender-avatar/example.com'),
      makeEnv({ SENDER_AVATAR_UPSTREAM_BASE: 'https://example.com/' }),
      makeCtx(),
    );

    expect(disabled.status).toBe(404);
    expect(disabled.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(badUpstream.status).toBe(503);
    expect(badUpstream.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns only image content when providers return html or fail', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('<html>challenge</html>', {
        headers: { 'Content-Type': 'text/html' },
      }))
      .mockResolvedValueOnce(new Response('<html>challenge</html>', {
        headers: { 'Content-Type': 'text/html' },
      }))
      .mockResolvedValueOnce(new Response('<html>challenge</html>', {
        headers: { 'Content-Type': 'text/html' },
      }));

    const response = await worker.fetch(
      new Request('https://wsmail.stage-thundermail.com/sender-avatar/ups.com?v=5'),
      makeEnv(),
      makeCtx(),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(await response.text()).toContain('<svg');
    expect((cacheMatch.mock.calls[0][0] as Request).url).toBe('https://wsmail.stage-thundermail.com/sender-avatar/ups.com?v=5');
    expect(cachePut).not.toHaveBeenCalled();
  });
});
