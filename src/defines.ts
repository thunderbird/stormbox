export function defaultJmapServerUrl(hostname = globalThis.location?.hostname): string {
  if (hostname === "webmail.thundermail.com") {
    return "https://jmap.thundermail.com";
  }
  return "https://jmap.stage-thundermail.com";
}

export function defaultJmapWsProxyUrl(hostname = globalThis.location?.hostname): string {
  return jmapWsProxyUrlForServer(defaultJmapServerUrl(hostname));
}

export function jmapWsProxyUrlForServer(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.username = "";
  url.password = "";
  url.pathname = "/jmap/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
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
    return "https://avatars.thunderbird.net";
  }
  return "";
}

export const BUG_REPORT_URL = "https://github.com/thunderbird/stormbox/issues";

export const FEEDBACK_URL = "https://ideas.tb.pro/";

export const JMAP_SERVER_URL =
  import.meta.env.VITE_JMAP_SERVER_URL || defaultJmapServerUrl();

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
 * URL of the JMAP-over-WebSocket auth bridge. It is derived from the
 * same public bridge origin as JMAP HTTP, with /jmap/ws on the WS
 * scheme. The bridge reads the credential off the URL query string
 * and synthesises the Authorization header upstream.
 */
export const JMAP_WS_PROXY_URL = jmapWsProxyUrlForServer(JMAP_SERVER_URL);

/**
 * Optional same-origin/edge proxy for sender domain icons. An empty
 * value disables remote logo lookups and keeps the initials fallback.
 */
export const SENDER_AVATAR_PROXY_URL =
  import.meta.env.VITE_SENDER_AVATAR_PROXY_URL ?? senderAvatarProxyUrlForHostname();
