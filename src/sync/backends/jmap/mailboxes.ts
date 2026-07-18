/**
 * Mailbox synchronisation. Translates JMAP Mailbox/get and Mailbox/changes
 * results into folders rows.
 *
 * Bootstrap path: callers run syncMailboxes(); the engine pulls Mailbox/get
 * and upserts every mailbox.
 *
 * Delta path: state-change handler calls syncMailboxChanges() with the
 * previously stored state; we issue Mailbox/changes, then Mailbox/get for
 * created/updated ids, then upsert. Destroyed ids are soft-deleted.
 */

import { DB_RPC } from '../../../db/protocol';
import { wlog } from '../../../db/worker-log';
import { JMAP_CAPS } from './transport';
import { callJmap, pickResponse } from './invoke';

const MAILBOX_PROPERTIES = [
  'id', 'name', 'parentId', 'role', 'sortOrder',
  'totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads',
  'myRights', 'isSubscribed',
];

// Fallback when the server does not advertise maxObjectsInGet. Matches
// Stalwart's default jmap.protocol.get.max-objects, which silently
// truncates unpaged Mailbox/get responses.
const DEFAULT_GET_CAP = 500;
// Upper bound on Mailbox/changes round-trips before giving up and
// falling back to a full sync.
const MAX_CHANGES_PAGES = 20;

/** Read the server-advertised jmap-core maxObjectsInGet, if any. */
async function readMaxObjectsInGet(handlers, accountId) {
  try {
    const rows = await handlers[DB_RPC.QUERY]({
      sql: `SELECT payload_json FROM account_capabilities
              WHERE account_id = ? AND capability = ?
              LIMIT 1`,
      params: [accountId, 'urn:ietf:params:jmap:core'],
    });
    const payload = rows?.[0]?.payload_json ? JSON.parse(rows[0].payload_json) : null;
    const raw = Number(payload?.maxObjectsInGet);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GET_CAP;
  } catch {
    return DEFAULT_GET_CAP;
  }
}

/**
 * Fetch the complete mailbox list. Servers cap an unpaged Mailbox/get
 * (Stalwart truncates at get.max-objects without any error), so when
 * the first response fills the cap we page the id list via
 * Mailbox/query and fetch the remainder in id-chunks. The common case
 * (fewer mailboxes than the cap) stays a single round-trip.
 */
async function fetchAllMailboxes({ transport, account, handlers, useWebSocket }) {
  const first = pickResponse(await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
    methodCalls: [[
      'Mailbox/get',
      { accountId: account.remote_account_id, properties: MAILBOX_PROPERTIES },
      'g1',
    ]],
    useWebSocket,
  }), 'Mailbox/get');
  let list = first?.list ?? [];
  let state = first?.state;
  const cap = await readMaxObjectsInGet(handlers, account.id);
  if (list.length < cap) {
    return { list, state };
  }

  // Possibly truncated: collect every id, then fetch the ones we miss.
  const ids = [];
  for (let position = 0; ;) {
    const query = pickResponse(await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
      methodCalls: [[
        'Mailbox/query',
        { accountId: account.remote_account_id, position, limit: cap, calculateTotal: true },
        'q1',
      ]],
      useWebSocket,
    }), 'Mailbox/query');
    const got = query?.ids ?? [];
    ids.push(...got);
    const total = Number(query?.total);
    if (got.length === 0 || (Number.isFinite(total) && ids.length >= total)) break;
    position += got.length;
  }
  const have = new Set(list.map((m) => m.id));
  const missing = ids.filter((id) => !have.has(id));
  for (let i = 0; i < missing.length; i += cap) {
    const got = pickResponse(await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
      methodCalls: [[
        'Mailbox/get',
        {
          accountId: account.remote_account_id,
          ids: missing.slice(i, i + cap),
          properties: MAILBOX_PROPERTIES,
        },
        'g-page',
      ]],
      useWebSocket,
    }), 'Mailbox/get');
    list = list.concat(got?.list ?? []);
    state = got?.state ?? state;
  }
  return { list, state };
}

/**
 * Pull the full mailbox set and persist it. Used on first connect and
 * whenever the locally-tracked Mailbox state token is missing.
 *
 * repairArchive should be false for shared accounts: the user usually
 * lacks the rights to create or re-role mailboxes there, and a shared
 * account is not required to have an Archive at all.
 */
