/**
 * Durable checkpoint for a send in progress.
 *
 * A send touches irreversible server state twice: creating the Email and
 * submitting it. If a response to either is lost, the client cannot tell
 * from the network alone whether the server acted. The checkpoint gives
 * it something to reason from instead: a stable Message-ID it can search
 * for, the remote ids of whatever has already been confirmed, and the
 * furthest phase known to have succeeded.
 *
 * The phase lives in its own `pending_mutations.phase` column so startup
 * recovery can index it; the rest rides in `server_response_json`, which
 * was already the row's scratch space for server results.
 *
 * Everything here is written BEFORE the protocol call it describes could
 * be repeated. Writing after would reintroduce the window the checkpoint
 * exists to close.
 */

import { SEND_PHASE, type SendPhase } from '../../../constants/states';
import { makeMessageId, makeOperationId } from '../../../utils/message-id';
import {
  readMutationCheckpoint,
  saveMutationCheckpoint,
} from './mutation-checkpoint';

export { makeMessageId } from '../../../utils/message-id';

export interface SendCheckpoint {
  /** Identifies this send attempt across retries and worker restarts. */
  operationId: string;
  /** RFC 5322 msg-id, reused unchanged on every retry of this operation. */
  messageId: string;
  /** Set once Email/set has been confirmed. */
  emailRemoteId: string | null;
  /** Set once EmailSubmission/set has been confirmed. */
  submissionRemoteId: string | null;
  /**
   * How many times local filing has been attempted and failed since the
   * submission was accepted. Counted separately from the row's own
   * `attempts` because that counter also covers the create and submit
   * phases, and a send that burned retries getting the message out still
   * deserves a full budget for the local repair that follows.
   */
  cacheAttempts: number;
  /** The accepted-send checkpoint and trusted-recipient mutation committed together. */
  trustedRecipientsQueued: boolean;
  /** Draft revisions whose post-send removal is not durably confirmed yet. */
  pendingDraftDestroyIds: string[] | null;
}

function draftEmailIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((id): id is string =>
    typeof id === 'string' && id.trim().length > 0);
  if (ids.length !== value.length || new Set(ids).size !== ids.length) return null;
  return ids;
}

/** Read the checkpoint off a pending_mutations row, if it has one. */
export function readCheckpoint(row: any): SendCheckpoint | null {
  const result = readMutationCheckpoint<SendCheckpoint>(row, (parsed: any) => {
    if (
      !parsed
      || typeof parsed.operationId !== 'string'
      || typeof parsed.messageId !== 'string'
    ) {
      return null;
    }
    const pendingDraftDestroyIds = parsed.pendingDraftDestroyIds == null
      ? null
      : draftEmailIds(parsed.pendingDraftDestroyIds);
    if (parsed.pendingDraftDestroyIds != null && pendingDraftDestroyIds == null) {
      return null;
    }
    return {
      operationId: parsed.operationId,
      messageId: parsed.messageId,
      emailRemoteId: typeof parsed.emailRemoteId === 'string' ? parsed.emailRemoteId : null,
      submissionRemoteId:
        typeof parsed.submissionRemoteId === 'string' ? parsed.submissionRemoteId : null,
      cacheAttempts: Number.isInteger(parsed.cacheAttempts) ? parsed.cacheAttempts : 0,
      trustedRecipientsQueued: parsed.trustedRecipientsQueued === true,
      pendingDraftDestroyIds,
    };
  });
  return result.status === 'valid' ? result.checkpoint : null;
}

export function newCheckpoint(
  identityEmail: string | null | undefined,
  pendingDraftDestroyIds: unknown = [],
): SendCheckpoint {
  return {
    operationId: makeOperationId(),
    messageId: makeMessageId(identityEmail),
    emailRemoteId: null,
    submissionRemoteId: null,
    cacheAttempts: 0,
    trustedRecipientsQueued: false,
    pendingDraftDestroyIds: draftEmailIds(pendingDraftDestroyIds) ?? [],
  };
}

/**
 * Phases past the point of no return, where the row's remaining work is
 * local repair rather than another try at sending.
 */
const POST_SUBMISSION_PHASES: Set<string> = new Set([
  SEND_PHASE.SUBMITTED,
  SEND_PHASE.CACHE_PENDING,
]);

/**
 * Persist the checkpoint and phase together. Returns the checkpoint so
 * callers can keep using it without re-reading the row.
 *
 * Crossing into a post-submission phase restarts `attempts`. That counter
 * is the outbox runner's give-up budget, and it counted tries at getting
 * the message out — work that has now succeeded. Carrying the total
 * forward would let a send that needed seven tries to reach the server
 * exhaust the cap on its first filing failure, retiring a delivered
 * message as a conflicted row. Past this point the budget that governs is
 * `cacheAttempts`, which is smaller than the cap, so it stays the one
 * that decides.
 */
export async function saveCheckpoint(
  handlers: Record<string, (params: any) => Promise<any>>,
  rowId: number | null | undefined,
  checkpoint: SendCheckpoint,
  phase: SendPhase,
): Promise<SendCheckpoint> {
  await saveMutationCheckpoint({
    handlers,
    rowId,
    phase,
    checkpoint,
    resetAttempts: POST_SUBMISSION_PHASES.has(phase),
  });
  return checkpoint;
}

/** Read the recorded phase, treating an unrecognised value as unstarted. */
export function readPhase(row: any): SendPhase | null {
  const phase = row?.phase;
  return Object.values(SEND_PHASE).includes(phase) ? phase : null;
}
