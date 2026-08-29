import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import {
  IDENTITY_ERROR,
} from '../../../src/constants/identity-errors';
import {
  MUTATION_TYPE,
  SERVICE_KIND,
} from '../../../src/constants/states';
import {
  __resetRepositoryForTests,
  __setRepositoryForTests,
} from '../../../src/composables/useRepository';
import { useAuthStore } from '../../../src/stores/auth-store';
import {
  CONTACT_MISSING_MESSAGE,
  useContactsStore,
} from '../../../src/stores/contacts-store';
import type {
  AddressbookRow,
  ContactDetailEmail,
  ContactListRow,
  ContactMutationFields,
  IdentityRow,
} from '../../../src/types';

let mutationErrorType: string | undefined;
let repo: any;

function identity(overrides: Partial<IdentityRow> = {}): IdentityRow {
  return {
    id: overrides.id ?? 1,
    account_id: overrides.account_id ?? 1,
    remote_id: overrides.remote_id ?? 'identity-1',
    name: overrides.name ?? '',
    email: overrides.email ?? 'alias@example.com',
    reply_to_json: overrides.reply_to_json ?? null,
    bcc_json: overrides.bcc_json ?? null,
    text_signature: overrides.text_signature ?? null,
    html_signature: overrides.html_signature ?? null,
    may_delete: overrides.may_delete ?? 1,
    raw_json: overrides.raw_json ?? null,
    updated_at: overrides.updated_at ?? 1,
    reply_to: overrides.reply_to ?? null,
    bcc: overrides.bcc ?? null,
  };
}

function contactFields(
  overrides: Partial<ContactMutationFields> = {},
): ContactMutationFields {
  return {
    fullName: 'Old',
    emails: [],
    phones: [],
    links: [],
    anniversaries: [],
    notes: [],
    organizations: [],
    titles: [],
    ...overrides,
  };
}

function addressbook(
  id: number,
  mayWrite: 0 | 1 | null,
): AddressbookRow {
  return {
    id,
    account_id: 1,
    service_kind: SERVICE_KIND.JMAP_CONTACTS,
    remote_id: `book-${id}`,
    name: `Book ${id}`,
    description: null,
    is_default: id === 1 ? 1 : 0,
    is_subscribed: 1,
    may_write: mayWrite,
    ctag: null,
    sync_token: null,
    raw_json: null,
    is_deleted: 0,
    updated_at: 1,
  };
}

function contact(
  id: number,
  addressbookIds: number[],
): ContactListRow {
  return {
    id,
    remote_id: `card-${id}`,
    addressbook_ids: addressbookIds,
    display_name: `Contact ${id}`,
    email: `contact-${id}@example.com`,
  };
}

beforeEach(async () => {
  setActivePinia(createPinia());
  const authStore = useAuthStore();
  authStore.accountId = 1;
  mutationErrorType = undefined;
  repo = {
    subscribe: vi.fn(() => () => {}),
    listAddressbooks: vi.fn(async () => []),
    listContacts: vi.fn(async () => []),
    getContact: vi.fn(async () => null),
    listIdentities: vi.fn(async () => []),
    insertPendingMutation: vi.fn(async () => ({ id: 10 })),
    ensureIdentityMutation: vi.fn(async () => ({ id: 10, reused: false })),
    runMutation: vi.fn(async () => ({
      attempted: 1,
      succeeded: mutationErrorType ? 0 : 1,
      failed: mutationErrorType ? 1 : 0,
      ...(mutationErrorType ? { errorType: mutationErrorType } : {}),
    })),
  };
  __setRepositoryForTests(repo);
  await useContactsStore().attach();
});

afterEach(() => {
  __resetRepositoryForTests();
  vi.restoreAllMocks();
});

