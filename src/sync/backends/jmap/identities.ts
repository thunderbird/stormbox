/**
 * Identity sync. JMAP Identity/get + Identity/changes.
 * Identities feed the compose form's "From" picker.
 */

import { DB_RPC } from '../../../db/protocol';
import { JMAP_CAPS } from './transport';
import { callJmap, pickResponse } from './invoke';

const IDENTITY_PROPERTIES = ['id', 'name', 'email', 'replyTo', 'bcc', 'textSignature', 'htmlSignature', 'mayDelete'];

export async function syncIdentities({ transport, account, handlers, useWebSocket = false }) {
  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.SUBMISSION],
    methodCalls: [[
      'Identity/get',
      { accountId: account.remote_account_id, properties: IDENTITY_PROPERTIES },
      'i1',
    ]],
    useWebSocket,
  });
  const response = pickResponse(result, 'Identity/get');
  // An unreadable response is not an account without identities, and
  // neither is a readable one carrying no list. Applying either as a
  // snapshot would empty the From picker over a bad reply.
  if (!response || !Array.isArray(response.list)) {
    return { count: 0, state: null, removed: 0 };
  }
  const list = response.list;
  const { removed } = await handlers[DB_RPC.IDENTITY_UPSERT_MANY]({
    accountId: account.id,
    snapshot: true,
    identities: list.map((id) => ({
      remoteId: id.id,
      name: id.name ?? null,
      email: id.email,
      replyToJson: id.replyTo ? JSON.stringify(id.replyTo) : null,
      bccJson: id.bcc ? JSON.stringify(id.bcc) : null,
      rawJson: JSON.stringify(id),
    })),
  });
  if (response.state) {
    await handlers[DB_RPC.SYNC_STATE_SET]({
      accountId: account.id,
      objectType: 'Identity',
      state: response.state,
    });
  }
  return { count: list.length, state: response.state ?? null, removed };
}

