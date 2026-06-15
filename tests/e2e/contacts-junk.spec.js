import {
  cleanupEmail,
  connectJmap,
  createEmailInMailbox,
  getEmailMailboxIds,
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
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import {
  clickFolder,
  expectRowSoon,
  openMessageBySubject,
  waitForPendingMutations,
} from './helpers/ui.js';

/**
 * Contacts management + Junk "Not junk" whitelist flows (junk-whitelist
 * branch). Exercises the UI end-to-end and verifies the server side via
 * JMAP: a whitelist creates a trusted ContactCard and rescues the
 * message to the Inbox; contacts add/edit/delete round-trips through
 * ContactCard/set; multi-email and the address-book folder rail work.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

const JUNK_SUBJECT_PREFIX = 'JunkWhitelist e2e';
const CONTACT_DOMAIN = 'contacts-e2e.example';

// --- JMAP contacts helpers (jmapRequest omits the contacts capability,
// so talk to ContactCard/* directly with our own `using`). ------------
async function contactsRequest(jmap, methodCalls) {
  const res = await fetch(jmap.apiUrl, {
    method: 'POST',
    headers: { Authorization: jmap.authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:contacts'],
      methodCalls,
    }),
  });
  if (!res.ok) throw new Error(`contacts JMAP failed: ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

async function listCards(jmap) {
  const q = await contactsRequest(jmap, [['ContactCard/query', { accountId: jmap.accountId }, 'q']]);
  const ids = q.methodResponses?.find((r) => r[0] === 'ContactCard/query')?.[1]?.ids ?? [];
  if (ids.length === 0) return [];
  const g = await contactsRequest(jmap, [['ContactCard/get', { accountId: jmap.accountId, ids }, 'g']]);
  return g.methodResponses?.find((r) => r[0] === 'ContactCard/get')?.[1]?.list ?? [];
}

function cardEmails(card) {
  const e = card?.emails;
  if (!e) return [];
  return Object.values(e).map((x) => x?.address).filter(Boolean);
}

function findCardByEmail(cards, email) {
  const lower = email.toLowerCase();
  return cards.find((c) => cardEmails(c).some((a) => a.toLowerCase() === lower)) ?? null;
}

async function destroyTestCards(jmap) {
  const cards = await listCards(jmap);
  const ids = cards
    .filter((c) => cardEmails(c).some((a) => a.toLowerCase().includes(CONTACT_DOMAIN)
      || a.toLowerCase().includes('promo-e2e.example')))
    .map((c) => c.id);
  if (ids.length > 0) {
    await contactsRequest(jmap, [['ContactCard/set', { accountId: jmap.accountId, destroy: ids }, 'd']]);
  }
}

async function ensureJunkMailbox(jmap) {
  const mailboxes = await listMailboxes(jmap);
  const junk = mailboxByRole(mailboxes, 'junk');
  if (junk) return junk;
  const payload = await jmapRequest(jmap, [[
    'Mailbox/set',
    { accountId: jmap.accountId, create: { mb: { name: 'Junk', role: 'junk' } } },
    'mb',
  ]]);
  const created = pickResponse(payload, 'Mailbox/set')?.created?.mb;
  if (!created?.id) throw new Error('Could not create Junk mailbox');
  return { id: created.id, name: 'Junk', role: 'junk' };
}

async function goToContacts(page) {
  await page.getByRole('button', { name: 'Contacts', exact: true }).click();
  await expect(page.locator('.contacts')).toBeVisible({ timeout: 30_000 });
}

test.describe('Contacts + Junk whitelist e2e', () => {
  test.beforeEach(async ({ sharedPage: page }) => {
    // Tests may leave the app in the Contacts space; resetSharedSession
    // re-anchors the Mail folder tree, so switch back to Mail first.
    await page.getByRole('button', { name: 'Mail', exact: true }).click().catch(() => {});
    await resetSharedSession(page, { extraSubjectPrefixes: [JUNK_SUBJECT_PREFIX] });
    const jmap = await connectJmap();
    await destroyTestCards(jmap);
  });

  test('Junk "Not junk" whitelists the sender and moves the message to the Inbox', async ({ sharedPage: page }, testInfo) => {
    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    const trash = mailboxByRole(mailboxes, 'trash');
    const junk = await ensureJunkMailbox(jmap);

    const senderEmail = `spammer-${Date.now()}@promo-e2e.example`;
    const subject = `${JUNK_SUBJECT_PREFIX} ${Date.now()}`;
    let createdId = null;
    try {
      createdId = await createEmailInMailbox(jmap, {
        mailboxId: junk.id,
        fromEmail: senderEmail,
        subject,
        keywords: { $junk: true },
      });

      await clickFolder(page, 'Junk');
      await expectRowSoon(page, subject);
      await openMessageBySubject(page, subject);

      // The "Not junk" button is only present in the Junk folder.
      const notJunk = page.getByRole('button', { name: /Not junk/i });
      await expect(notJunk).toBeVisible({ timeout: 30_000 });
      await notJunk.click();

      // Success toast confirms the action.
      await expect(page.locator('.store-error-toast__item--success'))
        .toContainText(/whitelisted/i, { timeout: 30_000 });

      // The message leaves the Junk list.
      await expect.poll(
        async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
        { timeout: 30_000, message: 'whitelisted message should leave Junk' },
      ).toBe(0);

      await waitForPendingMutations(page);

      // Server: message is now in the Inbox, not Junk.
      await expect.poll(async () => {
        const ids = await getEmailMailboxIds(jmap, createdId);
        if (!ids) return 'missing';
        if (ids[inbox.id] === true && ids[junk.id] !== true) return 'inbox';
        if (ids[junk.id] === true) return 'junk';
        return JSON.stringify(ids);
      }, { timeout: 30_000, message: 'server should report the message in Inbox' }).toBe('inbox');

      // Server: the sender is now a trusted ContactCard.
      await expect.poll(async () => {
        const cards = await listCards(jmap);
        return findCardByEmail(cards, senderEmail) != null;
      }, { timeout: 30_000, message: 'whitelisted sender should have a ContactCard' }).toBe(true);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await destroyTestCards(jmap);
      if (createdId && trash) await cleanupEmail(jmap, createdId, trash.id).catch(() => {});
    }
  });

  test('Contacts add (multi-email) → edit → remove round-trips through the UI and server', async ({ sharedPage: page }, testInfo) => {
    const jmap = await connectJmap();
    const ts = Date.now();
    const email1 = `alice-${ts}@${CONTACT_DOMAIN}`;
    const email2 = `alice.work-${ts}@${CONTACT_DOMAIN}`;
    const email3 = `alice.alt-${ts}@${CONTACT_DOMAIN}`;
    const name = `Alice E2E ${ts}`;
    const editedName = `Alice Edited ${ts}`;
    try {
      await goToContacts(page);

      // Folder rail: "All contacts" entry is present.
      await expect(page.locator('.contacts__book').filter({ hasText: 'All contacts' }))
        .toBeVisible({ timeout: 30_000 });

      // --- Add with two emails ---
      await page.getByRole('button', { name: 'Add contact' }).click();
      const form = page.locator('.contacts__form');
      await expect(form).toBeVisible();
      await form.locator('input[type="text"]').first().fill(name);
      await form.locator('input[type="email"]').first().fill(email1);
      await form.getByRole('button', { name: /add another email/i }).click();
      await form.locator('input[type="email"]').nth(1).fill(email2);
      await form.getByRole('button', { name: /^save contact$/i }).click();

      const row = page.locator('.contacts__row').filter({ hasText: name });
      await expect(row).toBeVisible({ timeout: 30_000 });

      // Server: card exists with both emails.
      await expect.poll(async () => {
        const card = findCardByEmail(await listCards(jmap), email1);
        return card ? cardEmails(card).length : 0;
      }, { timeout: 30_000, message: 'created card should carry two emails' }).toBe(2);

      // --- Edit: rename + add a third email ---
      await row.getByRole('button', { name: /^Edit / }).click();
      const editForm = page.locator('.contacts__form');
      await expect(editForm).toBeVisible();
      await editForm.locator('input[type="text"]').first().fill(editedName);
      await editForm.getByRole('button', { name: /add another email/i }).click();
      await editForm.locator('input[type="email"]').nth(2).fill(email3);
      await editForm.getByRole('button', { name: /^save changes$/i }).click();

      const editedRow = page.locator('.contacts__row').filter({ hasText: editedName });
      await expect(editedRow).toBeVisible({ timeout: 30_000 });

      // Server: three emails now, and the card still resolves by its
      // original address (merge preserved the existing entries).
      await expect.poll(async () => {
        const card = findCardByEmail(await listCards(jmap), email1);
        return card ? cardEmails(card).length : 0;
      }, { timeout: 30_000, message: 'edited card should carry three emails' }).toBe(3);
      const editedCard = findCardByEmail(await listCards(jmap), email3);
      expect(editedCard?.name?.full).toBe(editedName);

      // --- Remove ---
      await editedRow.getByRole('button', { name: /^Remove / }).click();
      await expect(editedRow).toHaveCount(0, { timeout: 30_000 });

      await waitForPendingMutations(page);

      // Server: card is gone.
      await expect.poll(async () => {
        return findCardByEmail(await listCards(jmap), email1) == null;
      }, { timeout: 30_000, message: 'removed contact should be destroyed server-side' }).toBe(true);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await destroyTestCards(jmap);
    }
  });
});
