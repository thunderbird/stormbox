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

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const GIF_BASE64 =
  'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

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

async function cardsById(jmap, ids) {
  const payload = await contactsRequest(jmap, [[
    'ContactCard/get',
    { accountId: jmap.accountId, ids },
    'card-get',
  ]]);
  return responseFor(payload, 'ContactCard/get')?.list ?? [];
}

async function cardIdsForEmail(jmap, email) {
  const queried = await contactsRequest(jmap, [[
    'ContactCard/query',
    {
      accountId: jmap.accountId,
      filter: { email },
      limit: 100,
    },
    'card-query',
  ]]);
  const ids = responseFor(queried, 'ContactCard/query')?.ids ?? [];
  const cards = await cardsById(jmap, ids);
  return cards
    .filter((card) => Object.values(card.emails ?? {})
      .some((entry) => entry?.address === email))
    .map((card) => card.id);
}

async function destroyCards(jmap, ids) {
  if (ids.length === 0) return;
  await contactsRequest(jmap, [[
    'ContactCard/set',
    { accountId: jmap.accountId, destroy: ids },
    'card-destroy',
  ]]).catch(() => {});
}

async function goToContacts(page) {
  await page.getByRole('button', { name: 'Contacts', exact: true }).click();
  await expect(page.locator('.contacts')).toBeVisible({ timeout: 30_000 });
}

function contactRowByName(page, name) {
  return page.locator('.contacts__row').filter({
    has: page.getByText(name, { exact: true }),
  });
}

async function cachedContactsForEmail(page, email) {
  return page.evaluate(async (address) => {
    const accounts = await globalThis.__repo.listAccounts();
    const contacts = await globalThis.__repo.listContacts(accounts[0].id, { limit: 10_000 });
    return contacts.filter((contact) => contact.email === address);
  }, email);
}

test.describe('Contact avatars', () => {
  test.beforeEach(async ({ sharedPage: page }) => {
    await page.getByRole('button', { name: 'Mail', exact: true }).click().catch(() => {});
    await waitForShellReady(page);
  });

  test('uploads, reloads, replaces, and duplicates a contact photo', async ({
    sharedPage: page,
  }) => {
    test.setTimeout(120_000);
    const jmap = await connectJmap();
    const stamp = Date.now();
    const name = `Contact avatar e2e ${stamp}`;
    const email = `avatar-${stamp}@contact-avatar-e2e.example`;
    const filter = page.getByRole('searchbox', {
      name: /Filter contacts or identities/i,
    });
    let remoteIds = [];
    try {
      await goToContacts(page);
      await page.getByRole('button', { name: 'New Contact' }).click();
      const form = page.locator('.contact-detail__editor');
      await form.locator('input[autocomplete="name"]').fill(name);
      await form.locator('input[type="email"]').fill(email);
      await form.locator('input[type="file"]').setInputFiles({
        name: 'avatar.png',
        mimeType: 'image/png',
        buffer: Buffer.from(PNG_BASE64, 'base64'),
      });
      await expect(form.locator('.contact-detail__photo-editor img')).toHaveAttribute(
        'src',
        `data:image/png;base64,${PNG_BASE64}`,
      );
      await form.getByRole('button', { name: 'Save contact' }).click();
      await waitForPendingMutations(page);

      await filter.fill(email);
      const originalRow = page.locator('.contacts__row').filter({ hasText: name });
      await expect(originalRow).toBeVisible();
      await expect(originalRow.locator('.contact-avatar img')).toBeVisible();
      let cached = await cachedContactsForEmail(page, email);
      remoteIds = cached.map((contact) => contact.remote_id).filter(Boolean);
      expect(cached).toHaveLength(1);
      expect(cached[0].photo).toMatchObject({
        uri: `data:image/png;base64,${PNG_BASE64}`,
        mediaType: 'image/png',
      });

      await page.reload();
      await waitForShellReady(page);
      await goToContacts(page);
      await filter.fill(email);
      await expect(page.locator('.contacts__row').filter({ hasText: name })
        .locator('.contact-avatar img')).toBeVisible();

      await page.locator('.contacts__row').filter({ hasText: name }).click();
      await expect(page.locator('.contact-detail__avatar img')).toBeVisible();
      await page.locator('.contact-detail').getByRole('button', { name: 'Edit' }).click();
      await page.locator('.contact-detail__editor input[type="file"]').setInputFiles({
        name: 'avatar.gif',
        mimeType: 'image/gif',
        buffer: Buffer.from(GIF_BASE64, 'base64'),
      });
      await expect(page.locator('.contact-detail__photo-editor img')).toHaveAttribute(
        'src',
        `data:image/gif;base64,${GIF_BASE64}`,
      );
      await page.locator('.contact-detail__editor')
        .getByRole('button', { name: 'Save contact' }).click();
      await expect(page.locator('.contact-detail__editor')).toBeHidden({ timeout: 30_000 });
      await waitForPendingMutations(page);

      cached = await cachedContactsForEmail(page, email);
      remoteIds = cached.map((contact) => contact.remote_id).filter(Boolean);
      expect(cached[0].photo).toMatchObject({
        uri: `data:image/gif;base64,${GIF_BASE64}`,
        mediaType: 'image/gif',
      });
      const [serverCard] = await cardsById(jmap, remoteIds);
      expect(Object.values(serverCard.media)).toContainEqual(expect.objectContaining({
        kind: 'photo',
        uri: `data:image/gif;base64,${GIF_BASE64}`,
        mediaType: 'image/gif',
      }));

      await page.locator('.contact-detail')
        .getByRole('button', { name: 'Duplicate contact' }).click();
      await waitForPendingMutations(page);
      await expect(page.locator('.contact-detail__display-name'))
        .toContainText(`${name} (Copy 1)`);
      cached = await cachedContactsForEmail(page, email);
      remoteIds = cached.map((contact) => contact.remote_id).filter(Boolean);
      expect(cached).toHaveLength(2);
      expect(cached.every((contact) =>
        contact.photo?.uri === `data:image/gif;base64,${GIF_BASE64}`)).toBe(true);

      const original = cached.find((contact) => contact.display_name === name);
      const copy = cached.find((contact) => contact.display_name === `${name} (Copy 1)`);
      expect(original?.remote_id).toBeTruthy();
      expect(copy?.remote_id).toBeTruthy();
      await contactRowByName(page, name).click();
      await page.locator('.contact-detail').getByRole('button', { name: 'Edit' }).click();
      await page.locator('.contact-detail__editor')
        .getByRole('button', { name: 'Remove', exact: true }).click();
      await page.locator('.contact-detail__editor')
        .getByRole('button', { name: 'Save contact' }).click();
      await expect(page.locator('.contact-detail__editor')).toBeHidden({ timeout: 30_000 });
      await waitForPendingMutations(page);

      cached = await cachedContactsForEmail(page, email);
      expect(cached.find((contact) => contact.remote_id === original.remote_id)?.photo).toBeNull();
      expect(cached.find((contact) => contact.remote_id === copy.remote_id)?.photo?.uri)
        .toBe(`data:image/gif;base64,${GIF_BASE64}`);
      const [serverOriginal] = await cardsById(jmap, [original.remote_id]);
      expect(Object.values(serverOriginal.media ?? {})
        .some((entry) => entry?.kind === 'photo')).toBe(false);
    } finally {
      const discoveredIds = await cardIdsForEmail(jmap, email).catch(() => []);
      await destroyCards(jmap, [...new Set([...remoteIds, ...discoveredIds])]);
    }
  });
});
