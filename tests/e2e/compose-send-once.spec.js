import {
  cleanupEmail,
  connectJmap,
  jmapRequest,
  listMailboxes,
  mailboxByRole,
  pickResponse,
} from './helpers/jmap-client.js';
import { DRAFT_FAULTS, FAULTS_PATH, STATUS_PATH } from '../fixtures/ws-proxy/inject.mjs';
import {
  attachConsoleTail,
  consoleLinesFor,
  expect,
  resetSharedSession,
  test,
} from './helpers/shared-session.js';
import {
  localStackEnabled,
  SHARED_TEST_OIDC_EMAIL,
  SHARED_TEST_OIDC_PASSWORD,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import { waitForPendingMutations } from './helpers/ui.js';
import {
  composeSendButton,
  composeSubject,
  discardCompose,
  fillRecipient,
  waitForIdentities,
} from './helpers/compose.js';

/**
 * Hammering Send produces one message (CS-1.15) and the composer leaves
 * the screen while the server works, the send toast standing in for it
 * (CS-1.16, CD-1.7).
 *
 * The harmful case is Send activated while the session's autosave is
 * still on the wire: send has to wait for that save (CD-6.5), and every
 * activation that lands during the wait must join the send already
 * claimed rather than queue another. Locally a save answers in tens of
 * milliseconds, which is too small a window for a burst of real key
 * presses to fall into, so the e2e WebSocket proxy holds the draft
 * create's answer back (DRAFT_FAULTS.HOLD_CREATE) the way a distant
 * server would. The proxy's own fault log proves the hold applied; without
 * it the burst could land after the save settled and the case would pass
 * on a send that was never contended.
 *
 * The burst has two shapes. Real presses on the focused button — Enter
 * repeats and the Ctrl+Enter shortcut — arrive one task apart, which is
 * how a held key behaves. The same-task burst dispatched from the page
 * is faster than any render, so nothing the button's disabled state does
 * can be what prevents the duplicate.
 *
 * Delivery is asserted against the second provisioned account (CS-5.6).
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

const SUBJECT_PREFIX = 'Send once e2e';

// The held save, a cross-account delivery, and Firefox all push this past
// the 30s budget the plain UI specs use.
test.setTimeout(180_000);

const WS_PROXY = process.env.WS_PROXY_URL ?? 'http://127.0.0.1:8787';

/** The client holds a socket through the proxy and the proxy knows the hold mode. */
async function waitForProxiedSocket() {
  await expect.poll(
    async () => {
      const res = await fetch(`${WS_PROXY}${STATUS_PATH}`, { signal: AbortSignal.timeout(5_000) });
      expect(
        res.ok,
        `the ws-proxy does not serve ${STATUS_PATH}; restart it with npm run stack:ws-proxy`,
      ).toBe(true);
      const status = await res.json();
      expect(
        status.modes,
        'the ws-proxy predates DRAFT_HOLD; restart it with npm run stack:ws-proxy',
      ).toContain('DRAFT_HOLD');
      return status.liveSockets;
    },
    {
      timeout: 60_000,
      message: 'the client should hold a WebSocket through the proxy before a fault is armed',
    },
  ).toBeGreaterThan(0);
}

async function holdsApplied() {
  const res = await fetch(`${WS_PROXY}${FAULTS_PATH}`, { signal: AbortSignal.timeout(5_000) });
  const applied = await res.json();
  return applied.filter((f) => f.mode === 'DRAFT_HOLD');
}

/** Exact-subject lookup over the newest rows of a mailbox. */
async function findAllByExactSubject(jmap, mailbox, subject, limit = 30) {
  const query = await jmapRequest(jmap, [[
    'Email/query',
    {
      accountId: jmap.accountId,
      filter: { inMailbox: mailbox.id },
      sort: [{ property: 'receivedAt', isAscending: false }],
      limit,
    },
    'q1',
  ]]);
  const ids = pickResponse(query, 'Email/query')?.ids ?? [];
  if (ids.length === 0) return [];
  const got = await jmapRequest(jmap, [[
    'Email/get',
    { accountId: jmap.accountId, ids, properties: ['subject'] },
    'g1',
  ]]);
  return (pickResponse(got, 'Email/get')?.list ?? [])
    .filter((m) => m.subject === subject)
    .map((m) => m.id);
}

/** Live outbox rows by type and status. */
async function mutationRows(page) {
  return page.evaluate(async () => globalThis.__repo.call('db.query', {
    sql: `SELECT id, mutation_type, local_status, request_json
            FROM pending_mutations
           ORDER BY id`,
    params: [],
  }));
}

async function sendRowsFor(page, subject) {
  const rows = await mutationRows(page);
  return rows.filter((r) => r.mutation_type === 'send'
    && JSON.parse(r.request_json ?? '{}').subject === subject);
}

async function saveInFlight(page) {
  const rows = await mutationRows(page);
  return rows.some((r) => r.mutation_type === 'saveDraft' && r.local_status === 'in_flight');
}

test.describe('Send once', () => {
  let jmap;
  let recipient;
  let sent;
  let drafts;
  let trash;
  let recipientInbox;
  let recipientTrash;

  test.beforeAll(async () => {
    jmap = await connectJmap();
    recipient = await connectJmap({
      username: SHARED_TEST_OIDC_EMAIL,
      password: SHARED_TEST_OIDC_PASSWORD,
    });
    const mailboxes = await listMailboxes(jmap);
    sent = mailboxByRole(mailboxes, 'sent');
    drafts = mailboxByRole(mailboxes, 'drafts');
    trash = mailboxByRole(mailboxes, 'trash');
    const recipientMailboxes = await listMailboxes(recipient);
    recipientInbox = mailboxByRole(recipientMailboxes, 'inbox');
    recipientTrash = mailboxByRole(recipientMailboxes, 'trash');
    if (!sent || !drafts || !trash || !recipientInbox || !recipientTrash) {
      throw new Error('Test requires Sent, Drafts and Trash on both accounts');
    }
  });

  test.beforeEach(async ({ sharedPage }) => {
    await resetSharedSession(sharedPage, { extraSubjectPrefixes: [SUBJECT_PREFIX] });
  });

  async function sweep(subject) {
    for (const mailbox of [sent, drafts]) {
      for (const id of await findAllByExactSubject(jmap, mailbox, subject).catch(() => [])) {
        await cleanupEmail(jmap, id, trash.id).catch(() => {});
      }
    }
    for (const id of await findAllByExactSubject(recipient, recipientInbox, subject).catch(() => [])) {
      await cleanupEmail(recipient, id, recipientTrash.id).catch(() => {});
    }
  }

  test('a burst of Send activations during a held autosave sends exactly once', async ({ sharedPage: page }, testInfo) => {
    const subject = `${SUBJECT_PREFIX} ${Date.now()} ${DRAFT_FAULTS.HOLD_CREATE}`;
    const holdsBefore = (await holdsApplied()).length;
    try {
      await waitForProxiedSocket();
      await page.locator('.folder-node').first().click();
      await page.keyboard.press('c');
      await expect(page.locator('.compose-dialog--expanded')).toBeVisible({ timeout: 10_000 });
      await waitForIdentities(page);
      await fillRecipient(page, 'To', SHARED_TEST_OIDC_EMAIL);
      await composeSubject(page).fill(subject);
      const editor = page.locator('.compose-dialog .editor[contenteditable]').first();
      await editor.click();
      await page.keyboard.type('Sent exactly once.');

      // The idle autosave fires and its create is answered late by the
      // proxy, so the save is still open when Send is hammered.
      await expect.poll(() => saveInFlight(page), {
        timeout: 30_000,
        intervals: [50],
        message: 'the autosave should be on the wire before Send is pressed',
      }).toBe(true);

      const send = composeSendButton(page);
      await send.focus();
      // Faster than a render: the button is still enabled for all three.
      await page.evaluate(() => {
        const button = document.querySelector('.compose-dialog--expanded footer .compose-send');
        button.click();
        button.click();
        button.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
        }));
      });
      // A held key: one activation per task.
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Control+Enter');

      // CS-1.16: the message left the screen at activation — neither
      // expanded nor docked — and the send toast reports for it, offering
      // nothing to press.
      const sendToast = page.locator('.store-error-toast__item--progress').filter({ hasText: subject });
      await expect(sendToast).toHaveText(`Sending “${subject}”…`, { timeout: 10_000 });
      await expect(page.locator('.compose-dialog--expanded')).toHaveCount(0);
      await expect(page.locator('.compose-dock__item').filter({ hasText: subject })).toHaveCount(0);
      await expect(sendToast.locator('button')).toHaveCount(0);

      // The hold really applied to this session's save.
      await expect.poll(async () => (await holdsApplied()).length, {
        timeout: 30_000,
        message: 'the ws-proxy should have held the draft create',
      }).toBeGreaterThan(holdsBefore);

      // The composer closes at acceptance, the send toast gives way to the
      // confirmation, and the outbox finishes filing.
      await expect(page.locator('.compose-dialog')).toHaveCount(0, { timeout: 90_000 });
      await expect(
        page.locator('.store-error-toast__item--success').filter({ hasText: /accepted for delivery/i }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(sendToast).toHaveCount(0);
      await waitForPendingMutations(page, { timeout: 60_000 });

      // Completed rows retire, so the count of sends is read from the
      // server below; what the outbox can still show is that nothing
      // for this message was left parked or failed.
      expect(await sendRowsFor(page, subject), 'a completed send retires its row').toEqual([]);

      // One Email in Sent, no orphan draft, one delivery.
      await expect.poll(
        async () => (await findAllByExactSubject(jmap, sent, subject)).length,
        { timeout: 60_000, message: 'the send should be filed in Sent' },
      ).toBe(1);
      expect(await findAllByExactSubject(jmap, drafts, subject)).toEqual([]);
      await expect.poll(
        async () => (await findAllByExactSubject(recipient, recipientInbox, subject)).length,
        { timeout: 90_000, message: 'the recipient should receive the message' },
      ).toBe(1);
      // A duplicate would arrive moments after the first; give it the chance.
      await page.waitForTimeout(5_000);
      expect(
        await findAllByExactSubject(recipient, recipientInbox, subject),
        'the recipient must receive exactly one copy',
      ).toHaveLength(1);
      expect(await findAllByExactSubject(jmap, sent, subject)).toHaveLength(1);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await sweep(subject);
    }
  });

  test('a send refused while another message is being written docks and is offered from the toast', async ({ sharedPage: page }, testInfo) => {
    // The failure must not take the screen from the message being written
    // (CS-1.16): the refused session docks with the failure marked, the
    // toast that reported the send reports the refusal, and Open brings the
    // session back with its error. The server refuses the envelope because
    // the domain has no public suffix — accepted by the client, rejected
    // by Stalwart's sanitizer — and the held autosave keeps the send in
    // flight long enough for the other message to be opened first.
    const subject = `${SUBJECT_PREFIX} refused ${Date.now()} ${DRAFT_FAULTS.HOLD_CREATE}`;
    const otherSubject = `${SUBJECT_PREFIX} other ${Date.now()}`;
    try {
      await waitForProxiedSocket();
      await page.locator('.folder-node').first().click();
      await page.keyboard.press('c');
      await expect(page.locator('.compose-dialog--expanded')).toBeVisible({ timeout: 10_000 });
      await waitForIdentities(page);
      await fillRecipient(page, 'To', 'nobody@mail.internal');
      await composeSubject(page).fill(subject);
      const editor = page.locator('.compose-dialog .editor[contenteditable]').first();
      await editor.click();
      await page.keyboard.type('Refused by the server while another message is open.');
      await expect.poll(() => saveInFlight(page), {
        timeout: 30_000,
        intervals: [50],
        message: 'the autosave should be on the wire before Send is pressed',
      }).toBe(true);
      await composeSendButton(page).click();

      const sendToast = page.locator('.store-error-toast__item').filter({ hasText: subject });
      const sendToastMessage = sendToast.locator('.store-error-toast__message');
      await expect(sendToastMessage).toHaveText(`Sending “${subject}”…`, { timeout: 10_000 });
      await expect(page.locator('.compose-dialog--expanded')).toHaveCount(0);

      // Another message is opened while the send waits for its held save.
      await page.locator('.folder-node').first().click();
      await page.keyboard.press('c');
      await expect(page.locator('.compose-dialog--expanded')).toBeVisible({ timeout: 10_000 });
      await composeSubject(page).fill(otherSubject);

      // The refusal lands behind the open message: docked, marked, and
      // reported by the same toast.
      await expect(sendToastMessage).toHaveText(`Couldn’t send “${subject}”.`, { timeout: 60_000 });
      await expect(sendToast).not.toHaveClass(/store-error-toast__item--progress/);
      const dockItem = page.locator('.compose-dock__item').filter({ hasText: subject });
      await expect(dockItem.locator('.compose-dock__status')).toHaveText('Send failed');
      await expect(page.locator('.compose-dialog--expanded')).toHaveCount(1);
      await expect(composeSubject(page)).toHaveValue(otherSubject);
      const rows = await sendRowsFor(page, subject);
      expect(rows.map((r) => r.local_status), 'the refused row stays for the user to act on')
        .toEqual(['conflicted']);

      // Open swaps the two: the refused message returns with its error and
      // the other one docks.
      await sendToast.getByRole('button', { name: 'Open' }).click();
      await expect(composeSubject(page)).toHaveValue(subject);
      await expect(page.locator('.compose-dialog--expanded .compose-error')).toHaveText(/Send failed/i);
      await expect(sendToast).toHaveCount(0);
      await expect(dockItem).toHaveCount(0);
      await expect(page.locator('.compose-dock__item').filter({ hasText: otherSubject })).toHaveCount(1);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      // Retire the refused row so later specs do not inherit a failed send,
      // then discard both messages.
      for (const row of await sendRowsFor(page, subject).catch(() => [])) {
        await page.evaluate(async (id) => {
          await globalThis.__repo.call('db.query', {
            sql: 'DELETE FROM pending_mutations WHERE id = ?',
            params: [id],
          });
        }, row.id).catch(() => {});
      }
      for (let i = 0; i < 2; i += 1) {
        if (await page.locator('.compose-dialog--expanded').count()) await discardCompose(page).catch(() => {});
        const docked = page.locator('.compose-dock__restore').first();
        if (await docked.count()) await docked.click().catch(() => {});
      }
      await sweep(subject);
      await sweep(otherSubject);
    }
  });
});
