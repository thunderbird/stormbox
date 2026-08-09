import { DB_RPC } from '../../../../db/protocol';
import { JMAP_CAPS } from '../transport';
import { callJmap, pickResponse } from '../invoke';
import { EMAIL_LIST_PROPERTIES, persistEmails } from '../messages';

/**
 * Pull the list of local message ids out of a pending_mutations row.
 *
 *   request.messageIds: number[]   - preferred shape, set by the store
 *                                    for both single and bulk callers.
 *   request.messageId:  number     - legacy single shape; kept so any
 *                                    pre-existing pending rows still drain.
 *   row.target_message_id          - legacy single FK pointer, also kept
 *                                    for back-compat with older rows.
 *
 * Returns a deduped array of finite numbers. May be empty.
 */
function collectMessageIds(row, request) {
  const out = new Set();
  if (Array.isArray(request?.messageIds)) {
    for (const id of request.messageIds) {
      const n = Number(id);
      if (Number.isFinite(n)) out.add(n);
    }
  }
  if (out.size === 0 && request?.messageId != null) {
    const n = Number(request.messageId);
    if (Number.isFinite(n)) out.add(n);
  }
  if (out.size === 0 && row?.target_message_id != null) {
    const n = Number(row.target_message_id);
    if (Number.isFinite(n)) out.add(n);
  }
  return [...out];
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
async function reconcileMessageFromServer({
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

  const got = pickResponse(payload, 'Email/get');
  const list = got?.list ?? [];
  const notFound = got?.notFound ?? [];

  if (list.length === 0 || notFound.includes(remoteId)) {
    // Server confirmed the message is gone; apply the destroy locally
    // through the protocol-neutral handler.
    await handlers[DB_RPC.OUTBOX_APPLY_DESTROY_BATCH]({
      accountId: account.id,
      messageIds: [messageId],
    });
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

async function dropFromActiveViews(handlers, account, { folderId, remoteId }) {
  // Used by reconcileMessageFromServer when an Email/get confirms the
  // message moved out of a folder we expected it to leave. Going
  // through OUTBOX_APPLY_MOVE here would require knowing the
  // messageId; this narrow per-view fix only needs the remoteId.
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

export { collectMessageIds, dropFromActiveViews, reconcileMessageFromServer };
