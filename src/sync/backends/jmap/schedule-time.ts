import {
  SERVER_CLOCK_MAX_UNCERTAINTY_MS,
  type ServerClockReference,
} from './transport';
import {
  scheduleClockWindowFromReference,
  validateScheduleTarget,
  type ScheduleClockWindow,
} from '../../../utils/schedule-time';

const ABSOLUTE_TIMESTAMP = /(?:Z|[+-]\d{2}:\d{2})$/i;

export type { ScheduleClockWindow };
// Conservative HOLDFOR rounding may release this long after the target.
export const SUBMISSION_RELEASE_OBSERVATION_DELAY_MS =
  SERVER_CLOCK_MAX_UNCERTAINTY_MS + 2_000;

export interface HoldForResult {
  targetAt: string;
  holdFor: number;
  clock: ScheduleClockWindow;
}

function scheduleError(type: string, description: string): Error {
  const error: any = new Error(description);
  error.type = type;
  error.terminal = true;
  error.description = description;
  return error;
}

/**
 * The scheduled-send instant carried by a SEND mutation request, or null
 * for an immediate send. Presence of this field is what switches the
 * shared send operation onto its Send Later branch.
 */
export function scheduledSendAtOf(request: unknown): string | null {
  const value = (request as { scheduledAt?: unknown } | null)?.scheduledAt;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function parseAbsoluteTarget(targetAt: unknown): { targetAt: string; targetMs: number } {
  if (typeof targetAt !== 'string' || !ABSOLUTE_TIMESTAMP.test(targetAt)) {
    throw scheduleError(
      'invalidScheduleTarget',
      'The scheduled time must be an absolute timestamp.',
    );
  }
  const targetMs = Date.parse(targetAt);
  if (!Number.isFinite(targetMs)) {
    throw scheduleError('invalidScheduleTarget', 'The scheduled time is invalid.');
  }
  return { targetAt: new Date(targetMs).toISOString(), targetMs };
}

export function scheduleClockWindow(
  transport: { serverClockReference?: ServerClockReference | null } | null | undefined,
  localNowMs = Date.now(),
): ScheduleClockWindow {
  return scheduleClockWindowFromReference(transport?.serverClockReference, localNowMs);
}

/**
 * Date headers have one-second precision. Future validation uses the
 * upper clock bound, while HOLDFOR rounds up from the lower bound. This
 * may schedule up to one uncertainty window late, but never rounds down
 * to an immediate or early send.
 */
export function computeHoldFor({
  targetAt,
  maxDelayedSend,
  transport,
  localNowMs = Date.now(),
}: {
  targetAt: unknown;
  maxDelayedSend: number;
  transport: any;
  localNowMs?: number;
}): HoldForResult {
  const parsed = parseAbsoluteTarget(targetAt);
  if (!Number.isSafeInteger(maxDelayedSend) || maxDelayedSend < 1) {
    throw scheduleError(
      'scheduleCapabilityUnavailable',
      'The server does not advertise a valid delayed-send limit.',
    );
  }
  const validation = validateScheduleTarget({
    targetAt: parsed.targetAt,
    maxDelayedSend,
    serverClockReference: transport?.serverClockReference,
    localNowMs,
  });
  if ('reason' in validation) {
    switch (validation.reason) {
      case 'invalidTarget':
        throw scheduleError('invalidScheduleTarget', 'The scheduled time is invalid.');
      case 'capabilityUnavailable':
        throw scheduleError(
          'scheduleCapabilityUnavailable',
          'The server does not advertise a valid delayed-send limit.',
        );
      case 'expired':
        throw scheduleError(
          'scheduleExpired',
          'The scheduled time passed before the message could be submitted.',
        );
      case 'tooFar':
        throw scheduleError(
          'scheduleTooFar',
          `The server accepts delayed sends up to ${maxDelayedSend} seconds.`,
        );
      default: {
        const exhaustive: never = validation.reason;
        throw exhaustive;
      }
    }
  }
  return {
    targetAt: validation.targetAt,
    holdFor: validation.holdFor,
    clock: validation.clock,
  };
}
