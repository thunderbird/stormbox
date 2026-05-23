import { test, expect } from '@playwright/test';

import {
  classifyMailboxState,
  cleanupEmail,
  connectJmap,
  createDraft,
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

test.skip(!localStackEnabled, skipLocalStackMessage);

test.describe('Delete message e2e', () => {
  test.beforeEach(async () => {
    const jmap = await connectJmap();
    await sweepOrphanTestMessages(jmap);
  });

  test('delete moves a real server-side draft to Trash', async ({ page }, testInfo) => {
    const consoleLines = [];
    trackConsole(page, consoleLines);

    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const drafts = mailboxByRole(mailboxes, 'drafts');
    const trash = mailboxByRole(mailboxes, 'trash');
    if (!drafts || !trash) {
      throw new Error(`Test requires Drafts and Trash mailboxes; saw ${mailboxes.map((m) => `${m.name}:${m.role}`).join(', ')}`);
    }

    const fromEmail = selfEmail();
    const subject = `Delete e2e ${Date.now()}`;
    let createdId = null;
    try {
      createdId = await createDraft(jmap, {
        draftsId: drafts.id,
        fromEmail,
        subject,
      });

      await expect.poll(
        async () => classifyMailboxState(await getEmailMailboxIds(jmap, createdId), { source: drafts, trash }),
        { timeout: 30_000, message: 'created test message should start in Drafts' },
      ).toBe('source');

      await loginViaOidc(page);
      await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });

      await clickFolder(page, drafts.name);
      await expect.poll(
        async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
        { timeout: 30_000, message: `expected test draft "${subject}" to render in Drafts` },
      ).toBeGreaterThan(0);

      await page.locator('.msg-list__item').filter({ hasText: subject }).first().click();
      await expect(page.locator('.message-view__title h2')).toHaveText(subject, { timeout: 30_000 });

      await page.getByTitle('Delete').click();

      await expect.poll(
        async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
        { timeout: 30_000, message: 'deleted draft should disappear from the Drafts list' },
      ).toBe(0);

      const draftsCache = await readViewCacheForFolderRole(page, 'drafts');
      expect(draftsCache, 'local Drafts cache should be reachable via window.__repo').not.toBeNull();
      expect(draftsCache.remoteIds, 'remote id should be gone from Drafts cache').not.toContain(createdId);

      try {
        await expect.poll(
          async () => classifyMailboxState(await getEmailMailboxIds(jmap, createdId), { source: drafts, trash }),
          { timeout: 30_000, message: 'server should report the deleted message in Trash, not Drafts' },
        ).toBe('trash');
      } catch (err) {
        const mutationRows = await readRecentMutations(page);
        await testInfo.attach('recent-mutations.json', {
          body: JSON.stringify(mutationRows, null, 2),
          contentType: 'application/json',
        });
        throw err;
      }
    } finally {
      await attachConsoleTail(testInfo, consoleLines);
      if (createdId) {
        await cleanupEmail(jmap, createdId, trash.id);
      }
    }
  });

  test('delete moves a real server-side Inbox message to Trash', async ({ page }, testInfo) => {
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
    const subject = `Delete inbox e2e ${Date.now()}`;
    let inboxMessageId = null;
    try {
      inboxMessageId = await createEmailInMailbox(jmap, {
        mailboxId: inbox.id,
        fromEmail,
        subject,
      });
      await expect.poll(
        async () => classifyMailboxState(await getEmailMailboxIds(jmap, inboxMessageId), {
          source: inbox,
          trash,
        }),
        { timeout: 30_000, message: 'created test message should start in Inbox' },
      ).toBe('source');

      await loginViaOidc(page);
      await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });

      await clickFolder(page, inbox.name);
      await expect.poll(
        async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
        { timeout: 30_000, message: `expected test message "${subject}" to render in Inbox` },
      ).toBeGreaterThan(0);

      await page.locator('.msg-list__item').filter({ hasText: subject }).first().click();
      await expect(page.locator('.message-view__title h2')).toHaveText(subject, { timeout: 30_000 });

      await page.getByTitle('Delete').click();

      await expect.poll(
        async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
        { timeout: 30_000, message: 'deleted message should disappear from the Inbox list' },
      ).toBe(0);

      const inboxCache = await readViewCacheForFolderRole(page, 'inbox');
      expect(inboxCache, 'local Inbox cache should be reachable via window.__repo').not.toBeNull();
      expect(inboxCache.remoteIds, 'remote id should be gone from Inbox cache').not.toContain(inboxMessageId);

      try {
        await expect.poll(
          async () => classifyMailboxState(await getEmailMailboxIds(jmap, inboxMessageId), {
            source: inbox,
            trash,
          }),
          { timeout: 30_000, message: 'server should report the deleted Inbox message in Trash, not Inbox' },
        ).toBe('trash');
      } catch (err) {
        const mutationRows = await readRecentMutations(page);
        await testInfo.attach('recent-mutations.json', {
          body: JSON.stringify(mutationRows, null, 2),
          contentType: 'application/json',
        });
        throw err;
      }
    } finally {
      await attachConsoleTail(testInfo, consoleLines);
      if (inboxMessageId) {
        await cleanupEmail(jmap, inboxMessageId, trash.id);
      }
    }
  });
});
