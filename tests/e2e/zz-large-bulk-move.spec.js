import { test, expect } from '@playwright/test';

import {
  connectJmap,
  countMessagesInMailboxBySubjectPrefix,
  createEmailsInMailbox,
  destroyEmails,
  ensureMailbox,
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
  trackConsole,
  waitForPendingMutations,
  waitForShellReady,
} from './helpers/ui.js';

// Default an uneven count (1033) so off-by-one chunking bugs in the
// bulk move path don't get masked by a round number. Override via
// LARGE_BULK_MOVE_COUNT for stress runs.
const MOVE_COUNT = Number(process.env.LARGE_BULK_MOVE_COUNT ?? 1_033);
const SOURCE_FOLDER = 'Large Move Source';
const DEST_FOLDER = 'Large Move Destination';
const SUBJECT_PREFIX = 'Large move e2e';
const BULK_DRAG_MIME = 'application/x-stormbox-message-ids';
const VIEW_PAGE_SIZE = 500;

test.skip(!localStackEnabled, skipLocalStackMessage);
test.setTimeout(3 * 60 * 1000);

test.describe('Large bulk move e2e', () => {
  test.describe.configure({ retries: 0 });

  test.beforeEach(async () => {
    const jmap = await connectJmap();
    await sweepOrphanTestMessages(jmap, {
      subjectPrefix: SUBJECT_PREFIX,
      throwOnError: true,
    });
  });

  test('moves a large message set through the real UI path', async ({ page }, testInfo) => {
    const consoleLines = [];
    trackConsole(page, consoleLines);

    const jmap = await connectJmap();
    const fromEmail = selfEmail();
    const source = await ensureMailbox(jmap, { name: SOURCE_FOLDER });
    const destination = await ensureMailbox(jmap, { name: DEST_FOLDER });

    // Hoisted so the finally block can call destroyEmails on the
    // exact ids we created. Skipping the Email/query phase the
    // sweep would otherwise pay cuts cleanup from ~10 round trips
    // to one batched destroy per chunkSize (default 500).
    let remoteIds = [];
    try {
      remoteIds = await createEmailsInMailbox(jmap, {
        mailboxId: source.id,
        fromEmail,
        subjectPrefix: SUBJECT_PREFIX,
        count: MOVE_COUNT,
        batchSize: 500,
      });
      await expect.poll(
        () => countMessagesInMailboxBySubjectPrefix(jmap, {
          mailboxId: source.id,
          subjectPrefix: SUBJECT_PREFIX,
        }),
        { timeout: 60_000, message: `expected ${MOVE_COUNT} large-move messages in source mailbox` },
      ).toBe(MOVE_COUNT);

      await loginViaOidc(page);
      await waitForShellReady(page);
      await page.waitForFunction(() => !!window.__repo, { timeout: 30_000 });

      const loaded = await loadSourceView(page, {
        sourceName: SOURCE_FOLDER,
        count: MOVE_COUNT,
      });
      expect(loaded.total).toBe(MOVE_COUNT);
      expect(loaded.covered).toBe(MOVE_COUNT);
      expect(loaded.ids).toHaveLength(MOVE_COUNT);

      await clickFolder(page, SOURCE_FOLDER);
      await expect(page.locator('.msg-list__count')).toHaveText(`${MOVE_COUNT} messages`, { timeout: 10_000 });

      await dispatchBulkDrop(page, {
        ids: loaded.ids,
        sourceFolderId: loaded.sourceFolderId,
        destinationName: DEST_FOLDER,
      });
      await waitForPendingMutations(page, { timeout: 120_000 });

      await expect(
        page.locator('.msg-list__count'),
        'source folder count should clear without a manual refresh',
      ).toHaveCount(0);
      const sourceProgress = await readFolderProgressByName(page, SOURCE_FOLDER);
      expect(sourceProgress.total).toBe(0);

      await clickFolder(page, DEST_FOLDER);
      await expect(
        page.locator('.msg-list__count'),
        'destination folder count should be correct immediately after navigation',
      ).toHaveText(`${MOVE_COUNT} messages`, { timeout: 10_000 });
      const destinationProgress = await readFolderProgressByName(page, DEST_FOLDER);
      expect(destinationProgress.total).toBe(MOVE_COUNT);

      await expect.poll(
        () => countMessagesInMailboxBySubjectPrefix(jmap, {
          mailboxId: source.id,
          subjectPrefix: SUBJECT_PREFIX,
        }),
        { timeout: 120_000, message: 'server should report large-move messages gone from source' },
      ).toBe(0);
      await expect.poll(
        () => countMessagesInMailboxBySubjectPrefix(jmap, {
          mailboxId: destination.id,
          subjectPrefix: SUBJECT_PREFIX,
        }),
        { timeout: 120_000, message: 'server should report large-move messages in destination' },
      ).toBe(MOVE_COUNT);
    } catch (err) {
      const mutationRows = await readRecentMutations(page).catch(() => []);
      const bulkState = await page.evaluate(() => globalThis.__stormboxBulkDebug?.()).catch(() => null);
      await testInfo.attach('recent-mutations.json', {
        body: JSON.stringify(mutationRows, null, 2),
        contentType: 'application/json',
      });
      await testInfo.attach('bulk-state.json', {
        body: JSON.stringify(bulkState, null, 2),
        contentType: 'application/json',
      });
      throw err;
    } finally {
      await attachConsoleTail(testInfo, consoleLines);
      // Fast path: destroy the ids we tracked. Falls back to the
      // sweep below for anything that slipped through (e.g. an
      // earlier interrupted run that left orphans).
      if (remoteIds.length > 0) {
        await destroyEmails(jmap, remoteIds).catch((err) => {
          console.warn(`[large-bulk-move] destroyEmails failed, falling back to sweep: ${err?.message ?? err}`);
        });
      }
      await sweepOrphanTestMessages(jmap, { subjectPrefix: SUBJECT_PREFIX });
    }
  });
});

