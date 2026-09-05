import { expect } from '@playwright/test';

import {
  connectJmap,
  destroyEmails,
  jmapRequest,
  listMailboxes,
  mailboxByRole,
  pickResponse,
} from './helpers/jmap-client.js';
import { composeSubject, fillRecipient, waitForIdentities } from './helpers/compose.js';
import {
  resetSharedSession,
  test,
} from './helpers/shared-session.js';
import { SHARED_TEST_OIDC_EMAIL } from './helpers/stack-env.js';
import {
  clickFolder,
  expectRowSoon,
  openMessageBySubject,
  waitForPendingMutations,
} from './helpers/ui.js';

const SUBJECT_PREFIX = 'SendLaterFlow e2e';

async function matchingEmails(jmap, subjectPrefix) {
  const response = await jmapRequest(jmap, [
    [
      'Email/query',
      {
        accountId: jmap.accountId,
        filter: { subject: subjectPrefix },
        position: 0,
        limit: 100,
      },
      'email-query',
    ],
    [
      'Email/get',
      {
        accountId: jmap.accountId,
        '#ids': {
          resultOf: 'email-query',
          name: 'Email/query',
          path: '/ids',
        },
        properties: ['id', 'subject', 'mailboxIds', 'keywords'],
      },
      'email-get',
    ],
  ]);
  return (pickResponse(response, 'Email/get')?.list ?? [])
    .filter((email) => email.subject?.startsWith(subjectPrefix));
}

async function submissionsForEmails(jmap, emailIds) {
  if (emailIds.length === 0) return [];
  const response = await jmapRequest(jmap, [
    [
      'EmailSubmission/query',
      { accountId: jmap.accountId, position: 0, limit: 500 },
      'submission-query',
    ],
    [
      'EmailSubmission/get',
      {
        accountId: jmap.accountId,
        '#ids': {
          resultOf: 'submission-query',
          name: 'EmailSubmission/query',
          path: '/ids',
        },
        properties: ['id', 'emailId', 'undoStatus'],
      },
      'submission-get',
    ],
  ]);
  const wanted = new Set(emailIds);
  return (pickResponse(response, 'EmailSubmission/get')?.list ?? [])
    .filter((submission) => wanted.has(submission.emailId));
}

async function scheduledMailboxOf(jmap) {
  const mailboxes = await listMailboxes(jmap);
  return mailboxes.find(
    (mailbox) => mailbox.name === 'Scheduled' && !mailbox.role && !mailbox.parentId,
  ) ?? null;
}

async function cleanupSendLaterArtifacts(jmap) {
  const emails = await matchingEmails(jmap, SUBJECT_PREFIX);
  const emailIds = emails.map((email) => email.id);
  const submissions = await submissionsForEmails(jmap, emailIds);
  const pending = submissions.filter((submission) => submission.undoStatus === 'pending');
  if (pending.length > 0) {
    await jmapRequest(jmap, [[
      'EmailSubmission/set',
      {
        accountId: jmap.accountId,
        update: Object.fromEntries(
          pending.map((submission) => [submission.id, { undoStatus: 'canceled' }]),
        ),
      },
      'submission-cancel',
    ]]);
  }
  if (submissions.length > 0) {
    await jmapRequest(jmap, [[
      'EmailSubmission/set',
      {
        accountId: jmap.accountId,
        destroy: submissions.map((submission) => submission.id),
      },
      'submission-destroy',
    ]]);
  }
  await destroyEmails(jmap, emailIds);
  // A discarded pre-release build managed a hidden mailbox and cached
  // its id in the synced settings document. Destroying it forces the
  // ensure path to verify the stale cache, rediscover, and create the
  // real Scheduled mailbox.
  const leftovers = (await listMailboxes(jmap))
    .filter((mailbox) => String(mailbox.name ?? '').startsWith('__stormbox_internal_'));
  if (leftovers.length > 0) {
    await jmapRequest(jmap, [[
      'Mailbox/set',
      {
        accountId: jmap.accountId,
        destroy: leftovers.map((mailbox) => mailbox.id),
        onDestroyRemoveEmails: true,
      },
      'legacy-scheduled-destroy',
    ]]);
  }
  // The managed mailbox remains visible even when cleanup leaves it empty.
  const scheduled = await scheduledMailboxOf(jmap);
  if (scheduled && scheduled.isSubscribed !== true) {
    await jmapRequest(jmap, [[
      'Mailbox/set',
      {
        accountId: jmap.accountId,
        update: { [scheduled.id]: { isSubscribed: true } },
      },
      'scheduled-subscribe',
    ]]);
  }
}

/** Scheduling columns on normal message rows, straight from the cache. */
async function localScheduledRows(page) {
  return page.evaluate(async () => {
    if (!globalThis.__repo) return null;
    const [account] = await globalThis.__repo.listAccounts();
    if (!account) return null;
    return globalThis.__repo.call('db.query', {
      sql: `SELECT subject, sent_at, scheduled_undo_status AS status
              FROM messages
             WHERE account_id = ? AND scheduled_undo_status IS NOT NULL
             ORDER BY sent_at`,
      params: [account.id],
    });
  });
}

