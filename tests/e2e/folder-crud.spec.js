import {
  connectJmap,
  createEmailInMailbox,
  ensureMailbox,
  jmapRequest,
  listMailboxes,
  pickResponse,
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
  skipLocalStackMessage,
  TEST_THUNDERMAIL,
} from './helpers/stack-env.js';
import { waitForPendingMutations } from './helpers/ui.js';

/**
 * Folder create / rename / delete — Verified Consistency triple.
 *
 * The Manage-folders dialog (its "New folder" button, row editor, and
 * bulk-delete bar) enqueues CREATE/UPDATE/DESTROY_MAILBOX mutations
 * that issue Mailbox/set (RFC 8621 §2.5). Each step asserts the
 * sidebar (UI), the folders table via window.__repo (cache), and
 * Mailbox/get via direct JMAP (server). The delete leg seeds a message
 * first so the onDestroyRemoveEmails escalation path (mailboxHasEmail
 * SetError -> second confirmation -> retry with true) is exercised
 * against the real server, not a mock.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

// Distinctive non-stemmed tokens; see folder-subscriptions.spec.js.
const CREATE_NAME = 'CrudCreate';
const RENAMED_NAME = 'CrudRenamed';
const BULK_A = 'BulkCrudA';
const BULK_B = 'BulkCrudB';
const SWEEP_SUBJECT = 'CrudSeed e2e';

async function getServerMailboxByName(jmap, name) {
  const mailboxes = await listMailboxes(jmap);
  return mailboxes.find((m) => (m.name ?? '') === name) ?? null;
}

async function destroyServerMailboxByName(jmap, name) {
  const mailbox = await getServerMailboxByName(jmap, name);
  if (!mailbox) return;
  await jmapRequest(jmap, [[
    'Mailbox/set',
    {
      accountId: jmap.accountId,
      destroy: [mailbox.id],
      onDestroyRemoveEmails: true,
    },
    'cleanup',
  ]]);
}

async function readCachedFolderByName(page, name) {
  return page.evaluate(async (folderName) => {
    if (!globalThis.__repo) return null;
    const rows = await globalThis.__repo.call('db.query', {
      sql: `SELECT remote_id, name, parent_id, is_subscribed, is_deleted
              FROM folders WHERE name = ? AND is_deleted = 0`,
      params: [folderName],
    });
    return rows?.[0] ?? null;
  }, name);
}

async function openManageDialog(page, searchText) {
  await page.locator('.folder-tree__manage').click();
  const dialog = page.locator('[role="dialog"]').filter({ hasText: 'Manage Folders' });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  if (searchText) {
    // The list is virtualized; searching guarantees the target row is
    // mounted regardless of how many folders the account has.
    await dialog.locator('.folder-subs__search-input').fill(searchText);
  }
  return dialog;
}

test.describe('Folder create/rename/delete e2e', () => {
  test.beforeEach(async ({ sharedPage }) => {
    await resetSharedSession(sharedPage);
  });

  test('create, rename, and delete round-trip through UI, cache, and server', async ({ sharedPage: page }, testInfo) => {
    const jmap = await connectJmap();
    // Idempotent baseline: a previous aborted run may have left either
    // name behind.
    await destroyServerMailboxByName(jmap, CREATE_NAME);
    await destroyServerMailboxByName(jmap, RENAMED_NAME);

    try {
      await expect(page.locator('.folder-tree__manage')).toBeVisible({ timeout: 30_000 });

      // ---- create (via the manager's "New folder" button) --------------
      let dialog = await openManageDialog(page);
      await dialog.locator('[data-folder-new]').click();
      // The manager dialog also contains the literal text "New folder"
      // (its header button), so match on the accessible dialog name.
      const createDialog = page.getByRole('dialog', { name: 'New folder' });
      await expect(createDialog).toBeVisible({ timeout: 10_000 });
      await createDialog.locator('[data-folder-create-name]').fill(CREATE_NAME);
      await createDialog.locator('[data-folder-create-submit]').click();
      await waitForPendingMutations(page);
      await expect(createDialog).toBeHidden({ timeout: 10_000 });
      // Close the manager again so the sidebar assertions run unobscured.
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden({ timeout: 5_000 });

      const createdNode = page.locator('.folder-node').filter({ hasText: CREATE_NAME }).first();
      await expect(createdNode).toBeVisible({ timeout: 10_000 });

      const cachedCreated = await readCachedFolderByName(page, CREATE_NAME);
      expect(cachedCreated).toBeTruthy();
      expect(Number(cachedCreated.is_subscribed)).toBe(1);

      const serverCreated = await getServerMailboxByName(jmap, CREATE_NAME);
      expect(serverCreated).toBeTruthy();
      expect(cachedCreated.remote_id).toBe(serverCreated.id);

      // ---- rename ----------------------------------------------------
      dialog = await openManageDialog(page, CREATE_NAME);
      await dialog.locator(`[data-folder-edit="${CREATE_NAME}"]`).click();
      await dialog.locator('[data-folder-rename-input]').fill(RENAMED_NAME);
      await dialog.locator('[data-folder-save]').click();
      // The row editor closes when the rename lands. Wait for it before
      // pressing Escape — while the editor is open, Escape closes the
      // editor rather than the dialog.
      await expect(dialog.locator('[data-folder-rename-input]')).toBeHidden({ timeout: 10_000 });
      await waitForPendingMutations(page);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden({ timeout: 5_000 });

      await expect(
        page.locator('.folder-node').filter({ hasText: RENAMED_NAME }).first(),
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        page.locator('.folder-node').filter({ hasText: CREATE_NAME }),
      ).toHaveCount(0);

      await expect.poll(
        async () => (await readCachedFolderByName(page, RENAMED_NAME))?.remote_id ?? null,
        { timeout: 10_000, message: 'cache should carry the renamed row' },
      ).toBe(serverCreated.id);
      await expect.poll(
        async () => (await getServerMailboxByName(jmap, RENAMED_NAME))?.id ?? null,
        { timeout: 10_000, message: 'server should report the new name' },
      ).toBe(serverCreated.id);

      // ---- delete (escalation path) -----------------------------------
      // Seed one message so the first destroy attempt
      // (onDestroyRemoveEmails: false) is rejected with mailboxHasEmail.
      await createEmailInMailbox(jmap, {
        mailboxId: serverCreated.id,
        fromEmail: TEST_THUNDERMAIL,
        subject: `${SWEEP_SUBJECT} ${Date.now()}`,
      });

      dialog = await openManageDialog(page, RENAMED_NAME);
      await dialog.locator(`[data-folder-edit="${RENAMED_NAME}"]`).click();
      await dialog.locator('[data-folder-delete]').click();
      await expect(dialog).toContainText(`Delete “${RENAMED_NAME}”?`, { timeout: 5_000 });

      // First confirmation: server refuses (folder still has mail) and
      // the dialog escalates to the permanent-delete warning.
      await dialog.locator('[data-folder-delete-confirm]').click();
      await expect(dialog).toContainText('permanently delete', { timeout: 10_000 });

      // Escalated confirmation retries with onDestroyRemoveEmails: true.
      // The editor closes itself once the destroy lands (see the rename
      // step for why Escape must wait for that).
      await dialog.locator('[data-folder-delete-confirm]').click();
      await expect(dialog.locator('[data-folder-delete-confirm]')).toBeHidden({ timeout: 10_000 });
      await waitForPendingMutations(page);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden({ timeout: 5_000 });

      await expect(
        page.locator('.folder-node').filter({ hasText: RENAMED_NAME }),
      ).toHaveCount(0, { timeout: 10_000 });
      await expect.poll(
        async () => readCachedFolderByName(page, RENAMED_NAME),
        { timeout: 10_000, message: 'cache row should be soft-deleted' },
      ).toBeNull();
      await expect.poll(
        async () => getServerMailboxByName(jmap, RENAMED_NAME),
        { timeout: 10_000, message: 'server should no longer list the mailbox' },
      ).toBeNull();
    } finally {
      await destroyServerMailboxByName(jmap, CREATE_NAME);
      await destroyServerMailboxByName(jmap, RENAMED_NAME);
      await sweepOrphanTestMessages(jmap, { subjectPrefix: SWEEP_SUBJECT });
      await attachConsoleTail(testInfo, consoleLinesFor(page));
    }
  });

  test('bulk delete removes selected folders, escalating for the one with mail', async ({ sharedPage: page }, testInfo) => {
    const jmap = await connectJmap();
    await destroyServerMailboxByName(jmap, BULK_A);
    await destroyServerMailboxByName(jmap, BULK_B);
    const boxB = await ensureMailbox(jmap, { name: BULK_B });
    await ensureMailbox(jmap, { name: BULK_A });
    // BULK_B holds a message so the first bulk pass
    // (onDestroyRemoveEmails: false) is rejected with mailboxHasEmail
    // and the action bar escalates; BULK_A deletes in the first pass.
    await createEmailInMailbox(jmap, {
      mailboxId: boxB.id,
      fromEmail: TEST_THUNDERMAIL,
      subject: `${SWEEP_SUBJECT} bulk ${Date.now()}`,
    });

    try {
      await expect(
        page.locator('.folder-node').filter({ hasText: BULK_A }).first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.locator('.folder-node').filter({ hasText: BULK_B }).first(),
      ).toBeVisible({ timeout: 30_000 });

      // Both names share the BulkCrud token, so one search shows both.
      const dialog = await openManageDialog(page, 'BulkCrud');
      await dialog.locator(`input[data-folder-select="${BULK_A}"]`).check();
      await dialog.locator(`input[data-folder-select="${BULK_B}"]`).check();
      const bulkbar = dialog.locator('[data-folder-bulkbar]');
      await expect(bulkbar).toContainText('2 selected');

      await bulkbar.locator('[data-folder-bulk-delete]').click();
      await expect(bulkbar).toContainText('Delete 2 folders?');
      await bulkbar.locator('[data-folder-bulk-confirm]').click();

      // First pass: BULK_A destroyed, BULK_B refused (mailboxHasEmail).
      await expect(bulkbar).toContainText('permanently delete', { timeout: 15_000 });
      await bulkbar.locator('[data-folder-bulk-confirm]').click();
      await expect(dialog.locator('[data-folder-bulkbar]')).toBeHidden({ timeout: 15_000 });
      await waitForPendingMutations(page);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden({ timeout: 5_000 });

      for (const name of [BULK_A, BULK_B]) {
        await expect(
          page.locator('.folder-node').filter({ hasText: name }),
        ).toHaveCount(0, { timeout: 10_000 });
        await expect.poll(
          async () => readCachedFolderByName(page, name),
          { timeout: 10_000, message: `cache row for ${name} should be soft-deleted` },
        ).toBeNull();
        await expect.poll(
          async () => getServerMailboxByName(jmap, name),
          { timeout: 10_000, message: `server should no longer list ${name}` },
        ).toBeNull();
      }
    } finally {
      await destroyServerMailboxByName(jmap, BULK_A);
      await destroyServerMailboxByName(jmap, BULK_B);
      await sweepOrphanTestMessages(jmap, { subjectPrefix: SWEEP_SUBJECT });
      await attachConsoleTail(testInfo, consoleLinesFor(page));
    }
  });

  test('system folders expose no subscription, selection, or edit controls', async ({ sharedPage: page }, testInfo) => {
    try {
      const dialog = await openManageDialog(page, 'Inbox');
      await expect(
        dialog.locator('.folder-subs__row').filter({ hasText: 'Inbox' }).first(),
      ).toContainText('always shown', { timeout: 10_000 });
      await expect(dialog.locator('[data-folder-name="Inbox"]')).toHaveCount(0);
      await expect(dialog.locator('input[data-folder-select="Inbox"]')).toHaveCount(0);
      await expect(dialog.locator('[data-folder-edit="Inbox"]')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden({ timeout: 5_000 });
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
    }
  });
});
