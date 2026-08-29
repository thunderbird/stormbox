import {
  cleanupEmail,
  connectJmap,
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
  expectRowSoon,
  readContactsCache,
  waitForPendingMutations,
  waitForShellReady,
} from './helpers/ui.js';
import {
  composeSubject,
  discardCompose,
  fillRecipient,
  recipientAddresses,
  saveDraftAndClose,
  waitForIdentities,
} from './helpers/compose.js';
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
const DETAIL_CONTACT_PREFIX = 'Contact detail integrity';
const DETAIL_DRAFT_PREFIX = 'Identity defaults integrity';
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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

async function getCard(jmap, id) {
  const result = await contactsRequest(jmap, [[
    'ContactCard/get',
    { accountId: jmap.accountId, ids: [id] },
    'g',
  ]]);
  return result.methodResponses?.find((response) => response[0] === 'ContactCard/get')
    ?.[1]?.list?.[0] ?? null;
}

async function patchCard(jmap, id, patch) {
  const result = await contactsRequest(jmap, [[
    'ContactCard/set',
    { accountId: jmap.accountId, update: { [id]: patch } },
    's',
  ]]);
  const set = result.methodResponses?.find((response) => response[0] === 'ContactCard/set')?.[1];
  expect(set?.updated?.[id], `card update should succeed: ${JSON.stringify(set)}`).toBeDefined();
}

async function directIdentity(jmap, email) {
  const result = await jmapRequest(jmap, [[
    'Identity/get',
    { accountId: jmap.accountId },
    'i',
  ]]);
  return (pickResponse(result, 'Identity/get')?.list ?? [])
    .find((identity) => identity.email === email) ?? null;
}

async function cachedIdentity(page, email) {
  return page.evaluate(async (address) => {
    const accounts = await globalThis.__repo.listAccounts();
    const identities = await globalThis.__repo.listIdentities(accounts[0].id);
    return identities.find((identity) => identity.email === address) ?? null;
  }, email);
}

async function readContact(page, remoteId) {
  return page.evaluate(async (id) => {
    const accounts = await globalThis.__repo.listAccounts();
    const accountId = accounts[0].id;
    const contacts = await globalThis.__repo.listContacts(accountId, { limit: 10_000 });
    const contact = contacts.find((candidate) => candidate.remote_id === id);
    return contact ? globalThis.__repo.getContact(accountId, contact.id) : null;
  }, remoteId);
}

async function selectContactLabel(row, label) {
  await row.locator('.contact-label__summary').click();
  await row.getByRole('menuitemradio', { name: label, exact: true }).click();
}

async function contactResourceRow(section, value) {
  const values = await section.locator('.contact-resource__value')
    .evaluateAll((inputs) => inputs.map((input) => input.value));
  const index = values.indexOf(value);
  expect(index, `resource row for ${value} should exist`).toBeGreaterThanOrEqual(0);
  return section.locator('.contact-resource__row').nth(index);
}

async function pasteImageIntoEditor(page, selector) {
  await page.evaluate(({ base64, editorSelector }) => {
    const editor = document.querySelector(editorSelector);
    if (!(editor instanceof HTMLElement)) throw new Error(`Missing editor: ${editorSelector}`);
    editor.focus();
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'signature.png', { type: 'image/png' }));
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: transfer });
    editor.dispatchEvent(event);
  }, { base64: PNG_BASE64, editorSelector: selector });
}

async function draftBySubject(jmap, mailboxId, subject) {
  const queried = await jmapRequest(jmap, [[
    'Email/query',
    {
      accountId: jmap.accountId,
      filter: { inMailbox: mailboxId },
      sort: [{ property: 'receivedAt', isAscending: false }],
      limit: 100,
    },
    'q',
  ]]);
  const ids = pickResponse(queried, 'Email/query')?.ids ?? [];
  if (ids.length === 0) return null;
  const result = await jmapRequest(jmap, [[
    'Email/get',
    {
      accountId: jmap.accountId,
      ids,
      properties: [
        'id', 'subject', 'from', 'bcc', 'mailboxIds', 'bodyStructure',
        'attachments', 'htmlBody', 'bodyValues',
      ],
      bodyProperties: [
        'partId', 'blobId', 'type', 'name', 'disposition', 'cid', 'subParts',
      ],
      fetchHTMLBodyValues: true,
    },
    'g',
  ]]);
  return (pickResponse(result, 'Email/get')?.list ?? [])
    .find((email) => email.subject === subject) ?? null;
}

