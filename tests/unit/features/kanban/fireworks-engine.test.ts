import { describe, expect, it } from 'vitest';

import { FireworksShow } from '../../../../src/features/kanban/celebration/fireworks-engine';

/** Deterministic LCG so the show is reproducible. */
function seeded(seed = 7) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe('FireworksShow', () => {
  it('opens with bursts already in the air, not just rising rockets', () => {
    const show = new FireworksShow(1280, 800, { random: seeded(), particlesPerBurst: 40 });
    expect(show.particles.length).toBeGreaterThanOrEqual(80);
    expect(show.rockets.length).toBeGreaterThan(0);
  });

  it('is over close to durationMs, with launches stopped early enough for the tail to fade', () => {
    const durationMs = 12_000;
    const show = new FireworksShow(1280, 800, { random: seeded(3), durationMs });
    let elapsed = 0;
    let lastLaunchSeen = 0;
    while (!show.finished && elapsed < 30_000) {
      const rocketsBefore = show.rockets.length;
      show.step(16);
      elapsed += 16;
      if (show.rockets.length > rocketsBefore) lastLaunchSeen = elapsed;
    }
    expect(show.finished).toBe(true);
    expect(lastLaunchSeen).toBeLessThan(durationMs - 2_000);
    expect(elapsed).toBeGreaterThan(durationMs - 3_000);
    expect(elapsed).toBeLessThanOrEqual(durationMs + 200);
  });

  it('keeps launching through the main body of the show', () => {
    const show = new FireworksShow(1280, 800, { random: seeded(11), durationMs: 12_000 });
    let elapsed = 0;
    while (elapsed < 6_000) {
      show.step(16);
      elapsed += 16;
    }
    expect(show.launching).toBe(true);
    expect(show.particles.length + show.rockets.length).toBeGreaterThan(0);
  });
});
