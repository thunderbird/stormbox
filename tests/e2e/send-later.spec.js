import { expect } from '@playwright/test';

import { connectImap } from './helpers/imap-client.js';
import {
  connectJmap,
  createEmailInMailbox,
  destroyEmails,
  ensureMailbox,
  getEmailMailboxIds,
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
import { selfEmail, SHARED_TEST_OIDC_EMAIL } from './helpers/stack-env.js';
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

/** The account's `scheduled` role mailbox (RFC 9979), or null before the first scheduled send. */
async function scheduledMailboxOf(jmap) {
  const mailboxes = await listMailboxes(jmap);
  return mailboxes.find((mailbox) => mailbox.role === 'scheduled') ?? null;
}

/** Server-side message count of the Scheduled mailbox; 0 before it exists. */
async function scheduledTotalOf(jmap) {
  const response = await jmapRequest(jmap, [[
    'Mailbox/get',
    { accountId: jmap.accountId, properties: ['id', 'role', 'totalEmails'] },
    'scheduled-total',
  ]]);
  const scheduled = (pickResponse(response, 'Mailbox/get')?.list ?? [])
    .find((mailbox) => mailbox.role === 'scheduled');
  return Number(scheduled?.totalEmails ?? 0);
}

/** The text a folder badge should show for `count`: no badge at all for 0. */
async function expectFolderBadge(badge, count) {
  if (count === 0) {
    await expect(badge).toHaveCount(0, { timeout: 30_000 });
  } else {
    await expect(badge).toHaveText(String(count), { timeout: 30_000 });
  }
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

/** Submit an existing Email through this account's first identity; resolves once the server reports it final. */
async function submitAndAwaitFinal(jmap, emailId) {
  const identities = await jmapRequest(jmap, [[
    'Identity/get',
    { accountId: jmap.accountId, properties: ['id', 'email'] },
    'identities',
  ]]);
  const identity = pickResponse(identities, 'Identity/get')?.list?.[0];
  if (!identity) throw new Error('Test account has no identity to submit with');
  const response = await jmapRequest(jmap, [[
    'EmailSubmission/set',
    {
      accountId: jmap.accountId,
      create: { now: { emailId, identityId: identity.id } },
    },
    'submit-now',
  ]]);
  const set = pickResponse(response, 'EmailSubmission/set');
  if (!set?.created?.now?.id) {
    throw new Error(`EmailSubmission/set create failed: ${JSON.stringify(set?.notCreated ?? set)}`);
  }
  await expect.poll(
    async () => (await submissionsForEmails(jmap, [emailId]))
      .map((submission) => submission.undoStatus)[0] ?? null,
    { timeout: 30_000, message: 'the immediate submission should settle as final' },
  ).toBe('final');
}

/** A minimal RFC 5322 message an IMAP client could APPEND. */
function rfc822Message(subject) {
  return [
    `From: ${selfEmail()}`,
    `To: ${selfEmail()}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@e2e.example>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Parked in Scheduled by an IMAP client.',
    '',
  ].join('\r\n');
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
    // Schedules left behind by other work in this account still count;
    // the badge assertions are relative to what is already waiting.
    const baselineScheduled = await scheduledTotalOf(jmap);

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

      // The badge counts waiting sends even though scheduled mail is
      // created $seen (SL-5.7).
      const scheduledBadge = page.locator('.folder-node')
        .filter({ has: scheduledFolderName })
        .locator('.folder-node__count');
      await expectFolderBadge(scheduledBadge, baselineScheduled + 2);

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

      await expectFolderBadge(scheduledBadge, baselineScheduled + 1);

      // ---- cancel the last schedule from multi-select -----------------
      // The Scheduled folder's bulk "delete" slot cancels the send
      // (SL-5.6): the message returns to Drafts instead of being
      // destroyed with its submission still held.
      await laterRow.locator('.msg-list__check input').click();
      const bulkActions = page.locator('.msg-list__bulk-actions');
      await expect(bulkActions.locator('[title="Delete"]')).toHaveCount(0);
      await bulkActions.locator('[title="Cancel send"]').click();
      await waitForPendingMutations(page);
      await expect(laterRow).toHaveCount(0, { timeout: 30_000 });
      await expect(scheduledFolderName).toBeVisible();
      await expectFolderBadge(scheduledBadge, baselineScheduled);
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

  // Scheduled is an ordinary IMAP folder, so other clients can put mail
  // there: an undo of a delete puts a sent message back, a drag or an
  // offline replay parks anything. Neither holds a pending submission,
  // so neither may end up untouchable (SL-5.6): the sent one is filed
  // to Sent by reconciliation and the other stays ordinary, deletable
  // mail.
  test('reconciles or frees mail an IMAP client puts into Scheduled', async ({ sharedPage: page }) => {
    test.setTimeout(120_000);
    const jmap = await connectJmap();
    const stamp = Date.now();
    const subjectSent = `${SUBJECT_PREFIX} imap sent ${stamp}`;
    const subjectPlain = `${SUBJECT_PREFIX} imap plain ${stamp}`;
    const mailboxes = await listMailboxes(jmap);
    const sent = mailboxByRole(mailboxes, 'sent');
    const trash = mailboxByRole(mailboxes, 'trash');
    const scheduled = await ensureMailbox(jmap, { name: 'Scheduled', role: 'scheduled' });
    const imap = await connectImap();

    try {
      // A message this account really sent: in Sent with a final submission.
      const sentId = await createEmailInMailbox(jmap, {
        mailboxId: sent.id,
        fromEmail: selfEmail(),
        subject: subjectSent,
        keywords: { $seen: true },
      });
      await submitAndAwaitFinal(jmap, sentId);

      // The IMAP client puts it back into Scheduled and parks an
      // ordinary message there as well.
      await imap.select(sent.name);
      const sentUid = await imap.waitForUidBySubject(subjectSent);
      await imap.uidCopy(sentUid, scheduled.name);
      expect(await getEmailMailboxIds(jmap, sentId)).toEqual({
        [sent.id]: true,
        [scheduled.id]: true,
      });
      await imap.append(scheduled.name, rfc822Message(subjectPlain));

      // Opening the folder reconciles its contents: the sent message
      // leaves for Sent on the server and in the list, with no
      // scheduling columns left behind.
      await clickFolder(page, 'Scheduled');
      const rows = page.locator('.msg-list__item');
      await expectRowSoon(page, subjectPlain);
      await expect(rows.filter({ hasText: subjectSent })).toHaveCount(0, { timeout: 30_000 });
      await expect.poll(
        async () => getEmailMailboxIds(jmap, sentId),
        { timeout: 30_000, message: 'the sent message should be filed back to Sent only' },
      ).toEqual({ [sent.id]: true });
      await expect.poll(
        async () => ((await localScheduledRows(page)) ?? [])
          .filter((row) => row.subject === subjectSent).length,
        { timeout: 45_000, message: 'the filed message should drop its scheduling columns' },
      ).toBe(0);

      // The parked message is ordinary mail: full toolbar, no banner,
      // and Delete moves it to Trash like anywhere else.
      await openMessageBySubject(page, subjectPlain);
      await expect(page.locator('.message-view__scheduled')).toHaveCount(0);
      await expect(page.locator('.message-view [aria-label="Reply"]')).toHaveCount(1);
      await page.locator('.message-view__header').getByRole('button', { name: 'Delete' }).click();
      await expect(rows.filter({ hasText: subjectPlain })).toHaveCount(0, { timeout: 30_000 });
      await waitForPendingMutations(page);
      const parked = (await matchingEmails(jmap, subjectPlain))
        .find((email) => email.subject === subjectPlain);
      expect(parked).toBeTruthy();
      expect(parked.mailboxIds).toEqual({ [trash.id]: true });
    } finally {
      await imap.logout();
      await cleanupSendLaterArtifacts(jmap);
    }
  });
});