describe('identity action errors', () => {
  it('returns a typed local validation error without queueing a mutation', async () => {
    const store = useContactsStore();

    await expect(store.createIdentity({
      name: 'Alias',
      email: 'not-an-address',
    })).resolves.toEqual({
      ok: false,
      error: IDENTITY_ERROR.INVALID_EMAIL,
    });
    expect(store.error).toBe('Enter a valid email address.');
    expect(repo.insertPendingMutation).not.toHaveBeenCalled();
  });

  it.each([
    [IDENTITY_ERROR.ADDRESS_NOT_ALLOWED, IDENTITY_ERROR.ADDRESS_NOT_ALLOWED],
    ['forbidden', IDENTITY_ERROR.PERMISSION_DENIED],
    ['unknownIdentity', IDENTITY_ERROR.NOT_FOUND],
    ['cacheReconcileFailed', IDENTITY_ERROR.CACHE_RECONCILIATION_FAILED],
    ['serverFail', IDENTITY_ERROR.SERVER_UNAVAILABLE],
    ['forbiddenFrom', IDENTITY_ERROR.ADDRESS_NOT_CONFIGURED],
    ['overQuota', IDENTITY_ERROR.OVER_QUOTA],
    ['tooLarge', IDENTITY_ERROR.OBJECT_TOO_LARGE],
    ['invalidPatch', IDENTITY_ERROR.INVALID_PATCH],
    ['willDestroy', IDENTITY_ERROR.WILL_DESTROY],
    ['singleton', IDENTITY_ERROR.SINGLETON],
    ['invalidArguments', IDENTITY_ERROR.INVALID_ARGUMENTS],
    ['createOutcomeUnknown', IDENTITY_ERROR.AMBIGUOUS_CREATE],
    ['invalidProperties', IDENTITY_ERROR.UNKNOWN],
  ])('maps mutation error %s to %s', async (reported, expected) => {
    mutationErrorType = reported;
    const store = useContactsStore();

    await expect(store.createIdentity({
      name: 'Alias',
      email: 'alias@example.com',
    })).resolves.toEqual({
      ok: false,
      error: expected,
    });
  });

  it('shows the address-not-allowed error as actionable copy', async () => {
    mutationErrorType = IDENTITY_ERROR.ADDRESS_NOT_ALLOWED;
    const store = useContactsStore();

    await store.createIdentity({
      name: 'Alias',
      email: 'alias@example.com',
    });

    expect(store.error).toBe(
      'You can’t send from this email address. Add it to your account before creating an identity.',
    );
  });
});

