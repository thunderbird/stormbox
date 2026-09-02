/**
 * The celebration clip. `preloadCelebrationAudio()` runs when the gear
 * dialog opens so the bytes are buffered before the user can possibly
 * accept; `playCelebrationAudio()` must be invoked synchronously inside
 * the accepting user gesture so autoplay policy lets it start at once.
 *
 * Volume is a 0..1 gain kept in localStorage so a level chosen during one
 * celebration carries over to the next account's first unlock.
 */

import clipUrl from '../assets/mm.mp3';

export const DEFAULT_CELEBRATION_VOLUME = 0.9;
const VOLUME_STORAGE_KEY = 'stormbox.kanban.celebrationVolume.v1';

let element: HTMLAudioElement | null = null;
let volume = readStoredVolume();
const volumeListeners = new Set<(value: number) => void>();

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CELEBRATION_VOLUME;
  return Math.min(1, Math.max(0, value));
}

function readStoredVolume(): number {
  if (typeof localStorage === 'undefined') return DEFAULT_CELEBRATION_VOLUME;
  try {
    const raw = localStorage.getItem(VOLUME_STORAGE_KEY);
    return raw == null ? DEFAULT_CELEBRATION_VOLUME : clampVolume(Number(raw));
  } catch {
    return DEFAULT_CELEBRATION_VOLUME;
  }
}

function createElement(): HTMLAudioElement | null {
  if (typeof Audio !== 'function') return null;
  const audio = new Audio(clipUrl);
  audio.preload = 'auto';
  audio.volume = volume;
  return audio;
}

export function preloadCelebrationAudio(): HTMLAudioElement | null {
  if (!element) {
    element = createElement();
    try {
      element?.load();
    } catch {
      // Non-fatal: play() will fetch on demand instead.
    }
  }
  return element;
}

export function playCelebrationAudio(): Promise<void> {
  const audio = preloadCelebrationAudio();
  if (!audio) return Promise.resolve();
  try {
    audio.currentTime = 0;
  } catch {
    // Not seekable before metadata; play() starts from 0 anyway.
  }
  const started = audio.play();
  return started ? started.catch(() => {}) : Promise.resolve();
}

export function getCelebrationVolume(): number {
  return volume;
}

/** Applies to the playing clip immediately and remembers the level. */
export function setCelebrationVolume(value: number): void {
  volume = clampVolume(value);
  if (element) element.volume = volume;
  try {
    localStorage?.setItem(VOLUME_STORAGE_KEY, String(volume));
  } catch {
    // The level still applies to this playback when it cannot persist.
  }
  for (const listener of volumeListeners) listener(volume);
}

export function onCelebrationVolumeChange(listener: (value: number) => void): () => void {
  volumeListeners.add(listener);
  return () => { volumeListeners.delete(listener); };
}

/**
 * Resolves once the clip has finished (or was paused/stopped); resolves
 * at once when there is no element or playback is not in progress.
 */
export function whenCelebrationAudioEnds(): Promise<void> {
  const audio = element;
  if (!audio || audio.paused || audio.ended) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      audio.removeEventListener('ended', done);
      audio.removeEventListener('pause', done);
      resolve();
    };
    audio.addEventListener('ended', done);
    audio.addEventListener('pause', done);
  });
}

export function __resetCelebrationAudioForTests(): void {
  element = null;
  volume = readStoredVolume();
  volumeListeners.clear();
}
