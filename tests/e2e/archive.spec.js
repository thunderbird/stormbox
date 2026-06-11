import {
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
  liveE2eEnabled,
  selfEmail,
  skipLiveE2eMessage,
} from './helpers/stack-env.js';
import {
  expectRowSoon,
  openMessageBySubject,
  readRecentMutations,
  readViewCacheForFolderRole,
  waitForPendingMutations,
} from './helpers/ui.js';

/**
 * Archive (R-3.4) — Verified Consistency triple.
 *
 * The archive button enqueues a MOVE_TO_FOLDERS mutation that targets
 * the account's archive folder. This spec asserts the UI removes the
 * row from the source folder, the local cache no longer references it,
 * and the server moved the message to the Archive mailbox.
 */

// temp skipping until get running, remove when ready to test this one
test.skip();

test.skip(!liveE2eEnabled, skipLiveE2eMessage);

// Stalwart's JMAP `subject:` filter stems "Archive" / "Archived" /
// "Archives" all back to "archive", which collides with the 1500
// "Seed e2e archive N" messages the local-stack fixture seeds into
// the Archive folder. A `subjectPrefix: 'Archive e2e'` sweep would
// therefore wipe the entire seeded fixture every run and break
// mail-flow.spec.js's deep-Archive scroll assertion. We use the
// non-stemmed `ArchiveAction` token so our sweep matches only this
// spec's own test mail.
const TEST_SUBJECT_PREFIX = 'ArchiveAction e2e';

test.describe('Archive e2e', () => {
  test.beforeEach(async ({ sharedPage }) => {
    await resetSharedSession(sharedPage, {
      extraSubjectPrefixes: [TEST_SUBJECT_PREFIX],
    });
  });

  test('Archive button moves an Inbox message into the Archive folder', async ({ sharedPage: page }, testInfo) => {
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
    const subject = `${TEST_SUBJECT_PREFIX} ${Date.now()}`;
    let createdId = null;
    try {
      createdId = await createEmailInMailbox(jmap, {
        mailboxId: inbox.id,
        fromEmail,
        subject,
      });

      await expectRowSoon(page, subject);
      await openMessageBySubject(page, subject);

      await page.getByTitle('Archive (A)').click();

      await expect.poll(
        async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
        { timeout: 30_000, message: 'archived message should disappear from Inbox' },
      ).toBe(0);

      await waitForPendingMutations(page);

      const inboxCache = await readViewCacheForFolderRole(page, 'inbox');
      expect(inboxCache, 'local Inbox cache should be reachable via window.__repo').not.toBeNull();
      expect(inboxCache.remoteIds, 'remote id should be gone from Inbox cache').not.toContain(createdId);

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
          { timeout: 30_000, message: 'server should report the archived message in Archive, not Inbox' },
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
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      if (createdId) {
        await cleanupEmail(jmap, createdId, trash.id);
      }
    }
  });
});
