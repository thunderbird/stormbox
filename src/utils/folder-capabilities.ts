import type { FolderRow } from '../types';

export interface FolderRights {
  mayReadItems: boolean;
  mayAddItems: boolean;
  mayRemoveItems: boolean;
  mayCreateChild: boolean;
  mayRename: boolean;
  mayDelete: boolean;
}

export interface FolderCapabilities extends FolderRights {
  isPrimary: boolean;
  isSystemProtected: boolean;
  maySubscribe: boolean;
  mayStar: boolean;
  mayReparent: boolean;
  mayDeleteWithMail: boolean;
  mayMoveMessages: boolean;
  mayCopyMessagesFrom: boolean;
  mayCopyMessagesTo: boolean;
}

const RIGHT_NAMES: Array<keyof FolderRights> = [
  'mayReadItems',
  'mayAddItems',
  'mayRemoveItems',
  'mayCreateChild',
  'mayRename',
  'mayDelete',
];

function parseRights(folder: FolderRow): Partial<FolderRights> | null {
  if (typeof folder.rights_json !== 'string' || folder.rights_json.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(folder.rights_json);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const rights: Partial<FolderRights> = {};
    for (const name of RIGHT_NAMES) {
      if (!(name in parsed)) continue;
      if (typeof parsed[name] !== 'boolean') return null;
      rights[name] = parsed[name];
    }
    return rights;
  } catch {
    return null;
  }
}

function right(
  parsed: Partial<FolderRights> | null,
  name: keyof FolderRights,
  fallback: boolean,
  hotColumn?: 0 | 1 | null,
): boolean {
  if (typeof parsed?.[name] === 'boolean') return parsed[name]!;
  if (hotColumn != null) return Number(hotColumn) === 1;
  return fallback;
}

/**
 * Derive every folder and message permission from one fail-closed policy.
 *
 * Shared/non-primary folders require a complete, well-formed myRights
 * object. Primary folders preserve the pre-rights cache behavior when
 * rights are absent, while still respecting explicit false values and the
 * hot read/add/remove columns. Primary role folders are structurally
 * protected independently of rights.
 */
export function folderCapabilities(
  folder: FolderRow,
  primaryAccountId: number | null | undefined,
): FolderCapabilities {
  const isPrimary = Number(folder.account_id) === Number(primaryAccountId);
  const parsed = parseRights(folder);
  const fallback = isPrimary;
  const rights: FolderRights = {
    mayReadItems: right(
      parsed,
      'mayReadItems',
      fallback,
      isPrimary ? folder.may_read_items : null,
    ),
    mayAddItems: right(
      parsed,
      'mayAddItems',
      fallback,
      isPrimary ? folder.may_add_items : null,
    ),
    mayRemoveItems: right(
      parsed,
      'mayRemoveItems',
      fallback,
      isPrimary ? folder.may_remove_items : null,
    ),
    mayCreateChild: right(parsed, 'mayCreateChild', fallback),
    mayRename: right(parsed, 'mayRename', fallback),
    mayDelete: right(parsed, 'mayDelete', fallback),
  };
  const isSystemProtected = isPrimary && folder.role != null;
  const subscribed = isSystemProtected
    || (isPrimary
      ? Number(folder.is_subscribed ?? 1) !== 0
      : Number(folder.is_subscribed) === 1);

  return {
    ...rights,
    isPrimary,
    isSystemProtected,
    // Stalwart currently gates shared isSubscribed updates on Modify,
    // represented by mayRename. Keep this server-specific policy explicit.
    maySubscribe: !isSystemProtected && (isPrimary || rights.mayRename),
    mayStar: !isSystemProtected && subscribed,
    mayReparent: !isSystemProtected && rights.mayRename,
    mayDeleteWithMail: !isSystemProtected && rights.mayDelete && rights.mayRemoveItems,
    mayMoveMessages: rights.mayRemoveItems,
    mayCopyMessagesFrom: rights.mayReadItems,
    mayCopyMessagesTo: rights.mayAddItems,
  };
}
