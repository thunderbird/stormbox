import { expect } from '@playwright/test';

import {
  TEST_OIDC_EMAIL,
  TEST_OIDC_PASSWORD,
} from './stack-env.js';

const APP_ORIGIN = new URL(
  process.env.PLAYWRIGHT_BASE_URL
    ?? `https://localhost:${process.env.PLAYWRIGHT_PORT ?? 3000}`,
).origin;

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
  await page.addInitScript(() => {
    window.localStorage.setItem('stormbox.welcomeModalDismissed.v1', '1');
  });
  await page.goto('/');
  if (await isAppShellAlreadyVisible(page)) {
    return;
  }
  await expect(page.getByRole('heading', { name: 'Thundermail' })).toBeVisible();
  // We're on the LoginGate, but storageState carried OIDC tokens
  // so oidc-spa is most likely doing a SILENT REFRESH against
  // Keycloak (the access token is short-lived, refresh token is
  // long-lived). During silent refresh:
  //   - the LoginGate is rendered with the Sign-in button DISABLED,
  //   - if refresh succeeds, the app transitions straight to .shell
  //     without the button ever being clicked,
  //   - if refresh fails (rare), the button enables and the user
  //     is expected to click it manually.
  // So we race "shell appeared" against "button became enabled"
  // and continue with whichever wins. Only the rare failure case
  // hits the form-fill flow below.
  // The LoginGate button is labelled just "Sign In"; scope by class so we
  // never race against the Keycloak page's own "Sign In" button.
  const signInBtn = page.locator('.login-card__signin');
  const shellLocator = page.locator('.shell');
  const winner = await Promise.race([
    shellLocator.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'shell'),
    expect(signInBtn).toBeEnabled({ timeout: 30_000 }).then(() => 'button'),
  ]).catch((err) => {
    throw new Error(`OIDC LoginGate stuck: neither .shell nor enabled "Sign in" button appeared within 30 s (${err?.message ?? err})`);
  });
  if (winner === 'shell') {
    // Silent refresh succeeded; nothing more to do.
    return;
  }
  // Refresh failed (or storageState is genuinely stale) — fall
  // through to form fill.
  await signInBtn.click();

  // Keycloak login is proxied at /realms/tbpro on the Vite HTTPS origin.
  await page.waitForURL(/\/realms\/tbpro/, { timeout: 15_000 });

  if (/\/realms\/tbpro/.test(page.url())) {
    const username = page.locator('input#username, input[name="username"]').first();
    const password = page.locator('input#password, input[name="password"]').first();
    await expect(username).toBeVisible({ timeout: 10_000 });
    await username.fill(TEST_OIDC_EMAIL);
    await password.fill(TEST_OIDC_PASSWORD);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await page.waitForURL((url) => url.origin === APP_ORIGIN, { timeout: 20_000 });
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
  // Generous timeout: when storageState is valid (the common case
  // every test should hit), the shell paints in under 1 s on warm
  // Stalwart but can take 2-4 s under suite load when many fresh
  // BrowserContexts have just torn down. Earlier 1.5 s was tight
  // enough that some tests fell through to the OIDC slow path
  // unnecessarily, then hit a 30 s wait for a button that would
  // never enable because storageState was actually valid. Note:
  // expect.toBeVisible resolves the moment the element appears, so
  // a generous timeout doesn't slow the warm path — it only widens
  // the window where we accept a slightly delayed paint as "still
  // valid storageState" rather than "OIDC is broken".
  try {
    await expect(page.locator('.shell')).toBeVisible({ timeout: 4_000 });
    return true;
  } catch {
    return false;
  }
}
