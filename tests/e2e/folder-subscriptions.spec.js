import {
  connectJmap,
  ensureMailbox,
  jmapRequest,
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
import { waitForPendingMutations } from './helpers/ui.js';

/**
 * Folder subscriptions — Verified Consistency triple.
 *
 * Toggling a folder in the "Manage folders" dialog enqueues a
 * SET_MAILBOX_SUBSCRIPTION mutation that issues a JMAP Mailbox/set
 * updating isSubscribed (RFC 8621 §2). This spec asserts the dialog
 * checkbox state (UI), the folders.is_subscribed column via
 * window.__repo (cache), and the Mailbox isSubscribed property via
 * direct JMAP (server), in both directions.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

// Distinctive, non-stemmed token so shared-session sweeps and other
// specs' FTS subject filters can never collide with this folder name.
const TEST_FOLDER_NAME = 'SubsToggle';

async function getServerSubscription(jmap, mailboxId) {
  const payload = await jmapRequest(jmap, [[
    'Mailbox/get',
    {
      accountId: jmap.accountId,
      ids: [mailboxId],
      properties: ['id', 'isSubscribed'],
    },
    'gSub',
  ]]);
  const row = pickResponse(payload, 'Mailbox/get')?.list?.[0] ?? null;
  return row ? row.isSubscribed === true : null;
}

async function setServerSubscription(jmap, mailboxId, isSubscribed) {
  const payload = await jmapRequest(jmap, [[
    'Mailbox/set',
    {
      accountId: jmap.accountId,
      update: { [mailboxId]: { isSubscribed } },
    },
    'sSub',
  ]]);
  const set = pickResponse(payload, 'Mailbox/set');
  if (set?.notUpdated?.[mailboxId]) {
    throw new Error(`Could not set isSubscribed baseline: ${JSON.stringify(set.notUpdated[mailboxId])}`);
  }
}

async function readCachedSubscription(page, remoteId) {
  return page.evaluate(async (rid) => {
    if (!globalThis.__repo) return null;
    const rows = await globalThis.__repo.call('db.query', {
      sql: 'SELECT is_subscribed FROM folders WHERE remote_id = ? AND is_deleted = 0',
      params: [rid],
    });
    if (!rows || rows.length === 0) return null;
    return Number(rows[0].is_subscribed);
  }, remoteId);
}

test.describe('Folder subscriptions e2e', () => {
  test.beforeEach(async ({ sharedPage }) => {
    await resetSharedSession(sharedPage);
  });

  test('Manage folders checkbox round-trips isSubscribed through UI, cache, and server', async ({ sharedPage: page }, testInfo) => {
    const jmap = await connectJmap();
    const mailbox = await ensureMailbox(jmap, { name: TEST_FOLDER_NAME });
    // Known baseline: subscribed. Stalwart leaves Mailbox/set creates
    // unsubscribed, so an idempotent re-run needs the explicit set.
    await setServerSubscription(jmap, mailbox.id, true);

    try {
      // The folder is on the signed-in account, so it renders in the
      // sidebar regardless of subscription state; wait for the sync.
      await expect(
        page.locator('.folder-node').filter({ hasText: TEST_FOLDER_NAME }).first(),
      ).toBeVisible({ timeout: 30_000 });

      await page.locator('.folder-tree__manage').click();
      const dialog = page.locator('[role="dialog"]').filter({ hasText: 'Folder subscriptions' });
      await expect(dialog).toBeVisible({ timeout: 10_000 });

      const checkbox = dialog.locator(`input[data-folder-name="${TEST_FOLDER_NAME}"]`);
      // The direct JMAP baseline set may reach the client via push a
      // moment after the sidebar rendered; poll until it lands.
      await expect(checkbox).toBeChecked({ timeout: 30_000 });

      // Unsubscribe.
      await checkbox.click();
      await waitForPendingMutations(page);
      await expect(checkbox).not.toBeChecked({ timeout: 10_000 });
      await expect(checkbox).toBeEnabled({ timeout: 10_000 });

      await expect.poll(
        async () => readCachedSubscription(page, mailbox.id),
        { timeout: 10_000, message: 'local cache should record is_subscribed = 0' },
      ).toBe(0);
      await expect.poll(
        async () => getServerSubscription(jmap, mailbox.id),
        { timeout: 10_000, message: 'server should report isSubscribed false' },
      ).toBe(false);

      // Subscribe again.
      await checkbox.click();
      await waitForPendingMutations(page);
      await expect(checkbox).toBeChecked({ timeout: 10_000 });

      await expect.poll(
        async () => readCachedSubscription(page, mailbox.id),
        { timeout: 10_000, message: 'local cache should record is_subscribed = 1' },
      ).toBe(1);
      await expect.poll(
        async () => getServerSubscription(jmap, mailbox.id),
        { timeout: 10_000, message: 'server should report isSubscribed true' },
      ).toBe(true);

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden({ timeout: 5_000 });
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
    }
  });
});
