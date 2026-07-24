import {
  cleanupEmail,
  connectJmap,
  createEmailInMailbox,
  ensureMailbox,
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
  SHARED_TEST_OIDC_EMAIL,
  SHARED_TEST_OIDC_PASSWORD,
  skipLocalStackMessage,
  TEST_THUNDERMAIL,
} from './helpers/stack-env.js';
import { expectRowSoon, waitForPendingMutations } from './helpers/ui.js';

test.skip(!localStackEnabled, skipLocalStackMessage);

const SHARED_FOLDER = 'SharedCopyE2E';
const SUBJECT_PREFIX = 'Shared copy e2e';

let ownerJmap;
let primaryJmap;
let sharedJmap;
let sharedMailbox;

async function destroyMailboxByName(jmap, name) {
  const mailbox = (await listMailboxes(jmap))
    .find((candidate) => candidate.name === name);
  if (!mailbox) return;
  await jmapRequest(jmap, [[
    'Mailbox/set',
    {
      accountId: jmap.accountId,
      destroy: [mailbox.id],
      onDestroyRemoveEmails: true,
    },
    'cleanup-mailbox',
  ]]);
}

async function destinationEmailsBySubject(subject) {
  const queried = await jmapRequest(sharedJmap, [[
    'Email/query',
    {
      accountId: sharedJmap.accountId,
      filter: { inMailbox: sharedMailbox.id },
      limit: 100,
    },
    'copy-query',
  ]]);
  const ids = pickResponse(queried, 'Email/query')?.ids ?? [];
  if (ids.length === 0) return [];
  const fetched = await jmapRequest(sharedJmap, [[
    'Email/get',
    {
      accountId: sharedJmap.accountId,
      ids,
      properties: ['id', 'subject', 'mailboxIds'],
    },
    'copy-get',
  ]]);
  return (pickResponse(fetched, 'Email/get')?.list ?? [])
    .filter((email) => email.subject === subject);
}

