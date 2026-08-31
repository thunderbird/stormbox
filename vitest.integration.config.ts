import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    globals: false,
    fileParallelism: false,
    maxWorkers: 1,
    sequence: {
      concurrent: false,
    },
    globalSetup: ['./tests/integration/global-setup.mjs'],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
