import { test, expect } from '@playwright/test';

import {
  classifyMailboxState,
  cleanupEmail,
  connectJmap,
  createEmailInMailbox,
  getEmailMailboxIds,
  listMailboxes,
  mailboxByRole,
  sweepOrphanTestMessages,
} from './helpers/jmap-client.js';
import { loginViaOidc } from './helpers/oidc-login.js';
import {
  localStackEnabled,
  selfEmail,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import {
  attachConsoleTail,
  clickFolder,
  readRecentMutations,
  readViewCacheForFolderRole,
  trackConsole,
} from './helpers/ui.js';

/**
 * Regression for "multi-select bulk delete leaves rows visible in the
 * local list" — the user-reported Firefox bug where the JMAP round
 * trip succeeded but the Inbox list never re-rendered to drop the
 * deleted rows.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

test.describe('Bulk delete e2e', () => {
  test.setTimeout(180_000);

  test.beforeEach(async () => {
    const jmap = await connectJmap();
    await sweepOrphanTestMessages(jmap);
  });

  test('multi-select delete drops every row from the Inbox list (UI + cache)', async ({ page }, testInfo) => {
    const consoleLines = [];
    trackConsole(page, consoleLines);

    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    const trash = mailboxByRole(mailboxes, 'trash');
    if (!inbox || !trash) {
      throw new Error(`Test requires Inbox and Trash mailboxes; saw ${mailboxes.map((m) => `${m.name}:${m.role}`).join(', ')}`);
    }
    const fromEmail = selfEmail();

    const stamp = Date.now();
    const subjects = [
      `Delete e2e bulk ${stamp} a`,
      `Delete e2e bulk ${stamp} b`,
      `Delete e2e bulk ${stamp} c`,
    ];
    const createdIds = [];
    try {
      for (const subject of subjects) {
        const id = await createEmailInMailbox(jmap, {
          mailboxId: inbox.id,
          fromEmail,
          subject,
        });
        createdIds.push(id);
      }

      await loginViaOidc(page);
      await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });

      await clickFolder(page, inbox.name);
      for (const subject of subjects) {
        await expect.poll(
          async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
          { timeout: 60_000, message: `expected test message "${subject}" to render in Inbox` },
        ).toBeGreaterThan(0);
      }

      for (const subject of subjects) {
        const row = page.locator('.msg-list__items > li')
          .filter({ hasText: subject })
          .first();
        await row.locator('.msg-list__check input').click();
      }
      await expect(page.locator('.msg-list__count'))
        .toHaveText(/^3 selected/, { timeout: 5_000 });

      await page.locator('.message-view__bulk-actions [title="Delete"]').click();

      for (const subject of subjects) {
        await expect.poll(
          async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
          { timeout: 30_000, message: `deleted bulk row "${subject}" should disappear from Inbox` },
        ).toBe(0);
      }

      const inboxCache = await readViewCacheForFolderRole(page, 'inbox');
      expect(inboxCache, 'local Inbox cache should be reachable via window.__repo').not.toBeNull();
      for (const remoteId of createdIds) {
        expect(
          inboxCache.remoteIds,
          `remote id ${remoteId} should be gone from the Inbox cache`,
        ).not.toContain(remoteId);
      }

      for (const remoteId of createdIds) {
        try {
          await expect.poll(
            async () => classifyMailboxState(
              await getEmailMailboxIds(jmap, remoteId),
              { source: inbox, trash },
            ),
            {
              timeout: 60_000,
              message: `server should report ${remoteId} in Trash, not Inbox`,
            },
          ).toBe('trash');
        } catch (err) {
          const mutationRows = await readRecentMutations(page);
          await testInfo.attach('recent-mutations.json', {
            body: JSON.stringify(mutationRows, null, 2),
            contentType: 'application/json',
          });
          throw err;
        }
      }
    } finally {
      await attachConsoleTail(testInfo, consoleLines);
      for (const id of createdIds) {
        await cleanupEmail(jmap, id, trash.id);
      }
    }
  });
});
