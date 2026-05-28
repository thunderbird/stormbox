// @vitest-environment happy-dom

import {
  describe, it, expect, beforeEach, vi,
} from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

// services/auth.js calls oidcEarlyInit({ BASE_URL: '/' }) at module
// load and throws under happy-dom unless the OIDC bootstrap is stubbed.
vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

// Inject a fake repository so logout can dispatch stopSyncAccount
// without needing a real shared worker.
import {
  __setRepositoryForTests,
  __resetRepositoryForTests,
} from '../../../src/composables/useRepository';
import { useAuthStore } from '../../../src/stores/auth-store';
import { AUTH_STATE } from '../../../src/constants/states';

function makeRepo() {
  return {
    subscribe() { return () => {}; },
    stopSyncAccount: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  __resetRepositoryForTests();
});

describe('auth-store', () => {
  it('logout clears in-memory account state and quota (R-1.4)', async () => {
    const repo = makeRepo();
    __setRepositoryForTests(repo);
    const authStore = useAuthStore();

    // Simulate the post-connect snapshot.
    authStore.status = AUTH_STATE.CONNECTED;
    authStore.accountId = 42;
    authStore.username = 'tester@example.com';
    authStore.error = 'previous transient';
    authStore.quotaUsedBytes = 1024;
    authStore.quotaHardLimitBytes = 1024 * 1024;

    await authStore.logout();

    expect(repo.stopSyncAccount).toHaveBeenCalledWith(42);
    expect(authStore.status).toBe(AUTH_STATE.IDLE);
    expect(authStore.accountId).toBeNull();
    expect(authStore.username).toBeNull();
    expect(authStore.error).toBeNull();
    expect(authStore.quotaUsedBytes).toBeNull();
    expect(authStore.quotaHardLimitBytes).toBeNull();
    expect(authStore.hasStorageQuota).toBe(false);
  });

  it('logout still resets local state even when stopSyncAccount throws (defensive teardown)', async () => {
    const repo = makeRepo();
    repo.stopSyncAccount.mockRejectedValueOnce(new Error('worker gone'));
    __setRepositoryForTests(repo);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const authStore = useAuthStore();

    authStore.status = AUTH_STATE.CONNECTED;
    authStore.accountId = 9;
    authStore.username = 'bob@example.com';

    await authStore.logout();

    expect(consoleWarn).toHaveBeenCalled();
    expect(authStore.status).toBe(AUTH_STATE.IDLE);
    expect(authStore.accountId).toBeNull();
    expect(authStore.username).toBeNull();
    consoleWarn.mockRestore();
  });

  it('storage quota: percentage clamps to 100 and hides when no hard limit (R-7.1 / R-7.2)', () => {
    const authStore = useAuthStore();

    expect(authStore.hasStorageQuota).toBe(false);
    expect(authStore.storagePercentUsed).toBe(0);

    authStore.quotaUsedBytes = 512;
    authStore.quotaHardLimitBytes = 1024;
    expect(authStore.hasStorageQuota).toBe(true);
    expect(authStore.storagePercentUsed).toBe(50);
    expect(authStore.storageProgressWidth).toBe('50%');

    // Over-quota usage is clamped so the bar never overflows.
    authStore.quotaUsedBytes = 5_000;
    expect(authStore.storagePercentUsed).toBe(100);

    // Removing the hard limit (server stopped advertising it) flips
    // hasStorageQuota off so the indicator hides per R-7.2.
    authStore.quotaHardLimitBytes = null;
    expect(authStore.hasStorageQuota).toBe(false);
  });
});
