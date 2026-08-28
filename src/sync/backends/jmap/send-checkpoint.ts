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

import { DB_RPC } from '../../../db/protocol';
import { SEND_PHASE, type SendPhase } from '../../../constants/states';
import { makeMessageId, makeOperationId } from '../../../utils/message-id';

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
}

/** Read the checkpoint off a pending_mutations row, if it has one. */
export function readCheckpoint(row: any): SendCheckpoint | null {
  if (!row?.server_response_json) return null;
  let parsed;
  try {
    parsed = JSON.parse(row.server_response_json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.operationId !== 'string' || typeof parsed.messageId !== 'string') {
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
  };
}

export function newCheckpoint(identityEmail: string | null | undefined): SendCheckpoint {
  return {
    operationId: makeOperationId(),
    messageId: makeMessageId(identityEmail),
    emailRemoteId: null,
    submissionRemoteId: null,
    cacheAttempts: 0,
    trustedRecipientsQueued: false,
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
  if (rowId == null) {
    // Durability is the entire point of this mechanism, so a send with
    // nowhere to record its progress is a programming error rather than a
    // degraded mode to tolerate silently.
    throw new Error('saveCheckpoint requires a pending_mutations row id');
  }
  await handlers[DB_RPC.QUERY]({
    sql: `UPDATE pending_mutations
             SET phase = ?,
                 server_response_json = ?,
                 ${POST_SUBMISSION_PHASES.has(phase) ? 'attempts = 0,' : ''}
                 updated_at = ?
           WHERE id = ?`,
    params: [phase, JSON.stringify(checkpoint), Date.now(), rowId],
  });
  return checkpoint;
}

/** Read the recorded phase, treating an unrecognised value as unstarted. */
export function readPhase(row: any): SendPhase | null {
  const phase = row?.phase;
  return Object.values(SEND_PHASE).includes(phase) ? phase : null;
}
