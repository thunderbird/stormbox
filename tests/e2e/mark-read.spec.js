import { test, expect } from '@playwright/test';

import {
  cleanupEmail,
  connectJmap,
  createEmailInMailbox,
  getEmailMailboxIds,
  jmapRequest,
  listMailboxes,
  mailboxByRole,
  pickResponse,
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
 * Mark read / unread (R-3.1) — Verified Consistency triple for the
 * bulk path. Selecting rows and pressing the "Mark as unread" bulk
 * action must enqueue a SET_KEYWORDS mutation that removes `$seen`
 * from the targets; the server and the local cache must agree.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

async function getEmailKeywords(jmap, emailId) {
  const payload = await jmapRequest(jmap, [[
    'Email/get',
    {
      accountId: jmap.accountId,
      ids: [emailId],
      properties: ['keywords'],
    },
    'g1',
  ]]);
  const row = pickResponse(payload, 'Email/get')?.list?.[0] ?? null;
  return row?.keywords ?? null;
}

test.describe('Mark read/unread e2e', () => {
  test.beforeEach(async () => {
    const jmap = await connectJmap();
    await sweepOrphanTestMessages(jmap, { subjectPrefix: 'Mark unread e2e' });
  });

  test('bulk "Mark as unread" removes $seen on every selected row (UI + cache + server)', async ({ page }, testInfo) => {
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
      `Mark unread e2e ${stamp} a`,
      `Mark unread e2e ${stamp} b`,
    ];
    const createdIds = [];
    try {
      // Seed messages with $seen already set so flipping them to unread
      // is a real keyword removal, not a no-op.
      for (const subject of subjects) {
        const payload = await jmapRequest(jmap, [[
          'Email/set',
          {
            accountId: jmap.accountId,
            create: {
              c1: {
                mailboxIds: { [inbox.id]: true },
                keywords: { $seen: true },
                from: [{ email: fromEmail }],
                to: [{ email: fromEmail }],
                subject,
                bodyStructure: { type: 'text/plain', partId: 'p1' },
                bodyValues: { p1: { value: 'mark-unread fixture' } },
              },
            },
          },
          's1',
        ]]);
        const set = pickResponse(payload, 'Email/set');
        const id = set?.created?.c1?.id;
        if (!id) throw new Error(`could not seed read message: ${JSON.stringify(set)}`);
        createdIds.push(id);
      }

      await loginViaOidc(page);
      await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });

      await clickFolder(page, inbox.name);
      for (const subject of subjects) {
        await expect.poll(
          async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
          { timeout: 30_000, message: `expected "${subject}" in Inbox` },
        ).toBeGreaterThan(0);
      }

      for (const subject of subjects) {
        const row = page.locator('.msg-list__items > li').filter({ hasText: subject }).first();
        await row.locator('.msg-list__check input').click();
      }

      await page.locator('.message-view__bulk-actions [title="Mark as unread"]').click();

      await waitForPendingMutations(page);

      // Local cache: the rows must be unread (is_seen=0) in the
      // canonical view for the Inbox folder.
      const seenFlags = await page.evaluate(async (remoteIds) => {
        if (!globalThis.__repo) return null;
        const accounts = await globalThis.__repo.listAccounts();
        const account = accounts?.[0];
        if (!account) return null;
        const folders = await globalThis.__repo.listFolders(account.id);
        const inboxFolder = folders.find((f) => f.role === 'inbox');
        const rows = await globalThis.__repo.listMessagesForView({
          accountId: account.id,
          folderId: inboxFolder.id,
          sort: 'received',
          offset: 0,
          limit: 500,
        });
        return remoteIds.map((rid) => {
          const row = rows.find((r) => r.remote_id === rid);
          return { remoteId: rid, isSeen: row ? Number(row.is_seen) : null };
        });
      }, createdIds);

      expect(seenFlags, 'local cache should expose is_seen for the test rows').not.toBeNull();
      for (const flag of seenFlags) {
        expect(flag.isSeen, `is_seen for ${flag.remoteId} should be 0 (unread)`).toBe(0);
      }

      for (const remoteId of createdIds) {
        try {
          await expect.poll(
            async () => {
              const keywords = await getEmailKeywords(jmap, remoteId);
              if (!keywords) return 'missing';
              return keywords.$seen === true ? 'seen' : 'unseen';
            },
            { timeout: 30_000, message: `server should report ${remoteId} as unread (no $seen)` },
          ).toBe('unseen');
        } catch (err) {
          const mutationRows = await readRecentMutations(page);
          await testInfo.attach('recent-mutations.json', {
            body: JSON.stringify(mutationRows, null, 2),
            contentType: 'application/json',
          });
          throw err;
        }
      }

      // Sanity: the rows still belong to Inbox; mark-unread is not a move.
      for (const remoteId of createdIds) {
        const mailboxIds = await getEmailMailboxIds(jmap, remoteId);
        expect(mailboxIds?.[inbox.id]).toBe(true);
      }

      const inboxCache = await readViewCacheForFolderRole(page, 'inbox');
      for (const remoteId of createdIds) {
        expect(inboxCache.remoteIds).toContain(remoteId);
      }
    } finally {
      await attachConsoleTail(testInfo, consoleLines);
      for (const id of createdIds) {
        await cleanupEmail(jmap, id, trash.id);
      }
    }
  });
});
