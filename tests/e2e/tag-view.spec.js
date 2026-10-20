import {
  connectJmap,
  createEmailInMailbox,
  destroyEmails,
  getEmailKeywords,
  getEmailMailboxIds,
  jmapRequest,
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
import { localStackEnabled, selfEmail, skipLocalStackMessage } from './helpers/stack-env.js';
import { expectRowSoon, waitForPendingMutations } from './helpers/ui.js';

test.skip(!localStackEnabled, skipLocalStackMessage);

const SUBJECT_PREFIX = 'Tag view e2e';
const PERSONAL = '$label3';

async function readTagView(page, keyword) {
  return page.evaluate(async (kw) => {
    const accounts = await globalThis.__repo.listAccounts();
    const account = accounts.find((row) => row.is_primary) ?? accounts[0];
    const rows = await globalThis.__repo.listMessagesForKeyword({
      accountIds: [account.id], keyword: kw, offset: 0, limit: 2000,
    });
    return rows.map((r) => ({ remoteId: r.remote_id, sourceFolderId: r.source_folder_id }));
  }, keyword);
}

function rowFor(page, subject) {
  return page.locator('.msg-list__items > li').filter({ hasText: subject }).first();
}

function tagNode(page, keyword = PERSONAL) {
  return page.locator(`[data-tag-view="${keyword}"]`);
}

async function openFolder(page, folder) {
  await page.locator('.folder-node').filter({ hasText: folder.name }).first()
    .locator('.folder-node__button').click();
  await expect(page.locator('.msg-list')).toHaveAttribute('aria-label', `${folder.name} messages, column 1`);
}

async function openTag(page, keyword = PERSONAL) {
  await tagNode(page, keyword).locator('button').click();
  await expect(page.locator('.msg-list')).toHaveAttribute('aria-label', /(?:Personal|Starred) messages/);
}

async function createFixture(jmap, folder, subject, keywords = {}) {
  return createEmailInMailbox(jmap, {
    mailboxId: folder.id, fromEmail: selfEmail(), subject, bodyText: 'tag view fixture',
    keywords: { $seen: true, [PERSONAL]: true, ...keywords },
  });
}

async function expectCachedMembership(page, remoteId, folderIds) {
  await expect.poll(() => page.evaluate(async ({ id }) => {
    const rows = await globalThis.__repo.call('db.query', {
      sql: `SELECT f.remote_id FROM folder_messages fm
            JOIN messages m ON m.id = fm.message_id
            JOIN folders f ON f.id = fm.folder_id
            WHERE m.remote_id = ? ORDER BY f.remote_id`,
      params: [id],
    });
    return rows.map((row) => row.remote_id);
  }, { id: remoteId })).toEqual([].concat(folderIds).sort());
}

test.describe('Tag view e2e', () => {
  test.beforeEach(async ({ sharedPage }) => {
    await resetSharedSession(sharedPage);
    const jmap = await connectJmap();
    await sweepOrphanTestMessages(jmap, { subjectPrefix: SUBJECT_PREFIX });
  });

  test('tag and Starred views exclude Trash and Archive, including multiple memberships', async ({ sharedPage: page }, testInfo) => {
    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    const sent = mailboxByRole(mailboxes, 'sent');
    const archive = mailboxByRole(mailboxes, 'archive');
    const trash = mailboxByRole(mailboxes, 'trash');
    const stamp = Date.now();
    const subjects = Object.fromEntries(['inbox', 'sent', 'archive', 'trash', 'multiple']
      .map((key) => [key, `${SUBJECT_PREFIX} ${stamp} ${key}`]));
    const ids = {};
    try {
      for (const [name, folder] of Object.entries({ inbox, sent, archive, trash, multiple: inbox })) {
        ids[name] = await createFixture(jmap, folder, subjects[name], { $flagged: true });
      }
      const response = await jmapRequest(jmap, [['Email/set', {
        accountId: jmap.accountId,
        update: { [ids.multiple]: { mailboxIds: { [inbox.id]: true, [archive.id]: true } } },
      }, 'multi']]);
      expect(pickResponse(response, 'Email/set')?.updated).toHaveProperty(ids.multiple);
      for (const [name, folder] of Object.entries({ inbox, sent, archive, trash })) {
        await openFolder(page, folder);
        await expectRowSoon(page, subjects[name]);
      }
      await expectCachedMembership(page, ids.multiple, [inbox.id, archive.id]);
      for (const keyword of [PERSONAL, '$flagged']) {
        await openTag(page, keyword);
        await expect(rowFor(page, subjects.inbox)).toBeVisible();
        await expect(rowFor(page, subjects.sent)).toBeVisible();
        for (const name of ['archive', 'trash', 'multiple']) {
          await expect(rowFor(page, subjects[name])).toHaveCount(0);
        }
        await expect.poll(async () => (await readTagView(page, keyword))
          .map((row) => row.remoteId).filter((id) => Object.values(ids).includes(id)).sort())
          .toEqual([ids.inbox, ids.sent].sort());
        const count = (await readTagView(page, keyword)).length;
        await expect(tagNode(page, keyword).locator('.tag-view-node__count')).toHaveText(String(count));
      }
      await openTag(page);
      const header = await page.locator('.selectable-list-header').elementHandle();
      await page.locator('.msg-list__select-all input').click();
      await expect(rowFor(page, subjects.inbox)).toHaveClass(/is-selected/);
      await expect(rowFor(page, subjects.sent)).toHaveClass(/is-selected/);
      expect(await header.evaluate((element) => element.isConnected)).toBe(true);
      await page.locator('.msg-list__select-all input').click();
      await expect(rowFor(page, subjects.inbox)).not.toHaveClass(/is-selected/);

      const inboxRow = rowFor(page, subjects.inbox);
      await inboxRow.hover();
      for (const title of ['Archive', 'Delete']) {
        await expect(inboxRow.locator(`.msg-list__action[title="${title}"]`)).toBeVisible();
      }
      await expect(inboxRow.locator('.msg-list__item')).toHaveAttribute('draggable', 'false');
      await inboxRow.locator('.msg-list__open').click();
      for (const label of ['Archive', 'Delete', 'Mark as junk']) {
        await expect(page.locator(`.message-view__action[aria-label="${label}"]`)).toBeVisible();
      }
      await waitForPendingMutations(page);
      await page.locator('[data-message-tags] .tag-chip').filter({ hasText: 'Personal' })
        .locator('.tag-chip__remove').click();
      await expect(rowFor(page, subjects.inbox)).toHaveCount(0);
      await expect(rowFor(page, subjects.sent)).toBeVisible();
      await waitForPendingMutations(page);
      await expect.poll(async () => (await getEmailKeywords(jmap, ids.inbox))?.[PERSONAL] ?? false).toBe(false);
      expect((await readTagView(page, PERSONAL)).some((row) => row.remoteId === ids.inbox)).toBe(false);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await destroyEmails(jmap, Object.values(ids));
    }
  });

  for (const surface of ['bulk', 'reading pane']) {
    for (const [role, label] of [['archive', 'Archive'], ['trash', 'Delete'], ['junk', 'Mark as junk']]) {
      test(`${surface} files tagged messages from different folders into ${role}`, async ({ sharedPage: page }, testInfo) => {
        const jmap = await connectJmap();
        const mailboxes = await listMailboxes(jmap);
        const sourceFolders = ['inbox', 'sent'].map((source) => mailboxByRole(mailboxes, source));
        const destination = mailboxByRole(mailboxes, role);
        const subjects = sourceFolders.map((folder, i) => `${SUBJECT_PREFIX} ${Date.now()} ${surface} ${role} ${i}`);
        const ids = [];
        try {
          for (const [i, folder] of sourceFolders.entries()) {
            ids.push(await createFixture(jmap, folder, subjects[i], { $notjunk: true }));
          }
          for (const [i, folder] of sourceFolders.entries()) {
            await openFolder(page, folder);
            await expectRowSoon(page, subjects[i]);
          }
          await openTag(page);
          for (const subject of subjects) await expect(rowFor(page, subject)).toBeVisible();
          const initialCount = (await readTagView(page, PERSONAL)).length;
          if (surface === 'bulk') {
            for (const subject of subjects) await rowFor(page, subject).locator('.msg-list__check input').click();
            await page.locator(`.msg-list__bulk-actions [aria-label="${label}"]`).click();
          } else {
            for (const subject of subjects) {
              const title = page.locator('.message-view__title h2');
              if (await title.count() === 0 || await title.textContent() !== subject) {
                await rowFor(page, subject).locator('.msg-list__open').click();
              }
              await expect(title).toHaveText(subject);
              await page.locator(`.message-view__action[aria-label="${label}"]`).click();
              await waitForPendingMutations(page);
              await expect.poll(async () => Object.keys(await getEmailMailboxIds(jmap, ids[subjects.indexOf(subject)]) ?? {}))
                .toEqual([destination.id]);
              if (role !== 'junk') await expect(rowFor(page, subject)).toHaveCount(0);
            }
          }
          await waitForPendingMutations(page);
          for (const [i, id] of ids.entries()) {
            await expect.poll(async () => Object.keys(await getEmailMailboxIds(jmap, id) ?? {}))
              .toEqual([destination.id]);
            await expectCachedMembership(page, id, destination.id);
            await expect.poll(() => page.evaluate(async ({ remoteId, tag }) => {
              const [row] = await globalThis.__repo.call('db.query', {
                sql: 'SELECT keywords_json, is_junk FROM messages WHERE remote_id = ?',
                params: [remoteId],
              });
              if (!row) return null;
              const keywords = JSON.parse(row.keywords_json ?? '{}');
              return {
                tagged: keywords[tag] === true,
                junk: keywords.$junk === true,
                notJunk: keywords.$notjunk === true,
                isJunk: Number(row.is_junk) === 1,
              };
            }, { remoteId: id, tag: PERSONAL })).toEqual({
              tagged: true,
              junk: role === 'junk',
              notJunk: role !== 'junk',
              isJunk: role === 'junk',
            });
            const keywords = await getEmailKeywords(jmap, id);
            expect(keywords[PERSONAL]).toBe(true);
            if (role === 'junk') {
              expect(keywords.$junk).toBe(true);
              expect(keywords.$notjunk ?? false).toBe(false);
              await expect(rowFor(page, subjects[i])).toBeVisible();
            } else {
              await expect(rowFor(page, subjects[i])).toHaveCount(0);
            }
          }
          const expectedCount = role === 'junk' ? initialCount : initialCount - ids.length;
          await expect.poll(async () => (await readTagView(page, PERSONAL)).length).toBe(expectedCount);
          if (expectedCount > 0) {
            await expect(tagNode(page).locator('.tag-view-node__count')).toHaveText(String(expectedCount));
          } else {
            await expect(tagNode(page).locator('.tag-view-node__count')).toHaveCount(0);
          }
          await expect(page.locator('.msg-list__check input:checked')).toHaveCount(0);
        } finally {
          await attachConsoleTail(testInfo, consoleLinesFor(page));
          await destroyEmails(jmap, ids);
        }
      });
    }
  }
});
