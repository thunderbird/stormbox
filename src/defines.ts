function defaultJmapProxyUrl(): string {
  const hostname = globalThis.location?.hostname;
  if (hostname === "webmail.thundermail.com") {
    return "https://wsmail.thundermail.com";
  }
  return "https://wsmail.stage-thundermail.com";
}

export function accountsUrlForHostname(hostname = globalThis.location?.hostname): string {
  if (hostname === "webmail.thundermail.com") {
    return "https://accounts.tb.pro";
  }
  return "https://accounts-stage.tb.pro";
}

export const JMAP_SERVER_URL =
  import.meta.env.VITE_JMAP_SERVER_URL || defaultJmapProxyUrl();

export const ACCOUNTS_URL =
  import.meta.env.VITE_ACCOUNTS_URL || accountsUrlForHostname();

export const OIDC_ISSUER =
  import.meta.env.VITE_OIDC_ISSUER || "https://auth-stage.tb.pro/realms/tbpro";

export const OIDC_CLIENT_ID =
  import.meta.env.VITE_OIDC_CLIENT_ID || "thunderbird-stormbox-test";

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
  import.meta.env.VITE_JMAP_WS_PROXY ?? `${defaultJmapProxyUrl()}/jmap/ws`;
