export const JMAP_SERVER_URL =
  import.meta.env.VITE_JMAP_SERVER_URL || "https://mail.stage-thundermail.com";

export const OIDC_ISSUER =
  import.meta.env.VITE_OIDC_ISSUER || "https://auth-stage.tb.pro/realms/tbpro";

export const OIDC_CLIENT_ID =
  import.meta.env.VITE_OIDC_CLIENT_ID || "bulwark-test";

/**
 * URL of the JMAP-over-WebSocket proxy. Stalwart's /jmap/ws only
 * authenticates via the HTTP Authorization header, which browsers
 * cannot set on a WebSocket upgrade. The proxy at wsmail.stage-...
 * reads the credential off the URL query string and synthesises the
 * header upstream. See stormbox/infra/ws-proxy.
 *
 * Set to an empty string to fall back to the URL Stalwart advertises
 * in the session document (and accept that the open will fail in any
 * browser).
 */
export const JMAP_WS_PROXY_URL =
  import.meta.env.VITE_JMAP_WS_PROXY ?? "https://wsmail.stage-thundermail.com/jmap/ws";
