/**
 * stormbox-ws-proxy: a scoped Cloudflare Worker proxy for Stalwart JMAP.
 *
 * Why this exists:
 *
 *   Browser clients call Stalwart from webmail.stage-thundermail.com
 *   and webmail.thundermail.com, but we do not want stage/prod Stalwart
 *   config changes just to allow those CORS origins. This Worker proxies
 *   the narrow JMAP HTTP surface and sets browser-facing CORS headers at
 *   the edge.
 *
 *   It also keeps the existing JMAP-over-WebSocket auth bridge:
 *   Stalwart's /jmap/ws handler accepts authentication via the HTTP
 *   `Authorization` header on the upgrade request, but browsers cannot
 *   set arbitrary headers on `new WebSocket(url, protocols)`. The client
 *   puts ?access_token=<jwt> or ?basic=<base64> on the WebSocket URL; the
 *   Worker strips that credential, sets Authorization upstream, and
 *   passes the upgrade through unchanged.
 *
 *   The token is only ever transmitted inside the encrypted TLS
 *   payload of the upgrade request (one request per connection
 *   lifetime), is stripped before it reaches Stalwart, and is excluded
 *   from the worker's own access logs by default.
 *
 * Deploy:  wrangler deploy   (see ../README.md)
 * Bound at: wsmail.stage-thundermail.com and wsmail.thundermail.com.
 */

export interface Env {
  /** Fallback upstream Stalwart origin, kept for ad-hoc wrangler dev usage. */
  UPSTREAM_BASE?: string;
  /** Upstream Stalwart origin for wsmail.stage-thundermail.com. */
  UPSTREAM_BASE_STAGE?: string;
  /** Upstream Stalwart origin for wsmail.thundermail.com. */
  UPSTREAM_BASE_PROD?: string;
  /** Comma-separated browser origins that may call this proxy. */
  ALLOWED_ORIGINS?: string;
}

const DEFAULT_STAGE_PROXY_HOST = 'wsmail.stage-thundermail.com';
const DEFAULT_PROD_PROXY_HOST = 'wsmail.thundermail.com';
const DEFAULT_STAGE_UPSTREAM = 'https://mail.stage-thundermail.com';
const DEFAULT_PROD_UPSTREAM = 'https://mail.thundermail.com';
const DEFAULT_ALLOWED_ORIGINS = [
  'https://webmail.stage-thundermail.com',
  'https://webmail.thundermail.com',
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestUrl = new URL(request.url);
    const upstreamBase = getUpstreamBase(requestUrl.hostname, env);

    if (request.method === 'OPTIONS') {
      return handlePreflight(request, env);
    }

    const upgrade = request.headers.get('Upgrade');
    if (upgrade?.toLowerCase() === 'websocket') {
      return proxyWebSocket(request, upstreamBase);
    }

    if (!isHttpJmapPath(requestUrl.pathname)) {
      return withCors(request, new Response('Only JMAP HTTP paths are proxied', { status: 403 }), env);
    }

    if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
      return withCors(request, new Response('Method not allowed', { status: 405 }), env);
    }

    return proxyHttpJmap(request, upstreamBase, env);
  },
};

async function proxyWebSocket(request: Request, upstreamBase: string): Promise<Response> {
    const url = new URL(request.url);

    // Two supported credential carriers:
    //   ?access_token=<jwt>       -> Authorization: Bearer <jwt>     (OIDC happy path, RFC 6750 §2.3)
    //   ?basic=<base64userpass>   -> Authorization: Basic <base64>   (self-host / app-password)
    // Exactly one must be set. Both are stripped before forwarding so
    // Stalwart never sees them in the URL or its logs.
    const bearer = url.searchParams.get('access_token');
    const basic = url.searchParams.get('basic');
    url.searchParams.delete('access_token');
    url.searchParams.delete('basic');

    let authHeader: string | null = null;
    if (bearer && !basic) authHeader = `Bearer ${bearer}`;
    else if (basic && !bearer) authHeader = `Basic ${basic}`;
    else if (bearer && basic) {
      return new Response('Pass either access_token OR basic, not both', { status: 400 });
    } else {
      return new Response('Missing access_token or basic query parameter', { status: 401 });
    }

    // Only /jmap/* is in scope. Anything else is almost certainly a
    // misconfiguration; reject early rather than acting as an open
    // bearer-injection proxy for the whole upstream.
    if (!url.pathname.startsWith('/jmap/')) {
      return new Response('Only /jmap/* upgrades are proxied', { status: 403 });
    }

    const upstream = new URL(url.pathname + url.search, upstreamBase);
    const upstreamReq = new Request(upstream.toString(), request);
    upstreamReq.headers.set('Authorization', authHeader);
    // Stateless bearer-bridge: don't leak any client cookies that the
    // browser would otherwise send on the same-origin upgrade.
    upstreamReq.headers.delete('Cookie');

    // Cloudflare's runtime handles WebSocket upgrade passthrough when
    // we return the fetch response directly.
    return fetch(upstreamReq);
}

