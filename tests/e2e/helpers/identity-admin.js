import {
  STACK_STALWART_API_AUTH,
  STACK_STALWART_API_URL,
  STACK_STALWART_PRINCIPAL,
} from './stack-env.js';
import {
  jmapRequest,
  pickResponse,
} from './jmap-client.js';

/**
 * Identity administration against the local stack: what the e2e principal
 * may send as (Stalwart management API) and its JMAP Identity objects.
 */

/**
 * Add (`addItem`) or remove (`removeItem`) an address from the principal's
 * `emails`, which is what Stalwart consults before accepting an Identity.
 */
export async function patchPrincipalEmails(action, address) {
  const response = await fetch(
    `${STACK_STALWART_API_URL}/api/principal/${encodeURIComponent(STACK_STALWART_PRINCIPAL)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: STACK_STALWART_API_AUTH,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ action, field: 'emails', value: address }]),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Principal ${action} for ${address} failed: ${response.status} ${response.statusText}`
      + (body ? ` body=${body.slice(0, 200)}` : ''),
    );
  }
}

/** `Identity/set` with `params` (create/update/destroy); returns its response. */
export async function identitySet(jmap, params) {
  const result = await jmapRequest(jmap, [[
    'Identity/set',
    { accountId: jmap.accountId, ...params },
    'identity-set',
  ]]);
  return pickResponse(result, 'Identity/set') ?? {};
}

export async function listIdentities(jmap) {
  const result = await jmapRequest(jmap, [[
    'Identity/get',
    { accountId: jmap.accountId },
    'identity-get',
  ]]);
  return pickResponse(result, 'Identity/get')?.list ?? [];
}

/** The server's Identity for `email`, or null. */
export async function directIdentity(jmap, email) {
  return (await listIdentities(jmap))
    .find((identity) => identity.email === email) ?? null;
}

/** Ids of every Identity for `email`; all identities when `email` is omitted. */
export async function identityIds(jmap, email) {
  return (await listIdentities(jmap))
    .filter((identity) => !email || identity.email === email)
    .map((identity) => identity.id);
}
