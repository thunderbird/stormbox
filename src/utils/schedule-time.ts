export const ABSOLUTE_TIMESTAMP_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/i;
export const SERVER_CLOCK_MAX_AGE_MS = 10 * 60 * 1_000;
export const SERVER_CLOCK_MAX_ABS_OFFSET_MS = 24 * 60 * 60 * 1_000;
export const SERVER_CLOCK_MAX_UNCERTAINTY_MS = 31_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const OFFSET_SAMPLE_STEP_MS = 6 * 60 * 60 * 1_000;

export const SCHEDULE_PRESETS = [
  { id: 'laterToday', label: 'Later today' },
  { id: 'thisEvening', label: 'This evening' },
  { id: 'tomorrow', label: 'Tomorrow' },
  { id: 'thisWeekend', label: 'This weekend' },
  { id: 'nextWeek', label: 'Next week' },
] as const;

export type SchedulePresetId = (typeof SCHEDULE_PRESETS)[number]['id'];

export interface WallDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
}

interface NormalizedWallDateTime extends WallDateTime {
  second: number;
}

export interface ServerClockReferenceLike {
  capturedAtMs: number;
  lowerOffsetMs: number;
  uncertaintyMs: number;
}

export interface ScheduleClockWindow {
  source: 'server' | 'local';
  lowerMs: number;
  upperMs: number;
}

export type ScheduleTargetValidationReason =
  | 'invalidTarget'
  | 'capabilityUnavailable'
  | 'expired'
  | 'tooFar';

export type ScheduleTargetValidation =
  | {
      ok: true;
      targetAt: string;
      targetMs: number;
      holdFor: number;
      clock: ScheduleClockWindow;
    }
  | {
      ok: false;
      reason: ScheduleTargetValidationReason;
      message: string;
      clock: ScheduleClockWindow;
    };

export type WallTimeConversionReason =
  | 'invalidTimeZone'
  | 'invalidWallTime'
  | 'nonexistentWallTime';

export type WallTimeConversion =
  | {
      ok: true;
      targetAt: string;
      targetMs: number;
      ambiguous: boolean;
    }
  | {
      ok: false;
      reason: WallTimeConversionReason;
      message: string;
    };

export type ScheduleResolutionReason =
  | WallTimeConversionReason
  | ScheduleTargetValidationReason;

export interface SchedulePresetResolution {
  id: SchedulePresetId;
  label: string;
  available: boolean;
  targetAt: string | null;
  resolvedLabel: string | null;
  reason: ScheduleResolutionReason | null;
  message: string | null;
}

export type CustomScheduleResolution =
  | {
      ok: true;
      targetAt: string;
      resolvedLabel: string;
      ambiguous: boolean;
    }
  | {
      ok: false;
      reason: ScheduleResolutionReason;
      message: string;
    };

export interface TimeZoneOption {
  id: string;
  label: string;
}

const FALLBACK_TIME_ZONES = [
  'UTC',
  'Africa/Johannesburg',
  'America/Anchorage',
  'America/Chicago',
  'America/Denver',
  'America/Halifax',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/New_York',
  'America/Phoenix',
  'America/Sao_Paulo',
  'Asia/Dubai',
  'Asia/Hong_Kong',
  'Asia/Kolkata',
  'Asia/Seoul',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Adelaide',
  'Australia/Brisbane',
  'Australia/Sydney',
  'Europe/Berlin',
  'Europe/London',
  'Europe/Moscow',
  'Europe/Paris',
  'Pacific/Auckland',
  'Pacific/Honolulu',
] as const;

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

function intlObject(): typeof Intl | null {
  try {
    return typeof globalThis.Intl === 'object' && globalThis.Intl !== null
      ? globalThis.Intl
      : null;
  } catch {
    return null;
  }
}

