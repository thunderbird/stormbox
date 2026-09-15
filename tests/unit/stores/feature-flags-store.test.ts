// @vitest-environment happy-dom

import { createPinia, setActivePinia } from 'pinia';
import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import { useAuthStore } from '../../../src/stores/auth-store';
import {
  featureFlagsStorageKey,
  featureForCode,
  useFeatureFlagsStore,
} from '../../../src/stores/feature-flags-store';

function signIn(accountId: number, recoveryEmail: string | null) {
  const auth = useAuthStore();
  auth.accountId = accountId;
  auth.recoveryEmail = recoveryEmail;
  return auth;
}

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
});

describe('feature flags store', () => {
  it('resolves codes case- and space-insensitively against a registry and rejects unknown ones', () => {
    const registry = { sample: 'sample-flag' };
    expect(featureForCode('  Sample ', registry)).toBe('sample-flag');
    expect(featureForCode('other', registry)).toBeNull();
    expect(featureForCode('', registry)).toBeNull();
    // Nothing registers a code yet, so every code is unknown by default.
    expect(featureForCode('sample')).toBeNull();
    expect(useFeatureFlagsStore().activate('sample')).toBe(false);
  });

  it('turns a flag on for the signed-in staff account and persists it per account', () => {
    signIn(1, 'boss@thunderbird.net');
    const store = useFeatureFlagsStore();
    expect(store.isEnabled('sample-flag')).toBe(false);

    expect(store.enable('sample-flag')).toBe(true);
    expect(store.isEnabled('sample-flag')).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(featureFlagsStorageKey(1))!))
      .toEqual({ enabled: ['sample-flag'] });

    // A fresh store for the same account reads it back; another account has none.
    setActivePinia(createPinia());
    signIn(1, 'boss@thunderbird.net');
    expect(useFeatureFlagsStore().isEnabled('sample-flag')).toBe(true);
    setActivePinia(createPinia());
    signIn(2, 'boss@thunderbird.net');
    expect(useFeatureFlagsStore().isEnabled('sample-flag')).toBe(false);
  });

  it('is gated to staff: a non-staff session can neither enable nor see a stored flag', () => {
    window.localStorage.setItem(featureFlagsStorageKey(1), JSON.stringify({ enabled: ['sample-flag'] }));
    signIn(1, 'someone@gmail.com');
    const store = useFeatureFlagsStore();
    expect(store.enabled).toEqual(['sample-flag']);
    expect(store.isEnabled('sample-flag')).toBe(false);
    expect(store.enable('other-flag')).toBe(false);
  });

  it('reloads the flags when the signed-in account changes', () => {
    window.localStorage.setItem(featureFlagsStorageKey(2), JSON.stringify({ enabled: ['sample-flag'] }));
    const auth = signIn(1, 'boss@thunderbird.net');
    const store = useFeatureFlagsStore();
    expect(store.isEnabled('sample-flag')).toBe(false);

    auth.accountId = 2;
    return Promise.resolve().then(() => {
      expect(store.isEnabled('sample-flag')).toBe(true);
    });
  });
});
