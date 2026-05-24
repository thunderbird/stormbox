import { test, expect } from '@playwright/test';

import {
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
  waitForPendingMutations,
} from './helpers/ui.js';

/**
 * Move via drag-and-drop (R-3.5) — Verified Consistency triple.
 *
 * Stormbox's only MVP move UI is drag-and-drop from the message list
 * onto a folder node. This spec drags a single Inbox row onto the
 * Archive folder and asserts the worker -> tab BroadcastChannel hop
 * lands the row in Archive in the UI, the local cache, and on the
 * server. (The unit tests cover the in-memory store/outbox paths but
 * not the cross-context BroadcastChannel handoff.)
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

test.describe('Move message e2e', () => {
  test.beforeEach(async () => {
    const jmap = await connectJmap();
    await sweepOrphanTestMessages(jmap, { subjectPrefix: 'Move e2e' });
  });

  test('drag-and-drop moves an Inbox row to the Archive folder', async ({ page }, testInfo) => {
    const consoleLines = [];
    trackConsole(page, consoleLines);

    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    const archive = mailboxByRole(mailboxes, 'archive');
    const trash = mailboxByRole(mailboxes, 'trash');
    if (!inbox || !archive || !trash) {
      throw new Error(
        `Test requires Inbox, Archive, and Trash mailboxes; saw ${mailboxes.map((m) => `${m.name}:${m.role}`).join(', ')}`,
      );
    }

    const fromEmail = selfEmail();
    const subject = `Move e2e ${Date.now()}`;
    let createdId = null;
    try {
      createdId = await createEmailInMailbox(jmap, {
        mailboxId: inbox.id,
        fromEmail,
        subject,
      });

      await loginViaOidc(page);
      await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });

      await clickFolder(page, inbox.name);
      const sourceRow = page.locator('.msg-list__items > li').filter({ hasText: subject }).first();
      await expect(sourceRow).toBeVisible({ timeout: 30_000 });

      const archiveFolder = page.locator('.folder-node')
        .filter({ hasText: new RegExp(`^\\s*${archive.name}`, 'i') })
        .first();
      await expect(archiveFolder).toBeVisible({ timeout: 30_000 });

      await sourceRow.dragTo(archiveFolder);

      await expect.poll(
        async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
        { timeout: 30_000, message: 'moved row should disappear from Inbox after drop' },
      ).toBe(0);

      await waitForPendingMutations(page);

      const inboxCache = await readViewCacheForFolderRole(page, 'inbox');
      expect(inboxCache.remoteIds, 'remote id should be gone from Inbox cache').not.toContain(createdId);

      // The Archive folder's query_view_items are only materialized
      // when the user navigates to it (outbox-apply marks the view
      // stale on the move, but does not eagerly fetch). Click Archive
      // so ensureFolderWindow runs and the moved row lands in the
      // cache the way the user would see it.
      await clickFolder(page, archive.name);
      await expect.poll(
        async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
        { timeout: 30_000, message: 'moved row should appear in Archive after navigation' },
      ).toBeGreaterThan(0);

      const archiveCache = await readViewCacheForFolderRole(page, 'archive');
      expect(archiveCache, 'local Archive cache should be reachable via window.__repo').not.toBeNull();
      expect(archiveCache.remoteIds, 'remote id should appear in Archive cache').toContain(createdId);

      try {
        await expect.poll(
          async () => {
            const ids = await getEmailMailboxIds(jmap, createdId);
            if (!ids) return 'missing';
            const inArchive = ids[archive.id] === true;
            const inInbox = ids[inbox.id] === true;
            if (inArchive && !inInbox) return 'archive';
            if (inInbox) return 'inbox';
            return JSON.stringify(ids);
          },
          { timeout: 30_000, message: 'server should report the message in Archive, not Inbox' },
        ).toBe('archive');
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
});
