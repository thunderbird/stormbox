import { DB_RPC } from '../../../../../db/protocol';
import { callJmap, pickResponse } from '../../invoke';
import { maxObjectsInSet } from '../../limits';
import { JMAP_CAPS } from '../../transport';
import { finishFolderBatch } from '../batch';
import type { FolderProcessResult } from '../batch';
import { extractMethodError } from '../errors';
import { chunks } from '../jmap';
import { resolveFolderContexts } from '../resolve';
import type { FolderMutationHandlerArgs } from '../resolve';

/**
 * Create a mailbox (RFC 8621 §2.5). request shape:
 *   { name: string, parentFolderId?: <local folders.id> | null }
 *
 * A child of a shared folder must be created in the owning account
 * (RFC 9670: needs myRights.mayCreateChild on the parent), so the JMAP
 * accountId comes from the parent folder when one is given and from
 * the mutation row's account otherwise. isSubscribed is set explicitly
 * because Stalwart leaves Mailbox/set creates unsubscribed, which
 * would hide the new folder from our own sidebar.
 */
async function runCreateMailbox({
  transport, account, handlers, request, useWebSocket,
}: FolderMutationHandlerArgs): Promise<FolderProcessResult> {
  if (!account) {
    return finishFolderBatch([], { create: { type: 'unknownAccount' } });
  }
  const operations = Array.isArray(request?.operations)
    ? request.operations
    : [{ clientId: 'c1', name: request?.name, parentFolderId: request?.parentFolderId }];
  const parentIds = operations
    .map((operation) => Number(operation?.parentFolderId))
    .filter((id) => Number.isFinite(id));
  const parents = await resolveFolderContexts(handlers, parentIds);
  const errors: Record<string, any> = {};
  const groups = new Map<string, any[]>();
  operations.forEach((operation, index) => {
    const clientId = String(operation?.clientId ?? `c${index + 1}`);
    const name = typeof operation?.name === 'string' ? operation.name.trim() : '';
    if (!name) {
      errors[clientId] = { type: 'invalidName' };
      return;
    }
    const parentId = operation?.parentFolderId == null
      ? null
      : Number(operation.parentFolderId);
    const parent = parentId == null ? null : parents.get(parentId);
    if (parentId != null && !parent) {
      errors[clientId] = { type: 'unknownFolder' };
      return;
    }
    const remoteAccountId = parent?.remote_account_id ?? account.remote_account_id;
    const group = groups.get(remoteAccountId) ?? [];
    group.push({
      clientId,
      name,
      localAccountId: parent?.account_id ?? account.id,
      localParentId: parent?.id ?? null,
      remoteParentId: parent?.remote_id ?? null,
    });
    groups.set(remoteAccountId, group);
  });
  const createdResult: Record<string, { remoteId: string; folderId?: number | null }> = {};
  let lastResponse;
  const cap = maxObjectsInSet(transport);
  for (const [remoteAccountId, items] of groups) {
    for (const chunk of chunks(items, cap)) {
      let raw;
      try {
        raw = await callJmap(transport, {
          using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
          methodCalls: [['Mailbox/set', {
            accountId: remoteAccountId,
            create: Object.fromEntries(chunk.map((item) => [
              item.clientId,
              { name: item.name, parentId: item.remoteParentId, isSubscribed: true },
            ])),
          }, 's1']],
          useWebSocket,
        });
      } catch (error) {
        const failure = {
          type: 'transport',
          message: error?.message ?? String(error),
        };
        for (const item of chunk) errors[item.clientId] = failure;
        continue;
      }
      lastResponse = raw;
      const response = pickResponse(raw, 'Mailbox/set');
      if (!response) {
        const failure = extractMethodError(raw);
        for (const item of chunk) errors[item.clientId] = failure;
        continue;
      }
      const chunkCreates: any[] = [];
      for (const item of chunk) {
        const created = response.created?.[item.clientId];
        if (!created?.id) {
          errors[item.clientId] = {
            type: 'notCreated',
            detail: response.notCreated?.[item.clientId] ?? null,
          };
          continue;
        }
        chunkCreates.push({
          clientId: item.clientId,
          accountId: item.localAccountId,
          remoteId: created.id,
          name: item.name,
          parentFolderId: item.localParentId,
          sortOrder: created.sortOrder ?? 0,
          rightsJson: created.myRights ? JSON.stringify(created.myRights) : null,
          rawJson: JSON.stringify({ ...created, name: item.name, parentId: item.remoteParentId }),
        });
        createdResult[item.clientId] = { remoteId: created.id };
      }
      if (chunkCreates.length > 0) {
        const applied = await handlers[DB_RPC.OUTBOX_APPLY_FOLDER_CREATES]({
          creates: chunkCreates,
        });
        for (const [clientId, folderId] of Object.entries(applied.folderIds ?? {})) {
          if (createdResult[clientId]) {
            createdResult[clientId].folderId = folderId as number | null;
          }
        }
      }
    }
  }
  const result = finishFolderBatch(Object.keys(createdResult), errors, lastResponse);
  result.result.created = createdResult;
  return result;
}

export { runCreateMailbox };
