import { describe, expect, it } from 'vitest';

import type { FolderRow } from '../../../src/types';
import { folderCapabilities } from '../../../src/utils/folder-capabilities';

function folder(overrides: Partial<FolderRow> = {}): FolderRow {
  return {
    id: 1,
    account_id: 1,
    remote_id: 'mb-1',
    parent_id: null,
    name: 'Folder',
    role: null,
    sort_order: 0,
    total_emails: 0,
    unread_emails: 0,
    total_threads: 0,
    unread_threads: 0,
    may_read_items: null,
    may_add_items: null,
    may_remove_items: null,
    rights_json: null,
    raw_json: null,
    is_subscribed: 1,
    is_starred: 0,
    is_deleted: 0,
    updated_at: 0,
    ...overrides,
  };
}

describe('folderCapabilities', () => {
  it('keeps primary non-system folders manageable when rights are absent', () => {
    const capabilities = folderCapabilities(folder(), 1);
    expect(capabilities).toMatchObject({
      mayCreateChild: true,
      mayRename: true,
      mayDelete: true,
      mayReadItems: true,
      mayAddItems: true,
      mayRemoveItems: true,
      mayDeleteWithMail: true,
    });
  });

  it('protects primary role folders independently of permissive rights', () => {
    const capabilities = folderCapabilities(folder({
      role: 'inbox',
      rights_json: JSON.stringify({
        mayCreateChild: true,
        mayRename: true,
        mayDelete: true,
      }),
    }), 1);
    expect(capabilities.isSystemProtected).toBe(true);
    expect(capabilities.maySubscribe).toBe(false);
    expect(capabilities.mayStar).toBe(false);
    expect(capabilities.mayReparent).toBe(false);
  });

  it('fails closed for shared folders with missing or malformed rights', () => {
    for (const rights_json of [null, '{bad json', JSON.stringify({ mayDelete: 'yes' })]) {
      const capabilities = folderCapabilities(folder({
        account_id: 2,
        rights_json,
        may_read_items: 1,
        may_add_items: 1,
        may_remove_items: 1,
      }), 1);
      expect(capabilities.mayReadItems).toBe(false);
      expect(capabilities.mayAddItems).toBe(false);
      expect(capabilities.mayRemoveItems).toBe(false);
      expect(capabilities.mayRename).toBe(false);
      expect(capabilities.mayDelete).toBe(false);
    }
  });

  it('keeps item, hierarchy, and destructive rights independent', () => {
    const capabilities = folderCapabilities(folder({
      account_id: 2,
      rights_json: JSON.stringify({
        mayReadItems: true,
        mayAddItems: false,
        mayRemoveItems: false,
        mayCreateChild: true,
        mayRename: true,
        mayDelete: true,
      }),
    }), 1);
    expect(capabilities.mayCopyMessagesFrom).toBe(true);
    expect(capabilities.mayCopyMessagesTo).toBe(false);
    expect(capabilities.mayCreateChild).toBe(true);
    expect(capabilities.maySubscribe).toBe(true);
    expect(capabilities.mayDelete).toBe(true);
    expect(capabilities.mayDeleteWithMail).toBe(false);
  });

  it('allows stars without rights only for subscribed non-system folders', () => {
    expect(folderCapabilities(folder({
      account_id: 2,
      rights_json: null,
      is_subscribed: 1,
    }), 1).mayStar).toBe(true);
    expect(folderCapabilities(folder({
      account_id: 2,
      rights_json: null,
      is_subscribed: 0,
    }), 1).mayStar).toBe(false);
  });
});
