/**
 * Storage quota sync via RFC 9425 Quota/get.
 */

import { DB_RPC } from '../../../db/protocol.js';
import { JMAP_CAPS } from './transport.js';
import { callJmap, pickResponse } from './invoke.js';

const QUOTA_PROPERTIES = [
  'id',
  'resourceType',
  'used',
  'hardLimit',
  'scope',
  'name',
  'types',
];

export async function syncQuota({ transport, account, handlers, useWebSocket = false }) {
  const session = transport.session;
  if (!session?.capabilities?.[JMAP_CAPS.QUOTA]) {
    return { count: 0, skipped: true };
  }

  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.QUOTA],
    methodCalls: [[
      'Quota/get',
      { accountId: account.remote_account_id, ids: null, properties: QUOTA_PROPERTIES },
      'q1',
    ]],
    useWebSocket,
  });
  const response = pickResponse(result, 'Quota/get');
  const list = response?.list ?? [];

  const diskQuota = list.find((q) => q.resourceType === 'octets' && q.scope === 'account')
    ?? list.find((q) => q.resourceType === 'octets')
    ?? list[0];

  if (!diskQuota || !diskQuota.hardLimit) {
    await handlers[DB_RPC.ACCOUNT_QUOTA_UPSERT]({
      accountId: account.id,
      usedBytes: null,
      hardLimitBytes: null,
    });
    return { count: 0, cleared: true };
  }

  await handlers[DB_RPC.ACCOUNT_QUOTA_UPSERT]({
    accountId: account.id,
    usedBytes: Number(diskQuota.used ?? 0),
    hardLimitBytes: Number(diskQuota.hardLimit),
  });

  if (response?.state) {
    await handlers[DB_RPC.SYNC_STATE_SET]({
      accountId: account.id,
      objectType: 'Quota',
      state: response.state,
    });
  }

  return {
    count: list.length,
    used: Number(diskQuota.used ?? 0),
    hardLimit: Number(diskQuota.hardLimit),
    state: response?.state ?? null,
  };
}

