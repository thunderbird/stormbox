/**
 * Email/query + Email/get + Email/queryChanges + Email/changes -> the
 * messages, threads, folder_messages, message_addresses, message_keywords
 * rows the UI reads from.
 *
 * Two entry points:
 *
 *   syncFolderWindow(): bootstrap path. Runs Email/query for a folder
 *     window, persists the result in query_views + query_view_items, and
 *     fetches list metadata for any new ids.
 *
 *   syncFolderWindowChanges(): delta path. Runs Email/queryChanges with
 *     the saved query_state, applies added/removed to query_view_items,
 *     fetches metadata for newly-visible ids.
 *
 *   syncEmailChanges(): account-wide Email/changes pass for cached
 *     objects outside an active window (e.g. read/flag changes from
 *     other devices).
 */

import { DB_RPC } from '../../../db/protocol.js';
import { JMAP_CAPS } from './transport.js';

/**
 * The "fast properties" list from WEBMAIL_SQLITE_STORAGE_SPEC.md > JMAP
 * Sync Strategy. Enough for the message list and metadata header without
 * pulling body parts.
 */
export const EMAIL_LIST_PROPERTIES = [
  'id', 'blobId', 'threadId', 'mailboxIds', 'keywords', 'size',
  'receivedAt', 'sentAt', 'messageId', 'inReplyTo', 'references',
  'sender', 'from', 'to', 'cc', 'bcc', 'replyTo',
  'subject', 'preview', 'hasAttachment',
];

const ADDRESS_KINDS = ['from', 'to', 'cc', 'bcc', 'replyTo', 'sender'];

/**
 * Pull a window of an Email/query result and persist all the resulting
 * rows. Caller passes the local folder row plus a sort/range definition.
 * sortProp is 'receivedAt' (default) or 'sentAt'.
 *
 * @returns {Promise<{ total: number, queryState: string, fetched: number, viewId: number }>}
 */
export async function syncFolderWindow({
  transport, account, folder, handlers,
  sortProp = 'receivedAt',
  position = 0,
  limit = 100,
  collapseThreads = false,
  useWebSocket = false,
}) {
  const filter = { inMailbox: folder.remote_id };
  const sort = [{ property: sortProp, isAscending: false }];

  // Single round trip: Email/query + Email/get chained via JMAP back
  // reference (RFC 8620 §3.1.3). The server resolves "ids" of the get
  // call from the result of the query, so we never have to wait for the
  // ID list before requesting metadata. This roughly halves first-paint
  // latency and is the main reason to talk JMAP over an open WebSocket
  // versus paying TLS handshakes per HTTP POST.
  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
    methodCalls: [
      [
        'Email/query',
        {
          accountId: account.remote_account_id,
          filter,
          sort,
          position,
          limit,
          calculateTotal: true,
          collapseThreads,
        },
        'q1',
      ],
      [
        'Email/get',
        {
          accountId: account.remote_account_id,
          '#ids': {
            resultOf: 'q1',
            name: 'Email/query',
            path: '/ids',
          },
          properties: EMAIL_LIST_PROPERTIES,
        },
        'g1',
      ],
    ],
    useWebSocket,
  });
  const query = pickResponse(result, 'Email/query');
  if (!query) {
    throw new Error('Email/query returned no payload');
  }

  const viewId = await upsertQueryView({
    handlers,
    account,
    folder,
    sortProp,
    collapseThreads,
    queryState: query.queryState,
    canCalculateChanges: query.canCalculateChanges ?? null,
    total: query.total ?? null,
  });

  const ids = query.ids ?? [];
  await upsertQueryViewItems({ handlers, viewId, position, ids });
  await recordQueryViewRange({ handlers, viewId, start: position, end: position + ids.length });

  let fetched = 0;
  const got = pickResponse(result, 'Email/get');
  const list = got?.list ?? [];
  if (list.length > 0) {
    await persistEmails({ account, emails: list, handlers });
    fetched = list.length;
  }

  return {
    total: query.total ?? null,
    queryState: query.queryState,
    fetched,
    viewId,
  };
}

/**
 * Delta variant. Caller passes the previously-stored queryState. We run
 * Email/queryChanges, apply the added/removed positions, and fetch any
 * metadata we don't already have.
 */
