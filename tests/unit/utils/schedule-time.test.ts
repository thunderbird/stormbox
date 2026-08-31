import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  detectTimeZone,
  instantToWallTime,
  isUsableTimeZone,
  pickerValueToWallTime,
  resolveCustomSchedule,
  resolveSchedulePreset,
  scheduleClockWindowFromReference,
  searchTimeZoneOptions,
  validateScheduleTarget,
  wallTimeToPickerValue,
  wallTimeToUtc,
} from '../../../src/utils/schedule-time';

const THIRTY_DAYS = 30 * 24 * 60 * 60;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('time zone discovery', () => {
  it('validates zones and runtime-supported canonical aliases through Intl', () => {
    expect(isUsableTimeZone('America/New_York')).toBe(true);
    expect(isUsableTimeZone('US/Eastern')).toBe(true);
    expect(isUsableTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isUsableTimeZone(' America/New_York ')).toBe(false);
  });

  it('detects the runtime zone with a safe UTC fallback', () => {
    const RealDateTimeFormat = Intl.DateTimeFormat;
    function TestDateTimeFormat(
      locales?: Intl.LocalesArgument,
      options?: Intl.DateTimeFormatOptions,
    ): Intl.DateTimeFormat {
      const formatter = new RealDateTimeFormat(locales, options);
      if (locales == null && options == null) {
        const resolvedOptions = formatter.resolvedOptions.bind(formatter);
        formatter.resolvedOptions = () => ({
          ...resolvedOptions(),
          timeZone: 'Europe/Paris',
        });
      }
      return formatter;
    }
    vi.stubGlobal('Intl', {
      DateTimeFormat: TestDateTimeFormat as typeof Intl.DateTimeFormat,
    });
    expect(detectTimeZone()).toBe('Europe/Paris');

    vi.stubGlobal('Intl', undefined);
    expect(detectTimeZone()).toBe('UTC');
    expect(isUsableTimeZone('UTC')).toBe(true);
  });

  it('offers bounded searchable options including UTC and the current zone', () => {
    const options = searchTimeZoneOptions({
      search: 'new york',
      currentTimeZone: 'America/New_York',
      limit: 10,
    });
    expect(options).toContainEqual({
      id: 'America/New_York',
      label: 'America/New York',
    });
    expect(searchTimeZoneOptions({
      currentTimeZone: 'Pacific/Honolulu',
      limit: 2000,
    }).length).toBeLessThanOrEqual(200);
    expect(searchTimeZoneOptions({ search: 'utc' })).toContainEqual({
      id: 'UTC',
      label: 'UTC',
    });
  });
});

describe('wall time conversion', () => {
  it('bridges picker fields through UTC without host-local Date setters', () => {
    const wallTime = {
      year: 2026,
      month: 11,
      day: 1,
      hour: 1,
      minute: 30,
    };
    const pickerValue = wallTimeToPickerValue(wallTime);

    expect(pickerValue).toBe('2026-11-01T01:30:00.000Z');
    expect(pickerValueToWallTime('2026-11-01T01:30:00.000Z')).toEqual(wallTime);
    expect(instantToWallTime(
      '2026-11-01T05:30:00.000Z',
      'America/New_York',
    )).toMatchObject(wallTime);
  });

  it('rejects nonexistent spring-forward wall times', () => {
    expect(wallTimeToUtc({
      year: 2026,
      month: 3,
      day: 8,
      hour: 2,
      minute: 30,
    }, 'America/New_York')).toEqual({
      ok: false,
      reason: 'nonexistentWallTime',
      message: 'That local time does not exist because the clock changes then.',
    });
  });

  it('resolves an ambiguous fall-back wall time to the earlier instant', () => {
    expect(wallTimeToUtc({
      year: 2026,
      month: 11,
      day: 1,
      hour: 1,
      minute: 30,
    }, 'America/New_York')).toEqual({
      ok: true,
      targetAt: '2026-11-01T05:30:00.000Z',
      targetMs: Date.parse('2026-11-01T05:30:00.000Z'),
      ambiguous: true,
    });
  });

  it('round-trips a custom picker value and applies future/cap validation', () => {
    expect(resolveCustomSchedule({
      wallTime: {
        year: 2027,
        month: 1,
        day: 1,
        hour: 8,
        minute: 15,
      },
      timeZone: 'Asia/Tokyo',
      maxDelayedSend: THIRTY_DAYS,
      localNowMs: Date.parse('2026-12-31T22:00:00Z'),
    })).toMatchObject({
      ok: true,
      targetAt: '2026-12-31T23:15:00.000Z',
      ambiguous: false,
    });

    expect(resolveCustomSchedule({
      wallTime: {
        year: 2026,
        month: 3,
        day: 8,
        hour: 2,
        minute: 30,
      },
      timeZone: 'America/New_York',
      maxDelayedSend: THIRTY_DAYS,
      localNowMs: Date.parse('2026-03-01T00:00:00Z'),
    })).toMatchObject({ ok: false, reason: 'nonexistentWallTime' });
  });
});

