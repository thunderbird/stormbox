import { DB_RPC } from '../../../../../db/protocol';
import { callJmap, pickResponse } from '../../invoke';
import { maxObjectsInSet } from '../../limits';
import { JMAP_CAPS } from '../../transport';
import { finishFolderBatch } from '../batch';
import type { FolderProcessResult } from '../batch';
import { extractMethodError, transportFolderError } from '../errors';
import { chunks } from '../jmap';
import { resolveFolderContexts } from '../resolve';
import type { FolderContext, FolderMutationHandlerArgs } from '../resolve';

/**
 * Toggle a Mailbox's per-user isSubscribed flag (RFC 8621 §2). request
 * shape: { folderId: <local folders.id>, isSubscribed: boolean }.
 *
 * The folder may belong to a shared account (RFC 9670), so the JMAP
 * accountId is resolved from the folder's own accounts row rather
 * than the mutation row's account. Note Stalwart requires the Modify
 * ACL to change any property of a shared mailbox, including
 * isSubscribed; a "forbidden" SetError surfaces as a terminal
 * notUpdated error the store can show to the user.
 */
async function runSetMailboxSubscription({
  transport, handlers, request, useWebSocket,
}: FolderMutationHandlerArgs): Promise<FolderProcessResult> {
  const operations = Array.isArray(request?.operations)
    ? request.operations
    : [{ folderId: request?.folderId, isSubscribed: request?.isSubscribed }];
  // Last operation wins for duplicate folder ids. This makes malformed
  // payloads deterministic without emitting duplicate remote ids in the
  // Mailbox/set update map.
  const normalizedById = new Map<number, { folderId: number; isSubscribed: boolean }>();
  for (const operation of operations) {
    const normalized = {
      folderId: Number(operation?.folderId),
      isSubscribed: operation?.isSubscribed === true,
    };
    if (Number.isFinite(normalized.folderId)) {
      normalizedById.set(normalized.folderId, normalized);
    }
  }
  const normalized = [...normalizedById.values()];
  const contexts = await resolveFolderContexts(
    handlers,
    normalized.map((operation) => operation.folderId),
  );
  const errors: Record<string, any> = {};
  const groups = new Map<string, Array<{ folder: FolderContext; isSubscribed: boolean }>>();
  for (const operation of normalized) {
    const folder = contexts.get(operation.folderId);
    if (!folder) {
      errors[String(operation.folderId)] = { type: 'unknownFolder' };
      continue;
    }
    const group = groups.get(folder.remote_account_id) ?? [];
    group.push({ folder, isSubscribed: operation.isSubscribed });
    groups.set(folder.remote_account_id, group);
  }
  const confirmed: Array<{ folderId: number; isSubscribed: boolean }> = [];
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
            update: Object.fromEntries(chunk.map((item) => [
              item.folder.remote_id,
              { isSubscribed: item.isSubscribed },
            ])),
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
      const chunkConfirmed: Array<{ folderId: number; isSubscribed: boolean }> = [];
      for (const item of chunk) {
        const failure = response.notUpdated?.[item.folder.remote_id];
        if (failure) {
          errors[String(item.folder.id)] = { type: 'notUpdated', detail: failure };
        } else {
          chunkConfirmed.push({ folderId: item.folder.id, isSubscribed: item.isSubscribed });
        }
      }
      if (chunkConfirmed.length > 0) {
        await handlers[DB_RPC.OUTBOX_APPLY_FOLDER_SUBSCRIPTIONS]({ updates: chunkConfirmed });
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

export { runSetMailboxSubscription };