export async function syncFolderWindowChanges({
  transport, account, folder, handlers,
  sinceQueryState,
  sortProp = 'receivedAt',
  collapseThreads = false,
  maxChanges = 500,
  useWebSocket = false,
}) {
  const filter = { inMailbox: folder.remote_id };
  const sort = [{ property: sortProp, isAscending: false }];

  // Email/queryChanges + Email/get for the newly-added ids in a single
  // round trip via back reference. The server resolves
  // /added/*/id from the queryChanges response into the get's ids.
  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
    methodCalls: [
      [
        'Email/queryChanges',
        {
          accountId: account.remote_account_id,
          filter,
          sort,
          sinceQueryState,
          maxChanges,
          calculateTotal: true,
          collapseThreads,
        },
        'qc1',
      ],
      [
        'Email/get',
        {
          accountId: account.remote_account_id,
          '#ids': {
            resultOf: 'qc1',
            name: 'Email/queryChanges',
            path: '/added/*/id',
          },
          properties: EMAIL_LIST_PROPERTIES,
        },
        'g2',
      ],
    ],
    useWebSocket,
  });
  const change = pickResponse(result, 'Email/queryChanges');
  if (!change || !change.newQueryState) {
    return { needsFullSync: true };
  }

  const viewId = await upsertQueryView({
    handlers,
    account,
    folder,
    sortProp,
    collapseThreads,
    queryState: change.newQueryState,
    canCalculateChanges: 1,
    total: change.total ?? null,
  });

  const additions = change.added ?? [];
  const removedIds = change.removed ?? [];
  // Single transactional pass that applies the RFC 8620 §5.5
  // queryChanges algorithm: remove + compact, then add + shift. The
  // handler also broadcasts MESSAGES so remove-only deltas (e.g. a
  // peer device moved a message out of this folder) still trigger a
  // message-list refresh in the UI.
  if (removedIds.length > 0 || additions.length > 0) {
    await handlers[DB_RPC.QUERY_VIEW_APPLY_CHANGES]({
      viewId,
      removed: removedIds,
      added: additions,
    });
  }

  let fetched = 0;
  const got = pickResponse(result, 'Email/get');
  const list = got?.list ?? [];
  if (list.length > 0) {
    await persistEmails({ account, emails: list, handlers });
    fetched = list.length;
  }

  return {
    needsFullSync: false,
    queryState: change.newQueryState,
    added: additions,
    removed: removedIds,
    total: change.total ?? null,
    fetched,
  };
}

/**
 * Account-wide Email/changes pass. Refreshes the metadata of cached
 * objects that may have changed (read/flag from other devices, moves,
 * destroys), regardless of whether they are in any active window.
 */
export async function syncEmailChanges({
  transport, account, handlers,
  sinceState,
  maxChanges = 500,
  useWebSocket = false,
}) {
  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
    methodCalls: [[
      'Email/changes',
      { accountId: account.remote_account_id, sinceState, maxChanges },
      'c1',
    ]],
    useWebSocket,
  });
  const change = pickResponse(result, 'Email/changes');
  if (!change || !change.newState) {
    return { needsFullSync: true };
  }
  const ids = [...(change.created ?? []), ...(change.updated ?? [])];
  if (ids.length > 0) {
    const got = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
      methodCalls: [[
        'Email/get',
        {
          accountId: account.remote_account_id,
          ids,
          properties: EMAIL_LIST_PROPERTIES,
        },
        'g1',
      ]],
      useWebSocket,
    });
    const list = pickResponse(got, 'Email/get')?.list ?? [];
    await persistEmails({ account, emails: list, handlers });
  }
  if (change.destroyed?.length) {
    // Before nuking the messages row, drop any query_view_items
    // entries that reference its remote_id. The FK on
    // query_view_items.message_id only has ON DELETE SET NULL, so
    // the bulk DELETE below would leave skeleton-placeholder rows
    // showing in every folder view that knew about this message
    // (and would also leave query_views.total over-counting the
    // dead positions). _refreshActiveQueryViews only runs queryChanges
    // on the top-5 LRU views, so any other folder would keep the
    // ghost until the user manually navigated back to it.
    await dropRemoteIdsFromAllViews(handlers, account, change.destroyed);
    const placeholders = change.destroyed.map(() => '?').join(',');
    await handlers[DB_RPC.QUERY]({
      sql: `DELETE FROM messages
              WHERE account_id = ? AND remote_id IN (${placeholders})`,
      params: [account.id, ...change.destroyed],
    });
  }
  await handlers[DB_RPC.SYNC_STATE_SET]({
    accountId: account.id,
    objectType: 'Email',
    state: change.newState,
  });
  return {
    needsFullSync: false,
    created: change.created ?? [],
    updated: change.updated ?? [],
    destroyed: change.destroyed ?? [],
    newState: change.newState,
  };
}

