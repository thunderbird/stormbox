import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.PLAYWRIGHT_PORT ? Number(process.env.PLAYWRIGHT_PORT) : 3000;
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `https://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.js$/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',

  use: {
    baseURL: BASE_URL,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
  ],

  // The dev container starts Vite on its own; reuse whatever is already
  // running rather than spinning up a per-test instance. Set
  // PLAYWRIGHT_NO_REUSE=1 to override.
  webServer: process.env.PLAYWRIGHT_NO_REUSE
    ? {
      command: `npm run dev -- --host 0.0.0.0 --port ${PORT}`,
      url: BASE_URL,
      reuseExistingServer: false,
      timeout: 60_000,
      ignoreHTTPSErrors: true,
    }
    : {
      command: 'true',
      url: BASE_URL,
      reuseExistingServer: true,
      timeout: 1_000,
      ignoreHTTPSErrors: true,
    },
});
