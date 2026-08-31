import {
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

const TEST_PREFIX = 'Address book management e2e';

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

async function listBooks(jmap) {
  const response = await contactsRequest(jmap, [[
    'AddressBook/get',
    {
      accountId: jmap.accountId,
      properties: [
        'id',
        'name',
        'description',
        'isDefault',
        'isSubscribed',
      ],
    },
    'book-get',
  ]]);
  const result = responseFor(response, 'AddressBook/get');
  if (!result) throw new Error(JSON.stringify(response));
  return result.list ?? [];
}

async function cleanupBooks(jmap) {
  const ids = (await listBooks(jmap))
    .filter((book) => String(book.name ?? '').startsWith(TEST_PREFIX))
    .map((book) => book.id);
  if (ids.length === 0) return;
  await contactsRequest(jmap, [[
    'AddressBook/set',
    {
      accountId: jmap.accountId,
      destroy: ids,
      onDestroyRemoveContents: true,
    },
    'book-cleanup',
  ]]).catch(() => {});
}

async function goToContacts(page) {
  await page.getByRole('button', { name: 'Contacts', exact: true }).click();
  await expect(page.locator('.contacts')).toBeVisible({ timeout: 30_000 });
}

test('Firefox smoke exposes ordered address-book controls', async ({
  browserName,
  sharedPage: page,
}) => {
  test.skip(browserName !== 'firefox', 'Firefox-only smoke coverage');
  await waitForShellReady(page);
  await goToContacts(page);

  const create = page.getByRole('button', { name: 'Create address book' });
  const newContact = page.getByRole('button', { name: 'New Contact' });
  await expect(create).toBeEnabled();
  await expect(newContact).toBeVisible();
  expect(await create.evaluate((button, contactButton) =>
    Boolean(button.compareDocumentPosition(contactButton)
      & Node.DOCUMENT_POSITION_FOLLOWING), await newContact.elementHandle()))
    .toBe(true);

  const concrete = page.locator('.contacts-rail__book')
    .filter({ hasNotText: 'All contacts' })
    .filter({ hasNotText: 'Trash' })
    .filter({ hasNotText: 'Manage identities' })
    .first();
  await concrete.click();
  await expect(page.locator('.directory-list__addressbook-actions')
    .getByRole('button', { name: 'Edit address book' })).toBeVisible();
  await expect(page.locator('.directory-list__addressbook-actions')
    .getByRole('button', { name: 'Delete address book' })).toBeVisible();
});

test('Chromium manages metadata and confirms permanent deletion', async ({
  browserName,
  sharedPage: page,
}) => {
  test.skip(browserName !== 'chromium', 'Chromium carries the full UI flow');
  const jmap = await connectJmap();
  const name = `${TEST_PREFIX} ${Date.now()}`;
  try {
    await cleanupBooks(jmap);
    await waitForShellReady(page);
    await goToContacts(page);

    await page.getByRole('button', { name: 'Create address book' }).click();
    const form = page.locator('.address-book-detail__editor');
    await expect(form).toBeVisible();
    await form.getByLabel('Name').fill(name);
    await form.getByLabel(/Description/).fill('Initial description');
    await form.getByRole('button', { name: 'Save address book' }).click();
    await waitForPendingMutations(page);
    await expect(page.locator('.address-book-detail__display-name'))
      .toHaveText(name);

    const headerActions = page.locator('.directory-list__addressbook-actions');
    await headerActions.getByRole('button', { name: 'Edit address book' }).click();
    await form.getByLabel(/Description/).fill('Updated description');
    await form.getByLabel('Set as default').check();
    await form.getByRole('button', { name: 'Save address book' }).click();
    await waitForPendingMutations(page);

    const railBook = page.locator('.contacts-rail__book').filter({ hasText: name });
    await expect(railBook).toContainText('Personal');
    await expect.poll(async () => (await listBooks(jmap))
      .find((book) => book.name === name)).toMatchObject({
      description: 'Updated description',
      isDefault: true,
    });

    await headerActions.getByRole('button', { name: 'Delete address book' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('0 contacts belong only to this address book');
    await expect(dialog).toContainText('server will choose a replacement default');
    await dialog.getByRole('button', { name: 'Delete address book' }).click();
    await waitForPendingMutations(page);
    await expect(railBook).toHaveCount(0);
    await expect.poll(async () => (await listBooks(jmap))
      .some((book) => book.name === name)).toBe(false);
  } finally {
    await cleanupBooks(jmap);
  }
});
