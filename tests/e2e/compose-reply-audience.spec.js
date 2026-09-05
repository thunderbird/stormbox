import {
  cleanupEmail,
  connectJmap,
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
  localStackEnabled,
  selfEmail,
  SHARED_TEST_OIDC_EMAIL,
  SHARED_TEST_OIDC_PASSWORD,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import {
  clickFolder,
  openMessageBySubject,
  waitForPendingMutations,
} from './helpers/ui.js';
import {
  clearRecipients,
  composeRow,
  composeSendButton,
  discardCompose,
  fillRecipient,
  composeSubject,
  invalidRecipients,
  recipientAddresses,
  recipientInput,
  recipientPills,
  waitForIdentities,
} from './helpers/compose.js';

/**
 * Reply audience, Cc/Bcc addressing and threading (CS-2.1 to CS-2.8).
 *
 * Every claim here is checked where it is observable rather than where it
 * is convenient: the audience in the composer, the headers on the message
 * the server actually stored, and the copy that reached the other account.
 * A reply whose To looks right in the UI but carries no In-Reply-To is
 * still a new conversation in every other mail client, and the UI cannot
 * show that.
 *
 * Delivery is proved against a second account: self-addressed mail is
 * accepted for submission and never arrives on the pinned Stalwart v0.15.4
 * (issue #77), so asserting it would test the server's bug.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

const STRANGER = 'stranger@example.org';
const COLLEAGUE = 'colleague@example.org';
const CC_WATCHER = 'cc-watcher@example.org';
const REPLIES_TO = 'replies@example.org';

async function closeCompose(page) {
  const dialog = page.locator('.compose-dialog');
  if (await dialog.count() === 0) return;
  await discardCompose(page).catch(() => {});
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
}

/**
 * Seed a message into this account's Inbox with a full address set.
 *
 * Written over JMAP rather than sent over SMTP so Reply-To, Cc and the
 * Message-ID are exactly what the test says they are.
 */
async function seedReceived(jmap, { mailboxId, from, to, cc, replyTo, subject, bodyText }) {
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
          ...(replyTo?.length ? { replyTo: replyTo.map((email) => ({ email })) } : {}),
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

async function readEmail(jmap, emailId) {
  const payload = await jmapRequest(jmap, [[
    'Email/get',
    {
      accountId: jmap.accountId,
      ids: [emailId],
      properties: [
        'subject', 'from', 'to', 'cc', 'bcc', 'replyTo',
        'messageId', 'inReplyTo', 'references', 'header:Bcc:asRaw',
      ],
    },
    'g1',
  ]]);
  return pickResponse(payload, 'Email/get')?.list?.[0] ?? null;
}

/** Threading fields persisted in the signed-in account's local SQLite row. */
async function readCachedThreading(page, emailId) {
  return page.evaluate(async (remoteId) => {
    if (!globalThis.__repo) return null;
    const accounts = await globalThis.__repo.listAccounts();
    const accountId = accounts?.[0]?.id;
    if (accountId == null) return null;
    const rows = await globalThis.__repo.call('db.query', {
      sql: `SELECT rfc822_message_id, in_reply_to_json, references_json
              FROM messages
             WHERE account_id = ? AND remote_id = ?
             LIMIT 1`,
      params: [accountId, remoteId],
    });
    return rows?.[0] ?? null;
  }, emailId);
}

/**
 * Find a message by exact subject among the newest rows of a mailbox.
 *
 * The JMAP `subject` filter is full-text tokenised, so it cannot match a
 * subject containing `Re:` — replies have to be found by reading subjects.
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
  return (pickResponse(got, 'Email/get')?.list ?? [])
    .find((m) => m.subject === subject)?.id ?? null;
}

/** The addresses of a field, lower-cased, for order-insensitive compares. */
function emailsOf(list) {
  return (list ?? []).map((entry) => entry.email.toLowerCase()).sort();
}

test.describe('Reply audience, Cc/Bcc and threading', () => {
  test.beforeEach(async ({ sharedPage }) => {
    await resetSharedSession(sharedPage);
  });

  test('Reply All carries the whole audience and threads to its parent', async ({ sharedPage: page }, testInfo) => {
    const consoleLines = consoleLinesFor(page);
    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    const sent = mailboxByRole(mailboxes, 'sent');
    const trash = mailboxByRole(mailboxes, 'trash');
    expect(inbox && sent && trash, 'Inbox, Sent and Trash are required').toBeTruthy();

    const shared = await connectJmap({
      username: SHARED_TEST_OIDC_EMAIL,
      password: SHARED_TEST_OIDC_PASSWORD,
    });
    const sharedMailboxes = await listMailboxes(shared);
    const sharedInbox = mailboxByRole(sharedMailboxes, 'inbox');
    const sharedTrash = mailboxByRole(sharedMailboxes, 'trash');
    expect(sharedInbox, 'the second account needs an Inbox to receive into').toBeTruthy();

    const stamp = Date.now();
    const parentSubject = `Reply audience parent ${stamp}`;
    const replySubject = `Re: ${parentSubject}`;
    const mine = [];
    const theirs = [];
    try {
      // The parent names four audiences: an author, a Reply-To that
      // overrides it, a recipient who is us, another who is not, and a Cc.
      // Every rule in CS-2.5 is visible in one message.
      mine.push(await seedReceived(jmap, {
        mailboxId: inbox.id,
        from: STRANGER,
        replyTo: [REPLIES_TO],
        to: [selfEmail(), SHARED_TEST_OIDC_EMAIL],
        cc: [CC_WATCHER, COLLEAGUE],
        subject: parentSubject,
        bodyText: 'The message the reply audience is computed from.',
      }));

      await clickFolder(page, 'Inbox');
      await openMessageBySubject(page, parentSubject);

      // CS-2.7: the audience is visible before replying.
      const ccRow = page.locator('.message-view__metadata-row')
        .filter({ hasText: /^Cc/ });
      await expect(ccRow, 'the detail view should show Cc').toHaveCount(1);
      await expect(ccRow).toContainText(CC_WATCHER);

      await page.getByRole('button', { name: 'Reply All', exact: true }).first().click();
      await expect(page.locator('.compose-dialog')).toBeVisible({ timeout: 10_000 });
      await waitForIdentities(page);

      // CS-2.5: Reply-To wins over From, the original To and Cc travel in
      // Cc, and our own address is not among them.
      const toAddresses = await recipientAddresses(page, 'To');
      expect(toAddresses, 'Reply-To overrides From').toEqual([REPLIES_TO.toLowerCase()]);
      expect(toAddresses, 'the From address is not the reply target here')
        .not.toContain(STRANGER.toLowerCase());

      await expect(composeRow(page, 'Cc'), 'a filled Cc row should be shown').toHaveCount(1);
      const ccAddresses = await recipientAddresses(page, 'Cc');
      expect(ccAddresses, 'the original Cc travels (issue #71)').toContain(CC_WATCHER.toLowerCase());
      expect(ccAddresses, 'the other original recipient travels')
        .toContain(COLLEAGUE.toLowerCase());
      expect(ccAddresses, 'the second account was a recipient too')
        .toContain(SHARED_TEST_OIDC_EMAIL.toLowerCase());
      expect(ccAddresses, 'our own address is never a recipient of our reply')
        .not.toContain(selfEmail().toLowerCase());

      // Send it to the second account only, so delivery is provable, and
      // keep the seeded strangers out of the outgoing envelope.
      await clearRecipients(page, 'To');
      await clearRecipients(page, 'Cc');
      await fillRecipient(page, 'To', SHARED_TEST_OIDC_EMAIL);
      expect(await recipientAddresses(page, 'To'))
        .toEqual([SHARED_TEST_OIDC_EMAIL.toLowerCase()]);
      const editor = page.locator('.compose-dialog .editor[contenteditable]').first();
      await editor.click();
      await page.keyboard.type('Replying to all of you.');
      await composeSendButton(page).click();
      await expect(page.locator('.compose-dialog')).toBeHidden({ timeout: 30_000 });
      await waitForPendingMutations(page);

      await expect.poll(
        async () => findByExactSubject(jmap, sent, replySubject),
        { timeout: 30_000, message: 'the reply should be filed in Sent' },
      ).not.toBeNull();
      const replyId = await findByExactSubject(jmap, sent, replySubject);
      mine.push(replyId);

      // CS-2.6: threading is headers, not a subject prefix.
      const parent = await readEmail(jmap, mine[0]);
      const reply = await readEmail(jmap, replyId);
      const parentMessageId = parent.messageId?.[0];
      expect(parentMessageId, 'the seeded parent should have a Message-ID').toBeTruthy();
      expect(reply.inReplyTo, 'In-Reply-To must name the parent').toEqual([parentMessageId]);
      expect(reply.references, 'References must include the parent')
        .toContain(parentMessageId);

      // The cache leg of CS-5.4: the same fields must survive the
      // server-to-SQLite mapping rather than existing only on the wire.
      await expect.poll(async () => {
        const cached = await readCachedThreading(page, replyId);
        if (!cached) return null;
        return {
          messageId: cached.rfc822_message_id,
          inReplyTo: JSON.parse(cached.in_reply_to_json ?? 'null'),
          references: JSON.parse(cached.references_json ?? 'null'),
        };
      }, {
        timeout: 30_000,
        message: 'the local Sent row should preserve the reply threading fields',
      }).toEqual({
        messageId: reply.messageId?.[0],
        inReplyTo: reply.inReplyTo,
        references: reply.references,
      });

      // And the copy that arrived carries them too, which is what another
      // client threads on.
      await expect.poll(
        async () => findByExactSubject(shared, sharedInbox, replySubject),
        // Under the suite's own 60s test timeout: a poll allowed to run that
        // long dies with "Test timeout" and takes its message with it, so the
        // reason for the failure is the one thing the report leaves out.
        { timeout: 30_000, message: 'the reply should reach the second account' },
      ).not.toBeNull();
      const deliveredId = await findByExactSubject(shared, sharedInbox, replySubject);
      theirs.push(deliveredId);
      const delivered = await readEmail(shared, deliveredId);
      expect(delivered.inReplyTo).toEqual([parentMessageId]);
      expect(delivered.references).toContain(parentMessageId);
    } finally {
      await attachConsoleTail(testInfo, consoleLines);
      await closeCompose(page);
      for (const id of mine.filter(Boolean)) {
        await cleanupEmail(jmap, id, trash.id).catch(() => {});
      }
      for (const id of theirs.filter(Boolean)) {
        await cleanupEmail(shared, id, sharedTrash?.id ?? null).catch(() => {});
      }
    }
  });

  test('Reply stays narrow where Reply All would not', async ({ sharedPage: page }) => {
    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    const trash = mailboxByRole(mailboxes, 'trash');

    const parentSubject = `Reply narrow parent ${Date.now()}`;
    let parentId = null;
    try {
      parentId = await seedReceived(jmap, {
        mailboxId: inbox.id,
        from: STRANGER,
        to: [selfEmail(), COLLEAGUE],
        cc: [CC_WATCHER],
        subject: parentSubject,
        bodyText: 'A plain reply should not gather this audience.',
      });

      await clickFolder(page, 'Inbox');
      await openMessageBySubject(page, parentSubject);
      await page.getByRole('button', { name: 'Reply', exact: true }).first().click();
      await expect(page.locator('.compose-dialog')).toBeVisible({ timeout: 10_000 });

      // CS-2.5: a plain reply targets the author and nobody else, so no Cc
      // row appears at all.
      expect(await recipientAddresses(page, 'To'))
        .toEqual([STRANGER.toLowerCase()]);
      await expect(composeRow(page, 'Cc'), 'a plain reply gathers nobody').toHaveCount(0);
    } finally {
      await closeCompose(page);
      if (parentId) await cleanupEmail(jmap, parentId, trash.id).catch(() => {});
    }
  });

  test('Cc and Bcc address a message from the composer, and Bcc stays hidden', async ({ sharedPage: page }, testInfo) => {
    const consoleLines = consoleLinesFor(page);
    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const sent = mailboxByRole(mailboxes, 'sent');
    const trash = mailboxByRole(mailboxes, 'trash');

    const shared = await connectJmap({
      username: SHARED_TEST_OIDC_EMAIL,
      password: SHARED_TEST_OIDC_PASSWORD,
    });
    const sharedMailboxes = await listMailboxes(shared);
    const sharedInbox = mailboxByRole(sharedMailboxes, 'inbox');
    const sharedTrash = mailboxByRole(sharedMailboxes, 'trash');
    expect(sharedInbox, 'the second account needs an Inbox to receive into').toBeTruthy();

    const subject = `Cc Bcc compose ${Date.now()}`;
    const mine = [];
    const theirs = [];
    try {
      await clickFolder(page, sent.name);
      await clickFolder(page, 'Inbox');
      await page.keyboard.press('c');
      await expect(page.locator('.compose-dialog')).toBeVisible({ timeout: 10_000 });
      await waitForIdentities(page);

      // CS-2.1: the fields exist and are reachable from inline toggles.
      // Each is filled as it is revealed: an empty Cc collapses when focus
      // moves on to the Bcc field, so filling both afterwards cannot work.
      await expect(composeRow(page, 'Cc')).toHaveCount(0);
      await page.locator('.compose-dialog .recipient-toggle', { hasText: /^Cc$/ }).click();
      await expect(composeRow(page, 'Cc')).toHaveCount(1);

      // CS-2.2: nothing in To, and the send is still permitted. The quoted
      // display name also proves the parser end to end: a comma inside it
      // is not a separator (CS-2.3).
      await fillRecipient(page, 'Cc', `"Watcher, A" <${SHARED_TEST_OIDC_EMAIL}>`);
      await page.locator('.compose-dialog .recipient-toggle', { hasText: /^Bcc$/ }).click();
      await expect(composeRow(page, 'Bcc')).toHaveCount(1);
      await fillRecipient(page, 'Bcc', selfEmail());
      await composeSubject(page).fill(subject);
      const editor = page.locator('.compose-dialog .editor[contenteditable]').first();
      await editor.click();
      await page.keyboard.type('Addressed with no To at all.');
      await composeSendButton(page).click();
      await expect(page.locator('.compose-dialog'), 'a Cc-only send is permitted')
        .toBeHidden({ timeout: 30_000 });
      await waitForPendingMutations(page);

      await expect.poll(
        async () => findByExactSubject(jmap, sent, subject),
        { timeout: 30_000, message: 'the message should be filed in Sent' },
      ).not.toBeNull();
      const sentId = await findByExactSubject(jmap, sent, subject);
      mine.push(sentId);

      const stored = await readEmail(jmap, sentId);
      expect(stored.to ?? [], 'nothing was addressed in To').toEqual([]);
      expect(emailsOf(stored.cc)).toEqual([SHARED_TEST_OIDC_EMAIL.toLowerCase()]);
      expect(stored.cc[0].name, 'a comma in a display name is not a separator')
        .toBe('Watcher, A');

      // Bcc is addressed but must not be visible in the delivered copy.
      await expect.poll(
        async () => findByExactSubject(shared, sharedInbox, subject),
        { timeout: 30_000, message: 'the Cc recipient should receive it' },
      ).not.toBeNull();
      const deliveredId = await findByExactSubject(shared, sharedInbox, subject);
      theirs.push(deliveredId);
      const delivered = await readEmail(shared, deliveredId);
      expect(delivered['header:Bcc:asRaw'] ?? null, 'Bcc must not be disclosed').toBeNull();
      expect(emailsOf(delivered.bcc)).toEqual([]);
    } finally {
      await attachConsoleTail(testInfo, consoleLines);
      await closeCompose(page);
      for (const id of mine.filter(Boolean)) {
        await cleanupEmail(jmap, id, trash.id).catch(() => {});
      }
      for (const id of theirs.filter(Boolean)) {
        await cleanupEmail(shared, id, sharedTrash?.id ?? null).catch(() => {});
      }
    }
  });

  test('A fragment that is not an address stops the send and is named', async ({ sharedPage: page }) => {
    // CS-2.4 and CS-3.16: the alternative is delivering to a smaller
    // audience than the user addressed and saying nothing about it. The
    // fragment stays where it was entered, marked, and fixable.
    try {
      await page.keyboard.press('c');
      await expect(page.locator('.compose-dialog')).toBeVisible({ timeout: 10_000 });
      await waitForIdentities(page);

      await fillRecipient(page, 'To', `${selfEmail()}, not an address`);
      await composeSubject(page).fill(`Rejected fragment ${Date.now()}`);

      await composeSendButton(page).click();
      await expect(page.locator('.compose-dialog .compose-error'))
        .toHaveText('Fix invalid recipients before saving or sending this message.');
      await expect(page.locator('.compose-dialog'), 'the draft is kept, not sent')
        .toBeVisible();
      await expect(
        invalidRecipients(page, 'To'),
        'what the user typed is still theirs to fix, where they typed it',
      ).toHaveText(['not an address']);
      await expect(
        recipientPills(page, 'To'),
        'the address that was readable is still a recipient',
      ).toHaveCount(2);

      // Clicking it reopens it as text, which is the whole point of keeping
      // it: a typo is corrected in place (CS-3.16).
      await invalidRecipients(page, 'To').click();
      await expect(recipientInput(page, 'To')).toHaveValue('not an address');
    } finally {
      await closeCompose(page);
    }
  });
});
