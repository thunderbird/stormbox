/**
 * JMAP mutation dispatch + post-success cache reconciliation.
 *
 * Translates a single pending_mutations row into the appropriate
 * Email/set or EmailSubmission/set request, then mirrors the
 * server-confirmed result in the local SQLite cache before resolving.
 * The constitution requires the cache to match the server before the
 * mutation RPC returns, so we never wait for an async StateChange push
 * to apply the local effect.
 *
 * Supported mutation_type values:
 *
 *   'setKeywords'      Email/set update with a keywords/$X patch
 *   'moveToFolders'    Email/set update of mailbox memberships
 *   'destroy'          Email/set destroy
 *   'send'             Email/set create + EmailSubmission/set with
 *                      onSuccessUpdateEmail moving the email out of
 *                      drafts/outbox into sent
 *   'setMailboxSubscription' / 'createMailbox' / 'updateMailbox' /
 *   'destroyMailbox'   Mailbox/set subscription toggle, create,
 *                      rename/move, and destroy (RFC 8621 §2.5)
 *
 * Move and destroy delegate the cache effect to the protocol-neutral
 * OUTBOX_APPLY_MOVE_BATCH / OUTBOX_APPLY_DESTROY_BATCH DB handlers,
 * which do the work inside a single engine transaction. Send and the
 * notUpdated/notDestroyed fallback are JMAP-specific (they issue an
 * Email/get to reconcile) and live in `applySendLocally` /
 * `reconcileMessageFromServer` below.
 *
 * Two entry points:
 *
 *   processMutationRow({ transport, account, handlers, row, useWebSocket })
 *     -> { ok, error? }
 *
 *     The per-row dispatch used by the worker-side OutboxRunner
 *     (sync/backends/jmap/outbox-runner.js). The runner owns
 *     status/attempts/not_before bookkeeping; this helper just runs
 *     the JMAP call and reports success or a typed error.
 *
 *   drainOutbox({ transport, account, handlers, limit, mutationId, useWebSocket })
 *     -> { attempted, succeeded, failed }
 *
 *     Kept for direct unit tests in jmap-outbox.test.js (they assert
 *     the in-DB status transitions for each mutation type without
 *     spinning up the runner). Production code goes through the
 *     OutboxRunner instead.
 */

import { DB_RPC } from '../../../../db/protocol';
import { deleteRow, markFailed, markRow } from './batch';
import { runCopyToFolders } from './operations/copy-to-folders';
import { runCreateMailbox } from './operations/create-mailbox';
import {
  runCreateContact,
  runDeleteContact,
  runUpdateContact,
  runWhitelistSender,
} from './operations/contacts';
import { runDestroy } from './operations/destroy';
import { runDestroyMailbox } from './operations/destroy-mailbox';
import { runMoveToFolders } from './operations/move-to-folders';
import { runSend } from './operations/send';
import { runSetKeywords } from './operations/set-keywords';
import { runSetMailboxSubscription } from './operations/set-mailbox-subscription';
import { runUpdateMailbox } from './operations/update-mailbox';
import { toProcessResult } from './send-outcome';

export { applySendLocally } from './send-apply';
export type { FolderBatchResult, FolderProcessResult } from './batch';
export type { FolderContext, FolderId, FolderMutationHandlerArgs } from './resolve';

export const MUTATION_TYPES = Object.freeze({
  SET_KEYWORDS: 'setKeywords',
  MOVE_TO_FOLDERS: 'moveToFolders',
  COPY_TO_FOLDERS: 'copyToFolders',
  DESTROY: 'destroy',
  SEND: 'send',
  WHITELIST_SENDER: 'whitelistSender',
  CREATE_CONTACT: 'createContact',
  UPDATE_CONTACT: 'updateContact',
  DELETE_CONTACT: 'deleteContact',
  SET_MAILBOX_SUBSCRIPTION: 'setMailboxSubscription',
  CREATE_MAILBOX: 'createMailbox',
  UPDATE_MAILBOX: 'updateMailbox',
  DESTROY_MAILBOX: 'destroyMailbox',
});
/**
 * Drain pending mutations for the given account. When mutationId is
 * provided, run only that row so a user action is not blocked behind
 * unrelated older queued mutations.
 */
