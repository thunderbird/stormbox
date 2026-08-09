import { maxObjectsInSet } from '../../limits';
import { chunks, submitEmailSet } from '../jmap';
import { collectMessageIds } from '../messages-shared';
import { resolveRemoteMessageIdsByAccount } from '../resolve';

async function runSetKeywords({ transport, handlers, row, request, useWebSocket }) {
  const messageIds = collectMessageIds(row, request);
  if (messageIds.length === 0) {
    return { ok: false, error: { type: 'unknownMessage' } };
  }
  // Keyword flips (e.g. $seen on open) can target messages living in a
  // shared account's folders, so resolve each message's own account and
  // issue one Email/set per remote account.
  const resolvedByAccount = await resolveRemoteMessageIdsByAccount(handlers, messageIds);
  if (resolvedByAccount.size === 0) {
    return { ok: false, error: { type: 'unknownMessage' } };
  }
  const update = {};
  for (const k of request.add ?? []) {
    update[`keywords/${k}`] = true;
  }
  for (const k of request.remove ?? []) {
    update[`keywords/${k}`] = null;
  }
  for (const [remoteAccountId, resolved] of resolvedByAccount) {
    for (const chunk of chunks(resolved, maxObjectsInSet(transport))) {
      const result = await submitEmailSet({
        transport,
        account: { remote_account_id: remoteAccountId },
        useWebSocket,
        update: Object.fromEntries(
          chunk.map(({ remoteId }) => [remoteId, update]),
        ),
      });
      if (!result.ok) return result;
    }
  }
  return { ok: true };
}

export { runSetKeywords };
