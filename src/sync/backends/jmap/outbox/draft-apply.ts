import { DB_RPC } from '../../../../db/protocol';
import { fetchAndCheckpointComposeBody } from '../compose-body-checkpoint';
import type { ComposeRegularAttachmentSource } from '../compose-email';
import { callJmap, pickResponseById } from '../invoke';
import { maxObjectsInGet, maxObjectsInSet } from '../limits';
import { EMAIL_LIST_PROPERTIES, persistEmails } from '../messages';
import { isAuthenticationError, JMAP_CAPS } from '../transport';
import { extractMethodErrorById } from './errors';
import { chunks } from './jmap';

export type DestroyDraftEmailsResult =
  | {
      ok: true;
      confirmedIds: string[];
      response: any;
    }
  | {
      ok: false;
      confirmedIds: string[];
      remainingIds: string[];
      error: any;
    };

async function reconcileDestroyedDraftEmails({
  transport,
  account,
  ids,
  useWebSocket,
}: {
  transport: any;
  account: any;
  ids: string[];
  useWebSocket: boolean;
}): Promise<{ conclusive: boolean; gone: string[]; existing: string[] }> {
  const gone = new Set<string>();
  let conclusive = true;
  const getChunks = chunks(ids, maxObjectsInGet(transport));
  for (let index = 0; index < getChunks.length; index += 1) {
    const chunk = getChunks[index];
    try {
      const callId = `draft-destroy-get-${index}`;
      const result = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
        methodCalls: [[
          'Email/get',
          {
            accountId: account.remote_account_id,
            ids: chunk,
            properties: ['id'],
          },
          callId,
        ]],
        useWebSocket,
      });
      const response = pickResponseById(result, 'Email/get', callId);
      if (!response || !Array.isArray(response.list) || !Array.isArray(response.notFound)) {
        const methodError = extractMethodErrorById(result, callId);
        if (isAuthenticationError(methodError)) throw methodError;
        conclusive = false;
        continue;
      }
      const requested = new Set(chunk);
      const existingIds = response.list.map((email) => email?.id);
      const notFoundIds = response.notFound;
      const observed = [...existingIds, ...notFoundIds];
      if (
        observed.some((id) => typeof id !== 'string' || !requested.has(id))
        || new Set(observed).size !== observed.length
        || new Set(observed).size !== requested.size
      ) {
        conclusive = false;
      }
      for (const id of notFoundIds) {
        if (typeof id === 'string' && requested.has(id)) gone.add(id);
      }
    } catch (error) {
      if (isAuthenticationError(error)) throw error;
      conclusive = false;
    }
  }
  return {
    conclusive,
    gone: ids.filter((id) => gone.has(id)),
    existing: ids.filter((id) => !gone.has(id)),
  };
}

export async function destroyDraftEmails({
  transport,
  account,
  handlers,
  draftsRemoteId,
  remoteIds,
  useWebSocket = false,
  onProgress,
}: {
  transport: any;
  account: any;
  handlers: Record<string, (params: any) => Promise<any>>;
  draftsRemoteId: string | null;
  remoteIds: string[];
  useWebSocket?: boolean;
  onProgress?: (progress: {
    confirmedIds: string[];
    remainingIds: string[];
  }) => Promise<void>;
}): Promise<DestroyDraftEmailsResult> {
  let pending = [...new Set(remoteIds)];
  const confirmedIds: string[] = [];
  let lastResponse: any = null;
  if (pending.length === 0) {
    return { ok: true, confirmedIds, response: lastResponse };
  }
  const setLimit = maxObjectsInSet(transport);
  let chunkIndex = 0;
  while (pending.length > 0) {
    const chunk = pending.slice(0, setLimit);
    const callId = `draft-destroy-${chunkIndex}`;
    const result = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
      methodCalls: [[
        'Email/set',
        { accountId: account.remote_account_id, destroy: chunk },
        callId,
      ]],
      useWebSocket,
    });
    lastResponse = result;
    const response = pickResponseById(result, 'Email/set', callId);
    let confirmed: string[] = [];
    let error: any = null;
    if (!response) {
      error = extractMethodErrorById(result, callId) ?? { type: 'noResponse' };
      if (error?.type === 'serverPartialFail') {
        const reconciled = await reconcileDestroyedDraftEmails({
          transport,
          account,
          ids: chunk,
          useWebSocket,
        });
        confirmed = reconciled.gone;
        if (reconciled.conclusive && reconciled.existing.length === 0) {
          error = null;
        }
      }
    } else {
      const destroyed = new Set<string>(response.destroyed ?? []);
      confirmed = chunk.filter((id) =>
        destroyed.has(id) || response.notDestroyed?.[id]?.type === 'notFound');
      const unconfirmed = chunk.filter((id) => !confirmed.includes(id));
      if (unconfirmed.length > 0) {
        error = Object.fromEntries(
          unconfirmed.map((id) => [
            id,
            response.notDestroyed?.[id] ?? { type: 'notDestroyed' },
          ]),
        );
      }
    }
    if (confirmed.length > 0) {
      await dropDraftPredecessors({
        transport,
        account,
        handlers,
        draftsRemoteId,
        remoteIds: confirmed,
        useWebSocket,
      });
      const confirmedSet = new Set(confirmed);
      pending = pending.filter((id) => !confirmedSet.has(id));
      confirmedIds.push(...confirmed);
      await onProgress?.({
        confirmedIds: confirmed,
        remainingIds: [...pending],
      });
    }
    if (error) {
      return {
        ok: false,
        confirmedIds,
        remainingIds: pending,
        error,
      };
    }
    chunkIndex += 1;
  }
  return { ok: true, confirmedIds, response: lastResponse };
}

