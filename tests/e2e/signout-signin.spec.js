import { test, expect } from '@playwright/test';

/**
 * Reproduces the user-reported regression where Inbox fails to load
 * with "[mail-store] ensureLoaded failed" after a sign out followed
 * by a fresh sign in.
 *
 * The first login populates SQLite. Logout calls stopSyncAccount,
 * leaving the OPFS database intact. The second login creates a new
 * JmapBackend over the same SharedWorker; the mail-store auto-picks
 * Inbox, which fires ensureLoaded(0, 100). If anything in that path
 * throws (SQLite read, syncFolderWindow, etc.) we expect to see the
 * console.error from ensureLoaded's catch. This test asserts:
 *
 *   1. We can sign out and back in without an unhandled error.
 *   2. After the second login, Inbox renders at least one real row.
 *   3. No "[mail-store] ensureLoaded failed" lines appeared.
 */

const STAGE_USERNAME = process.env.STAGE_USERNAME;
const STAGE_PASSWORD = process.env.STAGE_PASSWORD;

test.skip(
  !STAGE_USERNAME || !STAGE_PASSWORD,
  'STAGE_USERNAME / STAGE_PASSWORD not set; live-stage signout/signin e2e skipped',
);

test.describe('Sign out + sign in regression', () => {
  test.setTimeout(180_000);

  test('Inbox loads cleanly on the second sign in (no ensureLoaded failures)', async ({ page }, testInfo) => {
    const ensureLoadedFailures = [];
    const consoleLines = [];
    page.on('console', (msg) => {
      const text = msg.text();
      consoleLines.push(`[${msg.type()}] ${text}`);
      if (/\[mail-store\] ensureLoaded failed/.test(text)) {
        ensureLoadedFailures.push(text);
      }
    });
    page.on('pageerror', (err) => {
      consoleLines.push(`[pageerror] ${err.message}`);
    });

    await login(page);
    await waitForInboxReady(page);

    // Sign out via the sidebar button. Wait for the LoginGate to come
    // back, signalling that auth-store cleared its state and the
    // shell unmounted.
    await page.getByRole('button', { name: /sign out/i }).click();
    await expect(page.getByRole('heading', { name: 'Thundermail' })).toBeVisible({ timeout: 15_000 });

    // From this point on, any ensureLoaded failure is interesting -
    // it would be triggered by the second login path. Clear the
    // pre-existing list so we only catch what happens next.
    ensureLoadedFailures.length = 0;

    await login(page);
    await waitForInboxReady(page);

    if (ensureLoadedFailures.length > 0) {
      await testInfo.attach('ensureLoaded-failures.txt', {
        body: ensureLoadedFailures.join('\n\n'),
        contentType: 'text/plain',
      });
      await testInfo.attach('console-tail.txt', {
        body: consoleLines.slice(-200).join('\n'),
        contentType: 'text/plain',
      });
    }
    expect(
      ensureLoadedFailures,
      `expected no ensureLoaded failures after second sign in; saw:\n${ensureLoadedFailures.join('\n')}`,
    ).toEqual([]);
  });
});

async function login(page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Thundermail' })).toBeVisible();
  await page.getByRole('button', { name: /use app password instead/i }).click();
  await page.getByLabel('Username').fill(STAGE_USERNAME);
  await page.getByLabel('App password').fill(STAGE_PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
}

async function waitForInboxReady(page) {
  await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });
  // Inbox auto-selects once the folder tree lands. Wait for the
  // highlight to settle and at least one real row to paint.
  await expect.poll(
    async () => {
      const current = page.locator('.folder-node.is-current');
      if ((await current.count()) === 0) return '';
      return ((await current.first().textContent()) ?? '').toLowerCase();
    },
    { timeout: 30_000, message: 'expected Inbox to be auto-selected' },
  ).toMatch(/inbox/);
  await expect.poll(
    async () => page.locator('.msg-list__item').count(),
    { timeout: 60_000, message: 'expected at least one Inbox row to render' },
  ).toBeGreaterThan(0);
}
