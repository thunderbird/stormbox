import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';

import { DB_RPC } from '../../src/db/protocol';
import {
  deleteContactTrashForever,
} from '../../src/sync/backends/jmap/contacts-trash';
import {
  createContactCard,
  syncAddressBooks,
  syncContacts,
  updateContactCard,
} from '../../src/sync/backends/jmap/contacts';
import {
  CONTACTS_TRASH_FILE_NODE_FOLDER,
  THUNDERMAIL_FILE_NODE_FOLDER,
} from '../../src/sync/backends/jmap/file-node';
import {
  pushSettings,
  SETTINGS_FILE_NAME,
  syncSettingsFromServer,
} from '../../src/sync/backends/jmap/settings';
import {
  runContactBatch,
  runContactTrash,
} from '../../src/sync/backends/jmap/outbox/operations/contacts';
import {
  createContactUid,
  createContactUidFromSeed,
  isContactUid,
} from '../../src/utils/contact-uid';
import { contactMutationFieldsFromDetail } from '../../src/utils/contact-fields';
import { contactDetailFromTrash } from '../../src/utils/contact-trash-display';
import {
  callMethod,
  CONTACTS_USING,
  createLiveIntegrationContext,
  FILE_NODE_USING,
  requireResponseById,
} from './helpers/live-jmap';

const FILE_NODE_PROPERTIES = ['id', 'name', 'parentId', 'blobId', 'type'];

