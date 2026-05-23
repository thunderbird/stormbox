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
  /** Enables the sender avatar proxy route when set to "1" or "true". */
  SENDER_AVATAR_PROXY_ENABLED?: string;
  /** Fixed upstream base for sender avatars. Only https://geticon.dev is allowed in v1. */
  SENDER_AVATAR_UPSTREAM_BASE?: string;
  /** Fixed fallback upstream base. Only https://www.google.com is allowed in v1. */
  SENDER_AVATAR_FALLBACK_UPSTREAM_BASE?: string;
  /** Browser and edge cache TTL for successful sender avatar responses. */
  SENDER_AVATAR_CACHE_TTL_SECONDS?: string;
}

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

type CacheStorageWithDefault = CacheStorage & {
  default: Cache;
};

const DEFAULT_STAGE_PROXY_HOST = 'wsmail.stage-thundermail.com';
const DEFAULT_PROD_PROXY_HOST = 'wsmail.thundermail.com';
const DEFAULT_STAGE_UPSTREAM = 'https://mail.stage-thundermail.com';
const DEFAULT_PROD_UPSTREAM = 'https://mail.thundermail.com';
const DEFAULT_ALLOWED_ORIGINS = [
  'https://webmail.stage-thundermail.com',
  'https://webmail.thundermail.com',
];
const SENDER_AVATAR_PATH_PREFIX = '/sender-avatar/';
const DEFAULT_SENDER_AVATAR_UPSTREAM_BASE = 'https://geticon.dev/';
const DEFAULT_SENDER_AVATAR_FALLBACK_UPSTREAM_BASE = 'https://www.google.com/';
const DEFAULT_SENDER_AVATAR_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_SENDER_AVATAR_BYTES = 256 * 1024;
const EMPTY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"></svg>';
const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IMAGE_CONTENT_TYPES = [
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
];