function parseJson(value: string): any {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function reconcileDraftViews({
  transport,
  account,
  handlers,
  draftsRemoteId,
  successorId = null,
  useWebSocket,
}) {
  if (!draftsRemoteId) return;
  const folderRows = await handlers[DB_RPC.QUERY]({
    sql: 'SELECT id FROM folders WHERE account_id = ? AND remote_id = ?',
    params: [account.id, draftsRemoteId],
  });
  const folderId = Number(folderRows[0]?.id);
  if (!Number.isFinite(folderId)) return;
  const views = await handlers[DB_RPC.QUERY]({
    sql: `SELECT id, filter_json, sort_json FROM query_views
           WHERE account_id = ? AND folder_id = ?
             AND view_type = 'mailbox-window'`,
    params: [account.id, folderId],
  });
  const methodCalls: any[] = views.map((view, index) => {
    const filter = parseJson(view.filter_json);
    const sort = parseJson(view.sort_json);
    return [
      'Email/query',
      {
        accountId: account.remote_account_id,
        ...(filter ? { filter } : { filter: { inMailbox: draftsRemoteId } }),
        ...(Array.isArray(sort) && sort.length > 0 ? { sort } : {}),
        ...(successorId ? { anchor: successorId, anchorOffset: 0 } : { position: 0 }),
        limit: 1,
        calculateTotal: true,
      },
      `dq${index}`,
    ];
  });
  methodCalls.push([
    'Mailbox/get',
    {
      accountId: account.remote_account_id,
      ids: [draftsRemoteId],
      properties: ['id', 'totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads'],
    },
    'dm1',
  ]);
  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
    methodCalls,
    useWebSocket,
  });

  for (let index = 0; index < views.length; index += 1) {
    const query = pickResponseById(result, 'Email/query', `dq${index}`);
    const total = Number(query?.total);
    const position = Number(query?.position);
    if (!query || !Number.isFinite(total)
        || (successorId && !Number.isFinite(position))) {
      await handlers[DB_RPC.QUERY]({
        sql: 'UPDATE query_views SET stale = 1, updated_at = ? WHERE id = ?',
        params: [Date.now(), Number(views[index].id)],
      });
      continue;
    }
    if (successorId) {
      await handlers[DB_RPC.QUERY_VIEW_APPLY_CHANGES]({
        viewId: Number(views[index].id),
        removed: [successorId],
        added: [{ id: successorId, index: position }],
      });
    }
    await handlers[DB_RPC.QUERY]({
      sql: 'UPDATE query_views SET total = ?, updated_at = ? WHERE id = ?',
      params: [total, Date.now(), Number(views[index].id)],
    });
  }

  const mailbox = pickResponseById(result, 'Mailbox/get', 'dm1')?.list?.[0];
  if (mailbox?.id === draftsRemoteId) {
    await handlers[DB_RPC.FOLDER_UPDATE_COUNTS_MANY]({
      accountId: account.id,
      folders: [{
        remoteId: draftsRemoteId,
        totalEmails: Number(mailbox.totalEmails ?? 0),
        unreadEmails: Number(mailbox.unreadEmails ?? 0),
        totalThreads: Number(mailbox.totalThreads ?? 0),
        unreadThreads: Number(mailbox.unreadThreads ?? 0),
      }],
    });
  }
}

export async function persistDraftSuccessor({
  transport,
  account,
  handlers,
  draftsRemoteId,
  successorId,
  expectedBodyStructure,
  expectedBodyValues,
  expectedRegularAttachments,
  useWebSocket = false,
}: {
  transport: any;
  account: any;
  handlers: Record<string, (params: any) => Promise<any>>;
  draftsRemoteId: string;
  successorId: string;
  expectedBodyStructure: any;
  expectedBodyValues: Record<string, any>;
  expectedRegularAttachments: ComposeRegularAttachmentSource[];
  useWebSocket?: boolean;
}): Promise<{ localMessageId: number; attachments: any[]; regularAttachments: any[] }> {
  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
    methodCalls: [[
      'Email/get',
      {
        accountId: account.remote_account_id,
        ids: [successorId],
        properties: EMAIL_LIST_PROPERTIES,
      },
      'dg1',
    ]],
    useWebSocket,
  });
  const email = pickResponseById(result, 'Email/get', 'dg1')?.list?.[0];
  if (!email
      || email.id !== successorId
      || email.mailboxIds?.[draftsRemoteId] !== true
      || email.keywords?.$draft !== true) {
    throw new Error('Created draft could not be confirmed in Drafts');
  }
  await persistEmails({ account, emails: [email], handlers });
  const body = await fetchAndCheckpointComposeBody({
    transport,
    account,
    handlers,
    remoteId: successorId,
    expectedBodyStructure,
    expectedBodyValues,
    expectedRegularAttachments,
    useWebSocket,
  });
  await reconcileDraftViews({
    transport,
    account,
    handlers,
    draftsRemoteId,
    successorId,
    useWebSocket,
  });
  return body;
}

export async function dropDraftPredecessors({
  transport,
  account,
  handlers,
  draftsRemoteId,
  remoteIds,
  useWebSocket = false,
}) {
  if (remoteIds.length > 0) {
    await handlers[DB_RPC.MESSAGE_DESTROY_REMOTE_IDS_BATCH]({
      accountId: account.id,
      remoteIds,
    });
  }
  await reconcileDraftViews({
    transport,
    account,
    handlers,
    draftsRemoteId,
    useWebSocket,
  });
}
