/**
 * HTTP proxy handler — fronts Stalwart's JMAP HTTP surface on the
 * `jmap.*.thundermail.com` hostnames. The SPA at
 * `webmail.*.thundermail.com` calls this bridge cross-origin; the
 * bridge owns CORS for the allowlisted webmail (and dev) origins so
 * Stalwart's all-or-nothing CORS never reaches the browser.
 *
 * Forwards `/.well-known/jmap` and `/jmap/*` preserving method,
 * headers, and body. Rewrites the URLs Stalwart bakes into the
 * session document so every URL the SPA subsequently dereferences
 * stays inside the bridge. Rewrites absolute `Location` headers
 * for the same reason. Strips Cloudflare meta headers and `Cookie`
 * before talking to Stalwart. WebSocket upgrades are dispatched to
 * `ws.ts` before this handler runs; non-upgrade `/jmap/ws` requests
 * are rejected here so URL credentials never get proxied upstream.
 */

import type { Route } from './routes';

/**
 * Headers Cloudflare injects on inbound requests; Stalwart must not
 * see them (and a couple are sensitive).
 */
const HEADERS_TO_STRIP_BEFORE_UPSTREAM = [
  'cf-connecting-ip',
  'cf-ray',
  'cf-visitor',
  'cf-worker',
  'cf-ipcountry',
  'cf-ew-via',
  'x-real-ip',
  'x-forwarded-for',
  'x-forwarded-proto',
  // SPA session cookies must not leak to the mail server; JMAP auth
  // is Authorization-only.
  'cookie',
];

/**
 * Preflight cache lifetime. Browsers cap this (Chrome 7200s, Firefox
 * 86400s) but at one hour the cost of preflighting JMAP method calls
 * is amortised to ~one round trip per active session per method.
 */
const PREFLIGHT_MAX_AGE_SECONDS = 3600;

/**
 * Headers the SPA legitimately sets on JMAP requests. Browsers
 * compare this set against the preflight's
 * `Access-Control-Request-Headers` and fail loudly if anything is
 * missing, so be explicit rather than `*`.
 */
const ALLOWED_REQUEST_HEADERS = 'Authorization, Content-Type, Accept';

export async function handleHttpProxy(request: Request, route: Route): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
    return new Response('WebSocket upgrades must be handled by the WS bridge', { status: 426 });
  }

  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (url.pathname === '/jmap/ws') {
    const headers = corsHeadersFor(origin, route);
    return new Response('Expected Upgrade: websocket', { status: 426, headers });
  }

  // Short-circuit preflights at the edge. Stalwart's CORS is exactly
  // what we are working around; we must NOT forward OPTIONS to it.
  if (request.method === 'OPTIONS' && origin !== null) {
    return preflightResponse(origin, route);
  }

  if (!isJmapPath(url.pathname)) {
    const headers = corsHeadersFor(origin, route);
    return new Response('Only /jmap/* and /.well-known/jmap are proxied', {
      status: 404,
      headers,
    });
  }

  const upstreamUrl = new URL(url.pathname + url.search, route.upstream);
  const upstreamHeaders = new Headers(request.headers);
  for (const name of HEADERS_TO_STRIP_BEFORE_UPSTREAM) {
    upstreamHeaders.delete(name);
  }

  const upstreamResponse = await fetch(upstreamUrl.toString(), {
    method: request.method,
    headers: upstreamHeaders,
    body: methodAllowsBody(request.method) ? request.body : null,
    redirect: 'manual',
  });

  return rewriteResponse(upstreamResponse, url.pathname, route, origin);
}

function isJmapPath(pathname: string): boolean {
  return pathname === '/.well-known/jmap' || pathname.startsWith('/jmap/');
}

function methodAllowsBody(method: string): boolean {
  const upper = method.toUpperCase();
  return upper !== 'GET' && upper !== 'HEAD';
}

/**
 * Build the `Access-Control-*` headers for a request whose `Origin`
 * we recognise. Returns headers containing only `Vary: Origin` for
 * unrecognised or missing origins so we do not act as an open CORS
 * oracle, but caches still know responses key on `Origin`.
 */
function corsHeadersFor(origin: string | null, route: Route): Headers {
  const headers = new Headers();
  // Always set Vary: Origin so any cache (CF edge, browser, ALB,
  // etc.) knows the response depends on the request Origin and
  // does not serve a 403 / no-CORS body to a recognised origin
  // (or vice versa).
  headers.set('Vary', 'Origin');
  if (origin === null || !route.allowedOrigins.has(origin)) {
    return headers;
  }
  headers.set('Access-Control-Allow-Origin', origin);
  // Authorization is Bearer/Basic, not a cookie; no need to allow
  // credentials. Keeping this `false` (the default) means responses
  // are still readable to the SPA via the explicit Allow-Origin
  // echo but cookies aren't sent.
  return headers;
}

