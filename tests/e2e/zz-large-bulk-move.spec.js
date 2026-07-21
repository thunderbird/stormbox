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
// bulk overlay / outbox apply path don't get masked by a round
// number. Override via LARGE_BULK_MOVE_COUNT for stress runs.
const MOVE_COUNT = Number(process.env.LARGE_BULK_MOVE_COUNT ?? 1_033);
const SOURCE_FOLDER = 'Large Move Source';
const DEST_FOLDER = 'Large Move Destination';
const SUBJECT_PREFIX = 'Large move e2e';
const BULK_DRAG_MIME = 'application/x-stormbox-message-ids';

test.skip(!localStackEnabled, skipLocalStackMessage);
test.setTimeout(8 * 60 * 1000);

test.describe('Large bulk move e2e', () => {
  test.describe.configure({ retries: 0 });

  test.beforeEach(async () => {
    const jmap = await connectJmap();
    await sweepOrphanTestMessages(jmap, {
      subjectPrefix: SUBJECT_PREFIX,
      throwOnError: true,
    });
  });

  test('moves a large message set with modal progress on the real UI path', async ({ page }, testInfo) => {
    const consoleLines = [];
    const timings = [];
    let phaseStart = Date.now();
    const mark = (name) => {
      const now = Date.now();
      timings.push({ name, ms: now - phaseStart });
      phaseStart = now;
    };
    trackConsole(page, consoleLines);

    const jmap = await connectJmap();
    const fromEmail = selfEmail();
    const source = await ensureMailbox(jmap, { name: SOURCE_FOLDER });
    const destination = await ensureMailbox(jmap, { name: DEST_FOLDER });
    mark('connect-and-mailboxes');

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
      mark('server-create');
      await expect.poll(
        () => countMessagesInMailboxBySubjectPrefix(jmap, {
          mailboxId: source.id,
          subjectPrefix: SUBJECT_PREFIX,
        }),
        { timeout: 60_000, message: `expected ${MOVE_COUNT} large-move messages in source mailbox` },
      ).toBe(MOVE_COUNT);
      mark('server-source-count');

      await loginViaOidc(page);
      await waitForShellReady(page);
      await page.waitForFunction(() => !!window.__repo, { timeout: 30_000 });
      mark('login-and-shell');

      const indexed = await seedLocalSourceView(page, {
        sourceName: SOURCE_FOLDER,
        destinationName: DEST_FOLDER,
        subjectPrefix: SUBJECT_PREFIX,
        remoteIds,
        fromEmail,
      });
      expect(indexed.total).toBe(MOVE_COUNT);
      expect(indexed.covered).toBe(MOVE_COUNT);
      expect(indexed.ids).toHaveLength(MOVE_COUNT);
      mark('seed-local-cache');

      await page.reload();
      await waitForShellReady(page);
      await page.waitForFunction(() => !!window.__repo, { timeout: 30_000 });

      await clickFolder(page, SOURCE_FOLDER);
      await expect(page.locator('.msg-list__count')).toHaveText(`${MOVE_COUNT} messages`, { timeout: 10_000 });
      mark('reload-and-open-source');
      const overlay = page.locator('.bulk-overlay');
      // Record overlay text in-page before the drop: the move finishes in
      // tens of ms, so out-of-process polling can't catch the modal before
      // it dismisses. A MutationObserver captures it deterministically.
      await page.evaluate(() => {
        const seen = [];
        globalThis.__bulkProgressSeen = seen;
        const record = () => {
          const txt = document.querySelector('.bulk-overlay__sub')?.textContent ?? '';
          if (txt && txt !== seen[seen.length - 1]) seen.push(txt);
        };
        const obs = new MutationObserver(record);
        obs.observe(document.body, { childList: true, subtree: true, characterData: true });
        globalThis.__bulkProgressObs = obs;
        record();
      });

      await dispatchBulkDrop(page, {
        ids: indexed.ids,
        sourceFolderId: indexed.sourceFolderId,
        destinationName: DEST_FOLDER,
      });

      // The modal must run to completion and dismiss itself. The move is
      // fast, so a generous-but-finite timeout fails fast on a genuine
      // stall instead of hanging for minutes.
      await expect(overlay).toBeHidden({ timeout: 60_000 });
      const progressSeen = await page.evaluate(() => {
        globalThis.__bulkProgressObs?.disconnect();
        return globalThis.__bulkProgressSeen ?? [];
      });
      mark('ui-bulk-move');
      console.log(`[large-bulk-move progress] ${JSON.stringify(progressSeen)}`);
      // The backend owns wire chunking, so the overlay is intentionally
      // indeterminate. Assert that it engaged for the complete semantic
      // target set; source/destination counts below prove completion.
      expect(
        progressSeen.some((t) => t.includes(`${MOVE_COUNT.toLocaleString()} messages`)),
        `expected the bulk-progress overlay to engage with the full total; saw ${JSON.stringify(progressSeen)}`,
      ).toBe(true);
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
      mark('ui-count-assertions');

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
      mark('server-final-counts');
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
      const cleanupStart = Date.now();
      // Fast path: destroy the ids we tracked. Falls back to the
      // sweep below for anything that slipped through (e.g. an
      // earlier interrupted run that left orphans).
      if (remoteIds.length > 0) {
        await destroyEmails(jmap, remoteIds).catch((err) => {
          console.warn(`[large-bulk-move] destroyEmails failed, falling back to sweep: ${err?.message ?? err}`);
        });
      }
      await sweepOrphanTestMessages(jmap, { subjectPrefix: SUBJECT_PREFIX });
      timings.push({ name: 'cleanup', ms: Date.now() - cleanupStart });
      console.log(`[large-bulk-move timings] ${JSON.stringify(timings)}`);
      await testInfo.attach('phase-timings.json', {
        body: JSON.stringify(timings, null, 2),
        contentType: 'application/json',
      });
    }
  });
});

