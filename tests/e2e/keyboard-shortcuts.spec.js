import { test, expect } from '@playwright/test';

import {
  classifyMailboxState,
  cleanupEmail,
  connectJmap,
  createEmailInMailbox,
  getEmailMailboxIds,
  listMailboxes,
  mailboxByRole,
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
  focusMessageList,
  openMessageBySubject,
  readOpenMessageSubject,
  readRecentMutations,
  readViewCacheForFolderRole,
  trackConsole,
} from './helpers/ui.js';

/**
 * Thunderbird-style keyboard shortcuts — live stack E2E.
 * Runs on both Chromium and Firefox via playwright.config.js projects.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

function composeInput(page, label) {
  return page.locator('.compose-dialog .row')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator('input');
}

test.describe('Keyboard shortcuts e2e', () => {
  test.setTimeout(180_000);

  test.beforeEach(async () => {
    const jmap = await connectJmap();
    await sweepOrphanTestMessages(jmap);
  });

  test('Delete key removes the open Inbox message (list focus)', async ({ page }, testInfo) => {
    const consoleLines = [];
    trackConsole(page, consoleLines);

    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    const trash = mailboxByRole(mailboxes, 'trash');
    if (!inbox || !trash) {
      throw new Error(`Test requires Inbox and Trash mailboxes; saw ${mailboxes.map((m) => `${m.name}:${m.role}`).join(', ')}`);
    }

    const fromEmail = selfEmail();
    const subject = `Keyboard delete e2e ${Date.now()}`;
    let createdId = null;
    try {
      createdId = await createEmailInMailbox(jmap, {
        mailboxId: inbox.id,
        fromEmail,
        subject,
      });

      await loginViaOidc(page);
      await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });

      await clickFolder(page, inbox.name);
      await expect.poll(
        async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
        { timeout: 60_000, message: `expected test message "${subject}" to render in Inbox` },
      ).toBeGreaterThan(0);
      await openMessageBySubject(page, subject);
      await focusMessageList(page);
      await page.keyboard.press('Delete');

      await expect.poll(
        async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
        { timeout: 30_000, message: 'Delete shortcut should remove the row from Inbox' },
      ).toBe(0);

      const inboxCache = await readViewCacheForFolderRole(page, 'inbox');
      expect(inboxCache?.remoteIds ?? []).not.toContain(createdId);

      try {
        await expect.poll(
          async () => classifyMailboxState(await getEmailMailboxIds(jmap, createdId), {
            source: inbox,
            trash,
          }),
          { timeout: 60_000, message: 'server should move deleted message to Trash' },
        ).toBe('trash');
      } catch (err) {
        const mutationRows = await readRecentMutations(page);
        await testInfo.attach('recent-mutations.json', {
          body: JSON.stringify(mutationRows, null, 2),
          contentType: 'application/json',
        });
        throw err;
      }
    } finally {
      await attachConsoleTail(testInfo, consoleLines);
      if (createdId) {
        await cleanupEmail(jmap, createdId, trash.id);
      }
    }
  });

  test('Delete key removes the open message while focus is in the message body iframe', async ({ page }, testInfo) => {
    const consoleLines = [];
    trackConsole(page, consoleLines);

    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    const trash = mailboxByRole(mailboxes, 'trash');
    if (!inbox || !trash) {
      throw new Error(`Test requires Inbox and Trash mailboxes; saw ${mailboxes.map((m) => `${m.name}:${m.role}`).join(', ')}`);
    }

    const fromEmail = selfEmail();
    const subject = `Keyboard delete iframe e2e ${Date.now()}`;
    let createdId = null;
    try {
      createdId = await createEmailInMailbox(jmap, {
        mailboxId: inbox.id,
        fromEmail,
        subject,
        bodyText: 'Delete me from the iframe focus path.',
        htmlBody: '<p>Delete me from the iframe focus path.</p>',
      });

      await loginViaOidc(page);
      await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });

      await clickFolder(page, inbox.name);
      await expect.poll(
        async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
        { timeout: 60_000, message: `expected test message "${subject}" to render in Inbox` },
      ).toBeGreaterThan(0);
      await openMessageBySubject(page, subject);

      const frame = page.frameLocator('.message-view__html-frame');
      await frame.locator('body').click({ position: { x: 8, y: 8 } });
      await page.keyboard.press('Delete');

      await expect.poll(
        async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
        { timeout: 30_000, message: 'Delete shortcut should work when the iframe has focus' },
      ).toBe(0);

      const inboxCache = await readViewCacheForFolderRole(page, 'inbox');
      expect(inboxCache?.remoteIds ?? []).not.toContain(createdId);

      await expect.poll(
        async () => classifyMailboxState(await getEmailMailboxIds(jmap, createdId), {
          source: inbox,
          trash,
        }),
        { timeout: 60_000, message: 'server should move iframe-focused delete to Trash' },
      ).toBe('trash');
    } finally {
      await attachConsoleTail(testInfo, consoleLines);
      if (createdId) {
        await cleanupEmail(jmap, createdId, trash.id);
      }
    }
  });

  test('Delete key bulk-deletes checkbox-selected rows', async ({ page }, testInfo) => {
    const consoleLines = [];
    trackConsole(page, consoleLines);

    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    const trash = mailboxByRole(mailboxes, 'trash');
    if (!inbox || !trash) {
      throw new Error(`Test requires Inbox and Trash mailboxes; saw ${mailboxes.map((m) => `${m.name}:${m.role}`).join(', ')}`);
    }

    const fromEmail = selfEmail();
    const stamp = Date.now();
    const subjects = [
      `Keyboard bulk delete e2e ${stamp} a`,
      `Keyboard bulk delete e2e ${stamp} b`,
    ];
    const createdIds = [];
    try {
      for (const subject of subjects) {
        createdIds.push(await createEmailInMailbox(jmap, {
          mailboxId: inbox.id,
          fromEmail,
          subject,
        }));
      }

      await loginViaOidc(page);
      await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });

      await clickFolder(page, inbox.name);
      for (const subject of subjects) {
        await expect.poll(
          async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
          { timeout: 60_000, message: `expected "${subject}" in Inbox` },
        ).toBeGreaterThan(0);
      }

      for (const subject of subjects) {
        const checkbox = page.locator('.msg-list__items > li')
          .filter({ hasText: subject })
          .first()
          .locator('.msg-list__check input');
        await checkbox.click();
        await expect(checkbox).toBeChecked();
      }
      await expect(page.locator('.msg-list__count')).toHaveText(/^2 selected/, { timeout: 5_000 });

      await page.keyboard.press('Delete');

      for (const subject of subjects) {
        await expect.poll(
          async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
          { timeout: 30_000, message: `bulk Delete shortcut should remove "${subject}"` },
        ).toBe(0);
      }

      const inboxCache = await readViewCacheForFolderRole(page, 'inbox');
      for (const remoteId of createdIds) {
        expect(inboxCache?.remoteIds ?? []).not.toContain(remoteId);
      }

      for (const remoteId of createdIds) {
        try {
          await expect.poll(
            async () => classifyMailboxState(
              await getEmailMailboxIds(jmap, remoteId),
              { source: inbox, trash },
            ),
            { timeout: 60_000, message: `server should move ${remoteId} to Trash` },
          ).toBe('trash');
        } catch (err) {
          const mutationRows = await readRecentMutations(page);
          await testInfo.attach('recent-mutations.json', {
            body: JSON.stringify(mutationRows, null, 2),
            contentType: 'application/json',
          });
          throw err;
        }
      }
    } finally {
      await attachConsoleTail(testInfo, consoleLines);
      for (const id of createdIds) {
        await cleanupEmail(jmap, id, trash.id);
      }
    }
  });

  test('F moves to the next message and Ctrl+N opens compose', async ({ page }) => {
    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    const trash = mailboxByRole(mailboxes, 'trash');
    if (!inbox || !trash) throw new Error('Test requires Inbox and Trash mailboxes');

    const fromEmail = selfEmail();
    const stamp = Date.now();
    const subjects = [
      `Keyboard nav e2e ${stamp} first`,
      `Keyboard nav e2e ${stamp} second`,
    ];
    const createdIds = [];
    try {
      for (const subject of subjects) {
        createdIds.push(await createEmailInMailbox(jmap, {
          mailboxId: inbox.id,
          fromEmail,
          subject,
        }));
      }

      await loginViaOidc(page);
      await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });
      await clickFolder(page, inbox.name);
      for (const subject of subjects) {
        await expect.poll(
          async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
          { timeout: 60_000, message: `expected test message "${subject}" to render in Inbox` },
        ).toBeGreaterThan(0);
      }

      await openMessageBySubject(page, subjects[0]);
      await focusMessageList(page);
      await page.keyboard.press('f');
      await expect.poll(
        async () => readOpenMessageSubject(page),
        { timeout: 10_000, message: 'F should open the next message' },
      ).toBe(subjects[1]);

      await page.keyboard.press('Control+n');
      await expect(page.locator('.compose-dialog')).toBeVisible({ timeout: 5_000 });
    } finally {
      for (const id of createdIds) {
        await cleanupEmail(jmap, id, trash.id);
      }
    }
  });

  test('reply, reply-all, and forward shortcuts open compose with quoted context', async ({ page }, testInfo) => {
    const consoleLines = [];
    trackConsole(page, consoleLines);

    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    const trash = mailboxByRole(mailboxes, 'trash');
    if (!inbox || !trash) throw new Error('Test requires Inbox and Trash mailboxes');

    const fromEmail = 'reply-source@example.net';
    const subject = `Keyboard reply e2e ${Date.now()}`;
    let createdId = null;
    try {
      createdId = await createEmailInMailbox(jmap, {
        mailboxId: inbox.id,
        fromEmail,
        subject,
        bodyText: 'Quoted keyboard reply body',
        htmlBody: '<p>Quoted keyboard reply body</p>',
      });

      await loginViaOidc(page);
      await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });
      await clickFolder(page, inbox.name);
      await expect.poll(
        async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
        { timeout: 60_000, message: `expected test message "${subject}" to render in Inbox` },
      ).toBeGreaterThan(0);
      await openMessageBySubject(page, subject);

      const cases = [
        { shortcut: 'Control+R', expectedSubject: `Re: ${subject}`, expectedTo: fromEmail },
        { shortcut: 'Control+Shift+R', expectedSubject: `Re: ${subject}`, expectedTo: fromEmail },
        { shortcut: 'Control+L', expectedSubject: `Fwd: ${subject}`, expectedTo: '' },
      ];

      for (const c of cases) {
        await focusMessageList(page);
        await page.keyboard.press(c.shortcut);
        await expect(page.locator('.compose-dialog')).toBeVisible({ timeout: 5_000 });
        await expect(composeInput(page, 'Subject')).toHaveValue(c.expectedSubject);
        await expect(composeInput(page, 'To')).toHaveValue(c.expectedTo);
        await expect(page.locator('.compose-dialog .editor')).toContainText('Quoted keyboard reply body');
        await page.getByRole('button', { name: /^discard$/i }).click();
        await expect(page.locator('.compose-dialog')).toBeHidden();
      }
    } finally {
      await attachConsoleTail(testInfo, consoleLines);
      if (createdId) {
        await cleanupEmail(jmap, createdId, trash.id);
      }
    }
  });
});
