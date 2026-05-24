/**
 * Upstream routing + CORS allowlist shared by every code path in
 * `stormbox-jmap-bridge`.
 *
 * The Worker terminates on four production hostnames as Workers
 * Custom Domains:
 *
 *   wsmail.stage-thundermail.com   → handle WebSocket upgrade
 *   wsmail.thundermail.com         → handle WebSocket upgrade
 *   jmap.stage-thundermail.com     → handle HTTP /jmap/* + /.well-known/jmap
 *   jmap.thundermail.com           → handle HTTP /jmap/* + /.well-known/jmap
 *
 * The webmail SPA lives at `webmail.*.thundermail.com` and is served
 * by GitHub Pages (untouched by Cloudflare). Because the SPA and the
 * bridge are NOT same-origin, the HTTP half handles CORS itself:
 * preflights are answered directly, and `Access-Control-*` headers
 * are merged into every response. The allowlist per route is the
 * SPA's webmail origin plus localhost for vite dev hitting stage.
 */

export interface Route {
  /** Origin to forward upstream requests to. */
  upstream: string;
  /**
   * Externally-advertised origin Stalwart bakes into the JMAP
   * session document (apiUrl, uploadUrl, downloadUrl, eventSourceUrl,
   * WS capability URL). Rewritten on the response stream so the
   * SPA's subsequent calls go back through the bridge instead of
   * dereferencing the raw Stalwart hostname.
   */
  stalwartOrigin: string;
  /** Bridge origin for HTTP fields in the session document. */
  httpBridgeOrigin: string;
  /** Bridge origin for the WebSocket capability URL. */
  wsBridgeOrigin: string;
  /**
   * Origins permitted by `Access-Control-Allow-Origin`. The Worker
   * echoes back the request's `Origin` only when it is in this set;
   * otherwise CORS headers are omitted entirely (browser will
   * block the response from the JS context, which is the desired
   * behaviour for unrecognised origins).
   */
  allowedOrigins: ReadonlySet<string>;
}

const LOCAL_DEV_ORIGINS = ['https://localhost:3000', 'http://localhost:3000'];

export const STAGE_ROUTE: Route = {
  upstream: 'https://mail.stage-thundermail.com',
  stalwartOrigin: 'https://mail.stage-thundermail.com',
  httpBridgeOrigin: 'https://jmap.stage-thundermail.com',
  wsBridgeOrigin: 'wss://wsmail.stage-thundermail.com',
  allowedOrigins: new Set([
    'https://webmail.stage-thundermail.com',
    // Vite dev server with self-signed cert; lets devs run a local
    // SPA build against stage Stalwart through the bridge.
    ...LOCAL_DEV_ORIGINS,
  ]),
};

export const PROD_ROUTE: Route = {
  upstream: 'https://mail.thundermail.com',
  stalwartOrigin: 'https://mail.thundermail.com',
  httpBridgeOrigin: 'https://jmap.thundermail.com',
  wsBridgeOrigin: 'wss://wsmail.thundermail.com',
  // Prod allowlist is strict: webmail prod only.
  allowedOrigins: new Set(['https://webmail.thundermail.com']),
};

/**
 * Header that lets smoke tests against `*.workers.dev` pick the
 * prod upstream. Only honoured when the request reached the Worker
 * on a `*.workers.dev` hostname; bound production routes never
 * inspect it.
 */
export const TEST_UPSTREAM_HEADER = 'x-jmap-bridge-test-upstream';

export function selectRoute(request: Request): Route | null {
  const host = new URL(request.url).hostname;
  if (host === 'jmap.thundermail.com' || host === 'wsmail.thundermail.com') {
    return PROD_ROUTE;
  }
  if (host === 'jmap.stage-thundermail.com' || host === 'wsmail.stage-thundermail.com') {
    return STAGE_ROUTE;
  }
  if (host.endsWith('.workers.dev')) {
    const which = request.headers.get(TEST_UPSTREAM_HEADER)?.toLowerCase();
    return which === 'prod' ? PROD_ROUTE : STAGE_ROUTE;
  }
  return null;
}

export type HostKind = 'wsmail' | 'jmap' | 'workers-dev' | 'unknown';

export function classifyHost(host: string): HostKind {
  if (host.startsWith('wsmail.')) return 'wsmail';
  if (host.startsWith('jmap.')) return 'jmap';
  if (host.endsWith('.workers.dev')) return 'workers-dev';
  return 'unknown';
}