export function isUsableTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    return false;
  }
  const intl = intlObject();
  if (!intl?.DateTimeFormat) return value === 'UTC';
  try {
    new intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function detectTimeZone(): string {
  const intl = intlObject();
  try {
    const detected = intl?.DateTimeFormat?.().resolvedOptions().timeZone;
    return isUsableTimeZone(detected) ? detected : 'UTC';
  } catch {
    return 'UTC';
  }
}

function supportedTimeZones(): string[] {
  const intl = intlObject() as (typeof Intl & {
    supportedValuesOf?: (key: 'timeZone') => string[];
  }) | null;
  try {
    const supported = intl?.supportedValuesOf?.call(intl, 'timeZone');
    if (Array.isArray(supported)) {
      return supported.filter(isUsableTimeZone);
    }
  } catch {
    // The bounded fallback remains available on older Intl implementations.
  }
  return [...FALLBACK_TIME_ZONES];
}

export function searchTimeZoneOptions({
  search = '',
  currentTimeZone = detectTimeZone(),
  limit = 50,
}: {
  search?: string;
  currentTimeZone?: string;
  limit?: number;
} = {}): TimeZoneOption[] {
  const boundedLimit = Number.isSafeInteger(limit)
    ? Math.min(200, Math.max(1, limit))
    : 50;
  const zones = new Set<string>(['UTC']);
  if (isUsableTimeZone(currentTimeZone)) zones.add(currentTimeZone);
  for (const zone of supportedTimeZones()) zones.add(zone);
  const needle = search.trim().toLocaleLowerCase();
  return [...zones]
    .filter((zone) => {
      if (!needle) return true;
      const searchable = `${zone} ${zone.replaceAll('_', ' ').replaceAll('/', ' ')}`;
      return searchable.toLocaleLowerCase().includes(needle);
    })
    .sort((left, right) => left.localeCompare(right))
    .slice(0, boundedLimit)
    .map((zone) => ({ id: zone, label: zone.replaceAll('_', ' ') }));
}

function validClockReference(
  reference: unknown,
  localNowMs: number,
): reference is ServerClockReferenceLike {
  if (!reference || typeof reference !== 'object') return false;
  const value = reference as ServerClockReferenceLike;
  const ageMs = localNowMs - value.capturedAtMs;
  return Number.isFinite(value.capturedAtMs)
    && Number.isFinite(value.lowerOffsetMs)
    && Number.isFinite(value.uncertaintyMs)
    && ageMs >= 0
    && ageMs <= SERVER_CLOCK_MAX_AGE_MS
    && Math.abs(value.lowerOffsetMs) <= SERVER_CLOCK_MAX_ABS_OFFSET_MS
    && value.uncertaintyMs >= 0
    && value.uncertaintyMs <= SERVER_CLOCK_MAX_UNCERTAINTY_MS
    && Math.abs(value.lowerOffsetMs + value.uncertaintyMs)
      <= SERVER_CLOCK_MAX_ABS_OFFSET_MS;
}

export function scheduleClockWindowFromReference(
  reference: unknown,
  localNowMs = Date.now(),
): ScheduleClockWindow {
  if (!validClockReference(reference, localNowMs)) {
    return { source: 'local', lowerMs: localNowMs, upperMs: localNowMs };
  }
  const lowerMs = localNowMs + reference.lowerOffsetMs;
  return {
    source: 'server',
    lowerMs,
    upperMs: lowerMs + reference.uncertaintyMs,
  };
}

function normalizedClockWindow(
  window: ScheduleClockWindow | undefined,
  localNowMs: number,
): ScheduleClockWindow {
  if (
    window
    && (window.source === 'server' || window.source === 'local')
    && Number.isFinite(window.lowerMs)
    && Number.isFinite(window.upperMs)
    && window.lowerMs <= window.upperMs
  ) {
    return window;
  }
  return { source: 'local', lowerMs: localNowMs, upperMs: localNowMs };
}

export function parseAbsoluteTimestamp(
  targetAt: unknown,
): { targetAt: string; targetMs: number } | null {
  let targetMs: number;
  if (targetAt instanceof Date) {
    targetMs = targetAt.getTime();
  } else if (typeof targetAt === 'number') {
    targetMs = targetAt;
  } else if (
    typeof targetAt === 'string'
    && ABSOLUTE_TIMESTAMP_PATTERN.test(targetAt)
  ) {
    targetMs = Date.parse(targetAt);
  } else {
    return null;
  }
  if (!Number.isFinite(targetMs)) return null;
  return { targetAt: new Date(targetMs).toISOString(), targetMs };
}

export function validateScheduleTarget({
  targetAt,
  maxDelayedSend,
  clockWindow,
  serverClockReference,
  localNowMs = Date.now(),
}: {
  targetAt: unknown;
  maxDelayedSend: unknown;
  clockWindow?: ScheduleClockWindow;
  serverClockReference?: unknown;
  localNowMs?: number;
}): ScheduleTargetValidation {
  const clock = clockWindow
    ? normalizedClockWindow(clockWindow, localNowMs)
    : scheduleClockWindowFromReference(serverClockReference, localNowMs);
  const parsed = parseAbsoluteTimestamp(targetAt);
  if (!parsed) {
    return {
      ok: false,
      reason: 'invalidTarget',
      message: 'Choose a valid scheduled time.',
      clock,
    };
  }
  if (!Number.isSafeInteger(maxDelayedSend) || Number(maxDelayedSend) < 1) {
    return {
      ok: false,
      reason: 'capabilityUnavailable',
      message: 'Scheduled sending is not supported by this account.',
      clock,
    };
  }
  if (parsed.targetMs <= clock.upperMs) {
    return {
      ok: false,
      reason: 'expired',
      message: 'Choose a scheduled time in the future.',
      clock,
    };
  }
  const holdFor = Math.ceil((parsed.targetMs - clock.lowerMs) / 1_000);
  if (!Number.isSafeInteger(holdFor) || holdFor < 1) {
    return {
      ok: false,
      reason: 'expired',
      message: 'Choose a scheduled time in the future.',
      clock,
    };
  }
  if (holdFor > Number(maxDelayedSend)) {
    return {
      ok: false,
      reason: 'tooFar',
      message: `Choose a time within ${maxDelayedSend} seconds.`,
      clock,
    };
  }
  return { ok: true, ...parsed, holdFor, clock };
}

function wallEpochMs(value: NormalizedWallDateTime): number {
  const date = new Date(0);
  date.setUTCFullYear(value.year, value.month - 1, value.day);
  date.setUTCHours(value.hour, value.minute, value.second, 0);
  return date.getTime();
}

function normalizedWallTime(value: WallDateTime): NormalizedWallDateTime | null {
  const candidate = {
    year: Number(value?.year),
    month: Number(value?.month),
    day: Number(value?.day),
    hour: Number(value?.hour),
    minute: Number(value?.minute),
    second: value?.second == null ? 0 : Number(value.second),
  };
  if (
    !Object.values(candidate).every(Number.isSafeInteger)
    || candidate.year < 1
    || candidate.year > 9999
    || candidate.month < 1
    || candidate.month > 12
    || candidate.day < 1
    || candidate.day > 31
    || candidate.hour < 0
    || candidate.hour > 23
    || candidate.minute < 0
    || candidate.minute > 59
    || candidate.second < 0
    || candidate.second > 59
  ) {
    return null;
  }
  const epoch = wallEpochMs(candidate);
  const roundTrip = new Date(epoch);
  if (
    roundTrip.getUTCFullYear() !== candidate.year
    || roundTrip.getUTCMonth() + 1 !== candidate.month
    || roundTrip.getUTCDate() !== candidate.day
    || roundTrip.getUTCHours() !== candidate.hour
    || roundTrip.getUTCMinutes() !== candidate.minute
    || roundTrip.getUTCSeconds() !== candidate.second
  ) {
    return null;
  }
  return candidate;
}

function sameWallTime(
  left: NormalizedWallDateTime,
  right: NormalizedWallDateTime,
): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute
    && left.second === right.second;
}

