import {
  connectJmap,
  createEmailInMailbox,
  destroyEmails,
  downloadBlob,
  fileNodeRequest,
  getEmailKeywords,
  listMailboxes,
  mailboxByRole,
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
  selfEmail,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import {
  expectRowSoon,
  readRecentMutations,
  waitForPendingMutations,
} from './helpers/ui.js';
import { DEFAULT_MESSAGE_TAGS } from '../../src/utils/message-tags';

/**
 * Tags (specs/011-message-keywords §6) — Verified Consistency for user
 * keywords through every entry point: the row's Tag menu, the
 * multi-select Tag menu, the digit shortcuts, and the open message's
 * chips. Each write must land in the row's chips, the local cache
 * (keywords_json / message_keywords) and on the server (Email.keywords).
 * The default Thunderbird tags are used so no definition is created on
 * the account.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

const SUBJECT_PREFIX = 'Tag e2e';
const WORK = '$label2';
const TODO = '$label4';

async function readTagKeywords(page, remoteIds) {
  return page.evaluate(async (ids) => {
    if (!globalThis.__repo) return null;
    const accounts = await globalThis.__repo.listAccounts();
    const account = accounts?.[0];
    if (!account) return null;
    const folders = await globalThis.__repo.listFolders(account.id);
    const inbox = folders.find((f) => f.role === 'inbox');
    const rows = await globalThis.__repo.listMessagesForView({
      accountId: account.id,
      folderId: inbox.id,
      sort: 'received',
      offset: 0,
      limit: 500,
    });
    return Object.fromEntries(ids.map((rid) => {
      const row = rows.find((r) => r.remote_id === rid);
      if (!row) return [rid, null];
      const keywords = JSON.parse(row.keywords_json ?? '{}');
      return [rid, Object.keys(keywords).filter((k) => keywords[k] === true && !k.startsWith('$seen')).sort()];
    }));
  }, remoteIds);
}

async function expectServerKeyword(jmap, remoteId, keyword, present) {
  await expect.poll(
    async () => {
      const keywords = await getEmailKeywords(jmap, remoteId);
      if (!keywords) return 'missing';
      return keywords[keyword] === true ? 'present' : 'absent';
    },
    { timeout: 30_000, message: `server should report ${keyword} ${present ? 'on' : 'off'} ${remoteId}` },
  ).toBe(present ? 'present' : 'absent');
}

function rowFor(page, subject) {
  return page.locator('.msg-list__items > li').filter({ hasText: subject }).first();
}

/** The row's tag stack (MK-6.5): its icons carry the keywords, its label the names. */
function tagStackOf(row) {
  return row.locator('.msg-list__action--tag');
}

async function expectRowTags(row, names) {
  await expect(tagStackOf(row)).toHaveAttribute(
    'aria-label',
    names.length > 0 ? `Tags: ${names.join(', ')}` : 'Tag',
  );
}

async function readDefinitions(page) {
  return page.evaluate(async () => {
    const [account] = await window.__repo.listAccounts();
    return (await window.__repo.getSettings(account.id))?.doc?.settings?.messageTags ?? null;
  });
}

/** Defines a tag through the tag manager (the menus only apply tags) and returns its keyword. */
async function defineTag(page, name) {
  await page.getByRole('button', { name: 'Manage Tags', exact: true }).click();
  const manager = page.locator('[data-tag-manager]');
  await manager.locator('[data-tag-editor-name]').fill(name);
  await manager.locator('[data-tag-editor-submit]').click();
  await expect(manager.locator('[data-tag-editor-name]')).toHaveValue('');
  let keyword = null;
  await expect.poll(async () => {
    keyword = (await readDefinitions(page))?.find((definition) => definition.name === name)?.keyword ?? null;
    return keyword;
  }).not.toBeNull();
  await page.getByRole('button', { name: 'Close tags', exact: true }).click();
  // The settings write drains before the caller tags anything, so its
  // refresh cannot land on top of the next optimistic keyword.
  await waitForPendingMutations(page);
  return keyword;
}

async function readRemoteDefinitions(page, jmap) {
  const nodeId = await page.evaluate(async () => {
    const [account] = await window.__repo.listAccounts();
    return (await window.__repo.getSettings(account.id))?.remoteNodeId;
  });
  if (!nodeId) return null;
  const response = await fileNodeRequest(jmap, [[
    'FileNode/get', { accountId: jmap.accountId, ids: [nodeId], properties: ['id', 'blobId'] }, 'tag-settings',
  ]]);
  const node = pickResponse(response, 'FileNode/get')?.list?.[0];
  if (!node?.blobId) return null;
  const bytes = await downloadBlob(jmap, { blobId: node.blobId, type: 'application/json', name: 'settings.json' });
  return JSON.parse(bytes.toString('utf8'))?.settings?.messageTags ?? null;
}

test.describe('Tag message e2e', () => {
  test.beforeEach(async ({ sharedPage }) => {
    await resetSharedSession(sharedPage);
    const jmap = await connectJmap();
    await sweepOrphanTestMessages(jmap, { subjectPrefix: SUBJECT_PREFIX });
  });

  test('Unicode tag creation, editing and adoption persist through the worker and reload', async ({ sharedPage: page }, testInfo) => {
    test.setTimeout(120_000);
    const jmap = await connectJmap();
    const inbox = mailboxByRole(await listMailboxes(jmap), 'inbox');
    const saved = await readDefinitions(page) ?? DEFAULT_MESSAGE_TAGS;
    const stamp = Date.now();
    const suffix = String(stamp).replace(/\d/g, (digit) => String.fromCodePoint(0xff10 + Number(digit)));
    const tagName = `日本語${suffix}`;
    const renamed = `${tagName} 📬`;
    const subject = `${SUBJECT_PREFIX} Unicode ${stamp}`;
    let keyword;
    let remoteId;
    let secondId;
    const screenshot = async (name) => {
      await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
    };
    try {
      remoteId = await createEmailInMailbox(jmap, {
        mailboxId: inbox.id, fromEmail: selfEmail(), subject,
        bodyText: 'Unicode tag persistence fixture', keywords: { $seen: true },
      });
      await expectRowSoon(page, subject);
      keyword = await defineTag(page, tagName);
      expect(keyword).toMatch(/^=e6=97=a5=e6=9c=ac=e8=aa=9e/);
      expect(keyword.length).toBeLessThanOrEqual(128);
      const row = rowFor(page, subject);
      await page.mouse.move(0, 0);
      await expect(row.locator('.msg-list__action--tag')).toBeHidden();
      await row.hover();
      await expect(row.locator('.msg-list__action--tag')).toBeVisible();
      await screenshot('01-row-hover');
      await row.locator('.msg-list__action--tag').click();
      const popover = page.locator('[data-tag-picker-popover]');
      await expect(popover.locator('input')).toHaveCount(0);
      await popover.locator(`[data-tag-keyword="${keyword}"]`).hover();
      await screenshot('02-unicode-menu');
      await popover.locator(`[data-tag-keyword="${keyword}"]`).click();
      await expectRowTags(row, [tagName]);
      await expect(tagStackOf(row).locator(`.tag-stack__icon[data-tag-keyword="${keyword}"]`)).toHaveCount(1);
      await page.keyboard.press('Escape');
      await waitForPendingMutations(page);
      await expect.poll(() => readTagKeywords(page, [remoteId])).toEqual({ [remoteId]: [keyword] });
      await expectServerKeyword(jmap, remoteId, keyword, true);
      await expect.poll(() => readDefinitions(page)).toEqual(expect.arrayContaining([
        expect.objectContaining({ keyword, name: tagName }),
      ]));
      await screenshot('03-unicode-chip');

      await page.getByRole('button', { name: 'Manage Tags', exact: true }).click();
      const manager = page.locator('[data-tag-manager]');
      const entry = manager.locator(`[data-tag-setting="${keyword}"]`);
      await expect(manager.locator('[data-tag-editor-name]')).toBeFocused();
      await entry.locator('.tag-editor__name').fill(renamed);
      await entry.locator('.tag-editor__name').press('Enter');
      await entry.locator('input[type="color"]').fill('#123456');
      await expect.poll(() => readDefinitions(page)).toEqual(expect.arrayContaining([
        expect.objectContaining({ keyword, name: renamed, color: '#123456' }),
      ]));
      await expect(manager.locator('.tag-editor__status')).not.toContainText('failed');
      await screenshot('04-manager-renamed');

      const name = manager.locator('[data-tag-editor-name]');
      await name.fill('😀'.repeat(101));
      await expect(manager.locator('[data-tag-editor-submit]')).toBeDisabled();
      await expect(manager.locator('#tag-editor-name-help')).toHaveText('Use 100 characters or fewer.');
      await screenshot('05-validation');
      await name.fill('😀'.repeat(100));
      await expect(manager.locator('[data-tag-editor-submit]')).toBeEnabled();
      await manager.locator('[data-tag-editor-submit]').click();
      await expect(name).toHaveValue('');
      await expect.poll(() => readDefinitions(page)).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: '😀'.repeat(100) }),
      ]));
      await screenshot('06-long-unicode-name');
      await page.setViewportSize({ width: 390, height: 844 });
      await expect.poll(async () => (await entry.locator('.tag-editor__name').boundingBox())?.width).toBeGreaterThan(80);
      await expect.poll(() => manager.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await screenshot('07-mobile-manager');
      await page.setViewportSize({ width: 1280, height: 800 });

      await page.getByRole('button', { name: 'Close tags', exact: true }).click();
      await waitForPendingMutations(page);
      await expect.poll(() => readRemoteDefinitions(page, jmap), { timeout: 30_000 }).toEqual(await readDefinitions(page));
      await page.reload();
      await expectRowSoon(page, subject);
      await expectRowTags(rowFor(page, subject), [renamed]);
      await page.getByRole('button', { name: 'Manage Tags', exact: true }).click();
      await expect(entry.locator('.tag-editor__name')).toHaveValue(renamed);
      await expect(entry.locator('input[type="color"]')).toHaveValue('#123456');
      await entry.locator('[data-action="delete"]').hover();
      await screenshot('08-delete-hover');
      await entry.locator('[data-action="delete"]').click();
      await expect(entry).toHaveCount(0);
      await page.getByRole('button', { name: 'Close tags', exact: true }).click();
      await expectRowTags(rowFor(page, subject), [keyword]);
      await page.getByRole('button', { name: 'Manage Tags', exact: true }).click();
      await manager.locator(`[data-tag-editor-adopt="${keyword}"]`).click();
      await expect(manager.locator('#tag-editor-name-help')).toHaveText('Use 100 characters or fewer.');
      await expect(manager.locator('[data-tag-editor-submit]')).toBeDisabled();
      await manager.locator('[data-tag-editor-name]').fill(renamed);
      await manager.locator('[data-tag-editor-submit]').click();
      await expect(entry).toBeVisible();
      await expect(manager.locator('.tag-editor__status')).not.toContainText('failed');
      await expect.poll(() => readDefinitions(page)).toEqual(expect.arrayContaining([
        expect.objectContaining({ keyword, name: renamed }),
      ]));
      await screenshot('09-adopted');
      await page.getByRole('button', { name: 'Close tags', exact: true }).click();
      await rowFor(page, subject).locator('.msg-list__subject').click();
      await page.locator(`[data-message-tags] [data-tag-keyword="${keyword}"] .tag-chip__remove`).click();
      await waitForPendingMutations(page);
      await expect.poll(() => readTagKeywords(page, [remoteId])).toEqual({ [remoteId]: [] });
      await expectServerKeyword(jmap, remoteId, keyword, false);
      const arabicName = `العربية${suffix}`;
      const arabicKeyword = await defineTag(page, arabicName);
      const messageTags = page.locator('[data-message-tags]');
      await page.locator('.message-view__header [data-tag-picker-trigger]').click();
      await popover.locator(`[data-tag-keyword="${arabicKeyword}"]`).click();
      await expect(messageTags.locator('.tag-chip')).toHaveText([arabicName]);
      await page.keyboard.press('Escape');
      await waitForPendingMutations(page);
      await expectServerKeyword(jmap, remoteId, arabicKeyword, true);
      await screenshot('10-reader-unicode');
      await page.locator('.message-view__action[aria-label="Back"]').click();

      const secondSubject = `${subject} bulk`;
      secondId = await createEmailInMailbox(jmap, {
        mailboxId: inbox.id, fromEmail: selfEmail(), subject: secondSubject,
        bodyText: 'Bulk Unicode fixture', keywords: { $seen: true },
      });
      await expectRowSoon(page, secondSubject);
      const emojiName = `📬${suffix}`;
      const emojiKeyword = await defineTag(page, emojiName);
      await expect.poll(() => readTagKeywords(page, [secondId])).toEqual({ [secondId]: [] });
      const firstRow = page.locator('.msg-list__items > li').filter({
        has: page.locator('.msg-list__subject', { hasText: new RegExp(`^${subject}$`) }),
      });
      await firstRow.locator('.msg-list__check input').click();
      await rowFor(page, secondSubject).locator('.msg-list__check input').click();
      const bulk = page.locator('.msg-list__bulk-actions');
      await bulk.locator('[data-tag-picker-trigger]').click();
      await bulk.locator(`[data-tag-keyword="${emojiKeyword}"]`).click();
      await expect(bulk.locator(`[data-tag-keyword="${emojiKeyword}"]`)).toHaveAttribute('aria-checked', 'true');
      await expectRowTags(rowFor(page, secondSubject), [emojiName]);
      await screenshot('11-bulk-unicode');
      await page.keyboard.press('Escape');
      await bulk.locator('[title="Clear selection"]').click();
      await waitForPendingMutations(page);
      await expect.poll(() => readTagKeywords(page, [remoteId, secondId])).toEqual({
        [remoteId]: [arabicKeyword, emojiKeyword].sort(), [secondId]: [emojiKeyword],
      });
      await expectServerKeyword(jmap, remoteId, emojiKeyword, true);
      await expectServerKeyword(jmap, secondId, emojiKeyword, true);
      await expect.poll(() => readRemoteDefinitions(page, jmap), { timeout: 30_000 }).toEqual(await readDefinitions(page));
    } finally {
      try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await page.evaluate(async (messageTags) => {
        const [account] = await window.__repo.listAccounts();
        await window.__repo.applySettingsPatch(account.id, { messageTags });
      }, saved);
      await waitForPendingMutations(page);
      await expect.poll(() => readDefinitions(page)).toEqual(saved);
      await expect.poll(() => readRemoteDefinitions(page, jmap), { timeout: 30_000 }).toEqual(saved);
      } finally {
        await destroyEmails(jmap, [remoteId, secondId].filter(Boolean));
      }
    }
  });

  test('row menu, bulk menu, digits and chips agree with cache and server', async ({ sharedPage: page }, testInfo) => {
    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    if (!inbox) {
      throw new Error(`Test requires Inbox mailbox; saw ${mailboxes.map((m) => `${m.name}:${m.role}`).join(', ')}`);
    }

    const fromEmail = selfEmail();
    const stamp = Date.now();
    const subjects = {
      hover: `${SUBJECT_PREFIX} ${stamp} hover`,
      bulkA: `${SUBJECT_PREFIX} ${stamp} bulk a`,
      bulkB: `${SUBJECT_PREFIX} ${stamp} bulk b`,
      plain: `${SUBJECT_PREFIX} ${stamp} plain`,
    };
    const ids = {};
    try {
      for (const [key, subject] of Object.entries(subjects)) {
        ids[key] = await createEmailInMailbox(jmap, {
          mailboxId: inbox.id,
          fromEmail,
          subject,
          bodyText: 'tag fixture',
          keywords: { $seen: true },
        });
      }
      for (const subject of Object.values(subjects)) {
        await expectRowSoon(page, subject);
      }

      // Row Tag menu: hidden at rest, shown on hover; a click opens the
      // popover, a toggle applies at once and keeps the menu open.
      const hoverRow = rowFor(page, subjects.hover);
      const hoverTag = hoverRow.locator('.msg-list__action--tag');
      await expect(hoverTag).toBeHidden();
      await hoverRow.hover();
      await expect(hoverTag).toBeVisible();
      await hoverTag.click();
      const popover = page.locator('[data-tag-picker-popover]');
      await expect(popover).toBeVisible();
      // Focus lands on the first item, so the digits work in the menu.
      await expect(popover.locator('[role^="menuitem"]').first()).toBeFocused();
      const workItem = popover.locator(`[data-tag-keyword="${WORK}"]`);
      await expect(workItem).toHaveAttribute('aria-checked', 'false');
      await workItem.click();
      await expect(workItem).toHaveAttribute('aria-checked', 'true');
      await expect(popover).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(popover).toHaveCount(0);
      await expectRowTags(hoverRow, ['Work']);

      // Bulk Tag menu over two rows: tri-state reads none, then all.
      for (const subject of [subjects.bulkA, subjects.bulkB]) {
        await rowFor(page, subject).locator('.msg-list__check input').click();
      }
      const bulkTrigger = page.locator('.msg-list__bulk-actions [data-tag-picker-trigger]');
      await expect(bulkTrigger).toHaveAccessibleName('Tag selected messages');
      await bulkTrigger.click();
      const bulkTodo = page.locator(`.msg-list__bulk-actions [data-tag-keyword="${TODO}"]`);
      await expect(bulkTodo).toHaveAttribute('aria-checked', 'false');
      await bulkTodo.click();
      await expect(bulkTodo).toHaveAttribute('aria-checked', 'true');
      // Digit 2 in the open menu toggles the second tag (Work) onto the same selection.
      await page.keyboard.press('2');
      await expect(page.locator(`.msg-list__bulk-actions [data-tag-keyword="${WORK}"]`)).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('Escape');
      await page.locator('.msg-list__bulk-actions [title="Clear selection"]').click();
      await expectRowTags(rowFor(page, subjects.bulkA), ['Work', 'To Do']);
      await expectRowTags(rowFor(page, subjects.bulkB), ['Work', 'To Do']);
      await expectRowTags(rowFor(page, subjects.plain), []);

      await waitForPendingMutations(page);

      // The cache converges once every mutation's own Email/changes refresh
      // has landed; an earlier refresh can transiently hold a later
      // optimistic keyword back, so the read polls.
      await expect.poll(() => readTagKeywords(page, Object.values(ids)), {
        message: 'local cache should hold the keywords for the test rows',
      }).toEqual({
        [ids.hover]: [WORK],
        [ids.bulkA]: [WORK, TODO],
        [ids.bulkB]: [WORK, TODO],
        [ids.plain]: [],
      });

      try {
        await expectServerKeyword(jmap, ids.hover, WORK, true);
        await expectServerKeyword(jmap, ids.bulkA, WORK, true);
        await expectServerKeyword(jmap, ids.bulkA, TODO, true);
        await expectServerKeyword(jmap, ids.bulkB, TODO, true);
        await expectServerKeyword(jmap, ids.plain, WORK, false);
      } catch (err) {
        await testInfo.attach('recent-mutations.json', {
          body: JSON.stringify(await readRecentMutations(page), null, 2),
          contentType: 'application/json',
        });
        throw err;
      }

      // Open message: chips are removable and 0 clears every tag on the
      // selection. Earlier writes are drained before each step so their
      // StateChange refresh cannot overwrite the optimistic change.
      await waitForPendingMutations(page);
      await rowFor(page, subjects.hover).locator('.msg-list__subject').click();
      const viewChips = page.locator('[data-message-tags] .tag-chip');
      await expect(viewChips).toHaveText(['Work']);
      await viewChips.first().locator('.tag-chip__remove').click();
      await expect(viewChips).toHaveCount(0);
      await expectRowTags(rowFor(page, subjects.hover), []);

      await waitForPendingMutations(page);
      await rowFor(page, subjects.bulkB).locator('.msg-list__check input').click();
      await page.keyboard.press('0');
      await page.locator('.msg-list__bulk-actions [title="Clear selection"]').click();
      await expectRowTags(rowFor(page, subjects.bulkB), []);
      await expectRowTags(rowFor(page, subjects.bulkA), ['Work', 'To Do']);

      await waitForPendingMutations(page);
      await expect.poll(() => readTagKeywords(page, [ids.hover, ids.bulkA, ids.bulkB])).toEqual({
        [ids.hover]: [],
        [ids.bulkA]: [WORK, TODO],
        [ids.bulkB]: [],
      });
      await expectServerKeyword(jmap, ids.hover, WORK, false);
      await expectServerKeyword(jmap, ids.bulkB, WORK, false);
      await expectServerKeyword(jmap, ids.bulkB, TODO, false);
      await expectServerKeyword(jmap, ids.bulkA, TODO, true);

      // The row's stack opens the menu; Remove All Tags strips the row.
      const bulkARow = rowFor(page, subjects.bulkA);
      await tagStackOf(bulkARow).click();
      const stackMenu = page.locator('[data-tag-picker-popover]');
      await expect(stackMenu).toBeVisible();
      await stackMenu.locator('[data-tag-picker-clear]').click();
      await expectRowTags(bulkARow, []);
      await expect(stackMenu.locator('[data-tag-picker-clear]')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await waitForPendingMutations(page);
      await expect.poll(() => readTagKeywords(page, [ids.bulkA])).toEqual({ [ids.bulkA]: [] });
      await expectServerKeyword(jmap, ids.bulkA, WORK, false);
      await expectServerKeyword(jmap, ids.bulkA, TODO, false);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await destroyEmails(jmap, Object.values(ids));
    }
  });
});
