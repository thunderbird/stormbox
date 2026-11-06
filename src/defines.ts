/** Hosted SPA origin that staff sign-ins on production are sent to. */
export const STAFF_APP_HOSTNAME = "alpha-app.thundermail.com";

/**
 * Hosted SPA hostnames that talk to the production backends.
 * `alpha-app` is the auto-deployed main build with production settings.
 */
export const PROD_WEBMAIL_HOSTNAMES: readonly string[] = Object.freeze([
  "webmail.thundermail.com",
  STAFF_APP_HOSTNAME,
]);

export function isProdWebmailHostname(hostname = globalThis.location?.hostname): boolean {
  return hostname != null && PROD_WEBMAIL_HOSTNAMES.includes(hostname);
}

export function defaultJmapServerUrl(hostname = globalThis.location?.hostname): string {
  if (isProdWebmailHostname(hostname)) {
    return "https://mail.thundermail.com";
  }
  return "https://mail.stage-thundermail.com";
}

export function defaultJmapWsProxyUrl(hostname = globalThis.location?.hostname): string {
  return jmapWsProxyUrlForServer(defaultJmapServerUrl(hostname));
}

/** Stable hosted account keys preserve cached mail and pending mutations. */
export function jmapAccountOriginForServer(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.origin === "https://mail.thundermail.com") {
    url.hostname = "jmap.thundermail.com";
  } else if (url.origin === "https://mail.stage-thundermail.com") {
    url.hostname = "jmap.stage-thundermail.com";
  }
  return url.origin;
}

export function jmapWsProxyUrlForServer(serverUrl: string): string {
  const url = new URL(jmapAccountOriginForServer(serverUrl));
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.username = "";
  url.password = "";
  url.pathname = "/jmap/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function accountsUrlForHostname(hostname = globalThis.location?.hostname): string {
  if (isProdWebmailHostname(hostname)) {
    return "https://accounts.tb.pro";
  }
  return "https://accounts.stage-thundermail.com";
}

export function appointmentUrlForHostname(hostname = globalThis.location?.hostname): string {
  if (isProdWebmailHostname(hostname)) {
    return "https://appointment.tb.pro";
  }
  return "https://appointment-stage.tb.pro";
}

export function sendUrlForHostname(hostname = globalThis.location?.hostname): string {
  if (isProdWebmailHostname(hostname)) {
    return "https://send.tb.pro";
  }
  return "https://send-stage.tb.pro";
}

export function senderAvatarProxyUrlForHostname(hostname = globalThis.location?.hostname): string {
  if (isProdWebmailHostname(hostname) || hostname === "webmail.stage-thundermail.com") {
    return "https://avatars.thunderbird.net";
  }
  return "";
}

/**
 * Origin staff-flagged sign-ins are redirected to. Only the production
 * webmail host redirects; an empty string disables the redirect (dev,
 * stage, and alpha-app itself).
 */
export function staffAppUrlForHostname(hostname = globalThis.location?.hostname): string {
  if (hostname === "webmail.thundermail.com") {
    return `https://${STAFF_APP_HOSTNAME}`;
  }
  return "";
}

export const BUG_REPORT_URL = "https://github.com/thunderbird/stormbox/issues";

export const FEEDBACK_URL = "https://ideas.tb.pro/";

export const SUPPORT_URL = "https://accounts.tb.pro/contact";

export const JMAP_SERVER_URL =
  import.meta.env.VITE_JMAP_SERVER_URL || defaultJmapServerUrl();

export const ACCOUNTS_URL =
  import.meta.env.VITE_ACCOUNTS_URL || accountsUrlForHostname();

export const APPOINTMENT_URL =
  import.meta.env.VITE_APPOINTMENT_URL || appointmentUrlForHostname();

export const SEND_URL =
  import.meta.env.VITE_SEND_URL || sendUrlForHostname();

/**
 * Where staff sign-ins are sent instead of connecting on this origin.
 * Empty disables the redirect.
 */
export const STAFF_APP_URL =
  import.meta.env.VITE_STAFF_APP_URL ?? staffAppUrlForHostname();

export const OIDC_ISSUER =
  import.meta.env.VITE_OIDC_ISSUER || "https://auth.stage-thundermail.com/realms/tbpro";

export const OIDC_CLIENT_ID =
  import.meta.env.VITE_OIDC_CLIENT_ID || "thunderbird-stormbox-test";

/**
 * The hosted mail servers use their jmap.* WebSocket auth bridges.
 * Local and custom servers default to /jmap/ws on the server origin.
 * An explicit override can select a separately hosted auth bridge.
 */
export const JMAP_WS_PROXY_URL =
  import.meta.env.VITE_JMAP_WS_PROXY_URL ?? jmapWsProxyUrlForServer(JMAP_SERVER_URL);

/**
 * Optional same-origin/edge proxy for sender domain icons. An empty
 * value disables remote logo lookups and keeps the initials fallback.
 */
export const SENDER_AVATAR_PROXY_URL =
  import.meta.env.VITE_SENDER_AVATAR_PROXY_URL ?? senderAvatarProxyUrlForHostname();
