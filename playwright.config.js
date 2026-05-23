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
      VITE_SENDER_AVATAR_PROXY_URL: process.env.VITE_SENDER_AVATAR_PROXY_URL ?? `https://localhost:${PORT}/sender-avatar`,
      VITE_LOCAL_STACK: '1',
    }
  : {};

function buildWebServer() {
  if (LOCAL_STACK) {
    return {
      command: `npm run dev -- --host 0.0.0.0 --port ${PORT}`,
      url: BASE_URL,
      reuseExistingServer: process.env.PLAYWRIGHT_REUSE === '1',
      timeout: 60_000,
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
      timeout: 60_000,
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

// Per-browser OIDC storage state captured by tests/e2e/auth.setup.js.
// We split chromium / firefox because oidc-spa's localStorage layout
// can encode browser-specific quirks even though Keycloak's SSO
// cookies are themselves engine-agnostic.
const STORAGE_STATE_CHROMIUM = '.playwright-auth/chromium.json';
const STORAGE_STATE_FIREFOX = '.playwright-auth/firefox.json';

function localStackProjects() {
  if (!LOCAL_STACK) {
    return [
      { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
      { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    ];
  }
  const chromiumSetupUse = {
    ...devices['Desktop Chrome'],
    launchOptions: { args: ['--ignore-certificate-errors'] },
  };
  const firefoxSetupUse = { ...devices['Desktop Firefox'] };
  return [
    // Setup projects capture a shared OIDC session per browser so the
    // dependent test projects boot already authenticated. Each setup
    // project writes its own storageState file (see auth.setup.js
    // which keys off project.name); chromium and firefox sessions
    // don't stomp on each other.
    {
      name: 'setup-chromium',
      testMatch: /auth\.setup\.js/,
      use: chromiumSetupUse,
    },
    {
      name: 'setup-firefox',
      testMatch: /auth\.setup\.js/,
      use: firefoxSetupUse,
    },
    // All specs run serially within each browser project (the single
    // Stalwart account makes parallel mutation tests race), but the
    // two browser projects can run side-by-side under workers: 2.
    // The big per-test speedup comes from storageState: every test
    // boots already signed in to Keycloak (~3-5s saved per test).
    {
      name: 'chromium',
      testMatch: /\.spec\.js$/,
      dependencies: ['setup-chromium'],
      use: { ...chromiumSetupUse, storageState: STORAGE_STATE_CHROMIUM },
    },
    {
      name: 'firefox',
      testMatch: /\.spec\.js$/,
      dependencies: ['setup-firefox'],
      use: { ...firefoxSetupUse, storageState: STORAGE_STATE_FIREFOX },
    },
  ];
}

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*(\.spec\.js|\.setup\.js)$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // One worker so chromium and firefox specs do not parallel-mutate
  // the single shared Stalwart account. The per-test speedup comes
  // from storageState (Keycloak login skipped), not from worker
  // parallelism. With one shared mailbox the only safe way to
  // parallelize would be one Stalwart account per worker, which is a
  // bigger fixture change.
  workers: LOCAL_STACK ? 1 : undefined,
  forbidOnly: !!process.env.CI,
  // One retry covers the occasional Keycloak SSO blip; real
  // regressions fail twice in a row.
  retries: LOCAL_STACK ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  globalSetup: LOCAL_STACK ? './tests/e2e/global-setup.js' : undefined,

  use: {
    baseURL: BASE_URL,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: localStackProjects(),

  webServer: buildWebServer(),
});
