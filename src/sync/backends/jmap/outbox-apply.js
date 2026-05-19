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
 * Steps:
 *   1. Read the current folder_messages rows for this message.
 *   2. Replace those rows with (existing - removeFolderIds + addFolderIds).
 *      Sort timestamps from any existing membership are carried over;
 *      newly-added folders inherit the same sort timestamps because the
 *      message itself did not change, only its mailbox membership did.
 *   3. For each removed folder, drop the row from any mailbox-window
 *      query_views(folder_id = removed) and decrement that view's total.
 *   4. For each added folder, mark any mailbox-window query_views(folder_id
 *      = added) stale and clear its painted ranges. We do not try to
 *      compute the insert position locally; the next visit re-fetches
 *      the page from the server.
 */
export async function applyMoveLocally(handlers, account, {
  messageId, addFolderIds = [], removeFolderIds = [],
}) {
  if (messageId == null) return;
  const remoteId = await resolveRemoteId(handlers, account, messageId);
  if (!remoteId) return;

  const existing = await handlers[DB_RPC.QUERY]({
    sql: `SELECT folder_id, remote_membership_id, added_at,
                 sort_received_at, sort_sent_at, instance_state_json
            FROM folder_messages WHERE message_id = ?`,
    params: [messageId],
  });

  const removeSet = new Set((removeFolderIds ?? []).map(Number));
  const addList = (addFolderIds ?? []).map(Number);
  const carriedSortReceived = existing[0]?.sort_received_at ?? null;
  const carriedSortSent = existing[0]?.sort_sent_at ?? null;

  const keep = existing.filter((row) => !removeSet.has(Number(row.folder_id)));
  const existingFolderIds = new Set(keep.map((row) => Number(row.folder_id)));
  const additions = addList
    .filter((folderId) => !existingFolderIds.has(folderId))
    .map((folderId) => ({
      folderId,
      sortReceivedAt: carriedSortReceived,
      sortSentAt: carriedSortSent,
    }));

  const memberships = [
    ...keep.map((row) => ({
      folderId: Number(row.folder_id),
      remoteMembershipId: row.remote_membership_id ?? null,
      addedAt: row.added_at ?? null,
      sortReceivedAt: row.sort_received_at ?? null,
      sortSentAt: row.sort_sent_at ?? null,
      instanceStateJson: row.instance_state_json ?? null,
    })),
    ...additions,
  ];

  await handlers[DB_RPC.FOLDER_MEMBERSHIP_REPLACE]({
    accountId: account.id,
    messageId,
    memberships,
  });

  for (const folderId of removeSet) {
    await dropFromActiveViews(handlers, account, { folderId, remoteId });
  }

  for (const folderId of addList) {
    await markDestinationViewsStale(handlers, account, { folderId });
  }
}

/**
 * Apply a successful Email/set destroy locally.
 *
 * Steps:
 *   1. DELETE FROM messages WHERE id = ? — FK cascades clean
 *      folder_messages, message_addresses, message_keywords, body_parts,
 *      body_values automatically.
 *   2. For every query_view that has an entry for this remote_id,
 *      remove the entry (with position compaction) and decrement total.
 *
 * Note: query_view_items.message_id has ON DELETE SET NULL — the join
 * MESSAGE_LIST_FOR_VIEW uses (remote_id) so the deleted row would no
 * longer return, but the position would remain allocated and total
 * would drift. Cleaning the entries explicitly keeps positions and
 * total consistent for any view (including ones the user is not
 * currently looking at).
 */
export async function applyDestroyLocally(handlers, account, { messageId }) {
  if (messageId == null) return;
  const remoteId = await resolveRemoteId(handlers, account, messageId);

  await handlers[DB_RPC.QUERY]({
    sql: 'DELETE FROM messages WHERE id = ? AND account_id = ?',
    params: [messageId, account.id],
  });

  if (!remoteId) return;

  const viewRows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT qv.id
            FROM query_views qv
            JOIN query_view_items qi ON qi.view_id = qv.id
           WHERE qv.account_id = ?
             AND qi.remote_id = ?`,
    params: [account.id, remoteId],
  });
  for (const view of viewRows) {
    await applyRemovalToView(handlers, { viewId: Number(view.id), remoteId });
  }
}

async function dropFromActiveViews(handlers, account, { folderId, remoteId }) {
  const viewRows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT id FROM query_views
           WHERE account_id = ?
             AND folder_id = ?
             AND view_type = 'mailbox-window'`,
    params: [account.id, folderId],
  });
  for (const view of viewRows) {
    await applyRemovalToView(handlers, { viewId: Number(view.id), remoteId });
  }
}

async function applyRemovalToView(handlers, { viewId, remoteId }) {
  const result = await handlers[DB_RPC.QUERY_VIEW_APPLY_CHANGES]({
    viewId,
    removed: [remoteId],
    added: [],
  });
  if (Number(result?.removed ?? 0) > 0) {
    await handlers[DB_RPC.QUERY]({
      sql: `UPDATE query_views
               SET total = MAX(0, COALESCE(total, 0) - 1),
                   updated_at = ?
             WHERE id = ?`,
      params: [Date.now(), viewId],
    });
  }
}

async function markDestinationViewsStale(handlers, account, { folderId }) {
  const viewRows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT id FROM query_views
           WHERE account_id = ?
             AND folder_id = ?
             AND view_type = 'mailbox-window'`,
    params: [account.id, folderId],
  });
  if (viewRows.length === 0) return;
  const placeholders = viewRows.map(() => '?').join(',');
  const ids = viewRows.map((r) => Number(r.id));
  const ts = Date.now();
  await handlers[DB_RPC.QUERY]({
    sql: `UPDATE query_views
             SET stale = 1, updated_at = ?
           WHERE id IN (${placeholders})`,
    params: [ts, ...ids],
  });
  await handlers[DB_RPC.QUERY]({
    sql: `DELETE FROM query_view_ranges WHERE view_id IN (${placeholders})`,
    params: ids,
  });
}

async function resolveRemoteId(handlers, account, messageId) {
  const rows = await handlers[DB_RPC.QUERY]({
    sql: 'SELECT remote_id FROM messages WHERE account_id = ? AND id = ?',
    params: [account.id, messageId],
  });
  return rows[0]?.remote_id ?? null;
}

/**
 * Reconcile local state for a single message against what the server
 * actually has. Called when Email/set update or destroy returned
 * notUpdated/notDestroyed - the most common reason is that local cache
 * and server are out of sync (someone else moved/deleted the message),
 * so the patch could not be applied. Bulwark's webmail trusts Email/set
 * and lets the next StateChange push reconcile; we cannot do that with
 * a SQLite cache because the user navigates through stale rows until
 * the push lands.
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
