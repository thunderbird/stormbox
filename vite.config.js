import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import basicSsl from "@vitejs/plugin-basic-ssl";

// Self-signed HTTPS is required so the browser treats the dev origin
// as a secure context. OPFS, SharedWorker isolation, and SubtleCrypto
// all refuse to expose themselves over plain http:// from a
// non-loopback hostname. The cert is generated on first run and cached
// under node_modules/.vite; you'll need to accept the
// "self-signed certificate" warning once per browser.
export default defineConfig({
  plugins: [vue(), basicSsl()],
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
  },
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
