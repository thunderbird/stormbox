import {
  attachConsoleTail,
  consoleLinesFor,
  expect,
  test,
} from './helpers/shared-session.js';
import { connectJmap } from './helpers/jmap-client.js';
import {
  localStackEnabled,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import {
  waitForPendingMutations,
  waitForShellReady,
} from './helpers/ui.js';

test.skip(!localStackEnabled, skipLocalStackMessage);

const TEST_PREFIX = 'Contact actions e2e';
const TEST_DOMAIN = 'contact-actions-e2e.example';

async function contactsRequest(jmap, methodCalls) {
  const response = await fetch(jmap.apiUrl, {
    method: 'POST',
    headers: {
      Authorization: jmap.authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      using: [
        'urn:ietf:params:jmap:core',
        'urn:ietf:params:jmap:contacts',
      ],
      methodCalls,
    }),
  });
  if (!response.ok) {
    throw new Error(`contacts JMAP failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function responseFor(payload, method) {
  return payload.methodResponses?.find((response) => response[0] === method)?.[1] ?? null;
}

async function createBook(jmap, name) {
  const payload = await contactsRequest(jmap, [[
    'AddressBook/set',
    {
      accountId: jmap.accountId,
      create: { book: { name } },
    },
    'book-set',
  ]]);
  const set = responseFor(payload, 'AddressBook/set');
  const id = set?.created?.book?.id;
  expect(id, `address book create should succeed: ${JSON.stringify(set)}`).toBeTruthy();
  return id;
}

async function destroyBooks(jmap, ids) {
  if (ids.length === 0) return;
  await contactsRequest(jmap, [[
    'AddressBook/set',
    { accountId: jmap.accountId, destroy: ids },
    'book-destroy',
  ]]).catch(() => {});
}

async function createCard(jmap, {
  addressBookIds,
  email,
  name,
}) {
  const payload = await contactsRequest(jmap, [[
    'ContactCard/set',
    {
      accountId: jmap.accountId,
      create: {
        card: {
          '@type': 'Card',
          version: '1.0',
          addressBookIds: Object.fromEntries(
            addressBookIds.map((id) => [id, true]),
          ),
          name: { full: name },
          emails: {
            primary: {
              '@type': 'EmailAddress',
              address: email,
            },
          },
        },
      },
    },
    'card-set',
  ]]);
  const set = responseFor(payload, 'ContactCard/set');
  const id = set?.created?.card?.id;
  expect(id, `contact create should succeed: ${JSON.stringify(set)}`).toBeTruthy();
  return id;
}

async function destroyCards(jmap, ids) {
  if (ids.length === 0) return;
  await contactsRequest(jmap, [[
    'ContactCard/set',
    { accountId: jmap.accountId, destroy: ids },
    'card-destroy',
  ]]).catch(() => {});
}

async function cardsById(jmap, ids) {
  const payload = await contactsRequest(jmap, [[
    'ContactCard/get',
    { accountId: jmap.accountId, ids },
    'card-get',
  ]]);
  const get = responseFor(payload, 'ContactCard/get');
  return {
    list: get?.list ?? [],
    notFound: get?.notFound ?? [],
  };
}

async function resyncContacts(page) {
  await page.evaluate(async () => {
    const accounts = await globalThis.__repo.listAccounts();
    const accountId = accounts[0].id;
    await globalThis.__repo.ensureAddressbooks(accountId);
    await globalThis.__repo.ensureContacts(accountId);
  });
}

async function goToContacts(page) {
  await page.getByRole('button', { name: 'Contacts', exact: true }).click();
  await expect(page.locator('.contacts')).toBeVisible({ timeout: 30_000 });
}

function railBook(page, name) {
  return page.locator('.contacts-rail__book').filter({ hasText: name });
}

function contactRow(page, email) {
  return page.locator('.contacts__row').filter({ hasText: email });
}

async function cachedDirectoryState(page) {
  return page.evaluate(async () => {
    const accounts = await globalThis.__repo.listAccounts();
    const accountId = accounts[0].id;
    const [addressbooks, contacts] = await Promise.all([
      globalThis.__repo.listAddressbooks(accountId),
      globalThis.__repo.listContacts(accountId, { limit: 10_000 }),
    ]);
    return { addressbooks, contacts };
  });
}

async function clearContactFilter(page) {
  const filter = page.getByRole('searchbox', {
    name: /Filter contacts or identities/i,
  });
  if (await filter.count()) await filter.fill('');
}

test.describe('Contact list actions', () => {
  test.beforeEach(async ({ sharedPage: page }) => {
    await page.getByRole('button', { name: 'Mail', exact: true }).click().catch(() => {});
    await waitForShellReady(page);
  });

  test('multi-select drag moves cards and preserves a third membership', async ({
    sharedPage: page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const jmap = await connectJmap();
    const stamp = Date.now();
    const names = {
      source: `${TEST_PREFIX} source ${stamp}`,
      target: `${TEST_PREFIX} target ${stamp}`,
      third: `${TEST_PREFIX} third ${stamp}`,
    };
    const bookIds = [];
    const cardIds = [];
    try {
      const source = await createBook(jmap, names.source);
      const target = await createBook(jmap, names.target);
      const third = await createBook(jmap, names.third);
      bookIds.push(source, target, third);
      for (const index of [1, 2]) {
        cardIds.push(await createCard(jmap, {
          addressBookIds: [source, third],
          email: `drag-${stamp}-${index}@${TEST_DOMAIN}`,
          name: `${TEST_PREFIX} drag ${stamp} ${index}`,
        }));
      }

      await resyncContacts(page);
      await goToContacts(page);
      await railBook(page, names.source).click();
      const first = contactRow(page, `drag-${stamp}-1@${TEST_DOMAIN}`);
      const second = contactRow(page, `drag-${stamp}-2@${TEST_DOMAIN}`);
      await expect(first).toBeVisible();
      await first.locator('input[type="checkbox"]').click();
      await second.locator('input[type="checkbox"]').click();
      await expect(page.locator('.selectable-list-header')).toContainText('2 selected');

      await first.dragTo(railBook(page, names.target));
      await waitForPendingMutations(page);

      await expect.poll(async () => {
        const { list } = await cardsById(jmap, cardIds);
        return list.every((card) =>
          card.addressBookIds?.[target] === true
          && card.addressBookIds?.[third] === true
          && card.addressBookIds?.[source] !== true);
      }, {
        timeout: 30_000,
        message: 'both cards should move while retaining their third membership',
      }).toBe(true);
      await expect.poll(async () => {
        const state = await cachedDirectoryState(page);
        const books = new Map(state.addressbooks.map((book) => [book.remote_id, book.id]));
        return state.contacts
          .filter((contact) => cardIds.includes(contact.remote_id))
          .every((contact) =>
            contact.addressbook_ids.includes(books.get(target))
            && contact.addressbook_ids.includes(books.get(third))
            && !contact.addressbook_ids.includes(books.get(source)));
      }, {
        timeout: 30_000,
        message: 'the local cache should match the moved server memberships',
      }).toBe(true);
      await expect(first).toHaveCount(0);
      await expect(second).toHaveCount(0);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await destroyCards(jmap, cardIds);
      await destroyBooks(jmap, bookIds);
    }
  });

  test('Space selection and the Move menu provide the keyboard/touch path', async ({
    sharedPage: page,
  }, testInfo) => {
    const jmap = await connectJmap();
    const stamp = Date.now();
    const sourceName = `${TEST_PREFIX} menu source ${stamp}`;
    const targetName = `${TEST_PREFIX} menu target ${stamp}`;
    const email = `menu-${stamp}@${TEST_DOMAIN}`;
    const bookIds = [];
    const cardIds = [];
    let toggledTheme = false;
    try {
      const source = await createBook(jmap, sourceName);
      const target = await createBook(jmap, targetName);
      bookIds.push(source, target);
      cardIds.push(await createCard(jmap, {
        addressBookIds: [source],
        email,
        name: `${TEST_PREFIX} menu ${stamp}`,
      }));

      await resyncContacts(page);
      await goToContacts(page);
      await railBook(page, sourceName).click();
      const row = contactRow(page, email);
      await row.click();
      await page.locator('[role="listbox"]').press('Space');
      await expect(page.locator('.selectable-list-header')).toContainText('1 selected');

      const listSurface = page.locator('.directory-list');
      const lightBackground = await listSurface.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      );
      await page.getByRole('button', { name: /Switch to (dark|light) mode/ }).click();
      toggledTheme = true;
      await expect.poll(() => listSurface.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      )).not.toBe(lightBackground);

      await page.getByRole('button', { name: 'Move', exact: true }).click();
      await page.getByRole('menuitem', { name: targetName, exact: true }).click();
      await waitForPendingMutations(page);

      await expect.poll(async () => {
        const { list } = await cardsById(jmap, cardIds);
        return list[0]?.addressBookIds?.[target] === true
          && list[0]?.addressBookIds?.[source] !== true;
      }, { timeout: 30_000 }).toBe(true);
    } finally {
      if (toggledTheme) {
        await page.getByRole('button', { name: /Switch to (dark|light) mode/ })
          .click()
          .catch(() => {});
      }
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await destroyCards(jmap, cardIds);
      await destroyBooks(jmap, bookIds);
    }
  });

  test('named-book deletion removes membership and destroys only final cards', async ({
    sharedPage: page,
  }, testInfo) => {
    const jmap = await connectJmap();
    const stamp = Date.now();
    const sourceName = `${TEST_PREFIX} delete source ${stamp}`;
    const otherName = `${TEST_PREFIX} delete other ${stamp}`;
    const bookIds = [];
    const cardIds = [];
    try {
      const source = await createBook(jmap, sourceName);
      const other = await createBook(jmap, otherName);
      bookIds.push(source, other);
      const finalEmail = `final-${stamp}@${TEST_DOMAIN}`;
      const sharedEmail = `shared-${stamp}@${TEST_DOMAIN}`;
      const finalCard = await createCard(jmap, {
        addressBookIds: [source],
        email: finalEmail,
        name: `${TEST_PREFIX} final ${stamp}`,
      });
      const sharedCard = await createCard(jmap, {
        addressBookIds: [source, other],
        email: sharedEmail,
        name: `${TEST_PREFIX} shared ${stamp}`,
      });
      cardIds.push(finalCard, sharedCard);

      await resyncContacts(page);
      await goToContacts(page);
      await railBook(page, sourceName).click();
      const list = page.locator('[role="listbox"]');
      await expect(list.getByRole('option')).toHaveCount(2);
      await list.focus();
      await list.press('ControlOrMeta+a');
      await expect(page.locator('.selectable-list-header')).toContainText('2 selected');
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText(`removed from ${sourceName}`);
      await expect(dialog).toContainText(
        '1 selected contact currently has no other address-book membership',
      );
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await waitForPendingMutations(page);

      await expect.poll(async () => {
        const result = await cardsById(jmap, cardIds);
        const shared = result.list.find((card) => card.id === sharedCard);
        return {
          finalMissing: result.notFound.includes(finalCard),
          sharedOther: shared?.addressBookIds?.[other] === true,
          sharedSource: shared?.addressBookIds?.[source] === true,
        };
      }, { timeout: 30_000 }).toEqual({
        finalMissing: true,
        sharedOther: true,
        sharedSource: false,
      });
      await expect.poll(async () => {
        const state = await cachedDirectoryState(page);
        return state.contacts.filter((contact) =>
          cardIds.includes(contact.remote_id)).length;
      }, { timeout: 30_000 }).toBe(1);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await destroyCards(jmap, cardIds);
      await destroyBooks(jmap, bookIds);
    }
  });

  test('All contacts warns and permanently deletes the selected card', async ({
    sharedPage: page,
  }, testInfo) => {
    const jmap = await connectJmap();
    const stamp = Date.now();
    const firstName = `${TEST_PREFIX} global first ${stamp}`;
    const secondName = `${TEST_PREFIX} global second ${stamp}`;
    const email = `global-${stamp}@${TEST_DOMAIN}`;
    const bookIds = [];
    const cardIds = [];
    try {
      const first = await createBook(jmap, firstName);
      const second = await createBook(jmap, secondName);
      bookIds.push(first, second);
      const cardId = await createCard(jmap, {
        addressBookIds: [first, second],
        email,
        name: `${TEST_PREFIX} global ${stamp}`,
      });
      cardIds.push(cardId);

      await resyncContacts(page);
      await goToContacts(page);
      await clearContactFilter(page);
      await railBook(page, 'All contacts').click();
      const filter = page.getByRole('searchbox', {
        name: /Filter contacts or identities/i,
      });
      await filter.fill(email);
      const row = contactRow(page, email);
      await expect(row).toBeVisible();
      await row.locator('input[type="checkbox"]').click();
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText('Permanently delete this contact');
      await expect(dialog).toContainText('from all address books');
      await expect(dialog).toBeFocused();
      await expect(dialog.getByRole('button', { name: 'Cancel' })).not.toBeFocused();
      await expect.poll(() => dialog.evaluate(
        (element) => getComputedStyle(element).outlineStyle,
      )).toBe('none');
      await dialog.press('Enter');
      await expect(dialog).toHaveCount(0);
      await expect.poll(async () => {
        const result = await cardsById(jmap, cardIds);
        return result.notFound.includes(cardId);
      }).toBe(false);

      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(dialog).toBeFocused();
      await dialog.getByRole('button', { name: 'Delete permanently' }).click();
      await waitForPendingMutations(page);

      await expect.poll(async () => {
        const result = await cardsById(jmap, [cardId]);
        return result.notFound.includes(cardId);
      }, { timeout: 30_000 }).toBe(true);
      await expect.poll(async () => {
        const state = await cachedDirectoryState(page);
        return state.contacts.some((contact) => contact.remote_id === cardId);
      }, { timeout: 30_000 }).toBe(false);
      await expect(row).toHaveCount(0);
    } finally {
      await clearContactFilter(page).catch(() => {});
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await destroyCards(jmap, cardIds);
      await destroyBooks(jmap, bookIds);
    }
  });
});