function preflightResponse(origin: string, route: Route): Response {
  const headers = corsHeadersFor(origin, route);
  if (!headers.has('Access-Control-Allow-Origin')) {
    // Unrecognised origin: no allow-* headers, browser will reject.
    return new Response(null, { status: 403, headers });
  }
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', ALLOWED_REQUEST_HEADERS);
  headers.set('Access-Control-Max-Age', String(PREFLIGHT_MAX_AGE_SECONDS));
  return new Response(null, { status: 204, headers });
}

/**
 * Strip every `Access-Control-*` header from `target` and replace
 * them with our own from `cors`. The bridge is the single source of
 * CORS truth; Stalwart-side `Access-Control-*` settings must never
 * leak through to the browser (especially the permissive `*`
 * variants stage runs with).
 */
function replaceCorsHeaders(target: Headers, cors: Headers): void {
  const toDelete: string[] = [];
  target.forEach((_, name) => {
    if (name.toLowerCase().startsWith('access-control-')) {
      toDelete.push(name);
    }
  });
  for (const name of toDelete) target.delete(name);
  for (const name of ['access-control-allow-origin', 'vary']) {
    const value = cors.get(name);
    if (value !== null) target.set(name, value);
  }
}

async function rewriteResponse(
  upstream: Response,
  requestPath: string,
  route: Route,
  origin: string | null,
): Promise<Response> {
  const rewrittenHeaders = rewriteLocationHeader(upstream.headers, route);
  replaceCorsHeaders(rewrittenHeaders, corsHeadersFor(origin, route));

  // Only the JMAP session document carries the URLs we have to
  // rewrite. Every other body is forwarded as a stream so uploads
  // and downloads (potentially many megabytes) never get buffered
  // in Worker memory.
  if (requestPath !== '/jmap/session') {
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: rewrittenHeaders,
    });
  }

  const contentType = upstream.headers.get('content-type') ?? '';
  if (!upstream.ok || !contentType.includes('application/json')) {
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: rewrittenHeaders,
    });
  }

  let session: unknown;
  try {
    session = await upstream.json();
  } catch {
    return new Response(null, {
      status: 502,
      statusText: 'Bad Gateway (session JSON parse failed)',
      headers: rewrittenHeaders,
    });
  }

  const rewritten = rewriteSessionUrls(session, route);
  const body = JSON.stringify(rewritten);
  rewrittenHeaders.set('content-type', 'application/json');
  rewrittenHeaders.delete('content-length');
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: rewrittenHeaders,
  });
}

function rewriteLocationHeader(source: Headers, route: Route): Headers {
  const headers = new Headers(source);
  const location = headers.get('location');
  if (!location) return headers;
  // Relative redirects (`/jmap/session`) are already same-origin from
  // the browser's perspective; only absolute references to the
  // Stalwart hostname leak the upstream identity.
  if (/^https?:\/\//i.test(location)) {
    const rewritten = rewriteHttpHost(location, route);
    if (rewritten !== location) headers.set('location', rewritten);
  }
  return headers;
}

/**
 * Replace Stalwart's externally-advertised host (with or without an
 * explicit `:443`) with the HTTP bridge host inside a string.
 */
export function rewriteHttpHost(value: string, route: Route): string {
  const fromWithPort = `${route.stalwartOrigin}:443`;
  // Order matters: strip the explicit-port form first so the second
  // pass doesn't leave a stray ":443" behind.
  return value
    .split(fromWithPort).join(route.httpBridgeOrigin)
    .split(route.stalwartOrigin).join(route.httpBridgeOrigin);
}

/**
 * Rewrite every advertised URL in the JMAP session document.
 *
 * HTTP URLs (apiUrl, downloadUrl, uploadUrl, eventSourceUrl, plus
 * any string fields we don't know about that happen to contain the
 * Stalwart origin) get pointed at `route.httpBridgeOrigin`. The
 * WebSocket URL inside `capabilities['urn:ietf:params:jmap:websocket']`
 * is rewritten to `route.wsBridgeOrigin` on the same jmap.* bridge
 * host so the browser upgrade uses the same public proxy URL.
 */
export function rewriteSessionUrls(session: unknown, route: Route): unknown {
  if (session === null || typeof session !== 'object') return session;

  const wsCap = 'urn:ietf:params:jmap:websocket';
  const stalwartWssWithPort = route.stalwartOrigin.replace(/^https:/i, 'wss:') + ':443';
  const stalwartWss = route.stalwartOrigin.replace(/^https:/i, 'wss:');

  function rewriteWsUrl(value: string): string {
    return value
      .split(stalwartWssWithPort).join(route.wsBridgeOrigin)
      .split(stalwartWss).join(route.wsBridgeOrigin);
  }

  function walk(node: unknown, path: string[]): unknown {
    if (node === null) return null;
    if (typeof node === 'string') {
      if (path.includes(wsCap)) {
        return rewriteWsUrl(node);
      }
      return rewriteHttpHost(node, route);
    }
    if (Array.isArray(node)) {
      return node.map((v, i) => walk(v, [...path, String(i)]));
    }
    if (typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = walk(v, [...path, k]);
      }
      return out;
    }
    return node;
  }

  return walk(session, []);
}
