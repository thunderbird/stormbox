/**
 * stormbox-jmap-bridge: single Cloudflare Worker that fronts both
 * halves of Stormbox's JMAP transport on dedicated bridge hostnames.
 *
 *   wsmail.*.thundermail.com  → WebSocket upgrade auth bridge
 *                                (credential-on-URL → Authorization)
 *   jmap.*.thundermail.com    → HTTP /jmap/* + /.well-known/jmap
 *                                proxy with first-party CORS so the
 *                                SPA at webmail.* can call it
 *                                cross-origin
 *
 * The two halves share the same Cloudflare account, the same trust
 * boundary, the same observability-off requirement (Authorization
 * material flows on every request), and the same upstream selection
 * by hostname. Keeping them as one Worker keeps the auth-fronting
 * layer in a single auditable place — one wrangler.toml, one set of
 * routes, one set of strip-cookie / disable-logging knobs to verify.
 *
 * Dispatch is by hostname, not by request inspection: a request to
 * `wsmail.*` only ever reaches the WS bridge, and a request to
 * `jmap.*` only ever reaches the HTTP proxy. The code paths never
 * share request handling. `*.workers.dev` is supported as a test
 * mode and dispatches by the presence of the `Upgrade` header so
 * smoke tests can exercise either path from one deployment.
 *
 * What this Worker does NOT do:
 *   - It is not same-origin with the SPA. The HTTP half handles
 *     CORS itself (preflight short-circuit + Allow-Origin echo for
 *     allowlisted origins). The SPA at webmail.* stays untouched on
 *     GitHub Pages.
 *   - No logging. Observability is disabled in wrangler.toml so the
 *     bearer-bearing WebSocket upgrade URLs and the Authorization-
 *     bearing HTTP requests never land in Cloudflare Logs.
 *   - No caching. Streaming passthrough except for the small session
 *     document, which is parsed only to rewrite URLs back at us.
 *   - No credentials of its own. Auth is whatever the client sent.
 */

import { classifyHost, selectRoute } from './routes';
import { handleWebSocketUpgrade } from './ws';
import { handleHttpProxy } from './http';

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = selectRoute(request);
    if (!route) {
      return new Response('Unknown host', { status: 404 });
    }

    const isUpgrade = request.headers.get('upgrade')?.toLowerCase() === 'websocket';

    switch (classifyHost(url.hostname)) {
      case 'wsmail':
        // wsmail.* is WS-only by design. The handler itself rejects
        // non-upgrade requests with 426.
        return handleWebSocketUpgrade(request, route);
      case 'jmap':
        // jmap.* is HTTP-only. The handler rejects upgrades as
        // defense in depth; in practice Cloudflare strips Upgrade on
        // HTTP/2 so this only fires on HTTP/1.1 clients.
        return handleHttpProxy(request, route);
      case 'workers-dev':
        // Test mode: pick by request shape so one deployment can be
        // exercised from curl with or without --http1.1 and Upgrade.
        return isUpgrade
          ? handleWebSocketUpgrade(request, route)
          : handleHttpProxy(request, route);
      default:
        return new Response('Unknown host', { status: 404 });
    }
  },
};
