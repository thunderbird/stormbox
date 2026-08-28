import {
  cleanupEmail,
  connectJmap,
  listMailboxes,
  mailboxByRole,
} from './helpers/jmap-client.js';
import {
  attachConsoleTail,
  consoleLinesFor,
  expect,
  test,
} from './helpers/shared-session.js';
import {
  localStackEnabled,
  skipLocalStackMessage,
  SHARED_TEST_OIDC_EMAIL,
  SHARED_TEST_OIDC_PASSWORD,
  STACK_STALWART_API_AUTH,
  STACK_STALWART_API_URL,
  STACK_STALWART_PRINCIPAL,
} from './helpers/stack-env.js';
import {
  clickFolder,
  readContactsCache,
  waitForPendingMutations,
  waitForShellReady,
} from './helpers/ui.js';
import { composeSubject, fillRecipient } from './helpers/compose.js';
import {
  CONTACT_CACHE_FAULT, CONTACT_CACHE_REFUSALS, FAULTS_PATH, STATUS_PATH,
} from '../fixtures/ws-proxy/inject.mjs';

/**
 * Contact and identity source integrity (CS-4.2, CS-4.4, CS-4.5, CS-4.6).
 *
 * Each case here needs a real server for a reason that a unit test cannot
 * supply: what the recipient's copy of a message says in its From header,
 * what an alias created after login does to the picker, and what a card
 * deleted somewhere else does to this account's address book.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

const WS_PROXY = process.env.WS_PROXY_URL ?? 'http://127.0.0.1:8787';

const ALIAS_PREFIX = 'alias-e2e';
const CONTACT_DOMAIN = 'integrity-e2e.example';

async function contactsRequest(jmap, methodCalls) {
  const res = await fetch(jmap.apiUrl, {
    method: 'POST',
    headers: { Authorization: jmap.authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:contacts'],
      methodCalls,
    }),
  });
  if (!res.ok) {
    throw new Error(`contacts JMAP failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  return res.json();
}

async function listCards(jmap) {
  const q = await contactsRequest(jmap, [['ContactCard/query', { accountId: jmap.accountId }, 'q']]);
  const ids = q.methodResponses?.find((r) => r[0] === 'ContactCard/query')?.[1]?.ids ?? [];
  if (ids.length === 0) return [];
  const g = await contactsRequest(jmap, [['ContactCard/get', { accountId: jmap.accountId, ids }, 'g']]);
  return g.methodResponses?.find((r) => r[0] === 'ContactCard/get')?.[1]?.list ?? [];
}

async function createCard(jmap, { name, email, bookId }) {
  const res = await contactsRequest(jmap, [[
    'ContactCard/set',
    {
      accountId: jmap.accountId,
      create: {
        c1: {
          '@type': 'Card',
          version: '1.0',
          addressBookIds: { [bookId]: true },
          name: { full: name },
          emails: { e1: { '@type': 'EmailAddress', address: email } },
        },
      },
    },
    's',
  ]]);
  const created = res.methodResponses?.[0]?.[1]?.created?.c1;
  expect(created?.id, `the server should have created a card: ${JSON.stringify(res.methodResponses?.[0]?.[1])}`)
    .toBeTruthy();
  return created.id;
}

async function destroyCard(jmap, cardId) {
  await contactsRequest(jmap, [[
    'ContactCard/set',
    { accountId: jmap.accountId, destroy: [cardId] },
    's',
  ]]).catch(() => {});
}

async function defaultBookId(jmap) {
  const res = await contactsRequest(jmap, [['AddressBook/get', { accountId: jmap.accountId }, 'a']]);
  const books = res.methodResponses?.[0]?.[1]?.list ?? [];
  const chosen = books.find((b) => b.isDefault) ?? books[0];
  expect(chosen?.id, 'the account needs an address book to file a card in').toBeTruthy();
  return chosen.id;
}

/** Stalwart's management API: what the account is allowed to send as. */
async function patchPrincipalEmails(action, address) {
  const res = await fetch(
    `${STACK_STALWART_API_URL}/api/principal/${encodeURIComponent(STACK_STALWART_PRINCIPAL)}`,
    {
      method: 'PATCH',
      headers: { Authorization: STACK_STALWART_API_AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ action, field: 'emails', value: address }]),
    },
  );
  expect(res.ok, `principal ${action} for ${address} should succeed`).toBe(true);
}

