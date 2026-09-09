import {
  connectJmap,
  createEmailInMailbox,
  destroyEmails,
  getEmailKeywords,
  listMailboxes,
  mailboxByRole,
  sweepOrphanTestMessages,
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
  waitForPendingMutations,
} from './helpers/ui.js';

/**
 * Starring (specs/011-message-keywords, MK-2.x) — Verified Consistency
 * for the `$flagged` keyword through every entry point: the row's hover
 * star, the multi-select Star toggle, and the S shortcut. Each write
 * must land in the row, the local cache (is_flagged) and on the server
 * (Email.keywords.$flagged), and the Starred filter must show exactly
 * the starred rows.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

const SUBJECT_PREFIX = 'Star e2e';

async function readFlaggedFlags(page, remoteIds) {
  return page.evaluate(async (ids) => {
    if (!globalThis.__repo) return null;
    const accounts = await globalThis.__repo.listAccounts();
    const account = accounts?.[0];
    if (!account) return null;
    const folders = await globalThis.__repo.listFolders(account.id);
    const inbox = folders.find((f) => f.role === 'inbox');
    const rows = await globalThis.__repo.listMessagesForView({
      accountId: account.id,
      folderId: inbox.id,
      sort: 'received',
      offset: 0,
      limit: 500,
    });
    return Object.fromEntries(ids.map((rid) => {
      const row = rows.find((r) => r.remote_id === rid);
      return [rid, row ? Number(row.is_flagged) : null];
    }));
  }, remoteIds);
}

async function expectServerFlagged(jmap, remoteId, flagged) {
  await expect.poll(
    async () => {
      const keywords = await getEmailKeywords(jmap, remoteId);
      if (!keywords) return 'missing';
      return keywords.$flagged === true ? 'flagged' : 'unflagged';
    },
    { timeout: 30_000, message: `server should report ${remoteId} as ${flagged ? 'flagged' : 'unflagged'}` },
  ).toBe(flagged ? 'flagged' : 'unflagged');
}

function rowFor(page, subject) {
  return page.locator('.msg-list__items > li').filter({ hasText: subject }).first();
}

test.describe('Star message e2e', () => {
  test.beforeEach(async ({ sharedPage }) => {
    await resetSharedSession(sharedPage);
    const jmap = await connectJmap();
    await sweepOrphanTestMessages(jmap, { subjectPrefix: SUBJECT_PREFIX });
  });

  test('row star, bulk Star, S and the Starred filter agree with cache and server', async ({ sharedPage: page }, testInfo) => {
    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    if (!inbox) {
      throw new Error(`Test requires Inbox mailbox; saw ${mailboxes.map((m) => `${m.name}:${m.role}`).join(', ')}`);
    }

    const fromEmail = selfEmail();
    const stamp = Date.now();
    const subjects = {
      hover: `${SUBJECT_PREFIX} ${stamp} hover`,
      bulkA: `${SUBJECT_PREFIX} ${stamp} bulk a`,
      bulkB: `${SUBJECT_PREFIX} ${stamp} bulk b`,
      plain: `${SUBJECT_PREFIX} ${stamp} plain`,
    };
    const ids = {};
    try {
      for (const [key, subject] of Object.entries(subjects)) {
        ids[key] = await createEmailInMailbox(jmap, {
          mailboxId: inbox.id,
          fromEmail,
          subject,
          bodyText: 'star fixture',
          keywords: { $seen: true },
        });
      }
      for (const subject of Object.values(subjects)) {
        await expectRowSoon(page, subject);
      }

      // Hover star: hidden at rest, shown on hover, set with one click.
      const hoverRow = rowFor(page, subjects.hover);
      const hoverStar = hoverRow.locator('.msg-list__action--star');
      await expect(hoverStar).toBeHidden();
      await hoverRow.hover();
      await expect(hoverStar).toBeVisible();
      await expect(hoverStar).toHaveAttribute('aria-pressed', 'false');
      await hoverStar.click();
      await expect(hoverStar).toHaveAttribute('aria-pressed', 'true');
      await expect(hoverStar).toHaveAccessibleName('Unstar');
      // The set star stays put once the pointer leaves the row.
      await page.mouse.move(600, 700);
      await expect(hoverStar).toBeVisible();
      await expect(hoverRow.locator('.msg-list__action[title="Archive"]')).toBeHidden();

      // Bulk Star over two unstarred rows.
      for (const subject of [subjects.bulkA, subjects.bulkB]) {
        await rowFor(page, subject).locator('.msg-list__check input').click();
      }
      const bulkStar = page.locator('.msg-list__bulk-actions .msg-list__bulk-action--star');
      await expect(bulkStar).toHaveAccessibleName('Star');
      await bulkStar.click();
      await expect(bulkStar).toHaveAccessibleName('Unstar');
      await page.locator('.msg-list__bulk-actions [title="Clear selection"]').click();

      await waitForPendingMutations(page);

      const flags = await readFlaggedFlags(page, Object.values(ids));
      expect(flags, 'local cache should expose is_flagged for the test rows').not.toBeNull();
      expect(flags[ids.hover]).toBe(1);
      expect(flags[ids.bulkA]).toBe(1);
      expect(flags[ids.bulkB]).toBe(1);
      expect(flags[ids.plain]).toBe(0);

      try {
        await expectServerFlagged(jmap, ids.hover, true);
        await expectServerFlagged(jmap, ids.bulkA, true);
        await expectServerFlagged(jmap, ids.bulkB, true);
        await expectServerFlagged(jmap, ids.plain, false);
      } catch (err) {
        await testInfo.attach('recent-mutations.json', {
          body: JSON.stringify(await readRecentMutations(page), null, 2),
          contentType: 'application/json',
        });
        throw err;
      }

      // Starred filter: the three starred rows and not the plain one.
      const starredFilter = page.locator('.msg-list__filter--starred');
      await starredFilter.click();
      await expect(starredFilter).toHaveAttribute('aria-pressed', 'true');
      for (const subject of [subjects.hover, subjects.bulkA, subjects.bulkB]) {
        await expect(rowFor(page, subject)).toBeVisible();
      }
      await expect(rowFor(page, subjects.plain)).toHaveCount(0);

      // S on a selection is modal: one starred row means unstar them all.
      await rowFor(page, subjects.bulkA).locator('.msg-list__check input').click();
      await page.keyboard.press('s');
      await page.locator('.msg-list__bulk-actions [title="Clear selection"]').click();
      // The unstarred row leaves the Starred filter once it is no longer sticky.
      await expect(rowFor(page, subjects.bulkA)).toHaveCount(0);
      await starredFilter.click();
      await expect(rowFor(page, subjects.bulkA)).toBeVisible();
      await expect(rowFor(page, subjects.bulkA).locator('.msg-list__action--star')).toBeHidden();

      await waitForPendingMutations(page);
      const after = await readFlaggedFlags(page, [ids.bulkA, ids.bulkB]);
      expect(after[ids.bulkA]).toBe(0);
      expect(after[ids.bulkB]).toBe(1);
      await expectServerFlagged(jmap, ids.bulkA, false);
      await expectServerFlagged(jmap, ids.bulkB, true);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await destroyEmails(jmap, Object.values(ids));
    }
  });
});
