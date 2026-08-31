import { fileURLToPath } from "node:url";

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
const devHttps = process.env.VITE_DEV_HTTPS === "1";
const publicOrigin = localStackPublicOrigin();

function appHtmlConfigPlugin() {
  return {
    name: "stormbox-html-config",
    transformIndexHtml(html) {
      return html.replaceAll("%APP_TITLE%", APP_TITLE);
    },
  };
}

// Dev serves plain http on port 3000. OPFS, SharedWorker isolation and
// SubtleCrypto need a secure context, and loopback qualifies as one, so
// http://localhost:3000 exposes them all.
//
// Reaching the dev server through one of the non-loopback `allowedHosts`
// below is not a secure context over http and those APIs disappear. Set
// VITE_DEV_HTTPS=1 for self-signed HTTPS in that case; the cert is
// generated on first run and cached under node_modules/.vite, and the
// browser asks you to accept it once.
//
// Local-stack e2e reverse-proxies Keycloak + Stalwart through the Vite
// origin (see vite.local-stack.mjs), which keeps OIDC discovery and the
// JMAP session fetch same-origin whichever scheme is in use.
export default defineConfig({
  plugins: [
    appHtmlConfigPlugin(),
    vue(),
    ...(devHttps ? [basicSsl()] : []),
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
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        pdfViewer: fileURLToPath(new URL("./pdf-viewer.html", import.meta.url)),
      },
    },
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

