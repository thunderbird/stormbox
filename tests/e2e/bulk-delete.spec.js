import {
  classifyMailboxState,
  cleanupEmail,
  connectJmap,
  createEmailInMailbox,
  getEmailMailboxIds,
  listMailboxes,
  mailboxByRole,
} from './helpers/jmap-client.js';
import {
  attachConsoleTail,
  consoleLinesFor,
  expect,
  resetSharedSession,
  test,
} from './helpers/shared-session.js';
import {
  localStackEnabled,
  selfEmail,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import {
  expectRowSoon,
  readRecentMutations,
  readViewCacheForFolderRole,
  waitForPendingMutations,
} from './helpers/ui.js';

/**
 * Regression for "multi-select bulk delete leaves rows visible in the
 * local list" — the user-reported Firefox bug where the JMAP round
 * trip succeeded but the Inbox list never re-rendered to drop the
 * deleted rows.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

test.describe('Bulk delete e2e', () => {
  test.beforeEach(async ({ sharedPage }) => {
    await resetSharedSession(sharedPage);
  });

  test('multi-select delete drops every row from the Inbox list (UI + cache)', async ({ sharedPage: page }, testInfo) => {
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
    const initialViewport = page.viewportSize();
    try {
      await page.setViewportSize({ width: 1100, height: 800 });
      for (const subject of subjects) {
        const id = await createEmailInMailbox(jmap, {
          mailboxId: inbox.id,
          fromEmail,
          subject,
        });
        createdIds.push(id);
      }

      for (const subject of subjects) {
        await expectRowSoon(page, subject);
      }

      await page.locator('.msg-list__item').filter({ hasText: subjects[0] })
        .locator('.msg-list__content').click();
      await expect(page.locator('.message-view__article')).toBeVisible();
      await expect(page.locator('.msg-list')).toHaveClass(/msg-list--card/);
      const listHeader = await page.locator('.selectable-list-header').elementHandle();
      const listScroller = await page.locator('.msg-list__scroller').elementHandle();

      for (const subject of subjects) {
        const row = page.locator('.msg-list__items > li')
          .filter({ hasText: subject })
          .first();
        await row.locator('.msg-list__check input').click();
      }
      await expect(page.locator('.msg-list__count'))
        .toHaveText(/^3 selected/, { timeout: 5_000 });
      await expect(page.locator('.msg-list')).not.toHaveClass(/msg-list--card/);

      await page.locator('.msg-list__bulk-actions [title="Delete"]').click();

      for (const subject of subjects) {
        await expect.poll(
          async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
          { timeout: 30_000, message: `deleted bulk row "${subject}" should disappear from Inbox` },
        ).toBe(0);
      }

      await expect(page.locator('.message-view__article')).toBeVisible();
      await expect(page.locator('.msg-list')).toHaveClass(/msg-list--card/);
      await expect(page.locator('.msg-list__items > li.is-focused')).toHaveCount(1);
      expect(await listHeader.evaluate((element) => element.isConnected)).toBe(true);
      expect(await listScroller.evaluate((element) => element.isConnected)).toBe(true);

      // LOCAL_STACK uses Vue's dev build, whose component state exposes the rendered virtual items.
      // Its render tree excludes orphan DOM nodes left behind by duplicate keys.
      await expect.poll(() => page.locator('.msg-list').evaluate((list) => {
        let component = list.__vueParentComponent;
        while (component && !component.setupState?.virtualItems) component = component.parent;
        const expected = component?.setupState.virtualItems;
        const actual = [...list.querySelectorAll('.msg-list__items > li')];
        if (!expected?.length || actual.length !== expected.length) return false;
        const ids = actual.map((row) => row.id).filter(Boolean);
        return new Set(ids).size === ids.length
          && actual.every((row, index) => Number(row.dataset.index) === expected[index].index);
      }), { message: 'one DOM row per virtual item after bulk deletion' }).toBe(true);
      expect(consoleLinesFor(page).filter((line) => /duplicate keys/i.test(line))).toEqual([]);

      const inboxCache = await readViewCacheForFolderRole(page, 'inbox');
      expect(inboxCache, 'local Inbox cache should be reachable via window.__repo').not.toBeNull();
      for (const remoteId of createdIds) {
        expect(
          inboxCache.remoteIds,
          `remote id ${remoteId} should be gone from the Inbox cache`,
        ).not.toContain(remoteId);
      }

      await waitForPendingMutations(page);

      for (const remoteId of createdIds) {
        try {
          await expect.poll(
            async () => classifyMailboxState(
              await getEmailMailboxIds(jmap, remoteId),
              { source: inbox, trash },
            ),
            {
              timeout: 30_000,
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
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      for (const id of createdIds) {
        await cleanupEmail(jmap, id, trash.id);
      }
      if (initialViewport) await page.setViewportSize(initialViewport);
    }
  });
});
