import { DB_RPC } from '../../../../db/protocol';
import { isRetryableMessageError, isTerminalPerObjectFolderError } from './errors';

interface FolderBatchResult {
  succeededIds: Array<number | string>;
  errors: Record<string, any>;
  created?: Record<string, { remoteId: string; folderId?: number | null }>;
  copied?: Record<string, { remoteId: string; sourceId: number }>;
}

interface FolderProcessResult {
  ok: boolean;
  error?: any;
  response?: any;
  result: FolderBatchResult;
}
function finishFolderBatch(
  succeededIds: Array<number | string>,
  errors: Record<string, any>,
  response?: any,
): FolderProcessResult {
  const result: FolderBatchResult = { succeededIds, errors };
  const errorList = Object.values(errors) as any[];
  const firstError = errorList[0];
  if (firstError) {
    const terminal = errorList.every(isTerminalPerObjectFolderError);
    return {
      ok: false,
      error: {
        ...firstError,
        ...(terminal ? { terminal: true } : {}),
        result,
      },
      response,
      result,
    };
  }
  return { ok: true, response, result };
}

function finishMessageBatch(
  succeededIds: number[],
  errors: Record<string, any>,
  response?: any,
  { preventRetryAfterSuccess = false } = {},
): FolderProcessResult {
  const result: FolderBatchResult = {
    succeededIds: [...new Set(succeededIds)],
    errors,
  };
  const errorList = Object.values(errors) as any[];
  if (errorList.length === 0) return { ok: true, response, result };
  const first = errorList[0];
  const retryable = errorList.some(isRetryableMessageError);
  if (preventRetryAfterSuccess && result.succeededIds.length > 0 && retryable) {
    return {
      ok: false,
      error: {
        type: 'copyPartialSuccess',
        terminal: true,
        detail: first,
        result,
      },
      response,
      result,
    };
  }
  return {
    ok: false,
    error: {
      ...first,
      ...(!retryable ? { terminal: true } : {}),
      result,
    },
    response,
    result,
  };
}
async function markRow(handlers, id, status) {
  await handlers[DB_RPC.QUERY]({
    sql: 'UPDATE pending_mutations SET local_status = ?, updated_at = ? WHERE id = ?',
    params: [status, Date.now(), id],
  });
}

async function markFailed(handlers, id, error) {
  await handlers[DB_RPC.QUERY]({
    sql: `UPDATE pending_mutations
              SET local_status = 'conflicted',
                  error_json = ?,
                  updated_at = ?
            WHERE id = ?`,
    params: [JSON.stringify(error ?? {}), Date.now(), id],
  });
}

async function deleteRow(handlers, id) {
  await handlers[DB_RPC.QUERY]({
    sql: 'DELETE FROM pending_mutations WHERE id = ?',
    params: [id],
  });
}

export {
  deleteRow,
  finishFolderBatch,
  finishMessageBatch,
  markFailed,
  markRow,
};
export type { FolderBatchResult, FolderProcessResult };
