/**
 * localStorage access for onboarding state (welcome dismissal, What's New,
 * feature beacons). Every helper swallows storage errors: with blocked
 * storage the onboarding UI becomes a session-only affordance.
 */

export const WELCOME_MODAL_STORAGE_KEY = 'stormbox.welcomeModalDismissed.v1';
// Dated per announcement: a new round gets a new key, so existing users
// see it once while new users (who see Welcome) never do.
export const WHATS_NEW_STORAGE_KEY = 'stormbox.whatsNewSeen.2026-09-compose';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readOnboardingFlag(key: string): boolean {
  try {
    return storage()?.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function writeOnboardingFlag(key: string): void {
  try {
    storage()?.setItem(key, '1');
  } catch {
    // Dismissal still applies for this session.
  }
}

export function readOnboardingJson<T>(key: string): T | null {
  try {
    const raw = storage()?.getItem(key);
    if (raw == null) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed != null && typeof parsed === 'object' ? parsed as T : null;
  } catch {
    return null;
  }
}

export function writeOnboardingJson(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // Progress is kept in memory for this session only.
  }
}

export function removeOnboardingKey(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
}
