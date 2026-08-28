import { DRAFT_PHASE, type DraftPhase } from '../../../constants/states';
import { DB_RPC } from '../../../db/protocol';
import { makeMessageId, makeOperationId } from '../../../utils/message-id';

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

export function newDraftCheckpoint(request: any, identityEmail: string): DraftCheckpoint {
  const inputIds: unknown[] = Array.isArray(request?.draftEmailIds)
    ? request.draftEmailIds
    : [];
  const baseEmailIds = [...new Set<string>(
    inputIds.filter((id): id is string => typeof id === 'string' && !!id),
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
  if (!row?.server_response_json) return null;
  let parsed;
  try {
    parsed = JSON.parse(row.server_response_json);
  } catch {
    return null;
  }
  if (!parsed
      || typeof parsed.operationId !== 'string'
      || typeof parsed.draftSessionId !== 'string'
      || !Number.isInteger(parsed.revision)
      || typeof parsed.revisionMessageId !== 'string'
      || typeof parsed.payloadHash !== 'string') {
    return null;
  }
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && !!entry))]
      : [];
  return {
    operationId: parsed.operationId,
    draftSessionId: parsed.draftSessionId,
    revision: parsed.revision,
    revisionMessageId: parsed.revisionMessageId,
    payloadHash: parsed.payloadHash,
    baseEmailIds: strings(parsed.baseEmailIds),
    preparedEmail: parsed.preparedEmail && typeof parsed.preparedEmail === 'object'
      ? parsed.preparedEmail
      : null,
    newEmailId: typeof parsed.newEmailId === 'string' ? parsed.newEmailId : null,
    localMessageId: Number.isInteger(parsed.localMessageId) ? parsed.localMessageId : null,
    pendingDestroyIds: strings(parsed.pendingDestroyIds),
  };
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
  await handlers[DB_RPC.QUERY]({
    sql: `UPDATE pending_mutations
             SET phase = ?, server_response_json = ?, updated_at = ?
           WHERE id = ?`,
    params: [phase, JSON.stringify(checkpoint), Date.now(), rowId],
  });
  return checkpoint;
}
