import { test, expect } from '@playwright/test';

import {
  cleanupEmail,
  connectJmap,
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
  waitForInboxReady,
  waitForPendingMutations,
} from './helpers/ui.js';

/**
 * Compose + send (R-4.4, SC-2) — Verified Consistency triple.
 *
 * Stormbox enqueues a SEND mutation that chains Email/set +
 * EmailSubmission/set with onSuccessUpdateEmail to move the freshly
 * created draft into Sent. This spec drives the compose dialog through
 * Send and asserts the resulting message is present in Sent in the UI,
 * the local cache, and on the server (via direct Email/query against
 * the Sent mailbox).
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

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

test.describe('Compose + send e2e', () => {
  test.beforeEach(async () => {
    const jmap = await connectJmap();
    await sweepOrphanTestMessages(jmap, { subjectPrefix: 'Compose send e2e' });
  });

  test('Send delivers a self-addressed message into Sent (UI + cache + JMAP)', async ({ page }, testInfo) => {
    const consoleLines = [];
    trackConsole(page, consoleLines);

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
      await loginViaOidc(page);
      // waitForInboxReady waits until the Inbox folder is auto-selected
      // and at least one message has rendered. That synchronises us
      // with App.vue's onMounted chain (authStore.initialize -> mailStore
      // -> contactsStore -> composeStore.attach), so by the time we
      // open compose its accountId watch has fired and refreshIdentities
      // has had a chance to populate the From dropdown.
      await waitForInboxReady(page);

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
    } finally {
      await attachConsoleTail(testInfo, consoleLines);
      if (serverId) {
        await cleanupEmail(jmap, serverId, trash.id);
      }
    }
  });
});
