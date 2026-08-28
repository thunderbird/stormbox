import {
  connectJmap,
  downloadBlob,
  destroyEmails,
  jmapRequest,
  listMailboxes,
  mailboxByRole,
  pickResponse,
} from './helpers/jmap-client.js';
import {
  attachConsoleTail,
  consoleLinesFor,
  expect,
  resetSharedSession,
  test,
} from './helpers/shared-session.js';
import {
  discardCompose,
  fillRecipient,
  saveDraftAndClose,
  waitForIdentities,
} from './helpers/compose.js';
import {
  clickFolder,
  expectRowSoon,
} from './helpers/ui.js';
import {
  localStackEnabled,
  SHARED_TEST_OIDC_EMAIL,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import {
  DRAFT_FAULTS,
  FAULTS_PATH,
  INJECT_MARKER,
  STATUS_PATH,
} from '../fixtures/ws-proxy/inject.mjs';

test.skip(!localStackEnabled, skipLocalStackMessage);
test.use({ viewport: { width: 1440, height: 900 } });
test.setTimeout(240_000);

const SUBJECT_PREFIX = 'Draft lifecycle e2e';
const WS_PROXY = process.env.WS_PROXY_URL ?? 'http://127.0.0.1:8787';

async function requireDraftFaultProxy() {
  await expect.poll(async () => {
    const response = await fetch(`${WS_PROXY}${STATUS_PATH}`, {
      signal: AbortSignal.timeout(5_000),
    });
    const status = await response.json();
    return status.liveSockets > 0
      && status.modes?.includes('DRAFT_CREATE')
      && status.modes?.includes('DRAFT_CLEANUP');
  }, {
    timeout: 30_000,
    message: 'the running WebSocket proxy must support draft fault modes',
  }).toBe(true);
}

async function waitForNewFault(mode, after) {
  let match = null;
  await expect.poll(async () => {
    const response = await fetch(`${WS_PROXY}${FAULTS_PATH}`, {
      signal: AbortSignal.timeout(5_000),
    });
    const faults = await response.json();
    match = faults.find((fault) => fault.mode === mode && fault.at >= after) ?? null;
    return !!match;
  }, { timeout: 30_000 }).toBe(true);
  return match;
}

async function openCompose(page) {
  await page.keyboard.press('ControlOrMeta+n');
  await expect(page.locator('.compose-dialog--expanded')).toBeVisible();
  await waitForIdentities(page);
}

async function pasteGeneratedImage(page) {
  await page.evaluate(() => new Promise((resolve) => {
    const editor = document.querySelector('.compose-dialog--expanded .editor[contenteditable]');
    editor.focus();
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d');
    context.fillStyle = '#3366cc';
    context.fillRect(0, 0, 32, 32);
    canvas.toBlob((blob) => {
      const data = new DataTransfer();
      data.items.add(new File([blob], 'draft.png', { type: 'image/png' }));
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: data });
      editor.dispatchEvent(event);
      resolve();
    }, 'image/png');
  }));
}

async function readDraftParts(jmap, id) {
  const result = await jmapRequest(jmap, [[
    'Email/get',
    {
      accountId: jmap.accountId,
      ids: [id],
      properties: ['id', 'bodyStructure', 'attachments', 'htmlBody', 'bodyValues'],
      bodyProperties: ['partId', 'blobId', 'type', 'name', 'disposition', 'cid', 'subParts'],
      fetchHTMLBodyValues: true,
    },
    'g1',
  ]]);
  return pickResponse(result, 'Email/get')?.list?.[0] ?? null;
}

async function emailsByExactSubject(jmap, mailboxId, subject) {
  const query = await jmapRequest(jmap, [[
    'Email/query',
    {
      accountId: jmap.accountId,
      filter: { inMailbox: mailboxId },
      sort: [{ property: 'receivedAt', isAscending: false }],
      limit: 100,
    },
    'q1',
  ]]);
  const ids = pickResponse(query, 'Email/query')?.ids ?? [];
  if (ids.length === 0) return [];
  const got = await jmapRequest(jmap, [[
    'Email/get',
    {
      accountId: jmap.accountId,
      ids,
      properties: ['id', 'subject', 'keywords', 'mailboxIds'],
    },
    'g1',
  ]]);
  return (pickResponse(got, 'Email/get')?.list ?? [])
    .filter((email) => email.subject === subject);
}

