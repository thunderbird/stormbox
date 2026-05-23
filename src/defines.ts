function defaultJmapProxyUrl(hostname = globalThis.location?.hostname): string {
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

export function appointmentUrlForHostname(hostname = globalThis.location?.hostname): string {
  if (hostname === "webmail.thundermail.com") {
    return "https://appointment.tb.pro";
  }
  return "https://appointment-stage.tb.pro";
}

export function sendUrlForHostname(hostname = globalThis.location?.hostname): string {
  if (hostname === "webmail.thundermail.com") {
    return "https://send.tb.pro";
  }
  return "https://send-stage.tb.pro";
}

export function senderAvatarProxyUrlForHostname(hostname = globalThis.location?.hostname): string {
  if (hostname === "webmail.thundermail.com" || hostname === "webmail.stage-thundermail.com") {
    return `${defaultJmapProxyUrl(hostname)}/sender-avatar`;
  }
  return "";
}

export const JMAP_SERVER_URL =
  import.meta.env.VITE_JMAP_SERVER_URL || defaultJmapProxyUrl();

export const ACCOUNTS_URL =
  import.meta.env.VITE_ACCOUNTS_URL || accountsUrlForHostname();

export const APPOINTMENT_URL =
  import.meta.env.VITE_APPOINTMENT_URL || appointmentUrlForHostname();

export const SEND_URL =
  import.meta.env.VITE_SEND_URL || sendUrlForHostname();

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

/**
 * Optional same-origin/edge proxy for sender domain icons. An empty
 * value disables remote logo lookups and keeps the initials fallback.
 */
export const SENDER_AVATAR_PROXY_URL =
  import.meta.env.VITE_SENDER_AVATAR_PROXY_URL ?? senderAvatarProxyUrlForHostname();