async function identityIds(jmap, email) {
  const res = await fetch(jmap.apiUrl, {
    method: 'POST',
    headers: { Authorization: jmap.authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:submission'],
      methodCalls: [['Identity/get', { accountId: jmap.accountId }, 'i']],
    }),
  });
  const list = (await res.json()).methodResponses?.[0]?.[1]?.list ?? [];
  return list.filter((identity) => !email || identity.email === email).map((i) => i.id);
}

async function identitySet(jmap, params) {
  const res = await fetch(jmap.apiUrl, {
    method: 'POST',
    headers: { Authorization: jmap.authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:submission'],
      methodCalls: [['Identity/set', { accountId: jmap.accountId, ...params }, 's']],
    }),
  });
  return (await res.json()).methodResponses?.[0]?.[1] ?? {};
}

/** Force the full, authoritative contact sync the app runs at startup. */
function resyncContacts(page) {
  return page.evaluate(async () => {
    const accounts = await globalThis.__repo.listAccounts();
    await globalThis.__repo.ensureContacts(accounts[0].id);
  });
}

test.describe('Contact and identity integrity', () => {
  test.beforeEach(async ({ sharedPage: page }) => {
    // A case here may leave the app in the Contacts space, and the shared
    // session is shared with every other spec in the lane.
    await page.getByRole('button', { name: 'Mail', exact: true }).click().catch(() => {});
    await waitForShellReady(page);
  });

  test('an identity managed in Contacts can be sent from, and arrives as itself', async ({ sharedPage: page }, testInfo) => {
    // CS-4.9: the managed identity must reach both the shared list and the
    // From picker, and the recipient's copy proves which identity was used.
    const jmap = await connectJmap();
    // Self-addressed mail cannot prove delivery here: the client writes the
    // Sent copy first, and Stalwart's ingest drops the inbound copy as a
    // duplicate Message-ID while still answering 250. A second account has
    // no Sent copy to collide with, so its Inbox is a real observation.
    const recipient = await connectJmap({
      username: SHARED_TEST_OIDC_EMAIL,
      password: SHARED_TEST_OIDC_PASSWORD,
    });
    const stamp = Date.now();
    const alias = `${ALIAS_PREFIX}-${stamp}@example.org`;
    const subject = `Alias fidelity ${stamp}`;
    let identityId = null;
    let deliveredId = null;
    try {
      await patchPrincipalEmails('addItem', alias);
      await page.getByRole('button', { name: 'Contacts', exact: true }).click();
      await expect(page.locator('.contacts')).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Manage identities' }).click();
      await expect(page.getByRole('heading', { name: 'Identities' })).toBeVisible();
      await page.getByRole('button', { name: 'Add identity' }).click();
      const form = page.locator('.contacts__form');
      await form.locator('input[type="text"]').fill('Alias E2E');
      await form.locator('input[type="email"]').fill(alias);
      await form.getByRole('button', { name: 'Save identity' }).click();

      await expect.poll(async () => {
        const ids = await identityIds(jmap, alias);
        identityId = ids[0] ?? null;
        return ids.length;
      }, {
        timeout: 30_000,
        message: 'the identity created in Contacts should exist on the server',
      }).toBe(1);
      const aliasRow = page.locator('.contacts__row').filter({ hasText: alias });
      await expect(aliasRow).toContainText('Alias E2E');

      await aliasRow.getByRole('button', { name: 'Edit Alias E2E' }).click();
      await form.locator('input[type="text"]').fill('Alias E2E Updated');
      await form.getByRole('button', { name: 'Save changes' }).click();
      await expect(aliasRow).toContainText('Alias E2E Updated');

      await page.getByRole('button', { name: 'Mail', exact: true }).click();
      await page.keyboard.press('ControlOrMeta+n');
      await expect(page.locator('.compose-dialog')).toBeVisible({ timeout: 10_000 });
      const picker = page.locator('.compose-dialog [data-compose-from]');
      const aliasOption = picker.locator('.app-dropdown__item', { hasText: alias });
      await expect
        .poll(async () => aliasOption.count(), {
          timeout: 30_000,
          message: 'opening the composer should pick up an alias added since login',
        })
        .toBe(1);

      await picker.locator('summary').click();
      await aliasOption.click();
      await expect(picker.locator('summary')).toContainText(alias);
      await fillRecipient(page, 'To', SHARED_TEST_OIDC_EMAIL);
      await composeSubject(page).fill(subject);
      await page.locator('.compose-dialog .editor[contenteditable]').first().click();
      await page.keyboard.type('Sent from an alias.');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.locator('.compose-dialog')).toHaveCount(0, { timeout: 30_000 });

      // What the recipient received is the assertion: a From header the
      // server rewrote to the primary address would fail here.
      const mailboxes = await listMailboxes(recipient);
      const inbox = mailboxByRole(mailboxes, 'inbox');
      await expect.poll(async () => {
        const found = await findDelivered(recipient, inbox.id, subject);
        deliveredId = found?.id ?? deliveredId;
        return found?.from?.[0] ?? null;
      }, {
        // Under the per-test budget: delivery inside the local stack is
        // immediate, so a slow poll here only hides the failure behind a
        // timeout that says nothing.
        timeout: 30_000,
        message: 'the message should arrive with the selected identity name and address',
      }).toEqual({ name: 'Alias E2E Updated', email: alias });

      await page.getByRole('button', { name: 'Contacts', exact: true }).click();
      await page.getByRole('button', { name: 'Manage identities' }).click();
      await page.locator('.contacts__row')
        .filter({ hasText: alias })
        .getByRole('button', { name: 'Remove Alias E2E Updated' })
        .click();
      await expect.poll(
        async () => (await identityIds(jmap, alias)).length,
        {
          timeout: 30_000,
          message: 'removing the identity in Contacts should destroy it on the server',
        },
      ).toBe(0);
      identityId = null;
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      if (deliveredId) {
        const boxes = await listMailboxes(recipient).catch(() => []);
        const trash = mailboxByRole(boxes, 'trash');
        if (trash) await cleanupEmail(recipient, deliveredId, trash.id).catch(() => {});
      }
      if (identityId) await identitySet(jmap, { destroy: [identityId] }).catch(() => {});
      await patchPrincipalEmails('removeItem', alias).catch(() => {});
    }
  });

  test('explains when an identity address is not configured for the account', async ({ sharedPage: page }, testInfo) => {
    const jmap = await connectJmap();
    const address = `not-owned-${Date.now()}@example.net`;
    try {
      await page.getByRole('button', { name: 'Contacts', exact: true }).click();
      await expect(page.locator('.contacts')).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Manage identities' }).click();
      await page.getByRole('button', { name: 'Add identity' }).click();
      const form = page.locator('.contacts__form');
      await form.locator('input[type="text"]').fill('Unavailable Address');
      await form.locator('input[type="email"]').fill(address);
      await form.getByRole('button', { name: 'Save identity' }).click();

      await expect(form).toBeVisible();
      await expect(page.locator('.store-error-toast')).toContainText(
        'You can’t send from this email address. Add it to your account before creating an identity.',
      );
      expect(await identityIds(jmap, address)).toEqual([]);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await page.locator('.contacts__form')
        .getByRole('button', { name: 'Cancel' })
        .click()
        .catch(() => {});
    }
  });

  test('a contact deleted on the server disappears here after a sync', async ({ sharedPage: page }, testInfo) => {
    // CS-4.2. Without an authoritative sweep the card stayed in this
    // account's address book and its autocomplete indefinitely: a delta
    // never names a card the server has already forgotten.
    const jmap = await connectJmap();
    const stamp = Date.now();
    const email = `ghost-${stamp}@${CONTACT_DOMAIN}`;
    const name = `Ghost ${stamp}`;
    let cardId = null;
    try {
      cardId = await createCard(jmap, { name, email, bookId: await defaultBookId(jmap) });

      await clickFolder(page, 'Inbox');
      await resyncContacts(page);
      await expect.poll(
        async () => (await readContactsCache(page)).some((c) => c.display_name === name),
        { timeout: 30_000, message: 'the new card should reach this account first' },
      ).toBe(true);

      await destroyCard(jmap, cardId);
      cardId = null;
      await resyncContacts(page);

      await expect.poll(
        async () => (await readContactsCache(page)).some((c) => c.display_name === name),
        { timeout: 30_000, message: 'a card the server no longer has must not survive a full sync' },
      ).toBe(false);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      if (cardId) await destroyCard(jmap, cardId);
    }
  });

  test('a contact saved but not cached is reported, not called a success', async ({ sharedPage: page }, testInfo) => {
    // CS-4.4. The card reaches the server and the read-back is refused, so
    // the save half worked and the cache half did not. Reporting success
    // there tells the user their contact is saved while showing them a list
    // that says otherwise.
    const jmap = await connectJmap();
    const stamp = Date.now();
    const email = `stale-${stamp}@${CONTACT_DOMAIN}`;
    // The proxy arms on this marker inside the ContactCard/set create, then
    // refuses the read-back for the card the server reports creating.
    const name = `Stale ${stamp} ${CONTACT_CACHE_FAULT}`;
    try {
      // Faults live in the WebSocket leg; an HTTP send never reaches the
      // proxy and would leave this case describing a fault that never fired.
      await waitForWebSocketLeg('CONTACT_CACHE');
      await page.getByRole('button', { name: 'Contacts', exact: true }).click();
      await expect(page.locator('.contacts')).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Add contact' }).click();
      const form = page.locator('.contacts__form');
      await expect(form).toBeVisible();
      await form.locator('input[type="text"]').first().fill(name);
      await form.locator('input[type="email"]').first().fill(email);
      // Start watching for the parked row before the save can settle. The
      // repair below is quick, and a poll that begins after it has already
      // run would find a clean queue and read that as proof of a state it
      // never actually observed.
      const parked = firstParkedSighting(page, name);
      await form.getByRole('button', { name: /^save contact$/i }).click();

      // The server has the card even though this account could not read it
      // back, which is the state the requirement is about.
      let cardId = null;
      await expect.poll(async () => {
        const cards = await listCards(jmap);
        cardId = cards.find((card) => card?.name?.full === name)?.id ?? null;
        return cardId;
      }, {
        timeout: 30_000,
        message: 'the card should exist on the server despite the refused read-back',
      }).toBeTruthy();

      // Nothing below means anything unless the read-back for *this* card
      // was actually refused. The card id is what makes that specific: the
      // proxy's log outlives the run, so counting refusals would be
      // satisfied by an earlier case before this one did anything.
      await expect.poll(async () => cacheRefusalsFor(cardId), {
        timeout: 30_000,
        message: `the ws-proxy should have refused the read-back of card ${cardId}`,
      }).toBeGreaterThanOrEqual(1);

      // CS-4.4: a half-applied write is not a success. The row has to be
      // seen carrying "written, not cached" — waiting only for the cache to
      // agree in the end would pass just as well if the write had been
      // called a success and the cache repaired by some later sync.
      const { row: sighting, trail } = await parked;
      expect(
        sighting,
        `the write should be parked as written-but-not-cached; the proxy refuses `
        + `${CONTACT_CACHE_REFUSALS} read-backs so the row stays parked across a retry. `
        + `Row states seen: ${trail.length ? trail.join(' -> ') : '(nothing)'}`,
      ).toBeTruthy();
      expect(sighting.phase).toBe('cache_pending');
      expect(
        JSON.parse(sighting.server_response_json ?? '{}').reconcileIds ?? [],
        'and it should carry the id the repair needs',
      ).toContain(cardId);

      await waitForPendingMutations(page);
      await expect.poll(async () => {
        const rows = await readContactsCache(page);
        return (rows ?? []).some((row) => row.display_name === name);
      }, {
        timeout: 30_000,
        message: 'the retry should repair the cache the refused read-back left stale',
      }).toBe(true);

      // The repair reconciles the card already written; it does not write
      // a second one.
      expect(
        (await listCards(jmap)).filter((card) => card?.name?.full === name).length,
        'the repair must not create the contact twice',
      ).toBe(1);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      const cards = await listCards(jmap).catch(() => []);
      for (const card of cards) {
        if (card?.name?.full === name) await destroyCard(jmap, card.id);
      }
    }
  });
});

