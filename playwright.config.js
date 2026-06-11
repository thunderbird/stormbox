import fs from 'node:fs';

import { defineConfig, devices } from '@playwright/test';

import { loadE2eEnvFile } from './tests/e2e/helpers/env-file.js';

const rawRemoteE2e = process.env.REMOTE_E2E === '1' || process.env.REMOTE_E2E === 'true';
loadE2eEnvFile({ remote: rawRemoteE2e });

const PORT = process.env.PLAYWRIGHT_PORT ? Number(process.env.PLAYWRIGHT_PORT) : 3000;
const LOCAL_STACK = process.env.LOCAL_STACK === '1' || process.env.LOCAL_STACK === 'true';
const REMOTE_E2E = process.env.REMOTE_E2E === '1' || process.env.REMOTE_E2E === 'true';
const LIVE_E2E = LOCAL_STACK || REMOTE_E2E;

function requiredRemoteEnv(name) {
  const value = process.env[name];
  if (REMOTE_E2E && !value) {
    throw new Error(`REMOTE_E2E requires ${name} to be set`);
  }
  return value;
}

const BASE_URL = REMOTE_E2E
  ? requiredRemoteEnv('PLAYWRIGHT_BASE_URL')
  : process.env.PLAYWRIGHT_BASE_URL ?? `https://localhost:${PORT}`;

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
      // Default to reusing an already-running vite under LOCAL_STACK so
      // iterative local runs skip the ~5s vite boot. Opt out with
      // PLAYWRIGHT_NO_REUSE=1 if you suspect a stale dev server.
      reuseExistingServer: process.env.PLAYWRIGHT_NO_REUSE !== '1',
      timeout: 60_000,
      ignoreHTTPSErrors: true,
      env: {
        ...process.env,
        ...localStackViteEnv,
        ...stackProxies,
      },
    };
  }
  if (REMOTE_E2E) {
    return {
      command: 'true',
      url: BASE_URL,
      reuseExistingServer: true,
      timeout: 10_000,
      ignoreHTTPSErrors: true,
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

// Firefox is the default live-e2e lane because the suite has
// historically uncovered more Firefox-only regressions than
// Chromium-only ones. Set INCLUDE_CHROMIUM=1 to also run the chromium
// lane (e.g. for pre-merge / nightly), or pass --project=chromium
// explicitly to run chromium only.
const INCLUDE_CHROMIUM =
  process.env.INCLUDE_CHROMIUM === '1' || process.env.INCLUDE_CHROMIUM === 'true';

function projects() {
  if (!LIVE_E2E) {
    return [
      { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
      { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    ];
  }
  const chromiumSetupUse = {
    ...devices['Desktop Chrome'],
    launchOptions: { args: ['--ignore-certificate-errors'] },
  };
  // Firefox throttles JS in background/unfocused tabs by default
  // (setTimeout clamped to 1 s, microtask budget reduced). Playwright
  // doesn't always keep its windows in OS foreground when other
  // apps are active, so the test page can land in throttled mode
  // mid-test — observed as 30 s+ delays between StateChange WS
  // delivery and the corresponding UI re-render. These prefs disable
  // the throttling for the test browser only; production Firefox
  // continues to throttle as designed.
  const firefoxNoThrottle = {
    'dom.min_background_timeout_value': 4,
    'dom.timeout.background_throttling_max_budget': -1,
    'dom.timeout.background_budget_regeneration_rate': -1,
    'dom.timeout.foreground_throttling_max_budget': -1,
  };
  const firefoxSetupUse = {
    ...devices['Desktop Firefox'],
    launchOptions: { firefoxUserPrefs: firefoxNoThrottle },
  };

  // Setup projects capture a shared OIDC session per browser so the
  // dependent test projects boot already authenticated. Each setup
  // project writes its own storageState file (see auth.setup.js
  // which keys off project.name); chromium and firefox sessions
  // don't stomp on each other.
  //
  // Both browser projects (when INCLUDE_CHROMIUM=1) run serially
  // under workers: 1 because the single shared mail account can't
  // tolerate parallel mutation. The per-test speedup comes
  // from storageState (Keycloak login skipped, ~3-5s per test),
  // not from worker parallelism.
  const firefoxProjects = [
    {
      name: 'setup-firefox',
      testMatch: /auth\.setup\.js/,
      use: firefoxSetupUse,
    },
    {
      name: 'firefox',
      testMatch: /\.spec\.js$/,
      dependencies: ['setup-firefox'],
      use: { ...firefoxSetupUse, storageState: STORAGE_STATE_FIREFOX },
    },
  ];
  if (!INCLUDE_CHROMIUM) {
    return firefoxProjects;
  }
  return [
    {
      name: 'setup-chromium',
      testMatch: /auth\.setup\.js/,
      use: chromiumSetupUse,
    },
    {
      name: 'chromium',
      testMatch: /\.spec\.js$/,
      dependencies: ['setup-chromium'],
      use: { ...chromiumSetupUse, storageState: STORAGE_STATE_CHROMIUM },
    },
    ...firefoxProjects,
  ];
}

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*(\.spec\.js|\.setup\.js)$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // One worker so specs do not parallel-mutate the single shared
  // mail account. Two browser projects under INCLUDE_CHROMIUM=1
  // would race on the same mailbox; lifting workers to 2 needs a
  // second Thundermail principal first. The per-test speedup comes
  // from storageState (Keycloak login skipped), not from worker
  // parallelism.
  workers: LIVE_E2E ? 1 : undefined,
  forbidOnly: !!process.env.CI,
  // One retry covers the occasional Keycloak SSO blip; real
  // regressions fail twice in a row.
  retries: LIVE_E2E ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  globalSetup: LIVE_E2E ? './tests/e2e/global-setup.js' : undefined,

  use: {
    baseURL: BASE_URL,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: projects(),

  webServer: buildWebServer(),
});
