/**
 * stormbox-ws-proxy: WebSocket auth bridge for Stalwart's JMAP /jmap/ws.
 *
 * Stalwart authenticates the WebSocket upgrade via the HTTP
 * `Authorization` header, but browsers cannot set arbitrary headers
 * on `new WebSocket(url, protocols)`. The client puts the credential
 * on the upgrade URL as `?access_token=<jwt>` or `?basic=<base64>`;
 * this Worker strips it, synthesises an `Authorization` header, and
 * forwards the upgrade to Stalwart unchanged.
 *
 * Anything that is not a WebSocket upgrade request gets 426. This
 * Worker does not proxy JMAP HTTP, does not handle CORS, and does
 * not log anything; HTTP JMAP traffic is expected to talk to
 * Stalwart directly.
 *
 * Bound at wsmail.stage-thundermail.com and wsmail.thundermail.com.
 */

export interface Env {
  /** Fallback upstream Stalwart origin, kept for ad-hoc wrangler dev usage. */
  UPSTREAM_BASE?: string;
  /** Upstream Stalwart origin for wsmail.stage-thundermail.com. */
  UPSTREAM_BASE_STAGE?: string;
  /** Upstream Stalwart origin for wsmail.thundermail.com. */
  UPSTREAM_BASE_PROD?: string;
}

const DEFAULT_STAGE_PROXY_HOST = 'wsmail.stage-thundermail.com';
const DEFAULT_PROD_PROXY_HOST = 'wsmail.thundermail.com';
const DEFAULT_STAGE_UPSTREAM = 'https://mail.stage-thundermail.com';
const DEFAULT_PROD_UPSTREAM = 'https://mail.thundermail.com';

export default {
  async fetch(request: Request, env: Env, _ctx?: unknown): Promise<Response> {
    const upgrade = request.headers.get('Upgrade');
    if (upgrade?.toLowerCase() !== 'websocket') {
      return new Response(null, { status: 426 });
    }

    const upstreamBase = getUpstreamBase(new URL(request.url).hostname, env);
    return bridgeWebSocketAuth(request, upstreamBase);
  },
};

async function bridgeWebSocketAuth(request: Request, upstreamBase: string): Promise<Response> {
  const url = new URL(request.url);

  // Only /jmap/* is in scope. Anything else is almost certainly a
  // misconfiguration; reject early rather than acting as an open
  // bearer-injection proxy for the whole upstream.
  if (!url.pathname.startsWith('/jmap/')) {
    return new Response('Only /jmap/* upgrades are proxied', { status: 403 });
  }

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

function getUpstreamBase(hostname: string, env: Env): string {
  if (hostname === DEFAULT_PROD_PROXY_HOST) {
    return env.UPSTREAM_BASE_PROD ?? DEFAULT_PROD_UPSTREAM;
  }
  if (hostname === DEFAULT_STAGE_PROXY_HOST) {
    return env.UPSTREAM_BASE_STAGE ?? env.UPSTREAM_BASE ?? DEFAULT_STAGE_UPSTREAM;
  }
  return env.UPSTREAM_BASE ?? env.UPSTREAM_BASE_STAGE ?? DEFAULT_STAGE_UPSTREAM;
}
