/**
 * Local SQLite reconciliation that runs immediately after a JMAP
 * Email/set succeeds. The point is to keep the cache authoritative
 * without waiting for an async StateChange push: by the time
 * runMutation returns, the messages / folder_messages / query_view_items
 * tables already reflect the new server state, and the MESSAGES /
 * FOLDERS broadcasts triggered here drive the UI refresh.
 *
 * If anything in this file throws, the outbox treats the mutation as
 * failed (see outbox.js' try/catch). That is intentional: a successful
 * JMAP call we cannot mirror locally would leave the UI permanently
 * out of sync, which is worse than reporting failure and re-reading
 * the painted ranges from the (still consistent) cache.
 */

import { DB_RPC } from '../../../db/protocol.js';
import { JMAP_CAPS } from './transport.js';
import { persistEmails, EMAIL_LIST_PROPERTIES } from './messages.js';

/**
 * Apply a successful Email/set update {mailboxIds/<id>} locally.
 *
 * Delegates to the OUTBOX_APPLY_MOVE worker handler which does
 * everything inside a single engine transaction:
 *   - Replace folder_messages rows for this message.
 *   - For each removed folder, drop the row from any mailbox-window
 *     query_views(folder_id = removed) and decrement total.
 *   - For each added folder, mark any mailbox-window query_views(folder_id
 *     = added) stale while preserving painted ranges, so large folders
 *     keep their existing coverage and only the visible window is
 *     reconciled on the next visit.
 *
 * Combining the steps into one transaction is what gives delete its
 * snappy feel: with the per-step orchestration we used before, each
 * intermediate RPC paid a per-call lock acquisition + fsync and a
 * single delete could stretch from ~200 ms to ~800-1500 ms when the
 * indexer was holding the engine lock.
 */
export async function applyMoveLocally(handlers, account, {
  messageId, addFolderIds = [], removeFolderIds = [],
}) {
  if (messageId == null) return;
  await handlers[DB_RPC.OUTBOX_APPLY_MOVE]({
    accountId: account.id,
    messageId,
    addFolderIds: (addFolderIds ?? []).map(Number).filter(Number.isFinite),
    removeFolderIds: (removeFolderIds ?? []).map(Number).filter(Number.isFinite),
  });
}

/**
 * Apply a successful Email/set destroy locally. Same one-transaction
 * batching as applyMoveLocally; the worker handler cascades the
 * DELETE FROM messages and compacts every affected query_view in a
 * single fsync.
 */
export async function applyDestroyLocally(handlers, account, { messageId }) {
  if (messageId == null) return;
  await handlers[DB_RPC.OUTBOX_APPLY_DESTROY]({
    accountId: account.id,
    messageId,
  });
}

async function dropFromActiveViews(handlers, account, { folderId, remoteId }) {
  // Still used by reconcileMessageFromServer when an Email/get
  // confirms the message moved out of a folder we expected it to
  // leave. Going through OUTBOX_APPLY_MOVE here would require
  // knowing the messageId; instead, do the narrow per-view fix
  // through the existing handlers.
  const viewRows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT id FROM query_views
           WHERE account_id = ?
             AND folder_id = ?
             AND view_type = 'mailbox-window'`,
    params: [account.id, folderId],
  });
  for (const view of viewRows) {
    const result = await handlers[DB_RPC.QUERY_VIEW_APPLY_CHANGES]({
      viewId: Number(view.id),
      removed: [remoteId],
      added: [],
    });
    if (Number(result?.removed ?? 0) > 0) {
      await handlers[DB_RPC.QUERY]({
        sql: `UPDATE query_views
                 SET total = MAX(0, COALESCE(total, 0) - 1),
                     updated_at = ?
               WHERE id = ?`,
        params: [Date.now(), Number(view.id)],
      });
    }
  }
}

/**
 * Reconcile local state for a single message against what the server
 * actually has. Called when Email/set update or destroy returned
 * notUpdated/notDestroyed - the most common reason is that local cache
 * and server are out of sync (someone else moved/deleted the message),
 * so the patch could not be applied. A push-only client could trust
 * Email/set and let the next StateChange catch up, but with a SQLite
 * cache the user would navigate through stale rows until the push
 * landed, so we reconcile inline instead.
 *
 * Returns:
 *   { gone: true }                  -> message no longer on server; we
 *                                      applied destroy locally
 *   { gone: false, email }          -> message still on server with the
 *                                      shown mailboxIds; local cache has
 *                                      been refreshed to match
 *   { gone: false, email: null,
 *     error: 'getFailed' }          -> Email/get itself failed; local
 *                                      state is unchanged
 */
export async function reconcileMessageFromServer({
  transport, account, handlers, messageId, remoteId,
  removeRemoteFolderIds = [], useWebSocket = false,
}) {
  let payload;
  try {
    payload = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
      methodCalls: [[
        'Email/get',
        {
          accountId: account.remote_account_id,
          ids: [remoteId],
          properties: EMAIL_LIST_PROPERTIES,
        },
        'r1',
      ]],
      useWebSocket,
    });
  } catch (err) {
    return { gone: false, email: null, error: 'getFailed', detail: err?.message };
  }

  const got = payload?.methodResponses?.find((r) => r[0] === 'Email/get')?.[1];
  const list = got?.list ?? [];
  const notFound = got?.notFound ?? [];

  if (list.length === 0 || notFound.includes(remoteId)) {
    await applyDestroyLocally(handlers, account, { messageId });
    return { gone: true };
  }

  const email = list[0];
  await persistEmails({ account, emails: [email], handlers });

  // Even though persistEmails fixed folder_messages, query_view_items
  // still references this remote_id in any view whose folder is no
  // longer in the email's mailboxIds. Drop those entries explicitly so
  // the user does not keep seeing the message in those folders.
  for (const remoteFolderId of removeRemoteFolderIds) {
    if (email.mailboxIds?.[remoteFolderId] === true) continue;
    const rows = await handlers[DB_RPC.QUERY]({
      sql: 'SELECT id FROM folders WHERE account_id = ? AND remote_id = ?',
      params: [account.id, remoteFolderId],
    });
    if (!rows[0]) continue;
    await dropFromActiveViews(handlers, account, {
      folderId: Number(rows[0].id),
      remoteId,
    });
  }

  return { gone: false, email };
}

async function callJmap(transport, { using, methodCalls, useWebSocket }) {
  if (useWebSocket && typeof transport.wsRequest === 'function') {
    return transport.wsRequest(using, methodCalls);
  }
  return transport.request(using, methodCalls);
}
