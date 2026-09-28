import { describe, expect, it } from 'vitest';

import { FEATURE_BEACONS, LATEST_BEACON_SEQ } from '../../../src/constants/feature-beacons';
import { resolveSetting } from '../../../src/constants/settings';
import {
  compactOnboardingState,
  isBeaconSeen,
  isOnboardingState,
  markBeaconSeen,
  onboardingSeenThrough,
} from '../../../src/utils/onboarding-state';

const live = (...seqs: number[]) => new Set(seqs);

describe('beacon sequence numbers (OB-4.1)', () => {
  it('are unique positive integers, and the latest is the largest', () => {
    const seqs = FEATURE_BEACONS.map((beacon) => beacon.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs.every((seq) => Number.isInteger(seq) && seq > 0)).toBe(true);
    expect(LATEST_BEACON_SEQ).toBe(Math.max(...seqs));
  });
});

describe('onboarding state', () => {
  it('validates the stored shape; anything else resolves to null (Welcome not dismissed)', () => {
    expect(isOnboardingState(null)).toBe(true);
    expect(isOnboardingState({ beaconsSeenThrough: 3 })).toBe(true);
    expect(isOnboardingState({ beaconsSeenThrough: 3, beaconsSeenAlso: [5, 7] })).toBe(true);
    for (const bad of [{}, { beaconsSeenThrough: -1 }, { beaconsSeenThrough: 1.5 }, { beaconsSeenThrough: 1, beaconsSeenAlso: ['x'] }, [], 'done']) {
      expect(isOnboardingState(bad)).toBe(false);
      expect(resolveSetting('onboarding', bad)).toBeNull();
    }
  });

  it('treats a missing state as nothing seen', () => {
    expect(isBeaconSeen(null, 1)).toBe(false);
    expect(isBeaconSeen({ beaconsSeenThrough: 4 }, 4)).toBe(true);
    expect(isBeaconSeen({ beaconsSeenThrough: 4 }, 5)).toBe(false);
    expect(isBeaconSeen({ beaconsSeenThrough: 4, beaconsSeenAlso: [6] }, 6)).toBe(true);
  });

  it('folds entries into the mark as gaps close, and stores one number when nothing is left above it', () => {
    const all = live(1, 2, 3, 4, 5);
    let state = markBeaconSeen(null, 3, all, 5);
    expect(state).toEqual({ beaconsSeenThrough: 0, beaconsSeenAlso: [3] });
    state = markBeaconSeen(state, 5, all, 5);
    expect(state).toEqual({ beaconsSeenThrough: 0, beaconsSeenAlso: [3, 5] });
    state = markBeaconSeen(state, 1, all, 5);
    expect(state).toEqual({ beaconsSeenThrough: 1, beaconsSeenAlso: [3, 5] });
    state = markBeaconSeen(state, 2, all, 5);
    expect(state).toEqual({ beaconsSeenThrough: 3, beaconsSeenAlso: [5] });
    state = markBeaconSeen(state, 4, all, 5);
    expect(state).toEqual({ beaconsSeenThrough: 5 });
  });

  it('steps over the seqs of removed beacons, so a gap never pins the mark', () => {
    // Beacon 2 was removed from the list.
    expect(markBeaconSeen({ beaconsSeenThrough: 1 }, 3, live(1, 3, 4), 4))
      .toEqual({ beaconsSeenThrough: 3 });
  });

  it('never moves past the newest beacon, and drops entries already under the mark', () => {
    expect(compactOnboardingState({ beaconsSeenThrough: 2, beaconsSeenAlso: [1, 2, 4] }, live(1, 2, 3, 4), 4))
      .toEqual({ beaconsSeenThrough: 2, beaconsSeenAlso: [4] });
    expect(compactOnboardingState({ beaconsSeenThrough: 0 }, live(3), 3))
      .toEqual({ beaconsSeenThrough: 2 });
    expect(onboardingSeenThrough(9)).toEqual({ beaconsSeenThrough: 9 });
  });
});
