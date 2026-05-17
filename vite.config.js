import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
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
