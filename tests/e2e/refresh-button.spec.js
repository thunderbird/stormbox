import { test, expect } from '@playwright/test';

import {
  cleanupEmail,
  connectJmap,
  createEmailInMailbox,
  listMailboxes,
  mailboxByRole,
} from './helpers/jmap-client.js';
import { loginViaOidc } from './helpers/oidc-login.js';
import {
  localStackEnabled,
  selfEmail,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import {
  attachConsoleTail,
  trackConsole,
} from './helpers/ui.js';

/**
 * Regression for the user-reported "Refresh does nothing" complaint
 * when the local SQLite cache has ghost rows (messages that exist
 * locally but not on the server).
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

test.describe('Refresh button nuke-and-rebuild', () => {
  test('clears ghost rows from Inbox and shows the spinner while running', async ({ page }, testInfo) => {
    const consoleLines = [];
    trackConsole(page, consoleLines);

    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    const trash = mailboxByRole(mailboxes, 'trash');
    if (!inbox || !trash) throw new Error('Test requires Inbox and Trash mailboxes');

    const baselineSubject = `Refresh baseline e2e ${Date.now()}`;
    let baselineId = null;
    try {
      baselineId = await createEmailInMailbox(jmap, {
        mailboxId: inbox.id,
        fromEmail: selfEmail(),
        subject: baselineSubject,
      });

      await loginViaOidc(page);
      await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });
      await expect.poll(
        async () => ((await page.locator('.folder-node.is-current').first().textContent()) ?? '').toLowerCase(),
        { timeout: 30_000, message: 'expected Inbox to be auto-selected' },
      ).toMatch(/inbox/);
      await page.locator('.msg-list__refresh').click();
      await expect.poll(
        async () => page.locator('.msg-list__item').filter({ hasText: baselineSubject }).count(),
        { timeout: 30_000, message: 'baseline Inbox row should be visible before injecting ghost row' },
      ).toBeGreaterThan(0);

      const ghostSubject = `Ghost refresh e2e ${Date.now()}`;
      const ghostRemoteId = `ghost-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      await page.evaluate(async ({ subject, remoteId }) => {
        const accounts = await globalThis.__repo.listAccounts();
        const account = accounts[0];
        const folders = await globalThis.__repo.listFolders(account.id);
        const inbox = folders.find((f) => f.role === 'inbox');
        await globalThis.__repo.ensureFolderWindow(account.id, inbox.id, { offset: 0, limit: 100 });
        const view = await globalThis.__repo.call('db.query', {
          sql: `SELECT id FROM query_views
                  WHERE account_id = ? AND folder_id = ?
                    AND view_type = 'mailbox-window'
                  LIMIT 1`,
          params: [account.id, inbox.id],
        });
        if (view?.[0]?.id == null) throw new Error('no query_view for Inbox');
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

      // The ghost is written directly to the local repository to
      // reproduce a persisted cache corruption. Reloading makes the
      // message list consume that persisted state through the normal
      // startup path instead of depending on a test-only broadcast.
      await page.reload();
      await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });
      await expect.poll(
        async () => ((await page.locator('.folder-node.is-current').first().textContent()) ?? '').toLowerCase(),
        { timeout: 30_000, message: 'expected Inbox to be selected after reload' },
      ).toMatch(/inbox/);

      await expect.poll(
        async () => page.locator('.msg-list__item').filter({ hasText: ghostSubject }).count(),
        { timeout: 30_000, message: 'ghost row should be visible before refresh' },
      ).toBeGreaterThan(0);
      await page.locator('.msg-list__item').filter({ hasText: baselineSubject }).first().click();
      await expect(page.locator('.message-view__title h2')).toHaveText(baselineSubject, { timeout: 30_000 });

      // Resolve as soon as we observe the spinner class (or after a
      // short ceiling). The previous 5 s sleep was always paid even
      // on the happy path; the spinner appears within ms of the
      // click for a healthy refresh.
      const sawSpinner = page.evaluate(async () => {
        const btn = document.querySelector('.msg-list__refresh svg');
        if (!btn) return false;
        if (btn.classList.contains('is-spinning')) return true;
        return await new Promise((resolve) => {
          const observer = new MutationObserver(() => {
            if (btn.classList.contains('is-spinning')) {
              observer.disconnect();
              resolve(true);
            }
          });
          observer.observe(btn, { attributes: true, attributeFilter: ['class'] });
          setTimeout(() => {
            observer.disconnect();
            resolve(btn.classList.contains('is-spinning'));
          }, 1500);
        });
      });

      await page.locator('.msg-list__refresh').click();
      const spinnerSeen = await sawSpinner;
      expect(spinnerSeen, 'refresh button should spin while loading').toBe(true);

      await expect.poll(
        async () => page.locator('.msg-list__item').filter({ hasText: ghostSubject }).count(),
        { timeout: 30_000, message: 'ghost row should be gone after refresh' },
      ).toBe(0);

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
        await attachConsoleTail(testInfo, consoleLines);
      }
      expect(cacheRemoteIds).not.toContain(ghostRemoteId);
      await expect(page.locator('.message-view__title h2')).toHaveText(baselineSubject, { timeout: 30_000 });
      await expect(page.locator('.msg-list__items > li.is-focused .msg-list__subject')).toHaveText(baselineSubject);
    } finally {
      if (baselineId) await cleanupEmail(jmap, baselineId, trash.id);
    }
  });
});