// ----- helpers ---------------------------------------------------------

/**
 * Public helper: given a list of Email JSON objects (as returned by
 * Email/get with EMAIL_LIST_PROPERTIES), upsert messages rows and
 * reconcile folder_messages against the server-side mailboxIds.
 * Exported so the outbox reconciliation path can refresh local cache
 * for a single message after a failed Email/set, without having to
 * re-route through the sync engine's batched paths.
 */
export async function persistEmails({ account, emails, handlers }) {
  if (emails.length === 0) return;

  // Pre-create thread rows so messages.thread_id can resolve.
  const threadIds = uniq(emails.map((e) => e.threadId).filter(Boolean));
  if (threadIds.length > 0) {
    await handlers[DB_RPC.THREAD_UPSERT_MANY]({
      accountId: account.id,
      threads: threadIds.map((remoteId) => ({ remoteId })),
    });
  }
  // Build a remoteThreadId -> localId map.
  const threadMap = new Map();
  if (threadIds.length > 0) {
    const placeholders = threadIds.map(() => '?').join(',');
    const rows = await handlers[DB_RPC.QUERY]({
      sql: `SELECT id, remote_id FROM threads WHERE account_id = ? AND remote_id IN (${placeholders})`,
      params: [account.id, ...threadIds],
    });
    for (const r of rows) {
      threadMap.set(r.remote_id, r.id);
    }
  }

  // Upsert messages with addresses + keywords cascaded.
  const ts = Date.now();
  const messages = emails.map((e) => {
    const keywords = Object.keys(e.keywords ?? {}).filter((k) => e.keywords[k]);
    return {
      remoteId: e.id,
      threadId: threadMap.get(e.threadId) ?? null,
      remoteThreadId: e.threadId ?? null,
      blobId: e.blobId ?? null,
      rfc822MessageId: extractMessageId(e.messageId),
      inReplyToJson: e.inReplyTo ? JSON.stringify(e.inReplyTo) : null,
      referencesJson: e.references ? JSON.stringify(e.references) : null,
      subject: e.subject ?? null,
      preview: e.preview ?? null,
      size: e.size ?? null,
      receivedAt: parseDate(e.receivedAt),
      sentAt: parseDate(e.sentAt),
      hasAttachment: !!e.hasAttachment,
      keywordsJson: JSON.stringify(e.keywords ?? {}),
      keywords,
      isSeen: keywords.includes('$seen'),
      isFlagged: keywords.includes('$flagged'),
      isAnswered: keywords.includes('$answered'),
      isDraft: keywords.includes('$draft'),
      isForwarded: keywords.includes('$forwarded'),
      isJunk: keywords.includes('$junk'),
      fromText: joinAddresses(e.from),
      toText: joinAddresses(e.to),
      rawJson: JSON.stringify(e),
      addresses: addressesFromEmail(e),
      metadataFetchedAt: ts,
    };
  });
  await handlers[DB_RPC.MESSAGE_UPSERT_MANY]({ accountId: account.id, messages });

  // Folder membership: replace rows for each touched message based on
  // the JMAP mailboxIds set. Missing mailboxes (i.e. mailboxIds that have
  // not been synced to folders yet) are skipped silently; the next
  // mailbox sync will catch up.
  const allMailboxIds = uniq(emails.flatMap((e) => Object.keys(e.mailboxIds ?? {})));
  const folderMap = new Map();
  if (allMailboxIds.length > 0) {
    const placeholders = allMailboxIds.map(() => '?').join(',');
    const folderRows = await handlers[DB_RPC.QUERY]({
      sql: `SELECT id, remote_id FROM folders
             WHERE account_id = ? AND remote_id IN (${placeholders})`,
      params: [account.id, ...allMailboxIds],
    });
    for (const row of folderRows) {
      folderMap.set(row.remote_id, row.id);
    }
  }

  const emailIds = emails.map((e) => e.id).filter(Boolean);
  const messageMap = new Map();
  if (emailIds.length > 0) {
    const placeholders = emailIds.map(() => '?').join(',');
    const messageRows = await handlers[DB_RPC.QUERY]({
      sql: `SELECT id, remote_id FROM messages
             WHERE account_id = ? AND remote_id IN (${placeholders})`,
      params: [account.id, ...emailIds],
    });
    for (const row of messageRows) {
      messageMap.set(row.remote_id, row.id);
    }
  }

  const replacements = [];
  for (const e of emails) {
    const messageId = messageMap.get(e.id);
    if (!messageId) continue;
    const memberships = Object.keys(e.mailboxIds ?? {})
      .map((mailboxId) => folderMap.get(mailboxId))
      .filter(Boolean)
      .map((folderId) => ({
        folderId,
        sortReceivedAt: parseDate(e.receivedAt),
        sortSentAt: parseDate(e.sentAt) ?? parseDate(e.receivedAt),
      }));
    if (memberships.length > 0) {
      replacements.push({ messageId, memberships });
    }
  }
  if (replacements.length > 0) {
    await handlers[DB_RPC.FOLDER_MEMBERSHIP_REPLACE_MANY]({
      accountId: account.id,
      replacements,
    });
  }
}

