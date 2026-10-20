import { expect } from '@playwright/test';

import {
  TEST_OIDC_EMAIL,
  TEST_OIDC_PASSWORD,
} from './stack-env.js';

const APP_ORIGIN = new URL(
  process.env.PLAYWRIGHT_BASE_URL
    ?? `http://localhost:${process.env.PLAYWRIGHT_PORT ?? 3000}`,
).origin;

/**
 * Sign in through automatic OIDC redirection or the manual entry point.
 *
 * Fast path: if the browser context already has a valid oidc-spa
 * session (typically because the project loaded a shared
 * storageState captured by tests/e2e/auth.setup.js), `page.goto('/')`
 * paints the shell directly and we return without going near
 * Keycloak. This is the common case in the e2e suite.
 *
 * Slow path: full Keycloak form fill + submit. Only used by the
 * setup spec on its first run (no cached state) and as a fallback
 * when the cached SSO cookie has expired.
 *
 * Set `navigateToApp: false` to complete a pending login on the IdP page.
 *
 * Onboarding is seeded as done: Welcome dismissed and every beacon seen.
 * `beaconsSeen: false` seeds Welcome dismissed with every beacon unseen,
 * for the beacon spec. See seedOnboarding.
 */
/**
 * A high-water mark above any beacon that will ship, so "everything seen"
 * never needs updating when beacons are added (specs/010 §3).
 */
export const ALL_BEACONS_SEEN = 1_000_000;

/**
 * Seeds the synced `onboarding` setting through the settings store's
 * pre-sign-in pending patch, which the first settings pull applies to the
 * account (specs/006 R-SET.14). It runs once per tab, so a reload keeps
 * whatever the test did since.
 */
export async function seedOnboarding(page, { beaconsSeen = true } = {}) {
  await page.addInitScript((through) => {
    if (window.sessionStorage.getItem('stormbox.e2e.onboardingSeeded')) return;
    window.sessionStorage.setItem('stormbox.e2e.onboardingSeeded', '1');
    const key = 'stormbox.settings.pending.v1';
    let pending = {};
    try {
      pending = JSON.parse(window.localStorage.getItem(key) ?? '{}') ?? {};
    } catch {
      pending = {};
    }
    pending.anonymous = { ...(pending.anonymous ?? {}), onboarding: { beaconsSeenThrough: through } };
    window.localStorage.setItem(key, JSON.stringify(pending));
  }, beaconsSeen ? ALL_BEACONS_SEEN : 0);
}

export async function loginViaOidc(page, { beaconsSeen = true, navigateToApp = true } = {}) {
  await seedOnboarding(page, { beaconsSeen });
  if (navigateToApp) await page.goto('/');
  const shell = page.locator('.shell');
  const usernameField = page.locator('input#username, input[name="username"]').first();
  // Supports deployed versions with a manual OIDC entry point.
  const manualSignIn = page.locator('.login-card__signin:enabled');
  const loginError = page.locator('.login-card__error');
  const outcome = await Promise.race([
    shell.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'shell'),
    usernameField.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'identity-provider'),
    manualSignIn.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'manual'),
    loginError.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'error'),
  ]).catch((err) => {
    throw new Error(`OIDC startup did not reach mail or sign-in within 30 s (${err?.message ?? err})`);
  });
  if (outcome === 'shell') return;
  if (outcome === 'error') {
    throw new Error(`OIDC startup failed: ${(await loginError.textContent())?.trim()}`);
  }
  if (outcome === 'manual') {
    await manualSignIn.click();
    await page.waitForURL(/\/realms\/tbpro/, { timeout: 15_000 });
  }

  if (/\/realms\/tbpro/.test(page.url())) {
    const username = page.locator('input#username, input[name="username"]').first();
    const password = page.locator('input#password, input[name="password"]').first();
    await expect(username).toBeVisible({ timeout: 10_000 });
    await username.fill(TEST_OIDC_EMAIL);
    await password.fill(TEST_OIDC_PASSWORD);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await page.waitForURL((url) => url.origin === APP_ORIGIN, { timeout: 20_000 });
  }

  await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 }).catch(async (err) => {
    const message = (await loginError.textContent().catch(() => null))?.trim();
    if (message) {
      if (/429|too many requests/i.test(message)) {
        await page.waitForTimeout(5_000);
        await page.reload();
        await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });
        return;
      }
      throw new Error(`OIDC login returned to app but connect failed: ${message}`);
    }
    throw err;
  });
}
