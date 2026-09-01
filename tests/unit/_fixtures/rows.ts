/**
 * Typed row builders shared by store, component, sync, and utility
 * suites. Every column is present so the result satisfies the row type
 * without casts; explicit `undefined` overrides fall back to the default.
 */

import type {
  BodyAttachmentRow,
  ContactMutationFields,
  IdentityRow,
} from '../../../src/types';

function defined<T extends object>(overrides: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

export function identityRow(overrides: Partial<IdentityRow> = {}): IdentityRow {
  const id = overrides.id ?? 1;
  return {
    id,
    account_id: 1,
    remote_id: `identity-${id}`,
    name: '',
    email: 'user@example.com',
    reply_to_json: null,
    bcc_json: null,
    text_signature: null,
    html_signature: null,
    may_delete: null,
    raw_json: null,
    updated_at: 0,
    reply_to: null,
    bcc: null,
    ...defined(overrides),
  };
}

export function contactMutationFields(
  overrides: Partial<ContactMutationFields> = {},
): ContactMutationFields {
  return {
    fullName: null,
    emails: [],
    phones: [],
    links: [],
    anniversaries: [],
    notes: [],
    organizations: [],
    titles: [],
    ...defined(overrides),
  };
}

export function attachmentPart(
  overrides: Partial<BodyAttachmentRow> = {},
): BodyAttachmentRow {
  return {
    part_id: 'part-1',
    blob_id: 'blob-1',
    name: 'file.bin',
    mime_type: 'application/octet-stream',
    size: 12,
    disposition: 'attachment',
    cid: null,
    charset: null,
    ...defined(overrides),
  };
}
