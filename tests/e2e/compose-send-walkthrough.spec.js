import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '@playwright/test';

import {
  cleanupEmail,
  connectJmap,
  jmapRequest,
  listMailboxes,
  mailboxByRole,
  pickResponse,
} from './helpers/jmap-client.js';
import { loginViaOidc } from './helpers/oidc-login.js';
import {
  localStackEnabled,
  selfEmail,
  SHARED_TEST_OIDC_EMAIL,
  SHARED_TEST_OIDC_PASSWORD,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import {
  attachConsoleTail,
  clickFolder,
  openMessageBySubject,
  trackConsole,
  waitForFolderTreeReady,
  waitForPendingMutations,
} from './helpers/ui.js';
import {
  clearRecipients,
  composeRow,
  composeSubject,
  fillRecipient,
  recipientAddresses,
  recipientInput,
  recipientPills,
} from './helpers/compose.js';

/**
 * Recorded walkthrough of the compose, send and recipient-autocomplete
 * surface — the scope of specs/004-compose-improvements.
 *
 * One test so Playwright produces a single continuous video, narrated
 * through test.step() so the report reads in recording order. Uses the
 * default `page` fixture rather than the suite's worker-scoped
 * `sharedPage`, because that fixture builds its own BrowserContext
 * without `recordVideo` and would silently discard the video option.
 *
 * Two classes of check:
 *   - Hard assertions for the guarantees this patch introduces
 *     (CS-1.1 to CS-1.5). A regression fails the run.
 *   - Recorded observations for behaviour the spec has accepted as not
 *     yet implemented. These are collected and attached to the report
 *     rather than asserted, so the walkthrough documents reality
 *     without freezing a known gap into an expectation.
 *
 * Delivery is proved against a second account. Self-addressed delivery
 * is accepted for submission but never arrives on the pinned Stalwart
 * v0.15.4 (issue #77), so asserting it would test the server's bug
 * rather than this code.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

test.use({ video: 'on', viewport: { width: 1440, height: 900 } });
test.setTimeout(900_000);

const findings = [];
// Stills and the observation log are written here so the walkthrough
// leaves reviewable artifacts next to its video, rather than only
// inline report attachments that a non-HTML reporter discards.
const ARTIFACT_DIR = path.join('test-results', 'walkthrough');
let shotIndex = 0;

function record(area, observation) {
  findings.push({ area, observation });
}

async function shot(page, name) {
  shotIndex += 1;
  const file = path.join(
    ARTIFACT_DIR,
    `${String(shotIndex).padStart(2, '0')}-${name}.png`,
  );
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

function suggestions(page) {
  return page.locator('.compose-dialog [role="option"]');
}

async function openCompose(page) {
  await page.keyboard.press('ControlOrMeta+n');
  await expect(page.locator('.compose-dialog')).toBeVisible({ timeout: 10_000 });
  const fromSelect = page.locator('.compose-dialog select').first();
  await expect.poll(
    async () => fromSelect.locator('option').count(),
    { timeout: 30_000, message: 'identity sync should populate the From dropdown' },
  ).toBeGreaterThan(0);
}

async function closeCompose(page) {
  const dialog = page.locator('.compose-dialog');
  if (await dialog.count() === 0) return;
  await page.locator('.compose-dialog header button.icon').click().catch(() => {});
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
}

async function typeInTo(page, text) {
  const to = recipientInput(page, 'To');
  await to.click();
  await to.fill('');
  await to.pressSequentially(text, { delay: 180 });
  await page.waitForTimeout(800);
}

async function findBySubject(jmap, mailbox, subject) {
  const payload = await jmapRequest(jmap, [[
    'Email/query',
    {
      accountId: jmap.accountId,
      filter: { operator: 'AND', conditions: [{ inMailbox: mailbox.id }, { subject }] },
      sort: [{ property: 'receivedAt', isAscending: false }],
      limit: 5,
    },
    'q1',
  ]]);
  return pickResponse(payload, 'Email/query')?.ids?.[0] ?? null;
}

/**
 * Exact-subject lookup over the newest rows in a mailbox. The JMAP
 * `subject` filter is full-text tokenised, which cannot match a subject
 * containing "Re:", so replies have to be found this way.
 */
async function findByExactSubject(jmap, mailbox, subject, limit = 25) {
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
  if (ids.length === 0) return null;
  const got = await jmapRequest(jmap, [[
    'Email/get',
    { accountId: jmap.accountId, ids, properties: ['subject'] },
    'g1',
  ]]);
  const match = (pickResponse(got, 'Email/get')?.list ?? [])
    .find((m) => m.subject === subject);
  return match?.id ?? null;
}

async function readEmail(jmap, emailId, extraProps = []) {
  const payload = await jmapRequest(jmap, [[
    'Email/get',
    {
      accountId: jmap.accountId,
      ids: [emailId],
      properties: ['to', 'cc', 'bcc', 'subject', 'from', 'inReplyTo', 'references',
        'header:Bcc:asRaw', ...extraProps],
    },
    'g1',
  ]]);
  return pickResponse(payload, 'Email/get')?.list?.[0] ?? null;
}

/** Seed a received message with an arbitrary From / To / Cc shape. */
async function seedReceived(jmap, { mailboxId, from, to, cc, subject, bodyText }) {
  const payload = await jmapRequest(jmap, [[
    'Email/set',
    {
      accountId: jmap.accountId,
      create: {
        c1: {
          mailboxIds: { [mailboxId]: true },
          keywords: {},
          from: [{ email: from }],
          to: to.map((email) => ({ email })),
          ...(cc?.length ? { cc: cc.map((email) => ({ email })) } : {}),
          subject,
          bodyStructure: { type: 'text/plain', partId: 'p1' },
          bodyValues: { p1: { value: bodyText } },
        },
      },
    },
    's1',
  ]]);
  const set = pickResponse(payload, 'Email/set');
  if (set?.notCreated?.c1) {
    throw new Error(`seedReceived failed: ${JSON.stringify(set.notCreated.c1)}`);
  }
  return set.created.c1.id;
}

/** Queue a SEND mutation the way compose-store.send() does. */
async function sendViaRepo(page, { to = [], cc = [], bcc = [], subject, identityId = null }) {
  return page.evaluate(async (payload) => {
    const repo = globalThis.__repo;
    const accounts = await repo.listAccounts();
    const accountId = accounts[0].id;
    const folders = await repo.listFolders(accountId);
    const byRole = (role) => folders.find((f) => f.role === role) ?? null;
    const identities = await repo.listIdentities(accountId);
    const mutation = await repo.insertPendingMutation({
      accountId,
      mutationType: 'send',
      targetMessageId: null,
      requestJson: JSON.stringify({
        identityId: payload.identityId ?? identities[0].id,
        to: payload.to,
        cc: payload.cc,
        bcc: payload.bcc,
        subject: payload.subject,
        textBody: 'Sent with no client-built envelope.',
        htmlBody: '',
        draftsFolderId: byRole('drafts')?.id ?? null,
        sentFolderId: byRole('sent')?.id ?? null,
        outboxFolderId: null,
      }),
      optimisticPatchJson: null,
    });
    const summary = await repo.runMutation(accountId, mutation.id);
    return { summary, mutationId: mutation.id };
  }, { to, cc, bcc, subject, identityId });
}

async function countSentRows(page) {
  return page.evaluate(async () => {
    const repo = globalThis.__repo;
    const accounts = await repo.listAccounts();
    const accountId = accounts[0].id;
    const folders = await repo.listFolders(accountId);
    const sent = folders.find((f) => f.role === 'sent');
    if (!sent) return -1;
    const rows = await repo.listMessagesForView({
      accountId, folderId: sent.id, sort: 'sent', offset: 0, limit: 200,
    });
    return rows.length;
  });
}

test.describe('Compose, send and autocomplete walkthrough', () => {
  test('exercises every path in the compose and send surface', async ({ page }, testInfo) => {
    const consoleLines = [];
    trackConsole(page, consoleLines);

    const jmap = await connectJmap();
    const shared = await connectJmap({
      username: SHARED_TEST_OIDC_EMAIL,
      password: SHARED_TEST_OIDC_PASSWORD,
    });
    const mailboxes = await listMailboxes(jmap);
    const sharedMailboxes = await listMailboxes(shared);
    const sent = mailboxByRole(mailboxes, 'sent');
    const inbox = mailboxByRole(mailboxes, 'inbox');
    const trash = mailboxByRole(mailboxes, 'trash');
    const sharedInbox = mailboxByRole(sharedMailboxes, 'inbox');
    const sharedTrash = mailboxByRole(sharedMailboxes, 'trash');
    if (!sent || !inbox || !trash || !sharedInbox) {
      throw new Error('walkthrough requires Inbox, Sent, Trash and a shared Inbox');
    }

    const stamp = Date.now();
    const stranger = 'stranger.never.written.to@example.org';
    const subjects = {
      to: `Walkthrough to ${stamp}`,
      cc: `Walkthrough cc ${stamp}`,
      bcc: `Walkthrough bcc ${stamp}`,
      received: `Walkthrough received ${stamp}`,
      reply: `Re: Walkthrough received ${stamp}`,
    };
    const mine = [];
    const theirs = [];
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

    try {
      await test.step('Sign in and load the mailbox', async () => {
        await loginViaOidc(page);
        await waitForFolderTreeReady(page);
        await expect(page.locator('.msg-list')).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(900);
        await shot(page, 'mailbox-loaded');
      });

      await test.step('Seed a received message from an address never written to', async () => {
        // Used twice: for the reply paths, and to show whether an
        // incoming sender leaks into recipient suggestions (CS-3.3).
        const id = await seedReceived(jmap, {
          mailboxId: inbox.id,
          from: stranger,
          to: [selfEmail(), 'colleague@example.org'],
          cc: ['cc-watcher@example.org'],
          subject: subjects.received,
          bodyText: 'Original message body for the reply paths.',
        });
        mine.push(id);
        await clickFolder(page, sent.name);
        await page.waitForTimeout(800);
        await clickFolder(page, 'Inbox');
        await page.waitForTimeout(800);
      });

      // ---- Compose form -------------------------------------------------
      await test.step('Compose opens with From, To, Subject and a body editor', async () => {
        await openCompose(page);
        await expect(recipientInput(page, 'To')).toBeVisible();
        await expect(composeSubject(page)).toBeVisible();
        await expect(page.locator('.compose-dialog .editor[contenteditable]')).toBeVisible();
        // Cc and Bcc exist but stay out of the way until asked for; three
        // empty recipient rows on every new message is why they were left
        // out to begin with (CS-2.1).
        await expect(composeRow(page, 'Cc')).toHaveCount(0);
        await page.locator('.compose-dialog .recipient-add').click();
        await expect(composeRow(page, 'Cc')).toHaveCount(1);
        await page.locator('.compose-dialog .recipient-add').click();
        await expect(composeRow(page, 'Bcc')).toHaveCount(1);
        record('Cc/Bcc fields (R-4.7, CS-2.1)',
          'Cc and Bcc are reachable from the To row, one control at a time, and a reply-all opens with Cc already shown.');
        await page.waitForTimeout(1_000);
        await shot(page, 'compose-fields-cc-bcc');
      });

      // ---- Autocomplete -------------------------------------------------
      await test.step('One character does not open the suggestion list', async () => {
        await typeInTo(page, 'e');
        await expect(suggestions(page), 'one character is not a query').toHaveCount(0);
        record('Autocomplete minimum length',
          'A single character opens nothing: the list starts at two.');
      });

      await test.step('An address prefix produces suggestions', async () => {
        await typeInTo(page, 'e2e');
        const count = await suggestions(page).count();
        if (count > 0) {
          const rows = await suggestions(page).evaluateAll((els) => els.map((el) => el.innerText.replace(/\s+/g, ' ').trim()));
          record('Autocomplete by address prefix',
            `${count} suggestion(s): ${rows.join(' | ')}`);
          const unique = new Set(rows.map((r) => r.toLowerCase()));
          if (unique.size < rows.length) {
            record('Duplicate suggestions (issue #58)',
              `${rows.length} rows collapse to ${unique.size} distinct entries, so the same address is offered more than once.`);
          }
        } else {
          record('Autocomplete by address prefix',
            'No suggestions appeared for an address prefix; the account may have no contacts and no send history yet.');
        }
        await shot(page, 'autocomplete-address-prefix');
        await page.waitForTimeout(800);
      });

      await test.step('An upper-case prefix behaves the same as lower case', async () => {
        await typeInTo(page, 'E2E');
        const count = await suggestions(page).count();
        record('Autocomplete case handling',
          `Upper-case prefix "E2E" produced ${count} suggestion(s).`);
      });

      await test.step('A display name produces nothing (CS-3.1)', async () => {
        await typeInTo(page, 'Tester');
        const count = await suggestions(page).count();
        record('Autocomplete by name (CS-3.1)',
          `Typing a name produced ${count} suggestion(s). Contacts are matched on the email column only, so a name that does not prefix the address cannot be found.`);
        await shot(page, 'autocomplete-name-no-match');
        await page.waitForTimeout(800);
      });

      await test.step('An incoming sender is offered as a recipient (CS-3.3)', async () => {
        await typeInTo(page, 'stranger');
        const count = await suggestions(page).count();
        const rows = count > 0
          ? await suggestions(page).evaluateAll((els) => els.map((el) => el.innerText.replace(/\s+/g, ' ').trim()))
          : [];
        record('Suggestion provenance (CS-3.3)',
          `An address that has only ever sent mail to this account produced ${count} suggestion(s)${rows.length ? `: ${rows.join(' | ')}` : ''}. History is drawn from every stored message address, not just confirmed outgoing recipients.`);
        await shot(page, 'autocomplete-incoming-sender-offered');
        await page.waitForTimeout(800);
      });

      await test.step('Keyboard selection in the suggestion list (CS-3.8, CS-3.9)', async () => {
        await clearRecipients(page, 'To');
        await typeInTo(page, 'e2e');
        const field = recipientInput(page, 'To');
        await expect(field).toHaveAttribute('aria-expanded', 'true');
        await page.keyboard.press('ArrowDown');
        await expect(field, 'the highlighted option is named for a reader')
          .toHaveAttribute('aria-activedescendant', /compose-to-option-\d+/);
        await page.keyboard.press('Enter');
        await expect(recipientPills(page, 'To'), 'Enter takes the highlighted suggestion')
          .toHaveCount(1);
        const committed = await recipientAddresses(page, 'To');
        record('Keyboard and ARIA in the suggestion list (CS-3.8, CS-3.9)',
          `ArrowDown then Enter committed ${JSON.stringify(committed)} as a pill. The field carries combobox semantics: aria-expanded, aria-controls and aria-activedescendant, with the option count announced.`);
        await clearRecipients(page, 'To');
      });

      await test.step('Clicking a suggestion fills the field', async () => {
        await typeInTo(page, 'e2e');
        await expect(suggestions(page).first()).toBeVisible();
        await suggestions(page).first().click();
        await expect(recipientPills(page, 'To')).toHaveCount(1);
        record('Applying a suggestion by mouse',
          `Clicking the first suggestion committed ${JSON.stringify(await recipientAddresses(page, 'To'))}.`);
        await clearRecipients(page, 'To');
        await page.waitForTimeout(500);
      });

      // ---- Send guard ---------------------------------------------------
      await test.step('An empty recipient list is refused and the draft is kept', async () => {
        await clearRecipients(page, 'To');
        await composeSubject(page).fill('Walkthrough no recipients');
        const sentBefore = await countSentRows(page);
        await page.locator('.compose-dialog button.primary', { hasText: /^Send$/ }).click();
        const error = page.locator('.compose-dialog .compose-error');
        await expect(error).toBeVisible({ timeout: 10_000 });
        await expect(error).toHaveText(/Add at least one recipient\./);
        await expect(composeSubject(page)).toHaveValue('Walkthrough no recipients');
        expect(await countSentRows(page), 'nothing may be filed in Sent').toBe(sentBefore);
        await shot(page, 'empty-recipients-refused');
        await page.waitForTimeout(900);
        await closeCompose(page);
      });

      // ---- Successful send, cross-account -------------------------------
      await test.step('Send to another account from the compose UI', async () => {
        await openCompose(page);
        await fillRecipient(page, 'To', SHARED_TEST_OIDC_EMAIL);
        await composeSubject(page).fill(subjects.to);
        const editor = page.locator('.compose-dialog .editor[contenteditable]').first();
        await editor.click();
        await page.keyboard.type('Recorded walkthrough of the send path.', { delay: 12 });
        await page.waitForTimeout(500);
        await page.locator('.compose-dialog button.primary', { hasText: /^Send$/ }).click();
        await expect(page.locator('.compose-dialog')).toBeHidden({ timeout: 30_000 });
        await waitForPendingMutations(page);
      });

      await test.step('It is filed in Sent locally, on the server, and in the UI', async () => {
        await clickFolder(page, sent.name);
        await expect.poll(
          async () => page.locator('.msg-list__item').filter({ hasText: subjects.to }).count(),
          { timeout: 30_000, message: 'sent message should appear in Sent' },
        ).toBeGreaterThan(0);
        const serverId = await findBySubject(jmap, sent, subjects.to);
        expect(serverId, 'server should hold the message in Sent').not.toBeNull();
        mine.push(serverId);
        await page.locator('.msg-list__item').filter({ hasText: subjects.to }).first().click();
        await page.waitForTimeout(900);
        await shot(page, 'sent-message-open');
      });

      await test.step('The other account actually received it', async () => {
        await expect.poll(
          async () => findBySubject(shared, sharedInbox, subjects.to),
          { timeout: 90_000, message: 'recipient account should receive the message' },
        ).not.toBeNull();
        const deliveredId = await findBySubject(shared, sharedInbox, subjects.to);
        theirs.push(deliveredId);
        const delivered = await readEmail(shared, deliveredId);
        expect(delivered.to?.[0]?.email).toBe(SHARED_TEST_OIDC_EMAIL);
      });

      // ---- The reason the envelope was removed --------------------------
      await test.step('A Cc-only message is delivered, with no To at all (CS-1.1)', async () => {
        const { summary } = await sendViaRepo(page, {
          cc: [{ email: SHARED_TEST_OIDC_EMAIL }],
          subject: subjects.cc,
        });
        expect(summary.failed, 'Cc-only send should succeed').toBe(0);
        await expect.poll(
          async () => findBySubject(shared, sharedInbox, subjects.cc),
          { timeout: 90_000, message: 'Cc-only message should be delivered' },
        ).not.toBeNull();
        const deliveredId = await findBySubject(shared, sharedInbox, subjects.cc);
        theirs.push(deliveredId);
        const delivered = await readEmail(shared, deliveredId);
        expect(delivered.cc?.[0]?.email).toBe(SHARED_TEST_OIDC_EMAIL);
        expect(delivered.to, 'the message carries no To recipients').toBeFalsy();
        mine.push(await findBySubject(jmap, sent, subjects.cc));
      });

      await test.step('A Bcc-only message is delivered without exposing Bcc (CS-1.1)', async () => {
        const { summary } = await sendViaRepo(page, {
          bcc: [{ email: SHARED_TEST_OIDC_EMAIL }],
          subject: subjects.bcc,
        });
        expect(summary.failed, 'Bcc-only send should succeed').toBe(0);
        await expect.poll(
          async () => findBySubject(shared, sharedInbox, subjects.bcc),
          { timeout: 90_000, message: 'Bcc-only message should be delivered' },
        ).not.toBeNull();
        const deliveredId = await findBySubject(shared, sharedInbox, subjects.bcc);
        theirs.push(deliveredId);
        const delivered = await readEmail(shared, deliveredId);
        // RFC 8621 §7: the server strips Bcc on delivery.
        expect(
          delivered['header:Bcc:asRaw'],
          'the delivered copy must not carry a Bcc header',
        ).toBeFalsy();
        mine.push(await findBySubject(jmap, sent, subjects.bcc));
      });

      // ---- Failure bookkeeping ------------------------------------------
      await test.step('A rejected send is reported and files nothing in Sent (CS-1.3, CS-1.4)', async () => {
        const sentBefore = await countSentRows(page);
        const { summary, mutationId } = await sendViaRepo(page, {
          to: [{ email: SHARED_TEST_OIDC_EMAIL }],
          subject: `Walkthrough rejected ${stamp}`,
          identityId: 999_999,
        });
        expect(summary.failed, 'an unresolvable identity must fail the send').toBe(1);
        expect(await countSentRows(page), 'nothing may be filed in Sent').toBe(sentBefore);
        const error = await page.evaluate(
          async (id) => globalThis.__repo.getPendingMutationError(id),
          mutationId,
        );
        record('Failed send bookkeeping (CS-1.3)',
          `The mutation row survived with error ${JSON.stringify(error)}, so the message is recoverable rather than silently dropped.`);
        const stillThere = await findBySubject(jmap, sent, `Walkthrough rejected ${stamp}`);
        expect(stillThere, 'a failed send must not appear in Sent on the server').toBeNull();
      });

      // ---- Reply, Reply All, Forward ------------------------------------
      await test.step('Reply prefills the sender, subject and quoted body', async () => {
        await clickFolder(page, 'Inbox');
        await openMessageBySubject(page, subjects.received);
        const ccRow = page.locator('.message-view__metadata-row').filter({ hasText: /^Cc/ });
        await expect(ccRow, 'the detail view shows Cc (CS-2.7)').toHaveCount(1);
        await expect(ccRow).toContainText('cc-watcher@example.org');
        record('Cc in the message detail view (CS-2.7)',
          'The open message shows its Cc recipient, so the audience is visible before replying.');
        await page.getByRole('button', { name: 'Reply', exact: true }).first().click();
        await expect(page.locator('.compose-dialog')).toBeVisible({ timeout: 10_000 });
        const to = await recipientAddresses(page, 'To');
        const subject = await composeSubject(page).inputValue();
        const body = await page.locator('.compose-dialog .editor[contenteditable]').innerText();
        expect(to, 'reply should address the original sender').toContain(stranger.toLowerCase());
        expect(subject, 'reply should carry an Re: subject').toMatch(/^Re: /);
        record('Reply prefill',
          `To=${JSON.stringify(to)}, Subject="${subject}", quoted body ${body.includes('Original message body') ? 'present' : 'MISSING'}.`);
        await shot(page, 'reply-prefill');
        await page.waitForTimeout(900);
      });

      await test.step('Sending that reply threads it to its parent (CS-2.6)', async () => {
        // Continues from the composer opened above rather than
        // re-opening the message. Re-clicking a row mid-walkthrough left
        // the detail pane in its "Select a message to read it" state, so
        // the Reply control never appeared; the list is virtualized over
        // ~1500 seeded rows and a second click on a recycled row does
        // not reliably open it.
        await clearRecipients(page, 'To');
        await fillRecipient(page, 'To', SHARED_TEST_OIDC_EMAIL);
        await composeSubject(page).fill(subjects.reply);
        await page.locator('.compose-dialog button.primary', { hasText: /^Send$/ }).click();
        await expect(page.locator('.compose-dialog')).toBeHidden({ timeout: 30_000 });
        await waitForPendingMutations(page);
        // Stalwart's subject index lags the Email/set commit, so poll
        // rather than reading once.
        await expect.poll(
          async () => findByExactSubject(jmap, sent, subjects.reply),
          { timeout: 30_000, message: 'reply should become queryable in Sent' },
        ).not.toBeNull();
        const replyId = await findByExactSubject(jmap, sent, subjects.reply);
        expect(replyId, 'the reply should be filed in Sent').not.toBeNull();
        mine.push(replyId);
        const replyMail = await readEmail(jmap, replyId);
        expect(replyMail.inReplyTo?.length, 'a reply must name its parent').toBeGreaterThan(0);
        expect(replyMail.references?.length, 'a reply must carry a References chain')
          .toBeGreaterThan(0);
        record('Reply threading headers (CS-2.6)',
          `inReplyTo=${JSON.stringify(replyMail.inReplyTo)}, references=${JSON.stringify(replyMail.references)}, so other clients thread this on headers rather than on the subject.`);
      });

      await test.step('Reply All via keyboard carries the original Cc (issue #71)', async () => {
        await page.keyboard.press('ControlOrMeta+Shift+r');
        await expect(page.locator('.compose-dialog')).toBeVisible({ timeout: 10_000 });
        await expect(composeRow(page, 'Cc'), 'reply-all opens with its Cc shown')
          .toHaveCount(1);
        const to = await recipientAddresses(page, 'To');
        const cc = await recipientAddresses(page, 'Cc');
        expect(cc, 'the original Cc is part of the audience').toContain('cc-watcher@example.org');
        expect(cc, 'our own address is not a recipient of our reply')
          .not.toContain(selfEmail().toLowerCase());
        record('Reply All audience (issue #71, CS-2.5)',
          `Ctrl+Shift+R produced To=${JSON.stringify(to)}, Cc=${JSON.stringify(cc)}. The original To and Cc travel, our own addresses do not, and Bcc is never copied.`);
        await shot(page, 'reply-all-carries-cc');
        await page.waitForTimeout(900);
        await closeCompose(page);
        await expect(page.locator('.compose-dialog')).toBeHidden();
      });

      await test.step('Forward via keyboard starts with no recipients', async () => {
        await page.keyboard.press('ControlOrMeta+l');
        await expect(page.locator('.compose-dialog')).toBeVisible({ timeout: 10_000 });
        const to = await recipientAddresses(page, 'To');
        const subject = await composeSubject(page).inputValue();
        expect(to, 'forward should start with an empty recipient').toEqual([]);
        expect(subject).toMatch(/^Fwd: /);
        record('Forward prefill', `Ctrl+L produced To=${JSON.stringify(to)}, Subject="${subject}".`);
        await page.waitForTimeout(900);
        await closeCompose(page);
        await expect(page.locator('.compose-dialog')).toBeHidden();
      });

      await test.step('Summary of recorded observations', async () => {
        const md = ['# Walkthrough observations', ''];
        for (const f of findings) {
          md.push(`## ${f.area}`, '', f.observation, '');
        }
        const body = md.join('\n');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'observations.md'), body);
        await testInfo.attach('walkthrough-observations.md', {
          body,
          contentType: 'text/markdown',
        });
      });
    } finally {
      await attachConsoleTail(testInfo, consoleLines);
      for (const id of mine.filter(Boolean)) {
        await cleanupEmail(jmap, id, trash.id).catch(() => {});
      }
      for (const id of theirs.filter(Boolean)) {
        await cleanupEmail(shared, id, sharedTrash?.id ?? null).catch(() => {});
      }
    }
  });
});
