import { DB_RPC } from '../../../db/protocol';

export const CACHE_REPAIR_MAX_ATTEMPTS = 3;

export type MutationCheckpointRead<T> =
  | { status: 'absent' }
  | { status: 'valid'; checkpoint: T }
  | { status: 'invalid' };

export function readMutationCheckpoint<T>(
  row: { server_response_json?: unknown } | null | undefined,
  decode: (value: unknown) => T | null,
): MutationCheckpointRead<T> {
  const serialized = row?.server_response_json;
  if (serialized == null) return { status: 'absent' };
  if (typeof serialized !== 'string' || serialized.length === 0) {
    return { status: 'invalid' };
  }
  try {
    const checkpoint = decode(JSON.parse(serialized));
    return checkpoint == null
      ? { status: 'invalid' }
      : { status: 'valid', checkpoint };
  } catch {
    return { status: 'invalid' };
  }
}

export async function saveMutationCheckpoint<T>({
  handlers,
  rowId,
  phase,
  checkpoint,
  resetAttempts = false,
}: {
  handlers: Record<string, (params: any) => Promise<any>>;
  rowId: number | null | undefined;
  phase: string | null;
  checkpoint: T | null;
  resetAttempts?: boolean;
}): Promise<T | null> {
  if (rowId == null) {
    throw new Error('saveMutationCheckpoint requires a mutation row id');
  }
  await handlers[DB_RPC.QUERY]({
    sql: `UPDATE pending_mutations
             SET phase = ?,
                 server_response_json = ?,
                 ${resetAttempts ? 'attempts = 0,' : ''}
                 updated_at = ?
           WHERE id = ?`,
    params: [
      phase,
      checkpoint == null ? null : JSON.stringify(checkpoint),
      Date.now(),
      rowId,
    ],
  });
  return checkpoint;
}
