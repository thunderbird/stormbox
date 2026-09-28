// @vitest-environment happy-dom

/**
 * Beacon state is the synced `onboarding` setting (specs/010 §3): a
 * high-water mark over beacon `seq`s plus out-of-order extras, null until
 * Welcome is first dismissed. Legacy device keys seed it once and are
 * deleted.
 */

import { createPinia, setActivePinia } from 'pinia';
import {
  afterEach,
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
  beaconById,
  BEACON_IDS,
  FEATURE_BEACONS,
  LATEST_BEACON_SEQ,
} from '../../../src/constants/feature-beacons';
import { useFeatureBeaconsStore } from '../../../src/stores/feature-beacons-store';
import { useSettingsStore } from '../../../src/stores/settings-store';
import type { OnboardingState } from '../../../src/utils/onboarding-state';

const LEGACY_WELCOME = 'stormbox.welcomeModalDismissed.v1';
const LEGACY_WHATS_NEW = 'stormbox.whatsNewSeen.2026-09-compose';
const LEGACY_PROGRESS = 'stormbox.featureBeacons.2026-09-compose';

/** The newest beacon, and the ids above a given mark, so appending a beacon needs no test edits. */
const NEWEST = FEATURE_BEACONS.find((beacon) => beacon.seq === LATEST_BEACON_SEQ)!.id;
const idsAbove = (seq: number) => FEATURE_BEACONS.filter((beacon) => beacon.seq > seq).map((beacon) => beacon.id);

function seed(state: OnboardingState | null) {
  useSettingsStore().settings = state == null ? {} : { onboarding: state };
}

function onboarding() {
  return useSettingsStore().get('onboarding');
}

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('feature beacons store', () => {
  it('shows nothing until Welcome has been dismissed', () => {
    seed(null);
    const store = useFeatureBeaconsStore();
    expect(store.welcomeDismissed).toBe(false);
    store.arm();
    expect(store.enabled).toBe(false);
    expect(store.count).toBe(0);
  });

  it('arms with every beacon above the mark unseen', () => {
    seed({ beaconsSeenThrough: 6 });
    const store = useFeatureBeaconsStore();
    store.arm();
    expect(store.enabled).toBe(true);
    expect(store.unseen.map((beacon) => beacon.id)).toEqual(idsAbove(6));
    expect(store.isUnseen('manageFolders')).toBe(false);
    expect(store.isUnseen('starMessages')).toBe(true);
  });

  it('counts out-of-order entries as seen', () => {
    seed({ beaconsSeenThrough: 0, beaconsSeenAlso: [2, 9] });
    const store = useFeatureBeaconsStore();
    store.arm();
    expect(store.unseen.map((beacon) => beacon.seq))
      .toEqual(FEATURE_BEACONS.map((beacon) => beacon.seq).filter((seq) => seq !== 2 && seq !== 9));
  });

  it('stays off when every beacon is seen, and never expires unseen ones', () => {
    seed({ beaconsSeenThrough: LATEST_BEACON_SEQ });
    const store = useFeatureBeaconsStore();
    store.arm();
    expect(store.enabled).toBe(false);

    seed({ beaconsSeenThrough: LATEST_BEACON_SEQ - 1 });
    for (let session = 0; session < 20; session += 1) {
      store.reset();
      store.arm();
    }
    expect(store.enabled).toBe(true);
    expect(store.unseen.map((beacon) => beacon.id)).toEqual([NEWEST]);
  });

  it('marks seen by advancing the mark when possible and listing the rest', () => {
    seed({ beaconsSeenThrough: 0 });
    const store = useFeatureBeaconsStore();
    store.arm();

    store.markSeen('composeSchedule');
    expect(onboarding()).toEqual({ beaconsSeenThrough: 0, beaconsSeenAlso: [3] });
    store.markSeen('newMessage');
    expect(onboarding()).toEqual({ beaconsSeenThrough: 1, beaconsSeenAlso: [3] });
    // Filling the gap folds the listed entry into the mark.
    store.markSeen('composeMinimize');
    expect(onboarding()).toEqual({ beaconsSeenThrough: 3 });
    expect(store.count).toBe(BEACON_IDS.length - 3);
  });

  it('keeps the layer alive while the last card is read, then turns off', () => {
    seed({ beaconsSeenThrough: LATEST_BEACON_SEQ - 1 });
    const store = useFeatureBeaconsStore();
    store.arm();
    store.open(NEWEST);
    store.setCardShowing(true);
    store.markSeen(NEWEST);

    expect(onboarding()).toEqual({ beaconsSeenThrough: LATEST_BEACON_SEQ });
    expect(store.enabled).toBe(true);
    expect(store.openBeacon?.id).toBe(NEWEST);
    store.close();
    store.setCardShowing(false);
    expect(store.enabled).toBe(false);
  });

  it('Dismiss all stores one number', () => {
    seed({ beaconsSeenThrough: 2, beaconsSeenAlso: [5] });
    const store = useFeatureBeaconsStore();
    store.arm();
    store.open('contacts');
    store.dismissAll();
    expect(onboarding()).toEqual({ beaconsSeenThrough: LATEST_BEACON_SEQ });
    expect(store.enabled).toBe(false);
    expect(store.openId).toBeNull();
  });

  it('first Welcome dismissal marks everything seen; a later one leaves progress alone', () => {
    seed(null);
    const store = useFeatureBeaconsStore();
    store.dismissWelcome();
    expect(onboarding()).toEqual({ beaconsSeenThrough: LATEST_BEACON_SEQ });

    seed({ beaconsSeenThrough: 2 });
    store.dismissWelcome();
    expect(onboarding()).toEqual({ beaconsSeenThrough: 2 });
  });

  it('turns off when another device finishes the list', async () => {
    seed({ beaconsSeenThrough: 0 });
    const store = useFeatureBeaconsStore();
    store.arm();
    seed({ beaconsSeenThrough: LATEST_BEACON_SEQ });
    await Promise.resolve();
    expect(store.enabled).toBe(false);
  });

  it('opens cards only while armed', () => {
    seed({ beaconsSeenThrough: LATEST_BEACON_SEQ });
    const store = useFeatureBeaconsStore();
    store.open('contacts');
    expect(store.openBeacon).toBeNull();
  });

  it('restart marks every beacon unseen and shows them at once', () => {
    seed({ beaconsSeenThrough: LATEST_BEACON_SEQ });
    const store = useFeatureBeaconsStore();
    store.restart();
    expect(onboarding()).toEqual({ beaconsSeenThrough: 0 });
    expect(store.enabled).toBe(true);
    expect(store.count).toBe(BEACON_IDS.length);
  });

  it('reset drops in-memory state only', () => {
    seed({ beaconsSeenThrough: 3 });
    const store = useFeatureBeaconsStore();
    store.arm();
    store.open('contacts');
    store.reset();
    expect(store.enabled).toBe(false);
    expect(store.openId).toBeNull();
    expect(onboarding()).toEqual({ beaconsSeenThrough: 3 });
  });
});

