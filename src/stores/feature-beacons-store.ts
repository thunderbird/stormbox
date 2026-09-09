/**
 * Feature beacons for users who dismissed Welcome before this What's New
 * round. `arm()` runs on every connect, but a page load counts as one
 * session however often the connection drops and returns; progress
 * ({ seen, sessions }) persists so a beacon stays dismissed across reloads
 * and the whole round expires after BEACON_SESSION_LIMIT sessions.
 * Finishing writes the What's New flag, which is the same gate the Welcome
 * dismissal sets, so the round never comes back.
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import {
  BEACON_IDS,
  BEACON_SESSION_LIMIT,
  FEATURE_BEACONS,
  FEATURE_BEACONS_STORAGE_KEY,
  isBeaconId,
  type BeaconId,
  type FeatureBeacon,
} from '../constants/feature-beacons';
import {
  readOnboardingJson,
  removeOnboardingKey,
  WHATS_NEW_STORAGE_KEY,
  writeOnboardingFlag,
  writeOnboardingJson,
} from '../utils/onboarding-storage';

interface BeaconProgress {
  seen: BeaconId[];
  sessions: number;
}

function readProgress(): BeaconProgress {
  const stored = readOnboardingJson<Partial<Record<keyof BeaconProgress, unknown>>>(
    FEATURE_BEACONS_STORAGE_KEY,
  );
  const seen = Array.isArray(stored?.seen) ? stored.seen.filter(isBeaconId) : [];
  const sessions = typeof stored?.sessions === 'number' && Number.isFinite(stored.sessions)
    ? Math.max(0, Math.floor(stored.sessions))
    : 0;
  return { seen: [...new Set(seen)], sessions };
}

export const useFeatureBeaconsStore = defineStore('feature-beacons', () => {
  const enabled = ref(false);
  const seen = ref<BeaconId[]>([]);
  const sessions = ref(0);
  const openId = ref<BeaconId | null>(null);
  const cardShowing = ref(false);
  // Survives reset() so a reconnect re-arms without spending another session.
  const sessionCounted = ref(false);

  const unseen = computed<FeatureBeacon[]>(() =>
    enabled.value
      ? FEATURE_BEACONS.filter((beacon) => !seen.value.includes(beacon.id))
      : []);
  const count = computed(() => unseen.value.length);
  const allSeen = computed(() => seen.value.length >= BEACON_IDS.length);
  // A card stays readable after its beacon is marked seen, so the open
  // beacon is looked up in the full list.
  const openBeacon = computed<FeatureBeacon | null>(() =>
    (enabled.value && openId.value
      ? FEATURE_BEACONS.find((beacon) => beacon.id === openId.value) ?? null
      : null));

  function persist(): void {
    writeOnboardingJson(FEATURE_BEACONS_STORAGE_KEY, {
      seen: seen.value,
      sessions: sessions.value,
    } satisfies BeaconProgress);
  }

  // Once every beacon is seen the store stays enabled only while a card is
  // still showing, so the last one can be read.
  function settle(): void {
    if (allSeen.value && openId.value == null && !cardShowing.value) enabled.value = false;
  }

  // The round is over: the What's New flag replaces the progress record.
  function finish(): void {
    writeOnboardingFlag(WHATS_NEW_STORAGE_KEY);
    removeOnboardingKey(FEATURE_BEACONS_STORAGE_KEY);
    settle();
  }

  /** The layer reports whether any card (pinned or not) is on screen. */
  function setCardShowing(showing: boolean): void {
    cardShowing.value = showing;
    settle();
  }

  function arm(): void {
    if (enabled.value) return;
    const progress = readProgress();
    seen.value = progress.seen;
    sessions.value = sessionCounted.value
      ? Math.max(progress.sessions, 1)
      : progress.sessions + 1;
    sessionCounted.value = true;
    openId.value = null;
    if (sessions.value > BEACON_SESSION_LIMIT || allSeen.value) {
      finish();
      return;
    }
    enabled.value = true;
    persist();
  }

  function isUnseen(id: BeaconId): boolean {
    return enabled.value && !seen.value.includes(id);
  }

  function markSeen(id: BeaconId): void {
    if (!isUnseen(id)) return;
    seen.value = [...seen.value, id];
    if (allSeen.value) {
      finish();
      return;
    }
    persist();
  }

  function dismissAll(): void {
    if (!enabled.value) return;
    seen.value = [...BEACON_IDS];
    openId.value = null;
    cardShowing.value = false;
    finish();
  }

  function open(id: BeaconId): void {
    if (!enabled.value) return;
    openId.value = id;
  }

  function close(): void {
    openId.value = null;
    settle();
  }

  /** Drops in-memory state on disconnect; stored progress is untouched. */
  function reset(): void {
    enabled.value = false;
    seen.value = [];
    sessions.value = 0;
    openId.value = null;
    cardShowing.value = false;
  }

  return {
    enabled,
    seen,
    sessions,
    openId,
    unseen,
    count,
    allSeen,
    openBeacon,
    arm,
    isUnseen,
    markSeen,
    dismissAll,
    open,
    close,
    setCardShowing,
    reset,
  };
});
