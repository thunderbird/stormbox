import { DB_RPC } from '../../../../../db/protocol';
import { callJmap, pickResponse } from '../../invoke';
import { maxObjectsInGet, maxObjectsInSet } from '../../limits';
import { JMAP_CAPS } from '../../transport';
import { finishMessageBatch } from '../batch';
import { extractMethodError, transportFolderError } from '../errors';
import { chunks, hasNumericMailboxId } from '../jmap';
import { collectMessageIds, reconcileMessageFromServer } from '../messages-shared';
import { resolveFolderContexts, resolveMessageContextsByAccount } from '../resolve';

async function runMoveToFolders({ transport, handlers, row, request, useWebSocket }) {
  const messageIds = collectMessageIds(row, request);
  if (messageIds.length === 0) {
    return { ok: false, error: { type: 'unknownMessage' } };
  }
  const addLocalIds = (request.addFolderIds ?? []).map(Number).filter(Number.isFinite);
  const removeLocalIds = (request.removeFolderIds ?? []).map(Number).filter(Number.isFinite);
  const folderContexts = await resolveFolderContexts(
    handlers,
    [...addLocalIds, ...removeLocalIds],
  );
  if (folderContexts.size !== new Set([...addLocalIds, ...removeLocalIds]).size) {
    return { ok: false, error: { type: 'unknownFolder', terminal: true } };
  }
  const folderAccounts = new Set(
    [...folderContexts.values()].map((folder) => folder.account_id),
  );
  if (folderAccounts.size !== 1) {
    return { ok: false, error: { type: 'mixedDestinationAccounts', terminal: true } };
  }
  const resolvedByAccount = await resolveMessageContextsByAccount(handlers, messageIds);
  if (resolvedByAccount.size === 0) {
    return { ok: false, error: { type: 'unknownMessage', terminal: true } };
  }
  const succeededIds: number[] = [];
  const errors: Record<string, any> = {};
  let lastResponse;
  for (const resolved of resolvedByAccount.values()) {
    const owner = resolved[0]?.account;
    if (!owner || !folderAccounts.has(owner.id)) {
      for (const message of resolved) {
        errors[String(message.localId)] = { type: 'crossAccountMove' };
      }
      continue;
    }
    const addRemote = addLocalIds.map((id) => folderContexts.get(id)!.remote_id);
    const removeRemote = removeLocalIds.map((id) => folderContexts.get(id)!.remote_id);
    const requiresFullReplacement = hasNumericMailboxId([...addRemote, ...removeRemote]);
    const patch: Record<string, boolean | null> = {};
    for (const id of addRemote) patch[`mailboxIds/${id}`] = true;
    for (const id of removeRemote) patch[`mailboxIds/${id}`] = null;
    const chunkSize = requiresFullReplacement
      ? Math.min(maxObjectsInGet(transport), maxObjectsInSet(transport))
      : maxObjectsInSet(transport);
    for (const chunk of chunks(resolved, chunkSize)) {
      let submitted = chunk;
      let update: Record<
        string,
        Record<string, boolean | null> | { mailboxIds: Record<string, true> }
      >;
      if (requiresFullReplacement) {
        let getRaw;
        try {
          getRaw = await callJmap(transport, {
            using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
            methodCalls: [['Email/get', {
              accountId: owner.remote_account_id,
              ids: chunk.map((message) => message.remoteId),
              properties: ['id', 'mailboxIds'],
            }, 'g-move-memberships']],
            useWebSocket,
          });
        } catch (error) {
          const failure = transportFolderError(error);
          for (const message of chunk) errors[String(message.localId)] = failure;
          continue;
        }
        lastResponse = getRaw;
        const getResponse = pickResponse(getRaw, 'Email/get');
        if (!getResponse) {
          const failure = extractMethodError(getRaw, { count: chunk.length });
          for (const message of chunk) errors[String(message.localId)] = failure;
          continue;
        }
        const returned = new Map<string, {
          id: string;
          mailboxIds?: Record<string, boolean>;
        }>((getResponse.list ?? []).map((email) => [email.id, email]));
        submitted = [];
        update = {};
        for (const message of chunk) {
          const email = returned.get(message.remoteId);
          if (!email) {
            if (!(getResponse.notFound ?? []).includes(message.remoteId)) {
              errors[String(message.localId)] = { type: 'moveMailboxStateUnavailable' };
              continue;
            }
            // A message the server no longer has satisfies a move out of a
            // folder, and reconciliation is what drops it from the local
            // cache. Same outcome the patch path reaches through
            // notUpdated, so both paths agree on a concurrent deletion.
            const reconciled = await reconcileMessageFromServer({
              transport,
              account: owner,
              handlers,
              useWebSocket,
              messageId: message.localId,
              remoteId: message.remoteId,
              removeRemoteFolderIds: removeRemote,
            });
            const moved = reconciled.gone || (
              reconciled.email
              && !removeRemote.some((id) => reconciled.email.mailboxIds?.[id] === true)
            );
            if (moved) succeededIds.push(message.localId);
            else errors[String(message.localId)] = { type: 'notFound' };
            continue;
          }
          const next = new Set(
            Object.entries(email.mailboxIds ?? {})
              .filter(([, included]) => included === true)
              .map(([mailboxId]) => mailboxId),
          );
          for (const mailboxId of addRemote) next.add(mailboxId);
          for (const mailboxId of removeRemote) next.delete(mailboxId);
          if (next.size === 0) {
            errors[String(message.localId)] = {
              type: 'invalidProperties',
              description: 'The move would leave the Email in no mailbox.',
              properties: ['mailboxIds'],
            };
            continue;
          }
          const mailboxIds: Record<string, true> = {};
          for (const mailboxId of next) mailboxIds[mailboxId] = true;
          update[message.remoteId] = { mailboxIds };
          submitted.push(message);
        }
        if (submitted.length === 0) continue;
      } else {
        update = Object.fromEntries(
          chunk.map((message) => [message.remoteId, patch]),
        );
      }
      const raw = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
        methodCalls: [['Email/set', {
          accountId: owner.remote_account_id,
          update,
        }, 's1']],
        useWebSocket,
      });
      lastResponse = raw;
      const response = pickResponse(raw, 'Email/set');
      if (!response) {
        const failure = extractMethodError(raw, { count: submitted.length });
        for (const message of submitted) errors[String(message.localId)] = failure;
        continue;
      }
      const confirmed = submitted.filter((message) =>
        Object.prototype.hasOwnProperty.call(response.updated ?? {}, message.remoteId));
      if (confirmed.length > 0) {
        await handlers[DB_RPC.OUTBOX_APPLY_MOVE_BATCH]({
          accountId: owner.id,
          messageIds: confirmed.map((message) => message.localId),
          addFolderIds: addLocalIds,
          removeFolderIds: removeLocalIds,
        });
        succeededIds.push(...confirmed.map((message) => message.localId));
      }
      for (const message of submitted) {
        const failure = response.notUpdated?.[message.remoteId];
        if (!failure) {
          if (!Object.prototype.hasOwnProperty.call(response.updated ?? {}, message.remoteId)) {
            errors[String(message.localId)] = { type: 'notUpdated', detail: null };
          }
          continue;
        }
        const reconciled = await reconcileMessageFromServer({
          transport,
          account: owner,
          handlers,
          useWebSocket,
          messageId: message.localId,
          remoteId: message.remoteId,
          removeRemoteFolderIds: removeRemote,
        });
        const moved = reconciled.gone || (
          reconciled.email
          && !removeRemote.some((id) => reconciled.email.mailboxIds?.[id] === true)
        );
        if (moved) succeededIds.push(message.localId);
        else errors[String(message.localId)] = { type: 'notUpdated', detail: failure };
      }
    }
  }
  return finishMessageBatch(succeededIds, errors, lastResponse);
}

export { runMoveToFolders };
