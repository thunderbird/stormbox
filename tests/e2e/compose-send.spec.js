import {
  cleanupEmail,
  connectJmap,
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
  liveE2eEnabled,
  selfEmail,
  skipLiveE2eMessage,
} from './helpers/stack-env.js';
import {
  clickFolder,
  readRecentMutations,
  readViewCacheForFolderRole,
  waitForPendingMutations,
} from './helpers/ui.js';

/**
 * Compose + send (R-4.4, SC-2) — Verified Consistency triple.
 *
 * Stormbox enqueues a SEND mutation that chains Email/set +
 * EmailSubmission/set with onSuccessUpdateEmail to move the freshly
 * created draft into Sent. This spec drives the compose dialog through
 * Send and asserts the resulting message is present in Sent in:
 *   (1) the local cache, immediately after the SEND mutation drains
 *       and before the user navigates to Sent — guards Constitution
 *       IV.2 (cache matches server before runMutation resolves, no
 *       reliance on the StateChange push to fill Sent),
 *   (2) the UI, after navigating to Sent,
 *   (3) the server, via direct Email/query against the Sent mailbox.
 *
 * The Sent folder is warmed up before send so a mailbox-window
 * query_view exists for the SEND apply step to prepend into; without a
 * pre-existing view the apply path can only persist the message and
 * the row would still appear in listMessagesForView only after the
 * next folder visit.
 */

// temp skipping until get running, remove when ready to test this one
test.skip();

test.skip(!liveE2eEnabled, skipLiveE2eMessage);

function composeInput(page, label) {
  return page.locator('.compose-dialog .row')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator('input')
    .first();
}

async function findSentMessageBySubject(jmap, sentMailbox, subject) {
  const payload = await jmapRequest(jmap, [
    [
      'Email/query',
      {
        accountId: jmap.accountId,
        filter: {
          operator: 'AND',
          conditions: [
            { inMailbox: sentMailbox.id },
            { subject },
          ],
        },
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit: 5,
      },
      'q1',
    ],
  ]);
  const ids = pickResponse(payload, 'Email/query')?.ids ?? [];
  return ids[0] ?? null;
}

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

