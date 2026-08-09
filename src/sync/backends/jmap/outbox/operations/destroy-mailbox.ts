import { DB_RPC } from '../../../../../db/protocol';
import { callJmap, pickResponse } from '../../invoke';
import { maxObjectsInSet } from '../../limits';
import { JMAP_CAPS } from '../../transport';
import { finishFolderBatch } from '../batch';
import type { FolderProcessResult } from '../batch';
import { extractMethodError, transportFolderError } from '../errors';
import { chunks } from '../jmap';
import { resolveFolderContexts, resolveLocallyDestroyedFolderIds } from '../resolve';
import type { FolderMutationHandlerArgs } from '../resolve';

/**
 * Destroy a mailbox (RFC 8621 §2.5). request shape:
 *   { folderId: <local folders.id>, onDestroyRemoveEmails?: boolean }
 *
 * With onDestroyRemoveEmails false (the default and the store's first
 * attempt), a mailbox that still contains mail is rejected with a
 * mailboxHasEmail SetError; the store escalates to an explicit user
 * confirmation before retrying with true. mailboxHasChild is always
 * terminal — children must be moved or deleted first. Shared mailboxes
 * additionally need myRights.mayDelete (and mayRemoveItems when
 * removing emails) on Stalwart.
 */
async function runDestroyMailbox({
  transport, handlers, request, useWebSocket,
}: FolderMutationHandlerArgs): Promise<FolderProcessResult> {
  const operations = Array.isArray(request?.operations) ? request.operations : [request];
  const normalizedById = new Map<number, {
    folderId: number;
    onDestroyRemoveEmails: boolean;
  }>();
  for (const operation of operations) {
    const normalized = {
      folderId: Number(operation?.folderId),
      onDestroyRemoveEmails: operation?.onDestroyRemoveEmails === true,
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
  const alreadyDestroyed = await resolveLocallyDestroyedFolderIds(
    handlers,
    normalized
      .map((operation) => operation.folderId)
      .filter((folderId) => !contexts.has(folderId)),
  );
  const errors: Record<string, any> = {};
  const groups = new Map<string, any[]>();
  for (const operation of normalized) {
    const folder = contexts.get(operation.folderId);
    if (!folder) {
      if (!alreadyDestroyed.has(operation.folderId)) {
        errors[String(operation.folderId)] = { type: 'unknownFolder' };
      }
      continue;
    }
    const key = `${folder.remote_account_id}\u0000${operation.onDestroyRemoveEmails ? '1' : '0'}`;
    const group = groups.get(key) ?? [];
    group.push({ folder, onDestroyRemoveEmails: operation.onDestroyRemoveEmails });
    groups.set(key, group);
  }
  const confirmed: any[] = [...alreadyDestroyed].map((folderId) => ({ folderId }));
  let lastResponse;
  const cap = maxObjectsInSet(transport);
  for (const items of groups.values()) {
    const remoteAccountId = items[0].folder.remote_account_id;
    const onDestroyRemoveEmails = items[0].onDestroyRemoveEmails;
    for (const chunk of chunks(items, cap)) {
      let raw;
      try {
        raw = await callJmap(transport, {
          using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
          methodCalls: [['Mailbox/set', {
            accountId: remoteAccountId,
            destroy: chunk.map((item) => item.folder.remote_id),
            onDestroyRemoveEmails,
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
        const failure = response.notDestroyed?.[item.folder.remote_id];
        if (failure) {
          errors[String(item.folder.id)] = { type: 'notDestroyed', detail: failure };
        } else {
          chunkConfirmed.push({
            folderId: item.folder.id,
            accountId: item.folder.account_id,
            onDestroyRemoveEmails: item.onDestroyRemoveEmails,
          });
        }
      }
      if (chunkConfirmed.length > 0) {
        await handlers[DB_RPC.OUTBOX_APPLY_FOLDER_DESTROYS]({ destroys: chunkConfirmed });
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

export { runDestroyMailbox };
