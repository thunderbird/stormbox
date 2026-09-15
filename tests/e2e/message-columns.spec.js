import {
  cleanupEmail,
  connectJmap,
  createEmailInMailbox,
  getEmailMailboxIds,
  listMailboxes,
  mailboxByRole,
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
  selfEmail,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import {
  escapeRegExp,
  expectRowSoon,
  readRecentMutations,
  readViewCacheForFolderRole,
  waitForFolderTreeReady,
  waitForPendingMutations,
} from './helpers/ui.js';

/**
 * Message list columns (specs/012-message-list-columns) — Verified
 * Consistency triple for a move between two columns.
 *
 * Adds a second column bound to Archive, drags an Inbox row onto it and
 * asserts the row lands in Archive in both columns' UI, in the local
 * cache and on the server; then checks that dropping the row onto the
 * column showing its own folder is a no-op (no highlight, no mutation)
 * and that the column layout survives a reload.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

const SUBJECT_PREFIX = 'Columns e2e';

function columnRegion(page, index) {
  return page.locator('.msg-columns .msg-list').nth(index);
}

function rowIn(column, subject) {
  return column.locator('.msg-list__items > li').filter({ hasText: subject }).first();
}

async function countPendingMutationRows(page) {
  return page.evaluate(async () => {
    if (!globalThis.__repo) return -1;
    const rows = await globalThis.__repo.call('db.query', {
      sql: 'SELECT COUNT(*) AS c FROM pending_mutations',
      params: [],
    });
    return Number(rows?.[0]?.c ?? 0);
  });
}

/** Remove every column after the primary one so later specs see one list. */
async function removeExtraColumns(page) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const inline = page.locator('.msg-columns .msg-list__remove-column');
    if (await inline.count() > 0) {
      await inline.last().click();
      continue;
    }
    // A narrow column keeps its × in the More menu.
    const more = page.locator('.msg-columns .msg-list').nth(1).locator('[data-more-menu]');
    if (await more.count() === 0) break;
    await more.click();
    await page.locator('[data-more-item="remove-column"]').first().click();
  }
  await expect(page.locator('.msg-columns .msg-list')).toHaveCount(1);
}