test.describe('Compose + send e2e', () => {
  test.beforeEach(async ({ sharedPage }) => {
    await resetSharedSession(sharedPage);
  });

  test('Send delivers a self-addressed message into Sent (UI + cache + JMAP)', async ({ sharedPage: page }, testInfo) => {
    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const sent = mailboxByRole(mailboxes, 'sent');
    const trash = mailboxByRole(mailboxes, 'trash');
    if (!sent || !trash) {
      throw new Error(
        `Test requires Sent and Trash mailboxes; saw ${mailboxes.map((m) => `${m.name}:${m.role}`).join(', ')}`,
      );
    }

    const recipient = selfEmail();
    const subject = `Compose send e2e ${Date.now()}`;
    let serverId = null;
    try {
      // Warm up the Sent folder so a mailbox-window query_view exists
      // before send runs. The post-send apply step prepends the new
      // remote_id into existing Sent views; if no view exists it can
      // only persist the message and the synchronous cache assertion
      // below would have nothing positional to find. Realistic user
      // behaviour: most users have visited Sent at least once before
      // their next compose.
      await clickFolder(page, sent.name);
      await clickFolder(page, 'Inbox');

      // Open compose. Ctrl+N is the documented compose shortcut and is
      // already exercised in keyboard-shortcuts.spec.js; we use the UI
      // path here so this spec stands alone.
      await page.keyboard.press('ControlOrMeta+n');
      await expect(page.locator('.compose-dialog')).toBeVisible({ timeout: 10_000 });

      // Identities sync runs in the background after connect; under
      // firefox we sometimes open compose before it lands. Without an
      // identity, send() fails with "No identities are configured."
      // and the dialog stays open. Wait until the From <select> in
      // particular has at least one option. The From select is the
      // first <select> in the dialog (toolbar font/size selects come
      // later); scoping by position avoids the `<label>` regex trick,
      // which breaks the moment options populate and push their text
      // into the row's text content.
      const fromSelect = page.locator('.compose-dialog select').first();
      await expect.poll(
        async () => fromSelect.locator('option').count(),
        { timeout: 30_000, message: 'identity sync should populate the From dropdown' },
      ).toBeGreaterThan(0);

      await composeInput(page, 'To').fill(recipient);
      await composeInput(page, 'Subject').fill(subject);

      // Squire contenteditable body — click and type so the compose
      // store picks up htmlBody and textBody.
      const editor = page.locator('.compose-dialog .editor[contenteditable]').first();
      await editor.click();
      await page.keyboard.type('Hello from the compose+send e2e.');

      await page.locator('.compose-dialog button.primary', { hasText: /^Send$/ }).click();

      await expect(page.locator('.compose-dialog')).toBeHidden({ timeout: 30_000 });
      await waitForPendingMutations(page);

      // Synchronous cache check (Constitution IV.2): once the SEND
      // mutation has drained, listMessagesForView for Sent must
      // already contain the new email. The 2s polling budget catches
      // the rAF/microtask hop between the worker write and the
      // BroadcastChannel notification but is well under the
      // StateChange push round trip; a regression to push-driven
      // reconciliation will time out here on Chromium and Firefox.
      const sentLocalId = await page.evaluate(async (sentRemoteId) => {
        const accounts = await globalThis.__repo.listAccounts();
        const folders = await globalThis.__repo.listFolders(accounts[0].id);
        return folders.find((f) => f.remote_id === sentRemoteId)?.id ?? null;
      }, sent.id);
      expect(sentLocalId, 'Sent folder should be known locally after the warm-up').not.toBeNull();
      await expect.poll(
        async () => page.evaluate(async (folderId) => {
          if (!globalThis.__repo) return [];
          const accounts = await globalThis.__repo.listAccounts();
          const accountId = accounts?.[0]?.id;
          if (accountId == null) return [];
          const rows = await globalThis.__repo.listMessagesForView({
            accountId,
            folderId,
            sort: 'sent',
            offset: 0,
            limit: 5,
          });
          return rows.map((r) => r?.subject ?? null);
        }, sentLocalId),
        { timeout: 2_000, message: 'Sent cache should contain the sent message immediately after the SEND mutation drains' },
      ).toContain(subject);

      // UI: the new message lands in Sent.
      await clickFolder(page, sent.name);
      await expect.poll(
        async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
        { timeout: 30_000, message: `expected "${subject}" to appear in Sent` },
      ).toBeGreaterThan(0);

      // Server: Email/query against Sent finds exactly the message.
      try {
        await expect.poll(
          async () => findSentMessageBySubject(jmap, sent, subject),
          { timeout: 30_000, message: 'JMAP Email/query should find the sent message in Sent' },
        ).not.toBeNull();
      } catch (err) {
        const mutationRows = await readRecentMutations(page);
        await testInfo.attach('recent-mutations.json', {
          body: JSON.stringify(mutationRows, null, 2),
          contentType: 'application/json',
        });
        throw err;
      }
      serverId = await findSentMessageBySubject(jmap, sent, subject);

      // Local cache: the Sent view contains the server id.
      const sentCache = await readViewCacheForFolderRole(page, 'sent');
      expect(sentCache, 'local Sent cache should be reachable via window.__repo').not.toBeNull();
      expect(sentCache.remoteIds, 'sent remote id should be in the Sent cache').toContain(serverId);

      // Local cache: the sent copy is already read before any push-driven
      // reconciliation can repair it.
      const sentSeenState = await page.evaluate(async ({ remoteId, folderId }) => {
        if (!globalThis.__repo) return null;
        const accounts = await globalThis.__repo.listAccounts();
        const accountId = accounts?.[0]?.id;
        if (accountId == null) return null;
        const rows = await globalThis.__repo.listMessagesForView({
          accountId,
          folderId,
          sort: 'sent',
          offset: 0,
          limit: 10,
        });
        const row = rows.find((candidate) => candidate.remote_id === remoteId);
        return row ? Number(row.is_seen) : null;
      }, { remoteId: serverId, folderId: sentLocalId });
      expect(sentSeenState, 'local Sent cache should mark the sent message read').toBe(1);

      // Server: Thunderbird Desktop sees the same canonical read state.
      await expect.poll(
        async () => {
          const keywords = await getEmailKeywords(jmap, serverId);
          if (!keywords) return 'missing';
          return keywords.$seen === true ? 'seen' : 'unseen';
        },
        { timeout: 30_000, message: 'server should mark the sent message read with $seen' },
      ).toBe('seen');
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      if (serverId) {
        await cleanupEmail(jmap, serverId, trash.id);
      }
    }
  });
});