async function seedLocalSourceView(page, {
  sourceName, destinationName, subjectPrefix, remoteIds, fromEmail,
}) {
  return page.evaluate(async ({
    sourceName: srcName,
    destinationName: dstName,
    subjectPrefix: prefix,
    remoteIds: remotes,
    fromEmail: sender,
  }) => {
    const repo = globalThis.__repo;
    const accounts = await repo.listAccounts();
    const account = accounts[0];
    if (!account) throw new Error('No local account after login');
    const accountId = Number(account.id ?? account.account_id ?? account.local_id);
    if (!Number.isFinite(accountId)) {
      throw new Error(`Local account row is missing an id: ${JSON.stringify(account)}`);
    }

    await repo.ensureFolderTree(accountId);
    const folders = await repo.listFolders(accountId);
    const source = folders.find((f) => f.name === srcName);
    const destination = folders.find((f) => f.name === dstName);
    if (!source || !destination) {
      throw new Error(`Missing local source/destination folders: ${srcName}/${dstName}`);
    }

    const filterJson = JSON.stringify({ inMailbox: source.remote_id });
    const sortJson = JSON.stringify([{ property: 'receivedAt', isAscending: false }]);
    const now = Date.now();

    await repo.call('db.query', {
      sql: 'DELETE FROM messages WHERE account_id = ? AND subject LIKE ?',
      params: [accountId, `${prefix}%`],
    });
    await repo.call('db.query', {
      sql: 'DELETE FROM query_views WHERE account_id = ? AND folder_id IN (?, ?)',
      params: [accountId, source.id, destination.id],
    });
    await repo.call('db.query', {
      sql: `UPDATE folders
              SET total_emails = CASE WHEN id = ? THEN ? WHEN id = ? THEN 0 ELSE total_emails END,
                  unread_emails = CASE WHEN id IN (?, ?) THEN 0 ELSE unread_emails END,
                  updated_at = ?
            WHERE account_id = ?`,
      params: [source.id, remotes.length, destination.id, source.id, destination.id, now, accountId],
    });
    await repo.call('db.query', {
      sql: `INSERT INTO query_views(
              account_id, view_type, folder_id, filter_json, sort_json,
              collapse_threads, query_state, can_calculate_changes, total,
              stale, created_at, updated_at, last_accessed_at
            ) VALUES (?, 'mailbox-window', ?, ?, ?, 0, ?, 1, ?, 0, ?, ?, ?)
            ON CONFLICT(account_id, view_type, folder_id, filter_json, sort_json, collapse_threads)
            DO UPDATE SET query_state = excluded.query_state,
                          total = excluded.total,
                          stale = 0,
                          updated_at = excluded.updated_at,
                          last_accessed_at = excluded.last_accessed_at`,
      params: [accountId, source.id, filterJson, sortJson, `large-move-${now}`, remotes.length, now, now, now],
    });
    const viewRows = await repo.call('db.query', {
      sql: `SELECT id FROM query_views
             WHERE account_id = ?
               AND folder_id = ?
               AND view_type = 'mailbox-window'
               AND filter_json = ?
               AND sort_json = ?
               AND collapse_threads = 0
             LIMIT 1`,
      params: [accountId, source.id, filterJson, sortJson],
    });
    const viewId = Number(viewRows?.[0]?.id);
    if (!Number.isFinite(viewId)) throw new Error('Failed to create local source query_view');

    const localIds = [];
    for (let offset = 0; offset < remotes.length; offset += 500) {
      const batch = remotes.slice(offset, offset + 500);
      const messageValues = [];
      const messageParams = [];
      for (let i = 0; i < batch.length; i += 1) {
        const position = offset + i;
        const remoteId = batch[i];
        const receivedAt = now - position;
        messageValues.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        messageParams.push(
          accountId,
          remoteId,
          `${prefix} ${String(position).padStart(5, '0')}`,
          '{}',
          1,
          receivedAt,
          receivedAt,
          sender,
          now,
          now,
        );
      }
      await repo.call('db.query', {
        sql: `INSERT INTO messages(
                account_id, remote_id, subject, keywords_json, is_seen,
                received_at, sent_at, from_text, metadata_fetched_at, updated_at
              ) VALUES ${messageValues.join(',')}
              ON CONFLICT(account_id, remote_id) DO UPDATE SET
                subject = excluded.subject,
                keywords_json = excluded.keywords_json,
                is_seen = excluded.is_seen,
                received_at = excluded.received_at,
                sent_at = excluded.sent_at,
                from_text = excluded.from_text,
                metadata_fetched_at = excluded.metadata_fetched_at,
                updated_at = excluded.updated_at`,
        params: messageParams,
      });
      const placeholders = batch.map(() => '?').join(',');
      const rows = await repo.call('db.query', {
        sql: `SELECT id, remote_id FROM messages
               WHERE account_id = ? AND remote_id IN (${placeholders})`,
        params: [accountId, ...batch],
      });
      const byRemote = new Map(rows.map((row) => [row.remote_id, Number(row.id)]));
      const folderValues = [];
      const folderParams = [];
      const itemValues = [];
      const itemParams = [];
      for (let i = 0; i < batch.length; i += 1) {
        const position = offset + i;
        const remoteId = batch[i];
        const localId = byRemote.get(remoteId);
        if (!Number.isFinite(localId)) throw new Error(`Missing local id for ${remoteId}`);
        localIds.push(localId);
        const receivedAt = now - position;
        folderValues.push('(?, ?, ?, NULL, ?, ?, ?, NULL)');
        folderParams.push(source.id, localId, accountId, now, receivedAt, receivedAt);
        itemValues.push('(?, ?, ?, ?)');
        itemParams.push(viewId, position, localId, remoteId);
      }
      await repo.call('db.query', {
        sql: `INSERT OR REPLACE INTO folder_messages(
                folder_id, message_id, account_id, remote_membership_id,
                added_at, sort_received_at, sort_sent_at, instance_state_json
              ) VALUES ${folderValues.join(',')}`,
        params: folderParams,
      });
      await repo.call('db.query', {
        sql: `INSERT OR REPLACE INTO query_view_items(view_id, position, message_id, remote_id)
              VALUES ${itemValues.join(',')}`,
        params: itemParams,
      });
    }
    await repo.call('db.query', {
      sql: `INSERT OR REPLACE INTO query_view_ranges(view_id, start_position, end_position, fetched_at)
            VALUES (?, 0, ?, ?)`,
      params: [viewId, remotes.length, now],
    });
    const progress = await repo.queryViewProgress({
      accountId,
      folderId: source.id,
      sort: 'received',
    });
    return {
      sourceFolderId: source.id,
      destinationFolderId: destination.id,
      total: Number(progress.total),
      covered: Number(progress.covered),
      ids: localIds,
    };
  }, {
    sourceName,
    destinationName,
    subjectPrefix,
    remoteIds,
    fromEmail,
  });
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
