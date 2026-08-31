import {
  attachConsoleTail,
  consoleLinesFor,
  expect,
  test,
} from './helpers/shared-session.js';
import { connectJmap, downloadBlob } from './helpers/jmap-client.js';
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

async function fileNodeRequest(jmap, methodCalls) {
  const response = await fetch(jmap.apiUrl, {
    method: 'POST',
    headers: {
      Authorization: jmap.authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      using: [
        'urn:ietf:params:jmap:core',
        'urn:ietf:params:jmap:filenode',
      ],
      methodCalls,
    }),
  });
  if (!response.ok) {
    throw new Error(`FileNode JMAP failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function fileNodeByName(jmap, name, parentId) {
  const queried = await fileNodeRequest(jmap, [[
    'FileNode/query',
    {
      accountId: jmap.accountId,
      filter: { name },
    },
    'file-query',
  ]]);
  const ids = responseFor(queried, 'FileNode/query')?.ids ?? [];
  const fetched = await fileNodeRequest(jmap, [[
    'FileNode/get',
    {
      accountId: jmap.accountId,
      ...(ids.length > 0 ? { ids } : {}),
      properties: [
        'id',
        'name',
        'parentId',
        'blobId',
        'type',
        'myRights',
      ],
    },
    'file-get',
  ]]);
  const get = responseFor(fetched, 'FileNode/get');
  const nodes = (get?.list ?? []).filter((node) =>
    node.name === name && (node.parentId ?? null) === parentId);
  expect(nodes, `expected one FileNode named ${name} under ${parentId ?? 'root'}`)
    .toHaveLength(1);
  return { node: nodes[0], state: get.state };
}

async function contactsTrashParentId(jmap) {
  const root = await fileNodeByName(jmap, 'thundermail', null);
  if (!root) return null;
  const trash = await fileNodeByName(jmap, 'contacts_trash', root.node.id);
  return trash?.node.id ?? null;
}

async function readJsonFileNode(jmap, name) {
  const parentId = await contactsTrashParentId(jmap);
  if (!parentId) return { status: 'missing', node: null, document: null };
  const found = await fileNodeByName(jmap, name, parentId);
  if (!found) return { status: 'missing', node: null, document: null };
  const { node, state } = found;
  expect(node?.blobId).toBeTruthy();
  const bytes = await downloadBlob(jmap, {
    blobId: node.blobId,
    type: 'application/json',
    name,
  });
  return {
    status: 'found',
    state,
    node,
    document: JSON.parse(bytes.toString('utf8')),
  };
}

async function contactsTrashFileNames(jmap) {
  const parentId = await contactsTrashParentId(jmap);
  if (!parentId) return [];
  const queried = await fileNodeRequest(jmap, [[
    'FileNode/query',
    {
      accountId: jmap.accountId,
      filter: {
        nameMatch: 'stormbox-contacts-trash*.json',
      },
      limit: 500,
    },
    'trash-files-query',
  ]]);
  const ids = responseFor(queried, 'FileNode/query')?.ids ?? [];
  if (ids.length === 0) return [];
  const fetched = await fileNodeRequest(jmap, [[
    'FileNode/get',
    {
      accountId: jmap.accountId,
      ids,
      properties: ['id', 'name', 'parentId'],
    },
    'trash-files-get',
  ]]);
  return (responseFor(fetched, 'FileNode/get')?.list ?? [])
    .filter((node) =>
      node.parentId === parentId
      && (
        node.name === 'stormbox-contacts-trash.json'
        || /^stormbox-contacts-trash-[0-9a-f-]{36}\.json$/i.test(node.name)
      ))
    .map((node) => node.name);
}

function trashEntryWins(candidate, current) {
  if (!current || candidate.updatedAt !== current.updatedAt) {
    return !current || candidate.updatedAt > current.updatedAt;
  }
  const rank = { trashed: 0, restored: 1, purged: 2 };
  if (candidate.status !== current.status) {
    return rank[candidate.status] > rank[current.status];
  }
  return JSON.stringify(candidate) > JSON.stringify(current);
}

async function readContactsTrashEntry(jmap, uid) {
  let selected = null;
  for (const name of await contactsTrashFileNames(jmap)) {
    const remote = await readJsonFileNode(jmap, name);
    for (const value of Object.values(remote.document?.entries ?? {})) {
      if (value?.uid === uid && trashEntryWins(value, selected)) selected = value;
    }
  }
  return selected;
}

async function uploadJson(jmap, document) {
  const advertised = jmap.session.uploadUrl;
  if (!advertised) throw new Error('JMAP session has no uploadUrl');
  const advertisedOrigin = new URL(advertised).origin;
  const url = advertised
    .replace(advertisedOrigin, new URL(jmap.apiUrl).origin)
    .replace('{accountId}', encodeURIComponent(jmap.accountId));
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: jmap.authHeader,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(document),
  });
  if (!response.ok) {
    throw new Error(`FileNode upload failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function cleanupTrashEntry(page, jmap, uid, fileNamesBefore) {
  const existingNames = new Set(fileNamesBefore);
  const localChanges = [];
  for (const name of await contactsTrashFileNames(jmap)) {
    const remote = await readJsonFileNode(jmap, name);
    const entries = Object.fromEntries(
      Object.entries(remote.document.entries).filter(([, value]) => value?.uid !== uid),
    );
    if (Object.keys(entries).length === Object.keys(remote.document.entries).length) continue;
    const document = { ...remote.document, entries };
    if (Object.keys(entries).length === 0 && !existingNames.has(name)) {
      const destroyed = await fileNodeRequest(jmap, [[
        'FileNode/set',
        {
          accountId: jmap.accountId,
          ifInState: remote.state,
          destroy: [remote.node.id],
        },
        'file-destroy',
      ]]);
      expect(responseFor(destroyed, 'FileNode/set')?.destroyed).toContain(remote.node.id);
      localChanges.push({ name, destroy: true });
      continue;
    }
    const upload = await uploadJson(jmap, document);
    const updated = await fileNodeRequest(jmap, [[
      'FileNode/set',
      {
        accountId: jmap.accountId,
        ifInState: remote.state,
        update: {
          [remote.node.id]: {
            blobId: upload.blobId,
            type: 'application/json',
          },
        },
      },
      'file-update',
    ]]);
    expect(responseFor(updated, 'FileNode/set')?.updated).toHaveProperty(remote.node.id);
    localChanges.push({ name, destroy: false, document });
  }
  await page.evaluate(async ({ entryUid, changes }) => {
    const accounts = await globalThis.__repo.listAccounts();
    const accountId = accounts[0].id;
    const statements = changes.map((change) => change.destroy
      ? {
          sql: 'DELETE FROM contacts_trash_documents WHERE account_id = ? AND shard_name = ?',
          params: [accountId, change.name],
        }
      : {
          sql: `UPDATE contacts_trash_documents
                   SET doc_json = ?, dirty = 0, updated_at = ?
                 WHERE account_id = ? AND shard_name = ?`,
          params: [JSON.stringify(change.document), Date.now(), accountId, change.name],
        });
    statements.push({
      sql: 'DELETE FROM contacts_trash WHERE account_id = ? AND uid = ?',
      params: [accountId, entryUid],
    });
    await globalThis.__repo.call('db.transaction', { statements });
  }, { entryUid: uid, changes: localChanges });
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
  uid = `urn:uuid:${crypto.randomUUID()}`,
}) {
  const payload = await contactsRequest(jmap, [[
    'ContactCard/set',
    {
      accountId: jmap.accountId,
      create: {
        card: {
          '@type': 'Card',
          version: '1.0',
          uid,
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

async function cardsByUid(jmap, uid) {
  const queried = await contactsRequest(jmap, [[
    'ContactCard/query',
    {
      accountId: jmap.accountId,
      filter: { uid },
      limit: 2,
    },
    'card-query',
  ]]);
  const ids = responseFor(queried, 'ContactCard/query')?.ids ?? [];
  return cardsById(jmap, ids);
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

      await page.getByRole('button', { name: 'Move', exact: true }).click();
      await page.getByRole('menuitem', { name: targetName, exact: true }).click();
      await waitForPendingMutations(page);

      await expect.poll(async () => {
        const { list } = await cardsById(jmap, cardIds);
        return list[0]?.addressBookIds?.[target] === true
          && list[0]?.addressBookIds?.[source] !== true;
      }, { timeout: 30_000 }).toBe(true);
    } finally {
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
    const finalUid = `urn:uuid:${crypto.randomUUID()}`;
    const trashFilesBefore = await contactsTrashFileNames(jmap);
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
        uid: finalUid,
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
      await expect.poll(async () => page.evaluate(async () => {
        const rows = await globalThis.__repo.call('db.query', {
          sql: `SELECT local_status, error_json
                  FROM pending_mutations
                 WHERE mutation_type = 'contactBatch'
                 ORDER BY created_at DESC
                 LIMIT 1`,
          params: [],
        });
        return rows.length === 0 ? 'gone' : `${rows[0].local_status}:${rows[0].error_json}`;
      }), { timeout: 30_000 }).toBe('gone');
      await expect(page.locator('.directory-list__notice')).toContainText('deleted');

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

      await railBook(page, 'Trash').click();
      const filter = page.getByRole('searchbox', {
        name: /Filter contacts or identities/i,
      });
      await filter.fill(finalEmail);
      await contactRow(page, finalEmail).click();
      await page.getByRole('button', { name: 'Delete Forever' }).click();
      await page.getByRole('alertdialog')
        .getByRole('button', { name: 'Delete forever' })
        .click();
      await waitForPendingMutations(page);
    } finally {
      await clearContactFilter(page).catch(() => {});
      await cleanupTrashEntry(
        page,
        jmap,
        finalUid,
        trashFilesBefore,
      );
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await destroyCards(jmap, cardIds);
      await destroyBooks(jmap, bookIds);
    }
  });

  test('All contacts can delete and restore through durable Trash', async ({
    sharedPage: page,
  }, testInfo) => {
    const jmap = await connectJmap();
    const stamp = Date.now();
    const uid = `urn:uuid:${crypto.randomUUID()}`;
    const trashFilesBefore = await contactsTrashFileNames(jmap);
    const firstName = `${TEST_PREFIX} global first ${stamp}`;
    const secondName = `${TEST_PREFIX} global second ${stamp}`;
    const destinationName = `${TEST_PREFIX} restore destination ${stamp}`;
    const email = `global-${stamp}@${TEST_DOMAIN}`;
    const bookIds = [];
    const cardIds = [];
    try {
      const first = await createBook(jmap, firstName);
      const second = await createBook(jmap, secondName);
      const destination = await createBook(jmap, destinationName);
      bookIds.push(first, second, destination);
      const cardId = await createCard(jmap, {
        addressBookIds: [first, second],
        email,
        name: `${TEST_PREFIX} global ${stamp}`,
        uid,
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
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await waitForPendingMutations(page);
      await expect.poll(async () => page.evaluate(async () => {
        const rows = await globalThis.__repo.call('db.query', {
          sql: `SELECT local_status, error_json
                  FROM pending_mutations
                 WHERE mutation_type = 'contactBatch'
                 ORDER BY created_at DESC
                 LIMIT 1`,
          params: [],
        });
        return rows.length === 0 ? 'gone' : `${rows[0].local_status}:${rows[0].error_json}`;
      }), { timeout: 30_000 }).toBe('gone');
      await expect(page.locator('.directory-list__notice')).toHaveText('1 contact deleted.');

      await expect.poll(async () => {
        const result = await cardsById(jmap, [cardId]);
        return result.notFound.includes(cardId);
      }, { timeout: 30_000 }).toBe(true);
      await expect.poll(async () => {
        const state = await cachedDirectoryState(page);
        return state.contacts.some((contact) => contact.remote_id === cardId);
      }, { timeout: 30_000 }).toBe(false);
      await expect(row).toHaveCount(0);
      await expect.poll(async () => page.evaluate(async (remoteId) => {
        const accounts = await globalThis.__repo.listAccounts();
        const trash = await globalThis.__repo.listContactTrash(accounts[0].id);
        return trash.some((entry) => entry.prior_remote_id === remoteId);
      }, cardId), { timeout: 30_000 }).toBe(true);
      await expect.poll(async () => {
        return (await readContactsTrashEntry(jmap, uid))?.status ?? null;
      }, { timeout: 30_000 }).toBe('trashed');
      await destroyBooks(jmap, [first, second]);
      await resyncContacts(page);

      await clearContactFilter(page);
      await railBook(page, 'Trash').click();
      await expect(contactRow(page, email)).toBeVisible();
      await contactRow(page, email).click();
      await page.getByRole('button', { name: 'Restore', exact: true }).click();
      const destinationDialog = page.getByRole('dialog', {
        name: 'Choose an address book',
      });
      await expect(destinationDialog).toBeVisible();
      await destinationDialog.getByRole('button', {
        name: destinationName,
        exact: true,
      }).click();
      await waitForPendingMutations(page);
      await expect.poll(async () => page.evaluate(async (entryUid) => {
        const accounts = await globalThis.__repo.listAccounts();
        const trash = await globalThis.__repo.listContactTrash(accounts[0].id);
        return trash.some((entry) => entry.uid === entryUid);
      }, uid), { timeout: 30_000 }).toBe(false);
      await expect(contactRow(page, email)).toHaveCount(0);

      await expect.poll(async () => {
        const result = await cardsByUid(jmap, uid);
        return result.list.length === 1 ? result.list[0] : null;
      }, { timeout: 30_000 }).not.toBeNull();
      const restoredCards = await cardsByUid(jmap, uid);
      expect(restoredCards.list).toHaveLength(1);
      const restoredCard = restoredCards.list[0];
      cardIds.push(restoredCard.id);
      expect(restoredCard.addressBookIds).toMatchObject({
        [destination]: true,
      });
      expect(restoredCard.addressBookIds[first]).toBeUndefined();
      expect(restoredCard.addressBookIds[second]).toBeUndefined();
      await expect.poll(async () => {
        const entry = await readContactsTrashEntry(jmap, uid);
        return entry
          ? {
              status: entry.status,
              snapshot: entry.snapshot,
              media: entry.media,
            }
          : null;
      }, { timeout: 30_000 }).toEqual({
        status: 'restored',
        snapshot: null,
        media: [],
      });

      await railBook(page, 'All contacts').click();
      await filter.fill(email);
      await expect(contactRow(page, email)).toBeVisible();
    } finally {
      await clearContactFilter(page).catch(() => {});
      await cleanupTrashEntry(
        page,
        jmap,
        uid,
        trashFilesBefore,
      );
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await destroyCards(jmap, cardIds);
      await destroyBooks(jmap, bookIds);
    }
  });
});
