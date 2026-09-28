/**
 * Device-local onboarding keys from before the synced `onboarding` setting
 * (specs/010 OB-6.3): read once to seed the setting, then deleted. Every
 * helper swallows storage errors, so blocked storage just means nothing
 * to migrate.
 */

import type { OnboardingState } from './onboarding-state';

const LEGACY_WELCOME_KEY = 'stormbox.welcomeModalDismissed.v1';
const LEGACY_WHATS_NEW_KEY = 'stormbox.whatsNewSeen.2026-09-compose';
const LEGACY_PROGRESS_KEY = 'stormbox.featureBeacons.2026-09-compose';
const LEGACY_KEYS = [LEGACY_WELCOME_KEY, LEGACY_WHATS_NEW_KEY, LEGACY_PROGRESS_KEY];

/** `seq` of the last beacon the `2026-09-compose` round announced (`keyboardShortcuts`). */
const LEGACY_ROUND_LAST_SEQ = 8;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * The onboarding state the legacy keys describe, or null when there are
 * none (a new user, who gets Welcome). A finished round means every beacon
 * it announced is seen; an unfinished one carries its seen beacons over.
 */
export function readLegacyOnboarding(
  seqOf: (beaconId: string) => number | undefined,
): OnboardingState | null {
  if (read(LEGACY_WELCOME_KEY) !== '1') return null;
  if (read(LEGACY_WHATS_NEW_KEY) === '1') return { beaconsSeenThrough: LEGACY_ROUND_LAST_SEQ };
  let seen: unknown;
  try {
    seen = (JSON.parse(read(LEGACY_PROGRESS_KEY) ?? 'null') as { seen?: unknown } | null)?.seen;
  } catch {
    seen = null;
  }
  const seqs = Array.isArray(seen)
    ? seen.flatMap((id) => {
      const seq = typeof id === 'string' ? seqOf(id) : undefined;
      return seq == null ? [] : [seq];
    })
    : [];
  return seqs.length > 0
    ? { beaconsSeenThrough: 0, beaconsSeenAlso: seqs }
    : { beaconsSeenThrough: 0 };
}

/** Deletes every legacy onboarding key; the synced setting replaces them. */
export function removeLegacyOnboardingKeys(): void {
  for (const key of LEGACY_KEYS) {
    try {
      storage()?.removeItem(key);
    } catch {
      // Nothing to clean up when storage is unavailable.
    }
  }
}
