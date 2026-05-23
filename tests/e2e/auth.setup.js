import fs from 'node:fs';
import path from 'node:path';

import { test as setup, expect } from '@playwright/test';

import { loginViaOidc } from './helpers/oidc-login.js';
import { localStackEnabled, skipLocalStackMessage } from './helpers/stack-env.js';

/**
 * One-shot OIDC login that captures the resulting Keycloak SSO cookie
 * (and any oidc-spa state stored under localStorage) into a shared
 * storageState file. Every test project depends on this setup and
 * boots its browser context with the saved state, so individual
 * tests skip the Keycloak login form entirely — Keycloak either
 * recognises the SSO cookie and returns a fresh code instantly, or
 * (when oidc-spa held tokens in localStorage) the app paints the
 * shell without any auth round trip at all.
 *
 * Re-running the suite blows the file away on the next setup run so
 * stale tokens never strand a worker behind a logged-out shell.
 */

setup.skip(!localStackEnabled, skipLocalStackMessage);

// Must match the per-browser paths declared in playwright.config.js
// for the `chromium` / `firefox` test projects.
const STORAGE_STATE_PATHS = {
  'setup-chromium': '.playwright-auth/chromium.json',
  'setup-firefox': '.playwright-auth/firefox.json',
};

setup('authenticate via OIDC once for the whole run', async ({ page }, info) => {
  const target = STORAGE_STATE_PATHS[info.project.name];
  if (!target) {
    throw new Error(
      `auth.setup.js running under unknown project "${info.project.name}"; `
      + `add a mapping to STORAGE_STATE_PATHS in tests/e2e/auth.setup.js.`,
    );
  }
  await loginViaOidc(page);
  await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await page.context().storageState({ path: target });
});