describe('identity mutation requests', () => {
  it('returns the exact confirmed row when a concurrent refresh adds another identity', async () => {
    const confirmed = identity({
      id: 88,
      remote_id: 'created-identity',
      email: 'new@example.com',
    });
    const unrelated = identity({
      id: 77,
      remote_id: 'concurrent-identity',
      email: 'other@example.com',
    });
    repo.runMutation.mockResolvedValue({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      result: {
        ids: ['created-identity'],
        identity: confirmed,
      },
    });
    repo.listIdentities.mockResolvedValue([unrelated, confirmed]);
    const store = useContactsStore();

    const result = await store.createIdentity({
      operationId: 'stable-create',
      name: '',
      email: 'new@example.com',
    });

    expect(result).toEqual({ ok: true, identity: confirmed });
    const request = JSON.parse(repo.ensureIdentityMutation.mock.calls[0][0].requestJson);
    expect(request).toEqual({
      operationId: 'stable-create',
      name: '',
      email: 'new@example.com',
    });
  });

  it('sends only changed mutable update fields and retains address order', async () => {
    const original = identity({
      remote_id: 'identity-update',
      email: 'fixed@example.com',
    });
    const updated = identity({
      ...original,
      name: '',
      reply_to: null,
      bcc: [
        { name: null, email: 'first@example.com' },
        { name: 'Second', email: 'second@example.com' },
      ],
      bcc_json: JSON.stringify([
        { name: null, email: 'first@example.com' },
        { name: 'Second', email: 'second@example.com' },
      ]),
    });
    const store = useContactsStore();
    store.identities = [original];
    repo.runMutation.mockResolvedValue({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      result: { ids: ['identity-update'], identity: updated },
    });
    repo.listIdentities.mockResolvedValue([updated]);

    const result = await store.updateIdentity({
      operationId: 'stable-update',
      remoteId: 'identity-update',
      name: '',
      replyTo: null,
      bcc: [
        { name: null, email: 'first@example.com' },
        { name: 'Second', email: 'second@example.com' },
      ],
    });

    expect(result).toEqual({ ok: true, identity: updated });
    const request = JSON.parse(repo.ensureIdentityMutation.mock.calls[0][0].requestJson);
    expect(request).toEqual({
      operationId: 'stable-update',
      remoteId: 'identity-update',
      name: '',
      replyTo: null,
      bcc: [
        { name: null, email: 'first@example.com' },
        { name: 'Second', email: 'second@example.com' },
      ],
    });
    expect(request).not.toHaveProperty('email');
    expect(request).not.toHaveProperty('id');
    expect(request).not.toHaveProperty('mayDelete');
  });

  it.each([
    [
      { name: null },
      IDENTITY_ERROR.INVALID_NAME,
    ],
    [
      { replyTo: [{ name: null, email: 'Group: one@example.com;' }] },
      IDENTITY_ERROR.INVALID_REPLY_TO,
    ],
    [
      { bcc: [{ name: null, email: 'not an address' }] },
      IDENTITY_ERROR.INVALID_BCC,
    ],
    [
      {
        htmlSignature: '<img src="data:image/svg+xml;base64,PHN2Zz4=">',
        textSignature: '',
      },
      IDENTITY_ERROR.INVALID_SIGNATURE,
    ],
  ])('rejects invalid identity fields before enqueue', async (fields, expected) => {
    const store = useContactsStore();

    await expect(store.createIdentity({
      email: 'alias@example.com',
      ...fields,
    })).resolves.toEqual({ ok: false, error: expected });
    expect(repo.ensureIdentityMutation).not.toHaveBeenCalled();
  });

  it('enforces the strict 2048-byte signature boundary with multibyte text', async () => {
    const store = useContactsStore();
    const rejected = 'é'.repeat(1024);

    await expect(store.createIdentity({
      email: 'alias@example.com',
      htmlSignature: rejected,
      textSignature: rejected,
    })).resolves.toEqual({
      ok: false,
      error: IDENTITY_ERROR.SIGNATURE_TOO_LARGE,
    });
    expect(repo.ensureIdentityMutation).not.toHaveBeenCalled();
  });

  it('blocks delete when the cached Identity is not server-deletable', async () => {
    const store = useContactsStore();

    await expect(store.deleteIdentity(identity({ may_delete: 0 }))).resolves.toEqual({
      ok: false,
      error: IDENTITY_ERROR.PERMISSION_DENIED,
    });
    expect(repo.ensureIdentityMutation).not.toHaveBeenCalled();
  });

  it('reuses the stable operation after an accepted write needs cache repair', async () => {
    const confirmed = identity({ remote_id: 'created-identity' });
    repo.runMutation
      .mockResolvedValueOnce({
        attempted: 1,
        succeeded: 0,
        failed: 1,
        errorType: IDENTITY_ERROR.CACHE_REPAIR_FAILED,
      })
      .mockResolvedValueOnce({
        attempted: 1,
        succeeded: 1,
        failed: 0,
        result: { ids: ['created-identity'], identity: confirmed },
      });
    repo.listIdentities.mockResolvedValue([confirmed]);
    const store = useContactsStore();
    const input = {
      operationId: 'same-create-operation',
      email: 'alias@example.com',
    };

    await expect(store.createIdentity(input)).resolves.toEqual({
      ok: false,
      error: IDENTITY_ERROR.CACHE_REPAIR_FAILED,
    });
    await expect(store.createIdentity(input)).resolves.toEqual({
      ok: true,
      identity: confirmed,
    });

    expect(repo.ensureIdentityMutation).toHaveBeenCalledTimes(2);
    expect(repo.ensureIdentityMutation.mock.calls.map(([request]) => request.operationId))
      .toEqual(['same-create-operation', 'same-create-operation']);
    expect(repo.insertPendingMutation).not.toHaveBeenCalled();
  });

  it('keeps the operation id for an explicit retry after an exhausted outage', async () => {
    const original = identity({ remote_id: 'identity-outage', name: 'Before' });
    const updated = identity({ ...original, name: 'After' });
    const store = useContactsStore();
    store.identities = [original];
    repo.listIdentities.mockResolvedValue([updated]);
    mutationErrorType = IDENTITY_ERROR.SERVER_UNAVAILABLE;

    await expect(store.updateIdentity({
      remoteId: 'identity-outage',
      name: 'After',
    })).resolves.toEqual({
      ok: false,
      error: IDENTITY_ERROR.SERVER_UNAVAILABLE,
    });

    mutationErrorType = undefined;
    await expect(store.updateIdentity({
      remoteId: 'identity-outage',
      name: 'After',
    })).resolves.toEqual({ ok: true, identity: updated });

    const operationIds = repo.ensureIdentityMutation.mock.calls.map(
      ([request]) => request.operationId,
    );
    expect(operationIds).toHaveLength(2);
    expect(operationIds[1]).toBe(operationIds[0]);
  });

  it('repairs an accepted create before applying changed signature fields', async () => {
    const repaired = identity({
      remote_id: 'created-identity',
      html_signature: '<div>FIRST</div>',
      text_signature: 'FIRST',
    });
    const updated = identity({
      ...repaired,
      html_signature: '<div>SECOND</div>',
      text_signature: 'SECOND',
    });
    repo.ensureIdentityMutation
      .mockResolvedValueOnce({ id: 10, reused: false, requestMatches: true })
      .mockResolvedValueOnce({
        id: 10,
        reused: true,
        requestMatches: false,
        storedRequestJson: JSON.stringify({
          operationId: 'create-operation',
          email: 'alias@example.com',
          htmlSignature: '<div>FIRST</div>',
          textSignature: 'FIRST',
        }),
      })
      .mockResolvedValueOnce({ id: 11, reused: false, requestMatches: true });
    repo.runMutation
      .mockResolvedValueOnce({
        attempted: 1,
        succeeded: 0,
        failed: 1,
        errorType: IDENTITY_ERROR.CACHE_REPAIR_FAILED,
      })
      .mockResolvedValueOnce({
        attempted: 1,
        succeeded: 1,
        failed: 0,
        result: { ids: ['created-identity'], identity: repaired },
      })
      .mockResolvedValueOnce({
        attempted: 1,
        succeeded: 1,
        failed: 0,
        result: { ids: ['created-identity'], identity: updated },
      });
    repo.listIdentities
      .mockResolvedValueOnce([repaired])
      .mockResolvedValueOnce([updated]);
    const store = useContactsStore();

    await expect(store.createIdentity({
      operationId: 'create-operation',
      email: 'alias@example.com',
      htmlSignature: '<div>FIRST</div>',
      textSignature: 'FIRST',
    })).resolves.toEqual({
      ok: false,
      error: IDENTITY_ERROR.CACHE_REPAIR_FAILED,
    });
    await expect(store.createIdentity({
      operationId: 'create-operation',
      email: 'alias@example.com',
      htmlSignature: '<div>SECOND</div>',
      textSignature: 'SECOND',
    })).resolves.toEqual({ ok: true, identity: updated });

    expect(repo.runMutation).toHaveBeenCalledTimes(3);
    const continuation = JSON.parse(
      repo.ensureIdentityMutation.mock.calls[2][0].requestJson,
    );
    expect(continuation).toMatchObject({
      remoteId: 'created-identity',
      htmlSignature: '<div>SECOND</div>',
      textSignature: 'SECOND',
    });
    expect(continuation.operationId).not.toBe('create-operation');
  });

  it('repairs an accepted update before applying changed signature fields', async () => {
    const repaired = identity({
      remote_id: 'identity-1',
      html_signature: '<div>FIRST</div>',
      text_signature: 'FIRST',
    });
    const updated = identity({
      ...repaired,
      html_signature: '<div>SECOND</div>',
      text_signature: 'SECOND',
    });
    repo.ensureIdentityMutation
      .mockResolvedValueOnce({ id: 20, reused: false, requestMatches: true })
      .mockResolvedValueOnce({
        id: 20,
        reused: true,
        requestMatches: false,
        storedRequestJson: JSON.stringify({
          operationId: 'update-operation',
          remoteId: 'identity-1',
          htmlSignature: '<div>FIRST</div>',
          textSignature: 'FIRST',
        }),
      })
      .mockResolvedValueOnce({ id: 21, reused: false, requestMatches: true });
    repo.runMutation
      .mockResolvedValueOnce({
        attempted: 1,
        succeeded: 0,
        failed: 1,
        errorType: IDENTITY_ERROR.CACHE_REPAIR_FAILED,
      })
      .mockResolvedValueOnce({
        attempted: 1,
        succeeded: 1,
        failed: 0,
        result: { ids: ['identity-1'], identity: repaired },
      })
      .mockResolvedValueOnce({
        attempted: 1,
        succeeded: 1,
        failed: 0,
        result: { ids: ['identity-1'], identity: updated },
      });
    repo.listIdentities
      .mockResolvedValueOnce([repaired])
      .mockResolvedValueOnce([updated]);
    const store = useContactsStore();

    await expect(store.updateIdentity({
      operationId: 'update-operation',
      remoteId: 'identity-1',
      htmlSignature: '<div>FIRST</div>',
      textSignature: 'FIRST',
    })).resolves.toEqual({
      ok: false,
      error: IDENTITY_ERROR.CACHE_REPAIR_FAILED,
    });
    await expect(store.updateIdentity({
      operationId: 'update-operation',
      remoteId: 'identity-1',
      htmlSignature: '<div>SECOND</div>',
      textSignature: 'SECOND',
    })).resolves.toEqual({ ok: true, identity: updated });

    expect(repo.runMutation).toHaveBeenCalledTimes(3);
    const continuation = JSON.parse(
      repo.ensureIdentityMutation.mock.calls[2][0].requestJson,
    );
    expect(continuation).toMatchObject({
      remoteId: 'identity-1',
      htmlSignature: '<div>SECOND</div>',
      textSignature: 'SECOND',
    });
    expect(continuation.operationId).not.toBe('update-operation');
  });
});

