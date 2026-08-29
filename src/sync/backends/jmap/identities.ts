import { DB_RPC } from '../../../db/protocol';
import type {
  IdentityAddress,
  IdentityRow,
  IdentityUpsertInput,
  JmapIdentity,
} from '../../../types';
import { identityAddressesFromUnknown } from '../../../utils/identity-fields';
import { JMAP_CAPS } from './transport';
import { callJmap, pickResponse, requireResponse } from './invoke';

const IDENTITY_PROPERTIES = [
  'id',
  'name',
  'email',
  'replyTo',
  'bcc',
  'textSignature',
  'htmlSignature',
  'mayDelete',
];

function nullableString(value: unknown): string | null | undefined {
  if (value == null) return null;
  return typeof value === 'string' ? value : undefined;
}

function nullableAddresses(value: unknown): IdentityAddress[] | null | undefined {
  return identityAddressesFromUnknown(value);
}

interface NormalizedIdentity {
  identity: IdentityUpsertInput;
  conformant: boolean;
}

function normalizeIdentity(value: unknown): NormalizedIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const identity = value as JmapIdentity;
  if (typeof identity.id !== 'string' || !identity.id || typeof identity.email !== 'string') {
    return null;
  }
  const nullName = (identity as { name?: unknown }).name === null;
  const name = typeof identity.name === 'string'
    ? identity.name
    : (nullName ? '' : undefined);
  const replyTo = nullableAddresses(identity.replyTo);
  const bcc = nullableAddresses(identity.bcc);
  const textSignature = nullableString(identity.textSignature);
  const htmlSignature = nullableString(identity.htmlSignature);
  const mayDelete = identity.mayDelete == null
    ? null
    : (typeof identity.mayDelete === 'boolean' ? identity.mayDelete : undefined);
  if (
    name === undefined
    || replyTo === undefined
    || bcc === undefined
    || textSignature === undefined
    || htmlSignature === undefined
    || mayDelete === undefined
  ) {
    return null;
  }
  return {
    conformant: !nullName,
    identity: {
      remoteId: identity.id,
      name,
      email: identity.email,
      replyTo,
      bcc,
      textSignature,
      htmlSignature,
      mayDelete,
      rawJson: JSON.stringify(identity),
    },
  };
}

function completeIdentitySnapshot(
  response: any,
  accountRemoteId: string,
  list: unknown[],
  identities: IdentityUpsertInput[],
  conformant: boolean,
) {
  const ids = identities.map((identity) => identity.remoteId);
  const notFound = response.notFound;
  return typeof response.state === 'string'
    && (response.accountId == null || response.accountId === accountRemoteId)
    && response.hasMore !== true
    && response.isTruncated !== true
    && (typeof response.total !== 'number' || response.total === list.length)
    && conformant
    && identities.length === list.length
    && new Set(ids).size === ids.length
    && (notFound == null || (Array.isArray(notFound) && notFound.length === 0));
}

/**
 * Read the complete account Identity collection. Only a structurally complete
 * GetResponse is allowed to sweep rows that were not returned.
 */
export async function syncIdentities({
  transport,
  account,
  handlers,
  useWebSocket = false,
  requireSnapshot = false,
}) {
  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.SUBMISSION],
    methodCalls: [[
      'Identity/get',
      { accountId: account.remote_account_id, properties: IDENTITY_PROPERTIES },
      'i1',
    ]],
    useWebSocket,
  });
  const response = requireSnapshot
    ? requireResponse(result, 'Identity/get')
    : pickResponse(result, 'Identity/get');
  // An unreadable response is not an account without identities, and
  // neither is a readable one carrying no list. Applying either as a
  // snapshot would empty the From picker over a bad reply.
  if (!response || !Array.isArray(response.list)) {
    if (requireSnapshot) {
      throw new Error('JMAP Identity/get returned an unreadable snapshot');
    }
    return { count: 0, removed: 0 };
  }
  const list: unknown[] = response.list;
  const normalized = list
    .map(normalizeIdentity)
    .filter((identity): identity is NormalizedIdentity => identity !== null);
  const identities = normalized.map((entry) => entry.identity);
  const complete = completeIdentitySnapshot(
    response,
    account.remote_account_id,
    list,
    identities,
    normalized.every((entry) => entry.conformant),
  );
  const { removed } = await handlers[DB_RPC.IDENTITY_UPSERT_MANY]({
    accountId: account.id,
    snapshot: complete,
    identities,
  });
  if (requireSnapshot && !complete) {
    throw new Error('JMAP Identity/get returned an incomplete snapshot');
  }
  return {
    complete,
    count: identities.length,
    removed: removed ?? 0,
  };
}

/**
 * Repair one accepted Identity write without treating the targeted response as
 * an account snapshot.
 */
export async function syncIdentityById({
  transport,
  account,
  handlers,
  remoteId,
  useWebSocket = false,
}: any): Promise<IdentityRow> {
  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.SUBMISSION],
    methodCalls: [[
      'Identity/get',
      {
        accountId: account.remote_account_id,
        ids: [remoteId],
        properties: IDENTITY_PROPERTIES,
      },
      'identity-get-one',
    ]],
    useWebSocket,
  });
  const response = requireResponse(result, 'Identity/get');
  if (!Array.isArray(response.list)) {
    throw new Error('JMAP targeted Identity/get returned an unreadable response');
  }
  const matches = response.list
    .map(normalizeIdentity)
    .filter((identity): identity is NormalizedIdentity =>
      identity !== null && identity.identity.remoteId === remoteId)
    .map((entry) => entry.identity);
  if (matches.length !== 1) {
    throw new Error(`JMAP targeted Identity/get did not return ${remoteId}`);
  }
  await handlers[DB_RPC.IDENTITY_UPSERT_MANY]({
    accountId: account.id,
    snapshot: false,
    identities: matches,
  });
  const row = await handlers[DB_RPC.IDENTITY_GET_BY_REMOTE]({
    accountId: account.id,
    remoteId,
  });
  if (!row) {
    throw new Error(`Identity ${remoteId} was not available after cache repair`);
  }
  return row;
}
