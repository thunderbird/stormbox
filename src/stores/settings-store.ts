/**
 * Account settings with a synchronous browser mirror for boot-time UI.
 * SQLite remains authoritative once an account is known.
 */

import { defineStore } from 'pinia';
import { ref, watch, type WatchStopHandle } from 'vue';

import { getRepositoryAsync } from '../composables/useRepository';
import { resolveSetting, type Settings } from '../constants/settings';
import { TABLE_FAMILIES } from '../db/protocol';
import type { Repository } from '../db/repository';
import { detectTimeZone, isUsableTimeZone } from '../utils/schedule-time';
import { useAuthStore } from './auth-store';

const LOCAL_SETTINGS_KEY = 'stormbox.settings.v1';
const LOCAL_SETTINGS_META_KEY = 'stormbox.settings.meta.v1';
const LOCAL_PENDING_KEY = 'stormbox.settings.pending.v1';
const LEGACY_THEME_KEY = 'stormbox.theme.v1';

type SettingsMap = Record<string, unknown>;

interface PendingSettings {
  anonymous: SettingsMap;
  accounts: Record<string, SettingsMap>;
}

function readObject(key: string): SettingsMap {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeObject(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // In-memory state remains usable when browser storage is unavailable.
  }
}

function readMirror(): { values: SettingsMap; accountId: number | null } {
  const values = readObject(LOCAL_SETTINGS_KEY);
  let accountId: number | null;
  try {
    const raw = globalThis.localStorage?.getItem(LOCAL_SETTINGS_META_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    accountId = Number.isFinite(parsed?.accountId) ? Number(parsed.accountId) : null;
  } catch {
    accountId = null;
  }

  if (Object.keys(values).length > 0) return { values, accountId };

  try {
    const theme = globalThis.localStorage?.getItem(LEGACY_THEME_KEY);
    if (theme === 'light' || theme === 'dark') {
      const migrated = { theme };
      writeObject(LOCAL_SETTINGS_KEY, migrated);
      const pending = readPending();
      pending.anonymous = { ...pending.anonymous, ...migrated };
      writePending(pending);
      return { values: migrated, accountId: null };
    }
  } catch {
    // No browser storage or no legacy value.
  }
  return { values: {}, accountId };
}

function writeMirror(values: SettingsMap, accountId: number | null): void {
  writeObject(LOCAL_SETTINGS_KEY, values);
  writeObject(LOCAL_SETTINGS_META_KEY, { accountId });
}

function readPending(): PendingSettings {
  const raw = readObject(LOCAL_PENDING_KEY);
  const anonymous = raw.anonymous;
  const accounts = raw.accounts;
  return {
    anonymous: anonymous && typeof anonymous === 'object' && !Array.isArray(anonymous)
      ? anonymous as SettingsMap
      : {},
    accounts: accounts && typeof accounts === 'object' && !Array.isArray(accounts)
      ? accounts as Record<string, SettingsMap>
      : {},
  };
}

function writePending(pending: PendingSettings): void {
  writeObject(LOCAL_PENDING_KEY, pending);
}

function pendingForAccount(accountId: number): SettingsMap {
  const pending = readPending();
  return {
    ...pending.anonymous,
    ...(pending.accounts[String(accountId)] ?? {}),
  };
}

function stagePending(accountId: number | null, patch: SettingsMap): void {
  const pending = readPending();
  if (accountId == null) {
    pending.anonymous = { ...pending.anonymous, ...patch };
  } else {
    const key = String(accountId);
    pending.accounts[key] = { ...(pending.accounts[key] ?? {}), ...patch };
  }
  writePending(pending);
}

function clearPendingPatch(
  accountId: number,
  patch: SettingsMap,
  includeAnonymous: boolean,
): void {
  const pending = readPending();
  const key = String(accountId);
  const accountPending = pending.accounts[key] ?? {};
  for (const [setting, value] of Object.entries(patch)) {
    if (
      includeAnonymous
      && JSON.stringify(pending.anonymous[setting]) === JSON.stringify(value)
    ) {
      delete pending.anonymous[setting];
    }
    if (JSON.stringify(accountPending[setting]) === JSON.stringify(value)) {
      delete accountPending[setting];
    }
  }
  if (Object.keys(accountPending).length === 0) delete pending.accounts[key];
  else pending.accounts[key] = accountPending;
  writePending(pending);
}

export const useSettingsStore = defineStore('settings', () => {
  const authStore = useAuthStore();
  const initialMirror = readMirror();
  const settings = ref<SettingsMap>(initialMirror.values);
  let repo: Repository | null = null;
  let unsubscribe: (() => void) | null = null;
  let stopAccountWatch: WatchStopHandle | null = null;
  let activeAccountId: number | null = null;
  let stateRevision = 0;
  let attachGeneration = 0;
  const writesInFlight = new Map<number, number>();
  const refreshAfterWrite = new Set<number>();
  const initializedTimeZoneAccounts = new Set<number>();
  const timeZoneSyncInFlight = new Map<number, Promise<boolean>>();

  async function attach(): Promise<void> {
    if (repo) return;
    const generation = ++attachGeneration;
    const nextRepo = await getRepositoryAsync();
    if (generation !== attachGeneration) return;
    repo = nextRepo;
    unsubscribe = repo.subscribe(onTablesTouched);
    stopAccountWatch = watch(
      () => [authStore.accountId, authStore.isConnected] as const,
      async ([newId, connected]) => {
        activeAccountId = newId;
        stateRevision += 1;
        if (newId == null) {
          settings.value = readMirror().values;
          return;
        }
        const mirror = readMirror();
        const pending = pendingForAccount(newId);
        const mirrorBelongsToAccount = mirror.accountId === newId;
        if (!mirrorBelongsToAccount) {
          settings.value = pending;
        }
        try {
          await refresh(newId, connected);
        } catch (error) {
          console.warn('[settings-store] account refresh failed', error);
        }
      },
      { immediate: true },
    );
  }

  function detach(): void {
    attachGeneration += 1;
    stopAccountWatch?.();
    stopAccountWatch = null;
    unsubscribe?.();
    unsubscribe = null;
    repo = null;
    activeAccountId = null;
  }

  function $reset(): void {
    activeAccountId = null;
    stateRevision += 1;
    settings.value = readMirror().values;
  }

  function onTablesTouched(tables: string[]): void {
    if (!tables.includes(TABLE_FAMILIES.SETTINGS) || activeAccountId == null) return;
    if ((writesInFlight.get(activeAccountId) ?? 0) > 0) {
      refreshAfterWrite.add(activeAccountId);
      return;
    }
    void refresh(activeAccountId).catch((error) => {
      console.warn('[settings-store] refresh after broadcast failed', error);
    });
  }

  async function refresh(
    accountId = activeAccountId,
    initializeTimeZone = authStore.isConnected,
  ): Promise<void> {
    if (!repo || accountId == null || accountId !== activeAccountId) return;
    let mayInitializeTimeZone = false;
    if (initializeTimeZone && !initializedTimeZoneAccounts.has(accountId)) {
      const existingSync = timeZoneSyncInFlight.get(accountId);
      if (existingSync) {
        await existingSync;
      } else {
        const currentRepo = repo;
        const sync = (async () => {
          if (typeof currentRepo.ensureSettings !== 'function') return true;
          try {
            await currentRepo.ensureSettings(accountId);
            return true;
          } catch {
            return false;
          }
        })();
        timeZoneSyncInFlight.set(accountId, sync);
        mayInitializeTimeZone = await sync;
        if (timeZoneSyncInFlight.get(accountId) === sync) {
          timeZoneSyncInFlight.delete(accountId);
        }
      }
    }
    const revision = stateRevision;
    let result = await repo.getSettings(accountId);
    const pending = pendingForAccount(accountId);
    if (Object.keys(pending).length > 0) {
      result = await repo.applySettingsPatch(accountId, pending);
      clearPendingPatch(accountId, pending, true);
    }
    if (accountId !== activeAccountId || revision !== stateRevision) return;
    settings.value = result?.doc?.settings ?? {};
    writeMirror(settings.value, accountId);
    if (mayInitializeTimeZone && !initializedTimeZoneAccounts.has(accountId)) {
      initializedTimeZoneAccounts.add(accountId);
      if (!isUsableTimeZone(settings.value.timeZone)) {
        await update({ timeZone: detectTimeZone() });
      }
    }
  }

  function get<K extends keyof Settings>(key: K): Settings[K] {
    return resolveSetting(key, settings.value[key]);
  }

  async function update(patch: Partial<Settings>): Promise<void> {
    const accountId = authStore.isConnected ? authStore.accountId : null;
    settings.value = { ...settings.value, ...patch };
    stateRevision += 1;
    writeMirror(settings.value, accountId);
    stagePending(accountId, patch);
    if (!repo || accountId == null) return;

    const revision = stateRevision;
    writesInFlight.set(accountId, (writesInFlight.get(accountId) ?? 0) + 1);
    try {
      const result = await repo.applySettingsPatch(accountId, patch);
      clearPendingPatch(accountId, patch, false);
      if (accountId !== activeAccountId || revision !== stateRevision) return;
      settings.value = result?.doc?.settings ?? settings.value;
      writeMirror(settings.value, accountId);
    } finally {
      const remaining = Math.max(0, (writesInFlight.get(accountId) ?? 1) - 1);
      if (remaining > 0) {
        writesInFlight.set(accountId, remaining);
      } else {
        writesInFlight.delete(accountId);
        if (refreshAfterWrite.delete(accountId) && accountId === activeAccountId) {
          void refresh(accountId).catch((error) => {
            console.warn('[settings-store] deferred refresh failed', error);
          });
        }
      }
    }
  }

  return {
    settings,
    get,
    attach,
    detach,
    refresh,
    update,
    $reset,
  };
});
