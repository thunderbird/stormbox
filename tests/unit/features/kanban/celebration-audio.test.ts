// @vitest-environment happy-dom

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import {
  __resetCelebrationAudioForTests,
  DEFAULT_CELEBRATION_VOLUME,
  getCelebrationVolume,
  onCelebrationVolumeChange,
  playCelebrationAudio,
  preloadCelebrationAudio,
  setCelebrationVolume,
  whenCelebrationAudioEnds,
} from '../../../../src/features/kanban/celebration/audio';

const VOLUME_KEY = 'stormbox.kanban.celebrationVolume.v1';

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];

  src: string;
  preload = '';
  volume = 1;
  currentTime = 0;
  paused = true;
  ended = false;
  load = vi.fn();
  pause = vi.fn(() => {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  });
  play = vi.fn(() => {
    this.paused = false;
    return Promise.resolve();
  });

  constructor(src: string) {
    super();
    this.src = src;
    FakeAudio.instances.push(this);
  }

  finish() {
    this.ended = true;
    this.paused = true;
    this.dispatchEvent(new Event('ended'));
  }
}

const originalAudio = globalThis.Audio;

beforeEach(() => {
  FakeAudio.instances = [];
  localStorage.clear();
  (globalThis as any).Audio = FakeAudio;
  __resetCelebrationAudioForTests();
});

afterEach(() => {
  (globalThis as any).Audio = originalAudio;
  __resetCelebrationAudioForTests();
});

describe('celebration audio', () => {
  it('preload creates one buffered element pointing at the bundled clip', () => {
    const first = preloadCelebrationAudio() as unknown as FakeAudio;
    const second = preloadCelebrationAudio() as unknown as FakeAudio;

    expect(FakeAudio.instances).toHaveLength(1);
    expect(first).toBe(second);
    expect(first.src).toMatch(/mm\.mp3$/);
    expect(first.preload).toBe('auto');
    expect(first.load).toHaveBeenCalledTimes(1);
    expect(first.volume).toBeLessThan(1);
  });

  it('play reuses the preloaded element, rewinds it and starts synchronously', async () => {
    const element = preloadCelebrationAudio() as unknown as FakeAudio;
    element.currentTime = 12;

    const started = playCelebrationAudio();

    // play() must already have been called before any await so it stays
    // inside the accepting user gesture for autoplay policy.
    expect(element.play).toHaveBeenCalledTimes(1);
    expect(element.currentTime).toBe(0);
    expect(FakeAudio.instances).toHaveLength(1);
    await expect(started).resolves.toBeUndefined();
  });

  it('play without a prior preload still works from a fresh element', async () => {
    await playCelebrationAudio();
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0].play).toHaveBeenCalledTimes(1);
  });

  it('swallows a rejected play() so a blocked autoplay never surfaces', async () => {
    const element = preloadCelebrationAudio() as unknown as FakeAudio;
    element.play.mockReturnValue(Promise.reject(new Error('NotAllowedError')));
    await expect(playCelebrationAudio()).resolves.toBeUndefined();
  });

  it('is a no-op where Audio is unavailable', async () => {
    (globalThis as any).Audio = undefined;
    __resetCelebrationAudioForTests();
    expect(preloadCelebrationAudio()).toBeNull();
    await expect(playCelebrationAudio()).resolves.toBeUndefined();
    expect(getCelebrationVolume()).toBe(DEFAULT_CELEBRATION_VOLUME);
    expect(() => setCelebrationVolume(0.2)).not.toThrow();
    await expect(whenCelebrationAudioEnds()).resolves.toBeUndefined();
  });
});

describe('celebration volume', () => {
  it('starts at the default, is clamped, applied live and remembered', () => {
    expect(getCelebrationVolume()).toBe(DEFAULT_CELEBRATION_VOLUME);
    const element = preloadCelebrationAudio() as unknown as FakeAudio;
    expect(element.volume).toBe(DEFAULT_CELEBRATION_VOLUME);

    const seen: number[] = [];
    const stop = onCelebrationVolumeChange((v) => seen.push(v));

    setCelebrationVolume(0.3);
    expect(element.volume).toBe(0.3);
    expect(localStorage.getItem(VOLUME_KEY)).toBe('0.3');
    setCelebrationVolume(7);
    expect(element.volume).toBe(1);
    setCelebrationVolume(-1);
    expect(element.volume).toBe(0);
    setCelebrationVolume(Number.NaN);
    expect(getCelebrationVolume()).toBe(DEFAULT_CELEBRATION_VOLUME);
    expect(seen).toEqual([0.3, 1, 0, DEFAULT_CELEBRATION_VOLUME]);

    stop();
    setCelebrationVolume(0.5);
    expect(seen).toHaveLength(4);
  });

  it('a stored level is used for the next element and survives a reset', () => {
    localStorage.setItem(VOLUME_KEY, '0.25');
    __resetCelebrationAudioForTests();
    expect(getCelebrationVolume()).toBe(0.25);
    const element = preloadCelebrationAudio() as unknown as FakeAudio;
    expect(element.volume).toBe(0.25);
  });

  it('ignores garbage in storage', () => {
    localStorage.setItem(VOLUME_KEY, 'loud');
    __resetCelebrationAudioForTests();
    expect(getCelebrationVolume()).toBe(DEFAULT_CELEBRATION_VOLUME);
  });

  it('setting the volume mid-play keeps the clip going', async () => {
    const element = preloadCelebrationAudio() as unknown as FakeAudio;
    await playCelebrationAudio();
    setCelebrationVolume(0.1);
    expect(element.pause).not.toHaveBeenCalled();
    expect(element.play).toHaveBeenCalledTimes(1);
    expect(element.paused).toBe(false);
  });
});

describe('whenCelebrationAudioEnds', () => {
  it('resolves when the clip finishes', async () => {
    const element = preloadCelebrationAudio() as unknown as FakeAudio;
    await playCelebrationAudio();
    let settled = false;
    const done = whenCelebrationAudioEnds().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    element.finish();
    await done;
    expect(settled).toBe(true);
  });

  it('resolves when the clip is paused and immediately when nothing is playing', async () => {
    const element = preloadCelebrationAudio() as unknown as FakeAudio;
    await playCelebrationAudio();
    const done = whenCelebrationAudioEnds();
    element.pause();
    await expect(done).resolves.toBeUndefined();

    await expect(whenCelebrationAudioEnds()).resolves.toBeUndefined();
  });
});
