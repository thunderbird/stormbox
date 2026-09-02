import { JMAP_CAPS, type ServerClockReference } from './transport';

export interface ScheduleCapability {
  supported: boolean;
  maxDelayedSend: number;
  serverClockReference: ServerClockReference | null;
}

const UNSUPPORTED_SCHEDULE_CAPABILITY: Readonly<ScheduleCapability> = {
  supported: false,
  maxDelayedSend: 0,
  serverClockReference: null,
};

function readServerClockReference(transport: any): ServerClockReference | null {
  const reference = transport?.serverClockReference;
  if (
    !reference
    || !Number.isFinite(reference.capturedAtMs)
    || !Number.isFinite(reference.lowerOffsetMs)
    || !Number.isFinite(reference.uncertaintyMs)
  ) {
    return null;
  }
  return {
    capturedAtMs: reference.capturedAtMs,
    lowerOffsetMs: reference.lowerOffsetMs,
    uncertaintyMs: reference.uncertaintyMs,
  };
}

function accountSubmissionCapability(transport: any, account: any): any {
  const remoteAccountId = account?.remote_account_id;
  if (typeof remoteAccountId !== 'string' || remoteAccountId.length === 0) return null;
  return transport?.session?.accounts?.[remoteAccountId]
    ?.accountCapabilities?.[JMAP_CAPS.SUBMISSION] ?? null;
}

export function readScheduleCapability(
  transport: any,
  account: any,
): ScheduleCapability {
  const serverClockReference = readServerClockReference(transport);
  const capability = accountSubmissionCapability(transport, account);
  if (!capability || typeof capability !== 'object' || Array.isArray(capability)) {
    return { ...UNSUPPORTED_SCHEDULE_CAPABILITY, serverClockReference };
  }
  const extensions = capability.submissionExtensions;
  const hasFutureRelease = extensions
    && typeof extensions === 'object'
    && !Array.isArray(extensions)
    && Object.hasOwn(extensions, 'FUTURERELEASE');
  const maxDelayedSend = capability.maxDelayedSend;
  if (
    !hasFutureRelease
    || typeof maxDelayedSend !== 'number'
    || !Number.isSafeInteger(maxDelayedSend)
    || maxDelayedSend < 1
  ) {
    return { ...UNSUPPORTED_SCHEDULE_CAPABILITY, serverClockReference };
  }
  return { supported: true, maxDelayedSend, serverClockReference };
}

/** The capability as the current JMAP session advertises it (SL-1.6). */
export async function loadScheduleCapability(
  transport: any,
  account: any,
): Promise<ScheduleCapability> {
  if (typeof transport?.fetchSession === 'function') {
    await transport.fetchSession();
  }
  return readScheduleCapability(transport, account);
}

/**
 * The capability from a freshly fetched session. Submission uses this so
 * the server limit and clock reference HOLDFOR is computed from are
 * current at the moment of EmailSubmission/set (SL-2.8).
 */
export async function refreshScheduleCapability(
  transport: any,
  account: any,
): Promise<ScheduleCapability> {
  if (typeof transport?.fetchSession === 'function') {
    await transport.fetchSession({ force: true });
  }
  return readScheduleCapability(transport, account);
}

export async function requireScheduleCapability(
  transport: any,
  account: any,
): Promise<{ maxDelayedSend: number }> {
  const capability = await refreshScheduleCapability(transport, account);
  if (capability.supported) {
    return { maxDelayedSend: capability.maxDelayedSend };
  }
  const error: any = new Error(
    'This account does not advertise FUTURERELEASE with a valid delayed-send limit.',
  );
  error.type = 'scheduleCapabilityUnavailable';
  error.terminal = true;
  error.description = error.message;
  throw error;
}