async function loadSourceView(page, { sourceName, count }) {
  return page.evaluate(async ({ sourceName: name, count: expectedCount, pageSize }) => {
    const repo = globalThis.__repo;
    const accounts = await repo.listAccounts();
    const account = accounts[0];
    if (!account) throw new Error('No local account after login');

    await repo.ensureFolderTree(account.id);
    const folders = await repo.listFolders(account.id);
    const source = folders.find((folder) => folder.name === name);
    if (!source) {
      throw new Error(`Missing local source folder: ${name}`);
    }

    const localIds = [];
    for (let offset = 0; offset < expectedCount; offset += pageSize) {
      const limit = Math.min(pageSize, expectedCount - offset);
      await repo.ensureFolderWindow(account.id, source.id, { offset, limit });
      const rows = await repo.listMessagesForView({
        accountId: account.id,
        folderId: source.id,
        sort: 'received',
        offset,
        limit,
      });
      localIds.push(...rows.map((row) => Number(row.id)));
    }

    const progress = await repo.queryViewProgress({
      accountId: account.id,
      folderId: source.id,
      sort: 'received',
    });
    return {
      sourceFolderId: source.id,
      total: Number(progress.total),
      covered: Number(progress.covered),
      ids: localIds,
    };
  }, { sourceName, count, pageSize: VIEW_PAGE_SIZE });
}

async function dispatchBulkDrop(page, { ids, sourceFolderId, destinationName }) {
  await page.evaluate(({ ids: localIds, sourceFolderId: srcFolderId, destinationName: dstName, mime }) => {
    const folder = Array.from(document.querySelectorAll('.folder-node'))
      .find((el) => (el.textContent ?? '').toLowerCase().includes(dstName.toLowerCase()));
    if (!folder) throw new Error(`Destination folder "${dstName}" not found in DOM`);

    const transfer = new DataTransfer();
    transfer.effectAllowed = 'move';
    transfer.setData(mime, JSON.stringify({
      ids: localIds,
      sourceFolderId: srcFolderId,
    }));
    transfer.setData('text/plain', `${localIds.length} messages`);

    for (const type of ['dragenter', 'dragover', 'drop']) {
      const event = new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      });
      folder.dispatchEvent(event);
    }
  }, {
    ids,
    sourceFolderId,
    destinationName,
    mime: BULK_DRAG_MIME,
  });
}

async function readFolderProgressByName(page, folderName) {
  return page.evaluate(async (name) => {
    const repo = globalThis.__repo;
    const accounts = await repo.listAccounts();
    const account = accounts[0];
    const folders = await repo.listFolders(account.id);
    const folder = folders.find((f) => f.name === name);
    if (!folder) throw new Error(`Folder "${name}" not found`);
    return repo.queryViewProgress({
      accountId: account.id,
      folderId: folder.id,
      sort: 'received',
    });
  }, folderName);
}
