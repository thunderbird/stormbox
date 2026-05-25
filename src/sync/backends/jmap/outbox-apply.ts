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
  await applyMoveBatchLocally(handlers, account, {
    messageIds: [messageId],
    addFolderIds,
    removeFolderIds,
  });
}

/**
 * Apply a successful chunk-sized Email/set update locally. This is the
 * bulk invariant boundary: the same ids Stalwart accepted are mirrored
 * in one SQLite transaction before the outbox advances to the next
 * chunk.
 */
export async function applyMoveBatchLocally(handlers, account, {
  messageIds = [], addFolderIds = [], removeFolderIds = [],
}) {
  const ids = (messageIds ?? []).map(Number).filter(Number.isFinite);
  if (ids.length === 0) return;
  await handlers[DB_RPC.OUTBOX_APPLY_MOVE_BATCH]({
    accountId: account.id,
    messageIds: ids,
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
  await applyDestroyBatchLocally(handlers, account, { messageIds: [messageId] });
}

/**
 * Apply a successful chunk-sized Email/set destroy locally in one
 * transaction, matching the JMAP operation's confirmed id set.
 */
export async function applyDestroyBatchLocally(handlers, account, { messageIds = [] }) {
  const ids = (messageIds ?? []).map(Number).filter(Number.isFinite);
  if (ids.length === 0) return;
  await handlers[DB_RPC.OUTBOX_APPLY_DESTROY_BATCH]({
    accountId: account.id,
    messageIds: ids,
  });
}

/**
 * Apply a successful Email/set create + EmailSubmission/set send
 * locally. The constitution requires the local cache to match the
 * server before the mutation RPC resolves; without this step the new
 * email would only land via a later StateChange push.
 *
 * Pulls the freshly-created email back from the server (its
 * mailboxIds reflect the post-onSuccessUpdateEmail state, i.e. the
 * Sent folder and not the transient Drafts/Outbox box used during
 * create), persists it via persistEmails so messages and
 * folder_messages match, and prepends the new remote_id at position 0
 * in any open Sent mailbox-window query_view so a subsequent
 * listMessagesForView read returns the row immediately.
 *
 * sentRemoteId is the JMAP mailbox id of Sent. With no sentRemoteId
 * we still persist the message but skip the query_view update; the
 * next folder visit will rebuild the window from the server.
 */
export async function applySendLocally({
  transport, account, handlers, useWebSocket = false,
  createdRemoteId, sentRemoteId,
}) {
  if (!createdRemoteId) return;
  const payload = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
    methodCalls: [[
      'Email/get',
      {
        accountId: account.remote_account_id,
        ids: [createdRemoteId],
        properties: EMAIL_LIST_PROPERTIES,
      },
      'r1',
    ]],
    useWebSocket,
  });
  const got = payload?.methodResponses?.find((r) => r[0] === 'Email/get')?.[1];
  const email = got?.list?.[0];
  if (!email) return;

  await persistEmails({ account, emails: [email], handlers });

  if (!sentRemoteId) return;
  const folderRows = await handlers[DB_RPC.QUERY]({
    sql: 'SELECT id FROM folders WHERE account_id = ? AND remote_id = ?',
    params: [account.id, sentRemoteId],
  });
  const sentFolderId = folderRows[0]?.id;
  if (sentFolderId == null) return;

  // Prepend the new remote_id at position 0 of every open Sent
  // mailbox-window query_view and bump total. Sent is sorted newest
  // first, so position 0 is correct for any sort variant the open
  // view holds.
  const viewRows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT id FROM query_views
           WHERE account_id = ? AND folder_id = ?
             AND view_type = 'mailbox-window'`,
    params: [account.id, Number(sentFolderId)],
  });
  for (const view of viewRows) {
    const viewId = Number(view.id);
    const result = await handlers[DB_RPC.QUERY_VIEW_APPLY_CHANGES]({
      viewId,
      removed: [],
      added: [{ id: createdRemoteId, index: 0 }],
    });
    if (Number(result?.added ?? 0) > 0) {
      await handlers[DB_RPC.QUERY]({
        sql: `UPDATE query_views
                 SET total = COALESCE(total, 0) + ?,
                     updated_at = ?
               WHERE id = ?`,
        params: [Number(result.added), Date.now(), viewId],
      });
    }
  }
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