export async function drainOutbox({
  transport, account, handlers, limit = 25, mutationId = null, useWebSocket = false,
}) {
  const rows = mutationId == null
    ? await handlers[DB_RPC.PENDING_MUTATION_LIST_PENDING]({
      accountId: account.id,
      limit,
    })
    : await handlers[DB_RPC.QUERY]({
      sql: `SELECT * FROM pending_mutations
              WHERE account_id = ?
                AND id = ?
                AND local_status IN ('pending','retry')
              LIMIT 1`,
      params: [account.id, mutationId],
    });
  const summary = { attempted: rows.length, succeeded: 0, failed: 0 };
  for (const row of rows) {
    try {
      await markRow(handlers, row.id, 'in_flight');
      const result = await runOne({ transport, account, handlers, row, useWebSocket });
      if (result.ok) {
        await deleteRow(handlers, row.id);
        summary.succeeded += 1;
      } else {
        await markFailed(handlers, row.id, result.error);
        summary.failed += 1;
      }
    } catch (error) {
      await markFailed(handlers, row.id, { type: 'transport', message: error?.message ?? String(error) });
      summary.failed += 1;
    }
  }
  return summary;
}

/**
 * Per-row dispatch. Translates one pending_mutations row into the
 * matching JMAP call and returns a result discriminator the caller
 * (drainOutbox or OutboxRunner) uses for status bookkeeping.
 *
 * Throws are intentionally NOT caught here; both callers wrap this in
 * their own try/catch and translate a thrown error into a
 * `{ ok: false, error: { type: 'transport' } }` result, which matters
 * for the runner's retryable-vs-terminal classification.
 */
export async function processMutationRow({
  transport, account, handlers, row, useWebSocket = false,
}): Promise<{ ok: boolean; error?: any; response?: any; result?: any }> {
  const request = JSON.parse(row.request_json);
  switch (row.mutation_type) {
    case MUTATION_TYPES.SET_KEYWORDS:
      return runSetKeywords({ transport, handlers, row, request, useWebSocket });
    case MUTATION_TYPES.MOVE_TO_FOLDERS:
      return runMoveToFolders({ transport, handlers, row, request, useWebSocket });
    case MUTATION_TYPES.COPY_TO_FOLDERS:
      return runCopyToFolders({ transport, handlers, row, request, useWebSocket });
    case MUTATION_TYPES.DESTROY:
      return runDestroy({ transport, handlers, row, request, useWebSocket });
    case MUTATION_TYPES.SEND:
      return toProcessResult(
        await runSend({ transport, account, handlers, row, request, useWebSocket }),
      );
    case MUTATION_TYPES.WHITELIST_SENDER:
      return runWhitelistSender({ transport, account, handlers, row, request, useWebSocket });
    case MUTATION_TYPES.CREATE_CONTACT:
      return runCreateContact({ transport, account, handlers, row, request, useWebSocket });
    case MUTATION_TYPES.UPDATE_CONTACT:
      return runUpdateContact({ transport, account, handlers, row, request, useWebSocket });
    case MUTATION_TYPES.DELETE_CONTACT:
      return runDeleteContact({ transport, account, handlers, row, request, useWebSocket });
    case MUTATION_TYPES.SET_MAILBOX_SUBSCRIPTION:
      return runSetMailboxSubscription({ transport, handlers, request, useWebSocket });
    case MUTATION_TYPES.CREATE_MAILBOX:
      return runCreateMailbox({ transport, account, handlers, request, useWebSocket });
    case MUTATION_TYPES.UPDATE_MAILBOX:
      return runUpdateMailbox({ transport, handlers, request, useWebSocket });
    case MUTATION_TYPES.DESTROY_MAILBOX:
      return runDestroyMailbox({ transport, handlers, request, useWebSocket });
    default:
      return { ok: false, error: { type: 'unsupportedMutation', mutation_type: row.mutation_type } };
  }
}
async function runOne(args) {
  return processMutationRow(args);
}