/**
 * The contact write parked at "the server has it, the cache does not".
 *
 * Polls from before the save until the row appears, so the window is
 * observed rather than inferred from its aftermath. Resolves
 * `{ row: null, trail }` if the queue drains without it ever being seen;
 * `trail` is every distinct state the row was caught in, which is the
 * difference between "the row never parked" and "the row never existed".
 */
async function firstParkedSighting(page, name) {
  const deadline = Date.now() + 30_000;
  // Every state this row was seen in, so a miss can say whether the row
  // never existed, took another phase, or was simply never looked at.
  const trail = [];
  const note = (state) => {
    if (trail[trail.length - 1] !== state) trail.push(state);
  };
  while (Date.now() < deadline) {
    // An evaluate that fails is not the same as a row that is not there yet.
    // Swallowing it would spend the whole deadline retrying and then report
    // the absence as the product's behaviour.
    const seen = await page.evaluate(async (wanted) => {
      if (!globalThis.__repo) return { repo: false, rows: [] };
      const rows = await globalThis.__repo.call('db.query', {
        sql: `SELECT phase, mutation_type, local_status, attempts, error_json,
                     request_json, server_response_json
                FROM pending_mutations
               ORDER BY created_at DESC
               LIMIT 20`,
        params: [],
      });
      return {
        repo: true,
        rows: (rows ?? []).filter((r) => (r.request_json ?? '').includes(wanted)),
      };
    }, name).catch((err) => {
      if (String(err?.message ?? err).includes('Execution context was destroyed')) {
        return { repo: false, rows: [] };
      }
      throw err;
    });
    if (!seen.repo) note('no __repo');
    else if (seen.rows.length === 0) note('no row');
    else {
      for (const row of seen.rows) {
        note(
          `${row.mutation_type}/${row.local_status}:${row.phase ?? '-'}`
          + `@${row.attempts}`
          + `${row.error_json ? ` !${String(row.error_json).slice(0, 80)}` : ''}`,
        );
        if (row.phase === 'cache_pending') return { row, trail };
      }
    }
    await page.waitForTimeout(50);
  }
  return { row: null, trail };
}