export default {
  async fetch(request: Request, env: Env, ctx: WorkerExecutionContext): Promise<Response> {
    const requestUrl = new URL(request.url);
    const upstreamBase = getUpstreamBase(requestUrl.hostname, env);

    if (request.method === 'OPTIONS') {
      return handlePreflight(request, env);
    }

    const upgrade = request.headers.get('Upgrade');
    if (upgrade?.toLowerCase() === 'websocket') {
      return proxyWebSocket(request, upstreamBase);
    }

    if (isSenderAvatarPath(requestUrl.pathname)) {
      return proxySenderAvatar(request, env, ctx);
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

async function proxySenderAvatar(request: Request, env: Env, ctx: WorkerExecutionContext): Promise<Response> {
  if (!senderAvatarProxyEnabled(env)) {
    return withCors(request, senderAvatarEmptyResponse(404), env);
  }
  if (!['GET', 'HEAD'].includes(request.method)) {
    return withCors(request, senderAvatarEmptyResponse(405), env);
  }

  const requestUrl = new URL(request.url);
  const domain = senderAvatarDomainFromPath(requestUrl.pathname);
  if (!domain) {
    return withCors(request, senderAvatarEmptyResponse(400), env);
  }

  const upstreamBase = senderAvatarUpstreamBase(env);
  if (!upstreamBase) {
    return withCors(request, senderAvatarEmptyResponse(503), env);
  }
  const fallbackUpstreamBase = senderAvatarFallbackUpstreamBase(env);

  const cacheKeyUrl = new URL(`${SENDER_AVATAR_PATH_PREFIX}${domain}`, requestUrl.origin);
  const cacheVersion = requestUrl.searchParams.get('v');
  if (cacheVersion) cacheKeyUrl.searchParams.set('v', cacheVersion);
  const cacheKey = new Request(cacheKeyUrl.toString(), {
    method: 'GET',
  });
  if (request.method === 'GET') {
    const cached = await defaultCache().match(cacheKey);
    if (cached) return withCors(request, cached, env);
  }

  const metadata = request.method === 'GET'
    ? await fetchSenderAvatarMetadata(senderAvatarMetadataUrl(upstreamBase, domain))
    : null;
  let response = senderAvatarEmptyResponse(404);
  if (metadata?.type !== 'avatar') {
    response = senderAvatarResponse(
      await fetchSenderAvatar(senderAvatarProviderUrl(upstreamBase, domain), request.method),
      senderAvatarCacheTtl(env),
    );
  }
  if ((!response.ok || metadata?.type === 'avatar') && fallbackUpstreamBase) {
    response = senderAvatarResponse(
      await fetchSenderAvatar(senderAvatarFallbackProviderUrl(fallbackUpstreamBase, domain), request.method),
      senderAvatarCacheTtl(env),
    );
  }
  if (request.method === 'GET' && response.ok) {
    ctx.waitUntil(defaultCache().put(cacheKey, response.clone()));
  }
  return withCors(request, response, env);
}

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
  if (
    !isHttpJmapPath(requestUrl.pathname)
    && !requestUrl.pathname.startsWith('/jmap/')
    && !isSenderAvatarPath(requestUrl.pathname)
  ) {
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

function isSenderAvatarPath(pathname: string): boolean {
  return pathname.startsWith(SENDER_AVATAR_PATH_PREFIX);
}

function senderAvatarDomainFromPath(pathname: string): string {
  const encoded = pathname.slice(SENDER_AVATAR_PATH_PREFIX.length);
  if (!encoded || encoded.includes('/')) return '';
  try {
    return normalizeDomain(decodeURIComponent(encoded));
  } catch {
    return '';
  }
}

function normalizeDomain(value: string): string {
  const raw = value.trim().toLowerCase().replace(/\.+$/, '');
  if (!raw || raw.length > 253) return '';
  if (/[\s/:?#@\\[\]]/.test(raw)) return '';

  let hostname = '';
  try {
    hostname = new URL(`https://${raw}`).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return '';
  }

  if (!hostname || hostname === 'localhost' || !hostname.includes('.') || isIpv4Address(hostname)) {
    return '';
  }
  const labels = hostname.split('.');
  if (labels.some((label) => !DOMAIN_LABEL_RE.test(label))) return '';
  return hostname;
}

function isIpv4Address(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function senderAvatarProxyEnabled(env: Env): boolean {
  const value = env.SENDER_AVATAR_PROXY_ENABLED?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

function senderAvatarUpstreamBase(env: Env): string {
  const raw = env.SENDER_AVATAR_UPSTREAM_BASE ?? DEFAULT_SENDER_AVATAR_UPSTREAM_BASE;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (url.origin !== 'https://geticon.dev') return '';
  return 'https://geticon.dev/';
}

function senderAvatarFallbackUpstreamBase(env: Env): string {
  const raw = env.SENDER_AVATAR_FALLBACK_UPSTREAM_BASE
    ?? DEFAULT_SENDER_AVATAR_FALLBACK_UPSTREAM_BASE;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (url.origin !== 'https://www.google.com') return '';
  return 'https://www.google.com/';
}

function senderAvatarProviderUrl(upstreamBase: string, domain: string): string {
  const upstreamUrl = new URL(upstreamBase);
  upstreamUrl.searchParams.set('url', domain);
  return upstreamUrl.toString();
}

function senderAvatarMetadataUrl(upstreamBase: string, domain: string): string {
  const upstreamUrl = new URL(upstreamBase);
  upstreamUrl.searchParams.set('url', domain);
  upstreamUrl.searchParams.set('format', 'json');
  return upstreamUrl.toString();
}

function senderAvatarFallbackProviderUrl(upstreamBase: string, domain: string): string {
  const upstreamUrl = new URL('/s2/favicons', upstreamBase);
  upstreamUrl.searchParams.set('domain', domain);
  upstreamUrl.searchParams.set('sz', '64');
  return upstreamUrl.toString();
}

async function fetchSenderAvatar(url: string, method: string): Promise<Response> {
  try {
    return await fetch(new Request(url, {
      method,
      redirect: 'follow',
      headers: {
        Accept: IMAGE_CONTENT_TYPES.join(', '),
        'User-Agent': 'StormboxSenderAvatarProxy/1.0',
      },
    }));
  } catch {
    return senderAvatarEmptyResponse(502);
  }
}

async function fetchSenderAvatarMetadata(url: string): Promise<{ type?: string } | null> {
  try {
    const response = await fetch(new Request(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'StormboxSenderAvatarProxy/1.0',
      },
    }));
    if (!response.ok) return null;
    const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? '';
    if (!contentType.includes('json')) return null;
    return await response.json() as { type?: string };
  } catch {
    return null;
  }
}

function senderAvatarCacheTtl(env: Env): number {
  const parsed = Number(env.SENDER_AVATAR_CACHE_TTL_SECONDS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SENDER_AVATAR_CACHE_TTL_SECONDS;
  return Math.min(Math.floor(parsed), 30 * 24 * 60 * 60);
}

function senderAvatarResponse(upstreamRes: Response, cacheTtl: number): Response {
  if (!upstreamRes.ok) {
    return senderAvatarEmptyResponse(404, 'public, max-age=3600');
  }

  const contentType = upstreamRes.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  const contentLength = Number(upstreamRes.headers.get('Content-Length') ?? '0');
  if (!IMAGE_CONTENT_TYPES.includes(contentType)) {
    return senderAvatarEmptyResponse(404, 'public, max-age=3600');
  }
  if (Number.isFinite(contentLength) && contentLength > MAX_SENDER_AVATAR_BYTES) {
    return senderAvatarEmptyResponse(404, 'public, max-age=3600');
  }

  const headers = new Headers();
  headers.set('Content-Type', contentType);
  headers.set('Cache-Control', `public, max-age=${cacheTtl}, s-maxage=${cacheTtl}`);
  const etag = upstreamRes.headers.get('ETag');
  if (etag) headers.set('ETag', etag);
  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers,
  });
}

function senderAvatarEmptyResponse(status = 404, cacheControl = 'no-store'): Response {
  return new Response(EMPTY_SVG, {
    status,
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': cacheControl,
    },
  });
}

function defaultCache(): Cache {
  return (caches as CacheStorageWithDefault).default;
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