async function localMessageByRemoteId(page, remoteId) {
  return page.evaluate(async (id) => {
    const accounts = await globalThis.__repo.listAccounts();
    return globalThis.__repo.getMessageByRemote(accounts[0].id, id);
  }, remoteId);
}

test.describe('Compose draft lifecycle', () => {
  test.beforeEach(async ({ sharedPage }) => {
    await resetSharedSession(sharedPage, {
      extraSubjectPrefixes: [SUBJECT_PREFIX],
    });
  });

  test('autosaves, minimizes, closes without saving, reopens, saves, and discards', async ({
    sharedPage: page,
  }, testInfo) => {
    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const drafts = mailboxByRole(mailboxes, 'drafts');
    if (!drafts) throw new Error('Drafts mailbox is required');
    const firstSubject = `${SUBJECT_PREFIX} saved ${Date.now()}`;
    const secondSubject = `${firstSubject} updated`;
    const createdIds = new Set();

    try {
      await openCompose(page);
      await page.locator('.compose-dialog--expanded .row')
        .filter({ hasText: /^Subject$/ })
        .locator('input')
        .fill(firstSubject);
      await page.locator('.compose-dialog--expanded .editor').fill('Draft body');

      let firstDraft;
      await expect.poll(async () => {
        const matches = await emailsByExactSubject(jmap, drafts.id, firstSubject);
        firstDraft = matches[0] ?? null;
        if (firstDraft?.id) createdIds.add(firstDraft.id);
        return matches.length;
      }, { timeout: 30_000 }).toBe(1);
      await expect.poll(
        async () => !!(await localMessageByRemoteId(page, firstDraft.id)),
        { timeout: 15_000 },
      ).toBe(true);

      await page.getByRole('button', { name: 'Minimize' }).click();
      await expect(page.locator('.compose-dock__title')).toHaveText(firstSubject);
      await expect(page.locator('.compose-dialog--expanded')).toHaveCount(0);

      await openCompose(page);
      await expect(page.locator('.compose-dialog--expanded')).toHaveCount(1);
      await expect(page.locator('.compose-dock__item')).toHaveCount(1);
      const emptyClose = page.locator('.compose-dialog--expanded')
        .getByRole('button', { name: 'Close', exact: true });
      await expect(emptyClose).toBeVisible();
      await emptyClose.click();
      await expect(page.locator('.compose-dialog--expanded')).toHaveCount(0);

      await page.getByRole('button', { name: `Restore ${firstSubject}` }).click();
      const subjectInput = page.locator('.compose-dialog--expanded .row')
        .filter({ hasText: /^Subject$/ })
        .locator('input');
      await subjectInput.fill(secondSubject);
      await page.locator('.compose-dialog--expanded #compose-to').fill('unfinished recipient');
      await page.keyboard.press('Escape');
      const prompt = page.getByRole('alertdialog', { name: 'Save this draft?' });
      await expect(prompt).toBeVisible();
      await prompt.getByRole('button', { name: "Don't Save" }).click();
      await expect(page.locator('.compose-dialog--expanded')).toHaveCount(0);
      await expect.poll(
        async () => (await emailsByExactSubject(jmap, drafts.id, firstSubject)).length,
      ).toBe(1);
      await expect.poll(
        async () => (await emailsByExactSubject(jmap, drafts.id, secondSubject)).length,
      ).toBe(0);

      await clickFolder(page, drafts.name);
      await expectRowSoon(page, firstSubject);
      await page.locator('.msg-list__item').filter({ hasText: firstSubject }).first().click();
      await expect(page.locator('.compose-dialog--expanded')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.compose-dialog--expanded .editor')).toContainText('Draft body');

      const reopenedSubject = page.locator('.compose-dialog--expanded .row')
        .filter({ hasText: /^Subject$/ })
        .locator('input');
      await reopenedSubject.fill(secondSubject);
      await saveDraftAndClose(page);
      await expect(page.locator('.compose-dialog--expanded')).toHaveCount(0, { timeout: 30_000 });

      let secondDraft;
      await expect.poll(async () => {
        const matches = await emailsByExactSubject(jmap, drafts.id, secondSubject);
        secondDraft = matches[0] ?? null;
        if (secondDraft?.id) createdIds.add(secondDraft.id);
        return matches.length;
      }, { timeout: 30_000 }).toBe(1);
      await expect.poll(
        async () => (await emailsByExactSubject(jmap, drafts.id, firstSubject)).length,
      ).toBe(0);
      await expect.poll(
        async () => (await localMessageByRemoteId(page, firstDraft.id)) == null,
      ).toBe(true);
      await expect.poll(
        async () => !!(await localMessageByRemoteId(page, secondDraft.id)),
      ).toBe(true);

      await clickFolder(page, drafts.name);
      await expectRowSoon(page, secondSubject);
      await page.locator('.msg-list__item').filter({ hasText: secondSubject }).first().click();
      await expect(page.locator('.compose-dialog--expanded')).toBeVisible({ timeout: 30_000 });
      await discardCompose(page);
      await expect(page.locator('.compose-dialog--expanded')).toHaveCount(0, { timeout: 30_000 });
      await expect.poll(
        async () => (await emailsByExactSubject(jmap, drafts.id, secondSubject)).length,
      ).toBe(0);
      await expect.poll(
        async () => (await localMessageByRemoteId(page, secondDraft.id)) == null,
      ).toBe(true);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await destroyEmails(jmap, [...createdIds]);
    }
  });

  test('saves message content while omitting an invalid recipient pill', async ({
    sharedPage: page,
  }, testInfo) => {
    const jmap = await connectJmap();
    const drafts = mailboxByRole(await listMailboxes(jmap), 'drafts');
    if (!drafts) throw new Error('Drafts mailbox is required');
    const subject = `${SUBJECT_PREFIX} invalid recipient ${Date.now()}`;
    const createdIds = new Set();

    try {
      await openCompose(page);
      const toInput = page.locator('.compose-dialog--expanded #compose-to');
      await toInput.fill('unfinished recipient');
      await toInput.press('Enter');
      await page.locator('.compose-dialog--expanded .row')
        .filter({ hasText: /^Subject$/ })
        .locator('input')
        .fill(subject);
      await page.locator('.compose-dialog--expanded .editor')
        .fill('This body must survive the invalid recipient.');

      await expect(page.getByText(
        'Fix invalid recipients before saving or sending this message.',
        { exact: true },
      )).toBeVisible({ timeout: 30_000 });

      let savedDraft;
      await expect.poll(async () => {
        const matches = await emailsByExactSubject(jmap, drafts.id, subject);
        savedDraft = matches[0] ?? null;
        if (savedDraft?.id) createdIds.add(savedDraft.id);
        return matches.length;
      }, { timeout: 30_000 }).toBe(1);

      await saveDraftAndClose(page);
      await clickFolder(page, drafts.name);
      await expectRowSoon(page, subject);
      await page.locator('.msg-list__item').filter({ hasText: subject }).first().click();

      const composer = page.locator('.compose-dialog--expanded');
      await expect(composer).toBeVisible({ timeout: 30_000 });
      await expect(composer.locator('.editor'))
        .toContainText('This body must survive the invalid recipient.');
      await expect(composer.getByRole('button', {
        name: /unfinished recipient — not a valid address/,
      })).toHaveCount(0);
      await expect(composer.locator('#compose-to')).toHaveValue('');

      await discardCompose(page);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await destroyEmails(jmap, [...createdIds]);
    }
  });

  test('serializes autosave before send and cleans the saved draft', async ({
    sharedPage: page,
  }, testInfo) => {
    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const drafts = mailboxByRole(mailboxes, 'drafts');
    const sent = mailboxByRole(mailboxes, 'sent');
    if (!drafts || !sent) throw new Error('Drafts and Sent mailboxes are required');
    const subject = `${SUBJECT_PREFIX} send ${Date.now()}`;
    const createdIds = new Set();

    try {
      await openCompose(page);
      await fillRecipient(page, 'To', SHARED_TEST_OIDC_EMAIL);
      await page.locator('.compose-dialog--expanded .row')
        .filter({ hasText: /^Subject$/ })
        .locator('input')
        .fill(subject);
      await page.locator('.compose-dialog--expanded .editor').fill('Send after autosave');

      await expect.poll(async () => {
        const matches = await emailsByExactSubject(jmap, drafts.id, subject);
        for (const email of matches) createdIds.add(email.id);
        return matches.length;
      }, { timeout: 30_000 }).toBe(1);

      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.locator('.compose-dialog--expanded')).toHaveCount(0, { timeout: 60_000 });
      await expect(page.getByText('Message accepted for delivery.', { exact: true })).toBeVisible();
      await expect.poll(
        async () => (await emailsByExactSubject(jmap, drafts.id, subject)).length,
        { timeout: 30_000 },
      ).toBe(0);

      let sentEmail;
      await expect.poll(async () => {
        const matches = await emailsByExactSubject(jmap, sent.id, subject);
        sentEmail = matches[0] ?? null;
        if (sentEmail?.id) createdIds.add(sentEmail.id);
        return matches.length;
      }, { timeout: 30_000 }).toBe(1);
      await expect.poll(
        async () => !!(await localMessageByRemoteId(page, sentEmail.id)),
        { timeout: 15_000 },
      ).toBe(true);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await destroyEmails(jmap, [...createdIds]);
    }
  });

  test('refreshes inline part blobs before replacing an autosaved draft', async ({
    sharedPage: page,
  }, testInfo) => {
    const jmap = await connectJmap();
    const drafts = mailboxByRole(await listMailboxes(jmap), 'drafts');
    if (!drafts) throw new Error('Drafts mailbox is required');
    const subject = `${SUBJECT_PREFIX} attachment ${Date.now()}`;
    const createdIds = new Set();

    try {
      await openCompose(page);
      await page.locator('.compose-dialog--expanded .row')
        .filter({ hasText: /^Subject$/ })
        .locator('input')
        .fill(subject);
      await pasteGeneratedImage(page);

      let first;
      await expect.poll(async () => {
        const matches = await emailsByExactSubject(jmap, drafts.id, subject);
        first = matches[0] ?? null;
        if (first?.id) createdIds.add(first.id);
        return matches.length;
      }, { timeout: 30_000 }).toBe(1);
      const firstParts = await readDraftParts(jmap, first.id);
      const firstBlob = firstParts?.attachments?.[0]?.blobId;
      expect(firstBlob).toBeTruthy();

      await page.locator('.compose-dialog--expanded .editor').evaluate((editor) => {
        editor.append(document.createTextNode('Second revision'));
        editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
      });
      let second;
      await expect.poll(async () => {
        const matches = await emailsByExactSubject(jmap, drafts.id, subject);
        second = matches[0] ?? null;
        if (second?.id) createdIds.add(second.id);
        return matches.length === 1 && second?.id !== first.id;
      }, { timeout: 30_000 }).toBe(true);

      const secondParts = await readDraftParts(jmap, second.id);
      const secondBlob = secondParts?.attachments?.[0]?.blobId;
      expect(secondBlob).toBeTruthy();
      expect(secondBlob).not.toBe(firstBlob);
      await expect(downloadBlob(jmap, {
        blobId: secondBlob,
        type: 'image/png',
        name: 'draft.png',
      })).resolves.toBeTruthy();
      await expect.poll(async () => (await localMessageByRemoteId(page, first.id)) == null)
        .toBe(true);
      await discardCompose(page);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await destroyEmails(jmap, [...createdIds]);
    }
  });

  test('recovers a draft whose successful create response is lost', async ({
    sharedPage: page,
  }, testInfo) => {
    const jmap = await connectJmap();
    const drafts = mailboxByRole(await listMailboxes(jmap), 'drafts');
    if (!drafts) throw new Error('Drafts mailbox is required');
    const subject = `${SUBJECT_PREFIX} ${DRAFT_FAULTS.LOSE_CREATE} ${Date.now()}`;
    const started = Date.now();
    const createdIds = new Set();

    try {
      await openCompose(page);
      await requireDraftFaultProxy();
      await page.locator('.compose-dialog--expanded .row')
        .filter({ hasText: /^Subject$/ })
        .locator('input')
        .fill(subject);
      await page.locator('.compose-dialog--expanded .editor').fill('Lost create response');

      await waitForNewFault('DRAFT_CREATE', started);
      await expect.poll(async () => {
        const matches = await emailsByExactSubject(jmap, drafts.id, subject);
        for (const email of matches) createdIds.add(email.id);
        return matches.length;
      }, { timeout: 30_000 }).toBe(1);
      await expect(page.locator('.compose-save-error')).toHaveCount(0);
      await discardCompose(page);
      await expect.poll(
        async () => (await emailsByExactSubject(jmap, drafts.id, subject)).length,
      ).toBe(0);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await destroyEmails(jmap, [...createdIds]);
    }
  });

  test('retries an acknowledged cleanup whose response is lost', async ({
    sharedPage: page,
  }, testInfo) => {
    const jmap = await connectJmap();
    const drafts = mailboxByRole(await listMailboxes(jmap), 'drafts');
    if (!drafts) throw new Error('Drafts mailbox is required');
    const baseSubject = `${SUBJECT_PREFIX} cleanup base ${Date.now()}`;
    const replacementSubject = `${SUBJECT_PREFIX} ${DRAFT_FAULTS.LOSE_CLEANUP} ${Date.now()}`;
    const started = Date.now();
    const createdIds = new Set();

    try {
      await openCompose(page);
      await requireDraftFaultProxy();
      const subject = page.locator('.compose-dialog--expanded .row')
        .filter({ hasText: /^Subject$/ })
        .locator('input');
      await subject.fill(baseSubject);
      await page.locator('.compose-dialog--expanded .editor').fill('Cleanup retry');
      let base;
      await expect.poll(async () => {
        const matches = await emailsByExactSubject(jmap, drafts.id, baseSubject);
        base = matches[0] ?? null;
        if (base?.id) createdIds.add(base.id);
        return matches.length;
      }, { timeout: 30_000 }).toBe(1);

      await subject.fill(replacementSubject);
      await waitForNewFault('DRAFT_CLEANUP', started);
      await expect.poll(async () => {
        const matches = await emailsByExactSubject(jmap, drafts.id, replacementSubject);
        for (const email of matches) createdIds.add(email.id);
        return matches.length;
      }, { timeout: 30_000 }).toBe(1);
      await expect.poll(
        async () => (await emailsByExactSubject(jmap, drafts.id, baseSubject)).length,
      ).toBe(0);
      await expect(page.locator('.compose-save-error')).toHaveCount(0);
      await discardCompose(page);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await destroyEmails(jmap, [...createdIds]);
    }
  });

  test('preserves the confirmed predecessor when replacement creation is rejected', async ({
    sharedPage: page,
  }, testInfo) => {
    const jmap = await connectJmap();
    const drafts = mailboxByRole(await listMailboxes(jmap), 'drafts');
    if (!drafts) throw new Error('Drafts mailbox is required');
    const baseSubject = `${SUBJECT_PREFIX} rejection base ${Date.now()}`;
    const rejectedSubject = `${SUBJECT_PREFIX} ${INJECT_MARKER} ${Date.now()}`;
    const createdIds = new Set();

    try {
      await openCompose(page);
      const subject = page.locator('.compose-dialog--expanded .row')
        .filter({ hasText: /^Subject$/ })
        .locator('input');
      await subject.fill(baseSubject);
      await page.locator('.compose-dialog--expanded .editor').fill('Keep the predecessor');
      await expect.poll(async () => {
        const matches = await emailsByExactSubject(jmap, drafts.id, baseSubject);
        for (const email of matches) createdIds.add(email.id);
        return matches.length;
      }, { timeout: 30_000 }).toBe(1);

      await subject.fill(rejectedSubject);
      await expect(page.locator('.compose-save-error')).toBeVisible({ timeout: 15_000 });
      await expect.poll(
        async () => (await emailsByExactSubject(jmap, drafts.id, baseSubject)).length,
      ).toBe(1);
      await expect.poll(
        async () => (await emailsByExactSubject(jmap, drafts.id, rejectedSubject)).length,
      ).toBe(0);
      await discardCompose(page);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await destroyEmails(jmap, [...createdIds]);
    }
  });
});
