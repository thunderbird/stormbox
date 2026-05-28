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

/**
 * Pull the full mailbox set and persist it. Used on first connect and
 * whenever the locally-tracked Mailbox state token is missing.
 */
export async function syncMailboxes({ transport, account, handlers, useWebSocket = false }) {
  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
    methodCalls: [[
      'Mailbox/get',
      { accountId: account.remote_account_id, properties: MAILBOX_PROPERTIES },
      'g1',
    ]],
    useWebSocket,
  });
  const response = pickResponse(result, 'Mailbox/get');
  const repaired = await ensureArchiveMailbox({
    transport,
    account,
    mailboxes: response.list ?? [],
    state: response.state,
    useWebSocket,
  });
  const list = repaired.mailboxes;
  await persistMailboxes({ account, mailboxes: list, handlers });
  await handlers[DB_RPC.SYNC_STATE_SET]({
    accountId: account.id,
    objectType: 'Mailbox',
    state: repaired.state,
  });
  return { state: repaired.state, count: list.length };
}

/**
 * Apply Mailbox changes since `sinceState`. Returns an object describing
 * what we did so callers can decide whether to refetch totals or trees.
 */
export async function syncMailboxChanges({ transport, account, handlers, sinceState, useWebSocket = false }) {
  const changeResult = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
    methodCalls: [[
      'Mailbox/changes',
      { accountId: account.remote_account_id, sinceState, maxChanges: 500 },
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
  const ids = [...(change.created ?? []), ...(change.updated ?? [])];
  let upserted = [];
  if (ids.length > 0) {
    const getResult = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
      methodCalls: [[
        'Mailbox/get',
        { accountId: account.remote_account_id, ids, properties: MAILBOX_PROPERTIES },
        'g2',
      ]],
      useWebSocket,
    });
    const got = pickResponse(getResult, 'Mailbox/get');
    upserted = got?.list ?? [];
    await persistMailboxes({ account, mailboxes: upserted, handlers });
  }
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
    created: change.created ?? [],
    updated: change.updated ?? [],
    destroyed: change.destroyed ?? [],
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
  const methodCalls = target
    ? [[
        'Mailbox/set',
        {
          accountId: account.remote_account_id,
          update: {
            [target.id]: { role: 'archive' },
          },
        },
        's1',
      ]]
    : [[
        'Mailbox/set',
        {
          accountId: account.remote_account_id,
          create: {
            archive: { name: 'Archives', role: 'archive' },
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

