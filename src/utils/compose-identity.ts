import type { IdentityRow } from '../types';

export interface RememberedComposeIdentity {
  remoteId?: string | null;
  email?: string | null;
}

export interface ResolveComposeIdentityOptions {
  remembered?: RememberedComposeIdentity | null;
  primaryEmail?: string | null;
}

function normalizeEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

function rawJsonMayDelete(rawJson: string | null): boolean | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson);
    return typeof parsed?.mayDelete === 'boolean' ? parsed.mayDelete : null;
  } catch {
    return null;
  }
}

function indexByRemoteId(identities: IdentityRow[], remoteId: string | null | undefined): number {
  if (!remoteId) return -1;
  return identities.findIndex((identity) => identity.remote_id === remoteId);
}

function indexByEmail(identities: IdentityRow[], email: string | null | undefined): number {
  const normalized = normalizeEmail(email);
  if (!normalized) return -1;
  return identities.findIndex((identity) => normalizeEmail(identity.email) === normalized);
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
  { remembered = null, primaryEmail = null }: ResolveComposeIdentityOptions = {},
): number {
  if (identities.length === 0) return 0;

  const rememberedRemoteMatch = indexByRemoteId(identities, remembered?.remoteId);
  if (rememberedRemoteMatch >= 0) return rememberedRemoteMatch;

  const rememberedEmailMatch = indexByEmail(identities, remembered?.email);
  if (rememberedEmailMatch >= 0) return rememberedEmailMatch;

  const primaryEmailMatch = indexByEmail(identities, primaryEmail);
  if (primaryEmailMatch >= 0) return primaryEmailMatch;

  const nonDeletableMatch = identities.findIndex((identity) => rawJsonMayDelete(identity.raw_json) === false);
  if (nonDeletableMatch >= 0) return nonDeletableMatch;

  const thundermailMatch = identities.findIndex((identity) =>
    normalizeEmail(identity.email).endsWith('@thundermail.com'),
  );
  if (thundermailMatch >= 0) return thundermailMatch;

  return 0;
}