describe('legacy device keys (OB-6.3)', () => {
  it('a finished 2026-09-compose round covers every beacon it announced, leaving later ones unseen', () => {
    seed(null);
    window.localStorage.setItem(LEGACY_WELCOME, '1');
    window.localStorage.setItem(LEGACY_WHATS_NEW, '1');
    const store = useFeatureBeaconsStore();
    store.adoptLegacyState();

    expect(onboarding()).toEqual({ beaconsSeenThrough: beaconById('keyboardShortcuts').seq });
    store.arm();
    expect(store.unseen.map((beacon) => beacon.id)).toEqual(idsAbove(beaconById('keyboardShortcuts').seq));
    for (const key of [LEGACY_WELCOME, LEGACY_WHATS_NEW, LEGACY_PROGRESS]) {
      expect(window.localStorage.getItem(key)).toBeNull();
    }
  });

  it('an unfinished round carries its seen beacons over, compacted', () => {
    seed(null);
    window.localStorage.setItem(LEGACY_WELCOME, '1');
    window.localStorage.setItem(LEGACY_PROGRESS, JSON.stringify({
      seen: ['composeMinimize', 'newMessage', 'starMessages', 'gone'], sessions: 3,
    }));
    useFeatureBeaconsStore().adoptLegacyState();
    expect(onboarding()).toEqual({ beaconsSeenThrough: 2, beaconsSeenAlso: [7] });
    expect(window.localStorage.getItem(LEGACY_PROGRESS)).toBeNull();
  });

  it('Welcome dismissed with no round started means nothing seen', () => {
    seed(null);
    window.localStorage.setItem(LEGACY_WELCOME, '1');
    useFeatureBeaconsStore().adoptLegacyState();
    expect(onboarding()).toEqual({ beaconsSeenThrough: 0 });
  });

  it('a new user has no legacy state and still gets Welcome', () => {
    seed(null);
    const store = useFeatureBeaconsStore();
    store.adoptLegacyState();
    expect(onboarding()).toBeNull();
    expect(store.welcomeDismissed).toBe(false);
  });

  it('synced state wins over legacy keys, which are deleted anyway', () => {
    seed({ beaconsSeenThrough: 4 });
    window.localStorage.setItem(LEGACY_WELCOME, '1');
    window.localStorage.setItem(LEGACY_WHATS_NEW, '1');
    useFeatureBeaconsStore().adoptLegacyState();
    expect(onboarding()).toEqual({ beaconsSeenThrough: 4 });
    expect(window.localStorage.getItem(LEGACY_WELCOME)).toBeNull();
    expect(window.localStorage.getItem(LEGACY_WHATS_NEW)).toBeNull();
  });
});