function utcWallParts(instantMs: number): NormalizedWallDateTime {
  const date = new Date(instantMs);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

function wallFormatter(timeZone: string): Intl.DateTimeFormat | null {
  const cached = wallFormatters.get(timeZone);
  if (cached) return cached;
  const intl = intlObject();
  if (!intl?.DateTimeFormat) return null;
  try {
    const formatter = new intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    wallFormatters.set(timeZone, formatter);
    return formatter;
  } catch {
    return null;
  }
}

function wallPartsAt(instantMs: number, timeZone: string): NormalizedWallDateTime | null {
  const formatter = wallFormatter(timeZone);
  if (!formatter) return timeZone === 'UTC' ? utcWallParts(instantMs) : null;
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(instantMs))) {
    if (
      part.type === 'year'
      || part.type === 'month'
      || part.type === 'day'
      || part.type === 'hour'
      || part.type === 'minute'
      || part.type === 'second'
    ) {
      values[part.type] = Number(part.value);
    }
  }
  const result = normalizedWallTime({
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  });
  return result;
}

/**
 * Ambiguous fall-back wall times map to the earlier matching UTC instant.
 * Nonexistent spring-forward wall times have no matching instant and fail.
 */
export function wallTimeToUtc(
  wallTime: WallDateTime,
  timeZone: string,
): WallTimeConversion {
  if (!isUsableTimeZone(timeZone)) {
    return {
      ok: false,
      reason: 'invalidTimeZone',
      message: 'Choose a valid time zone.',
    };
  }
  const wall = normalizedWallTime(wallTime);
  if (!wall) {
    return {
      ok: false,
      reason: 'invalidWallTime',
      message: 'Choose a valid date and time.',
    };
  }
  const naiveMs = wallEpochMs(wall);
  const offsets = new Set<number>();
  for (
    let sampleMs = naiveMs - 3 * DAY_MS;
    sampleMs <= naiveMs + 3 * DAY_MS;
    sampleMs += OFFSET_SAMPLE_STEP_MS
  ) {
    const sampleWall = wallPartsAt(sampleMs, timeZone);
    if (sampleWall) offsets.add(wallEpochMs(sampleWall) - sampleMs);
  }
  const candidates = [...offsets]
    .map((offset) => naiveMs - offset)
    .filter((candidateMs) => {
      const roundTrip = wallPartsAt(candidateMs, timeZone);
      return roundTrip !== null && sameWallTime(roundTrip, wall);
    })
    .sort((left, right) => left - right);
  const uniqueCandidates = [...new Set(candidates)];
  if (uniqueCandidates.length === 0) {
    return {
      ok: false,
      reason: 'nonexistentWallTime',
      message: 'That local time does not exist because the clock changes then.',
    };
  }
  const targetMs = uniqueCandidates[0];
  return {
    ok: true,
    targetAt: new Date(targetMs).toISOString(),
    targetMs,
    ambiguous: uniqueCandidates.length > 1,
  };
}