function draftHtml(draft) {
  const htmlPart = draft?.htmlBody?.[0];
  return htmlPart ? draft.bodyValues?.[htmlPart.partId]?.value ?? '' : '';
}

function inlineParts(part) {
  if (!part) return [];
  return [
    ...(part.disposition === 'inline' ? [part] : []),
    ...(part.subParts ?? []).flatMap((child) => inlineParts(child)),
  ];
}

test.describe('Contact and identity integrity', () => {
  test.beforeEach(async ({ sharedPage: page }) => {
    // A case here may leave the app in the Contacts space, and the shared
    // session is shared with every other spec in the lane.
    await page.getByRole('button', { name: 'Mail', exact: true }).click().catch(() => {});
    await waitForShellReady(page);
  });

  test('round-trips a complete contact through UI, cache, and RFC 9553 wire data', async ({
    sharedPage: page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const jmap = await connectJmap();
    const stamp = Date.now();
    const name = `${DETAIL_CONTACT_PREFIX} ${stamp}`;
    const workEmail = `work-${stamp}@${CONTACT_DOMAIN}`;
    const middleEmail = `middle-${stamp}@${CONTACT_DOMAIN}`;
    const editedMiddleEmail = `middle-edited-${stamp}@${CONTACT_DOMAIN}`;
    const homeEmail = `home-${stamp}@${CONTACT_DOMAIN}`;
    let cardId = null;

    try {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.getByRole('button', { name: 'Contacts', exact: true }).click();
      const contacts = page.locator('.contacts');
      await expect(contacts).toBeVisible({ timeout: 30_000 });
      await expect(contacts).toHaveAttribute('data-layout', 'desktop');

      await page.getByRole('button', { name: 'New Contact' }).click();
      const form = page.locator('.contact-detail__editor');
      await expect(form.getByLabel('Full or display name')).toBeFocused();
      await form.getByLabel('Full or display name').fill(name);

      const phones = form.locator('fieldset.contact-resource').filter({ hasText: 'Phone numbers' });
      await phones.getByRole('button', { name: 'Add phone' }).click();
      const phoneRow = phones.locator('.contact-resource__row');
      await selectContactLabel(phoneRow, 'Work');
      await phoneRow.getByLabel('Phone numbers value').fill('tel:+15550123');

      const websites = form.locator('fieldset.contact-resource').filter({ hasText: 'Websites' });
      await websites.getByRole('button', { name: 'Add website' }).click();
      const websiteRow = websites.locator('.contact-resource__row');
      await selectContactLabel(websiteRow, 'Personal');
      await websiteRow.getByLabel('Websites value').fill('https://example.com/contact-integrity');

      await form.getByRole('button', { name: 'Add date' }).click();
      await form.getByLabel('Contact date').fill('1985-07-13');
      await form.getByRole('button', { name: 'Add note' }).click();
      await form.getByLabel('Contact note').fill('Created without an email address.');

      await form.getByRole('button', { name: 'Add work' }).click();
      const affiliation = form.locator('.contact-affiliations__card');
      await affiliation.getByLabel('Organization').fill('Example Industries');
      await affiliation.getByLabel('Department').fill('Research');
      await affiliation.getByLabel('Job title').fill('Principal Engineer');
      await affiliation.getByLabel('Role').fill('Reviewer');
      await form.getByRole('button', { name: 'Save contact' }).click();
      await expect(page.locator('.contact-detail').getByRole('heading', { name })).toBeVisible();
      await waitForPendingMutations(page);

      await expect.poll(async () => {
        const matches = (await listCards(jmap))
          .filter((card) => card.name?.full === name);
        cardId = matches[0]?.id ?? null;
        return matches.length;
      }, {
        timeout: 30_000,
        message: 'the email-less contact should be unique on the server',
      }).toBe(1);

      let card = await getCard(jmap, cardId);
      expect(Object.keys(card?.emails ?? {}), 'the first saved card is email-less').toEqual([]);
      const phoneEntry = Object.entries(card.phones ?? {})[0];
      expect(phoneEntry?.[1]).toMatchObject({
        '@type': 'Phone',
        number: 'tel:+15550123',
        contexts: { work: true },
      });
      const websiteEntry = Object.entries(card.links ?? {})[0];
      expect(websiteEntry?.[1]).toMatchObject({
        '@type': 'Link',
        uri: 'https://example.com/contact-integrity',
        contexts: { private: true },
      });
      const anniversaryEntry = Object.entries(card.anniversaries ?? {})[0];
      expect(anniversaryEntry?.[1]).toMatchObject({
        '@type': 'Anniversary',
        kind: 'birth',
        date: { '@type': 'PartialDate', year: 1985, month: 7, day: 13 },
      });
      const noteEntry = Object.entries(card.notes ?? {})[0];
      expect(noteEntry?.[1]).toMatchObject({
        '@type': 'Note',
        note: 'Created without an email address.',
      });
      const organizationEntry = Object.entries(card.organizations ?? {})[0];
      expect(organizationEntry?.[1]).toMatchObject({
        '@type': 'Organization',
        name: 'Example Industries',
        contexts: { work: true },
        units: [{ '@type': 'OrgUnit', name: 'Research' }],
      });
      const organizationId = organizationEntry[0];
      expect(Object.values(card.titles ?? {})).toEqual(expect.arrayContaining([
        expect.objectContaining({
          '@type': 'Title',
          kind: 'title',
          name: 'Principal Engineer',
          organizationId,
        }),
        expect.objectContaining({
          '@type': 'Title',
          kind: 'role',
          name: 'Reviewer',
          organizationId,
        }),
      ]));

      let cached = await readContact(page, cardId);
      expect(cached).toMatchObject({
        remote_id: cardId,
        full_name: name,
        emails: [],
        phones: [{
          mapKey: phoneEntry[0],
          position: 0,
          value: 'tel:+15550123',
          label: null,
          contexts: ['work'],
          features: [],
          pref: null,
        }],
        links: [{
          mapKey: websiteEntry[0],
          position: 0,
          value: 'https://example.com/contact-integrity',
          label: null,
          contexts: ['private'],
          pref: null,
        }],
        anniversaries: [{
          mapKey: anniversaryEntry[0],
          position: 0,
          kind: 'birth',
          date: { kind: 'partial', year: 1985, month: 7, day: 13 },
        }],
        notes: [{
          mapKey: noteEntry[0],
          position: 0,
          value: 'Created without an email address.',
        }],
        organizations: [{
          mapKey: organizationId,
          position: 0,
          name: 'Example Industries',
          contexts: ['work'],
          units: [{ position: 0, value: 'Research' }],
        }],
      });
      expect(cached.titles).toEqual(expect.arrayContaining([
        expect.objectContaining({
          position: 0,
          value: 'Principal Engineer',
          kind: 'title',
          organizationMapKey: organizationId,
        }),
        expect.objectContaining({
          position: 1,
          value: 'Reviewer',
          kind: 'role',
          organizationMapKey: organizationId,
        }),
      ]));

      await page.locator('.contact-detail').getByRole('button', { name: 'Edit' }).click();
      const emailSection = form.locator('fieldset.contact-resource').filter({ hasText: 'Email addresses' });
      for (const [address, label] of [
        [workEmail, 'Work'],
        [middleEmail, 'Custom'],
        [homeEmail, 'Home'],
      ]) {
        await emailSection.getByRole('button', { name: 'Add email' }).click();
        const row = emailSection.locator('.contact-resource__row').last();
        await selectContactLabel(row, label);
        if (label === 'Custom') {
          await row.getByLabel('Custom email label').fill('Community');
        }
        await row.getByLabel('Email addresses value').fill(address);
      }
      await form.getByRole('button', { name: 'Save contact' }).click();
      await expect(form).toHaveCount(0, { timeout: 30_000 });
      await waitForPendingMutations(page);

      card = await getCard(jmap, cardId);
      const entriesByAddress = new Map(
        Object.entries(card.emails ?? {}).map(([key, value]) => [value.address, { key, value }]),
      );
      expect(entriesByAddress.get(workEmail)?.value).toMatchObject({
        '@type': 'EmailAddress',
        contexts: { work: true },
        pref: 1,
      });
      expect(entriesByAddress.get(middleEmail)?.value).toMatchObject({
        '@type': 'EmailAddress',
        label: 'Community',
      });
      expect(entriesByAddress.get(homeEmail)?.value).toMatchObject({
        '@type': 'EmailAddress',
        contexts: { private: true },
      });
      const middleKey = entriesByAddress.get(middleEmail)?.key;
      expect(middleKey).toBeTruthy();

      cached = await readContact(page, cardId);
      expect(cached.emails).toEqual([
        expect.objectContaining({
          mapKey: entriesByAddress.get(workEmail)?.key,
          value: workEmail,
          contexts: ['work'],
          pref: 1,
          isPreferred: true,
        }),
        expect.objectContaining({
          mapKey: middleKey,
          value: middleEmail,
          label: 'Community',
          contexts: [],
          pref: null,
        }),
        expect.objectContaining({
          mapKey: entriesByAddress.get(homeEmail)?.key,
          value: homeEmail,
          contexts: ['private'],
          pref: null,
        }),
      ]);

      await patchCard(jmap, cardId, { 'name/x-integrity-unknown': 'keep-me' });
      await page.locator('.contact-detail').getByRole('button', { name: 'Edit' }).click();
      const middleRow = await contactResourceRow(emailSection, middleEmail);
      await middleRow
        .getByLabel('Email addresses value')
        .fill(editedMiddleEmail);
      await form.getByRole('button', { name: 'Save contact' }).click();
      await expect(form).toHaveCount(0, { timeout: 30_000 });
      await waitForPendingMutations(page);

      card = await getCard(jmap, cardId);
      expect(card.name?.['x-integrity-unknown']).toBe('keep-me');
      expect(card.emails?.[middleKey]?.address).toBe(editedMiddleEmail);
      expect(card.emails?.[middleKey]?.label).toBe('Community');
      cached = await readContact(page, cardId);
      expect(cached.emails.find((email) => email.mapKey === middleKey)?.value)
        .toBe(editedMiddleEmail);

      await page.locator('.contact-detail').getByRole('button', { name: 'Edit' }).click();
      const editedMiddleRow = await contactResourceRow(emailSection, editedMiddleEmail);
      await editedMiddleRow
        .getByRole('button', { name: 'Remove email' })
        .click();
      await form.getByRole('button', { name: 'Save contact' }).click();
      await expect(form).toHaveCount(0, { timeout: 30_000 });
      await waitForPendingMutations(page);

      card = await getCard(jmap, cardId);
      expect(card.name?.['x-integrity-unknown']).toBe('keep-me');
      expect(card.emails).not.toHaveProperty(middleKey);
      expect(Object.values(card.emails ?? {}).map((email) => email.address).sort())
        .toEqual([workEmail, homeEmail].sort());
      cached = await readContact(page, cardId);
      expect(cached.emails.map((email) => email.value).sort()).toEqual([workEmail, homeEmail].sort());

      await page.setViewportSize({ width: 900, height: 820 });
      await expect(contacts).toHaveAttribute('data-layout', 'tablet');
      await page.setViewportSize({ width: 600, height: 820 });
      await expect(contacts).toHaveAttribute('data-layout', 'phone');
      const back = page.getByRole('button', { name: 'Back' });
      await back.click();
      const list = page.getByRole('listbox', { name: 'Contacts' });
      await expect(list).toBeFocused();
      await list.press('Enter');
      await expect(page.locator('.contact-detail').getByRole('heading', { name })).toBeFocused();

      await page.locator('.contact-detail').getByRole('button', { name: 'Edit' }).click();
      await form.getByLabel('Contact note').fill('Unsaved focus check');
      await back.click();
      const confirmation = page.getByRole('alertdialog', { name: 'Save your changes?' });
      await expect(confirmation).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(confirmation).toHaveCount(0);
      await expect(back).toBeFocused();
      await expect(form.getByLabel('Contact note')).toHaveValue('Unsaved focus check');
      await form.getByRole('button', { name: 'Cancel' }).click();
      await expect(list).toBeFocused();
      await list.press('Enter');

      await page.locator('.contact-detail')
        .getByRole('button', { name: 'Delete', exact: true })
        .click();
      await page.getByRole('alertdialog')
        .getByRole('button', { name: 'Delete', exact: true })
        .click();
      await waitForPendingMutations(page);
      await expect.poll(async () => getCard(jmap, cardId), {
        timeout: 30_000,
        message: 'the exact card should be deleted from the server',
      }).toBeNull();
      await expect.poll(async () => readContact(page, cardId), {
        timeout: 30_000,
        message: 'the exact card should be deleted from the cache',
      }).toBeNull();
      cardId = null;
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {});
      if (cardId) await destroyCard(jmap, cardId);
    }
  });

  test('persists identity defaults and a marker-free CID draft across all three legs', async ({
    sharedPage: page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const drafts = mailboxByRole(mailboxes, 'drafts');
    if (!drafts) throw new Error('Drafts mailbox is required');
    const stamp = Date.now();
    const alias = `${ALIAS_PREFIX}-defaults-${stamp}@example.org`;
    const replyTo = `reply-${stamp}@example.org`;
    const automaticBcc = `automatic-bcc-${stamp}@example.org`;
    const manualBcc = `manual-bcc-${stamp}@example.org`;
    const identityName = `Integrity Alias ${stamp}`;
    const editedIdentityName = `${identityName} Edited`;
    const signatureText = `Integrity signature ${stamp}`;
    const subject = `${DETAIL_DRAFT_PREFIX} ${stamp}`;
    let identityId = null;
    let draftId = null;

    try {
      await patchPrincipalEmails('addItem', alias);
      await page.getByRole('button', { name: 'Contacts', exact: true }).click();
      await expect(page.locator('.contacts')).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Manage identities' }).click();
      await page.getByRole('button', { name: 'Add identity' }).click();

      const form = page.locator('.identity-detail__editor');
      await expect(form.getByLabel('Display name', { exact: true })).toBeFocused();
      await form.getByLabel('Display name', { exact: true }).fill(identityName);
      await form.getByLabel('Email', { exact: true }).fill(alias);
      await form.getByRole('button', { name: 'Add Reply-To address' }).click();
      await form.getByLabel('Reply-To display name 1').fill('Reply Desk');
      await form.getByLabel('Reply-To email 1').fill(replyTo);
      await form.getByRole('button', { name: 'Add Bcc address' }).click();
      await form.getByLabel('Bcc display name 1').fill('Archive');
      await form.getByLabel('Bcc email 1').fill(automaticBcc);

      const signature = form.locator('.editor[contenteditable][aria-label="Identity signature"]');
      await signature.click();
      await page.keyboard.type(signatureText);
      await pasteImageIntoEditor(
        page,
        '.identity-detail__editor .editor[contenteditable][aria-label="Identity signature"]',
      );
      await expect(signature.locator('img[src^="data:image/png;base64,"]')).toHaveCount(1);
      await form.getByRole('button', { name: 'Save identity' }).click();
      await expect(form).toHaveCount(0, { timeout: 30_000 });

      let wireIdentity;
      await expect.poll(async () => {
        wireIdentity = await directIdentity(jmap, alias);
        identityId = wireIdentity?.id ?? null;
        return wireIdentity;
      }, {
        timeout: 30_000,
        message: 'the UI-created identity should exist on the server',
      }).toMatchObject({
        name: identityName,
        email: alias,
        replyTo: [{ name: 'Reply Desk', email: replyTo }],
        bcc: [{ name: 'Archive', email: automaticBcc }],
        mayDelete: true,
      });
      expect(wireIdentity.htmlSignature).toContain(signatureText);
      expect(wireIdentity.htmlSignature).toContain(`data:image/png;base64,${PNG_BASE64}`);
      expect(wireIdentity.textSignature).toContain(signatureText);

      let localIdentity = await cachedIdentity(page, alias);
      expect(localIdentity).toMatchObject({
        remote_id: identityId,
        name: identityName,
        email: alias,
        reply_to: [{ name: 'Reply Desk', email: replyTo }],
        bcc: [{ name: 'Archive', email: automaticBcc }],
        may_delete: 1,
      });
      expect(localIdentity.html_signature).toContain(`data:image/png;base64,${PNG_BASE64}`);
      expect(localIdentity.text_signature).toContain(signatureText);

      const identityRow = page.locator('.contacts__row').filter({ hasText: alias });
      await identityRow.click();
      await page.locator('.identity-detail')
        .getByRole('button', { name: 'Edit', exact: true })
        .click();
      await form.getByLabel('Display name', { exact: true }).fill(editedIdentityName);
      await form.getByRole('button', { name: 'Save identity' }).click();
      await expect(form).toHaveCount(0, { timeout: 30_000 });
      await expect.poll(async () => (await directIdentity(jmap, alias))?.name, {
        timeout: 30_000,
        message: 'the identity edit should reach the server',
      }).toBe(editedIdentityName);
      await expect.poll(async () => (await cachedIdentity(page, alias))?.name, {
        timeout: 30_000,
        message: 'the identity edit should reach the cache',
      }).toBe(editedIdentityName);
      await expect(identityRow).toContainText(editedIdentityName, { timeout: 30_000 });

      await page.getByRole('button', { name: 'Mail', exact: true }).click();
      await page.keyboard.press('ControlOrMeta+n');
      const composer = page.locator('.compose-dialog--expanded');
      await expect(composer).toBeVisible({ timeout: 10_000 });
      await waitForIdentities(page);
      const picker = composer.locator('[data-compose-from]');
      const chooseIdentity = async (address) => {
        await picker.locator('summary').click();
        await picker.locator('.app-dropdown__item').filter({ hasText: address }).click();
      };

      await chooseIdentity(alias);
      await expect(picker.locator('summary')).toContainText(alias);
      await expect.poll(() => recipientAddresses(page, 'Bcc'), {
        timeout: 10_000,
        message: 'selecting the identity should insert its automatic Bcc',
      }).toEqual([automaticBcc]);
      const editor = composer.locator('.editor[contenteditable]').first();
      await expect(editor).toContainText(signatureText);
      const origin = editor.locator('[data-stormbox-origin="identity-signature"]');
      await expect(origin).toHaveCount(1);
      await expect(origin.locator('img[src^="data:image/png;base64,"]')).toHaveCount(1);

      await fillRecipient(page, 'Bcc', manualBcc);
      expect((await recipientAddresses(page, 'Bcc')).sort())
        .toEqual([automaticBcc, manualBcc].sort());
      await chooseIdentity(STACK_STALWART_PRINCIPAL);
      await expect.poll(() => recipientAddresses(page, 'Bcc'), {
        timeout: 10_000,
        message: 'switching From should keep manual Bcc and remove the old automatic Bcc',
      }).toEqual([manualBcc]);
      await expect(editor).not.toContainText(signatureText);

      await chooseIdentity(alias);
      await expect.poll(async () => (await recipientAddresses(page, 'Bcc')).sort(), {
        timeout: 10_000,
        message: 'switching back should restore defaults without replacing manual Bcc',
      }).toEqual([automaticBcc, manualBcc].sort());
      await expect(editor).toContainText(signatureText);
      await expect(origin).toHaveCount(1);

      await fillRecipient(page, 'To', STACK_STALWART_PRINCIPAL);
      await composeSubject(page).fill(subject);
      await editor.click();
      await page.keyboard.press('ControlOrMeta+Home');
      await page.keyboard.type('Manual draft body. ');
      const editorHtml = await editor.innerHTML();
      expect(editorHtml.indexOf('Manual draft body.')).toBeGreaterThanOrEqual(0);
      expect(editorHtml.indexOf('Manual draft body.')).toBeLessThan(editorHtml.indexOf(signatureText));

      await saveDraftAndClose(page);
      await expect(composer).toHaveCount(0, { timeout: 30_000 });
      await waitForPendingMutations(page);

      let savedDraft;
      await expect.poll(async () => {
        savedDraft = await draftBySubject(jmap, drafts.id, subject);
        draftId = savedDraft?.id ?? draftId;
        return savedDraft;
      }, {
        timeout: 30_000,
        message: 'the identity-default draft should exist on the server',
      }).not.toBeNull();
      expect(savedDraft.from).toEqual([{ name: editedIdentityName, email: alias }]);
      expect(savedDraft.bcc.map((address) => address.email).sort())
        .toEqual([automaticBcc, manualBcc].sort());
      const html = draftHtml(savedDraft);
      expect(html).toContain('Manual draft body.');
      expect(html).toContain(signatureText);
      expect(html).not.toContain('data-stormbox-');
      expect(html).not.toContain('data:image/');
      const imagePart = inlineParts(savedDraft.bodyStructure)
        .find((part) => part.type === 'image/png');
      expect(imagePart).toMatchObject({
        type: 'image/png',
        disposition: 'inline',
      });
      expect(imagePart.blobId).toBeTruthy();
      expect(imagePart.cid).toBeTruthy();
      expect(html).toContain(`cid:${imagePart.cid}`);

      let localDraft;
      await expect.poll(async () => {
        localDraft = await page.evaluate(async (remoteId) => {
          const accounts = await globalThis.__repo.listAccounts();
          return globalThis.__repo.getMessageByRemote(accounts[0].id, remoteId);
        }, draftId);
        return localDraft;
      }, {
        timeout: 30_000,
        message: 'the saved draft should be represented in the local repository',
      }).not.toBeNull();
      expect(localDraft).toMatchObject({
        remote_id: draftId,
        subject,
        is_draft: 1,
      });
      const localRaw = JSON.parse(localDraft.raw_json);
      expect(localRaw.from).toEqual([{ name: editedIdentityName, email: alias }]);
      expect(localRaw.bcc.map((address) => address.email).sort())
        .toEqual([automaticBcc, manualBcc].sort());

      await clickFolder(page, drafts.name);
      await expectRowSoon(page, subject);
      await page.locator('.msg-list__item').filter({ hasText: subject }).first().click();
      await expect(composer).toBeVisible({ timeout: 30_000 });
      await expect(composeSubject(page)).toHaveValue(subject);
      expect((await recipientAddresses(page, 'Bcc')).sort())
        .toEqual([automaticBcc, manualBcc].sort());
      await expect(editor).toContainText('Manual draft body.');
      await expect(editor).toContainText(signatureText);
      await expect(editor.locator('[data-stormbox-origin]')).toHaveCount(0);
      expect((await editor.textContent()).split(signatureText)).toHaveLength(2);
      await expect(editor.locator('img')).toHaveCount(1);

      await discardCompose(page);
      await waitForPendingMutations(page);
      await expect.poll(async () => draftBySubject(jmap, drafts.id, subject), {
        timeout: 30_000,
        message: 'discarding the reopened draft should delete the server artifact',
      }).toBeNull();
      draftId = null;

      await page.getByRole('button', { name: 'Contacts', exact: true }).click();
      await page.getByRole('button', { name: 'Manage identities' }).click();
      await page.locator('.contacts__row').filter({ hasText: alias }).click();
      const deleteIdentity = page.locator('.identity-detail')
        .getByRole('button', { name: 'Delete', exact: true });
      await expect(deleteIdentity).toBeEnabled();
      await deleteIdentity.click();
      await page.getByRole('alertdialog')
        .getByRole('button', { name: 'Delete', exact: true })
        .click();
      await expect.poll(async () => directIdentity(jmap, alias), {
        timeout: 30_000,
        message: 'identity deletion should reach the server',
      }).toBeNull();
      await expect.poll(async () => cachedIdentity(page, alias), {
        timeout: 30_000,
        message: 'identity deletion should reach the cache',
      }).toBeNull();
      identityId = null;
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      if (await page.locator('.compose-dialog--expanded').count()) {
        await discardCompose(page).catch(() => {});
      }
      if (draftId) await destroyEmails(jmap, [draftId]).catch(() => {});
      if (identityId) await identitySet(jmap, { destroy: [identityId] }).catch(() => {});
      await patchPrincipalEmails('removeItem', alias).catch(() => {});
    }
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

      await aliasRow.click();
      await page.locator('.identity-detail')
        .getByRole('button', { name: 'Edit', exact: true })
        .click();
      await form.locator('input[type="text"]').fill('Alias E2E Updated');
      await form.getByRole('button', { name: 'Save identity' }).click();
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
      await page.locator('.contacts__row').filter({ hasText: alias }).click();
      await page.locator('.identity-detail')
        .getByRole('button', { name: 'Delete', exact: true })
        .click();
      await page.getByRole('alertdialog')
        .getByRole('button', { name: 'Delete', exact: true })
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
      await page.getByRole('button', { name: 'New Contact' }).click();
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
