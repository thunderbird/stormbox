import { test, expect } from '@playwright/test';

import {
  TEST_OIDC_EMAIL,
  TEST_OIDC_PASSWORD,
  localStackEnabled,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import { REMEMBER_ME_SESSION_LIFETIME_SECONDS } from '../fixtures/configure-keycloak.mjs';

/**
 * "Keep me signed in" across browser restarts (#62).
 *
 * A restart is simulated by rehydrating a fresh browser context from
 * a storageState stripped of session cookies: persistent cookies
 * (Keycloak's remember-me identity cookie) and localStorage survive a
 * real quit + relaunch, session cookies do not. With the remember-me
 * lifespans configured by tests/fixtures/configure-keycloak.mjs, a
 * login with the checkbox ticked must silently restore into the
 * shell, and one without it must land back on the LoginGate.
 *
 * Both specs bypass the shared auth.setup storageState and perform a
 * full Keycloak form login in a pristine context, so they neither
 * depend on nor disturb the SSO session the rest of the suite reuses.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

const APP_ORIGIN = new URL(
  process.env.PLAYWRIGHT_BASE_URL
    ?? `https://localhost:${process.env.PLAYWRIGHT_PORT ?? 3000}`,
).origin;
const REMEMBER_ME_COOKIE_NAME = 'KEYCLOAK_IDENTITY';
const COOKIE_EXPIRY_TOLERANCE_SECONDS = 5 * 60;

function dismissWelcomeModal(pageOrContext) {
  return pageOrContext.addInitScript(() => {
    try {
      window.localStorage.setItem('stormbox.welcomeModalDismissed.v1', '1');
    } catch {
      // A new context first runs init scripts in an opaque blank page.
    }
  });
}

async function signInThroughKeycloak(page, { rememberMe }) {
  await dismissWelcomeModal(page);
  await page.goto('/');
  const signInBtn = page.locator('.login-card__signin');
  await expect(signInBtn).toBeEnabled({ timeout: 30_000 });
  await signInBtn.click();

  await page.waitForURL(/\/realms\/tbpro/, { timeout: 15_000 });
  const username = page.locator('input#username, input[name="username"]').first();
  await expect(username).toBeVisible({ timeout: 10_000 });
  await username.fill(TEST_OIDC_EMAIL);
  await page.locator('input#password, input[name="password"]').first().fill(TEST_OIDC_PASSWORD);

  if (rememberMe) {
    // Keycloak only starts a remember-me session for a form field
    // literally named rememberMe. Assert that contract so a theme
    // regression cannot silently turn this coverage into a skip.
    const rememberMeInput = page.locator('input[name="rememberMe"]');
    await expect(
      rememberMeInput,
      'tbpro theme must post the rememberMe field required by Keycloak',
    ).toHaveCount(1);
    const themedLabel = page.locator(
      'label:has([data-testid="remember-me-input"])',
    );
    // tbpro renders the input screen-reader-only inside a styled
    // label that toggles on click; standard Keycloak themes render a
    // plain visible checkbox. Click the label when present.
    if ((await themedLabel.count()) > 0) {
      await themedLabel.click();
    } else {
      await rememberMeInput.check();
    }
    await expect(rememberMeInput).toBeChecked();
  }

  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.waitForURL((url) => url.origin === APP_ORIGIN, { timeout: 20_000 });
  await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });
}

/**
 * What a browser keeps after quit + relaunch. Playwright marks
 * session cookies with expires === -1; anything with a real expiry
 * is persistent.
 */
function stripSessionCookies(storageState) {
  return {
    ...storageState,
    cookies: storageState.cookies.filter((cookie) => cookie.expires !== -1),
  };
}

function expectRememberMeCookieLifetime(storageState) {
  const identityCookie = storageState.cookies.find(
    (cookie) => cookie.name === REMEMBER_ME_COOKIE_NAME,
  );
  expect(
    identityCookie,
    `expected persistent ${REMEMBER_ME_COOKIE_NAME} after a remember-me login`,
  ).toBeDefined();

  const remainingLifetime = identityCookie.expires - (Date.now() / 1000);
  expect(
    remainingLifetime,
    'expected the Keycloak remember-me identity cookie to retain the configured 90-day lifetime',
  ).toBeGreaterThanOrEqual(
    REMEMBER_ME_SESSION_LIFETIME_SECONDS - COOKIE_EXPIRY_TOLERANCE_SECONDS,
  );
  expect(remainingLifetime).toBeLessThanOrEqual(
    REMEMBER_ME_SESSION_LIFETIME_SECONDS + COOKIE_EXPIRY_TOLERANCE_SECONDS,
  );
}

async function openBrowserContext(
  browser,
  storageState = { cookies: [], origins: [] },
) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    storageState,
  });
  await dismissWelcomeModal(context);
  const page = await context.newPage();
  return { context, page };
}

async function captureRestartState(browser, { rememberMe }) {
  const { context, page } = await openBrowserContext(browser);
  try {
    await signInThroughKeycloak(page, { rememberMe });
    return stripSessionCookies(await context.storageState());
  } finally {
    // A browser restart closes the original shared worker and OPFS connection.
    await context.close();
  }
}

test.describe('Keep me signed in across browser restarts', () => {
  test('remember-me session silently restores after a simulated restart', async ({ browser }) => {
    const restartState = await captureRestartState(browser, { rememberMe: true });
    // A plain Keycloak session can also leave short-lived persistent
    // cookies. Pin the remember-me identity cookie itself to the realm
    // policy so the standard 10-hour fallback cannot satisfy this test.
    expectRememberMeCookieLifetime(restartState);

    const { context, page: restartedPage } = await openBrowserContext(browser, restartState);
    try {
      await restartedPage.goto(`${APP_ORIGIN}/`);
      // oidc-spa restores the session silently against the proxied
      // realm; the shell must appear without the Keycloak login form.
      await expect(restartedPage.locator('.shell')).toBeVisible({ timeout: 30_000 });
      expect(new URL(restartedPage.url()).origin).toBe(APP_ORIGIN);
    } finally {
      await context.close();
    }
  });

  test('session without remember-me requires signing in again after a restart', async ({ browser }) => {
    const restartState = await captureRestartState(browser, { rememberMe: false });

    const { context, page: restartedPage } = await openBrowserContext(browser, restartState);
    try {
      await restartedPage.goto(`${APP_ORIGIN}/`);
      // With the session-scoped SSO cookie gone, restoration fails and
      // the LoginGate settles with an enabled Sign In button.
      await expect(restartedPage.getByRole('heading', { name: 'Thundermail' })).toBeVisible({ timeout: 30_000 });
      await expect(restartedPage.locator('.login-card__signin')).toBeEnabled({ timeout: 30_000 });
      await expect(restartedPage.locator('.shell')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