async function upsertQueryView({
  handlers, account, folder, sortProp, collapseThreads,
  queryState, canCalculateChanges, total,
}) {
  const ts = Date.now();
  const filterJson = JSON.stringify({ inMailbox: folder.remote_id });
  const sortJson = JSON.stringify([{ property: sortProp, isAscending: false }]);
  const params = [
    account.id,
    'mailbox-window',
    folder.id,
    filterJson,
    sortJson,
    collapseThreads ? 1 : 0,
    queryState,
    canCalculateChanges == null ? null : (canCalculateChanges ? 1 : 0),
    total,
    ts,
    ts,
    ts,
  ];
  await handlers[DB_RPC.QUERY]({
    sql: `INSERT INTO query_views(
            account_id, view_type, folder_id, filter_json, sort_json,
            collapse_threads, query_state, can_calculate_changes, total,
            created_at, updated_at, last_accessed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(account_id, view_type, folder_id, filter_json, sort_json, collapse_threads)
          DO UPDATE SET
            query_state = excluded.query_state,
            can_calculate_changes = excluded.can_calculate_changes,
            total = excluded.total,
            updated_at = excluded.updated_at,
            last_accessed_at = excluded.last_accessed_at`,
    params,
  });
  const row = await handlers[DB_RPC.QUERY]({
    sql: `SELECT id FROM query_views
           WHERE account_id = ? AND view_type = ? AND folder_id = ?
             AND filter_json = ? AND sort_json = ? AND collapse_threads = ?`,
    params: [account.id, 'mailbox-window', folder.id, filterJson, sortJson, collapseThreads ? 1 : 0],
  });
  return row[0]?.id;
}

/**
 * Bulk-write the positional ids returned by Email/query for the
 * initial syncFolderWindow pass. Deltas (`added` / `removed` from
 * Email/queryChanges) go through DB_RPC.QUERY_VIEW_APPLY_CHANGES so
 * they get proper position shifting and a MESSAGES broadcast.
 *
 * Implementation note: query_view_items has TWO unique constraints,
 * UNIQUE(view_id, position) and UNIQUE(view_id, remote_id). SQLite
 * supports multiple ON CONFLICT clauses, but they cannot resolve the
 * cross-constraint case where an INSERT both lands on an occupied
 * position AND duplicates an existing remote_id at another position:
 * the position-conflict UPSERT rewrites the row in place, which then
 * collides with the other remote_id-unique row that still exists. The
 * old multi-ON-CONFLICT version threw "UNIQUE constraint failed:
 * query_view_items.view_id, query_view_items.remote_id" every time
 * syncFolderWindow was re-run after applyMoveLocally had compacted
 * positions in the view; that took the whole Inbox load down.
 *
 * We write the range atomically by deleting any stale rows in the
 * target position range AND any rows that already hold one of the new
 * remote_ids elsewhere, then inserting clean. Leaving gaps at the
 * old positions of moved ids is fine: those positions are stale and
 * will be re-fetched on demand.
 */
