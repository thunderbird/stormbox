import { DRAFT_PHASE, type DraftPhase } from '../../../constants/states';
import { makeMessageId, makeOperationId } from '../../../utils/message-id';
import {
  readMutationCheckpoint,
  saveMutationCheckpoint,
} from './mutation-checkpoint';

export interface DraftCheckpoint {
  operationId: string;
  draftSessionId: string;
  revision: number;
  revisionMessageId: string;
  payloadHash: string;
  baseEmailIds: string[];
  preparedEmail: Record<string, unknown> | null;
  newEmailId: string | null;
  localMessageId: number | null;
  pendingDestroyIds: string[];
}

function sameStrings(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((value) => expected.has(value));
}

export function isDraftEmailId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactDraftEmailIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every(isDraftEmailId)) return null;
  const ids = value as string[];
  return new Set(ids).size === ids.length ? [...ids] : null;
}

export function draftCheckpointConflictReason(
  checkpoint: DraftCheckpoint,
  phase: DraftPhase,
): string | null {
  if (phase === DRAFT_PHASE.CONFLICT) return null;
  const hasPreparedEmail = checkpoint.preparedEmail != null;
  const hasSuccessor = isDraftEmailId(checkpoint.newEmailId);
  const hasLocalSuccessor = Number.isSafeInteger(checkpoint.localMessageId)
    && Number(checkpoint.localMessageId) > 0;
  const destroysSuccessor = hasSuccessor
    && checkpoint.pendingDestroyIds.includes(checkpoint.newEmailId!);

  if (!hasPreparedEmail) return 'missingPreparedEmail';
  if (destroysSuccessor) return 'successorPendingDestroy';

  switch (phase) {
    case DRAFT_PHASE.QUEUED:
      if (hasSuccessor || hasLocalSuccessor) return 'queuedHasSuccessor';
      return sameStrings(checkpoint.pendingDestroyIds, checkpoint.baseEmailIds)
        ? null
        : 'queuedDestroySetChanged';
    case DRAFT_PHASE.CREATED:
      if (!hasSuccessor) return 'createdMissingSuccessor';
      return hasLocalSuccessor ? 'createdHasLocalSuccessor' : null;
    case DRAFT_PHASE.CACHE_PENDING:
    case DRAFT_PHASE.CLEANUP_PENDING:
      if (!hasSuccessor) return 'pendingMissingSuccessor';
      return hasLocalSuccessor ? null : 'pendingMissingLocalSuccessor';
    default: {
      const unhandled: never = phase;
      return unhandled;
    }
  }
}

export function newDraftCheckpoint(request: any, identityEmail: string): DraftCheckpoint {
  const inputIds: unknown[] = Array.isArray(request?.draftEmailIds)
    ? request.draftEmailIds
    : [];
  const baseEmailIds = [...new Set<string>(
    inputIds.filter(isDraftEmailId),
  )];
  return {
    operationId: typeof request?.operationId === 'string'
      ? request.operationId
      : makeOperationId(),
    draftSessionId: String(request?.draftSessionId ?? makeOperationId()),
    revision: Number.isInteger(request?.revision) ? request.revision : 1,
    revisionMessageId: typeof request?.revisionMessageId === 'string'
      ? request.revisionMessageId
      : makeMessageId(identityEmail),
    payloadHash: typeof request?.payloadHash === 'string' ? request.payloadHash : '',
    baseEmailIds,
    preparedEmail: null,
    newEmailId: null,
    localMessageId: null,
    pendingDestroyIds: [...baseEmailIds],
  };
}

export function readDraftCheckpoint(row: any): DraftCheckpoint | null {
  const result = readMutationCheckpoint<DraftCheckpoint>(row, (parsed: any) => {
    if (!parsed
        || typeof parsed !== 'object'
        || Array.isArray(parsed)
        || !isDraftEmailId(parsed.operationId)
        || !isDraftEmailId(parsed.draftSessionId)
        || !Number.isSafeInteger(parsed.revision)
        || parsed.revision < 1
        || !isDraftEmailId(parsed.revisionMessageId)
        || typeof parsed.payloadHash !== 'string'
        || !parsed.preparedEmail
        || typeof parsed.preparedEmail !== 'object'
        || Array.isArray(parsed.preparedEmail)) {
      return null;
    }
    const baseEmailIds = exactDraftEmailIds(parsed.baseEmailIds);
    const pendingDestroyIds = exactDraftEmailIds(parsed.pendingDestroyIds);
    if (!baseEmailIds || !pendingDestroyIds) return null;
    const newEmailId = parsed.newEmailId == null
      ? null
      : (isDraftEmailId(parsed.newEmailId) ? parsed.newEmailId : undefined);
    const localMessageId = parsed.localMessageId == null
      ? null
      : (
        Number.isSafeInteger(parsed.localMessageId) && parsed.localMessageId > 0
          ? parsed.localMessageId
          : undefined
      );
    if (newEmailId === undefined || localMessageId === undefined) return null;
    return {
      operationId: parsed.operationId,
      draftSessionId: parsed.draftSessionId,
      revision: parsed.revision,
      revisionMessageId: parsed.revisionMessageId,
      payloadHash: parsed.payloadHash,
      baseEmailIds,
      preparedEmail: parsed.preparedEmail,
      newEmailId,
      localMessageId,
      pendingDestroyIds,
    };
  });
  return result.status === 'valid' ? result.checkpoint : null;
}

export function readDraftPhase(row: any): DraftPhase | null {
  return Object.values(DRAFT_PHASE).includes(row?.phase) ? row.phase : null;
}

export async function saveDraftCheckpoint(
  handlers: Record<string, (params: any) => Promise<any>>,
  rowId: number | null | undefined,
  checkpoint: DraftCheckpoint,
  phase: DraftPhase,
): Promise<DraftCheckpoint> {
  if (rowId == null) throw new Error('saveDraftCheckpoint requires a mutation row id');
  const reason = draftCheckpointConflictReason(checkpoint, phase);
  if (reason) {
    throw new Error(`Invalid draft checkpoint for ${phase}: ${reason}`);
  }
  await saveMutationCheckpoint({
    handlers,
    rowId,
    phase,
    checkpoint,
  });
  return checkpoint;
}
