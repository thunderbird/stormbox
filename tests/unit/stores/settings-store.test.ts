// @vitest-environment happy-dom

import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import {
  __resetRepositoryForTests,
  __setRepositoryForTests,
} from '../../../src/composables/useRepository';
import { AUTH_STATE } from '../../../src/constants/states';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useSettingsStore } from '../../../src/stores/settings-store';
import { detectTimeZone } from '../../../src/utils/schedule-time';

const MIRROR_KEY = 'stormbox.settings.v1';
const META_KEY = 'stormbox.settings.meta.v1';

function makeRepo(documents: Record<number, Record<string, unknown>>) {
  const listeners = new Set<(tables: string[]) => void>();
  return {
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    ensureSettings: vi.fn(async () => {}),
    getSettings: vi.fn(async (accountId) => ({
      doc: {
        owner: 'stormbox',
        documentType: 'user-settings',
        version: 1,
        settings: { ...(documents[accountId] ?? {}) },
        updatedAt: {},
      },
      remoteNodeId: null,
    })),
    applySettingsPatch: vi.fn(async (accountId, patch) => {
      documents[accountId] = { ...(documents[accountId] ?? {}), ...patch };
      return {
        doc: {
          owner: 'stormbox',
          documentType: 'user-settings',
          version: 1,
          settings: { ...documents[accountId] },
          updatedAt: {},
        },
      };
    }),
    touchSettings() {
      for (const listener of listeners) listener(['settings']);
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  setActivePinia(createPinia());
  __resetRepositoryForTests();
});

describe('settings store account safety', () => {
  it('uses the mirror synchronously but does not seed a different account', async () => {
    window.localStorage.setItem(MIRROR_KEY, JSON.stringify({ theme: 'dark' }));
    window.localStorage.setItem(META_KEY, JSON.stringify({ accountId: 1 }));
    const repo = makeRepo({ 2: { theme: 'light' } });
    __setRepositoryForTests(repo as any);
    const auth = useAuthStore();
    const store = useSettingsStore();

    expect(store.get('theme')).toBe('dark');
    auth.accountId = 2;
    await store.attach();
    await flushPromises();

    expect(store.get('theme')).toBe('light');
    expect(repo.applySettingsPatch).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem(META_KEY)!)).toEqual({ accountId: 2 });
  });

  it('stages signed-out changes anonymously instead of writing the mirrored account', async () => {
    window.localStorage.setItem(MIRROR_KEY, JSON.stringify({ theme: 'dark' }));
    window.localStorage.setItem(META_KEY, JSON.stringify({ accountId: 1 }));
    const repo = makeRepo({ 2: { theme: 'light' } });
    __setRepositoryForTests(repo as any);
    const store = useSettingsStore();
    await store.update({ theme: 'system' });
    expect(repo.applySettingsPatch).not.toHaveBeenCalled();

    const auth = useAuthStore();
    auth.accountId = 2;
    auth.status = AUTH_STATE.CONNECTED;
    await store.attach();
    await flushPromises();

    expect(store.get('theme')).toBe('system');
    expect(repo.applySettingsPatch).toHaveBeenCalledWith(2, { theme: 'system' });
  });

  it('claims anonymous pre-auth changes for the first connected account', async () => {
    const repo = makeRepo({ 7: { density: 'compact' } });
    __setRepositoryForTests(repo as any);
    const store = useSettingsStore();
    await store.update({ theme: 'dark' });

    const auth = useAuthStore();
    auth.accountId = 7;
    await store.attach();
    await flushPromises();

    expect(repo.applySettingsPatch).toHaveBeenCalledWith(7, { theme: 'dark' });
    expect(store.settings).toEqual({ density: 'compact', theme: 'dark' });
  });

  it('migrates the legacy theme through the anonymous pending path', async () => {
    window.localStorage.setItem('stormbox.theme.v1', 'dark');
    const repo = makeRepo({ 9: {} });
    __setRepositoryForTests(repo as any);
    const store = useSettingsStore();
    expect(store.get('theme')).toBe('dark');

    const auth = useAuthStore();
    auth.accountId = 9;
    await store.attach();
    await flushPromises();

    expect(repo.applySettingsPatch).toHaveBeenCalledWith(9, { theme: 'dark' });
  });

  it('does not reapply an update when its own broadcast arrives in flight', async () => {
    const repo = makeRepo({ 3: { theme: 'light' } });
    __setRepositoryForTests(repo as any);
    const auth = useAuthStore();
    auth.accountId = 3;
    auth.status = AUTH_STATE.CONNECTED;
    const store = useSettingsStore();
    await store.attach();
    await flushPromises();
    repo.applySettingsPatch.mockClear();

    let finishWrite!: () => void;
    const writing = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    repo.applySettingsPatch.mockImplementationOnce(async (accountId, patch) => {
      await writing;
      return {
        doc: {
          owner: 'stormbox',
          documentType: 'user-settings',
          version: 1,
          settings: { theme: patch.theme },
          updatedAt: {},
        },
      };
    });

    const update = store.update({ theme: 'dark' });
    await flushPromises();
    repo.touchSettings();
    await flushPromises();
    expect(repo.applySettingsPatch).toHaveBeenCalledTimes(1);

    finishWrite();
    await update;
    await flushPromises();
    expect(repo.applySettingsPatch).toHaveBeenCalledTimes(1);
  });

  it('validates raw values through the typed registry', () => {
    const store = useSettingsStore();
    store.settings = {
      theme: 'invalid',
      primaryIdentityRemoteId: '',
      scheduledMailboxRemoteId: '',
      timeZone: 'Mars/Olympus_Mons',
    };
    expect(store.get('theme')).toBe('system');
    expect(store.get('primaryIdentityRemoteId')).toBeNull();
    expect(store.get('scheduledMailboxRemoteId')).toBeNull();
    expect(store.get('timeZone')).toBe(detectTimeZone());
  });

  it('persists a detected timezone once on the first connected account load', async () => {
    const repo = makeRepo({ 11: {} });
    __setRepositoryForTests(repo as any);
    const auth = useAuthStore();
    auth.accountId = 11;
    auth.status = AUTH_STATE.CONNECTED;
    const store = useSettingsStore();

    await store.attach();
    await flushPromises();

    expect(repo.applySettingsPatch).toHaveBeenCalledTimes(1);
    expect(repo.applySettingsPatch).toHaveBeenCalledWith(11, {
      timeZone: detectTimeZone(),
    });
    repo.touchSettings();
    await flushPromises();
    expect(repo.applySettingsPatch).toHaveBeenCalledTimes(1);
  });

  it('preserves a valid synced timezone on first load', async () => {
    const repo = makeRepo({ 12: { timeZone: 'Pacific/Auckland' } });
    __setRepositoryForTests(repo as any);
    const auth = useAuthStore();
    auth.accountId = 12;
    auth.status = AUTH_STATE.CONNECTED;
    const store = useSettingsStore();

    await store.attach();
    await flushPromises();

    expect(store.get('timeZone')).toBe('Pacific/Auckland');
    expect(repo.applySettingsPatch).not.toHaveBeenCalled();
  });

  it('pulls remote settings before deciding whether to persist a default timezone', async () => {
    const documents: Record<number, Record<string, unknown>> = { 14: {} };
    const repo = makeRepo(documents);
    repo.ensureSettings.mockImplementationOnce(async () => {
      documents[14] = { timeZone: 'Europe/Berlin' };
    });
    __setRepositoryForTests(repo as any);
    const auth = useAuthStore();
    auth.accountId = 14;
    auth.status = AUTH_STATE.CONNECTED;
    const store = useSettingsStore();

    await store.attach();
    await flushPromises();

    expect(repo.ensureSettings).toHaveBeenCalledWith(14);
    expect(store.get('timeZone')).toBe('Europe/Berlin');
    expect(repo.applySettingsPatch).not.toHaveBeenCalled();
  });

  it('repairs an unusable synced timezone through the settings update path', async () => {
    const repo = makeRepo({ 13: { timeZone: 'Mars/Olympus_Mons' } });
    __setRepositoryForTests(repo as any);
    const auth = useAuthStore();
    auth.accountId = 13;
    auth.status = AUTH_STATE.CONNECTED;
    const store = useSettingsStore();

    await store.attach();
    await flushPromises();

    expect(store.get('timeZone')).toBe(detectTimeZone());
    expect(repo.applySettingsPatch).toHaveBeenCalledWith(13, {
      timeZone: detectTimeZone(),
    });
  });
});