async function upsertQueryViewItems({ handlers, viewId, position, ids }) {
  if (!ids || ids.length === 0) return;
  const idPlaceholders = ids.map(() => '?').join(',');
  const statements = [
    {
      sql: `DELETE FROM query_view_items
              WHERE view_id = ? AND position >= ? AND position < ?`,
      params: [viewId, position, position + ids.length],
    },
    {
      sql: `DELETE FROM query_view_items
              WHERE view_id = ? AND remote_id IN (${idPlaceholders})`,
      params: [viewId, ...ids],
    },
    ...ids.map((id, i) => ({
      sql: `INSERT INTO query_view_items(view_id, position, message_id, remote_id)
            VALUES (?, ?, NULL, ?)`,
      params: [viewId, position + i, id],
    })),
  ];
  await handlers[DB_RPC.TRANSACTION]({ statements });
}

/**
 * Remove the given remote ids from every query_view_items entry in
 * the account, with position compaction inside each affected view
 * and a matching decrement of query_views.total. Used by
 * syncEmailChanges so destroyed-on-server messages cannot leave
 * skeleton-placeholder rows behind in any folder.
 */
async function dropRemoteIdsFromAllViews(handlers, account, remoteIds) {
  if (!remoteIds?.length) return;
  const placeholders = remoteIds.map(() => '?').join(',');
  const rows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT qv.id AS view_id, qi.remote_id
            FROM query_views qv
            JOIN query_view_items qi ON qi.view_id = qv.id
           WHERE qv.account_id = ?
             AND qi.remote_id IN (${placeholders})`,
    params: [account.id, ...remoteIds],
  });
  if (rows.length === 0) return;
  const byView = new Map();
  for (const row of rows) {
    const viewId = Number(row.view_id);
    if (!byView.has(viewId)) byView.set(viewId, []);
    byView.get(viewId).push(row.remote_id);
  }
  for (const [viewId, ids] of byView) {
    await handlers[DB_RPC.QUERY_VIEW_APPLY_CHANGES]({
      viewId, removed: ids, added: [],
    });
    // The JOIN above guarantees each id was in the view, so we can
    // decrement total by exactly the number of pairs we found.
    await handlers[DB_RPC.QUERY]({
      sql: `UPDATE query_views
               SET total = MAX(0, COALESCE(total, 0) - ?),
                   updated_at = ?
             WHERE id = ?`,
      params: [ids.length, Date.now(), viewId],
    });
  }
}

async function recordQueryViewRange({ handlers, viewId, start, end }) {
  if (end <= start) return;
  await handlers[DB_RPC.QUERY]({
    sql: `INSERT INTO query_view_ranges(view_id, start_position, end_position, fetched_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(view_id, start_position, end_position) DO NOTHING`,
    params: [viewId, start, end, Date.now()],
  });
}

async function engineSelectRemoteIds(handlers, accountId, remoteIds) {
  if (remoteIds.length === 0) return [];
  const placeholders = remoteIds.map(() => '?').join(',');
  return handlers[DB_RPC.QUERY]({
    sql: `SELECT remote_id FROM messages
           WHERE account_id = ? AND remote_id IN (${placeholders})`,
    params: [accountId, ...remoteIds],
  });
}

function addressesFromEmail(email) {
  const out = [];
  for (const kind of ADDRESS_KINDS) {
    const list = email[kind];
    if (!Array.isArray(list)) continue;
    list.forEach((addr, position) => {
      if (!addr) return;
      out.push({
        kind,
        position,
        name: addr.name ?? null,
        email: addr.email ?? null,
      });
    });
  }
  return out;
}

function joinAddresses(list) {
  if (!Array.isArray(list)) return null;
  return list
    .map((a) => {
      const name = (a?.name ?? '').trim();
      const email = (a?.email ?? '').trim();
      if (!email) return name;
      return name ? `${name} <${email}>` : email;
    })
    .filter(Boolean)
    .join(', ');
}

/**
 * JMAP messageId is a list of strings (RFC 5322 Message-Id header values
 * after RFC 5322 unfolding). The local schema stores a single canonical
 * value; pick the first.
 */
function extractMessageId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

function parseDate(iso) {
  if (iso == null) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

async function callJmap(transport, { using, methodCalls, useWebSocket }) {
  if (useWebSocket) {
    return transport.wsRequest(using, methodCalls);
  }
  return transport.request(using, methodCalls);
}

function pickResponse(result, methodName) {
  const responses = result?.methodResponses ?? [];
  const found = responses.find((r) => r[0] === methodName);
  return found?.[1] ?? null;
}
