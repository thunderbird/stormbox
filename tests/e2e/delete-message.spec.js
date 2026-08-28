import {
  classifyMailboxState,
  cleanupEmail,
  connectJmap,
  createDraft,
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
  clickFolder,
  expectRowSoon,
  readRecentMutations,
  readViewCacheForFolderRole,
} from './helpers/ui.js';
import { discardCompose } from './helpers/compose.js';

test.skip(!localStackEnabled, skipLocalStackMessage);

// One parameterised spec exercises explicit removal from Drafts and Inbox.
// Composer Discard permanently destroys a draft; message Delete moves an
// Inbox Email to Trash.
const CASES = [
  {
    name: 'composer Discard permanently destroys a real server-side draft',
    sourceRole: 'drafts',
    subjectPrefix: 'Delete e2e',
    expectedState: 'missing',
    createMessage: async (jmap, { sourceMailbox, fromEmail, subject }) => createDraft(jmap, {
      draftsId: sourceMailbox.id,
      fromEmail,
      subject,
    }),
  },
  {
    name: 'delete moves a real server-side Inbox message to Trash',
    sourceRole: 'inbox',
    subjectPrefix: 'Delete inbox e2e',
    expectedState: 'trash',
    createMessage: async (jmap, { sourceMailbox, fromEmail, subject }) => createEmailInMailbox(jmap, {
      mailboxId: sourceMailbox.id,
      fromEmail,
      subject,
    }),
  },
];

test.describe('Delete message e2e', () => {
  test.beforeEach(async ({ sharedPage }) => {
    await resetSharedSession(sharedPage);
  });

  for (const {
    name, sourceRole, createMessage, subjectPrefix, expectedState,
  } of CASES) {
    test(name, async ({ sharedPage: page }, testInfo) => {
      const jmap = await connectJmap();
      const mailboxes = await listMailboxes(jmap);
      const source = mailboxByRole(mailboxes, sourceRole);
      const trash = mailboxByRole(mailboxes, 'trash');
      if (!source || !trash) {
        throw new Error(
          `Test requires ${sourceRole} and Trash mailboxes; saw ${mailboxes.map((m) => `${m.name}:${m.role}`).join(', ')}`,
        );
      }

      const fromEmail = selfEmail();
      const subject = `${subjectPrefix} ${Date.now()}`;
      let createdId = null;
      try {
        createdId = await createMessage(jmap, {
          sourceMailbox: source,
          fromEmail,
          subject,
        });

        await expect.poll(
          async () => classifyMailboxState(
            await getEmailMailboxIds(jmap, createdId),
            { source, trash },
          ),
          { timeout: 30_000, message: `created test message should start in ${source.name}` },
        ).toBe('source');

        await clickFolder(page, source.name);
        await expectRowSoon(page, subject);

        await page.locator('.msg-list__item').filter({ hasText: subject }).first().click();
        if (sourceRole === 'drafts') {
          await expect(page.locator('.compose-dialog--expanded')).toBeVisible({ timeout: 30_000 });
          await discardCompose(page);
        } else {
          await expect(page.locator('.message-view__title h2')).toHaveText(subject, { timeout: 30_000 });
          await page.getByTitle('Delete').click();
        }

        await expect.poll(
          async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
          { timeout: 30_000, message: `deleted message should disappear from the ${source.name} list` },
        ).toBe(0);

        const sourceCache = await readViewCacheForFolderRole(page, sourceRole);
        expect(sourceCache, `local ${source.name} cache should be reachable via window.__repo`).not.toBeNull();
        expect(sourceCache.remoteIds, `remote id should be gone from ${source.name} cache`).not.toContain(createdId);

        try {
          await expect.poll(
            async () => classifyMailboxState(
              await getEmailMailboxIds(jmap, createdId),
              { source, trash },
            ),
            {
              timeout: 30_000,
              message: sourceRole === 'drafts'
                ? 'server should report the discarded draft as destroyed'
                : `server should report the deleted message in Trash, not ${source.name}`,
            },
          ).toBe(expectedState);
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
  }
});
