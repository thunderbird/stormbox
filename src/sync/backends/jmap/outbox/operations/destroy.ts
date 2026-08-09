import { DB_RPC } from '../../../../../db/protocol';
import { callJmap, pickResponse } from '../../invoke';
import { maxObjectsInSet } from '../../limits';
import { JMAP_CAPS } from '../../transport';
import { finishMessageBatch } from '../batch';
import { extractMethodError } from '../errors';
import { chunks } from '../jmap';
import { collectMessageIds, reconcileMessageFromServer } from '../messages-shared';
import { resolveMessageContextsByAccount } from '../resolve';

async function runDestroy({ transport, handlers, row, request, useWebSocket }) {
  const messageIds = collectMessageIds(row, request);
  if (messageIds.length === 0) {
    return { ok: false, error: { type: 'unknownMessage' } };
  }
  const resolvedByAccount = await resolveMessageContextsByAccount(handlers, messageIds);
  if (resolvedByAccount.size === 0) {
    return { ok: false, error: { type: 'unknownMessage' } };
  }
  const succeededIds: number[] = [];
  const errors: Record<string, any> = {};
  let lastResponse;
  for (const resolved of resolvedByAccount.values()) {
    const owner = resolved[0].account;
    for (const chunk of chunks(resolved, maxObjectsInSet(transport))) {
      const raw = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
        methodCalls: [['Email/set', {
          accountId: owner.remote_account_id,
          destroy: chunk.map((message) => message.remoteId),
        }, 's1']],
        useWebSocket,
      });
      lastResponse = raw;
      const response = pickResponse(raw, 'Email/set');
      if (!response) {
        const failure = extractMethodError(raw, { count: chunk.length });
        for (const message of chunk) errors[String(message.localId)] = failure;
        continue;
      }
      const destroyed = new Set(response.destroyed ?? []);
      const confirmed = chunk.filter((message) => destroyed.has(message.remoteId));
      if (confirmed.length > 0) {
        await handlers[DB_RPC.OUTBOX_APPLY_DESTROY_BATCH]({
          accountId: owner.id,
          messageIds: confirmed.map((message) => message.localId),
        });
        succeededIds.push(...confirmed.map((message) => message.localId));
      }
      for (const message of chunk) {
        const failure = response.notDestroyed?.[message.remoteId];
        if (!failure) {
          if (!destroyed.has(message.remoteId)) {
            errors[String(message.localId)] = { type: 'notDestroyed', detail: null };
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
          removeRemoteFolderIds: [],
        });
        if (reconciled.gone) succeededIds.push(message.localId);
        else errors[String(message.localId)] = { type: 'notDestroyed', detail: failure };
      }
    }
  }
  return finishMessageBatch(succeededIds, errors, lastResponse);
}

export { runDestroy };
