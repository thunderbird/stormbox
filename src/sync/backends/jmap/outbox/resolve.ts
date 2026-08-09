import { DB_RPC } from '../../../../db/protocol';

type FolderId = number;

interface FolderContext {
  id: number;
  remote_id: string;
  account_id: number;
  remote_account_id: string;
}
interface FolderMutationHandlerArgs {
  transport: any;
  account?: { id: number; remote_account_id: string };
  handlers: Record<string, (params: any) => Promise<any>>;
  request: any;
  useWebSocket: boolean;
}
async function resolveFolderContexts(
  handlers: Record<string, (params: any) => Promise<any>>,
  folderIds: FolderId[],
): Promise<Map<number, FolderContext>> {
  const ids = [...new Set(folderIds.map(Number).filter(Number.isFinite))];
  if (ids.length === 0) return new Map();
  const rows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT f.id, f.remote_id, f.account_id, a.remote_account_id
            FROM folders f
            JOIN accounts a ON a.id = f.account_id
           WHERE f.id IN (${ids.map(() => '?').join(',')})
             AND f.is_deleted = 0`,
    params: ids,
  });
  return new Map(rows
    .filter((folder) => folder?.remote_id && folder?.remote_account_id)
    .map((folder) => [Number(folder.id), folder]));
}

async function resolveLocallyDestroyedFolderIds(
  handlers: Record<string, (params: any) => Promise<any>>,
  folderIds: FolderId[],
): Promise<Set<number>> {
  const ids = [...new Set(folderIds.map(Number).filter(Number.isFinite))];
  if (ids.length === 0) return new Set();
  const rows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT id FROM folders
           WHERE id IN (${ids.map(() => '?').join(',')})
             AND is_deleted = 1`,
    params: ids,
  });
  return new Set(rows.map((row) => Number(row.id)));
}
/**
 * Looks up remote ids for an array of local message ids in one query,
 * dropping any that no longer exist locally (e.g. a peer already
 * destroyed the row before the outbox got to it). Returns
 * [{ localId, remoteId }, ...] in no guaranteed order.
 */
/**
 * Account-aware variant of resolveRemoteMessageIds. Groups local
 * message ids by the JMAP remote account id that owns them so callers
 * can issue one set call per account. Returns
 * Map<remoteAccountId, [{ localId, remoteId }]>.
 */
async function resolveRemoteMessageIdsByAccount(handlers, messageIds) {
  const out = new Map();
  const contexts = await resolveMessageContextsByAccount(handlers, messageIds);
  for (const rows of contexts.values()) {
    const remoteAccountId = rows[0]?.account?.remote_account_id;
    if (!remoteAccountId) continue;
    out.set(remoteAccountId, rows.map((row) => ({
      localId: row.localId,
      remoteId: row.remoteId,
    })));
  }
  return out;
}

async function resolveMessageContextsByAccount(handlers, messageIds) {
  const out = new Map<number, any[]>();
  if (!Array.isArray(messageIds) || messageIds.length === 0) return out;
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT m.id, m.remote_id, m.account_id, a.remote_account_id
            FROM messages m
            JOIN accounts a ON a.id = m.account_id
           WHERE m.id IN (${placeholders})`,
    params: messageIds,
  });
  const rowsById = new Map<number, any>(
    rows.map((row: any) => [Number(row.id), row]),
  );
  for (const messageId of messageIds) {
    const row = rowsById.get(Number(messageId));
    if (!row) continue;
    if (!row.remote_id || !row.remote_account_id) continue;
    const accountId = Number(row.account_id);
    const group = out.get(accountId) ?? [];
    group.push({
      localId: Number(row.id),
      remoteId: row.remote_id,
      account: {
        id: accountId,
        remote_account_id: row.remote_account_id,
      },
    });
    out.set(accountId, group);
  }
  return out;
}

/**
 * Position-preserving variant of resolveRemoteFolderIds. Returns the
 * remote_id at the same array index as the input local id, or null if
 * the id is missing or no folders row matches. Used by send to
 * translate (draftsFolderId, sentFolderId, outboxFolderId) into the
 * matching JMAP mailbox ids without losing the slot ordering.
 */
async function resolveFolderRemoteIds(handlers, localIds) {
  const result = new Array(localIds.length).fill(null);
  const numericById = new Map();
  for (let i = 0; i < localIds.length; i += 1) {
    const id = Number(localIds[i]);
    if (!Number.isFinite(id)) continue;
    if (!numericById.has(id)) numericById.set(id, []);
    numericById.get(id).push(i);
  }
  if (numericById.size === 0) return result;
  const ids = [...numericById.keys()];
  const placeholders = ids.map(() => '?').join(',');
  const rows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT id, remote_id FROM folders WHERE id IN (${placeholders})`,
    params: ids,
  });
  for (const row of rows) {
    const slots = numericById.get(Number(row.id));
    if (!slots) continue;
    for (const slot of slots) result[slot] = row.remote_id ?? null;
  }
  return result;
}

async function resolveIdentity(handlers, account, localIdentityId) {
  const id = Number(localIdentityId);
  if (!Number.isFinite(id)) return null;
  const rows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT id, remote_id, name, email
            FROM identities
           WHERE account_id = ? AND id = ?`,
    params: [account.id, id],
  });
  return rows[0] ?? null;
}

export {
  resolveFolderContexts,
  resolveFolderRemoteIds,
  resolveIdentity,
  resolveLocallyDestroyedFolderIds,
  resolveMessageContextsByAccount,
  resolveRemoteMessageIdsByAccount,
};
export type { FolderContext, FolderId, FolderMutationHandlerArgs };
