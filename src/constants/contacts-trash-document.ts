import { CONTACTS_TRASH_LIMITS } from '../config/contacts-trash-limits';

export const CONTACTS_TRASH_DOCUMENT_OWNER = 'stormbox';
export const CONTACTS_TRASH_DOCUMENT_TYPE = 'contacts-trash';
export const CONTACTS_TRASH_DOCUMENT_VERSION = 1;
export const CONTACTS_TRASH_LEGACY_FILE_NAME = 'stormbox-contacts-trash.json';
export const CONTACTS_TRASH_SHARD_FILE_PREFIX = 'stormbox-contacts-trash-';
export const CONTACTS_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const CONTACTS_TRASH_TOMBSTONE_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
export const CONTACTS_TRASH_MAX_MEDIA_ITEMS = CONTACTS_TRASH_LIMITS.maxMediaItems;
export const CONTACTS_TRASH_MAX_MEDIA_BYTES = CONTACTS_TRASH_LIMITS.maxMediaItemBytes;
export const CONTACTS_TRASH_MAX_TOTAL_MEDIA_BYTES = CONTACTS_TRASH_LIMITS.maxTotalMediaBytes;
export const CONTACTS_TRASH_MAX_DOCUMENT_BYTES = CONTACTS_TRASH_LIMITS.snapshotShardMaxBytes;
export const CONTACTS_TRASH_MAX_TOMBSTONE_SHARD_BYTES =
  CONTACTS_TRASH_LIMITS.tombstoneShardMaxBytes;
export const CONTACTS_TRASH_MAX_SHARD_ENTRIES = CONTACTS_TRASH_LIMITS.shardMaxRecords;
export const CONTACTS_TRASH_SHARD_DOCUMENT_VERSION = 2;

export type ContactTrashStatus = 'purged' | 'restored' | 'trashed';

export interface ContactTrashMedia {
  blobId: string;
  mediaType: string;
  base64: string;
}

export interface ContactTrashDocumentEntry {
  uid: string;
  remoteId: string;
  addressBookIds: string[];
  trashedAt: number;
  expiresAt: number;
  status: ContactTrashStatus;
  updatedAt: number;
  emailKeys: string[];
  displayName: string;
  primaryEmail: string | null;
  snapshot: Record<string, unknown> | null;
  media: ContactTrashMedia[];
}

export interface ContactsTrashDocument {
  owner: typeof CONTACTS_TRASH_DOCUMENT_OWNER;
  documentType: typeof CONTACTS_TRASH_DOCUMENT_TYPE;
  version: typeof CONTACTS_TRASH_DOCUMENT_VERSION;
  entries: Record<string, ContactTrashDocumentEntry>;
}

export interface ContactsTrashShardDocument {
  owner: typeof CONTACTS_TRASH_DOCUMENT_OWNER;
  documentType: typeof CONTACTS_TRASH_DOCUMENT_TYPE;
  version: typeof CONTACTS_TRASH_SHARD_DOCUMENT_VERSION;
  entries: Record<string, ContactTrashDocumentEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  ))];
}

function statusValue(value: unknown): ContactTrashStatus | null {
  switch (value) {
    case 'purged':
    case 'restored':
    case 'trashed':
      return value;
    default:
      return null;
  }
}

function decodedBase64Size(value: string): number {
  const padding = value.endsWith('==') ? 2 : (value.endsWith('=') ? 1 : 0);
  return Math.floor((value.length * 3) / 4) - padding;
}

