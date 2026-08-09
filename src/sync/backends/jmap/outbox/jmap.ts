import { JMAP_CAPS } from '../transport';
import { callJmap, pickResponse } from '../invoke';
import { extractMethodError } from './errors';

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}
/**
 * RFC 6901 pointer tokens made only of digits are read as array indexes
 * by servers with pre-0.16.5 parsing, so those mailbox ids require a
 * full mailboxIds replacement.
 */
function hasNumericMailboxId(mailboxIds: string[]): boolean {
  return mailboxIds.some((mailboxId) => /^\d+$/.test(mailboxId));
}
async function submitEmailSet({ transport, account, useWebSocket, update, destroy }: {
  transport: any;
  account: any;
  useWebSocket?: boolean;
  update?: any;
  destroy?: any;
}) {
  const params: any = { accountId: account.remote_account_id };
  if (update) params.update = update;
  if (destroy) params.destroy = destroy;
  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
    methodCalls: [['Email/set', params, 's1']],
    useWebSocket,
  });
  const response = pickResponse(result, 'Email/set');
  if (!response) {
    return { ok: false, error: extractMethodError(result) };
  }
  if (response.notUpdated && update && Object.values(response.notUpdated).length > 0) {
    return { ok: false, error: { type: 'notUpdated', detail: response.notUpdated } };
  }
  if (response.notDestroyed && destroy && Object.values(response.notDestroyed).length > 0) {
    return { ok: false, error: { type: 'notDestroyed', detail: response.notDestroyed } };
  }
  return { ok: true, response };
}

export { chunks, hasNumericMailboxId, submitEmailSet };
