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
  waitForPendingMutations,
} from './helpers/ui.js';

/**
 * Tag views (specs/011-message-keywords, MK-3.4): the sidebar's Tags
 * section opens a local cross-folder view of one keyword. Mail tagged in
 * two folders shows up together, a message loses its row when the tag is
 * removed there, filing actions are not offered, and the sidebar count
 * follows the cache. The keyword write is asserted on the server as well.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

const SUBJECT_PREFIX = 'Tag view e2e';
const PERSONAL = '$label3';

async function readTagView(page, keyword) {
  return page.evaluate(async (kw) => {
    if (!globalThis.__repo) return null;
    const accounts = await globalThis.__repo.listAccounts();
    const account = accounts?.[0];
    if (!account) return null;
    const rows = await globalThis.__repo.listMessagesForKeyword({
      accountIds: [account.id], keyword: kw, offset: 0, limit: 500,
    });
    return rows.map((r) => ({ remoteId: r.remote_id, sourceFolderId: r.source_folder_id }));
  }, keyword);
}

function rowFor(page, subject) {
  return page.locator('.msg-list__items > li').filter({ hasText: subject }).first();
}

test.describe('Tag view e2e', () => {
  test.beforeEach(async ({ sharedPage }) => {
    await resetSharedSession(sharedPage);
    const jmap = await connectJmap();
    await sweepOrphanTestMessages(jmap, { subjectPrefix: SUBJECT_PREFIX });
  });

  test('a tag view gathers tagged mail from two folders and follows tag changes', async ({ sharedPage: page }, testInfo) => {
    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    const archive = mailboxByRole(mailboxes, 'archive');
    if (!inbox || !archive) {
      throw new Error(`Test requires Inbox and Archive; saw ${mailboxes.map((m) => `${m.name}:${m.role}`).join(', ')}`);
    }

    const fromEmail = selfEmail();
    const stamp = Date.now();
    const subjects = {
      inbox: `${SUBJECT_PREFIX} ${stamp} in inbox`,
      archived: `${SUBJECT_PREFIX} ${stamp} in archive`,
      plain: `${SUBJECT_PREFIX} ${stamp} untagged`,
    };
    const ids = {};
    try {
      ids.inbox = await createEmailInMailbox(jmap, {
        mailboxId: inbox.id, fromEmail, subject: subjects.inbox, bodyText: 'tag view fixture',
        keywords: { $seen: true, [PERSONAL]: true },
      });
      ids.archived = await createEmailInMailbox(jmap, {
        mailboxId: archive.id, fromEmail, subject: subjects.archived, bodyText: 'tag view fixture',
        keywords: { $seen: true, [PERSONAL]: true },
      });
      ids.plain = await createEmailInMailbox(jmap, {
        mailboxId: inbox.id, fromEmail, subject: subjects.plain, bodyText: 'tag view fixture',
        keywords: { $seen: true },
      });
      await expectRowSoon(page, subjects.inbox);
      await expectRowSoon(page, subjects.plain);

      // The Archive copy must be in the cache for the view to list it;
      // opening the folder indexes it.
      await page.locator('.folder-node', { hasText: 'Archive' }).first().locator('.folder-node__button').click();
      await expectRowSoon(page, subjects.archived);

      // Sidebar Tags section: Personal counts both tagged rows.
      const personalRow = page.locator(`[data-tag-view="${PERSONAL}"]`);
      await expect(personalRow).toBeVisible();
      await expect.poll(async () => (await personalRow.locator('.tag-view-node__count').textContent().catch(() => '0'))?.trim())
        .toBe('2');
      await personalRow.locator('button').click();

      await expect(page.locator('.msg-list')).toHaveAttribute('aria-label', /Personal messages/);
      await expect(rowFor(page, subjects.inbox)).toBeVisible();
      await expect(rowFor(page, subjects.archived)).toBeVisible();
      await expect(rowFor(page, subjects.plain)).toHaveCount(0);
      await expect(page.locator('.msg-list__count')).toHaveText('2 messages');

      // Filing is not offered in a tag view; tagging and starring are.
      const inboxRow = rowFor(page, subjects.inbox);
      await inboxRow.hover();
      await expect(inboxRow.locator('.msg-list__action--tag')).toBeVisible();
      await expect(inboxRow.locator('.msg-list__action--star')).toBeVisible();
      await expect(inboxRow.locator('.msg-list__action[title="Archive"]')).toHaveCount(0);
      await expect(inboxRow.locator('.msg-list__action[title="Delete"]')).toHaveCount(0);
      await expect(inboxRow.locator('.msg-list__item')).toHaveAttribute('draggable', 'false');

      const cached = await readTagView(page, PERSONAL);
      expect(cached.map((r) => r.remoteId).sort()).toEqual([ids.archived, ids.inbox].sort());
      expect(cached.every((r) => r.sourceFolderId != null)).toBe(true);

      // Remove the tag from the open message: its row leaves the view and
      // the sidebar count drops, then the server agrees. Earlier writes are
      // drained first so their StateChange refresh cannot overwrite the
      // optimistic removal.
      await waitForPendingMutations(page);
      await inboxRow.locator('.msg-list__subject').click();
      await expect(page.locator('.message-view__action[aria-label="Archive"]')).toHaveCount(0);
      await expect(page.locator('.message-view__action[aria-label="Delete"]')).toHaveCount(0);
      const viewChips = page.locator('[data-message-tags] .tag-chip');
      await expect(viewChips).toHaveText(['Personal']);
      await viewChips.first().locator('.tag-chip__remove').click();

      await expect(rowFor(page, subjects.inbox)).toHaveCount(0);
      await expect(rowFor(page, subjects.archived)).toBeVisible();
      // The header count hides while the reading pane narrows the column; count rows.
      await expect(page.locator('.msg-list__items > li')).toHaveCount(1);
      await expect(personalRow.locator('.tag-view-node__count')).toHaveText('1');

      await waitForPendingMutations(page);
      expect((await readTagView(page, PERSONAL)).map((r) => r.remoteId)).toEqual([ids.archived]);
      await expect.poll(async () => {
        const keywords = await getEmailKeywords(jmap, ids.inbox);
        return keywords?.[PERSONAL] === true ? 'present' : 'absent';
      }, { timeout: 30_000 }).toBe('absent');
      await expect.poll(async () => {
        const keywords = await getEmailKeywords(jmap, ids.archived);
        return keywords?.[PERSONAL] === true ? 'present' : 'absent';
      }, { timeout: 30_000 }).toBe('present');
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await destroyEmails(jmap, Object.values(ids));
    }
  });
});