describe('contact mutation requests', () => {
  it('treats a vanished edit target as terminal instead of temporarily unsynced', async () => {
    repo.getContact.mockResolvedValue(null);
    const store = useContactsStore();

    const result = await store.updateContact({
      contactId: 22,
      baseline: contactFields(),
      contact: {
        fullName: 'Updated',
        emails: [],
        phones: [],
        links: [],
        anniversaries: [],
        notes: [],
        organizations: [],
        titles: [],
      },
    });

    expect(result).toBe(false);
    expect(store.error).toBe(CONTACT_MISSING_MESSAGE);
    expect(repo.insertPendingMutation).not.toHaveBeenCalled();
  });

  it('reports a server-side deletion as the same terminal save result', async () => {
    repo.getContact.mockResolvedValue({
      id: 22,
      remote_id: 'card-22',
      addressbook_ids: [7],
      display_name: 'Old',
      full_name: 'Old',
      emails: [],
      phones: [],
      links: [],
      anniversaries: [],
      notes: [],
      organizations: [],
      titles: [],
    });
    mutationErrorType = 'notFound';
    const store = useContactsStore();

    const result = await store.updateContact({
      contactId: 22,
      baseline: contactFields(),
      contact: {
        fullName: 'Updated',
        emails: [],
        phones: [],
        links: [],
        anniversaries: [],
        notes: [],
        organizations: [],
        titles: [],
      },
    });

    expect(result).toBe(false);
    expect(store.error).toBe(CONTACT_MISSING_MESSAGE);
  });

  it('returns the exact UID-matched cache row when unrelated contacts arrive', async () => {
    repo.listContacts.mockImplementation(async () => {
      const inserted = repo.insertPendingMutation.mock.calls.at(-1)?.[0];
      if (!inserted) return [];
      const { uid } = JSON.parse(inserted.requestJson);
      return [
        {
          id: 77,
          remote_id: 'unrelated',
          uid: 'urn:uuid:00000000-0000-4000-8000-000000000077',
          addressbook_ids: [1],
          display_name: 'Concurrent contact',
          email: null,
        },
        {
          id: 88,
          remote_id: 'created',
          uid: uid.toUpperCase(),
          addressbook_ids: [1],
          display_name: 'Phone only',
          email: null,
        },
      ];
    });
    repo.getContact.mockImplementation(async (_accountId: number, contactId: number) => (
      contactId === 88
        ? {
            id: 88,
            remote_id: 'created',
            addressbook_ids: [1],
            display_name: 'Phone only',
            full_name: 'Phone only',
            emails: [],
            phones: [{
              mapKey: 'phone-1',
              position: 0,
              value: '+1 555 0100',
              label: null,
              contexts: [],
              features: ['voice'],
              pref: null,
            }],
            links: [],
            anniversaries: [],
            notes: [],
            organizations: [],
            titles: [],
          }
        : null
    ));
    const store = useContactsStore();

    const result = await store.createContactResult({
      contact: {
        fullName: 'Phone only',
        emails: [],
        phones: [{
          mapKey: null,
          position: 0,
          value: '+1 555 0100',
          label: null,
          contexts: [],
          features: ['voice'],
          pref: null,
        }],
        links: [],
        anniversaries: [],
        notes: [],
        organizations: [],
        titles: [],
      },
    });

    expect(result).toMatchObject({
      ok: true,
      contactId: 88,
      detail: { id: 88, full_name: 'Phone only' },
    });
  });

  it('uses the confirmed server id when create enriches an existing card', async () => {
    repo.runMutation.mockResolvedValue({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      result: { ids: ['promoted-card'] },
    });
    repo.listContacts.mockResolvedValue([{
      id: 66,
      remote_id: 'promoted-card',
      uid: 'urn:uuid:00000000-0000-4000-8000-000000000066',
      addressbook_ids: [1],
      display_name: 'Promoted',
      email: 'promoted@example.com',
    }]);
    repo.getContact.mockResolvedValue({
      id: 66,
      remote_id: 'promoted-card',
      addressbook_ids: [1],
      display_name: 'Promoted',
      full_name: 'Promoted',
      emails: [],
      phones: [],
      links: [],
      anniversaries: [],
      notes: [],
      organizations: [],
      titles: [],
    });
    const store = useContactsStore();

    const result = await store.createContactResult({
      name: 'Promoted',
      emails: ['promoted@example.com'],
    });

    expect(result).toMatchObject({
      ok: true,
      contactId: 66,
      detail: { id: 66 },
    });
  });

  it('queues an email-less card with a durable uid and stable detail keys', async () => {
    const store = useContactsStore();

    const result = await store.createContact({
      addressbookIds: [7, 8],
      contact: {
        fullName: 'Email Less',
        emails: [],
        phones: [{
          mapKey: null,
          position: 0,
          value: '+1 555 1234',
          label: null,
          contexts: ['work'],
          features: ['voice'],
          pref: null,
        }],
        links: [],
        anniversaries: [],
        notes: [],
        organizations: [],
        titles: [],
      },
    });

    expect(result).toBe(true);
    const inserted = repo.insertPendingMutation.mock.calls[0][0];
    const request = JSON.parse(inserted.requestJson);
    expect(request.uid).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(request.addressbookIds).toEqual([7, 8]);
    expect(request.phones[0].mapKey).toMatch(/^phone-/);
    expect(request.phones[0].value).toBe('+1 555 1234');
  });

  it('rejects a completely empty card before enqueue', async () => {
    const store = useContactsStore();

    const result = await store.createContact({
      contact: {
        fullName: null,
        emails: [],
        phones: [],
        links: [],
        anniversaries: [],
        notes: [],
        organizations: [],
        titles: [],
      },
    });

    expect(result).toBe(false);
    expect(store.error).toBe('Enter at least one contact detail.');
    expect(repo.insertPendingMutation).not.toHaveBeenCalled();
  });

  it('accepts a month-only partial date', async () => {
    const store = useContactsStore();
    const result = await store.createContact({
      contact: {
        fullName: null,
        emails: [],
        phones: [],
        links: [],
        anniversaries: [{
          mapKey: null,
          position: 0,
          kind: 'birth',
          date: { kind: 'partial', year: null, month: 5, day: null },
        }],
        notes: [],
        organizations: [],
        titles: [],
      },
    });

    expect(result).toBe(true);
    const request = JSON.parse(repo.insertPendingMutation.mock.calls[0][0].requestJson);
    expect(request.anniversaries[0]).toMatchObject({
      mapKey: expect.stringMatching(/^date-/),
      date: { kind: 'partial', year: null, month: 5, day: null },
    });
  });

  it('queues an update with the editor-open baseline despite a newer cache row', async () => {
    const baselineEmail: ContactDetailEmail = {
      mapKey: 'email1',
      position: 0,
      value: 'old@example.com',
      label: null,
      contexts: ['work'],
      pref: 1,
      isPreferred: true,
    };
    repo.getContact.mockResolvedValue({
      id: 22,
      remote_id: 'card-22',
      addressbook_ids: [7],
      display_name: 'Changed elsewhere',
      full_name: 'Changed elsewhere',
      emails: [baselineEmail],
      phones: [],
      links: [],
      anniversaries: [],
      notes: [],
      organizations: [],
      titles: [],
    });
    const store = useContactsStore();

    const result = await store.updateContact({
      contactId: 22,
      baseline: contactFields({
        fullName: 'Old',
        emails: [baselineEmail],
      }),
      contact: {
        fullName: 'New',
        emails: [{ ...baselineEmail, value: 'new@example.com', contexts: ['private'] }],
        phones: [],
        links: [],
        anniversaries: [],
        notes: [],
        organizations: [],
        titles: [],
      },
    });

    expect(result).toBe(true);
    const request = JSON.parse(repo.insertPendingMutation.mock.calls[0][0].requestJson);
    expect(request).toMatchObject({
      contactId: 22,
      baseline: {
        fullName: 'Old',
        emails: [{ mapKey: 'email1', value: 'old@example.com' }],
      },
      contact: {
        fullName: 'New',
        emails: [{ mapKey: 'email1', value: 'new@example.com' }],
      },
    });
  });

  it('rejects an update that removes every contact detail', async () => {
    repo.getContact.mockResolvedValue({
      id: 22,
      remote_id: 'card-22',
      addressbook_ids: [7],
      display_name: 'Old',
      full_name: 'Old',
      emails: [],
      phones: [],
      links: [],
      anniversaries: [],
      notes: [],
      organizations: [],
      titles: [],
    });
    const store = useContactsStore();

    const result = await store.updateContact({
      contactId: 22,
      baseline: contactFields(),
      contact: {
        fullName: null,
        emails: [],
        phones: [],
        links: [],
        anniversaries: [],
        notes: [],
        organizations: [],
        titles: [],
      },
    });

    expect(result).toBe(false);
    expect(store.error).toBe('Enter at least one contact detail.');
    expect(repo.insertPendingMutation).not.toHaveBeenCalled();
  });

  it('distinguishes legacy edits from new and reordered email rows', async () => {
    const legacyEmail = (value: string, position: number) => ({
      mapKey: null,
      position,
      value,
      label: null,
      contexts: [],
      pref: null,
      isPreferred: position === 0,
    });
    const first = legacyEmail('typo@example.con', 0);
    const second = legacyEmail('second@example.com', 1);
    repo.getContact.mockResolvedValue({
      id: 22,
      remote_id: 'card-22',
      addressbook_ids: [7],
      display_name: 'Legacy',
      full_name: 'Legacy',
      emails: [first, second],
      phones: [],
      links: [],
      anniversaries: [],
      notes: [],
      organizations: [],
      titles: [],
    });
    const store = useContactsStore();
    const fields = (emails: ReturnType<typeof legacyEmail>[]) => ({
      fullName: 'Legacy',
      emails,
      phones: [],
      links: [],
      anniversaries: [],
      notes: [],
      organizations: [],
      titles: [],
    });

    expect(await store.updateContact({
      contactId: 22,
      baseline: fields([first, second]),
      contact: fields([
        legacyEmail('typo@example.com', 0),
        legacyEmail('second@example.com', 1),
      ]),
    })).toBe(true);
    expect(await store.updateContact({
      contactId: 22,
      baseline: fields([first, second]),
      contact: fields([
        legacyEmail('new@example.com', 0),
        legacyEmail('typo@example.con', 1),
        legacyEmail('second@example.com', 2),
      ]),
    })).toBe(true);
    expect(await store.updateContact({
      contactId: 22,
      baseline: fields([first, second]),
      contact: fields([
        legacyEmail('typo@example.con', 0),
        legacyEmail('second@example.com', 1),
        legacyEmail('new@example.com', 2),
      ]),
    })).toBe(true);
    expect(await store.updateContact({
      contactId: 22,
      baseline: fields([first, second]),
      contact: fields([legacyEmail('second@example.com', 0)]),
    })).toBe(true);

    const requests = repo.insertPendingMutation.mock.calls.map(
      ([args]) => JSON.parse(args.requestJson),
    );
    expect(requests[0].contact.emails.map((email) => email.mapKey)).toEqual([null, null]);
    expect(requests[1].contact.emails).toEqual([
      expect.objectContaining({ value: 'new@example.com', mapKey: expect.stringMatching(/^email-/) }),
      expect.objectContaining({ value: 'typo@example.con', mapKey: null }),
      expect.objectContaining({ value: 'second@example.com', mapKey: null }),
    ]);
    expect(requests[2].contact.emails).toEqual([
      expect.objectContaining({ value: 'typo@example.con', mapKey: null }),
      expect.objectContaining({ value: 'second@example.com', mapKey: null }),
      expect.objectContaining({ value: 'new@example.com', mapKey: expect.stringMatching(/^email-/) }),
    ]);
    expect(requests[3].contact.emails).toEqual([
      expect.objectContaining({ value: 'second@example.com', mapKey: null }),
    ]);
  });

  it('rewrites form-local organization references to minted map keys', async () => {
    const store = useContactsStore();
    const result = await store.createContact({
      contact: {
        fullName: 'Worker',
        emails: [],
        phones: [],
        links: [],
        anniversaries: [],
        notes: [],
        organizations: [{
          mapKey: null,
          formId: 'form-org-1',
          position: 0,
          name: 'Example',
          contexts: ['work'],
          units: [],
        }],
        titles: [{
          mapKey: null,
          position: 0,
          value: 'Engineer',
          kind: 'title',
          organizationMapKey: 'form-org-1',
        }],
      },
    });

    expect(result).toBe(true);
    const request = JSON.parse(repo.insertPendingMutation.mock.calls[0][0].requestJson);
    expect(request.organizations[0].mapKey).toMatch(/^organization-/);
    expect(request.titles[0]).toMatchObject({
      mapKey: expect.stringMatching(/^title-/),
      organizationMapKey: request.organizations[0].mapKey,
    });
  });

  it.each(['title', 'role'] as const)(
    'accepts a %s-only work affiliation with a keyed empty organization',
    async (kind) => {
      const store = useContactsStore();
      const result = await store.createContact({
        contact: {
          fullName: null,
          emails: [],
          phones: [],
          links: [],
          anniversaries: [],
          notes: [],
          organizations: [{
            mapKey: null,
            formId: 'work-only',
            position: 0,
            name: null,
            contexts: ['work'],
            units: [],
          }],
          titles: [{
            mapKey: null,
            position: 0,
            value: kind === 'title' ? 'Engineer' : 'Advisor',
            kind,
            organizationMapKey: null,
            organizationFormId: 'work-only',
          }],
        },
      });

      expect(result).toBe(true);
      const request = JSON.parse(repo.insertPendingMutation.mock.calls[0][0].requestJson);
      expect(request.organizations[0]).toMatchObject({
        mapKey: expect.stringMatching(/^organization-/),
        name: null,
      });
      expect(request.titles[0].organizationMapKey)
        .toBe(request.organizations[0].mapKey);
    },
  );

  it('rejects a title with a dangling organization reference', async () => {
    const store = useContactsStore();
    const result = await store.createContact({
      contact: {
        fullName: 'Worker',
        emails: [],
        phones: [],
        links: [],
        anniversaries: [],
        notes: [],
        organizations: [],
        titles: [{
          mapKey: null,
          position: 0,
          value: 'Engineer',
          kind: 'title',
          organizationMapKey: 'missing-org',
        }],
      },
    });

    expect(result).toBe(false);
    expect(store.error).toBe('Choose a valid organization for each title.');
    expect(repo.insertPendingMutation).not.toHaveBeenCalled();
  });

  it('edits a cached title whose server organization is not exposed', async () => {
    const cachedTitle = {
      mapKey: 'hidden-title',
      position: 0,
      value: 'Old role',
      kind: 'role' as const,
      organizationMapKey: null,
    };
    repo.getContact.mockResolvedValue({
      id: 22,
      remote_id: 'card-22',
      addressbook_ids: [7],
      display_name: 'Worker',
      full_name: 'Worker',
      emails: [],
      phones: [],
      links: [],
      anniversaries: [],
      notes: [],
      organizations: [],
      titles: [cachedTitle],
    });
    const store = useContactsStore();

    const result = await store.updateContact({
      contactId: 22,
      baseline: contactFields({
        fullName: 'Worker',
        titles: [cachedTitle],
      }),
      contact: {
        fullName: 'Worker',
        emails: [],
        phones: [],
        links: [],
        anniversaries: [],
        notes: [],
        organizations: [],
        titles: [{ ...cachedTitle, value: 'New role' }],
      },
    });

    expect(result).toBe(true);
    const request = JSON.parse(repo.insertPendingMutation.mock.calls[0][0].requestJson);
    expect(request.baseline.titles[0].organizationMapKey).toBeNull();
    expect(request.contact.titles[0]).toMatchObject({
      value: 'New role',
      organizationMapKey: null,
    });
  });
});

