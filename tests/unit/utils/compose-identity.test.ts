import { describe, expect, it } from 'vitest';

import {
  findMatchingIdentityIndex,
  resolveComposeIdentityIndex,
} from '../../../src/utils/compose-identity';
import type { IdentityRow } from '../../../src/types';

function identity(overrides: Partial<IdentityRow>): IdentityRow {
  return {
    id: overrides.id ?? 1,
    account_id: overrides.account_id ?? 1,
    remote_id: overrides.remote_id ?? `id-${overrides.id ?? 1}`,
    name: overrides.name ?? null,
    email: overrides.email ?? 'user@example.com',
    reply_to_json: overrides.reply_to_json ?? null,
    raw_json: overrides.raw_json ?? null,
    updated_at: overrides.updated_at ?? 0,
  };
}

describe('compose identity resolution', () => {
  const identities = [
    identity({ id: 1, remote_id: 'alias', email: 'alias@example.com' }),
    identity({ id: 2, remote_id: 'primary', email: 'user@thundermail.com' }),
    identity({ id: 3, remote_id: 'other', email: 'other@example.com' }),
  ];

  it('prefers a remembered remote id over primary email', () => {
    expect(resolveComposeIdentityIndex(identities, {
      remembered: { remoteId: 'other', email: 'missing@example.com' },
      primaryEmail: 'user@thundermail.com',
    })).toBe(2);
  });

  it('falls back from remembered email to the account primary email', () => {
    expect(resolveComposeIdentityIndex(identities, {
      remembered: { email: 'missing@example.com' },
      primaryEmail: 'USER@THUNDERMAIL.COM',
    })).toBe(1);
  });

  it('uses a non-deletable JMAP identity when no email match exists', () => {
    expect(resolveComposeIdentityIndex([
      identity({ id: 1, email: 'alias@example.com', raw_json: JSON.stringify({ mayDelete: true }) }),
      identity({ id: 2, email: 'primary@example.com', raw_json: JSON.stringify({ mayDelete: false }) }),
    ])).toBe(1);
  });

  it('uses a thundermail address before falling back to the first identity', () => {
    expect(resolveComposeIdentityIndex([
      identity({ id: 1, email: 'alias@example.com' }),
      identity({ id: 2, email: 'person@thundermail.com' }),
    ])).toBe(1);
  });

  it('falls back to the first identity when no preferred identity exists', () => {
    expect(resolveComposeIdentityIndex([
      identity({ id: 1, email: 'alias@example.com' }),
      identity({ id: 2, email: 'other@example.com' }),
    ])).toBe(0);
  });

  it('matches existing selections by remote id before email', () => {
    expect(findMatchingIdentityIndex(identities, {
      remote_id: 'primary',
      email: 'old@example.com',
    })).toBe(1);
  });
});
