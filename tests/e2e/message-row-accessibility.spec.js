import { createRequire } from 'node:module';

import {
  cleanupEmail,
  connectJmap,
  createEmailInMailbox,
  getEmailKeywords,
  getEmailMailboxIds,
  listMailboxes,
  mailboxByRole,
} from './helpers/jmap-client.js';
import { expect, resetSharedSession, test } from './helpers/shared-session.js';
import { localStackEnabled, selfEmail, skipLocalStackMessage } from './helpers/stack-env.js';
import { expectRowSoon, readViewCacheForFolderRole, waitForPendingMutations } from './helpers/ui.js';

const require = createRequire(import.meta.url);
const PREFIX = 'Row controls e2e';
test.skip(!localStackEnabled, skipLocalStackMessage);

async function auditGrid(page) {
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  const result = await page.evaluate(async () => window.axe.run('.msg-list__scroller', {
    runOnly: {
      type: 'rule',
      values: ['nested-interactive', 'aria-required-children', 'aria-required-parent',
        'aria-valid-attr-value', 'aria-allowed-attr', 'aria-prohibited-attr',
        'aria-required-attr', 'aria-roles', 'button-name', 'label'],
    },
  }));
  expect(result.violations).toEqual([]);
  expect(result.passes.map((rule) => rule.id)).toContain('nested-interactive');
}

async function seedMessage(page) {
  const jmap = await connectJmap();
  const mailboxes = await listMailboxes(jmap);
  const inbox = mailboxByRole(mailboxes, 'inbox');
  const trash = mailboxByRole(mailboxes, 'trash');
  const subject = `${PREFIX} ${Date.now()}`;
  const id = await createEmailInMailbox(jmap, {
    mailboxId: inbox.id, fromEmail: selfEmail(), subject,
    bodyText: 'Message row keyboard accessibility fixture', keywords: { $seen: true },
  });
  try {
    await expectRowSoon(page, subject);
  } catch (error) {
    await cleanupEmail(jmap, id, trash.id);
    throw error;
  }
  const row = page.locator('.msg-list__items > li').filter({ hasText: subject });
  return { jmap, subject, id, row, trashId: trash.id };
}

test.beforeEach(async ({ sharedPage }) => {
  await resetSharedSession(sharedPage, { extraSubjectPrefixes: [PREFIX] });
});

