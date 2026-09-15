/**
 * Staff-gated feature flags. Staff turn a flag on by typing its code into
 * the Staff settings textbox; the flag persists in localStorage per
 * signed-in account and is purely client-side. `isEnabled` is false for
 * a non-staff session even when the account has the flag stored.
 */

import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';

import { useAuthStore } from './auth-store';

/** Normalized code → flag id. Empty until a feature registers a code. */
export const FEATURE_CODES: Readonly<Record<string, string>> = Object.freeze({});

const STORAGE_PREFIX = 'stormbox.featureFlags';
const STORAGE_VERSION = 'v1';

export function normalizeFeatureCode(text: string | null | undefined): string {
  return String(text ?? '').trim().toLowerCase();
}

/** The flag a typed code names, or null for a code no feature claims. */
export function featureForCode(
  text: string | null | undefined,
  registry: Readonly<Record<string, string>> = FEATURE_CODES,
): string | null {
  const code = normalizeFeatureCode(text);
  return code ? registry[code] ?? null : null;
}

export function featureFlagsStorageKey(accountId: number): string {
  return `${STORAGE_PREFIX}.${accountId}.${STORAGE_VERSION}`;
}

function readPersisted(accountId: number | null): string[] {
  if (accountId == null || typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(featureFlagsStorageKey(accountId));
    const parsed = raw ? JSON.parse(raw) : null;
    const enabled: unknown[] = Array.isArray(parsed?.enabled) ? parsed.enabled : [];
    return [...new Set(enabled.filter((id): id is string => typeof id === 'string' && id !== ''))];
  } catch {
    return [];
  }
}

function writePersisted(accountId: number, enabled: string[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(featureFlagsStorageKey(accountId), JSON.stringify({ enabled }));
  } catch {
    // Storage full or blocked: the flag does not survive reload.
  }
}

export const useFeatureFlagsStore = defineStore('feature-flags', () => {
  const authStore = useAuthStore();
  const enabled = ref<string[]>(readPersisted(authStore.accountId));

  watch(
    () => authStore.accountId,
    (accountId) => {
      enabled.value = readPersisted(accountId);
    },
  );

  const enabledIds = computed<ReadonlySet<string>>(() => new Set(enabled.value));

  function isEnabled(flagId: string): boolean {
    return authStore.isStaff && enabledIds.value.has(flagId);
  }

  /** Turns a flag on for the signed-in staff account; false otherwise. */
  function enable(flagId: string): boolean {
    const accountId = authStore.accountId;
    if (accountId == null || !authStore.isStaff || !flagId) return false;
    if (!enabledIds.value.has(flagId)) {
      enabled.value = [...enabled.value, flagId];
      writePersisted(accountId, enabled.value);
    }
    return true;
  }

  /** Resolves a typed code and turns its flag on; false for an unknown code. */
  function activate(code: string): boolean {
    const flagId = featureForCode(code);
    return flagId != null && enable(flagId);
  }

  return {
    enabled,
    isEnabled,
    enable,
    activate,
  };
});
