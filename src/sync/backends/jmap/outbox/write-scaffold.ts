import { wlog } from '../../../../db/worker-log';
import {
  CACHE_REPAIR_MAX_ATTEMPTS,
  readMutationCheckpoint,
  saveMutationCheckpoint,
} from '../mutation-checkpoint';

type ErrorCodeTable = Readonly<Record<string, string>>;

interface SetFailureOptions<Operation extends string> {
  reason: any;
  fallbackType: string;
  operation: Operation;
  classify: (reason: any, fallbackType: string, operation: Operation) => string;
  isRetryable: (protocolType: string, errorType: string) => boolean;
}

interface AcceptedWriteRepairOptions<Repair> {
  handlers: Record<string, (params: any) => Promise<any>>;
  rowId: number;
  phase: string;
  remoteId: string;
  attempts: number;
  checkpoint: (attempting: number) => unknown;
  cacheRepairErrorType: string;
  failureLog: (message: string) => string;
  repair: () => Promise<Repair>;
  success: (repair: Repair) => Record<string, unknown>;
}

interface UniqueCreateRecoveryOptions<Candidate> {
  baselineIds: readonly string[];
  refreshSnapshot: () => Promise<boolean | void>;
  readCandidates: () => Promise<Candidate[]>;
  candidateRemoteId: (candidate: Candidate) => string | null;
  matchesRequest: (candidate: Candidate) => boolean;
  ambiguousErrorType: string;
  reconcile: (remoteId: string) => Promise<any>;
}

export function setErrorTypeFromTable(
  reason: any,
  fallbackType: string,
  errorCodes: ErrorCodeTable,
  unknownErrorType: string,
): string {
  const protocolType = reason?.type ?? fallbackType;
  return Object.hasOwn(errorCodes, protocolType)
    ? errorCodes[protocolType]
    : unknownErrorType;
}

export function setWriteFailure<Operation extends string>({
  reason,
  fallbackType,
  operation,
  classify,
  isRetryable,
}: SetFailureOptions<Operation>) {
  const protocolType = reason?.type ?? fallbackType;
  const type = classify(reason, fallbackType, operation);
  return {
    ok: false,
    error: {
      type,
      protocolType,
      ...(reason ? { detail: reason } : {}),
      ...(isRetryable(protocolType, type) ? {} : { terminal: true }),
    },
  };
}

export function localWriteFailure(
  type: string,
  detail: Record<string, unknown> = {},
  terminal = true,
) {
  return {
    ok: false,
    error: {
      type,
      protocolType: 'clientValidation',
      detail,
      ...(terminal ? { terminal: true } : {}),
    },
  };
}

export function ambiguousWriteCreateFailure(
  type: string,
  detail: Record<string, unknown>,
) {
  return {
    ok: false,
    error: {
      type,
      protocolType: 'createOutcomeUnknown',
      detail,
      terminal: true,
    },
  };
}

export function readAcceptedWrite<T>(
  row: any,
  phase: string,
  decode: (value: unknown) => T | null,
): T | null {
  if (row?.phase !== phase) return null;
  const result = readMutationCheckpoint(row, decode);
  return result.status === 'valid' ? result.checkpoint : null;
}

export async function runAcceptedWriteRepair<Repair>({
  handlers,
  rowId,
  phase,
  remoteId,
  attempts,
  checkpoint,
  cacheRepairErrorType,
  failureLog,
  repair,
  success,
}: AcceptedWriteRepairOptions<Repair>) {
  const attempting = attempts + 1;
  await saveMutationCheckpoint({
    handlers,
    rowId,
    phase,
    checkpoint: checkpoint(attempting),
  });
  try {
    const repaired = await repair();
    return {
      ok: true,
      result: {
        ids: [remoteId],
        ...success(repaired),
      },
    };
  } catch (error: any) {
    const message = error?.message ?? String(error);
    wlog.warn('jmap-outbox', failureLog(message));
    return {
      ok: false,
      error: {
        type: cacheRepairErrorType,
        protocolType: 'cacheReconcileFailed',
        message,
        ...(attempting >= CACHE_REPAIR_MAX_ATTEMPTS ? { terminal: true } : {}),
        result: {
          applied: true,
          cached: false,
          ids: [remoteId],
        },
      },
    };
  }
}

export async function recoverUniqueWriteCreate<Candidate>({
  baselineIds,
  refreshSnapshot,
  readCandidates,
  candidateRemoteId,
  matchesRequest,
  ambiguousErrorType,
  reconcile,
}: UniqueCreateRecoveryOptions<Candidate>) {
  try {
    if (await refreshSnapshot() === false) {
      return ambiguousWriteCreateFailure(
        ambiguousErrorType,
        { reason: 'snapshotIncomplete' },
      );
    }
  } catch (error: any) {
    return ambiguousWriteCreateFailure(ambiguousErrorType, {
      reason: 'snapshotIncomplete',
      message: error?.message ?? String(error),
    });
  }
  const baseline = new Set(baselineIds);
  const candidates = await readCandidates();
  const matches = candidates.flatMap((candidate) => {
    const remoteId = candidateRemoteId(candidate);
    return remoteId !== null && !baseline.has(remoteId) && matchesRequest(candidate)
      ? [remoteId]
      : [];
  });
  if (matches.length !== 1) {
    return ambiguousWriteCreateFailure(ambiguousErrorType, {
      reason: matches.length === 0 ? 'noUniqueMatch' : 'multipleMatches',
      candidateIds: matches,
    });
  }
  return reconcile(matches[0]);
}