function wallTimeAt(instantMs: number, timeZone: string): NormalizedWallDateTime | null {
  if (!Number.isFinite(instantMs) || !isUsableTimeZone(timeZone)) return null;
  return wallPartsAt(instantMs, timeZone);
}

export function instantToWallTime(
  instant: string | number | Date,
  timeZone: string,
): WallDateTime | null {
  const parsed = parseAbsoluteTimestamp(instant);
  if (!parsed) return null;
  return wallTimeAt(parsed.targetMs, timeZone);
}

/**
 * VueDatePicker runs in the neutral UTC timezone so these ISO fields remain
 * wall fields. The selected IANA zone is applied only by wallTimeToUtc.
 */
export function wallTimeToPickerValue(wallTime: WallDateTime): string | null {
  const normalized = normalizedWallTime(wallTime);
  return normalized ? new Date(wallEpochMs(normalized)).toISOString() : null;
}

export function pickerValueToWallTime(value: unknown): WallDateTime | null {
  const parsed = parseAbsoluteTimestamp(value);
  if (!parsed) return null;
  const wall = utcWallParts(parsed.targetMs);
  return {
    year: wall.year,
    month: wall.month,
    day: wall.day,
    hour: wall.hour,
    minute: wall.minute,
  };
}

function shiftWall(
  wall: NormalizedWallDateTime,
  { days = 0, hours = 0 }: { days?: number; hours?: number },
): NormalizedWallDateTime {
  return utcWallParts(wallEpochMs(wall) + days * DAY_MS + hours * 60 * 60 * 1_000);
}

function nextWeekday(
  wall: NormalizedWallDateTime,
  weekday: number,
): NormalizedWallDateTime {
  const currentWeekday = new Date(wallEpochMs(wall)).getUTCDay();
  const days = ((weekday - currentWeekday + 6) % 7) + 1;
  return shiftWall(wall, { days });
}

function presetWallTime(
  preset: SchedulePresetId,
  now: NormalizedWallDateTime,
): NormalizedWallDateTime {
  switch (preset) {
    case 'laterToday':
      return shiftWall({ ...now, minute: 0, second: 0 }, { hours: 3 });
    case 'thisEvening':
      return { ...now, hour: 18, minute: 0, second: 0 };
    case 'tomorrow':
      return { ...shiftWall(now, { days: 1 }), hour: 8, minute: 0, second: 0 };
    case 'thisWeekend':
      return { ...nextWeekday(now, 6), hour: 8, minute: 0, second: 0 };
    case 'nextWeek':
      return { ...nextWeekday(now, 1), hour: 8, minute: 0, second: 0 };
    default: {
      const exhaustive: never = preset;
      return exhaustive;
    }
  }
}

