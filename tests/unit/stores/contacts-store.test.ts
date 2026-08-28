import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import {
  IDENTITY_ERROR,
} from '../../../src/constants/identity-errors';
import {
  __resetRepositoryForTests,
  __setRepositoryForTests,
} from '../../../src/composables/useRepository';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useContactsStore } from '../../../src/stores/contacts-store';

let mutationErrorType: string | undefined;
let repo: any;

beforeEach(async () => {
  setActivePinia(createPinia());
  const authStore = useAuthStore();
  authStore.accountId = 1;
  mutationErrorType = undefined;
  repo = {
    subscribe: vi.fn(() => () => {}),
    listAddressbooks: vi.fn(async () => []),
    listContacts: vi.fn(async () => []),
    listIdentities: vi.fn(async () => []),
    insertPendingMutation: vi.fn(async () => ({ id: 10 })),
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