async function openComposer(page) {
  await page.keyboard.press('c');
  const composer = page.locator('.compose-dialog--expanded');
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await waitForIdentities(page);
  return composer;
}

async function fillMessage(page, composer, subject) {
  await fillRecipient(page, 'To', SHARED_TEST_OIDC_EMAIL);
  await composeSubject(page).fill(subject);
  await composer.getByRole('textbox', { name: 'Message body' })
    .fill('This body remains readable while delivery is scheduled.');
}

async function openScheduleMenu(page, composer) {
  const scheduleTrigger = composer.locator('.compose-schedule-menu__trigger');
  await expect.poll(
    () => scheduleTrigger.getAttribute('aria-disabled'),
    { timeout: 30_000, message: 'schedule control should become capability-enabled' },
  ).toBeNull();
  await scheduleTrigger.click();
  const menu = composer.getByRole('menu', { name: 'Schedule send' });
  await expect(menu).toBeVisible();
  return menu;
}

test.describe('Send Later', () => {
  test.beforeEach(async ({ sharedPage }) => {
    await sharedPage.setViewportSize({ width: 1280, height: 720 });
    await resetSharedSession(sharedPage, {
      extraSubjectPrefixes: [SUBJECT_PREFIX],
    });
    await cleanupSendLaterArtifacts(await connectJmap());
  });

  test('keeps the schedule menu inside the viewport on narrow screens', async ({ sharedPage: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const composer = await openComposer(page);
    const menu = await openScheduleMenu(page, composer);

    const menuBox = await menu.boundingBox();
    const viewport = page.viewportSize();
    expect(menuBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width);
  });

  test('schedules, lists soonest-first, reads, and cancels through the real folder', async ({ sharedPage: page }) => {
    test.setTimeout(120_000);
    const jmap = await connectJmap();
    const stamp = Date.now();
    const subjectLater = `${SUBJECT_PREFIX} later ${stamp}`;
    const subjectSoon = `${SUBJECT_PREFIX} soon ${stamp}`;
    const scheduledFolderName = page.locator('.folder-node__name')
      .filter({ hasText: /^Scheduled$/ });

    try {
      // ---- schedule #1 via a preset (tomorrow morning) ----------------
      let composer = await openComposer(page);
      await fillMessage(page, composer, subjectLater);

      const sendButton = composer.getByRole('button', { name: 'Send', exact: true });
      await expect(sendButton).toBeEnabled();
      let menu = await openScheduleMenu(page, composer);

      const presetLabels = [
        'Later today',
        'This evening',
        'Tomorrow',
        'This weekend',
        'Next week',
      ];
      const menuItems = menu.getByRole('menuitem');
      await expect(menuItems).toHaveCount(6);
      for (const label of presetLabels) {
        const item = menuItems.filter({ hasText: label });
        await expect(item).toHaveCount(1);
        await expect(item.locator('.compose-schedule-menu__secondary')).not.toHaveText('');
        await expect(item.locator('.compose-schedule-menu__secondary'))
          .not.toContainText('Checking whether');
      }

      await menuItems.filter({ hasText: 'Tomorrow' }).click();
      await expect(composer).toBeVisible();
      await expect(composer.locator('.compose-send')).toHaveText(/Send/);
      await expect(composer.locator('.compose-schedule-menu__selection')).toHaveText('Tomorrow');
      await composer.locator('.compose-send').click();
      await expect(composer).toBeHidden({ timeout: 30_000 });

      // The real folder appears in the tree once a schedule is active.
      await expect(scheduledFolderName).toBeVisible({ timeout: 30_000 });

      // ---- schedule #2 via the custom picker (next quarter-hour) ------
      composer = await openComposer(page);
      await fillMessage(page, composer, subjectSoon);
      menu = await openScheduleMenu(page, composer);
      await menu.getByRole('menuitem').filter({ hasText: 'Choose a date and time' }).click();
      const scheduleDialog = page.getByRole('dialog', { name: 'Choose a date and time' });
      await expect(scheduleDialog).toBeVisible();
      await expect(scheduleDialog.getByRole('status')).toContainText(/Sends /);
      await scheduleDialog.getByRole('combobox', { name: 'Datepicker input' }).click();
      const datePickerPopup = page.getByRole('dialog', { name: 'Datepicker menu' });
      await expect(datePickerPopup).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(datePickerPopup).toBeHidden();
      await expect(scheduleDialog).toBeVisible();
      await expect(composer).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(scheduleDialog).toBeHidden();
      await expect(composer).toBeVisible();
      await expect(composeSubject(page)).toHaveValue(subjectSoon);

      menu = await openScheduleMenu(page, composer);
      await menu.getByRole('menuitem').filter({ hasText: 'Choose a date and time' }).click();
      await expect(scheduleDialog).toBeVisible();
      await scheduleDialog.getByRole('button', { name: 'Set send time' }).click();
      await expect(scheduleDialog).toBeHidden();
      await expect(composer).toBeVisible();
      await expect(composer.locator('.compose-send')).toHaveText(/Send/);
      await expect(composer.locator('.compose-schedule-menu__selection')).toHaveText('Custom');
      await composer.locator('.compose-send').click();
      await expect(composer).toBeHidden({ timeout: 30_000 });

      await waitForPendingMutations(page);
      await expect.poll(
        async () => ((await localScheduledRows(page)) ?? []).filter(
          (row) =>
            row.status === 'pending'
            && (row.subject === subjectSoon || row.subject === subjectLater),
        ).length,
        { timeout: 30_000, message: 'both schedules should be tracked locally' },
      ).toBe(2);

      // Permanent placement: the managed folder renders directly below
      // Drafts, like the other special folders.
      const folderNames = await page.locator('.folder-node__name').allTextContents();
      const draftsIndex = folderNames.findIndex((name) => name.trim() === 'Drafts');
      const scheduledIndex = folderNames.findIndex((name) => name.trim() === 'Scheduled');
      expect(draftsIndex).toBeGreaterThanOrEqual(0);
      expect(scheduledIndex).toBe(draftsIndex + 1);

      // ---- normal list rendering, soonest-first ------------------------
      await clickFolder(page, 'Scheduled');
      const rows = page.locator('.msg-list__item');
      const soonRow = rows.filter({ hasText: subjectSoon });
      const laterRow = rows.filter({ hasText: subjectLater });
      await expect(soonRow).toHaveCount(1, { timeout: 30_000 });
      await expect(laterRow).toHaveCount(1, { timeout: 30_000 });
      const rowText = await rows.allTextContents();
      expect(rowText.findIndex((text) => text.includes(subjectSoon)))
        .toBeLessThan(rowText.findIndex((text) => text.includes(subjectLater)));
      const tracked = (await localScheduledRows(page)).filter(
        (row) => row.subject === subjectSoon || row.subject === subjectLater,
      );
      for (const row of tracked) {
        expect(Number(row.sent_at)).toBeGreaterThan(Date.now());
      }

      // ---- normal detail rendering with scheduled adornments ----------
      await openMessageBySubject(page, subjectSoon);
      const banner = page.locator('.message-view__scheduled');
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(/Scheduled to send/);
      await expect(page.locator('.message-view__metadata')).toContainText('Send at');
      await expect(page.locator('.message-view__metadata')).toContainText(SHARED_TEST_OIDC_EMAIL);
      await expect(page.locator('.message-view [aria-label="Reply"]')).toHaveCount(0);
      await expect(page.locator('.message-view [aria-label="Delete"]')).toHaveCount(0);

      // Keyboard semantics match the read-only toolbar: reply and
      // delete shortcuts are inert on a scheduled message.
      await page.keyboard.press('r');
      await page.waitForTimeout(500);
      await expect(page.locator('.compose-dialog')).toHaveCount(0);
      await page.keyboard.press('Delete');
      await expect(soonRow).toHaveCount(1);
      await expect(laterRow).toHaveCount(1);

      // ---- cancel the soonest; the folder remains visible --------------
      await banner.getByRole('button', { name: 'Cancel send' }).click();
      await waitForPendingMutations(page);
      await expect(soonRow).toHaveCount(0, { timeout: 30_000 });
      await expect(laterRow).toHaveCount(1);
      await expect(scheduledFolderName).toBeVisible();

      const canceledRemote = (await matchingEmails(jmap, subjectSoon))
        .filter((email) => email.subject === subjectSoon);
      const drafts = mailboxByRole(await listMailboxes(jmap), 'drafts');
      expect(canceledRemote).toHaveLength(1);
      expect(canceledRemote[0].mailboxIds).toEqual({ [drafts.id]: true });
      expect(canceledRemote[0].keywords?.$draft).toBe(true);

      // ---- cancel the last test schedule -------------------------------
      await openMessageBySubject(page, subjectLater);
      await page.locator('.message-view__scheduled')
        .getByRole('button', { name: 'Cancel send' }).click();
      await waitForPendingMutations(page);
      await expect(scheduledFolderName).toBeVisible();
      await expect.poll(
        async () => ((await localScheduledRows(page)) ?? []).filter(
          (row) => row.subject === subjectSoon || row.subject === subjectLater,
        ).length,
        { timeout: 30_000, message: 'canceled messages should drop their scheduling columns' },
      ).toBe(0);

      // Both drafts are editable again, locally and on the server.
      await clickFolder(page, 'Drafts');
      await expectRowSoon(page, subjectSoon);
      await expectRowSoon(page, subjectLater);
      const remote = await matchingEmails(jmap, SUBJECT_PREFIX);
      expect(remote).toHaveLength(2);
      for (const email of remote) {
        expect(email.mailboxIds).toEqual({ [drafts.id]: true });
        expect(email.keywords?.$draft).toBe(true);
      }
      const submissions = await submissionsForEmails(
        jmap,
        remote.map((email) => email.id),
      );
      for (const submission of submissions) {
        expect(submission.undoStatus).toBe('canceled');
      }
    } finally {
      await cleanupSendLaterArtifacts(jmap);
    }
  });
});
