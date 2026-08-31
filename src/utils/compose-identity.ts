import type { IdentityRow } from '../types';
import { addressKey } from './address-key';

export interface ResolveComposeIdentityOptions {
  primaryIdentityRemoteId?: string | null;
}

function indexByRemoteId(identities: IdentityRow[], remoteId: string | null | undefined): number {
  if (!remoteId) return -1;
  return identities.findIndex((identity) => identity.remote_id === remoteId);
}

function indexByEmail(identities: IdentityRow[], email: string | null | undefined): number {
  const normalized = addressKey(email);
  if (!normalized) return -1;
  return identities.findIndex((identity) => addressKey(identity.email) === normalized);
}

export function findMatchingIdentityIndex(
  identities: IdentityRow[],
  identity: Pick<IdentityRow, 'remote_id' | 'email'> | null | undefined,
): number {
  if (!identity) return -1;
  const remoteMatch = indexByRemoteId(identities, identity.remote_id);
  if (remoteMatch >= 0) return remoteMatch;
  return indexByEmail(identities, identity.email);
}

export function resolveComposeIdentityIndex(
  identities: IdentityRow[],
  { primaryIdentityRemoteId = null }: ResolveComposeIdentityOptions = {},
): number {
  if (identities.length === 0) return 0;

  const selectedPrimary = indexByRemoteId(identities, primaryIdentityRemoteId);
  if (selectedPrimary >= 0) return selectedPrimary;

  const nonDeletableMatch = identities.findIndex((identity) => identity.may_delete === 0);
  if (nonDeletableMatch >= 0) return nonDeletableMatch;

  return 0;
}

export function resolveReplyIdentityIndex(
  identities: IdentityRow[],
  originalTo: readonly (string | null | undefined)[],
  options: ResolveComposeIdentityOptions = {},
): number {
  const match = findReplyIdentityIndex(identities, originalTo);
  if (match >= 0) return match;
  return resolveComposeIdentityIndex(identities, options);
}

export function findReplyIdentityIndex(
  identities: IdentityRow[],
  originalTo: readonly (string | null | undefined)[],
): number {
  for (const email of originalTo) {
    const match = indexByEmail(identities, email);
    if (match >= 0) return match;
  }
  return -1;
}