describe('contact batch mutation requests', () => {
  it('denies missing write rights before queueing', async () => {
    const store = useContactsStore();
    store.addressbooks = [addressbook(1, null)];
    store.contacts = [contact(1, [1])];

    const result = await store.deleteContacts([1], 1);

    expect(result).toMatchObject({
      ok: false,
      succeededContactIds: [],
      failures: [{ contactId: 1, errorType: 'permissionDenied' }],
    });
    expect(repo.insertPendingMutation).not.toHaveBeenCalled();
    expect(store.contacts).toHaveLength(1);
  });

  it('queues only local ids and replaces optimistic move state from the cache', async () => {
    const store = useContactsStore();
    const original = contact(1, [1, 3]);
    const authoritative = contact(1, [2, 3]);
    store.addressbooks = [
      addressbook(1, 1),
      addressbook(2, 1),
      addressbook(3, 1),
    ];
    store.contacts = [original];
    repo.runMutation.mockResolvedValue({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      result: {
        succeededContactIds: [1],
        updatedContactIds: [1],
        destroyedContactIds: [],
        failures: [],
      },
    });
    repo.listContacts.mockResolvedValue([authoritative]);

    const result = await store.moveContacts([1, 1], 1, 2);

    expect(result).toEqual({
      ok: true,
      succeededContactIds: [1],
      updatedContactIds: [1],
      destroyedContactIds: [],
      failures: [],
    });
    expect(repo.insertPendingMutation).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 1,
      mutationType: MUTATION_TYPE.CONTACT_BATCH,
      targetMessageId: null,
    }));
    expect(JSON.parse(repo.insertPendingMutation.mock.calls[0][0].requestJson)).toEqual({
      operation: 'move',
      contactIds: [1],
      sourceAddressbookId: 1,
      targetAddressbookId: 2,
    });
    expect(store.contacts).toEqual([authoritative]);
    expect(store.movingIds).toEqual([]);
  });

  it('returns per-contact terminal failures alongside accepted cards', async () => {
    const store = useContactsStore();
    const first = contact(1, [1]);
    const second = contact(2, [1, 2]);
    store.addressbooks = [addressbook(1, 1), addressbook(2, 1)];
    store.contacts = [first, second];
    repo.runMutation.mockResolvedValue({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      result: {
        succeededContactIds: [1],
        updatedContactIds: [],
        destroyedContactIds: [1],
        failures: [{ contactId: 2, errorType: 'forbidden' }],
      },
    });
    repo.listContacts.mockResolvedValue([second]);

    const result = await store.deleteContacts([1, 2], null);

    expect(result).toEqual({
      ok: false,
      succeededContactIds: [1],
      updatedContactIds: [],
      destroyedContactIds: [1],
      failures: [{ contactId: 2, errorType: 'forbidden' }],
    });
    expect(store.contacts).toEqual([second]);
    expect(store.error).toContain('1 contact updated; 1 could not be updated');
  });
});