async function proxyHttpJmap(request: Request, upstreamBase: string, env: Env): Promise<Response> {
  const requestUrl = new URL(request.url);
  const upstream = new URL(requestUrl.pathname + requestUrl.search, upstreamBase);
  const upstreamReq = new Request(upstream.toString(), request);

  // The browser-facing CORS contract is owned by this Worker, not Stalwart.
  upstreamReq.headers.delete('Origin');
  upstreamReq.headers.delete('Cookie');

  const upstreamRes = await fetch(upstreamReq);
  const response = isJmapSessionPath(requestUrl.pathname)
    ? await rewriteSessionResponse(upstreamRes, upstreamBase, requestUrl.origin)
    : stripUpstreamCors(upstreamRes);

  return withCors(request, response, env);
}

async function rewriteSessionResponse(
  response: Response,
  upstreamBase: string,
  proxyOrigin: string,
): Promise<Response> {
  if (!response.ok) {
    return stripUpstreamCors(response);
  }

  const contentType = response.headers.get('Content-Type') ?? '';
  if (!contentType.toLowerCase().includes('json')) {
    return stripUpstreamCors(response);
  }

  const session = await response.json();
  const upstreamUrl = new URL(upstreamBase);
  const proxyUrl = new URL(proxyOrigin);
  const replacements = [
    [upstreamUrl.origin, proxyUrl.origin],
    [`ws://${upstreamUrl.host}`, `ws://${proxyUrl.host}`],
    [`wss://${upstreamUrl.host}`, `wss://${proxyUrl.host}`],
  ] as const;
  const rewritten = rewriteValue(session, replacements);
  const headers = filteredHeaders(response.headers);
  headers.set('Content-Type', contentType || 'application/json');
  headers.delete('Content-Length');

  return new Response(JSON.stringify(rewritten), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function rewriteValue(value: unknown, replacements: readonly (readonly [string, string])[]): unknown {
  if (typeof value === 'string') {
    return replacements.reduce(
      (result, [from, to]) => result.replaceAll(from, to),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteValue(item, replacements));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rewriteValue(item, replacements)]),
    );
  }
  return value;
}

function handlePreflight(request: Request, env: Env): Response {
  const requestUrl = new URL(request.url);
  if (!isHttpJmapPath(requestUrl.pathname) && !requestUrl.pathname.startsWith('/jmap/')) {
    return new Response(null, { status: 403 });
  }
  return withCors(request, new Response(null, { status: 204 }), env);
}

function isHttpJmapPath(pathname: string): boolean {
  return pathname === '/.well-known/jmap'
    || pathname === '/jmap'
    || pathname.startsWith('/jmap/');
}

function isJmapSessionPath(pathname: string): boolean {
  return pathname === '/.well-known/jmap'
    || pathname === '/jmap/session';
}

function getUpstreamBase(hostname: string, env: Env): string {
  if (hostname === DEFAULT_PROD_PROXY_HOST) {
    return env.UPSTREAM_BASE_PROD ?? DEFAULT_PROD_UPSTREAM;
  }
  if (hostname === DEFAULT_STAGE_PROXY_HOST) {
    return env.UPSTREAM_BASE_STAGE ?? env.UPSTREAM_BASE ?? DEFAULT_STAGE_UPSTREAM;
  }
  return env.UPSTREAM_BASE ?? env.UPSTREAM_BASE_STAGE ?? DEFAULT_STAGE_UPSTREAM;
}

function withCors(request: Request, response: Response, env: Env): Response {
  const headers = filteredHeaders(response.headers);
  const origin = request.headers.get('Origin');
  const allowedOrigin = origin && allowedOrigins(env).includes(origin) ? origin : null;

  if (allowedOrigin) {
    headers.set('Access-Control-Allow-Origin', allowedOrigin);
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
    headers.set('Access-Control-Max-Age', '600');
  }
  headers.append('Vary', 'Origin');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function stripUpstreamCors(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: filteredHeaders(response.headers),
  });
}

function filteredHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete('Access-Control-Allow-Origin');
  headers.delete('Access-Control-Allow-Credentials');
  headers.delete('Access-Control-Allow-Headers');
  headers.delete('Access-Control-Allow-Methods');
  headers.delete('Access-Control-Max-Age');
  return headers;
}

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS.join(','))
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