test.describe('Cross-account shared-folder copy', () => {
  test.beforeAll(async () => {
    primaryJmap = await connectJmap();
    ownerJmap = await connectJmap({
      username: SHARED_TEST_OIDC_EMAIL,
      password: SHARED_TEST_OIDC_PASSWORD,
    });
    await destroyMailboxByName(ownerJmap, SHARED_FOLDER);
    sharedMailbox = await ensureMailbox(ownerJmap, { name: SHARED_FOLDER });
    await jmapRequest(ownerJmap, [[
      'Mailbox/set',
      {
        accountId: ownerJmap.accountId,
        update: {
          [sharedMailbox.id]: {
            shareWith: {
              [primaryJmap.accountId]: {
                mayReadItems: true,
                mayAddItems: true,
                mayRemoveItems: true,
                maySetSeen: true,
                maySetKeywords: true,
                mayCreateChild: true,
                mayRename: true,
                mayDelete: true,
                maySubmit: false,
              },
            },
          },
        },
      },
      'share',
    ]]);
    // Re-fetch the sharee's Session after granting access.
    const refreshedPrimary = await connectJmap();
    if (!refreshedPrimary.session.accounts?.[ownerJmap.accountId]) {
      throw new Error('Shared owner account did not appear in the sharee JMAP Session');
    }
    sharedJmap = {
      ...refreshedPrimary,
      accountId: ownerJmap.accountId,
    };
    await jmapRequest(sharedJmap, [[
      'Mailbox/set',
      {
        accountId: sharedJmap.accountId,
        update: { [sharedMailbox.id]: { isSubscribed: true } },
      },
      'subscribe',
    ]]);
  });

  test.afterAll(async () => {
    if (ownerJmap) await destroyMailboxByName(ownerJmap, SHARED_FOLDER);
  });

  test.beforeEach(async ({ sharedPage }) => {
    await sharedPage.evaluate(async () => {
      const accounts = await globalThis.__repo.call('db.query', {
        sql: 'SELECT id FROM accounts WHERE is_primary = 1 LIMIT 1',
        params: [],
      });
      if (accounts[0]?.id != null) {
        await globalThis.__repo.stopSyncAccount(accounts[0].id);
      }
    });
    await sharedPage.reload();
    await expect(sharedPage.locator('.folder-node').first())
      .toBeVisible({ timeout: 30_000 });
    await resetSharedSession(sharedPage, {
      extraSubjectPrefixes: [SUBJECT_PREFIX],
    });
  });

  test('copies into a shared account while preserving source and cache consistency', async ({
    sharedPage: page,
  }, testInfo) => {
    const mailboxes = await listMailboxes(primaryJmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    const trash = mailboxByRole(mailboxes, 'trash');
    const subject = `${SUBJECT_PREFIX} ${Date.now()}`;
    const sourceId = await createEmailInMailbox(primaryJmap, {
      mailboxId: inbox.id,
      fromEmail: TEST_THUNDERMAIL,
      subject,
    });
    let destinationId = null;

    try {
      await expectRowSoon(page, subject);
      const sharedFolder = page.locator('.folder-node')
        .filter({ hasText: SHARED_FOLDER })
        .first();
      await expect(sharedFolder).toBeVisible({ timeout: 30_000 });
      const sourceRow = page.locator('.msg-list__items > li')
        .filter({ hasText: subject })
        .first();
      await sourceRow.dragTo(sharedFolder);
      await waitForPendingMutations(page);
      const copyErrors = await page.evaluate(async () => globalThis.__repo.call(
        'db.query',
        {
          sql: `SELECT error_json FROM pending_mutations
                 WHERE mutation_type = 'copyToFolders'
                   AND local_status = 'conflicted'`,
          params: [],
        },
      ));
      expect(copyErrors).toEqual([]);

      // Cross-account drag is copy: the source remains in Inbox.
      await expect(sourceRow).toBeVisible();

      await expect.poll(async () => {
        const copies = await destinationEmailsBySubject(subject);
        destinationId = copies[0]?.id ?? null;
        return copies.length;
      }, {
        timeout: 30_000,
        message: 'destination account should contain exactly one copy',
      }).toBe(1);

      const sourceMailboxIds = pickResponse(await jmapRequest(primaryJmap, [[
        'Email/get',
        {
          accountId: primaryJmap.accountId,
          ids: [sourceId],
          properties: ['id', 'mailboxIds'],
        },
        'source-get',
      ]]), 'Email/get')?.list?.[0]?.mailboxIds;
      expect(sourceMailboxIds?.[inbox.id]).toBe(true);

      await expect.poll(() => page.evaluate(async ({
        copiedSubject,
        sharedAccountId,
        sharedFolderId,
      }) => {
        const rows = await globalThis.__repo.call('db.query', {
          sql: `SELECT m.id
                  FROM messages m
                  JOIN accounts a ON a.id = m.account_id
                  JOIN folder_messages fm ON fm.message_id = m.id
                  JOIN folders f ON f.id = fm.folder_id
                 WHERE m.subject = ?
                   AND a.remote_account_id = ?
                   AND f.remote_id = ?`,
          params: [copiedSubject, sharedAccountId, sharedFolderId],
        });
        return rows.length;
      }, {
        copiedSubject: subject,
        sharedAccountId: sharedJmap.accountId,
        sharedFolderId: sharedMailbox.id,
      }), {
        timeout: 30_000,
        message: 'local SQLite should contain the destination copy membership',
      }).toBe(1);

      const serverMailbox = pickResponse(await jmapRequest(sharedJmap, [[
        'Mailbox/get',
        {
          accountId: sharedJmap.accountId,
          ids: [sharedMailbox.id],
          properties: ['id', 'totalEmails', 'unreadEmails'],
        },
        'counter-get',
      ]]), 'Mailbox/get')?.list?.[0];
      const cachedCounts = await page.evaluate(async ({
        remoteId,
        accountRemoteId,
      }) => {
        const rows = await globalThis.__repo.call('db.query', {
          sql: `SELECT f.total_emails, f.unread_emails
                  FROM folders f
                  JOIN accounts a ON a.id = f.account_id
                 WHERE f.remote_id = ?
                   AND a.remote_account_id = ?
                   AND f.is_deleted = 0`,
          params: [remoteId, accountRemoteId],
        });
        return rows[0] ?? null;
      }, {
        remoteId: sharedMailbox.id,
        accountRemoteId: sharedJmap.accountId,
      });
      expect(cachedCounts).toEqual({
        total_emails: serverMailbox.totalEmails,
        unread_emails: serverMailbox.unreadEmails,
      });
    } finally {
      if (destinationId) {
        await jmapRequest(sharedJmap, [[
          'Email/set',
          { accountId: sharedJmap.accountId, destroy: [destinationId] },
          'cleanup-copy',
        ]]).catch(() => {});
      }
      if (trash) await cleanupEmail(primaryJmap, sourceId, trash.id).catch(() => {});
      await attachConsoleTail(testInfo, consoleLinesFor(page));
    }
  });
});
