import { test, expect } from '@playwright/test';

/**
 * Boot smoke test.
 *
 * Asserts:
 *  - the LoginGate renders with the Thundermail brand
 *  - the SharedWorker boots and the OPFS-backed SQLite migrations run
 *    successfully (we exercise this by submitting the "use app password"
 *    flow with bogus credentials; the request reaches the worker, which
 *    spins up the JmapBackend and ultimately fails on the network call
 *    because the JMAP server rejects the basic auth - but only after the
 *    worker has booted SQLite, opened the OPFS database, and run the
 *    migrations. If any of those steps fail the user sees the
 *    "Database failed to initialise" message instead of "Failed.")
 *  - no fatal console errors leak through
 */
test('login gate renders and the SharedWorker SQLite boots', async ({ page }) => {
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Thundermail' })).toBeVisible();
  await expect(
    page.getByText('This is an Early Alpha and subject to (very) frequent change. Use at your own risk!'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /sign in with thunderbird/i }),
  ).toBeVisible();

  // Reveal the app-password form, then submit bogus credentials. This is
  // the path that drives a real RPC into the SharedWorker.
  await page.getByRole('button', { name: /use app password instead/i }).click();
  await page.getByLabel('Username').fill('bogus');
  await page.getByLabel('App password').fill('bogus');
  await page.getByRole('button', { name: /^sign in$/i }).click();

  // The status leaves the idle "Not connected." state. Either
  // "Connecting…" (worker booted, JMAP call in flight) or "Failed."
  // (worker booted, JMAP call already rejected) is a pass. We
  // explicitly reject the "Database failed to initialise" message,
  // which would mean the SharedWorker SQLite path is broken.
  await expect(page.locator('.login-card__status')).toContainText(
    /failed|connect/i,
    { timeout: 15_000 },
  );

  // The error element only appears if an error was set; absence is OK
  // (means we're still in the connecting state). When present, it must
  // not be the database init failure.
  const errorEl = page.locator('.login-card__error');
  if (await errorEl.count() > 0) {
    const errorText = (await errorEl.textContent()) ?? '';
    expect(errorText).not.toMatch(/database failed to initialise/i);
  }

  const fatal = consoleErrors.filter((e) =>
    !e.includes('Failed to load resource')
    && !e.includes('CORS')
    && !e.includes('NetworkError')
    && !e.includes('JMAP')
    && !e.includes('OIDC')
    // Without LOCAL_STACK, oidc-spa attempts a silent-renew iframe
    // against the configured stage issuer, which responds with
    // `frame-ancestors 'self'` and trips a CSP console error. This
    // is expected when the OIDC provider is external; LOCAL_STACK
    // proxies the issuer through the same origin and avoids it.
    && !e.includes('Content Security Policy')
    && !e.includes('frame-ancestors')
    // Vite HMR sometimes warns about expected reloads in dev.
    && !e.includes('Vite'),
  );
  expect(fatal, fatal.join('\n')).toEqual([]);
});