describe.sequential('live Stalwart contacts backend', () => {
  const pngPhotoUri =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const gifPhotoUri =
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
  let context: Awaited<ReturnType<typeof createLiveIntegrationContext>>;
  let writableBookId: string;

  function contacts(name: string, args: Record<string, unknown>, callId: string) {
    return callMethod(context.transport, CONTACTS_USING, name, {
      accountId: context.account.remote_account_id,
      ...args,
    }, callId);
  }

  function files(name: string, args: Record<string, unknown>, callId: string) {
    return callMethod(context.transport, FILE_NODE_USING, name, {
      accountId: context.account.remote_account_id,
      ...args,
    }, callId);
  }

  /** FileNodes matching `filter`, fetched through a query back-reference. */
  async function fileNodes(filter: Record<string, unknown>): Promise<any[]> {
    const response = await context.transport.request([...FILE_NODE_USING], [
      [
        'FileNode/query',
        {
          accountId: context.account.remote_account_id,
          filter,
          calculateTotal: true,
          limit: 500,
        },
        'hierarchy-query',
      ],
      [
        'FileNode/get',
        {
          accountId: context.account.remote_account_id,
          '#ids': {
            resultOf: 'hierarchy-query',
            name: 'FileNode/query',
            path: '/ids',
          },
          properties: FILE_NODE_PROPERTIES,
        },
        'hierarchy-get',
      ],
    ]);
    return requireResponseById(
      response,
      'FileNode/get',
      'hierarchy-get',
    ).list ?? [];
  }

  async function allFileNodes(): Promise<any[]> {
    const result = await files('FileNode/get', {
      properties: FILE_NODE_PROPERTIES,
    }, 'hierarchy-all');
    return result.list ?? [];
  }

  async function expectContactsTrashHierarchy() {
    const allNodes = await allFileNodes();
    const roots = allNodes.filter((node) =>
      node.name === THUNDERMAIL_FILE_NODE_FOLDER && node.parentId == null);
    expect(roots).toHaveLength(1);
    const trashFolders = allNodes.filter((node) =>
      node.name === CONTACTS_TRASH_FILE_NODE_FOLDER
      && node.parentId === roots[0].id);
    expect(trashFolders).toHaveLength(1);
    const trashFiles = (await fileNodes({
      nameMatch: 'stormbox-contacts-trash*.json',
    })).filter((node) =>
      /^stormbox-contacts-trash-[0-9a-f-]{36}\.json$/i.test(node.name));
    expect(trashFiles.length).toBeGreaterThan(0);
    expect(trashFiles.every((node) => node.parentId === trashFolders[0].id)).toBe(true);
    expect(trashFiles.every((node) =>
      node.blobId && node.type === 'application/json')).toBe(true);
  }

  async function destroyTestArtifacts() {
    const cards = await contacts('ContactCard/query', {
      calculateTotal: false,
      limit: 500,
    }, 'cleanup-contact-query');
    if (cards.ids?.length) {
      await contacts('ContactCard/set', { destroy: cards.ids }, 'cleanup-contact-set');
    }

    const fileIds = (await allFileNodes())
      .filter((node) =>
        node.name === SETTINGS_FILE_NAME
        || node.name === 'stormbox-contacts-trash.json'
        || /^stormbox-contacts-trash-[0-9a-f-]{36}\.json$/i.test(node.name))
      .map((node) => node.id);
    if (fileIds.length) {
      await files('FileNode/set', { destroy: fileIds }, 'cleanup-file-set');
    }
  }

  async function remoteCard(remoteId: string): Promise<any | null> {
    const result = await contacts('ContactCard/get', { ids: [remoteId] }, 'get-card');
    return result.list?.[0] ?? null;
  }

  async function localContact(remoteId: string): Promise<any> {
    const contacts = await context.handlers[DB_RPC.CONTACT_LIST]({
      accountId: context.account.id,
    });
    return contacts.find((contact: any) => contact.remote_id === remoteId);
  }

  async function createRawCard(card: Record<string, unknown>): Promise<string> {
    const result = await contacts('ContactCard/set', {
      create: { integration: card },
    }, 'create-raw-card');
    if (result.notCreated?.integration) {
      throw new Error(JSON.stringify(result.notCreated.integration));
    }
    const id = result.created?.integration?.id;
    if (typeof id !== 'string' || !id) {
      throw new Error(`ContactCard/set returned no id: ${JSON.stringify(result)}`);
    }
    return id;
  }

  beforeAll(async () => {
    context = await createLiveIntegrationContext();
    await destroyTestArtifacts();
    const books = await contacts('AddressBook/get', {
      properties: ['id', 'myRights'],
    }, 'get-books');
    writableBookId = books.list?.find(
      (book: any) => book.myRights?.mayWrite === true,
    )?.id;
    if (!writableBookId) throw new Error('Integration account has no writable address book');
    await syncAddressBooks(context);
  });

  afterAll(async () => {
    if (!context) return;
    try {
      await destroyTestArtifacts();
    } finally {
      await context.engine.close();
    }
  });

  it('creates, syncs, and updates a contact through the backend', async () => {
    const uid = createContactUid();
    const email = `create-${crypto.randomUUID()}@integration.test`;
    const updatedEmail = `update-${crypto.randomUUID()}@integration.test`;
    const created = await createContactCard({
      transport: context.transport,
      account: context.account,
      uid,
      emails: [email],
      name: 'Integration Create',
      bookId: writableBookId,
    });
    expect(created).toMatchObject({ ok: true });
    expect(created.id).toEqual(expect.any(String));

    await syncContacts(context);
    expect(await localContact(created.id!)).toMatchObject({
      uid,
      display_name: 'Integration Create',
      email,
    });

    await expect(updateContactCard({
      transport: context.transport,
      account: context.account,
      remoteId: created.id,
      emails: [updatedEmail],
      name: 'Integration Updated',
    })).resolves.toEqual({ ok: true });
    await syncContacts(context);

    expect(await localContact(created.id!)).toMatchObject({
      uid,
      display_name: 'Integration Updated',
      email: updatedEmail,
    });
    expect(await remoteCard(created.id!)).toMatchObject({ uid });
  });

  it('round-trips, duplicates, trashes, and restores a data-URI contact photo', async () => {
    const email = `photo-${crypto.randomUUID()}@integration.test`;
    const contact = {
      fullName: 'Integration Photo',
      emails: [{
        mapKey: 'email',
        position: 0,
        value: email,
        label: null,
        contexts: [],
        pref: 1,
        isPreferred: true,
      }],
      phones: [],
      links: [],
      anniversaries: [],
      notes: [],
      organizations: [],
      titles: [],
      photo: {
        mapKey: 'avatar',
        uri: pngPhotoUri,
        blobId: null,
        mediaType: 'image/png',
        pref: 1,
      },
    };
    const created = await createContactCard({
      transport: context.transport,
      account: context.account,
      uid: createContactUid(),
      contact,
      addressBookIds: [writableBookId],
      allowDuplicate: true,
    });
    expect(created).toMatchObject({ ok: true, id: expect.any(String) });
    await syncContacts(context);

    const local = await localContact(created.id!);
    const detail = await context.handlers[DB_RPC.CONTACT_GET]({
      accountId: context.account.id,
      contactId: local.id,
    });
    expect(local.photo).toMatchObject({ mapKey: 'avatar', uri: pngPhotoUri });
    expect(detail.photo).toMatchObject({ mapKey: 'avatar', uri: pngPhotoUri });

    const replacement = {
      ...contactMutationFieldsFromDetail(detail),
      photo: {
        ...detail.photo,
        uri: gifPhotoUri,
        blobId: null,
        mediaType: 'image/gif',
      },
    };
    await expect(updateContactCard({
      transport: context.transport,
      account: context.account,
      remoteId: created.id,
      baseline: contactMutationFieldsFromDetail(detail),
      contact: replacement,
    })).resolves.toEqual({ ok: true });
    await syncContacts(context);
    expect(await remoteCard(created.id!)).toMatchObject({
      media: { avatar: { kind: 'photo', uri: gifPhotoUri, mediaType: 'image/gif' } },
    });

    const duplicate = await createContactCard({
      transport: context.transport,
      account: context.account,
      uid: createContactUid(),
      contact: { ...replacement, fullName: 'Integration Photo (Copy 1)' },
      addressBookIds: [writableBookId],
      allowDuplicate: true,
    });
    expect(duplicate).toMatchObject({ ok: true, id: expect.any(String) });
    expect(await remoteCard(duplicate.id!)).toMatchObject({
      name: { full: 'Integration Photo (Copy 1)' },
      media: { avatar: { uri: gifPhotoUri } },
    });

    const refreshed = await localContact(created.id!);
    await expect(runContactBatch({
      transport: context.transport,
      account: context.account,
      handlers: context.handlers,
      row: { id: 0 },
      request: {
        operation: 'scoped-delete',
        contactIds: [refreshed.id],
        sourceAddressbookId: null,
      },
      useWebSocket: false,
    })).resolves.toMatchObject({
      ok: true,
      result: { destroyedContactIds: [refreshed.id], failures: [] },
    });
    const [trash] = await context.handlers[DB_RPC.CONTACT_TRASH_LIST]({
      accountId: context.account.id,
    });
    const trashDetail = await context.handlers[DB_RPC.CONTACT_TRASH_GET]({
      accountId: context.account.id,
      trashId: trash.id,
    });
    expect(contactDetailFromTrash(trashDetail).photo)
      .toMatchObject({ mapKey: 'avatar', uri: gifPhotoUri });

    const restored = await runContactTrash({
      transport: context.transport,
      account: context.account,
      handlers: context.handlers,
      row: { id: 0 },
      request: {
        operation: 'restore',
        trashIds: [trash.id],
        destinationAddressbookId: null,
      },
      useWebSocket: false,
    });
    expect(restored).toMatchObject({
      ok: true,
      result: {
        restoredRemoteIds: [expect.any(String)],
        succeededTrashIds: [trash.id],
        failures: [],
      },
    });
    if (!('result' in restored) || !restored.result) {
      throw new Error(`Restore failed: ${JSON.stringify(restored)}`);
    }
    expect(await remoteCard(restored.result.restoredRemoteIds[0])).toMatchObject({
      media: { avatar: { uri: gifPhotoUri, mediaType: 'image/gif' } },
    });
  });

  it('stores the settings document directly under thundermail', async () => {
    await context.handlers[DB_RPC.SETTINGS_APPLY_PATCH]({
      accountId: context.account.id,
      patch: { theme: 'dark' },
    });

    await expect(pushSettings({
      transport: context.transport,
      account: context.account,
      handlers: context.handlers,
    })).resolves.toEqual({ ok: true });

    const allNodes = await allFileNodes();
    const [root] = allNodes.filter((node) =>
      node.name === THUNDERMAIL_FILE_NODE_FOLDER && node.parentId == null);
    expect(root).toBeDefined();
    expect(allNodes.filter((node) => node.name === SETTINGS_FILE_NAME))
      .toEqual([
        expect.objectContaining({
          parentId: root.id,
          type: 'application/json',
        }),
      ]);

    const legacyDocument = {
      owner: 'stormbox',
      documentType: 'user-settings',
      version: 1,
      settings: { theme: 'light', legacyLocation: true },
      updatedAt: {
        theme: Date.now() + 60_000,
        legacyLocation: Date.now() + 60_000,
      },
    };
    const upload = await context.transport.upload({
      accountId: context.account.remote_account_id,
      type: 'application/json',
      body: JSON.stringify(legacyDocument),
    });
    await files('FileNode/set', {
      create: {
        legacy: {
          parentId: null,
          name: SETTINGS_FILE_NAME,
          blobId: upload.blobId,
          type: 'application/json',
        },
      },
    }, 'create-legacy-settings');

    await expect(syncSettingsFromServer({
      transport: context.transport,
      account: context.account,
      handlers: context.handlers,
    })).resolves.toMatchObject({ ok: true, pulled: true, repairQueued: true });
    expect((await allFileNodes()).filter((node) =>
      node.name === SETTINGS_FILE_NAME && node.parentId == null)).toHaveLength(1);

    await expect(pushSettings({
      transport: context.transport,
      account: context.account,
      handlers: context.handlers,
    })).resolves.toEqual({ ok: true });
    expect((await allFileNodes()).filter((node) => node.name === SETTINGS_FILE_NAME))
      .toEqual([
        expect.objectContaining({
          parentId: root.id,
          type: 'application/json',
        }),
      ]);
    expect((await context.handlers[DB_RPC.SETTINGS_GET]({
      accountId: context.account.id,
    })).doc.settings).toMatchObject({
      theme: 'light',
      legacyLocation: true,
    });
  });

  it('repairs a missing uid before trashing and restores the same identity', async () => {
    const email = `legacy-${crypto.randomUUID()}@integration.test`;
    const remoteId = await createRawCard({
      '@type': 'Card',
      version: '1.0',
      kind: 'individual',
      addressBookIds: { [writableBookId]: true },
      name: { full: 'Integration Legacy' },
      emails: {
        email: {
          '@type': 'EmailAddress',
          address: email,
        },
      },
    });
    expect(await remoteCard(remoteId)).not.toHaveProperty('uid');

    await syncContacts(context);
    const local = await localContact(remoteId);
    expect(local).toMatchObject({ uid: null, email });

    const deleted = await runContactBatch({
      transport: context.transport,
      account: context.account,
      handlers: context.handlers,
      row: { id: 0 },
      request: {
        operation: 'scoped-delete',
        contactIds: [local.id],
        sourceAddressbookId: null,
      },
      useWebSocket: false,
    });
    expect(deleted).toMatchObject({
      ok: true,
      result: { destroyedContactIds: [local.id], failures: [] },
    });
    await expectContactsTrashHierarchy();
    expect(await remoteCard(remoteId)).toBeNull();

    const trash = await context.handlers[DB_RPC.CONTACT_TRASH_LIST]({
      accountId: context.account.id,
    });
    expect(trash).toHaveLength(1);
    expect(isContactUid(trash[0].uid)).toBe(true);
    await expect(createContactUidFromSeed(
      `contacts-trash\0${context.account.remote_account_id}\0${remoteId}`,
    )).resolves.toBe(trash[0].uid);

    const restored = await runContactTrash({
      transport: context.transport,
      account: context.account,
      handlers: context.handlers,
      row: { id: 0 },
      request: {
        operation: 'restore',
        trashIds: [trash[0].id],
        destinationAddressbookId: null,
      },
      useWebSocket: false,
    });
    expect(restored).toMatchObject({
      ok: true,
      result: {
        succeededTrashIds: [trash[0].id],
        failures: [],
      },
    });
    if (!('result' in restored) || !restored.result) {
      throw new Error(`Restore failed: ${JSON.stringify(restored)}`);
    }
    expect(restored.result.restoredRemoteIds).toHaveLength(1);
    expect(await remoteCard(restored.result.restoredRemoteIds[0])).toMatchObject({
      uid: trash[0].uid,
      name: { full: 'Integration Legacy' },
    });
    await expect(context.handlers[DB_RPC.CONTACT_TRASH_LIST]({
      accountId: context.account.id,
    })).resolves.toEqual([]);
  });

  it('persists a terminal tombstone when deleting trash forever', async () => {
    const uid = createContactUid();
    const created = await createContactCard({
      transport: context.transport,
      account: context.account,
      uid,
      emails: [`purge-${crypto.randomUUID()}@integration.test`],
      name: 'Integration Purge',
      bookId: writableBookId,
    });
    expect(created).toMatchObject({ ok: true });
    await syncContacts(context);
    const local = await localContact(created.id!);

    await expect(runContactBatch({
      transport: context.transport,
      account: context.account,
      handlers: context.handlers,
      row: { id: 0 },
      request: {
        operation: 'scoped-delete',
        contactIds: [local.id],
        sourceAddressbookId: null,
      },
      useWebSocket: false,
    })).resolves.toMatchObject({
      ok: true,
      result: { destroyedContactIds: [local.id], failures: [] },
    });
    const [trash] = await context.handlers[DB_RPC.CONTACT_TRASH_LIST]({
      accountId: context.account.id,
    });

    await expect(deleteContactTrashForever({
      transport: context.transport,
      account: context.account,
      handlers: context.handlers,
      trashIds: [trash.id],
    })).resolves.toMatchObject({
      succeededTrashIds: [trash.id],
      failures: [],
    });
    const document = await context.handlers[DB_RPC.CONTACT_TRASH_GET_DOCUMENT]({
      accountId: context.account.id,
    });
    expect(document.doc.entries[uid]).toMatchObject({
      status: 'purged',
      snapshot: null,
    });
  });
});
