import {
  cleanupEmail,
  connectJmap,
  createEmailInMailbox,
  getEmailKeywords,
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
  readContactEmailsFromCache,
  readContactsCache,
  readViewCacheForFolderRole,
  waitForPendingMutations,
} from './helpers/ui.js';

/**
 * Contacts management + Junk "Not junk" whitelist flows (junk-whitelist
 * branch). Each mutation is verified on all three legs the constitution
 * requires: the UI, the local cache via window.__repo, and the server
 * via direct JMAP. A whitelist creates a trusted ContactCard, marks the
 * message $notjunk, and rescues it to the Inbox; contacts add/edit/delete
 * round-trips through ContactCard/set; multi-email and the address-book
 * folder rail work.
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

      // Server: the spam keywords were rescued ($junk cleared, $notjunk set).
      await expect.poll(async () => {
        const keywords = await getEmailKeywords(jmap, createdId);
        if (!keywords) return 'missing';
        if (keywords.$junk) return 'still-junk';
        return keywords.$notjunk === true ? 'notjunk' : JSON.stringify(keywords);
      }, { timeout: 30_000, message: 'server should mark the message $notjunk and clear $junk' }).toBe('notjunk');

      // Local cache: the message left the Junk view (window.__repo, not the
      // worker read-through). The destination Inbox window is invalidated and
      // re-fetched on open rather than proactively materialized while another
      // folder is in view, so — like delete-message.spec / bulk-delete.spec —
      // we assert removal from the source cache here and the destination on
      // the server (above), not presence in the Inbox view cache.
      const junkCache = await readViewCacheForFolderRole(page, 'junk');
      expect(junkCache, 'local Junk cache should be reachable via window.__repo').not.toBeNull();
      expect(junkCache.remoteIds, 'remote id should be gone from the Junk cache').not.toContain(createdId);

      // Local cache: the trusted sender appears in the contacts cache.
      await expect.poll(async () => {
        const cached = await readContactsCache(page);
        return (cached ?? []).some(
          (c) => (c.email ?? '').toLowerCase() === senderEmail.toLowerCase(),
        );
      }, { timeout: 30_000, message: 'trusted sender should land in the local contacts cache' }).toBe(true);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await destroyTestCards(jmap);
      if (createdId && trash) await cleanupEmail(jmap, createdId, trash.id).catch(() => {});
    }
  });

  test('Junk multi-select "Not junk" whitelists every unique sender and moves the batch to the Inbox', async ({ sharedPage: page }, testInfo) => {
    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    const trash = mailboxByRole(mailboxes, 'trash');
    const junk = await ensureJunkMailbox(jmap);

    const ts = Date.now();
    // Two distinct senders, one of them on two messages, so the bulk
    // path's per-address de-duplication is exercised (3 messages → 2
    // trusted cards).
    const senderA = `bulk-a-${ts}@promo-e2e.example`;
    const senderB = `bulk-b-${ts}@promo-e2e.example`;
    const cases = [
      { subject: `${JUNK_SUBJECT_PREFIX} bulk ${ts} a1`, sender: senderA },
      { subject: `${JUNK_SUBJECT_PREFIX} bulk ${ts} a2`, sender: senderA },
      { subject: `${JUNK_SUBJECT_PREFIX} bulk ${ts} b1`, sender: senderB },
    ];
    const createdIds = [];
    try {
      for (const { subject, sender } of cases) {
        const id = await createEmailInMailbox(jmap, {
          mailboxId: junk.id,
          fromEmail: sender,
          subject,
          keywords: { $junk: true },
        });
        createdIds.push(id);
      }

      await clickFolder(page, 'Junk');
      for (const { subject } of cases) {
        await expectRowSoon(page, subject);
      }

      // Multi-select all three via the checkbox column (no preview open).
      for (const { subject } of cases) {
        await page.locator('.msg-list__items > li')
          .filter({ hasText: subject })
          .first()
          .locator('.msg-list__check input')
          .click();
      }
      await expect(page.locator('.msg-list__count'))
        .toHaveText(/^3 selected/, { timeout: 5_000 });

      // The bulk "Not junk" action is only present in the Junk folder.
      await page.locator('.msg-list__bulk-actions [title="Whitelist senders and move to Inbox"]').click();

      // Success toast names the two unique senders.
      await expect(page.locator('.store-error-toast__item--success'))
        .toContainText(/whitelisted 2 senders/i, { timeout: 30_000 });

      // Every selected message leaves the Junk list.
      for (const { subject } of cases) {
        await expect.poll(
          async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
          { timeout: 30_000, message: `whitelisted bulk row "${subject}" should leave Junk` },
        ).toBe(0);
      }

      await waitForPendingMutations(page);

      // Server: each message is now in the Inbox and marked $notjunk.
      for (const id of createdIds) {
        await expect.poll(async () => {
          const ids = await getEmailMailboxIds(jmap, id);
          if (!ids) return 'missing';
          if (ids[inbox.id] === true && ids[junk.id] !== true) return 'inbox';
          if (ids[junk.id] === true) return 'junk';
          return JSON.stringify(ids);
        }, { timeout: 30_000, message: `server should report ${id} in Inbox` }).toBe('inbox');
        await expect.poll(async () => {
          const keywords = await getEmailKeywords(jmap, id);
          if (!keywords) return 'missing';
          if (keywords.$junk) return 'still-junk';
          return keywords.$notjunk === true ? 'notjunk' : JSON.stringify(keywords);
        }, { timeout: 30_000, message: `server should mark ${id} $notjunk` }).toBe('notjunk');
      }

      // Server: both unique senders are trusted, and senderA — used by
      // two messages — produced a single card (de-duplicated).
      await expect.poll(async () => {
        const cards = await listCards(jmap);
        return findCardByEmail(cards, senderA) != null && findCardByEmail(cards, senderB) != null;
      }, { timeout: 30_000, message: 'both bulk senders should have a trusted ContactCard' }).toBe(true);
      const cardsForA = (await listCards(jmap))
        .filter((c) => cardEmails(c).some((a) => a.toLowerCase() === senderA.toLowerCase()));
      expect(cardsForA, 'the repeated sender should map to a single trusted card').toHaveLength(1);

      // Local cache: the messages left the Junk view (window.__repo). As in
      // the single-message test, the destination Inbox window is invalidated
      // and re-fetched on open, so we assert source-cache removal here and
      // the Inbox destination on the server (above), not presence in the
      // Inbox view cache.
      const junkCache = await readViewCacheForFolderRole(page, 'junk');
      expect(junkCache, 'local Junk cache should be reachable via window.__repo').not.toBeNull();
      for (const id of createdIds) {
        expect(junkCache.remoteIds, `${id} should be gone from the Junk cache`).not.toContain(id);
      }
      await expect.poll(async () => {
        const cached = await readContactsCache(page);
        const emails = new Set((cached ?? []).map((c) => (c.email ?? '').toLowerCase()));
        return emails.has(senderA.toLowerCase()) && emails.has(senderB.toLowerCase());
      }, { timeout: 30_000, message: 'both trusted senders should land in the contacts cache' }).toBe(true);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await destroyTestCards(jmap);
      if (trash) {
        for (const id of createdIds) {
          await cleanupEmail(jmap, id, trash.id).catch(() => {});
        }
      }
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

      // Local cache: the new contact (with both emails) is reachable via
      // window.__repo, not just rendered in the DOM.
      await expect.poll(async () => {
        const cached = await readContactsCache(page);
        return (cached ?? []).some((c) => c.display_name === name);
      }, { timeout: 30_000, message: 'added contact should appear in the local contacts cache' }).toBe(true);
      const addedRemoteId = (await readContactsCache(page))
        .find((c) => c.display_name === name)?.remote_id ?? null;
      expect(addedRemoteId, 'cached contact should carry a remote id').not.toBeNull();
      await expect.poll(
        async () => (await readContactEmailsFromCache(page, addedRemoteId))?.length ?? 0,
        { timeout: 30_000, message: 'cache should hold both emails for the new contact' },
      ).toBe(2);

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

      // Local cache: the rename and the third email are reflected.
      await expect.poll(async () => {
        const cached = await readContactsCache(page);
        return (cached ?? []).some((c) => c.display_name === editedName);
      }, { timeout: 30_000, message: 'edited contact name should appear in the local contacts cache' }).toBe(true);
      const editedRemoteId = (await readContactsCache(page))
        .find((c) => c.display_name === editedName)?.remote_id ?? null;
      expect(editedRemoteId, 'cached edited contact should carry a remote id').not.toBeNull();
      await expect.poll(
        async () => (await readContactEmailsFromCache(page, editedRemoteId))?.length ?? 0,
        { timeout: 30_000, message: 'cache should hold three emails after the edit' },
      ).toBe(3);

      // --- Remove ---
      await editedRow.getByRole('button', { name: /^Remove / }).click();
      await expect(editedRow).toHaveCount(0, { timeout: 30_000 });

      await waitForPendingMutations(page);

      // Server: card is gone.
      await expect.poll(async () => {
        return findCardByEmail(await listCards(jmap), email1) == null;
      }, { timeout: 30_000, message: 'removed contact should be destroyed server-side' }).toBe(true);

      // Local cache: the contact is soft-deleted and no longer listed.
      await expect.poll(async () => {
        const cached = await readContactsCache(page);
        return (cached ?? []).some((c) => c.display_name === editedName);
      }, { timeout: 30_000, message: 'removed contact should disappear from the local contacts cache' }).toBe(false);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await destroyTestCards(jmap);
    }
  });
});
