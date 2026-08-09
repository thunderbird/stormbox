import { DB_RPC } from '../../../../../db/protocol';
import { callJmap, pickResponse } from '../../invoke';
import { maxObjectsInSet } from '../../limits';
import { JMAP_CAPS } from '../../transport';
import { finishFolderBatch } from '../batch';
import type { FolderProcessResult } from '../batch';
import { extractMethodError, transportFolderError } from '../errors';
import { chunks } from '../jmap';
import { resolveFolderContexts } from '../resolve';
import type { FolderMutationHandlerArgs } from '../resolve';

/**
 * Rename and/or move a mailbox (RFC 8621 §2.5 update of name/parentId).
 * request shape:
 *   { folderId: <local folders.id>, name?: string,
 *     parentFolderId?: <local folders.id> | null }
 *
 * `parentFolderId` present-and-null means "move to top level"; absent
 * means "leave the parent alone". Requires myRights.mayRename on
 * shared mailboxes (Stalwart maps its Modify ACL to mayRename).
 */
async function runUpdateMailbox({
  transport, handlers, request, useWebSocket,
}: FolderMutationHandlerArgs): Promise<FolderProcessResult> {
  const operations = Array.isArray(request?.operations) ? request.operations : [request];
  const ids = operations.flatMap((operation) => [
    Number(operation?.folderId),
    Number(operation?.parentFolderId),
  ]).filter((id) => Number.isFinite(id));
  const contexts = await resolveFolderContexts(handlers, ids);
  const errors: Record<string, any> = {};
  const groups = new Map<string, any[]>();
  for (const operation of operations) {
    const folderId = Number(operation?.folderId);
    const folder = contexts.get(folderId);
    if (!folder) {
      errors[String(folderId)] = { type: 'unknownFolder' };
      continue;
    }
    const parentProvided = Object.prototype.hasOwnProperty.call(operation, 'parentFolderId');
    const patch: any = {};
    if (typeof operation?.name === 'string' && operation.name.trim()) {
      patch.name = operation.name.trim();
    }
    let localParentId = null;
    if (parentProvided) {
      if (operation.parentFolderId == null) {
        patch.parentId = null;
      } else {
        const parent = contexts.get(Number(operation.parentFolderId));
        if (!parent || parent.account_id !== folder.account_id) {
          errors[String(folderId)] = { type: 'unknownFolder' };
          continue;
        }
        patch.parentId = parent.remote_id;
        localParentId = parent.id;
      }
    }
    if (Object.keys(patch).length === 0) {
      errors[String(folderId)] = { type: 'emptyUpdate' };
      continue;
    }
    const group = groups.get(folder.remote_account_id) ?? [];
    group.push({
      folder,
      patch,
      cache: {
        folderId,
        name: patch.name ?? null,
        parentProvided,
        parentFolderId: localParentId,
      },
    });
    groups.set(folder.remote_account_id, group);
  }
  const confirmed: any[] = [];
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
            update: Object.fromEntries(chunk.map((item) => [item.folder.remote_id, item.patch])),
          }, 's1']],
          useWebSocket,
        });
      } catch (error) {
        const failure = transportFolderError(error);
        for (const item of chunk) errors[String(item.folder.id)] = failure;
        return finishFolderBatch(
          confirmed.map((item) => item.folderId),
          errors,
          lastResponse,
        );
      }
      lastResponse = raw;
      const response = pickResponse(raw, 'Mailbox/set');
      if (!response) {
        const failure = extractMethodError(raw);
        for (const item of chunk) errors[String(item.folder.id)] = failure;
        return finishFolderBatch(
          confirmed.map((item) => item.folderId),
          errors,
          lastResponse,
        );
      }
      const chunkConfirmed: any[] = [];
      for (const item of chunk) {
        const failure = response.notUpdated?.[item.folder.remote_id];
        if (failure) {
          errors[String(item.folder.id)] = { type: 'notUpdated', detail: failure };
        } else {
          chunkConfirmed.push(item.cache);
        }
      }
      if (chunkConfirmed.length > 0) {
        await handlers[DB_RPC.OUTBOX_APPLY_FOLDER_UPDATES]({ updates: chunkConfirmed });
        confirmed.push(...chunkConfirmed);
      }
    }
  }
  return finishFolderBatch(
    confirmed.map((item) => item.folderId),
    errors,
    lastResponse,
  );
}

export { runUpdateMailbox };
