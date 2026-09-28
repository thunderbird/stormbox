/**
 * Feature beacons (specs/010 §3–4). What is seen lives in the synced
 * `onboarding` setting as a high-water mark over beacon `seq`s, so a
 * dismissal follows the user to every device and a beacon shipped later
 * is unseen by everyone who has not dismissed it. `arm()` runs once the
 * connected account's settings are pulled; a beacon stays until it is seen
 * or dismissed.
 */

import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';

import {
  beaconById,
  FEATURE_BEACONS,
  isBeaconId,
  LATEST_BEACON_SEQ,
  LIVE_BEACON_SEQS,
  type BeaconId,
  type FeatureBeacon,
} from '../constants/feature-beacons';
import {
  compactOnboardingState,
  isBeaconSeen,
  markBeaconSeen,
  onboardingSeenThrough,
  type OnboardingState,
} from '../utils/onboarding-state';
import { readLegacyOnboarding, removeLegacyOnboardingKeys } from '../utils/onboarding-storage';
import { useSettingsStore } from './settings-store';

export const useFeatureBeaconsStore = defineStore('feature-beacons', () => {
  const settingsStore = useSettingsStore();
  const enabled = ref(false);
  const openId = ref<BeaconId | null>(null);
  const cardShowing = ref(false);

  const onboarding = computed(() => settingsStore.get('onboarding'));
  /** Welcome has been dismissed at least once, on any device. */
  const welcomeDismissed = computed(() => onboarding.value != null);
  const pending = computed<FeatureBeacon[]>(() =>
    FEATURE_BEACONS.filter((beacon) => !isBeaconSeen(onboarding.value, beacon.seq)));
  const unseen = computed<FeatureBeacon[]>(() => (enabled.value ? pending.value : []));
  const count = computed(() => unseen.value.length);
  const allSeen = computed(() => pending.value.length === 0);
  // A card stays readable after its beacon is marked seen, so the open
  // beacon is looked up in the full list.
  const openBeacon = computed<FeatureBeacon | null>(() =>
    (enabled.value && openId.value
      ? FEATURE_BEACONS.find((beacon) => beacon.id === openId.value) ?? null
      : null));

  function write(next: OnboardingState): void {
    void settingsStore.update({ onboarding: next }).catch((error) => {
      console.warn('[feature-beacons] saving onboarding state failed', error);
    });
  }

  // Once every beacon is seen the layer stays enabled only while a card is
  // still showing, so the last one can be read (OB-4.11).
  function settle(): void {
    if (allSeen.value && openId.value == null && !cardShowing.value) enabled.value = false;
  }
  // Another device may finish the list while this one shows it.
  watch(allSeen, settle);

  /**
   * Seeds the setting from this device's pre-sync keys when the account
   * has none yet (OB-6.3), then deletes those keys either way.
   */
  function adoptLegacyState(): void {
    if (onboarding.value == null) {
      const legacy = readLegacyOnboarding((id) => (isBeaconId(id) ? beaconById(id).seq : undefined));
      if (legacy) write(compactOnboardingState(legacy, LIVE_BEACON_SEQS, LATEST_BEACON_SEQ));
    }
    removeLegacyOnboardingKeys();
  }

  /** Shows the unseen beacons, if Welcome was dismissed and any remain. */
  function arm(): void {
    if (enabled.value) return;
    openId.value = null;
    enabled.value = welcomeDismissed.value && !allSeen.value;
  }

  /**
   * Welcome covers every current feature, so its first dismissal marks
   * every beacon seen (OB-3.3). Later dismissals, from Settings' Show
   * welcome, leave the state alone.
   */
  function dismissWelcome(): void {
    if (onboarding.value == null) write(onboardingSeenThrough(LATEST_BEACON_SEQ));
  }

  /** The layer reports whether any card (pinned or not) is on screen. */
  function setCardShowing(showing: boolean): void {
    cardShowing.value = showing;
    settle();
  }

  function isUnseen(id: BeaconId): boolean {
    return enabled.value && !isBeaconSeen(onboarding.value, beaconById(id).seq);
  }

  function markSeen(id: BeaconId): void {
    if (!isUnseen(id)) return;
    write(markBeaconSeen(onboarding.value, beaconById(id).seq, LIVE_BEACON_SEQS, LATEST_BEACON_SEQ));
    settle();
  }

  function dismissAll(): void {
    if (!enabled.value) return;
    openId.value = null;
    cardShowing.value = false;
    write(onboardingSeenThrough(LATEST_BEACON_SEQ));
    settle();
  }

  function open(id: BeaconId): void {
    if (!enabled.value) return;
    openId.value = id;
  }

  function close(): void {
    openId.value = null;
    settle();
  }

  /** Drops in-memory state on disconnect; the setting is untouched. */
  function reset(): void {
    enabled.value = false;
    openId.value = null;
    cardShowing.value = false;
  }

  /** Staff testing (OB-3.5): every beacon unseen again, shown at once. */
  function restart(): void {
    write({ beaconsSeenThrough: 0 });
    reset();
    arm();
  }

  return {
    enabled,
    openId,
    onboarding,
    welcomeDismissed,
    unseen,
    count,
    allSeen,
    openBeacon,
    adoptLegacyState,
    arm,
    dismissWelcome,
    isUnseen,
    markSeen,
    dismissAll,
    open,
    close,
    setCardShowing,
    reset,
    restart,
  };
});
