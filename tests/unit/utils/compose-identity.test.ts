import { describe, expect, it } from 'vitest';

import {
  findMatchingIdentityIndex,
  resolveComposeIdentityIndex,
  resolveReplyIdentityIndex,
} from '../../../src/utils/compose-identity';
import type { IdentityRow } from '../../../src/types';

function identity(overrides: Partial<IdentityRow>): IdentityRow {
  return {
    id: overrides.id ?? 1,
    account_id: overrides.account_id ?? 1,
    remote_id: overrides.remote_id ?? `id-${overrides.id ?? 1}`,
    name: overrides.name ?? '',
    email: overrides.email ?? 'user@example.com',
    reply_to_json: overrides.reply_to_json ?? null,
    bcc_json: overrides.bcc_json ?? null,
    text_signature: overrides.text_signature ?? null,
    html_signature: overrides.html_signature ?? null,
    may_delete: overrides.may_delete ?? null,
    reply_to: overrides.reply_to ?? null,
    bcc: overrides.bcc ?? null,
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

  it('prefers the client-selected Primary identity', () => {
    expect(resolveComposeIdentityIndex(identities, {
      primaryIdentityRemoteId: 'other',
    })).toBe(2);
  });

  it('uses a non-deletable JMAP identity when no Primary setting matches', () => {
    expect(resolveComposeIdentityIndex([
      identity({ id: 1, email: 'alias@example.com', may_delete: 1 }),
      identity({ id: 2, email: 'primary@example.com', may_delete: 0 }),
    ], {
      primaryIdentityRemoteId: 'removed',
    })).toBe(1);
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

  it('uses the first identity matching the original To field for replies', () => {
    expect(resolveReplyIdentityIndex(
      identities,
      ['missing@example.com', 'OTHER@example.com'],
      { primaryIdentityRemoteId: 'primary' },
    )).toBe(2);
  });

  it('falls back to Primary when no identity matches the original To field', () => {
    expect(resolveReplyIdentityIndex(
      identities,
      ['recipient@example.com'],
      { primaryIdentityRemoteId: 'primary' },
    )).toBe(1);
  });
});