export async function syncMailboxes({ transport, account, handlers, useWebSocket = false, repairArchive = true }) {
  const response = await fetchAllMailboxes({ transport, account, handlers, useWebSocket });
  const repaired = repairArchive
    ? await ensureArchiveMailbox({
      transport,
      account,
      mailboxes: response.list ?? [],
      state: response.state,
      useWebSocket,
    })
    : { mailboxes: response.list ?? [], state: response.state };
  const list = repaired.mailboxes;
  await persistMailboxes({ account, mailboxes: list, handlers });
  await tombstoneMissingFolders({ account, mailboxes: list, handlers });
  await handlers[DB_RPC.SYNC_STATE_SET]({
    accountId: account.id,
    objectType: 'Mailbox',
    state: repaired.state,
  });
  return { state: repaired.state, count: list.length };
}

/**
 * A full sync is authoritative: any live local folder row whose remote
 * id was not in the server's list no longer exists (destroyed while we
 * were offline, or dropped by an earlier truncated sync). Soft-delete
 * them so the sidebar and Manage Folders stop offering rows whose
 * mutations the server can only answer with notFound/notUpdated.
 */
async function tombstoneMissingFolders({ account, mailboxes, handlers }) {
  const rows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT id, remote_id FROM folders
           WHERE account_id = ? AND is_deleted = 0 AND remote_id IS NOT NULL`,
    params: [account.id],
  });
  const serverIds = new Set(mailboxes.map((m) => m.id));
  const stale = rows.filter((row) => !serverIds.has(row.remote_id));
  if (stale.length === 0) return;
  wlog.info('jmap-mailboxes', `tombstoning ${stale.length} folders missing from full sync`);
  // Same soft-delete shape the Mailbox/changes destroyed path uses, so
  // the handler broadcasts FOLDERS and the sidebar repaints.
  await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
    accountId: account.id,
    folders: stale.map((row) => ({
      remoteId: row.remote_id,
      name: '(deleted)',
      isDeleted: true,
    })),
  });
}

/**
 * Apply Mailbox changes since `sinceState`. Returns an object describing
 * what we did so callers can decide whether to refetch totals or trees.
 */
export async function syncMailboxChanges({ transport, account, handlers, sinceState, useWebSocket = false }) {
  // Page through Mailbox/changes: one round of maxChanges=500 is not
  // enough after a large offline delta (e.g. bulk folder imports), and
  // stopping early would persist newState while silently dropping the
  // rest of the delta.
  const created = [];
  const updated = [];
  const destroyed = [];
  let cursor = sinceState;
  let newState;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_CHANGES_PAGES) {
      return { needsFullSync: true };
    }
    const changeResult = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
      methodCalls: [[
        'Mailbox/changes',
        { accountId: account.remote_account_id, sinceState: cursor, maxChanges: 500 },
        'c1',
      ]],
      useWebSocket,
    });
    const change = pickResponse(changeResult, 'Mailbox/changes');
    if (change == null) {
      // Server returned an error payload (e.g. cannotCalculateChanges);
      // tell the caller to fall back to a full sync.
      return { needsFullSync: true };
    }
    created.push(...(change.created ?? []));
    updated.push(...(change.updated ?? []));
    destroyed.push(...(change.destroyed ?? []));
    newState = change.newState;
    if (!change.hasMoreChanges) break;
    cursor = change.newState;
  }

  const ids = [...new Set([...created, ...updated])];
  let upserted = [];
  if (ids.length > 0) {
    const cap = await readMaxObjectsInGet(handlers, account.id);
    for (let i = 0; i < ids.length; i += cap) {
      const getResult = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
        methodCalls: [[
          'Mailbox/get',
          {
            accountId: account.remote_account_id,
            ids: ids.slice(i, i + cap),
            properties: MAILBOX_PROPERTIES,
          },
          'g2',
        ]],
        useWebSocket,
      });
      const got = pickResponse(getResult, 'Mailbox/get');
      upserted = upserted.concat(got?.list ?? []);
    }
    await persistMailboxes({ account, mailboxes: upserted, handlers });
  }
  const change = { destroyed, newState };
  if (change.destroyed?.length) {
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: change.destroyed.map((remoteId) => ({
        remoteId,
        name: '(deleted)',
        isDeleted: true,
      })),
    });
  }
  await handlers[DB_RPC.SYNC_STATE_SET]({
    accountId: account.id,
    objectType: 'Mailbox',
    state: change.newState,
  });
  return {
    needsFullSync: false,
    created,
    updated,
    destroyed,
    upserted,
    newState: change.newState,
  };
}

async function ensureArchiveMailbox({
  transport,
  account,
  mailboxes,
  state,
  useWebSocket,
}) {
  if (mailboxes.some((mailbox) => mailbox.role === 'archive')) {
    return { mailboxes, state };
  }

  const target = selectArchiveRoleTarget(mailboxes);
  // isSubscribed: true keeps the repaired/created Archive visible in
  // clients that filter on subscriptions (RFC 8621 §2 recommends new
  // user-created mailboxes default to subscribed, but Stalwart leaves
  // Mailbox/set creates unsubscribed unless told otherwise).
  const methodCalls = target
    ? [[
        'Mailbox/set',
        {
          accountId: account.remote_account_id,
          update: {
            [target.id]: { role: 'archive', isSubscribed: true },
          },
        },
        's1',
      ]]
    : [[
        'Mailbox/set',
        {
          accountId: account.remote_account_id,
          create: {
            archive: { name: 'Archives', role: 'archive', isSubscribed: true },
          },
        },
        's1',
      ]];

  try {
    const setResult = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
      methodCalls,
      useWebSocket,
    });
    const setResponse = pickResponse(setResult, 'Mailbox/set');
    const changedId = target?.id ?? setResponse?.created?.archive?.id;
    if (!setResponse || !changedId || setResponse.notCreated?.archive || setResponse.notUpdated?.[changedId]) {
      wlog.warn('jmap-mailboxes', 'archive mailbox repair was rejected by server');
      return { mailboxes, state };
    }

    const getResult = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
      methodCalls: [[
        'Mailbox/get',
        { accountId: account.remote_account_id, ids: [changedId], properties: MAILBOX_PROPERTIES },
        'g-archive',
      ]],
      useWebSocket,
    });
    const getResponse = pickResponse(getResult, 'Mailbox/get');
    const repairedMailbox = getResponse?.list?.[0];
    if (!repairedMailbox) {
      wlog.warn('jmap-mailboxes', 'archive mailbox repair could not refetch changed mailbox');
      return { mailboxes, state: setResponse.newState ?? state };
    }

    return {
      mailboxes: mergeMailbox(mailboxes, repairedMailbox),
      state: getResponse.state ?? setResponse.newState ?? state,
    };
  } catch (err) {
    wlog.warn('jmap-mailboxes', 'archive mailbox repair failed', err);
    return { mailboxes, state };
  }
}

function selectArchiveRoleTarget(mailboxes) {
  return mailboxes.find((mailbox) => mailbox.name === 'Archives')
    ?? mailboxes.find((mailbox) => mailbox.name === 'Archive')
    ?? null;
}

function mergeMailbox(mailboxes, mailbox) {
  const index = mailboxes.findIndex((existing) => existing.id === mailbox.id);
  if (index === -1) {
    return [...mailboxes, mailbox];
  }
  const next = mailboxes.slice();
  next[index] = mailbox;
  return next;
}

async function persistMailboxes({ account, mailboxes, handlers }) {
  // First pass: upsert every mailbox row. JMAP gives us the remote parent
  // id (a string); the schema's parent_id column is the local integer id,
  // which we resolve in a second pass once every row exists.
  const folders = mailboxes.map((m) => ({
    remoteId: m.id,
    name: m.name,
    role: m.role ?? null,
    sortOrder: m.sortOrder ?? 0,
    totalEmails: m.totalEmails ?? null,
    unreadEmails: m.unreadEmails ?? null,
    totalThreads: m.totalThreads ?? null,
    unreadThreads: m.unreadThreads ?? null,
    mayReadItems: m.myRights?.mayReadItems ?? null,
    mayAddItems: m.myRights?.mayAddItems ?? null,
    mayRemoveItems: m.myRights?.mayRemoveItems ?? null,
    rightsJson: m.myRights ? JSON.stringify(m.myRights) : null,
    rawJson: JSON.stringify(m),
    isSubscribed: typeof m.isSubscribed === 'boolean' ? m.isSubscribed : null,
    isDeleted: false,
  }));
  await handlers[DB_RPC.FOLDER_UPSERT_MANY]({ accountId: account.id, folders });

  // Second pass: resolve string parentId -> local INTEGER parent_id. We
  // fan out one parameterised UPDATE per child folder and run them in a
  // single transaction so partial failures roll back.
  const updates = [];
  for (const m of mailboxes) {
    if (!m.parentId) {
      continue;
    }
    updates.push({
      sql: `UPDATE folders
                  SET parent_id = (SELECT id FROM folders
                                    WHERE account_id = ? AND remote_id = ?)
                WHERE account_id = ? AND remote_id = ?`,
      params: [account.id, m.parentId, account.id, m.id],
    });
  }
  if (updates.length > 0) {
    await handlers[DB_RPC.TRANSACTION]({ statements: updates });
  }
}

