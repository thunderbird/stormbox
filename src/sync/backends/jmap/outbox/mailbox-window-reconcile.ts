import { DB_RPC } from '../../../../db/protocol';
import { callJmap, pickResponseById } from '../invoke';
import { JMAP_CAPS } from '../transport';

type RequestFailurePolicy = 'throw' | 'markViewsStale';

interface MailboxWindowReconcileOptions {
  transport: any;
  account: any;
  handlers: Record<string, (params: any) => Promise<any>>;
  mailboxRemoteId: string;
  insertedId?: string | null;
  acceptEmptyFilter?: boolean;
  requestFailurePolicy: RequestFailurePolicy;
  useWebSocket?: boolean;
}

function parseJsonObject(value: string): any {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function markViewsStale(
  handlers: MailboxWindowReconcileOptions['handlers'],
  views: any[],
): Promise<void> {
  for (const view of views) {
    await handlers[DB_RPC.QUERY]({
      sql: 'UPDATE query_views SET stale = 1, updated_at = ? WHERE id = ?',
      params: [Date.now(), Number(view.id)],
    });
  }
}

export async function reconcileMailboxWindow({
  transport,
  account,
  handlers,
  mailboxRemoteId,
  insertedId = null,
  acceptEmptyFilter = true,
  requestFailurePolicy,
  useWebSocket = false,
}: MailboxWindowReconcileOptions): Promise<boolean> {
  const folderRows = await handlers[DB_RPC.QUERY]({
    sql: 'SELECT id FROM folders WHERE account_id = ? AND remote_id = ?',
    params: [account.id, mailboxRemoteId],
  });
  const folderId = Number(folderRows[0]?.id);
  if (!Number.isFinite(folderId)) return false;

  const views = await handlers[DB_RPC.QUERY]({
    sql: `SELECT id, filter_json, sort_json FROM query_views
           WHERE account_id = ? AND folder_id = ?
             AND view_type = 'mailbox-window'`,
    params: [account.id, folderId],
  });
  // CS-1.14: positions, totals, and mailbox counts come from the server.
  const methodCalls: any[] = views.map((view, index) => {
    const filter = parseJsonObject(view.filter_json);
    const sort = parseJsonObject(view.sort_json);
    const useStoredFilter = filter
      && (acceptEmptyFilter || Object.keys(filter).length > 0);
    return [
      'Email/query',
      {
        accountId: account.remote_account_id,
        ...(useStoredFilter ? { filter } : { filter: { inMailbox: mailboxRemoteId } }),
        ...(Array.isArray(sort) && sort.length > 0 ? { sort } : {}),
        ...(insertedId ? { anchor: insertedId, anchorOffset: 0 } : { position: 0 }),
        limit: 1,
        calculateTotal: true,
      },
      `mailbox-window-query-${index}`,
    ];
  });
  methodCalls.push([
    'Mailbox/get',
    {
      accountId: account.remote_account_id,
      ids: [mailboxRemoteId],
      properties: ['id', 'totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads'],
    },
    'mailbox-window-mailbox',
  ]);

  let result: any;
  try {
    result = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
      methodCalls,
      useWebSocket,
    });
  } catch (error) {
    switch (requestFailurePolicy) {
      case 'throw':
        throw error;
      case 'markViewsStale':
        await markViewsStale(handlers, views);
        return true;
      default: {
        const unhandledPolicy: never = requestFailurePolicy;
        throw new Error(
          `Unhandled mailbox-window failure policy: ${unhandledPolicy}`,
          { cause: error },
        );
      }
    }
  }

  for (let index = 0; index < views.length; index += 1) {
    const viewId = Number(views[index].id);
    const query = pickResponseById(
      result,
      'Email/query',
      `mailbox-window-query-${index}`,
    );
    const total = Number(query?.total);
    const position = Number(query?.position);
    if (!query || !Number.isFinite(total)
        || (insertedId && !Number.isFinite(position))) {
      await markViewsStale(handlers, [views[index]]);
      continue;
    }
    if (insertedId) {
      await handlers[DB_RPC.QUERY_VIEW_APPLY_CHANGES]({
        viewId,
        removed: [insertedId],
        added: [{ id: insertedId, index: position }],
      });
    }
    await handlers[DB_RPC.QUERY]({
      sql: 'UPDATE query_views SET total = ?, updated_at = ? WHERE id = ?',
      params: [total, Date.now(), viewId],
    });
  }

  const mailbox = pickResponseById(
    result,
    'Mailbox/get',
    'mailbox-window-mailbox',
  )?.list?.[0];
  if (mailbox?.id === mailboxRemoteId) {
    await handlers[DB_RPC.FOLDER_UPDATE_COUNTS_MANY]({
      accountId: account.id,
      folders: [{
        remoteId: mailboxRemoteId,
        totalEmails: Number(mailbox.totalEmails ?? 0),
        unreadEmails: Number(mailbox.unreadEmails ?? 0),
        totalThreads: Number(mailbox.totalThreads ?? 0),
        unreadThreads: Number(mailbox.unreadThreads ?? 0),
      }],
    });
  }
  return true;
}