test('row controls have independent semantics, native activation and stable focus', async ({ sharedPage: page }) => {
  const { jmap, subject, id, row, trashId } = await seedMessage(page);
  try {
    const grid = page.getByRole('grid', { name: 'Messages', exact: true });
    await expect(grid).toHaveAttribute('aria-multiselectable', 'true');
    await expect(row).toHaveRole('row');
    const checkbox = row.getByRole('checkbox', { name: `Select message: ${subject}`, exact: false });
    const open = row.getByRole('button', { name: `Open message: ${subject}`, exact: false });
    await page.keyboard.press('Tab');
    await grid.focus();
    await expect.poll(() => grid.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('solid');
    await row.hover();
    await row.locator('.msg-list__item').evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    const hoverBackground = await row.locator('.msg-list__actions')
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.mouse.move(0, 0);
    await checkbox.focus();
    await expect.poll(() => row.locator('.msg-list__actions')
      .evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(hoverBackground);
    const subjectBounds = await row.locator('.msg-list__subject').boundingBox();
    await page.mouse.click(subjectBounds.x + subjectBounds.width / 2, subjectBounds.y + subjectBounds.height / 2);
    await expect(grid).toBeFocused();
    await expect(page.locator('.message-view h2').first()).toHaveText(subject);
    await grid.press('F2');
    await expect(checkbox).toBeFocused();
    await checkbox.press('Space');
    await expect(checkbox).toBeChecked();
    await expect(row).toHaveAttribute('aria-selected', 'true');
    await checkbox.press('Escape');
    await expect(grid).toBeFocused();
    await expect(checkbox).toBeChecked();
    await grid.press('Escape');
    await expect(checkbox).not.toBeChecked();

    await grid.press('ArrowRight');
    await expect(checkbox).toBeFocused();
    await checkbox.press('Enter');
    await expect(checkbox).toBeChecked();
    await checkbox.press('ArrowRight');
    await expect(open).toBeFocused();
    await open.press('Enter');
    await expect(grid).toBeFocused();
    await expect(checkbox).not.toBeChecked();
    await expect(page.locator('.message-view h2').first()).toHaveText(subject);

    await grid.press('F2');
    await checkbox.press('ArrowRight');
    await open.press('ArrowRight');
    const tag = row.getByRole('button', { name: 'Tag', exact: true });
    await expect(tag).toBeFocused();
    await expect(tag).toBeVisible();
    await tag.press('Enter');
    await expect(page.locator('[data-tag-picker-popover]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-tag-picker-popover]')).toHaveCount(0);
    await expect(tag).toBeFocused();
    await tag.press('ArrowRight');
    const star = row.getByRole('button', { name: /^(Star|Unstar)$/ });
    await expect(star).toBeFocused();
    await star.press('Space');
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await waitForPendingMutations(page);
    await expect.poll(async () => (await getEmailKeywords(jmap, id))?.$flagged).toBe(true);
    await expect.poll(async () => {
      return page.evaluate(async (remoteId) => {
        const [account] = await window.__repo.listAccounts();
        const folders = await window.__repo.listFolders(account.id);
        const inbox = folders.find((folder) => folder.role === 'inbox');
        const rows = await window.__repo.listMessagesForView({
          accountId: account.id, folderId: inbox.id, sort: 'received', offset: 0, limit: 500,
        });
        return Number(rows.find((message) => message.remote_id === remoteId)?.is_flagged);
      }, id);
    }).toBe(1);
    await auditGrid(page);

    await star.press('Escape');
    await expect(grid).toBeFocused();
    await grid.press('Shift+ArrowDown');
    const cursorId = await grid.getAttribute('aria-activedescendant');
    await expect(page.locator(`[id="${cursorId}"]`)).toHaveAttribute('aria-selected', 'true');
    await grid.press('Escape');
    await grid.press('F2');
    await page.keyboard.press('Tab');
    await expect.poll(() => grid.evaluate((element) => element.contains(document.activeElement))).toBe(false);
    await grid.focus();
    await grid.press('F2');
    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => grid.evaluate((element) => element.contains(document.activeElement))).toBe(false);

    await checkbox.click();
    const nextRow = row.locator('xpath=following-sibling::li[@role="row"][1]');
    await nextRow.getByRole('checkbox').click({ modifiers: ['Shift'] });
    await expect(checkbox).toBeChecked();
    await expect(nextRow.getByRole('checkbox')).toBeChecked();
    await checkbox.click({ modifiers: ['Shift'] });
    await expect(nextRow.getByRole('checkbox')).not.toBeChecked();
    await checkbox.press('Escape');
    await grid.press('Escape');
    await grid.press('F2');
    await page.keyboard.press('End');
    await expect(row.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(row).toHaveCount(0);
    await expect(grid).toBeFocused();
    await waitForPendingMutations(page);
    await expect.poll(async () => (await getEmailMailboxIds(jmap, id))?.[trashId]).toBe(true);
    const cache = await readViewCacheForFolderRole(page, 'inbox');
    expect(cache.remoteIds).not.toContain(id);
  } finally {
    await cleanupEmail(jmap, id, trashId);
  }
});

test('narrow rows expose keyboard controls and keep the accessible grid after resizing', async ({ sharedPage: page }) => {
  const { jmap, id, row, trashId } = await seedMessage(page);
  const viewport = page.viewportSize();
  try {
    const back = page.locator('.message-view__action--back');
    if (await back.count() > 0) await back.click();
    await page.setViewportSize({ width: 600, height: 800 });
    const grid = page.getByRole('grid', { name: 'Messages', exact: true });
    const checkbox = row.getByRole('checkbox');
    await checkbox.focus();
    await checkbox.press('Escape');
    await grid.press('F2');
    await expect(checkbox).toBeFocused();
    await checkbox.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const tag = row.getByRole('button', { name: 'Tag', exact: true });
    await expect(tag).toBeFocused();
    await expect(tag).toBeVisible();
    await tag.press('ArrowRight');
    await expect(row.getByRole('button', { name: 'Star', exact: true })).toBeFocused();
    await page.keyboard.press('End');
    await expect(row.getByRole('button', { name: 'Star', exact: true })).toBeFocused();
    await auditGrid(page);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.keyboard.press('End');
    await expect(row.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(grid).toBeFocused();
    await auditGrid(page);
  } finally {
    if (viewport) await page.setViewportSize(viewport);
    await cleanupEmail(jmap, id, trashId);
  }
});

test('pointer selection keeps list shortcuts and hover behavior', async ({ sharedPage: page }) => {
  const grid = page.getByRole('grid', { name: 'Messages', exact: true });
  const row = grid.locator('[role="row"]').first();
  const checkbox = row.getByRole('checkbox');
  await checkbox.click();
  await page.mouse.move(0, 0);
  await page.keyboard.press('Escape');
  await expect(checkbox).not.toBeChecked();
  await expect(grid).toBeFocused();
  await expect(row.getByRole('button', { name: 'Delete', exact: true })).toBeHidden();
  await checkbox.click();
  await page.keyboard.press('ControlOrMeta+a');
  await expect(grid.locator('[role="row"]').nth(1).getByRole('checkbox')).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(checkbox).not.toBeChecked();
  await row.locator('.msg-list__check').click({ position: { x: 2, y: 2 } });
  await expect(checkbox).toBeChecked();
  await expect(grid).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(checkbox).not.toBeChecked();
  await row.locator('.msg-list__open').click({ button: 'right' });
  await expect(grid).toBeFocused();
  await row.locator('.msg-list__open').dragTo(page.locator('nav[aria-label="Spaces"]'));
  await expect(grid).toBeFocused();
});

test('closing a row menu after the message disappears returns focus to the list', async ({ sharedPage: page }) => {
  const { jmap, id, row, trashId } = await seedMessage(page);
  try {
    const grid = page.getByRole('grid', { name: 'Messages', exact: true });
    await row.locator('.msg-list__open').click();
    await grid.press('F2');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-tag-picker-popover]')).toBeVisible();
    await cleanupEmail(jmap, id, trashId);
    await expect(row).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-tag-picker-popover]')).toHaveCount(0);
    await expect(grid).toBeFocused();
  } finally {
    await cleanupEmail(jmap, id, trashId);
  }
});
