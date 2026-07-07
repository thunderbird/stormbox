import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  // services-ui ships a nested node_modules/vue; without dedupe, its
  // components load a second Vue runtime under vitest and slot rendering
  // crashes ("Cannot read properties of null (reading 'ce')"). Inlining the
  // package makes its imports go through this resolver so dedupe applies.
  resolve: {
    dedupe: ["vue"],
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.js", "tests/unit/**/*.test.ts"],
    globals: false,
    server: {
      deps: {
        inline: ["@journeyapps/wa-sqlite", "@thunderbirdops/services-ui"],
      },
    },
  },
  optimizeDeps: {
    exclude: ["@journeyapps/wa-sqlite"],
  },
});
