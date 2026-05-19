import { test, expect } from '@playwright/test';

/**
 * Regression for the user-reported "Refresh does nothing" complaint
 * when the local SQLite cache has ghost rows (messages that exist
 * locally but not on the server).
 *
 * We deliberately desync the cache by injecting a row into
 * query_view_items + messages for a remote_id Stalwart has never
 * heard of, then click the refresh button. The button must nuke the
 * local view and re-paint from the server's authoritative state, so
 * the ghost disappears.
 *
 * Both Chromium and Firefox run by default.
 */

const STAGE_USERNAME = process.env.STAGE_USERNAME;
const STAGE_PASSWORD = process.env.STAGE_PASSWORD;

test.skip(
  !STAGE_USERNAME || !STAGE_PASSWORD,
  'STAGE_USERNAME / STAGE_PASSWORD not set; live-stage refresh e2e skipped',
);

test.describe('Refresh button nuke-and-rebuild', () => {
  test.setTimeout(180_000);

  test('clears ghost rows from Inbox and shows the spinner while running', async ({ page }, testInfo) => {
    const consoleLines = [];
    page.on('console', (msg) => {
      consoleLines.push(`[${msg.type()}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      consoleLines.push(`[pageerror] ${err.message}`);
    });

    await login(page);
    await waitForInboxReady(page);

    const ghostSubject = `Ghost refresh e2e ${Date.now()}`;
    const ghostRemoteId = `ghost-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Inject a ghost row directly into SQLite by calling the worker
    // RPCs through window.__repo. Bypasses JMAP entirely so the
    // server never sees this remote_id. upsertMessages broadcasts
    // MESSAGES afterwards, which triggers the mail-store's
    // onTablesTouched -> refreshLoadedPages, so the ghost will
    // surface in the UI without a page reload.
    await page.evaluate(async ({ subject, remoteId }) => {
      const accounts = await globalThis.__repo.listAccounts();
      const account = accounts[0];
      const folders = await globalThis.__repo.listFolders(account.id);
      const inbox = folders.find((f) => f.role === 'inbox');
      const view = await globalThis.__repo.call('db.query', {
        sql: `SELECT id FROM query_views
                WHERE account_id = ? AND folder_id = ?
                  AND view_type = 'mailbox-window'
                LIMIT 1`,
        params: [account.id, inbox.id],
      });
      if (view?.[0]?.id == null) throw new Error('no query_view for Inbox');
      // Shift existing positions up by 1 and insert the ghost at
      // position 0. Done first so when MESSAGES broadcasts from the
      // upsertMessages below, refreshLoadedPages reads the new view.
      await globalThis.__repo.call('db.transaction', {
        statements: [
          {
            sql: `UPDATE query_view_items SET position = -position - 1 WHERE view_id = ?`,
            params: [view[0].id],
          },
          {
            sql: `INSERT INTO query_view_items(view_id, position, message_id, remote_id)
                  VALUES (?, 0, NULL, ?)`,
            params: [view[0].id, remoteId],
          },
          {
            sql: `UPDATE query_view_items SET position = -position WHERE view_id = ? AND position < 0`,
            params: [view[0].id],
          },
          {
            sql: `UPDATE query_views SET total = COALESCE(total, 0) + 1 WHERE id = ?`,
            params: [view[0].id],
          },
        ],
      });
      // upsertMessages broadcasts TABLE_FAMILIES.MESSAGES which
      // triggers mail-store.refreshLoadedPages. Without this, the
      // mail-store would keep its in-memory state and never re-JOIN
      // the new query_view_items entry against the new messages row.
      await globalThis.__repo.upsertMessages(account.id, [{
        remoteId,
        subject,
        fromText: 'ghost@example.com',
        toText: 'me@example.com',
        receivedAt: Date.now(),
        sentAt: Date.now(),
        metadataFetchedAt: Date.now(),
        keywordsJson: '{}',
        keywords: [],
        addresses: [],
      }]);
    }, { subject: ghostSubject, remoteId: ghostRemoteId });

    // Sanity: the ghost row appears in the UI via the broadcast-driven
    // refresh, no manual page reload needed.
    await expect.poll(
      async () => page.locator('.msg-list__item').filter({ hasText: ghostSubject }).count(),
      { timeout: 30_000, message: 'ghost row should be visible before refresh' },
    ).toBeGreaterThan(0);

    // Set up a probe that captures whether the toolbar spinner was
    // visible at any point during the refresh. The button itself
    // gates on mailStore.isLoading via .is-spinning.
    const sawSpinner = page.evaluate(async () => {
      const btn = document.querySelector('.msg-list__refresh svg');
      if (!btn) return false;
      let seen = false;
      const observer = new MutationObserver(() => {
        if (btn.classList.contains('is-spinning')) seen = true;
      });
      observer.observe(btn, { attributes: true, attributeFilter: ['class'] });
      // Resolve after 5 seconds; refresh should have completed by then.
      await new Promise((r) => setTimeout(r, 5000));
      observer.disconnect();
      return seen || btn.classList.contains('is-spinning');
    });

    await page.locator('.msg-list__refresh').click();
    const spinnerSeen = await sawSpinner;
    expect(spinnerSeen, 'refresh button should spin while loading').toBe(true);

    // After refresh: the ghost must be gone from the rendered list.
    await expect.poll(
      async () => page.locator('.msg-list__item').filter({ hasText: ghostSubject }).count(),
      { timeout: 30_000, message: 'ghost row should be gone after refresh' },
    ).toBe(0);

    // And gone from the SQLite cache too, not just hidden.
    const cacheRemoteIds = await page.evaluate(async () => {
      const accounts = await globalThis.__repo.listAccounts();
      const account = accounts[0];
      const folders = await globalThis.__repo.listFolders(account.id);
      const inbox = folders.find((f) => f.role === 'inbox');
      const rows = await globalThis.__repo.listMessagesForView({
        accountId: account.id,
        folderId: inbox.id,
        sort: 'received',
        offset: 0,
        limit: 200,
      });
      return rows.map((r) => r.remote_id);
    });

    if (cacheRemoteIds.includes(ghostRemoteId)) {
      await testInfo.attach('console-tail.txt', {
        body: consoleLines.slice(-200).join('\n'),
        contentType: 'text/plain',
      });
    }
    expect(cacheRemoteIds).not.toContain(ghostRemoteId);
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
