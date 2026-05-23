import { expect } from '@playwright/test';

import {
  TEST_OIDC_EMAIL,
  TEST_OIDC_PASSWORD,
} from './stack-env.js';

/**
 * Sign in via OIDC ("Sign in with Thunderbird" → Keycloak tbpro theme).
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
 */
export async function loginViaOidc(page) {
  await page.goto('/');
  if (await isAppShellAlreadyVisible(page)) {
    return;
  }
  await expect(page.getByRole('heading', { name: 'Thundermail' })).toBeVisible();
  await page.getByRole('button', { name: /sign in with thunderbird/i }).click();

  // Keycloak login is proxied at /realms/tbpro on the Vite HTTPS origin.
  await page.waitForURL(/\/realms\/tbpro/, { timeout: 15_000 });

  if (/\/realms\/tbpro/.test(page.url())) {
    const username = page.locator('input#username, input[name="username"]').first();
    const password = page.locator('input#password, input[name="password"]').first();
    await expect(username).toBeVisible({ timeout: 10_000 });
    await username.fill(TEST_OIDC_EMAIL);
    await password.fill(TEST_OIDC_PASSWORD);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await page.waitForURL(/localhost:3000/, { timeout: 20_000 });
  }

  const loginError = page.locator('.login-card__error');
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

async function isAppShellAlreadyVisible(page) {
  try {
    await expect(page.locator('.shell')).toBeVisible({ timeout: 1_500 });
    return true;
  } catch {
    return false;
  }
}