function normalizeMedia(value: unknown): ContactTrashMedia[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > CONTACTS_TRASH_MAX_MEDIA_ITEMS) return null;
  const media: ContactTrashMedia[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const item of value) {
    if (!isRecord(item)) return null;
    const blobId = typeof item.blobId === 'string' ? item.blobId.trim() : '';
    const mediaType = typeof item.mediaType === 'string' ? item.mediaType.trim() : '';
    const base64 = typeof item.base64 === 'string'
      ? item.base64.replace(/\s+/g, '')
      : '';
    const bytes = decodedBase64Size(base64);
    if (
      !blobId
      || !mediaType
      || !base64
      || base64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
      || bytes <= 0
      || bytes > CONTACTS_TRASH_MAX_MEDIA_BYTES
    ) {
      return null;
    }
    totalBytes += bytes;
    if (totalBytes > CONTACTS_TRASH_MAX_TOTAL_MEDIA_BYTES) return null;
    const key = `${blobId}\u0000${mediaType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    media.push({ blobId, mediaType, base64 });
  }
  return media;
}

export function emptyContactsTrashDocument(): ContactsTrashDocument {
  return {
    owner: CONTACTS_TRASH_DOCUMENT_OWNER,
    documentType: CONTACTS_TRASH_DOCUMENT_TYPE,
    version: CONTACTS_TRASH_DOCUMENT_VERSION,
    entries: {},
  };
}

export function emptyContactsTrashShardDocument(): ContactsTrashShardDocument {
  return {
    owner: CONTACTS_TRASH_DOCUMENT_OWNER,
    documentType: CONTACTS_TRASH_DOCUMENT_TYPE,
    version: CONTACTS_TRASH_SHARD_DOCUMENT_VERSION,
    entries: {},
  };
}

export function normalizeContactTrashEntry(
  value: unknown,
): ContactTrashDocumentEntry | null {
  if (!isRecord(value)) return null;
  const status = statusValue(value.status);
  const uid = typeof value.uid === 'string' ? value.uid : '';
  const remoteId = typeof value.remoteId === 'string' ? value.remoteId : '';
  const trashedAt = Number(value.trashedAt);
  const expiresAt = Number(value.expiresAt);
  const updatedAt = Number(value.updatedAt);
  if (
    !status
    || !uid
    || !remoteId
    || !Number.isFinite(trashedAt)
    || !Number.isFinite(expiresAt)
    || !Number.isFinite(updatedAt)
  ) {
    return null;
  }
  const snapshot = isRecord(value.snapshot)
    ? structuredClone(value.snapshot)
    : null;
  if (status === 'trashed' && !snapshot) return null;
  const media = normalizeMedia(value.media);
  if (!media) return null;
  return {
    uid,
    remoteId,
    addressBookIds: stringArray(value.addressBookIds),
    trashedAt: Math.floor(trashedAt),
    expiresAt: Math.floor(expiresAt),
    status,
    updatedAt: Math.floor(updatedAt),
    emailKeys: stringArray(value.emailKeys),
    displayName: typeof value.displayName === 'string' && value.displayName.trim()
      ? value.displayName.trim()
      : '(no name)',
    primaryEmail: typeof value.primaryEmail === 'string' && value.primaryEmail.trim()
      ? value.primaryEmail.trim()
      : null,
    snapshot: status === 'trashed' ? snapshot : null,
    media: status === 'trashed' ? media : [],
  };
}

export function normalizeContactsTrashDocument(input: unknown): ContactsTrashDocument {
  const document = emptyContactsTrashDocument();
  if (!isRecord(input) || !isRecord(input.entries)) return document;
  for (const [key, value] of Object.entries(input.entries)) {
    const entry = normalizeContactTrashEntry(value);
    if (entry && key === entry.uid) document.entries[key] = entry;
  }
  return document;
}

const DOCUMENT_KEYS = new Set(['owner', 'documentType', 'version', 'entries']);
const ENTRY_KEYS = new Set([
  'uid',
  'remoteId',
  'addressBookIds',
  'trashedAt',
  'expiresAt',
  'status',
  'updatedAt',
  'emailKeys',
  'displayName',
  'primaryEmail',
  'snapshot',
  'media',
]);
const MEDIA_KEYS = new Set(['blobId', 'mediaType', 'base64']);

function hasOnlyKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function matchesStringArray(value: unknown, normalized: string[]): boolean {
  return Array.isArray(value)
    && value.length === normalized.length
    && value.every((item, index) => item === normalized[index]);
}

function isStrictContactTrashEntry(
  value: unknown,
  normalized: ContactTrashDocumentEntry,
): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ENTRY_KEYS)) return false;
  if (
    value.uid !== normalized.uid
    || value.remoteId !== normalized.remoteId
    || value.trashedAt !== normalized.trashedAt
    || value.expiresAt !== normalized.expiresAt
    || value.status !== normalized.status
    || value.updatedAt !== normalized.updatedAt
    || value.displayName !== normalized.displayName
    || value.primaryEmail !== normalized.primaryEmail
    || !matchesStringArray(value.addressBookIds, normalized.addressBookIds)
    || !matchesStringArray(value.emailKeys, normalized.emailKeys)
  ) {
    return false;
  }
  if (normalized.status === 'trashed') {
    if (!isRecord(value.snapshot)) return false;
  } else if (value.snapshot !== null) {
    return false;
  }
  if (!Array.isArray(value.media) || value.media.length !== normalized.media.length) {
    return false;
  }
  if (normalized.status !== 'trashed' && value.media.length !== 0) return false;
  return value.media.every((item, index) => {
    if (!isRecord(item) || !hasOnlyKeys(item, MEDIA_KEYS)) return false;
    const expected = normalized.media[index];
    return item.blobId === expected.blobId
      && item.mediaType === expected.mediaType
      && item.base64 === expected.base64;
  });
}

export function validateContactsTrashDocument(
  input: unknown,
): ContactsTrashDocument | null {
  if (
    !isRecord(input)
    || !hasOnlyKeys(input, DOCUMENT_KEYS)
    || input.owner !== CONTACTS_TRASH_DOCUMENT_OWNER
    || input.documentType !== CONTACTS_TRASH_DOCUMENT_TYPE
    || input.version !== CONTACTS_TRASH_DOCUMENT_VERSION
    || !isRecord(input.entries)
  ) {
    return null;
  }
  const document = emptyContactsTrashDocument();
  for (const [key, value] of Object.entries(input.entries)) {
    const entry = normalizeContactTrashEntry(value);
    if (!entry || key !== entry.uid || !isStrictContactTrashEntry(value, entry)) {
      return null;
    }
    document.entries[key] = entry;
  }
  return document;
}

export function normalizeContactsTrashShardDocument(
  input: unknown,
): ContactsTrashShardDocument {
  const document = emptyContactsTrashShardDocument();
  if (!isRecord(input) || !isRecord(input.entries)) return document;
  for (const [key, value] of Object.entries(input.entries)) {
    const entry = normalizeContactTrashEntry(value);
    if (entry && key) document.entries[key] = entry;
  }
  return document;
}

export function validateContactsTrashShardDocument(
  input: unknown,
): ContactsTrashShardDocument | null {
  if (
    !isRecord(input)
    || !hasOnlyKeys(input, DOCUMENT_KEYS)
    || input.owner !== CONTACTS_TRASH_DOCUMENT_OWNER
    || input.documentType !== CONTACTS_TRASH_DOCUMENT_TYPE
    || input.version !== CONTACTS_TRASH_SHARD_DOCUMENT_VERSION
    || !isRecord(input.entries)
    || Object.keys(input.entries).length > CONTACTS_TRASH_MAX_SHARD_ENTRIES
  ) {
    return null;
  }
  const document = emptyContactsTrashShardDocument();
  for (const [key, value] of Object.entries(input.entries)) {
    const entry = normalizeContactTrashEntry(value);
    if (!key || !entry || !isStrictContactTrashEntry(value, entry)) return null;
    document.entries[key] = entry;
  }
  return document;
}

function statusRank(status: ContactTrashStatus): number {
  switch (status) {
    case 'trashed':
      return 0;
    case 'restored':
      return 1;
    case 'purged':
      return 2;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export function contactTrashEntryWins(
  local: ContactTrashDocumentEntry,
  remote: ContactTrashDocumentEntry,
): boolean {
  if (local.updatedAt !== remote.updatedAt) return local.updatedAt > remote.updatedAt;
  if (local.status !== remote.status) return statusRank(local.status) > statusRank(remote.status);
  return JSON.stringify(local) > JSON.stringify(remote);
}

export function mergeContactsTrashDocuments(
  localInput: unknown,
  remoteInput: unknown,
  _now = Date.now(),
): { document: ContactsTrashDocument; localNewer: boolean } {
  const local = normalizeContactsTrashDocument(localInput);
  const remote = normalizeContactsTrashDocument(remoteInput);
  const document = emptyContactsTrashDocument();
  let localNewer = false;
  const keys = new Set([...Object.keys(local.entries), ...Object.keys(remote.entries)]);
  for (const key of keys) {
    const localEntry = local.entries[key];
    const remoteEntry = remote.entries[key];
    let selected: ContactTrashDocumentEntry;
    if (!remoteEntry || (localEntry && contactTrashEntryWins(localEntry, remoteEntry))) {
      selected = localEntry;
      localNewer = true;
    } else {
      selected = remoteEntry;
    }
    document.entries[key] = selected;
  }
  return { document, localNewer };
}

export function aggregateContactsTrashDocuments(
  documents: Array<ContactsTrashDocument | ContactsTrashShardDocument>,
): ContactsTrashDocument {
  const aggregate = emptyContactsTrashDocument();
  for (const document of documents) {
    for (const entry of Object.values(document.entries)) {
      const current = aggregate.entries[entry.uid];
      if (!current || contactTrashEntryWins(entry, current)) {
        aggregate.entries[entry.uid] = structuredClone(entry);
      }
    }
  }
  return aggregate;
}

export function mergeContactsTrashShardDocuments(
  localInput: unknown,
  remoteInput: unknown,
): { document: ContactsTrashShardDocument; localNewer: boolean } {
  const local = normalizeContactsTrashShardDocument(localInput);
  const remote = normalizeContactsTrashShardDocument(remoteInput);
  const document = emptyContactsTrashShardDocument();
  let localNewer = false;
  const keys = new Set([...Object.keys(local.entries), ...Object.keys(remote.entries)]);
  for (const key of keys) {
    const localEntry = local.entries[key];
    const remoteEntry = remote.entries[key];
    if (!remoteEntry || (localEntry && contactTrashEntryWins(localEntry, remoteEntry))) {
      document.entries[key] = localEntry;
      localNewer = true;
    } else {
      document.entries[key] = remoteEntry;
    }
  }
  return { document, localNewer };
}

export function serializedContactsTrashShardBytes(
  document: ContactsTrashShardDocument,
): number {
  return new TextEncoder().encode(JSON.stringify(document)).byteLength;
}

export function contactTrashEntryFitsInShard(
  entry: ContactTrashDocumentEntry,
  maxBytes = CONTACTS_TRASH_MAX_DOCUMENT_BYTES,
): boolean {
  const document = emptyContactsTrashShardDocument();
  document.entries['00000000-0000-4000-8000-000000000000'] = entry;
  try {
    return serializedContactsTrashShardBytes(document) <= maxBytes;
  } catch {
    return false;
  }
}