/** Add a second column and bind it to `mailbox` through the dropdown. */
async function addColumnFor(page, mailbox) {
  await columnRegion(page, 0).locator('.msg-list__add-column').click();
  const second = columnRegion(page, 1);
  const trigger = second.locator('.msg-list__folder-trigger');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await second.locator('.msg-list__folder-menu [role="option"]')
    .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(mailbox.name)}\\s*$`, 'i') })
    .first()
    .click();
  await expect(second).toHaveAttribute(
    'aria-label',
    new RegExp(`^${escapeRegExp(mailbox.name)} messages, column 2$`, 'i'),
  );
  return second;
}

test.describe('Message list columns e2e', () => {
  test.beforeEach(async ({ sharedPage }) => {
    await resetSharedSession(sharedPage, { extraSubjectPrefixes: [SUBJECT_PREFIX] });
    const jmap = await connectJmap();
    await sweepOrphanTestMessages(jmap, { subjectPrefix: SUBJECT_PREFIX });
  });

  test('a second column shows another folder, takes a dragged row, ignores a same-folder drop and survives a reload', async ({ sharedPage: page }, testInfo) => {
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

    const subject = `${SUBJECT_PREFIX} ${Date.now()} move`;
    let createdId = null;
    try {
      createdId = await createEmailInMailbox(jmap, {
        mailboxId: inbox.id,
        fromEmail: selfEmail(),
        subject,
        keywords: { $seen: true },
      });
      await expectRowSoon(page, subject);

      // One column, following the folder list's Inbox selection.
      await expect(page.locator('.msg-columns .msg-list')).toHaveCount(1);
      const primary = columnRegion(page, 0);
      await expect(primary).toHaveAttribute('aria-label', /^Inbox messages, column 1$/i);

      // "+" adds a column and puts focus on its folder picker.
      await primary.locator('.msg-list__add-column').click();
      await expect(page.locator('.msg-columns .msg-list')).toHaveCount(2);
      const second = columnRegion(page, 1);
      await expect(second).toHaveAttribute('aria-label', 'Column 2, no folder chosen');
      const trigger = second.locator('.msg-list__folder-trigger');
      await expect(trigger).toBeFocused();

      // The dropdown lists the folders with their icons; pick Archive.
      await trigger.click();
      const menu = second.locator('.msg-list__folder-menu');
      await expect(menu).toBeVisible();
      await expect(menu).toHaveAttribute('role', 'listbox');
      const archiveOption = menu.locator('[role="option"]')
        .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(archive.name)}\\s*$`, 'i') })
        .first();
      await expect(archiveOption.locator('svg')).toBeVisible();
      await archiveOption.click();
      await expect(second).toHaveAttribute(
        'aria-label',
        new RegExp(`^${escapeRegExp(archive.name)} messages, column 2$`, 'i'),
      );
      await expect(trigger).toBeFocused();
      // The folder list still highlights the primary column's folder.
      await expect(page.locator('.folder-node.is-current')).toContainText(/inbox/i);

      // Drag the Inbox row onto the Archive column.
      const sourceRow = rowIn(primary, subject);
      await expect(sourceRow).toBeVisible({ timeout: 30_000 });
      await sourceRow.dragTo(second);

      await expect.poll(
        async () => primary.locator('.msg-list__item').filter({ hasText: subject }).count(),
        { timeout: 30_000, message: 'moved row should leave the Inbox column' },
      ).toBe(0);
      await expect.poll(
        async () => second.locator('.msg-list__item').filter({ hasText: subject }).count(),
        { timeout: 30_000, message: 'moved row should appear in the Archive column' },
      ).toBe(1);

      await waitForPendingMutations(page);
      const inboxCache = await readViewCacheForFolderRole(page, 'inbox');
      expect(inboxCache.remoteIds, 'remote id should be gone from the Inbox cache').not.toContain(createdId);
      const archiveCache = await readViewCacheForFolderRole(page, 'archive');
      expect(archiveCache, 'the Archive view should be cached for its column').not.toBeNull();
      expect(archiveCache.remoteIds, 'remote id should be in the Archive cache').toContain(createdId);

      try {
        await expect.poll(
          async () => {
            const ids = await getEmailMailboxIds(jmap, createdId);
            if (!ids) return 'missing';
            if (ids[archive.id] === true && !ids[inbox.id]) return 'archive';
            if (ids[inbox.id]) return 'inbox';
            return JSON.stringify(ids);
          },
          { timeout: 30_000, message: 'server should report the message in Archive, not Inbox' },
        ).toBe('archive');
      } catch (err) {
        await testInfo.attach('recent-mutations.json', {
          body: JSON.stringify(await readRecentMutations(page), null, 2),
          contentType: 'application/json',
        });
        throw err;
      }

      // Dropping the row onto the column that shows its own folder is a
      // no-op: no drop highlight while it hovers, no mutation on release.
      const mutationsBefore = await countPendingMutationRows(page);
      const archivedRow = rowIn(second, subject);
      await expect(archivedRow).toBeVisible();
      const rowBox = await archivedRow.boundingBox();
      const columnBox = await second.boundingBox();
      await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(columnBox.x + columnBox.width / 2, columnBox.y + columnBox.height - 40, { steps: 8 });
      await page.mouse.move(columnBox.x + columnBox.width / 2, columnBox.y + columnBox.height - 30, { steps: 4 });
      await expect(second).not.toHaveClass(/is-drop-(valid|copy|invalid)/);
      await page.mouse.up();
      await archivedRow.dragTo(second);
      await expect(archivedRow).toBeVisible();
      expect(await countPendingMutationRows(page), 'a same-folder drop must not queue a mutation').toBe(mutationsBefore);
      const idsAfter = await getEmailMailboxIds(jmap, createdId);
      expect(idsAfter?.[archive.id]).toBe(true);
      expect(idsAfter?.[inbox.id]).toBeUndefined();

      // The layout is persisted per account and restored on reload.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForFolderTreeReady(page);
      await expect(page.locator('.msg-columns .msg-list')).toHaveCount(2);
      const restored = columnRegion(page, 1);
      await expect(restored).toHaveAttribute(
        'aria-label',
        new RegExp(`^${escapeRegExp(archive.name)} messages, column 2$`, 'i'),
      );
      await expect(rowIn(restored, subject)).toBeVisible({ timeout: 30_000 });
      await expect(columnRegion(page, 0)).toHaveAttribute('aria-label', /^Inbox messages, column 1$/i);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await removeExtraColumns(page).catch(() => {});
      if (createdId) {
        await cleanupEmail(jmap, createdId, trash.id);
      }
    }
  });

  test('opening and deleting from another column leaves the primary column alone, and the header keeps one row in narrow layouts', async ({ sharedPage: page }, testInfo) => {
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
    const originalViewport = page.viewportSize() ?? { width: 1280, height: 720 };

    const stamp = Date.now();
    const inboxSubject = `${SUBJECT_PREFIX} ${stamp} stays`;
    const archiveSubject = `${SUBJECT_PREFIX} ${stamp} archived`;
    let inboxId = null;
    let archiveId = null;
    try {
      inboxId = await createEmailInMailbox(jmap, {
        mailboxId: inbox.id, fromEmail: selfEmail(), subject: inboxSubject, keywords: { $seen: true },
      });
      archiveId = await createEmailInMailbox(jmap, {
        mailboxId: archive.id, fromEmail: selfEmail(), subject: archiveSubject, keywords: { $seen: true },
      });
      await expectRowSoon(page, inboxSubject);

      const primary = columnRegion(page, 0);
      const second = await addColumnFor(page, archive);
      // The column restores the folder's remembered scroll position; the
      // new row sits at the top of a large folder.
      await second.locator('.msg-list__scroller').evaluate((el) => { el.scrollTop = 0; });
      const archivedRow = rowIn(second, archiveSubject);
      await expect(archivedRow).toBeVisible({ timeout: 30_000 });

      // Opening a row from column 2 shows it in the reading pane while
      // column 1 and the folder list stay on Inbox; only that row is open.
      await archivedRow.locator('.msg-list__item').click();
      await expect(page.locator('.message-view h2').first()).toHaveText(archiveSubject);
      await expect(primary).toHaveAttribute('aria-label', /^Inbox messages, column 1$/i);
      await expect(page.locator('.folder-node.is-current')).toContainText(/inbox/i);
      await expect(archivedRow).toHaveClass(/is-focused/);
      await expect(primary.locator('.msg-list__items > li.is-focused')).toHaveCount(0);

      // Checking the row and pressing Delete acts on column 2's folder only.
      await archivedRow.locator('.msg-list__check input').click();
      await expect(second.locator('.msg-list__bulk-actions')).toBeVisible();
      await expect(page.locator('.message-view')).toHaveCount(0);
      await page.keyboard.press('Delete');
      await expect.poll(
        async () => second.locator('.msg-list__item').filter({ hasText: archiveSubject }).count(),
        { timeout: 30_000, message: 'deleted row should leave the Archive column' },
      ).toBe(0);
      await expect(rowIn(primary, inboxSubject)).toBeVisible();
      await waitForPendingMutations(page);
      await expect.poll(
        async () => {
          const ids = await getEmailMailboxIds(jmap, archiveId);
          if (!ids) return 'missing';
          return ids[trash.id] === true && !ids[archive.id] ? 'trash' : JSON.stringify(ids);
        },
        { timeout: 30_000, message: 'server should report the deleted message in Trash' },
      ).toBe('trash');
      const inboxIds = await getEmailMailboxIds(jmap, inboxId);
      expect(inboxIds?.[inbox.id], 'the Inbox row must be untouched').toBe(true);

      // Deleting the open message previews its neighbour; close that
      // before switching layouts.
      const back = page.locator('.message-view__action--back');
      if (await back.count()) await back.click();
      await expect(page.locator('.message-view')).toHaveCount(0);

      // Single-column layout: opening a message covers the columns and
      // closing it brings both back unchanged.
      await page.setViewportSize({ width: 600, height: 800 });
      await expect(primary).toBeVisible();
      await rowIn(primary, inboxSubject).locator('.msg-list__item').click();
      await expect(page.locator('.message-view h2').first()).toHaveText(inboxSubject);
      await expect(page.locator('.msg-columns')).toHaveCount(0);
      await page.locator('.message-view__action--back').click();
      await expect(page.locator('.msg-columns .msg-list')).toHaveCount(2);
      await expect(columnRegion(page, 0)).toHaveAttribute('aria-label', /^Inbox messages, column 1$/i);
      await expect(columnRegion(page, 1)).toHaveAttribute(
        'aria-label',
        new RegExp(`^${escapeRegExp(archive.name)} messages, column 2$`, 'i'),
      );

      // Two-pane layout with both columns squeezed to their minimum: the
      // header is still one row, Refresh and × live in the More menu.
      await page.setViewportSize({ width: 700, height: 800 });
      const narrow = columnRegion(page, 1);
      await expect(narrow.locator('.msg-list__header')).toHaveAttribute('data-header-tier', 'compact');
      const headerBox = await narrow.locator('.msg-list__header').boundingBox();
      expect(headerBox.height, 'the header must stay one row').toBeLessThan(70);
      await expect(narrow.locator('.msg-list__remove-column')).toHaveCount(0);
      await expect(narrow.locator('.msg-list__refresh')).toHaveCount(0);
      const more = narrow.locator('[data-more-menu]');
      await expect(more).toBeVisible();
      await more.click();
      const menu = narrow.locator('[role="menu"]');
      await expect(menu).toBeVisible();
      await expect(menu.locator('[data-more-item="refresh"]')).toBeVisible();
      await menu.locator('[data-more-item="remove-column"]').click();
      await expect(page.locator('.msg-columns .msg-list')).toHaveCount(1);
      // The remaining column grows into the space, its + returns to the
      // row, and focus follows it there.
      await expect(columnRegion(page, 0).locator('.msg-list__add-column')).toBeFocused();
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await page.setViewportSize(originalViewport).catch(() => {});
      await removeExtraColumns(page).catch(() => {});
      if (inboxId) await cleanupEmail(jmap, inboxId, trash.id);
      if (archiveId) await cleanupEmail(jmap, archiveId, trash.id);
    }
  });
});
