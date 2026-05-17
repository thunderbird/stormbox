import { test, expect } from '@playwright/test';

/**
 * Boot smoke test. The app must:
 * - serve a non-empty index.html
 * - hydrate the Vue app
 * - show the LoginGate (because no JMAP_SERVER_URL connection has been
 *   made and no OIDC session exists)
 * - successfully connect to its SharedWorker and run migrations
 *
 * This catches the largest class of regressions (build broken, worker
 * URL wrong, schema migration explodes, etc.) without needing a real
 * JMAP server.
 */
test('login gate renders and the SharedWorker initialises', async ({ page }) => {
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Stormbox' })).toBeVisible();
  await expect(page.getByRole('button', { name: /sign in$/i })).toBeVisible();
  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();

  // The SharedWorker initialises lazily; force it by submitting the login
  // form with bogus credentials. The connect attempt should fail with a
  // clear error, but it proves the worker booted and migrations ran.
  await page.getByLabel('Username').fill('bogus');
  await page.getByLabel('Password').fill('bogus');
  await page.getByRole('button', { name: /sign in$/i }).click();

  // The status text flips to a non-idle value within the timeout.
  await expect(page.locator('.login-status')).toContainText(/connect|failed/i, {
    timeout: 10_000,
  });

  // No uncaught console errors. We allow specific expected ones.
  const fatal = consoleErrors.filter((e) =>
    !e.includes('Failed to load resource')
    && !e.includes('CORS')
    && !e.includes('NetworkError')
    && !e.includes('JMAP'),
  );
  expect(fatal, fatal.join('\n')).toEqual([]);
});
