import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.js", "tests/unit/**/*.test.ts"],
    globals: false,
    server: {
      deps: {
        inline: ["wa-sqlite"],
      },
    },
  },
  optimizeDeps: {
    exclude: ["wa-sqlite"],
  },
});
