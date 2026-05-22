import { expect } from '@playwright/test';

import {
  TEST_OIDC_EMAIL,
  TEST_OIDC_PASSWORD,
} from './stack-env.js';

/**
 * Sign in via OIDC ("Sign in with Thunderbird" → Keycloak tbpro theme).
 */
export async function loginViaOidc(page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Thundermail' })).toBeVisible();
  await page.getByRole('button', { name: /sign in with thunderbird/i }).click();

  // Keycloak login is proxied at /realms/tbpro on the Vite HTTPS origin.
  await page.waitForURL(/\/realms\/tbpro/, { timeout: 30_000 });

  if (/\/realms\/tbpro/.test(page.url())) {
    const username = page.locator('input#username, input[name="username"]').first();
    const password = page.locator('input#password, input[name="password"]').first();
    await expect(username).toBeVisible({ timeout: 15_000 });
    await username.fill(TEST_OIDC_EMAIL);
    await password.fill(TEST_OIDC_PASSWORD);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await page.waitForURL(/localhost:3000/, { timeout: 60_000 });
  }

  const loginError = page.locator('.login-card__error');
  await expect(page.locator('.shell')).toBeVisible({ timeout: 90_000 }).catch(async (err) => {
    const message = (await loginError.textContent().catch(() => null))?.trim();
    if (message) {
      if (/429|too many requests/i.test(message)) {
        await page.waitForTimeout(5_000);
        await page.reload();
        await expect(page.locator('.shell')).toBeVisible({ timeout: 90_000 });
        return;
      }
      throw new Error(`OIDC login returned to app but connect failed: ${message}`);
    }
    throw err;
  });
}
