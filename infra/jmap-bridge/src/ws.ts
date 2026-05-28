/**
 * WebSocket upgrade handler — bridges the browser's WebSocket auth
 * contract to Stalwart's JMAP /jmap/ws endpoint.
 *
 * Stalwart authenticates the WebSocket upgrade via the HTTP
 * `Authorization` header. Browsers cannot set arbitrary headers on
 * `new WebSocket(url, protocols)`, so the client puts the credential
 * on the upgrade URL as `?access_token=<jwt>` or `?basic=<base64>`;
 * this handler strips it, synthesises an `Authorization` header, and
 * forwards the upgrade to Stalwart unchanged.
 *
 * Anything that is not a WebSocket upgrade gets 426. This handler
 * does not log anything; the upgrade URL contains a credential until
 * it is stripped here.
 */

import type { Route } from './routes';

export async function handleWebSocketUpgrade(request: Request, route: Route): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response(null, { status: 426 });
  }

  const url = new URL(request.url);

  // Only `/jmap/*` is in scope. Anything else is almost certainly a
  // misconfiguration; reject early rather than acting as an open
  // bearer-injection proxy for the whole upstream.
  if (!url.pathname.startsWith('/jmap/')) {
    return new Response('Only /jmap/* upgrades are proxied', { status: 403 });
  }

  // Two supported credential carriers:
  //   ?access_token=<jwt>      -> Authorization: Bearer <jwt>    (OIDC happy path, RFC 6750 §2.3)
  //   ?basic=<base64userpass>  -> Authorization: Basic <base64>  (self-host / app-password)
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

  const upstream = new URL(url.pathname + url.search, route.upstream);
  const upstreamReq = new Request(upstream.toString(), request);
  upstreamReq.headers.set('Authorization', authHeader);
  // Stateless bearer-bridge: don't leak any client cookies that the
  // browser would otherwise send on the same-origin upgrade.
  upstreamReq.headers.delete('Cookie');

  // Cloudflare's runtime handles WebSocket upgrade passthrough when
  // we return the fetch response directly.
  return fetch(upstreamReq);
}
