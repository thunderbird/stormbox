import {
  connectJmap,
  getEmailMailboxIds,
  jmapRequest,
  listMailboxes,
  pickResponse,
} from './helpers/jmap-client.js';
import {
  attachConsoleTail,
  consoleLinesFor,
  expect,
  resetSharedSession,
  test,
} from './helpers/shared-session.js';
import { loginViaOidc } from './helpers/oidc-login.js';
import {
  localStackEnabled,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import { waitForFolderTreeReady, waitForInboxReady, waitForPendingMutations } from './helpers/ui.js';

/**
 * Staff kanban feature flag — Verified Consistency triple for the two
 * server-touching paths it adds: seeding through the CREATE_EMAILS
 * outbox operation and moving a row between columns.
 *
 * The e2e account's OIDC email is on a staff domain, so the gear is
 * visible. The spec walks the real unlock path (gear, code, Activate),
 * waits for the two seeded folders to fill, drags one row across and
 * asserts UI, local cache (window.__repo) and server (Email/get). It
 * then leaves the account exactly as it found it: flag cleared, both
 * seeded folders destroyed with their mail.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

const SEEDED_FOLDERS = ['Needs Reply', 'Blocked'];
const NEEDS_REPLY_COUNT = 15;
const BLOCKED_COUNT = 23;
const WAIT_MS = 30_000;
const SEED_WAIT_MS = 90_000;

async function destroySeededMailboxes(jmap) {
  const mailboxes = await listMailboxes(jmap);
  const targets = mailboxes.filter((m) => SEEDED_FOLDERS.some((name) => (m.name ?? '').toLowerCase() === name.toLowerCase()));
  if (targets.length === 0) return 0;
  const payload = await jmapRequest(jmap, [[
    'Mailbox/set',
    {
      accountId: jmap.accountId,
      destroy: targets.map((m) => m.id),
      onDestroyRemoveEmails: true,
    },
    'mbDestroy',
  ]]);
  const set = pickResponse(payload, 'Mailbox/set');
  const notDestroyed = Object.keys(set?.notDestroyed ?? {});
  if (notDestroyed.length) {
    throw new Error(`Could not destroy seeded mailboxes: ${JSON.stringify(set.notDestroyed)}`);
  }
  return targets.length;
}

async function countEmailsInMailbox(jmap, mailboxId) {
  const payload = await jmapRequest(jmap, [[
    'Email/query',
    { accountId: jmap.accountId, filter: { inMailbox: mailboxId }, limit: 0, calculateTotal: true },
    'q',
  ]]);
  return Number(pickResponse(payload, 'Email/query')?.total ?? 0);
}

async function clearKanbanFlag(page) {
  await page.evaluate(() => {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith('stormbox.kanban.')) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  });
}

async function readFolderCacheByName(page, name) {
  return page.evaluate(async (wanted) => {
    if (!globalThis.__repo) return null;
    const accounts = await globalThis.__repo.listAccounts();
    const account = accounts?.[0];
    if (!account) return null;
    const folders = await globalThis.__repo.listFolders(account.id);
    const folder = folders.find((f) => (f.name ?? '').toLowerCase() === wanted.toLowerCase() && !f.is_deleted);
    if (!folder) return null;
    const view = { accountId: account.id, folderId: folder.id, sort: 'received' };
    const progress = await globalThis.__repo.queryViewProgress(view);
    const rows = await globalThis.__repo.listMessagesForView({ ...view, offset: 0, limit: 500 });
    return {
      folderId: folder.id,
      remoteId: folder.remote_id,
      total: Number(progress?.total ?? 0),
      remoteIds: rows.map((r) => r.remote_id),
      subjects: rows.map((r) => r.subject),
    };
  }, name);
}

function column(page, label) {
  return page.locator(`[data-kanban-column="${label}"]`);
}

async function shellOverflow(page) {
  return page.locator('.shell').evaluate((shell) => shell.scrollWidth - shell.clientWidth);
}

test.describe('Staff gear in narrow layouts', () => {
  // The e2e account is staff, so the gear is in every layout's top bar.
  // Below 700px the bar has no room for it: it must disappear rather than
  // widen the shell (sidebar-layout.spec.js measures the same shell at
  // 640px and 340px without knowing about the gear).
  test('the gear never widens the top bar: hidden below 700px, present above', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 852 });
    await page.addInitScript(() => {
      window.localStorage.setItem('stormbox.welcomeModalDismissed.v1', '1');
    });
    await loginViaOidc(page);
    await waitForInboxReady(page);

    const gear = page.locator('[data-staff-gear]');
    await expect(gear).toBeVisible();
    expect(await shellOverflow(page)).toBeLessThanOrEqual(0);

    for (const width of [699, 640, 340]) {
      await page.setViewportSize({ width, height: 852 });
      await expect(gear).toBeHidden();
      await expect.poll(() => shellOverflow(page), { message: `shell overflow at ${width}px` })
        .toBeLessThanOrEqual(0);
    }

    await page.setViewportSize({ width: 700, height: 852 });
    await expect(gear).toBeVisible();
    await expect.poll(() => shellOverflow(page), { message: 'shell overflow at 700px' })
      .toBeLessThanOrEqual(0);
  });
});

test.describe('Kanban feature flag e2e', () => {
  test.beforeEach(async ({ sharedPage }) => {
    await resetSharedSession(sharedPage);
    const jmap = await connectJmap();
    // Leftovers from an interrupted run would make seeding a no-op.
    await destroySeededMailboxes(jmap);
    await clearKanbanFlag(sharedPage);
  });

  test('gear + code unlocks the board, seeds 15/23 mails, drag moves across columns, toggle restores the list', async ({ sharedPage: page }, testInfo) => {
    // Seeding creates two mailboxes and 38 messages over JMAP before the
    // assertions even begin; well over the default 60 s budget.
    test.setTimeout(300_000);
    const jmap = await connectJmap();
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForFolderTreeReady(page);

      // Flag off: the ordinary list, no board, no dialog.
      await expect(page.locator('.msg-list')).toBeVisible({ timeout: WAIT_MS });
      await expect(page.locator('[data-testid="kanban-board"]')).toHaveCount(0);
      const gear = page.locator('[data-staff-gear]');
      await expect(gear).toBeVisible();

      await gear.click();
      const dialog = page.locator('[data-kanban-unlock-dialog]');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('[role="switch"]')).toHaveCount(0);

      // A wrong code changes nothing.
      await dialog.locator('[data-kanban-unlock-code]').fill('nope');
      await dialog.locator('[data-kanban-unlock-submit]').click();
      await expect(dialog.getByRole('alert')).toContainText('Unknown feature code');
      await expect(page.locator('.msg-list')).toBeVisible();

      await dialog.locator('[data-kanban-unlock-code]').fill('kanban');
      await dialog.locator('[data-kanban-unlock-submit]').click();

      await expect(dialog).toHaveCount(0);
      const board = page.locator('[data-testid="kanban-board"]');
      await expect(board).toBeVisible({ timeout: WAIT_MS });
      await expect(page.locator('[data-kanban-fireworks]')).toBeVisible({ timeout: 5_000 });
      await expect(page.locator('.msg-list')).toHaveCount(0);

      // The volume pill is docked while the celebration plays; the level it
      // sets is remembered (the clip element itself is off-DOM, so the
      // gain binding is covered by unit tests).
      const volume = page.locator('[data-kanban-volume]');
      await expect(volume).toBeVisible({ timeout: 5_000 });
      await volume.locator('[data-kanban-volume-slider]').fill('0.4');
      await expect.poll(
        () => page.evaluate(() => localStorage.getItem('stormbox.kanban.celebrationVolume.v1')),
        { message: 'slider level is remembered' },
      ).toBe('0.4');

      // Column 1 is the sidebar's folder (the Inbox) with the shared row markup.
      const primary = column(page, 'Column 1');
      await expect(primary.locator('.kanban-column__title')).toHaveText('Inbox');
      await expect(primary.locator('.msg-list__item').first()).toBeVisible({ timeout: WAIT_MS });

      // Seeding: both folders appear as the column defaults and fill up.
      const second = column(page, 'Column 2');
      const third = column(page, 'Column 3');
      await expect(second.locator('.kanban-picker__name')).toHaveText('Needs Reply', { timeout: SEED_WAIT_MS });
      await expect(third.locator('.kanban-picker__name')).toHaveText('Blocked', { timeout: SEED_WAIT_MS });
      await expect(second.locator('.kanban-column__count')).toHaveText(String(NEEDS_REPLY_COUNT), { timeout: SEED_WAIT_MS });
      await expect(third.locator('.kanban-column__count')).toHaveText(String(BLOCKED_COUNT), { timeout: SEED_WAIT_MS });
      await expect(second.locator('.msg-list__item').first()).toBeVisible({ timeout: WAIT_MS });
      await expect(third.locator('.msg-list__item').first()).toBeVisible({ timeout: WAIT_MS });
      await waitForPendingMutations(page);

      // Sidebar shows the new folders too (same folder tree, not a copy).
      await expect(page.locator('.folder-node').filter({ hasText: /^\s*Needs Reply/ })).toBeVisible();
      await expect(page.locator('.folder-node').filter({ hasText: /^\s*Blocked/ })).toBeVisible();

      // Server + cache agree with the UI on the seeded counts.
      const mailboxes = await listMailboxes(jmap);
      const needsReplyMb = mailboxes.find((m) => m.name === 'Needs Reply');
      const blockedMb = mailboxes.find((m) => m.name === 'Blocked');
      expect(needsReplyMb, 'Needs Reply mailbox on server').toBeTruthy();
      expect(blockedMb, 'Blocked mailbox on server').toBeTruthy();
      expect(await countEmailsInMailbox(jmap, needsReplyMb.id)).toBe(NEEDS_REPLY_COUNT);
      expect(await countEmailsInMailbox(jmap, blockedMb.id)).toBe(BLOCKED_COUNT);
      const needsReplyCache = await readFolderCacheByName(page, 'Needs Reply');
      const blockedCache = await readFolderCacheByName(page, 'Blocked');
      expect(needsReplyCache?.total).toBe(NEEDS_REPLY_COUNT);
      expect(blockedCache?.total).toBe(BLOCKED_COUNT);
      expect(new Set(needsReplyCache.subjects).size, 'seeded subjects are distinct').toBe(NEEDS_REPLY_COUNT);

      // Drag the top Needs Reply row onto the Blocked column.
      const sourceRow = second.locator('.msg-list__item').first();
      const movedSubject = (await sourceRow.locator('.msg-list__subject').textContent())?.trim();
      expect(movedSubject, 'dragged row has a subject').toBeTruthy();
      const movedRemoteId = needsReplyCache.subjects.indexOf(movedSubject) >= 0
        ? needsReplyCache.remoteIds[needsReplyCache.subjects.indexOf(movedSubject)]
        : null;
      expect(movedRemoteId, 'dragged row is in the Needs Reply cache').toBeTruthy();

      await sourceRow.dragTo(third);

      await expect(second.locator('.kanban-column__count')).toHaveText(String(NEEDS_REPLY_COUNT - 1), { timeout: WAIT_MS });
      await expect(third.locator('.kanban-column__count')).toHaveText(String(BLOCKED_COUNT + 1), { timeout: WAIT_MS });
      await expect(second.locator('.msg-list__item').filter({ hasText: movedSubject })).toHaveCount(0);
      await waitForPendingMutations(page);

      await expect.poll(
        async () => (await readFolderCacheByName(page, 'Blocked'))?.remoteIds ?? [],
        { timeout: WAIT_MS, message: 'moved row lands in the Blocked cache' },
      ).toContain(movedRemoteId);
      expect((await readFolderCacheByName(page, 'Needs Reply')).remoteIds).not.toContain(movedRemoteId);

      await expect.poll(
        async () => {
          const ids = await getEmailMailboxIds(jmap, movedRemoteId);
          if (!ids) return 'missing';
          if (ids[blockedMb.id] === true && ids[needsReplyMb.id] !== true) return 'blocked';
          return JSON.stringify(ids);
        },
        { timeout: WAIT_MS, message: 'server reports the message in Blocked only' },
      ).toBe('blocked');

      // Multi-select works per column like the plain list: check two rows,
      // the header swaps to the bulk actions, and dragging a checked row
      // carries the whole selection to the drop column.
      const secondRows = second.locator('.msg-list__item');
      const multiSubjects = [];
      for (const index of [0, 1]) {
        multiSubjects.push((await secondRows.nth(index).locator('.msg-list__subject').textContent())?.trim());
        await secondRows.nth(index).locator('.msg-list__check input').click();
      }
      await expect(second.locator('li.is-selected')).toHaveCount(2);
      await expect(second.locator('.selectable-list-header__count')).toHaveText('2 selected');
      await expect(second.locator('.selectable-list-header__selection-actions [title="Archive"]')).toBeVisible();
      // The reading pane never shows during a selection.
      await expect(page.locator('.message-view__title h2')).toHaveCount(0);

      await secondRows.nth(1).dragTo(third);
      await expect(second.locator('.kanban-column__count')).toHaveText(String(NEEDS_REPLY_COUNT - 3), { timeout: WAIT_MS });
      await expect(third.locator('.kanban-column__count')).toHaveText(String(BLOCKED_COUNT + 3), { timeout: WAIT_MS });
      for (const subject of multiSubjects) {
        await expect(second.locator('.msg-list__item').filter({ hasText: subject })).toHaveCount(0);
        await expect(third.locator('.msg-list__item').filter({ hasText: subject })).toHaveCount(1);
      }
      // Moved rows leave the selection; the header is back to normal.
      await expect(second.locator('li.is-selected')).toHaveCount(0);
      await expect(second.locator('.selectable-list-header__selection-actions')).toHaveCount(0);
      await waitForPendingMutations(page);
      await expect.poll(
        async () => countEmailsInMailbox(jmap, blockedMb.id),
        { timeout: WAIT_MS, message: 'server holds the three moved rows in Blocked' },
      ).toBe(BLOCKED_COUNT + 3);

      // A bulk action from a column that is not the open folder acts on
      // that column's rows: mark one Blocked row unread from its header.
      const blockedRow = third.locator('.msg-list__item').filter({ hasText: multiSubjects[0] });
      await blockedRow.locator('.msg-list__check input').click();
      await expect(third.locator('.selectable-list-header__count')).toHaveText('1 selected');
      await third.locator('.selectable-list-header__selection-actions [title="Mark as unread"]').click();
      await expect(third.locator('li.is-unread').filter({ hasText: multiSubjects[0] })).toHaveCount(1, { timeout: WAIT_MS });
      await third.locator('.selectable-list-header__selection-actions [title="Mark as read"]').click();
      await expect(third.locator('li.is-unread').filter({ hasText: multiSubjects[0] })).toHaveCount(0, { timeout: WAIT_MS });
      await third.locator('.selectable-list-header__selection-actions [title="Clear selection"]').click();
      await expect(third.locator('li.is-selected')).toHaveCount(0);
      await waitForPendingMutations(page);

      // Dragging the handle after column 1 widens it; the width survives a
      // reload (checked further down).
      const handle = page.locator('[data-kanban-resizer="inbox"]');
      const widthBefore = (await primary.boundingBox()).width;
      const handleBox = await handle.boundingBox();
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + 80, handleBox.y + handleBox.height / 2, { steps: 4 });
      await page.mouse.up();
      await expect.poll(async () => Math.round((await primary.boundingBox()).width) - Math.round(widthBefore))
        .toBeGreaterThanOrEqual(70);

      // Opening a row from column 1 hides only the rightmost column; the
      // open row is the only highlighted one on the board.
      const inboxRow = primary.locator('.msg-list__item').first();
      const inboxSubject = (await inboxRow.locator('.msg-list__subject').textContent())?.trim();
      await inboxRow.locator('.msg-list__content').click();
      await expect(page.locator('.message-view__title h2')).toHaveText(inboxSubject, { timeout: WAIT_MS });
      await expect(board).toHaveClass(/kanban-board--compact/);
      await expect(second).toBeVisible();
      await expect(third).toBeHidden();
      await expect(primary).toBeVisible();
      await expect(board.locator('li.is-focused')).toHaveCount(1);
      await expect(page.locator('.column-resizer--message-list')).toHaveCount(0);

      // Clicking the open row again closes the message and restores the columns.
      await primary.locator('.msg-list__item').first().locator('.msg-list__content').click();
      await expect(page.locator('.message-view__title h2')).toHaveCount(0, { timeout: WAIT_MS });
      await expect(board).not.toHaveClass(/kanban-board--compact/);
      await expect(second).toBeVisible();
      await expect(third).toBeVisible();
      await expect(board.locator('li.is-focused')).toHaveCount(0);

      // Column 1 follows the sidebar like the plain list does; the pick
      // that now duplicates it is shadowed instead of shown twice.
      await page.locator('.folder-node').filter({ hasText: /^\s*Blocked/ }).locator('button').first().click();
      await expect(primary.locator('.kanban-column__title')).toHaveText('Blocked', { timeout: WAIT_MS });
      await expect(third.locator('[data-kanban-shadowed]')).toBeVisible();
      await expect(third.locator('.msg-list__item')).toHaveCount(0);
      await page.locator('.folder-node').filter({ hasText: /^\s*Inbox/ }).locator('button').first().click();
      await expect(primary.locator('.kanban-column__title')).toHaveText('Inbox', { timeout: WAIT_MS });
      await expect(third.locator('.msg-list__item').first()).toBeVisible({ timeout: WAIT_MS });

      // The flag survives a reload without re-celebrating.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForFolderTreeReady(page);
      await expect(page.locator('[data-testid="kanban-board"]')).toBeVisible({ timeout: WAIT_MS });
      await expect(page.locator('[data-kanban-fireworks]')).toHaveCount(0);
      await expect(column(page, 'Column 2').locator('.kanban-picker__name')).toHaveText('Needs Reply', { timeout: WAIT_MS });
      await expect.poll(async () => Math.round((await column(page, 'Column 1').boundingBox()).width) - Math.round(widthBefore))
        .toBeGreaterThanOrEqual(70);

      // After unlocking, the gear is a plain switch. Off puts the list back.
      await page.locator('[data-staff-gear]').click();
      const toggle = page.locator('[data-kanban-unlock-dialog] [role="switch"]');
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect(page.locator('[data-kanban-unlock-dialog] [data-kanban-unlock-code]')).toHaveCount(0);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(page.locator('.msg-list')).toBeVisible({ timeout: WAIT_MS });
      await expect(page.locator('[data-testid="kanban-board"]')).toHaveCount(0);
      await toggle.click();
      await expect(page.locator('[data-testid="kanban-board"]')).toBeVisible({ timeout: WAIT_MS });
      await expect(page.locator('[data-kanban-fireworks]')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-kanban-unlock-dialog]')).toHaveCount(0);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      // Leave the shared session as the next spec expects it.
      await clearKanbanFlag(page).catch(() => {});
      await destroySeededMailboxes(jmap).catch(() => {});
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await waitForFolderTreeReady(page).catch(() => {});
    }
  });
});
