import fs from 'node:fs';

import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.PLAYWRIGHT_PORT ? Number(process.env.PLAYWRIGHT_PORT) : 3000;
const LOCAL_STACK = process.env.LOCAL_STACK === '1' || process.env.LOCAL_STACK === 'true';
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `https://localhost:${PORT}`;

function stackProxyDefaults() {
  const inDocker = process.env.STORMBOX_IN_DOCKER === '1' || fs.existsSync('/.dockerenv');
  const host = inDocker ? '172.17.0.1' : '127.0.0.1';
  return {
    KEYCLOAK_PROXY: process.env.KEYCLOAK_PROXY ?? `http://${host}:8999`,
    STALWART_JMAP_PROXY: process.env.STALWART_JMAP_PROXY ?? `http://${host}:8081`,
  };
}

const stackProxies = LOCAL_STACK ? stackProxyDefaults() : {};

const localStackViteEnv = LOCAL_STACK
  ? {
      VITE_JMAP_SERVER_URL: process.env.VITE_JMAP_SERVER_URL ?? `https://localhost:${PORT}/stalwart-jmap`,
      VITE_JMAP_WS_PROXY: process.env.VITE_JMAP_WS_PROXY ?? `https://localhost:${PORT}/jmap/ws`,
      VITE_OIDC_ISSUER: process.env.VITE_OIDC_ISSUER ?? `https://localhost:${PORT}/realms/tbpro`,
      VITE_OIDC_CLIENT_ID: process.env.VITE_OIDC_CLIENT_ID ?? 'thunderbird-stormbox-test',
      VITE_LOCAL_STACK: '1',
    }
  : {};

function buildWebServer() {
  if (LOCAL_STACK) {
    return {
      command: `npm run dev -- --host 0.0.0.0 --port ${PORT}`,
      url: BASE_URL,
      reuseExistingServer: process.env.PLAYWRIGHT_REUSE === '1',
      timeout: 120_000,
      ignoreHTTPSErrors: true,
      env: {
        ...process.env,
        ...localStackViteEnv,
        ...stackProxies,
      },
    };
  }
  if (process.env.PLAYWRIGHT_NO_REUSE) {
    return {
      command: `npm run dev -- --host 0.0.0.0 --port ${PORT}`,
      url: BASE_URL,
      reuseExistingServer: false,
      timeout: 120_000,
      ignoreHTTPSErrors: true,
    };
  }
  return {
    command: 'true',
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 1_000,
    ignoreHTTPSErrors: true,
  };
}

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.js$/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: LOCAL_STACK ? 1 : undefined,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  globalSetup: LOCAL_STACK ? './tests/e2e/global-setup.js' : undefined,

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
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: LOCAL_STACK
          ? { args: ['--ignore-certificate-errors'] }
          : undefined,
      },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
  ],

  webServer: buildWebServer(),
});
