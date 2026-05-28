import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import basicSsl from "@vitejs/plugin-basic-ssl";

import { APP_TITLE } from "./src/app-config.js";
import {
  jmapWsDevProxyPlugin,
  keycloakDevProxy,
  localStackHttpTarget,
  localStackPublicOrigin,
  senderAvatarDevProxy,
  stalwartJmapDevProxy,
} from "./vite.local-stack.mjs";

const localStack = process.env.VITE_LOCAL_STACK === "1";
const publicOrigin = localStackPublicOrigin();

function appHtmlConfigPlugin() {
  return {
    name: "stormbox-html-config",
    transformIndexHtml(html) {
      return html.replaceAll("%APP_TITLE%", APP_TITLE);
    },
  };
}

// Self-signed HTTPS is required so the browser treats the dev origin
// as a secure context. OPFS, SharedWorker isolation, and SubtleCrypto
// all refuse to expose themselves over plain http:// from a
// non-loopback hostname. The cert is generated on first run and cached
// under node_modules/.vite; you'll need to accept the
// "self-signed certificate" warning once per browser.
//
// Local-stack e2e keeps HTTPS and reverse-proxies Keycloak + Stalwart
// through the Vite origin (see vite.local-stack.mjs) so mixed-content
// rules do not block OIDC discovery or JMAP session fetch.
export default defineConfig({
  plugins: [
    appHtmlConfigPlugin(),
    vue(),
    basicSsl(),
    ...(localStack ? [jmapWsDevProxyPlugin()] : []),
  ],
  base: "/",
  server: {
    host: "0.0.0.0",
    port: 3000,
    open: false,
    // Vite 5 host-header allowlist. The EC2 instance hostname is added
    // explicitly so dev access from outside the box works without
    // tripping the cross-site-WebSocket protection.
    allowedHosts: [
      "localhost",
      "127.0.0.1",
      "sancus.thunderbird.net",
      ".thunderbird.net",
    ],
    ...(localStack
      ? {
          proxy: {
            "/realms": keycloakDevProxy(
              process.env.KEYCLOAK_PROXY ?? localStackHttpTarget(8999),
            ),
            "/resources": keycloakDevProxy(
              process.env.KEYCLOAK_PROXY ?? localStackHttpTarget(8999),
            ),
            "/stalwart-jmap": stalwartJmapDevProxy(
              process.env.STALWART_JMAP_PROXY ?? localStackHttpTarget(8081),
            ),
            "/sender-avatar": senderAvatarDevProxy(),
          },
        }
      : {}),
  },
  define: localStack
    ? {
        // Expose for debugging in the browser console during local-stack dev.
        __LOCAL_STACK_PUBLIC_ORIGIN__: JSON.stringify(publicOrigin),
      }
    : {},
  build: {
    outDir: "dist",
    assetsDir: "assets",
    target: "esnext",
  },
  // @journeyapps/wa-sqlite ships its own ES modules + WASM. Pre-bundling
  // them through esbuild breaks the WASM URL imports the VFS examples
  // use, so exclude them from optimizeDeps.
  optimizeDeps: {
    exclude: ["@journeyapps/wa-sqlite"],
  },
  worker: {
    format: "es",
  },
});

