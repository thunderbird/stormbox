// @vitest-environment happy-dom

import {
  describe, it, expect, beforeEach, vi,
} from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const authService = vi.hoisted(() => ({
  initOidc: vi.fn(async () => null),
  getOidc: vi.fn(() => null as any),
}));

// services/auth.js calls oidcEarlyInit({ BASE_URL: '/' }) at module
// load and throws under happy-dom unless the OIDC bootstrap is stubbed.
vi.mock('../../../src/services/auth', () => authService);

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
    startSyncAccount: vi.fn().mockResolvedValue({ accountId: 42 }),
    updateSyncAccountAuth: vi.fn().mockResolvedValue({ updated: true }),
    stopSyncAccount: vi.fn().mockResolvedValue(undefined),
  };
}

function oidcTokens(accessToken: string, issuedAtTime: number) {
  return {
    accessToken,
    issuedAtTime,
    accessTokenExpirationTime: issuedAtTime + 60_000,
    getServerDateNow: () => Date.now(),
    decodedIdToken: { email: 'tester@example.com' },
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  __resetRepositoryForTests();
  authService.initOidc.mockReset();
  authService.initOidc.mockResolvedValue(null);
  authService.getOidc.mockReset();
  authService.getOidc.mockReturnValue(null);
});

describe('auth-store', () => {
  it('forwards rotated OIDC access tokens to the active JMAP worker', async () => {
    let publishTokens: ((tokens: any) => void) | null = null;
    const unsubscribeFromTokensChange = vi.fn();
    const oidc = {
      isUserLoggedIn: true,
      getTokens: vi.fn().mockResolvedValue(oidcTokens('initial-token', 1_000)),
      subscribeToTokensChange: vi.fn((listener) => {
        publishTokens = listener;
        return { unsubscribeFromTokensChange };
      }),
    };
    authService.getOidc.mockReturnValue(oidc);
    const repo = makeRepo();
    __setRepositoryForTests(repo);
    const authStore = useAuthStore();

    await expect(authStore.connectViaOidc()).resolves.toBe(true);
    expect(repo.startSyncAccount).toHaveBeenCalledWith(expect.objectContaining({
      auth: {
        kind: 'bearer',
        token: 'initial-token',
        issuedAt: 1_000,
        expiresAt: 61_000,
      },
    }));

    publishTokens!(oidcTokens('rotated-token', 2_000));
    await vi.waitFor(() => {
      expect(repo.updateSyncAccountAuth).toHaveBeenCalledWith(
        42,
        {
          token: 'rotated-token',
          issuedAt: 2_000,
          expiresAt: 62_000,
        },
      );
    });

    authStore.$reset();
    expect(unsubscribeFromTokensChange).toHaveBeenCalledOnce();
  });

  it('forwards a rotation that arrives while the worker is starting', async () => {
    let publishTokens: ((tokens: any) => void) | null = null;
    let finishStart: ((value: { accountId: number }) => void) | null = null;
    const oidc = {
      isUserLoggedIn: true,
      getTokens: vi.fn().mockResolvedValue(oidcTokens('initial-token', 1_000)),
      subscribeToTokensChange: vi.fn((listener) => {
        publishTokens = listener;
        return { unsubscribeFromTokensChange: vi.fn() };
      }),
    };
    authService.getOidc.mockReturnValue(oidc);
    const repo = makeRepo();
    repo.startSyncAccount.mockImplementationOnce(() => new Promise((resolve) => {
      finishStart = resolve;
    }));
    __setRepositoryForTests(repo);
    const authStore = useAuthStore();

    const connecting = authStore.connectViaOidc();
    await vi.waitFor(() => expect(repo.startSyncAccount).toHaveBeenCalledOnce());
    expect(oidc.subscribeToTokensChange.mock.invocationCallOrder[0])
      .toBeLessThan(oidc.getTokens.mock.invocationCallOrder[0]);
    publishTokens!(oidcTokens('rotated-token', 2_000));
    finishStart!({ accountId: 42 });

    await expect(connecting).resolves.toBe(true);
    expect(repo.updateSyncAccountAuth).toHaveBeenLastCalledWith(42, {
      token: 'rotated-token',
      issuedAt: 2_000,
      expiresAt: 62_000,
    });

    authStore.$reset();
    const callsAfterReset = repo.updateSyncAccountAuth.mock.calls.length;
    publishTokens!(oidcTokens('late-token', 3_000));
    await Promise.resolve();
    expect(repo.updateSyncAccountAuth).toHaveBeenCalledTimes(callsAfterReset);
  });

  it('renews and forwards a short-lived OIDC token before it expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const oidc = {
      isUserLoggedIn: true,
      getTokens: vi.fn()
        .mockResolvedValueOnce(oidcTokens('initial-token', 10_000))
        .mockResolvedValueOnce(oidcTokens('initial-token', 10_000))
        .mockResolvedValueOnce(oidcTokens('rotated-token', 45_000)),
      subscribeToTokensChange: vi.fn(() => ({
        unsubscribeFromTokensChange: vi.fn(),
      })),
    };
    authService.getOidc.mockReturnValue(oidc);
    const repo = makeRepo();
    __setRepositoryForTests(repo);
    const authStore = useAuthStore();

    try {
      await expect(authStore.connectViaOidc()).resolves.toBe(true);
      repo.updateSyncAccountAuth.mockClear();

      await vi.advanceTimersByTimeAsync(34_999);
      expect(oidc.getTokens).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => {
        expect(repo.updateSyncAccountAuth).toHaveBeenCalledWith(42, {
          token: 'rotated-token',
          issuedAt: 45_000,
          expiresAt: 105_000,
        });
      });
    } finally {
      authStore.$reset();
      vi.useRealTimers();
    }
  });

  it('retries a rejected worker update without waiting for another rotation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    let publishTokens: ((tokens: any) => void) | null = null;
    const tokens = oidcTokens('current-token', 10_000);
    const oidc = {
      isUserLoggedIn: true,
      getTokens: vi.fn().mockResolvedValue(tokens),
      subscribeToTokensChange: vi.fn((listener) => {
        publishTokens = listener;
        return { unsubscribeFromTokensChange: vi.fn() };
      }),
    };
    authService.getOidc.mockReturnValue(oidc);
    const repo = makeRepo();
    __setRepositoryForTests(repo);
    const authStore = useAuthStore();
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(authStore.connectViaOidc()).resolves.toBe(true);
      repo.updateSyncAccountAuth.mockReset()
        .mockRejectedValueOnce(new Error('worker temporarily unavailable'))
        .mockResolvedValue({ updated: true });

      publishTokens!(oidcTokens('rotated-token', 20_000));
      await vi.advanceTimersByTimeAsync(0);
      expect(repo.updateSyncAccountAuth).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(repo.updateSyncAccountAuth).toHaveBeenCalledTimes(2);
      expect(repo.updateSyncAccountAuth).toHaveBeenLastCalledWith(42, {
        token: 'rotated-token',
        issuedAt: 20_000,
        expiresAt: 80_000,
      });
    } finally {
      authStore.$reset();
      consoleWarn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not report a renewable connection when the worker rejects auth updates', async () => {
    const oidc = {
      isUserLoggedIn: true,
      getTokens: vi.fn().mockResolvedValue(oidcTokens('current-token', 1_000)),
      subscribeToTokensChange: vi.fn(() => ({
        unsubscribeFromTokensChange: vi.fn(),
      })),
    };
    authService.getOidc.mockReturnValue(oidc);
    const repo = makeRepo();
    repo.updateSyncAccountAuth.mockResolvedValueOnce({ updated: false });
    __setRepositoryForTests(repo);
    const authStore = useAuthStore();

    await expect(authStore.connectViaOidc()).resolves.toBe(false);
    expect(authStore.status).toBe(AUTH_STATE.FAILED);
    expect(authStore.accountId).toBeNull();
    expect(authStore.error).toMatch(/renewable JMAP authentication/i);
  });

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
