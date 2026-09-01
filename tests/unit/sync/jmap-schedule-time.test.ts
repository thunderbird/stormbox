import { describe, expect, it } from 'vitest';

import {
  computeHoldFor,
  parseAbsoluteTarget,
  scheduleClockWindow,
} from '../../../src/sync/backends/jmap/schedule-time';

const NOW = Date.parse('2026-08-31T12:00:00Z');

describe('scheduled-send clock policy', () => {
  it('retains transport-specific validation around the shared parser', () => {
    expect(parseAbsoluteTarget('2026-08-31T14:00:00+02:00')).toEqual({
      targetAt: '2026-08-31T12:00:00.000Z',
      targetMs: NOW,
    });
    expect(() => parseAbsoluteTarget('2026-08-31T12:00:00'))
      .toThrow(/absolute timestamp/);
    expect(() => parseAbsoluteTarget('2026-99-99T12:00:00Z'))
      .toThrow(/scheduled time is invalid/i);
  });

  it('falls back deliberately to local time without a valid Date reference', () => {
    expect(scheduleClockWindow({}, NOW)).toEqual({
      source: 'local',
      lowerMs: NOW,
      upperMs: NOW,
    });
    expect(computeHoldFor({
      targetAt: new Date(NOW + 1).toISOString(),
      maxDelayedSend: 60,
      transport: {},
      localNowMs: NOW,
    })).toMatchObject({ holdFor: 1, clock: { source: 'local' } });
  });

  it('uses the upper server bound for expiry and rounds HOLDFOR up from the lower bound', () => {
    const transport = {
      serverClockReference: {
        capturedAtMs: NOW,
        lowerOffsetMs: 1_000,
        uncertaintyMs: 999,
      },
    };
    expect(computeHoldFor({
      targetAt: new Date(NOW + 2_001).toISOString(),
      maxDelayedSend: 60,
      transport,
      localNowMs: NOW,
    })).toMatchObject({
      holdFor: 2,
      clock: {
        source: 'server',
        lowerMs: NOW + 1_000,
        upperMs: NOW + 1_999,
      },
    });
    expect(() => computeHoldFor({
      targetAt: new Date(NOW + 1_999).toISOString(),
      maxDelayedSend: 60,
      transport,
      localNowMs: NOW,
    })).toThrow(/passed/);
  });

  it('rejects the conservative integer delay above the server limit', () => {
    expect(() => computeHoldFor({
      targetAt: new Date(NOW + 60_001).toISOString(),
      maxDelayedSend: 60,
      transport: {},
      localNowMs: NOW,
    })).toThrow(/up to 60 seconds/);
  });

  it('ignores stale or unbounded Date references', () => {
    expect(scheduleClockWindow({
      serverClockReference: {
        capturedAtMs: NOW - 11 * 60_000,
        lowerOffsetMs: 500,
        uncertaintyMs: 999,
      },
    }, NOW).source).toBe('local');
    expect(scheduleClockWindow({
      serverClockReference: {
        capturedAtMs: NOW,
        lowerOffsetMs: 25 * 60 * 60_000,
        uncertaintyMs: 999,
      },
    }, NOW).source).toBe('local');
  });
});
