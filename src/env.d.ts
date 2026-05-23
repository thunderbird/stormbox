/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
  readonly VITE_JMAP_SERVER_URL?: string;
  readonly VITE_JMAP_WS_PROXY?: string;
  readonly VITE_ACCOUNTS_URL?: string;
  readonly VITE_APPOINTMENT_URL?: string;
  readonly VITE_SEND_URL?: string;
  readonly VITE_OIDC_ISSUER?: string;
  readonly VITE_OIDC_CLIENT_ID?: string;
  readonly VITE_LOCAL_STACK?: string;
  readonly VITE_SENDER_AVATAR_PROXY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
  readonly url: string;
}
