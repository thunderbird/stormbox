// @vitest-environment happy-dom

import { createPinia, setActivePinia } from 'pinia';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  BEACON_IDS,
  BEACON_SESSION_LIMIT,
  FEATURE_BEACONS_STORAGE_KEY,
} from '../../../src/constants/feature-beacons';
import { useFeatureBeaconsStore } from '../../../src/stores/feature-beacons-store';
import { WHATS_NEW_STORAGE_KEY } from '../../../src/utils/onboarding-storage';

function progress() {
  const raw = window.localStorage.getItem(FEATURE_BEACONS_STORAGE_KEY);
  return raw == null ? null : JSON.parse(raw);
}

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('feature beacons store', () => {
  it('arms with every beacon unseen, counts the session, and persists progress', () => {
    const store = useFeatureBeaconsStore();
    expect(store.enabled).toBe(false);
    expect(store.count).toBe(0);

    store.arm();

    expect(store.enabled).toBe(true);
    expect(store.sessions).toBe(1);
    expect(store.count).toBe(BEACON_IDS.length);
    expect(store.unseen.map((beacon) => beacon.id)).toEqual(BEACON_IDS);
    expect(progress()).toEqual({ seen: [], sessions: 1 });
    expect(window.localStorage.getItem(WHATS_NEW_STORAGE_KEY)).toBeNull();
  });

  it('resumes stored progress and ignores unknown ids', () => {
    window.localStorage.setItem(FEATURE_BEACONS_STORAGE_KEY, JSON.stringify({
      seen: ['newMessage', 'bogus', 'newMessage'],
      sessions: 2,
    }));
    const store = useFeatureBeaconsStore();

    store.arm();

    expect(store.sessions).toBe(3);
    expect(store.seen).toEqual(['newMessage']);
    expect(store.count).toBe(BEACON_IDS.length - 1);
    expect(progress()).toEqual({ seen: ['newMessage'], sessions: 3 });
  });

  it('arms only once per page load', () => {
    const store = useFeatureBeaconsStore();
    store.arm();
    store.arm();
    expect(store.sessions).toBe(1);
  });

  it(`finishes on session ${BEACON_SESSION_LIMIT + 1}: flag written, progress removed`, () => {
    window.localStorage.setItem(FEATURE_BEACONS_STORAGE_KEY, JSON.stringify({
      seen: [],
      sessions: BEACON_SESSION_LIMIT,
    }));
    const store = useFeatureBeaconsStore();

    store.arm();

    expect(store.enabled).toBe(false);
    expect(store.count).toBe(0);
    expect(window.localStorage.getItem(WHATS_NEW_STORAGE_KEY)).toBe('1');
    expect(progress()).toBeNull();
  });

  it(`stays live through session ${BEACON_SESSION_LIMIT}`, () => {
    window.localStorage.setItem(FEATURE_BEACONS_STORAGE_KEY, JSON.stringify({
      seen: [],
      sessions: BEACON_SESSION_LIMIT - 1,
    }));
    const store = useFeatureBeaconsStore();

    store.arm();

    expect(store.enabled).toBe(true);
    expect(store.sessions).toBe(BEACON_SESSION_LIMIT);
    expect(window.localStorage.getItem(WHATS_NEW_STORAGE_KEY)).toBeNull();
  });

  it('marks a beacon seen and persists while its card stays open', () => {
    const store = useFeatureBeaconsStore();
    store.arm();
    store.open('manageFolders');
    expect(store.openId).toBe('manageFolders');
    expect(store.openBeacon?.id).toBe('manageFolders');

    store.markSeen('manageFolders');

    // The card is still readable; only the dot retires.
    expect(store.openId).toBe('manageFolders');
    expect(store.openBeacon?.id).toBe('manageFolders');
    expect(store.isUnseen('manageFolders')).toBe(false);
    expect(store.count).toBe(BEACON_IDS.length - 1);
    expect(progress()).toEqual({ seen: ['manageFolders'], sessions: 1 });

    // Repeats and unarmed calls are no-ops.
    store.markSeen('manageFolders');
    expect(progress()).toEqual({ seen: ['manageFolders'], sessions: 1 });
  });

  it('finishes once every beacon has been seen', () => {
    const store = useFeatureBeaconsStore();
    store.arm();

    for (const id of BEACON_IDS) store.markSeen(id);

    expect(store.enabled).toBe(false);
    expect(store.count).toBe(0);
    expect(window.localStorage.getItem(WHATS_NEW_STORAGE_KEY)).toBe('1');
    expect(progress()).toBeNull();
  });

  it('finishes on Dismiss all', () => {
    const store = useFeatureBeaconsStore();
    store.arm();
    store.open('contacts');

    store.dismissAll();

    expect(store.enabled).toBe(false);
    expect(store.openId).toBeNull();
    expect(store.unseen).toEqual([]);
    expect(window.localStorage.getItem(WHATS_NEW_STORAGE_KEY)).toBe('1');
    expect(progress()).toBeNull();
  });

  it('opens cards only while armed', () => {
    const store = useFeatureBeaconsStore();
    store.open('contacts');
    expect(store.openId).toBeNull();

    store.arm();
    store.open('newMessage');
    expect(store.openId).toBe('newMessage');
    store.close();
    expect(store.openId).toBeNull();

    // A seen beacon's card can still be reopened from the control.
    store.markSeen('contacts');
    store.open('contacts');
    expect(store.openId).toBe('contacts');
  });

  it('keeps the round alive while the last card is being read', () => {
    const store = useFeatureBeaconsStore();
    store.arm();
    const [last, ...rest] = [...BEACON_IDS].reverse();
    for (const id of rest) store.markSeen(id);

    // Pinned card: finishing writes the flag but waits for close().
    store.open(last);
    store.markSeen(last);
    expect(window.localStorage.getItem(WHATS_NEW_STORAGE_KEY)).toBe('1');
    expect(progress()).toBeNull();
    expect(store.enabled).toBe(true);
    expect(store.count).toBe(0);
    store.close();
    expect(store.enabled).toBe(false);
  });

  it('keeps the round alive while an unpinned card is showing', () => {
    const store = useFeatureBeaconsStore();
    store.arm();
    store.setCardShowing(true);
    for (const id of BEACON_IDS) store.markSeen(id);

    expect(window.localStorage.getItem(WHATS_NEW_STORAGE_KEY)).toBe('1');
    expect(store.enabled).toBe(true);
    store.setCardShowing(false);
    expect(store.enabled).toBe(false);
  });

  it('reset drops in-memory state but keeps stored progress; re-arming does not spend a session', () => {
    const store = useFeatureBeaconsStore();
    store.arm();
    store.markSeen('newMessage');
    store.open('contacts');

    store.reset();

    expect(store.enabled).toBe(false);
    expect(store.seen).toEqual([]);
    expect(store.sessions).toBe(0);
    expect(store.openId).toBeNull();
    expect(progress()).toEqual({ seen: ['newMessage'], sessions: 1 });

    // A reconnect within the same page load is the same session.
    store.arm();
    expect(store.sessions).toBe(1);
    expect(store.seen).toEqual(['newMessage']);
    expect(progress()).toEqual({ seen: ['newMessage'], sessions: 1 });
  });

  it('a flaky connection cannot burn through the session limit', () => {
    window.localStorage.setItem(FEATURE_BEACONS_STORAGE_KEY, JSON.stringify({
      seen: [],
      sessions: BEACON_SESSION_LIMIT - 1,
    }));
    const store = useFeatureBeaconsStore();
    for (let i = 0; i < BEACON_SESSION_LIMIT + 2; i += 1) {
      store.arm();
      store.reset();
    }
    store.arm();
    expect(store.enabled).toBe(true);
    expect(store.sessions).toBe(BEACON_SESSION_LIMIT);
    expect(progress()).toEqual({ seen: [], sessions: BEACON_SESSION_LIMIT });
  });

  it('restart forgets a retired round and arms it again as session 1', () => {
    window.localStorage.setItem(WHATS_NEW_STORAGE_KEY, '1');
    const store = useFeatureBeaconsStore();
    store.arm();
    for (const id of BEACON_IDS) store.markSeen(id);
    expect(store.enabled).toBe(false);

    store.restart();

    expect(store.enabled).toBe(true);
    expect(store.sessions).toBe(1);
    expect(store.seen).toEqual([]);
    expect(store.count).toBe(BEACON_IDS.length);
    expect(window.localStorage.getItem(WHATS_NEW_STORAGE_KEY)).toBeNull();
    expect(progress()).toEqual({ seen: [], sessions: 1 });
  });

  it('restart mid-round drops seen beacons and the open card', () => {
    window.localStorage.setItem(FEATURE_BEACONS_STORAGE_KEY, JSON.stringify({
      seen: ['newMessage'],
      sessions: BEACON_SESSION_LIMIT - 1,
    }));
    const store = useFeatureBeaconsStore();
    store.arm();
    store.open('contacts');

    store.restart();

    expect(store.openId).toBeNull();
    expect(store.seen).toEqual([]);
    expect(store.sessions).toBe(1);
    expect(progress()).toEqual({ seen: [], sessions: 1 });
  });

  it('degrades to session-only state when storage is blocked', () => {
    const blocked = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(blocked);
    const store = useFeatureBeaconsStore();

    store.arm();
    expect(store.enabled).toBe(true);
    expect(store.count).toBe(BEACON_IDS.length);

    store.markSeen('newMessage');
    expect(store.count).toBe(BEACON_IDS.length - 1);

    store.dismissAll();
    expect(store.enabled).toBe(false);
  });
});