function sameWallDate(
  left: NormalizedWallDateTime,
  right: NormalizedWallDateTime,
): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day;
}

export function formatScheduleTarget(
  targetAt: string | number | Date,
  timeZone: string,
  locale = 'en-US',
): string {
  const parsed = parseAbsoluteTimestamp(targetAt);
  if (!parsed) return '';
  const intl = intlObject();
  if (!intl?.DateTimeFormat) return parsed.targetAt;
  try {
    return new intl.DateTimeFormat(locale, {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(parsed.targetMs));
  } catch {
    return parsed.targetAt;
  }
}

function unavailablePreset(
  preset: (typeof SCHEDULE_PRESETS)[number],
  reason: ScheduleResolutionReason,
  message: string,
): SchedulePresetResolution {
  return {
    ...preset,
    available: false,
    targetAt: null,
    resolvedLabel: null,
    reason,
    message,
  };
}

export function resolveSchedulePreset(
  id: SchedulePresetId,
  {
    now = Date.now(),
    timeZone,
    maxDelayedSend,
    clockWindow,
    serverClockReference,
    locale = 'en-US',
  }: {
    now?: string | number | Date;
    timeZone: string;
    maxDelayedSend: unknown;
    clockWindow?: ScheduleClockWindow;
    serverClockReference?: unknown;
    locale?: string;
  },
): SchedulePresetResolution {
  const preset = SCHEDULE_PRESETS.find((candidate) => candidate.id === id);
  if (!preset) {
    throw new TypeError(`Unknown schedule preset: ${id}`);
  }
  const parsedNow = parseAbsoluteTimestamp(now);
  if (!parsedNow) return unavailablePreset(preset, 'invalidTarget', 'The current time is invalid.');
  const nowWall = wallTimeAt(parsedNow.targetMs, timeZone);
  if (!nowWall) return unavailablePreset(preset, 'invalidTimeZone', 'Choose a valid time zone.');
  const presetWall = presetWallTime(id, nowWall);
  if (id === 'laterToday' && !sameWallDate(presetWall, nowWall)) {
    return unavailablePreset(preset, 'expired', 'No later-today time remains.');
  }
  const converted = wallTimeToUtc(presetWall, timeZone);
  if ('reason' in converted) {
    return unavailablePreset(preset, converted.reason, converted.message);
  }
  const validation = validateScheduleTarget({
    targetAt: converted.targetAt,
    maxDelayedSend,
    clockWindow,
    serverClockReference,
    localNowMs: parsedNow.targetMs,
  });
  if ('reason' in validation) {
    return unavailablePreset(preset, validation.reason, validation.message);
  }
  return {
    ...preset,
    available: true,
    targetAt: validation.targetAt,
    resolvedLabel: formatScheduleTarget(validation.targetAt, timeZone, locale),
    reason: null,
    message: null,
  };
}

export function resolveSchedulePresets(
  options: Parameters<typeof resolveSchedulePreset>[1],
): SchedulePresetResolution[] {
  return SCHEDULE_PRESETS.map((preset) => resolveSchedulePreset(preset.id, options));
}

export function resolveCustomSchedule({
  wallTime,
  timeZone,
  maxDelayedSend,
  clockWindow,
  serverClockReference,
  localNowMs = Date.now(),
  locale = 'en-US',
}: {
  wallTime: WallDateTime;
  timeZone: string;
  maxDelayedSend: unknown;
  clockWindow?: ScheduleClockWindow;
  serverClockReference?: unknown;
  localNowMs?: number;
  locale?: string;
}): CustomScheduleResolution {
  const converted = wallTimeToUtc(wallTime, timeZone);
  if ('reason' in converted) {
    return { ok: false, reason: converted.reason, message: converted.message };
  }
  const validation = validateScheduleTarget({
    targetAt: converted.targetAt,
    maxDelayedSend,
    clockWindow,
    serverClockReference,
    localNowMs,
  });
  if ('reason' in validation) {
    return { ok: false, reason: validation.reason, message: validation.message };
  }
  return {
    ok: true,
    targetAt: validation.targetAt,
    resolvedLabel: formatScheduleTarget(validation.targetAt, timeZone, locale),
    ambiguous: converted.ambiguous,
  };
}
