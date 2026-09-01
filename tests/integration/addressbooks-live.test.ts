import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';

import { DB_RPC } from '../../src/db/protocol';
import {
  inventoryAddressBook,
  syncAddressBooks,
  syncContacts,
} from '../../src/sync/backends/jmap/contacts';
import { MUTATION_TYPES } from '../../src/sync/backends/jmap/outbox';
import type {
  AddressBookInventory,
  AddressbookRow,
} from '../../src/types';
import {
  callMethod,
  CONTACTS_USING,
  createLiveIntegrationContext,
  processInsertedMutation,
} from './helpers/live-jmap';

describe.sequential('live Stalwart address book management', () => {
  const prefix = `Stormbox address book ${randomUUID()}`;
  let context: Awaited<ReturnType<typeof createLiveIntegrationContext>>;
  const contactIds = new Set<string>();

  function contacts(name: string, args: Record<string, unknown>, callId: string) {
    return callMethod(context.transport, CONTACTS_USING, name, {
      accountId: context.account.remote_account_id,
      ...args,
    }, callId);
  }

  async function remoteBooks(ids?: string[]): Promise<any[]> {
    const result = await contacts('AddressBook/get', {
      ...(ids ? { ids } : {}),
      properties: [
        'id',
        'name',
        'description',
        'sortOrder',
        'isDefault',
        'isSubscribed',
        'myRights',
      ],
    }, 'books');
    return result.list ?? [];
  }

  async function cleanup(): Promise<void> {
    if (contactIds.size > 0) {
      await contacts('ContactCard/set', { destroy: [...contactIds] }, 'cleanup-cards');
      contactIds.clear();
    }
    const bookIds = (await remoteBooks())
      .filter((book) => String(book.name ?? '').startsWith(prefix))
      .map((book) => book.id);
    if (bookIds.length > 0) {
      await contacts('AddressBook/set', {
        destroy: bookIds,
        onDestroyRemoveContents: true,
      }, 'cleanup-books');
    }
  }

  /**
   * Fails the test on a rejected write and returns its result. Rows stay
   * in pending_mutations: this suite never drains by status.
   */
  async function runMutation(
    mutationType: string,
    request: Record<string, unknown>,
  ): Promise<any> {
    const outcome = await processInsertedMutation(context, {
      mutationType,
      request,
      deleteOnSuccess: false,
    });
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    return outcome.result;
  }

  async function createBook(name: string): Promise<AddressbookRow> {
    const result = await runMutation(MUTATION_TYPES.CREATE_ADDRESSBOOK, {
      operationId: randomUUID(),
      name,
      description: 'Created by the focused live suite',
      isSubscribed: true,
      setAsDefault: false,
    });
    return result.addressbook;
  }

  async function createCard(
    name: string,
    addressBookIds: string[],
  ): Promise<string> {
    const result = await contacts('ContactCard/set', {
      create: {
        card: {
          '@type': 'Card',
          version: '1.0',
          kind: 'individual',
          uid: randomUUID(),
          name: { full: name },
          addressBookIds: Object.fromEntries(
            addressBookIds.map((id) => [id, true]),
          ),
        },
      },
    }, 'create-card');
    const id = result.created?.card?.id;
    if (typeof id !== 'string' || !id) {
      throw new Error(`ContactCard/set returned no id: ${JSON.stringify(result)}`);
    }
    contactIds.add(id);
    return id;
  }

  beforeAll(async () => {
    context = await createLiveIntegrationContext();
    await cleanup();
    await syncAddressBooks(context);
  });

  afterAll(async () => {
    await cleanup();
    await context.engine.close();
  });

  it('round-trips metadata and default changes', async () => {
    const created = await createBook(`${prefix} metadata`);

    const updated = await runMutation(MUTATION_TYPES.UPDATE_ADDRESSBOOK, {
      operationId: randomUUID(),
      addressbookId: created.id,
      description: 'Updated description',
      setAsDefault: true,
    });
    expect(updated.addressbook).toMatchObject({
      remote_id: created.remote_id,
      description: 'Updated description',
      is_default: 1,
    });
    expect((await remoteBooks([created.remote_id]))[0]).toMatchObject({
      description: 'Updated description',
      isDefault: true,
    });
  });

  it('deletes exclusive cards while preserving shared cards and memberships', async () => {
    const target = await createBook(`${prefix} delete`);
    const other = (await remoteBooks()).find(
      (book) => book.id !== target.remote_id
        && !String(book.name ?? '').startsWith(prefix),
    );
    if (!other) throw new Error('No retained address book is available');

    const exclusiveId = await createCard(
      `${prefix} exclusive`,
      [target.remote_id],
    );
    const sharedId = await createCard(
      `${prefix} shared`,
      [target.remote_id, other.id],
    );
    await syncContacts(context);

    const confirmed: AddressBookInventory = await inventoryAddressBook({
      transport: context.transport,
      account: context.account,
      handlers: context.handlers,
      addressbookId: target.id,
    });
    expect(confirmed).toMatchObject({
      total: 2,
      exclusiveCount: 1,
      sharedCount: 1,
    });

    await runMutation(MUTATION_TYPES.DESTROY_ADDRESSBOOK, {
      operationId: randomUUID(),
      addressbookId: target.id,
      confirmationInventory: confirmed,
    });
    contactIds.delete(exclusiveId);

    expect(await remoteBooks([target.remote_id])).toEqual([]);
    const cards = await contacts('ContactCard/get', {
      ids: [exclusiveId, sharedId],
    }, 'verify-cards');
    expect(cards.notFound).toContain(exclusiveId);
    expect(cards.list).toHaveLength(1);
    expect(cards.list[0]).toMatchObject({
      id: sharedId,
      addressBookIds: { [other.id]: true },
    });

    const localContacts = await context.handlers[DB_RPC.CONTACT_LIST]({
      accountId: context.account.id,
    });
    expect(localContacts.some((contact) => contact.remote_id === exclusiveId))
      .toBe(false);
    expect(localContacts.find((contact) => contact.remote_id === sharedId)
      ?.addressbook_ids).toHaveLength(1);
  });
});
