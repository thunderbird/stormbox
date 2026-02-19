export const JMAP_SERVER_URL =
  import.meta.env.VITE_JMAP_SERVER_URL || "https://mail.stage-thundermail.com";

export const OIDC_ISSUER =
  import.meta.env.VITE_OIDC_ISSUER || "https://auth-stage.tb.pro/realms/tbpro";

export const OIDC_CLIENT_ID =
  import.meta.env.VITE_OIDC_CLIENT_ID || "thunderbird-stormbox";
