import {
  cleanupEmail,
  connectJmap,
  createEmailInMailbox,
  getEmailKeywords,
  getEmailMailboxIds,
  jmapRequest,
  listMailboxes,
  mailboxByRole,
  pickResponse,
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
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import {
  clickFolder,
  expectRowSoon,
  openMessageBySubject,
  readViewCacheForFolderRole,
  waitForPendingMutations,
} from './helpers/ui.js';

/**
 * Mark as junk (R-3.17) — Verified Consistency triple for both entry
 * points. The open-message "Junk" toolbar button and the multi-select
 * bulk "Junk" action must set `$junk`, clear `$notjunk`, and move the
 * targets to the Junk mailbox; the UI, the local cache via
 * window.__repo, and the server via direct JMAP must agree.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

const JUNK_SUBJECT_PREFIX = 'MarkJunk e2e';

async function ensureJunkMailbox(jmap) {
  const mailboxes = await listMailboxes(jmap);
  const junk = mailboxByRole(mailboxes, 'junk');
  if (junk) return junk;
  const payload = await jmapRequest(jmap, [[
    'Mailbox/set',
    { accountId: jmap.accountId, create: { mb: { name: 'Junk', role: 'junk' } } },
    'mb',
  ]]);
  const created = pickResponse(payload, 'Mailbox/set')?.created?.mb;
  if (!created?.id) throw new Error('Could not create Junk mailbox');
  return { id: created.id, name: 'Junk', role: 'junk' };
}

async function classifyJunkState(jmap, emailId, { inbox, junk }) {
  const ids = await getEmailMailboxIds(jmap, emailId);
  if (!ids) return 'missing';
  if (ids[junk.id] === true && ids[inbox.id] !== true) return 'junk';
  if (ids[inbox.id] === true) return 'inbox';
  return JSON.stringify(ids);
}

async function classifyJunkKeywords(jmap, emailId) {
  const keywords = await getEmailKeywords(jmap, emailId);
  if (!keywords) return 'missing';
  if (keywords.$notjunk) return 'still-notjunk';
  return keywords.$junk === true ? 'junk' : JSON.stringify(keywords);
}

test.describe('Mark as junk e2e', () => {
  test.beforeEach(async ({ sharedPage: page }) => {
    await resetSharedSession(page, { extraSubjectPrefixes: [JUNK_SUBJECT_PREFIX] });
  });

  test('open-message "Junk" flags the message and moves it to the Junk folder', async ({ sharedPage: page }, testInfo) => {
    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    const trash = mailboxByRole(mailboxes, 'trash');
    const junk = await ensureJunkMailbox(jmap);

    const senderEmail = `junker-${Date.now()}@promo-e2e.example`;
    const subject = `${JUNK_SUBJECT_PREFIX} single ${Date.now()}`;
    let createdId = null;
    try {
      // Seed with $notjunk already set so the action performs a real
      // keyword removal, not a no-op.
      createdId = await createEmailInMailbox(jmap, {
        mailboxId: inbox.id,
        fromEmail: senderEmail,
        subject,
        keywords: { $notjunk: true },
      });

      await expectRowSoon(page, subject);
      await openMessageBySubject(page, subject);

      const junkButton = page.locator('.message-view__header [title="Junk"]');
      await expect(junkButton).toBeVisible({ timeout: 30_000 });
      await junkButton.click();

      // Success toast confirms the action.
      await expect(page.locator('.store-error-toast__item--success'))
        .toContainText(/marked as junk/i, { timeout: 30_000 });

      // The message leaves the Inbox list.
      await expect.poll(
        async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
        { timeout: 30_000, message: 'junked message should leave the Inbox' },
      ).toBe(0);

      await waitForPendingMutations(page);

      // Server: message is now in Junk, not the Inbox.
      await expect.poll(
        async () => classifyJunkState(jmap, createdId, { inbox, junk }),
        { timeout: 30_000, message: 'server should report the message in Junk' },
      ).toBe('junk');

      // Server: $junk set and $notjunk cleared.
      await expect.poll(
        async () => classifyJunkKeywords(jmap, createdId),
        { timeout: 30_000, message: 'server should mark the message $junk and clear $notjunk' },
      ).toBe('junk');

      // Local cache: the message left the Inbox view. Like the
      // delete/whitelist specs, the destination window is invalidated
      // and re-fetched on open, so the Junk destination is asserted on
      // the server (above) rather than in the view cache.
      const inboxCache = await readViewCacheForFolderRole(page, 'inbox');
      expect(inboxCache, 'local Inbox cache should be reachable via window.__repo').not.toBeNull();
      expect(inboxCache.remoteIds, 'remote id should be gone from the Inbox cache').not.toContain(createdId);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      if (createdId && trash) await cleanupEmail(jmap, createdId, trash.id).catch(() => {});
    }
  });

  test('bulk "Junk" flags every selected row and moves the batch to the Junk folder', async ({ sharedPage: page }, testInfo) => {
    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    const trash = mailboxByRole(mailboxes, 'trash');
    const junk = await ensureJunkMailbox(jmap);

    const ts = Date.now();
    const subjects = [
      `${JUNK_SUBJECT_PREFIX} bulk ${ts} a`,
      `${JUNK_SUBJECT_PREFIX} bulk ${ts} b`,
      `${JUNK_SUBJECT_PREFIX} bulk ${ts} c`,
    ];
    const createdIds = [];
    try {
      for (const subject of subjects) {
        const id = await createEmailInMailbox(jmap, {
          mailboxId: inbox.id,
          fromEmail: `junker-${ts}@promo-e2e.example`,
          subject,
        });
        createdIds.push(id);
      }

      for (const subject of subjects) {
        await expectRowSoon(page, subject);
      }

      // Multi-select all three via the checkbox column.
      for (const subject of subjects) {
        await page.locator('.msg-list__items > li')
          .filter({ hasText: subject })
          .first()
          .locator('.msg-list__check input')
          .click();
      }
      await expect(page.locator('.msg-list__count'))
        .toHaveText(/^3 selected/, { timeout: 5_000 });

      await page.locator('.msg-list__bulk-actions [title="Junk"]').click();

      await expect(page.locator('.store-error-toast__item--success'))
        .toContainText(/marked 3 messages as junk/i, { timeout: 30_000 });

      // Every selected message leaves the Inbox list.
      for (const subject of subjects) {
        await expect.poll(
          async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
          { timeout: 30_000, message: `junked bulk row "${subject}" should leave the Inbox` },
        ).toBe(0);
      }

      await waitForPendingMutations(page);

      // Server: each message is now in Junk and flagged $junk.
      for (const id of createdIds) {
        await expect.poll(
          async () => classifyJunkState(jmap, id, { inbox, junk }),
          { timeout: 30_000, message: `server should report ${id} in Junk` },
        ).toBe('junk');
        await expect.poll(
          async () => classifyJunkKeywords(jmap, id),
          { timeout: 30_000, message: `server should mark ${id} $junk` },
        ).toBe('junk');
      }

      // Local cache: the messages left the Inbox view.
      const inboxCache = await readViewCacheForFolderRole(page, 'inbox');
      expect(inboxCache, 'local Inbox cache should be reachable via window.__repo').not.toBeNull();
      for (const id of createdIds) {
        expect(inboxCache.remoteIds, `${id} should be gone from the Inbox cache`).not.toContain(id);
      }
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      if (trash) {
        for (const id of createdIds) {
          await cleanupEmail(jmap, id, trash.id).catch(() => {});
        }
      }
    }
  });
});