/** How many times the proxy refused the read-back of one specific card. */
async function cacheRefusalsFor(cardId) {
  const res = await fetch(`${WS_PROXY}${FAULTS_PATH}`, { signal: AbortSignal.timeout(5_000) });
  const applied = await res.json();
  return applied.filter((f) => f.mode === 'CONTACT_CACHE' && f.emailId === cardId).length;
}

/**
 * Wait until the client is actually talking through the proxy.
 *
 * The transport uses HTTP whenever its socket is not open, and an HTTP
 * request never reaches the proxy, so an unarmed fault would let the save
 * succeed for real and the case would prove nothing.
 */
async function waitForWebSocketLeg(mode) {
  await expect.poll(
    async () => {
      const res = await fetch(`${WS_PROXY}${STATUS_PATH}`, { signal: AbortSignal.timeout(5_000) });
      expect(
        res.ok,
        `the ws-proxy does not serve ${STATUS_PATH}; restart it with npm run stack:ws-proxy`,
      ).toBe(true);
      const status = await res.json();
      // The proxy outlives the suite, so it can be running code older than
      // the case that needs it. An older build forwards the marked frame
      // untouched, which is indistinguishable from a marker that stopped
      // matching until you check what it knows how to do.
      expect(
        status.modes ?? [],
        `the running ws-proxy predates the ${mode} fault; restart it with npm run stack:ws-proxy`,
      ).toContain(mode);
      return status.liveSockets;
    },
    {
      timeout: 60_000,
      message: 'the client should hold a WebSocket through the proxy before a fault is armed',
    },
  ).toBeGreaterThan(0);
}

/** The delivered copy of a subject, with its From header. */
async function findDelivered(jmap, mailboxId, subject) {
  const res = await fetch(jmap.apiUrl, {
    method: 'POST',
    headers: { Authorization: jmap.authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/query', { accountId: jmap.accountId, filter: { inMailbox: mailboxId, subject } }, 'q'],
        [
          'Email/get',
          {
            accountId: jmap.accountId,
            '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
            properties: ['id', 'from', 'subject'],
          },
          'g',
        ],
      ],
    }),
  });
  const list = (await res.json()).methodResponses?.find((r) => r[0] === 'Email/get')?.[1]?.list ?? [];
  return list.find((email) => email.subject === subject) ?? null;
}
