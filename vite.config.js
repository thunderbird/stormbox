import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  base: "/",
  server: {
    host: "0.0.0.0",
    port: 3000,
    open: true,
  },
  build: {
    outDir: "dist",
    assetsDir: "assets",
    target: "esnext",
  },
  // wa-sqlite ships its own ES modules + WASM. Pre-bundling them through
  // esbuild breaks the WASM URL imports the AccessHandlePoolVFS uses, so
  // exclude them from optimizeDeps.
  optimizeDeps: {
    exclude: ["wa-sqlite"],
  },
  worker: {
    format: "es",
  },
});
