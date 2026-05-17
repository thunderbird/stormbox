import { test, expect } from '@playwright/test';

/**
 * End-to-end test against a running Stalwart instance. Skipped unless
 * STALWART_HOST is set in the environment so the smoke suite stays
 * fast in default CI runs.
 *
 * Bootstrap (from the dev container):
 *   docker compose -f tests/fixtures/stalwart/docker-compose.yml up -d
 *   bash tests/fixtures/stalwart/seed.sh
 *   STALWART_HOST=http://localhost:18080 npx playwright test
 */
const STALWART_HOST = process.env.STALWART_HOST;
const TEST_EMAIL = process.env.TEST_EMAIL ?? 'admin';
const TEST_PASS = process.env.TEST_PASS ?? 'admin-pass-test';

test.skip(!STALWART_HOST, 'STALWART_HOST not set; skipping live-Stalwart e2e');

test.describe('Stalwart e2e', () => {
  test('user signs in, folder tree appears', async ({ page }) => {
    // The default JMAP_SERVER_URL baked into the bundle points at the
    // production endpoint. Override it via the Vite env at runtime so
    // the app talks to our local Stalwart instance.
    await page.addInitScript((host) => {
      window.__STORMBOX_JMAP_OVERRIDE__ = host;
    }, STALWART_HOST);

    await page.goto('/');

    await page.getByLabel('Username').fill(TEST_EMAIL);
    await page.getByLabel('Password').fill(TEST_PASS);
    await page.getByRole('button', { name: /sign in$/i }).click();

    // After successful sign-in, the LoginGate is gone and the shell
    // appears with at least the Inbox folder.
    await expect(page.locator('.shell')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /^Inbox/i })).toBeVisible({
      timeout: 15_000,
    });
  });
});