describe('Fastmail-style schedule presets', () => {
  it('resolves every preset in the selected zone', () => {
    const options = {
      now: '2026-08-31T12:00:00.000Z',
      timeZone: 'America/New_York',
      maxDelayedSend: THIRTY_DAYS,
    };
    expect(resolveSchedulePreset('laterToday', options))
      .toMatchObject({ available: true, targetAt: '2026-08-31T15:00:00.000Z' });
    expect(resolveSchedulePreset('thisEvening', options))
      .toMatchObject({ available: true, targetAt: '2026-08-31T22:00:00.000Z' });
    expect(resolveSchedulePreset('tomorrow', options))
      .toMatchObject({ available: true, targetAt: '2026-09-01T12:00:00.000Z' });
    expect(resolveSchedulePreset('thisWeekend', options))
      .toMatchObject({ available: true, targetAt: '2026-09-05T12:00:00.000Z' });
    expect(resolveSchedulePreset('nextWeek', options))
      .toMatchObject({ available: true, targetAt: '2026-09-07T12:00:00.000Z' });
    expect(resolveSchedulePreset('tomorrow', options).resolvedLabel).toContain('Sep');
  });

  it('uses zoned calendar arithmetic across month and year rollover', () => {
    expect(resolveSchedulePreset('laterToday', {
      now: '2027-01-01T03:15:00.000Z',
      timeZone: 'America/New_York',
      maxDelayedSend: THIRTY_DAYS,
    })).toMatchObject({
      available: false,
      reason: 'expired',
      targetAt: null,
    });
    expect(resolveSchedulePreset('tomorrow', {
      now: '2026-12-31T14:00:00.000Z',
      timeZone: 'Asia/Tokyo',
      maxDelayedSend: THIRTY_DAYS,
    })).toMatchObject({
      available: true,
      targetAt: '2026-12-31T23:00:00.000Z',
    });
  });

  it('makes evening unavailable at its exact boundary', () => {
    expect(resolveSchedulePreset('thisEvening', {
      now: '2026-08-31T22:00:00.000Z',
      timeZone: 'America/New_York',
      maxDelayedSend: THIRTY_DAYS,
    })).toMatchObject({ available: false, reason: 'expired' });
    expect(resolveSchedulePreset('thisEvening', {
      now: '2026-08-31T21:59:59.999Z',
      timeZone: 'America/New_York',
      maxDelayedSend: THIRTY_DAYS,
    })).toMatchObject({
      available: true,
      targetAt: '2026-08-31T22:00:00.000Z',
    });
  });

  it('uses the following Saturday and Monday even when already on that weekday', () => {
    expect(resolveSchedulePreset('thisWeekend', {
      now: '2026-09-05T06:00:00.000Z',
      timeZone: 'Europe/London',
      maxDelayedSend: THIRTY_DAYS,
    })).toMatchObject({
      available: true,
      targetAt: '2026-09-12T07:00:00.000Z',
    });
    expect(resolveSchedulePreset('thisWeekend', {
      now: '2026-09-06T12:00:00.000Z',
      timeZone: 'UTC',
      maxDelayedSend: THIRTY_DAYS,
    })).toMatchObject({
      available: true,
      targetAt: '2026-09-12T08:00:00.000Z',
    });
    expect(resolveSchedulePreset('nextWeek', {
      now: '2026-08-31T06:00:00.000Z',
      timeZone: 'Europe/London',
      maxDelayedSend: THIRTY_DAYS,
    })).toMatchObject({
      available: true,
      targetAt: '2026-09-07T07:00:00.000Z',
    });
  });

  it('keeps presets correct across a DST offset change', () => {
    expect(resolveSchedulePreset('tomorrow', {
      now: '2026-03-07T17:00:00.000Z',
      timeZone: 'America/New_York',
      maxDelayedSend: THIRTY_DAYS,
    })).toMatchObject({
      available: true,
      targetAt: '2026-03-08T12:00:00.000Z',
    });
    expect(resolveSchedulePreset('tomorrow', {
      now: '2026-10-03T12:00:00.000Z',
      timeZone: 'Australia/Sydney',
      maxDelayedSend: THIRTY_DAYS,
    })).toMatchObject({
      available: true,
      targetAt: '2026-10-03T21:00:00.000Z',
    });
  });
});

describe('schedule target limits', () => {
  const now = Date.parse('2026-08-31T12:00:00.000Z');
  const reference = {
    capturedAtMs: now,
    lowerOffsetMs: 1_000,
    uncertaintyMs: 999,
  };

  it('uses the upper clock bound for expiry and lower bound for the cap', () => {
    const clock = scheduleClockWindowFromReference(reference, now);
    expect(validateScheduleTarget({
      targetAt: new Date(clock.upperMs).toISOString(),
      maxDelayedSend: 60,
      clockWindow: clock,
      localNowMs: now,
    })).toMatchObject({ ok: false, reason: 'expired' });
    expect(validateScheduleTarget({
      targetAt: new Date(clock.lowerMs + 60_001).toISOString(),
      maxDelayedSend: 60,
      clockWindow: clock,
      localNowMs: now,
    })).toMatchObject({ ok: false, reason: 'tooFar' });
    expect(validateScheduleTarget({
      targetAt: new Date(clock.lowerMs + 60_000).toISOString(),
      maxDelayedSend: 60,
      clockWindow: clock,
      localNowMs: now,
    })).toMatchObject({ ok: true, holdFor: 60 });
  });

  it('returns typed reasons for malformed targets and capabilities', () => {
    expect(validateScheduleTarget({
      targetAt: '2026-09-01 12:00',
      maxDelayedSend: 60,
      localNowMs: now,
    })).toMatchObject({ ok: false, reason: 'invalidTarget' });
    expect(validateScheduleTarget({
      targetAt: new Date(now + 1_000).toISOString(),
      maxDelayedSend: '60',
      localNowMs: now,
    })).toMatchObject({ ok: false, reason: 'capabilityUnavailable' });
  });
});
