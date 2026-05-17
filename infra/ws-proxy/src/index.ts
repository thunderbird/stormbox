/**
 * stormbox-ws-proxy: a Cloudflare Worker that authenticates browser
 * WebSocket upgrades to Stalwart's JMAP endpoint.
 *
 * Why this exists:
 *
 *   Stalwart's /jmap/ws handler (RFC 8887, JMAP-over-WebSocket) only
 *   accepts authentication via the HTTP `Authorization` header on the
 *   upgrade request. Browsers cannot set arbitrary headers on
 *   `new WebSocket(url, protocols)`, so a browser-only client has no
 *   way to attach a bearer token to that handshake. The result is the
 *   server rejects the upgrade and the browser never gets a usable
 *   socket.
 *
 *   Until Stalwart accepts an upstream patch for RFC 6750 §2.3
 *   (access_token query parameter) on /jmap/ws, this worker provides
 *   the same effect at the edge: the client puts ?access_token=<jwt>
 *   on the WebSocket URL; this worker reads it, strips it from the
 *   forwarded URL, sets `Authorization: Bearer <jwt>` on the upstream
 *   request, and passes the upgrade through unchanged. Stalwart sees
 *   a normal authenticated request.
 *
 *   The token is only ever transmitted inside the encrypted TLS
 *   payload of the upgrade request (one request per connection
 *   lifetime), is stripped before it reaches Stalwart, and is excluded
 *   from the worker's own access logs by default.
 *
 * Deploy:  wrangler deploy   (see ../README.md)
 * Bound at: wsmail.stage-thundermail.com (custom domain on Workers)
 */

export interface Env {
  /** Upstream Stalwart origin, e.g. https://mail.stage-thundermail.com */
  UPSTREAM_BASE: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const upgrade = request.headers.get('Upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

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

    const upstream = new URL(url.pathname + url.search, env.UPSTREAM_BASE);
    const upstreamReq = new Request(upstream.toString(), request);
    upstreamReq.headers.set('Authorization', authHeader);
    // Stateless bearer-bridge: don't leak any client cookies that the
    // browser would otherwise send on the same-origin upgrade.
    upstreamReq.headers.delete('Cookie');

    // Cloudflare's runtime handles WebSocket upgrade passthrough when
    // we return the fetch response directly.
    return fetch(upstreamReq);
  },
};
