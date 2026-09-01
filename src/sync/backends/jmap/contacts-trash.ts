import {
  CONTACTS_TRASH_LEGACY_FILE_NAME,
  CONTACTS_TRASH_DOCUMENT_OWNER,
  CONTACTS_TRASH_DOCUMENT_TYPE,
  CONTACTS_TRASH_DOCUMENT_VERSION,
  CONTACTS_TRASH_MAX_DOCUMENT_BYTES,
  CONTACTS_TRASH_MAX_SHARD_ENTRIES,
  CONTACTS_TRASH_MAX_MEDIA_BYTES,
  CONTACTS_TRASH_MAX_MEDIA_ITEMS,
  CONTACTS_TRASH_MAX_TOTAL_MEDIA_BYTES,
  CONTACTS_TRASH_RETENTION_MS,
  CONTACTS_TRASH_SHARD_DOCUMENT_VERSION,
  CONTACTS_TRASH_SHARD_FILE_PREFIX,
  contactTrashEntryFitsInShard,
  mergeContactsTrashShardDocuments,
  serializedContactsTrashShardBytes,
  validateContactsTrashDocument,
  validateContactsTrashShardDocument,
  type ContactsTrashDocument,
  type ContactsTrashShardDocument,
  type ContactTrashDocumentEntry,
  type ContactTrashMedia,
} from '../../../constants/contacts-trash-document';
import { DB_RPC } from '../../../db/protocol';
import type {
  ContactTrashDetail,
  ContactTrashLookup,
  ContactTrashMutationResult,
} from '../../../types/db';
import { addressKey } from '../../../utils/address-key';
import { createContactUidFromSeed } from '../../../utils/contact-uid';
import { base64ToBytes, bytesToBase64 } from '../../../utils/inline-images';
import {
  discoverJsonFileNodes,
  ensureContactsTrashFileNodeFolder,
  findContactsTrashFileNodeFolder,
  hasFileNodeCapability,
  isFileNodeWriteConflictError,
  isRetryableFileNodeDocumentError,
  moveFileNodes,
  readJsonFileNode,
  readJsonFileNodeFromNode,
  retryFileNodeWrite,
  writeJsonFileNode,
  type FileNodeCollectionRead,
  type FileNodeDocumentError,
  type FileNodeDocumentRead,
} from './file-node';
import { callJmap, pickResponse, pickResponseById } from './invoke';
import { maxObjectsInGet, maxObjectsInSet, maxSizeUpload } from './limits';
import {
  classifyAuthenticationOrAuthorizationError,
  JMAP_CAPS,
} from './transport';

export const CONTACTS_TRASH_FILE_NAME = CONTACTS_TRASH_LEGACY_FILE_NAME;

const CONTACTS_TRASH_LEGACY_MARKER = {
  owner: CONTACTS_TRASH_DOCUMENT_OWNER,
  documentType: CONTACTS_TRASH_DOCUMENT_TYPE,
  version: CONTACTS_TRASH_DOCUMENT_VERSION,
};
const CONTACTS_TRASH_SHARD_MARKER = {
  owner: CONTACTS_TRASH_DOCUMENT_OWNER,
  documentType: CONTACTS_TRASH_DOCUMENT_TYPE,
  version: CONTACTS_TRASH_SHARD_DOCUMENT_VERSION,
};
const CONTACTS_TRASH_SHARD_FILE_PATTERN = new RegExp(
  `^${CONTACTS_TRASH_SHARD_FILE_PREFIX}[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}`
    + '-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.json$',
  'i',
);
const RETRYABLE_CONTACT_WRITE_ERRORS = new Set([
  'noResponse',
  'rateLimit',
  'serverFail',
  'serverPartialFail',
  'serverUnavailable',
  'stateMismatch',
  'transport',
]);

function isRetryableContactWriteError(errorType: string, detail?: any): boolean {
  const authentication = classifyAuthenticationOrAuthorizationError(
    detail ?? { type: errorType },
  );
  if (authentication) return authentication.retryable;
  return RETRYABLE_CONTACT_WRITE_ERRORS.has(errorType);
}

export function contactsTrashSnapshotWriteMaxBytes(transport: any): number {
  return Math.min(CONTACTS_TRASH_MAX_DOCUMENT_BYTES, maxSizeUpload(transport));
}

export type ContactsTrashSyncResult =
  | {
      ok: true;
      skipped?: boolean;
      pulled?: boolean;
      repairQueued?: boolean;
      document?: ContactsTrashDocument;
    }
  | { ok: false; error: FileNodeDocumentError };

type SuccessfulFileNodeCollectionRead = Extract<
  FileNodeCollectionRead,
  { ok: true }
>;

function invalidRemoteDocument(): ContactsTrashSyncResult {
  return {
    ok: false,
    error: {
      type: 'invalidDocument',
      message: 'Contacts trash document contains a malformed entry',
      terminal: true,
    },
  };
}

function isContactsTrashFileName(name: string): boolean {
  return name === CONTACTS_TRASH_LEGACY_FILE_NAME
    || CONTACTS_TRASH_SHARD_FILE_PATTERN.test(name);
}

async function mergeDuplicateTrashShard({
  transport,
  account,
  fileName,
  parentId,
  useWebSocket,
}: {
  transport: any;
  account: any;
  fileName: string;
  parentId: string;
  useWebSocket: boolean;
}): Promise<
  | { ok: true }
  | { ok: false; error: FileNodeDocumentError }
> {
  return retryFileNodeWrite(async () => {
    const current = await readJsonFileNode<ContactsTrashShardDocument>({
      transport,
      account,
      fileName,
      marker: CONTACTS_TRASH_SHARD_MARKER,
      maxBytes: CONTACTS_TRASH_MAX_DOCUMENT_BYTES,
      parentId,
      useWebSocket,
    });
    if (current.ok === false) return current;
    const root = await readJsonFileNode<ContactsTrashShardDocument>({
      transport,
      account,
      fileName,
      marker: CONTACTS_TRASH_SHARD_MARKER,
      maxBytes: CONTACTS_TRASH_MAX_DOCUMENT_BYTES,
      useWebSocket,
    });
    if (root.ok === false) return root;
    if (current.state !== root.state) {
      return { ok: false, error: { type: 'stateMismatch' as const } };
    }
    if (root.status === 'missing') return { ok: true };
    if (current.status === 'missing') {
      return { ok: false, error: { type: 'stateMismatch' as const } };
    }
    const currentDocument = validateContactsTrashShardDocument(current.document);
    const rootDocument = validateContactsTrashShardDocument(root.document);
    if (!currentDocument || !rootDocument) {
      return {
        ok: false,
        error: {
          type: 'invalidDocument',
          message: 'Contacts trash document contains a malformed entry',
          terminal: true,
        },
      };
    }
    const document = mergeContactsTrashShardDocuments(
      currentDocument,
      rootDocument,
    ).document;
    if (
      Object.keys(document.entries).length > CONTACTS_TRASH_MAX_SHARD_ENTRIES
      || serializedContactsTrashShardBytes(document)
        > contactsTrashSnapshotWriteMaxBytes(transport)
    ) {
      return {
        ok: false,
        error: {
          type: 'tooLarge',
          message: `Duplicate contacts trash shard ${fileName} cannot be merged safely`,
          terminal: true,
        },
      };
    }
    const write = await writeJsonFileNode({
      transport,
      account,
      fileName,
      marker: CONTACTS_TRASH_SHARD_MARKER,
      document,
      snapshot: current,
      parentId,
      destroyNodeIds: [root.node.id],
      useWebSocket,
    });
    return write.ok === true ? { ok: true } : write;
  });
}

async function prepareContactsTrashFolder({
  transport,
  account,
  useWebSocket,
}: {
  transport: any;
  account: any;
  useWebSocket: boolean;
}): Promise<
  | { ok: true; parentId: string }
  | { ok: false; error: FileNodeDocumentError }
> {
  // Only the relocation itself rides out transient server failures; the
  // folder, discovery, and merge steps before it are re-run solely on the
  // snapshot conflict set.
  const relocationFailures = new WeakSet<FileNodeDocumentError>();
  return retryFileNodeWrite(async () => {
    const folder = await ensureContactsTrashFileNodeFolder({
      transport,
      account,
      useWebSocket,
    });
    if (folder.ok === false) return folder;
    const legacy = await discoverJsonFileNodes({
      transport,
      account,
      nameMatch: 'stormbox-contacts-trash*.json',
      acceptName: isContactsTrashFileName,
      useWebSocket,
    });
    if (legacy.ok === false) return legacy;
    if (legacy.state !== folder.state) {
      return { ok: false, error: { type: 'stateMismatch' as const } };
    }
    if (legacy.nodes.length === 0) {
      return { ok: true, parentId: folder.node.id };
    }
    const current = await discoverJsonFileNodes({
      transport,
      account,
      nameMatch: 'stormbox-contacts-trash*.json',
      acceptName: isContactsTrashFileName,
      parentId: folder.node.id,
      useWebSocket,
    });
    if (current.ok === false) return current;
    if (current.state !== legacy.state) {
      return { ok: false, error: { type: 'stateMismatch' as const } };
    }
    const currentNames = new Set(current.nodes.map((node) => node.name));
    const collisions: string[] = [];
    for (const node of legacy.nodes) {
      const isLegacyDocument = node.name === CONTACTS_TRASH_LEGACY_FILE_NAME;
      const remote = await readJsonFileNodeFromNode<
        ContactsTrashDocument | ContactsTrashShardDocument
      >({
        transport,
        account,
        node,
        state: legacy.state,
        marker: isLegacyDocument
          ? CONTACTS_TRASH_LEGACY_MARKER
          : CONTACTS_TRASH_SHARD_MARKER,
        maxBytes: CONTACTS_TRASH_MAX_DOCUMENT_BYTES,
      });
      if (remote.ok === false) return remote;
      if (remote.status !== 'found') {
        return {
          ok: false,
          error: {
            type: 'invalidDocument',
            message: 'Contacts trash FileNode disappeared during relocation',
            terminal: true,
          },
        };
      }
      const valid = isLegacyDocument
        ? validateContactsTrashDocument(remote.document)
        : validateContactsTrashShardDocument(remote.document);
      if (!valid) {
        return {
          ok: false,
          error: {
            type: 'invalidDocument',
            message: 'Contacts trash document contains a malformed entry',
            terminal: true,
          },
        };
      }
      if (currentNames.has(node.name)) {
        collisions.push(node.name);
      }
    }
    for (const fileName of collisions) {
      if (fileName === CONTACTS_TRASH_LEGACY_FILE_NAME) {
        return {
          ok: false,
          error: {
            type: 'alreadyExists',
            message: 'The legacy contacts trash document exists in both locations',
            terminal: true,
          },
        };
      }
      const merged = await mergeDuplicateTrashShard({
        transport,
        account,
        fileName,
        parentId: folder.node.id,
        useWebSocket,
      });
      if (merged.ok === false) return merged;
    }
    if (collisions.length > 0) {
      return { ok: false, error: { type: 'stateMismatch' as const } };
    }
    const moved = await moveFileNodes({
      transport,
      account,
      nodes: legacy.nodes,
      state: legacy.state,
      parentId: folder.node.id,
      useWebSocket,
    });
    if (moved.ok === true) return { ok: true, parentId: folder.node.id };
    relocationFailures.add(moved.error);
    return moved;
  }, (error) => (relocationFailures.has(error)
    ? isRetryableFileNodeDocumentError(error)
    : isFileNodeWriteConflictError(error)));
}

export async function syncContactsTrashFromServer({
  transport,
  account,
  handlers,
  useWebSocket = false,
}: {
  transport: any;
  account: any;
  handlers: Record<string, (params: any) => Promise<any>>;
  useWebSocket?: boolean;
}): Promise<ContactsTrashSyncResult> {
  if (!hasFileNodeCapability(transport, account)) {
    return { ok: true, skipped: true };
  }
  const locations = await retryFileNodeWrite(async () => {
    const folder = await findContactsTrashFileNodeFolder({
      transport,
      account,
      useWebSocket,
    });
    if (folder.ok === false) return folder;
    const rootCollection = await discoverJsonFileNodes({
      transport,
      account,
      nameMatch: 'stormbox-contacts-trash*.json',
      acceptName: isContactsTrashFileName,
      useWebSocket,
    });
    if (rootCollection.ok === false) return rootCollection;
    if (folder.state !== rootCollection.state) {
      return { ok: false, error: { type: 'stateMismatch' as const } };
    }
    const collections: Array<{
      parentId: string | null;
      collection: SuccessfulFileNodeCollectionRead;
    }> = [{
      parentId: null,
      collection: rootCollection,
    }];
    if (folder.status === 'found') {
      const currentCollection = await discoverJsonFileNodes({
        transport,
        account,
        nameMatch: 'stormbox-contacts-trash*.json',
        acceptName: isContactsTrashFileName,
        parentId: folder.node.id,
        useWebSocket,
      });
      if (currentCollection.ok === false) return currentCollection;
      if (currentCollection.state !== rootCollection.state) {
        return { ok: false, error: { type: 'stateMismatch' as const } };
      }
      collections.push({
        parentId: folder.node.id,
        collection: currentCollection,
      });
    }
    return { ok: true, rootCollection, collections };
  });
  if (locations.ok === false) return locations;
  const { collections, rootCollection } = locations;
  const localShards = await handlers[DB_RPC.CONTACT_TRASH_GET_SHARDS]({
    accountId: account.id,
    metadataOnly: true,
  });
  const localByName = new Map(
    localShards.map((shard: any) => [shard.shardName, shard]),
  );
  let pulled = 0;
  for (const { parentId, collection } of collections) {
    for (const node of collection.nodes) {
      const local = localByName.get(node.name) as any;
      if (
        local
        && !local.dirty
        && local.remoteNodeId === node.id
        && local.remoteBlobId === node.blobId
      ) {
        continue;
      }
      const legacy = node.name === CONTACTS_TRASH_LEGACY_FILE_NAME;
      const remote = await readJsonFileNodeFromNode<
        ContactsTrashDocument | ContactsTrashShardDocument
      >({
        transport,
        account,
        node,
        state: collection.state,
        marker: legacy ? CONTACTS_TRASH_LEGACY_MARKER : CONTACTS_TRASH_SHARD_MARKER,
        maxBytes: CONTACTS_TRASH_MAX_DOCUMENT_BYTES,
        parentId,
      });
      if (remote.ok === false) return remote;
      if (remote.status !== 'found') return invalidRemoteDocument();
      const document = legacy
        ? validateContactsTrashDocument(remote.document)
        : validateContactsTrashShardDocument(remote.document);
      if (!document) return invalidRemoteDocument();
      await handlers[DB_RPC.CONTACT_TRASH_MERGE_REMOTE_SHARDS]({
        accountId: account.id,
        shards: [{
          shardName: node.name,
          doc: document,
          remoteNodeId: node.id,
          remoteBlobId: node.blobId,
          legacy,
        }],
        ensurePush: false,
        finalize: false,
      });
      localByName.delete(node.name);
      pulled += 1;
    }
  }
  const merged = await handlers[DB_RPC.CONTACT_TRASH_MERGE_REMOTE_SHARDS]({
    accountId: account.id,
    shards: [],
    ensurePush: true,
    finalize: true,
  });
  const relocation = rootCollection.nodes.length > 0
    ? await handlers[DB_RPC.CONTACT_TRASH_ENSURE_PUSH]({
      accountId: account.id,
      force: true,
    })
    : null;
  return {
    ok: true,
    pulled: pulled > 0,
    repairQueued: merged?.mutation != null || relocation?.mutation != null,
    document: merged.doc,
  };
}

export async function pushContactsTrash({
  transport,
  account,
  handlers,
  shardNames = null,
  useWebSocket = false,
}: {
  transport: any;
  account: any;
  handlers: Record<string, (params: any) => Promise<any>>;
  shardNames?: string[] | null;
  useWebSocket?: boolean;
}): Promise<ContactsTrashSyncResult> {
  if (!hasFileNodeCapability(transport, account)) {
    return {
      ok: false,
      error: {
        type: 'unsupported',
        message: 'Contact deletion requires FileNode-backed trash',
        terminal: true,
      },
    };
  }
  const folder = await prepareContactsTrashFolder({
    transport,
    account,
    useWebSocket,
  });
  if (folder.ok === false) return folder;
  const pending = await handlers[DB_RPC.CONTACT_TRASH_GET_SHARDS]({
    accountId: account.id,
    shardNames,
    dirtyOnly: true,
  });
  const snapshotWriteMaxBytes = contactsTrashSnapshotWriteMaxBytes(transport);
  for (const initial of pending) {
    const result = await retryFileNodeWrite(async () => {
      const remote = await readJsonFileNode<ContactsTrashShardDocument>({
        transport,
        account,
        fileName: initial.shardName,
        marker: CONTACTS_TRASH_SHARD_MARKER,
        maxBytes: CONTACTS_TRASH_MAX_DOCUMENT_BYTES,
        parentId: folder.parentId,
        useWebSocket,
      });
      if (remote.ok === false) return remote;
      if (remote.status === 'found') {
        const remoteDocument = validateContactsTrashShardDocument(remote.document);
        if (!remoteDocument) return invalidRemoteDocument();
        await handlers[DB_RPC.CONTACT_TRASH_MERGE_REMOTE_SHARDS]({
          accountId: account.id,
          shards: [{
            shardName: initial.shardName,
            doc: remoteDocument,
            remoteNodeId: remote.node.id,
            remoteBlobId: remote.node.blobId,
            legacy: false,
          }],
          ensurePush: false,
          finalize: false,
        });
      }
      const [local] = await handlers[DB_RPC.CONTACT_TRASH_GET_SHARDS]({
        accountId: account.id,
        shardNames: [initial.shardName],
      });
      if (!local || !local.dirty) {
        return { ok: true };
      }
      const document = validateContactsTrashShardDocument(local.doc);
      if (!document) return invalidRemoteDocument();
      let serializedBytes: number;
      try {
        serializedBytes = serializedContactsTrashShardBytes(document);
      } catch (error) {
        return {
          ok: false,
          error: {
            type: 'invalidDocument',
            message: error instanceof Error ? error.message : String(error),
            terminal: true,
          },
        };
      }
      if (
        Object.keys(document.entries).length > CONTACTS_TRASH_MAX_SHARD_ENTRIES
        || serializedBytes > snapshotWriteMaxBytes
      ) {
        return {
          ok: false,
          error: {
            type: 'tooLarge',
            message: 'Contacts trash shard exceeds its hard limits',
            terminal: true,
          },
        };
      }
      const write = await writeJsonFileNode({
        transport,
        account,
        fileName: initial.shardName,
        marker: CONTACTS_TRASH_SHARD_MARKER,
        document,
        snapshot: remote as Extract<
          FileNodeDocumentRead<ContactsTrashShardDocument>,
          { ok: true }
        >,
        parentId: folder.parentId,
        useWebSocket,
      });
      if (write.ok === true) {
        const confirmed = await handlers[DB_RPC.CONTACT_TRASH_CONFIRM_SHARD]({
          accountId: account.id,
          shardName: initial.shardName,
          remoteNodeId: write.nodeId,
          remoteBlobId: write.blobId,
          localRevision: local.localRevision,
        });
        if (confirmed.clean) {
          return { ok: true };
        }
        return { ok: false, error: { type: 'stateMismatch' as const } };
      }
      return write;
    });
    if (result.ok === false) return result;
  }
  const aggregate = await handlers[DB_RPC.CONTACT_TRASH_GET_DOCUMENT]({
    accountId: account.id,
  });
  return { ok: true, document: aggregate.doc };
}

function cardAddressBookIds(card: any): string[] | null {
  if (
    card?.addressBookIds
    && typeof card.addressBookIds === 'object'
    && !Array.isArray(card.addressBookIds)
  ) {
    const entries = Object.entries(card.addressBookIds);
    if (entries.some(([id, present]) => !id || present !== true)) return null;
    return entries.map(([id]) => id);
  }
  if (typeof card?.addressBookId === 'string' && card.addressBookId) {
    return [card.addressBookId];
  }
  return null;
}

function cardEmailAddresses(card: any): string[] {
  if (!card?.emails || typeof card.emails !== 'object' || Array.isArray(card.emails)) {
    return [];
  }
  return Object.values(card.emails).flatMap((email: any) =>
    typeof email?.address === 'string' && email.address.trim()
      ? [email.address.trim()]
      : []);
}

function cardDisplayName(card: any, emails: string[]): string {
  const name = card?.name;
  if (typeof name?.full === 'string' && name.full.trim()) return name.full.trim();
  if (typeof card?.fullName === 'string' && card.fullName.trim()) return card.fullName.trim();
  return emails[0] ?? '(no name)';
}

interface ContactMediaReference {
  object: Record<string, unknown>;
  blobId: string;
  mediaType: string;
}

function invalidTrashSnapshot(message: string): Error & { type: 'invalidTrashSnapshot' } {
  return Object.assign(new Error(message), { type: 'invalidTrashSnapshot' as const });
}

function contactMediaReferences(snapshot: unknown): ContactMediaReference[] {
  const references: ContactMediaReference[] = [];
  const stack: Array<{ depth: number; value: unknown }> = [{ depth: 0, value: snapshot }];
  const seen = new Set<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (
      current.value == null
      || typeof current.value !== 'object'
      || seen.has(current.value)
    ) {
      continue;
    }
    if (current.depth > 64 || nodes >= 10_000) {
      throw invalidTrashSnapshot('Contact media structure exceeds safe preservation limits');
    }
    nodes += 1;
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      for (const value of current.value) {
        stack.push({ depth: current.depth + 1, value });
      }
      continue;
    }
    const object = current.value as Record<string, unknown>;
    if ('blobId' in object) {
      const blobId = typeof object.blobId === 'string' ? object.blobId.trim() : '';
      const mediaType = typeof object.mediaType === 'string' ? object.mediaType.trim() : '';
      if (!blobId || !mediaType) {
        throw invalidTrashSnapshot('Contact Media blob references require blobId and mediaType');
      }
      references.push({ object, blobId, mediaType });
      if (references.length > CONTACTS_TRASH_MAX_MEDIA_ITEMS) {
        throw invalidTrashSnapshot('Contact has too many media blobs to preserve');
      }
    }
    for (const value of Object.values(object)) {
      stack.push({ depth: current.depth + 1, value });
    }
  }
  return references;
}

function mediaKey(blobId: string, mediaType: string): string {
  return `${blobId}\u0000${mediaType}`;
}

function hasDurableMedia(entry: ContactTrashDocumentEntry): boolean {
  try {
    const preserved = new Set(
      entry.media.map((item) => mediaKey(item.blobId, item.mediaType)),
    );
    return contactMediaReferences(entry.snapshot).every((reference) =>
      preserved.has(mediaKey(reference.blobId, reference.mediaType)));
  } catch {
    return false;
  }
}

async function preserveContactMedia({
  transport,
  account,
  entry,
}: {
  transport: any;
  account: any;
  entry: ContactTrashDocumentEntry;
}): Promise<ContactTrashDocumentEntry> {
  const references = contactMediaReferences(entry.snapshot);
  const unique = new Map<string, ContactMediaReference>();
  for (const reference of references) {
    unique.set(mediaKey(reference.blobId, reference.mediaType), reference);
  }
  const media: ContactTrashMedia[] = [];
  let totalBytes = 0;
  for (const reference of unique.values()) {
    const bytes = await transport.download({
      accountId: account.remote_account_id,
      blobId: reference.blobId,
      type: reference.mediaType,
      name: 'contact-media',
      maxBytes: CONTACTS_TRASH_MAX_MEDIA_BYTES,
    });
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw invalidTrashSnapshot('Contact media download returned no bytes');
    }
    if (bytes.byteLength > CONTACTS_TRASH_MAX_MEDIA_BYTES) {
      throw invalidTrashSnapshot('Contact media blob exceeds the preservation size limit');
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > CONTACTS_TRASH_MAX_TOTAL_MEDIA_BYTES) {
      throw invalidTrashSnapshot('Contact media exceeds the total preservation size limit');
    }
    media.push({
      blobId: reference.blobId,
      mediaType: reference.mediaType,
      base64: bytesToBase64(bytes),
    });
  }
  return { ...entry, media };
}

async function restoreContactMedia({
  transport,
  account,
  snapshot,
  media,
}: {
  transport: any;
  account: any;
  snapshot: Record<string, unknown>;
  media: ContactTrashMedia[];
}): Promise<Record<string, unknown>> {
  const references = contactMediaReferences(snapshot);
  const preserved = new Map(
    media.map((item) => [mediaKey(item.blobId, item.mediaType), item]),
  );
  const uploaded = new Map<string, string>();
  for (const reference of references) {
    const key = mediaKey(reference.blobId, reference.mediaType);
    if (uploaded.has(key)) continue;
    const durable = preserved.get(key);
    if (!durable) {
      throw invalidTrashSnapshot('Contact media snapshot has no durable blob copy');
    }
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(durable.base64);
    } catch {
      throw invalidTrashSnapshot('Contact media snapshot is not valid base64');
    }
    if (
      bytes.byteLength === 0
      || bytes.byteLength > CONTACTS_TRASH_MAX_MEDIA_BYTES
    ) {
      throw invalidTrashSnapshot('Contact media snapshot exceeds safe restore limits');
    }
    const upload = await transport.upload({
      accountId: account.remote_account_id,
      type: reference.mediaType,
      body: bytes,
    });
    if (typeof upload?.blobId !== 'string' || !upload.blobId) {
      throw new Error('Contact media upload returned no blob id');
    }
    uploaded.set(key, upload.blobId);
  }
  for (const reference of references) {
    reference.object.blobId = uploaded.get(mediaKey(reference.blobId, reference.mediaType))!;
  }
  return snapshot;
}

export function contactTrashEntryFromCard(
  card: any,
  timestamp = Date.now(),
): ContactTrashDocumentEntry | null {
  if (
    !card
    || typeof card !== 'object'
    || Array.isArray(card)
    || typeof card.id !== 'string'
    || !card.id
    || typeof card.uid !== 'string'
    || !card.uid
  ) {
    return null;
  }
  const addressBookIds = cardAddressBookIds(card);
  if (!addressBookIds?.length) return null;
  const emails = cardEmailAddresses(card);
  return {
    uid: card.uid,
    remoteId: card.id,
    addressBookIds,
    trashedAt: timestamp,
    expiresAt: timestamp + CONTACTS_TRASH_RETENTION_MS,
    status: 'trashed',
    updatedAt: timestamp,
    emailKeys: [...new Set(emails.map(addressKey).filter(Boolean))],
    displayName: cardDisplayName(card, emails),
    primaryEmail: emails[0] ?? null,
    snapshot: structuredClone(card),
    media: [],
  };
}

export interface ContactTrashWireTarget {
  contactId: number;
  remoteId: string;
}

export interface ContactTrashDeleteChunkResult {
  succeededContactIds: number[];
  updatedContactIds: number[];
  destroyedContactIds: number[];
  failures: Array<{ contactId: number; errorType: string; message?: string }>;
  updatedRemoteIds: string[];
  destroyedRemoteIds: string[];
}

function emptyDeleteResult(): ContactTrashDeleteChunkResult {
  return {
    succeededContactIds: [],
    updatedContactIds: [],
    destroyedContactIds: [],
    failures: [],
    updatedRemoteIds: [],
    destroyedRemoteIds: [],
  };
}

function mergeDeleteResult(
  target: ContactTrashDeleteChunkResult,
  source: ContactTrashDeleteChunkResult,
): void {
  target.succeededContactIds.push(...source.succeededContactIds);
  target.updatedContactIds.push(...source.updatedContactIds);
  target.destroyedContactIds.push(...source.destroyedContactIds);
  target.failures.push(...source.failures);
  target.updatedRemoteIds.push(...source.updatedRemoteIds);
  target.destroyedRemoteIds.push(...source.destroyedRemoteIds);
}

function failure(
  contactId: number,
  errorType: string,
  detail?: any,
): ContactTrashDeleteChunkResult['failures'][number] {
  const message = typeof detail?.description === 'string'
    ? detail.description
    : (typeof detail?.message === 'string' ? detail.message : undefined);
  return { contactId, errorType, ...(message ? { message } : {}) };
}

function contactWriteTransportError(error: any): {
  type: string;
  message: string;
  status?: number;
  terminal?: true;
} {
  const status = error?.status;
  const message = error?.message ?? String(error);
  const authentication = classifyAuthenticationOrAuthorizationError(error);
  if (authentication) {
    return {
      type: authentication.type,
      message,
      ...(typeof status === 'number' ? { status } : {}),
      ...(authentication.terminal ? { terminal: true } : {}),
    };
  }
  if (status === 404) {
    return { type: 'notFound', message, status, terminal: true };
  }
  if (status === 413) {
    return { type: 'tooLarge', message, status, terminal: true };
  }
  if (status === 429) return { type: 'rateLimit', message, status };
  if (status === 503) return { type: 'serverUnavailable', message, status };
  return {
    type: 'transport',
    message,
    ...(typeof status === 'number' ? { status } : {}),
  };
}

function trashIdsForRemoteIds(
  remoteIds: string[],
  trashIdByRemoteId: Map<string, number>,
): number[] {
  return remoteIds.flatMap((remoteId) => {
    const trashId = trashIdByRemoteId.get(remoteId);
    return trashId == null ? [] : [trashId];
  });
}

async function fetchCardsAndRights({
  transport,
  account,
  remoteIds,
  useWebSocket,
}: any): Promise<
  | {
      ok: true;
      state: string;
      cards: Map<string, any>;
      rights: Map<string, boolean>;
    }
  | { ok: false; error: any }
> {
  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
    methodCalls: [
      ['AddressBook/get', {
        accountId: account.remote_account_id,
        properties: ['id', 'myRights'],
      }, 'trash-books'],
      ['ContactCard/get', {
        accountId: account.remote_account_id,
        ids: remoteIds,
      }, 'trash-cards'],
    ],
    useWebSocket,
  });
  const books = pickResponseById(result, 'AddressBook/get', 'trash-books');
  const cards = pickResponseById(result, 'ContactCard/get', 'trash-cards');
  if (
    !books
    || !Array.isArray(books.list)
    || !cards
    || !Array.isArray(cards.list)
    || typeof cards.state !== 'string'
  ) {
    const detail = pickResponse(result, 'error');
    return { ok: false, error: { type: detail?.type ?? 'serverFail', detail } };
  }
  return {
    ok: true,
    state: cards.state,
    cards: new Map(cards.list.flatMap((card: any) =>
      typeof card?.id === 'string' ? [[card.id, card]] : [])),
    rights: new Map(books.list.flatMap((book: any) =>
      typeof book?.id === 'string'
        ? [[book.id, book.myRights?.mayWrite === true]]
        : [])),
  };
}

function sameSnapshot(entry: ContactTrashDocumentEntry | undefined, card: any): boolean {
  return entry?.status === 'trashed'
    && JSON.stringify(entry.snapshot) === JSON.stringify(card)
    && JSON.stringify(entry.addressBookIds) === JSON.stringify(cardAddressBookIds(card))
    && hasDurableMedia(entry);
}

async function checkpointTrashEntries({
  transport,
  account,
  handlers,
  entries,
  maxBytes,
  onSnapshotSaved,
  useWebSocket,
}: any): Promise<{ ok: true } | { ok: false; error: any }> {
  if (entries.length === 0) return { ok: true };
  const before = await handlers[DB_RPC.CONTACT_TRASH_GET_DOCUMENT]({
    accountId: account.id,
  });
  const previousEntries = entries.map((entry: ContactTrashDocumentEntry) =>
    before.doc.entries[entry.uid] ?? null);
  let staged;
  try {
    staged = await handlers[DB_RPC.CONTACT_TRASH_PUT_ENTRIES]({
      accountId: account.id,
      entries,
      ensurePush: false,
      maxBytes,
      singleShard: true,
    });
  } catch (error: any) {
    return { ok: false, error };
  }
  const stagedEntries = entries.map((entry: ContactTrashDocumentEntry) =>
    staged.doc.entries[entry.uid] as ContactTrashDocumentEntry);
  await onSnapshotSaved?.();
  const pushed = await pushContactsTrash({
    transport,
    account,
    handlers,
    shardNames: staged.touchedShards,
    useWebSocket,
  });
  if (pushed.ok === false) {
    if (!isRetryableFileNodeDocumentError(pushed.error)) {
      await handlers[DB_RPC.CONTACT_TRASH_ROLLBACK_ENTRIES]({
        accountId: account.id,
        stagedEntries,
        previousEntries,
      });
    }
    return pushed;
  }
  const confirmed = pushed.document?.entries ?? {};
  if (stagedEntries.some((entry: ContactTrashDocumentEntry) =>
    confirmed[entry.uid]?.status !== 'trashed'
    || JSON.stringify(confirmed[entry.uid]?.snapshot) !== JSON.stringify(entry.snapshot))) {
    return {
      ok: false,
      error: {
        type: 'trashConflict',
        message: 'A newer trash lifecycle state prevented deletion',
        terminal: true,
      },
    };
  }
  return { ok: true };
}

async function tombstoneEntries({
  transport,
  account,
  handlers,
  trashIds,
  useWebSocket,
}: any): Promise<{ ok: true } | { ok: false; error: any }> {
  if (trashIds.length === 0) return { ok: true };
  const changed = await handlers[DB_RPC.CONTACT_TRASH_SET_STATUS]({
    accountId: account.id,
    trashIds,
    status: 'purged',
    ensurePush: true,
  });
  const pushed = await pushContactsTrash({
    transport,
    account,
    handlers,
    shardNames: changed.touchedShards,
    useWebSocket,
  });
  return pushed.ok === false ? pushed : { ok: true };
}

export async function deleteContactCardsWithTrash({
  transport,
  account,
  handlers,
  targets,
  sourceAddressBookRemoteId,
  onPhase,
  onChunk,
  maxTrashShardBytes = CONTACTS_TRASH_MAX_DOCUMENT_BYTES,
  useWebSocket = false,
}: {
  transport: any;
  account: any;
  handlers: Record<string, (params: any) => Promise<any>>;
  targets: ContactTrashWireTarget[];
  sourceAddressBookRemoteId: string | null;
  onPhase?: (phase: string, detail?: unknown) => Promise<void>;
  onChunk?: (result: ContactTrashDeleteChunkResult) => Promise<void>;
  maxTrashShardBytes?: number;
  useWebSocket?: boolean;
}): Promise<{
  complete: boolean;
  result: ContactTrashDeleteChunkResult;
  error?: any;
}> {
  const total = emptyDeleteResult();
  const snapshotWriteMaxBytes = Math.min(
    maxTrashShardBytes,
    contactsTrashSnapshotWriteMaxBytes(transport),
  );
  const cap = Math.max(
    1,
    Math.min(maxObjectsInGet(transport), maxObjectsInSet(transport), CONTACTS_TRASH_MAX_SHARD_ENTRIES),
  );
  for (let offset = 0; offset < targets.length; offset += cap) {
    const chunkTargets = targets.slice(offset, offset + cap);
    let completed = false;
    for (let attempt = 0; attempt < 3 && !completed; attempt += 1) {
      const fetched = await fetchCardsAndRights({
        transport,
        account,
        remoteIds: chunkTargets.map((target) => target.remoteId),
        useWebSocket,
      });
      if (fetched.ok === false) return { complete: false, result: total, error: fetched.error };
      const result = emptyDeleteResult();
      const updates: Record<string, Record<string, unknown>> = {};
      const destroys: string[] = [];
      const writeTargets = new Map<string, ContactTrashWireTarget>();
      const document = await handlers[DB_RPC.CONTACT_TRASH_GET_DOCUMENT]({
        accountId: account.id,
      });
      const localTrash = await handlers[DB_RPC.CONTACT_TRASH_LIST]({
        accountId: account.id,
      });
      const trashIdByRemoteId = new Map<string, number>(
        localTrash.map((entry: any) => [entry.prior_remote_id, Number(entry.id)]),
      );
      const cardsWithTrashUids = new Map<string, any>();
      const remoteIdsByUid = new Map<string, Set<string>>();
      for (const card of fetched.cards.values()) {
        const snapshotCard = typeof card?.uid === 'string' && card.uid
          ? card
          : {
              ...card,
              uid: await createContactUidFromSeed(
                `contacts-trash\0${account.remote_account_id}\0${card.id}`,
              ),
            };
        cardsWithTrashUids.set(card.id, snapshotCard);
        const remoteIds = remoteIdsByUid.get(snapshotCard.uid) ?? new Set<string>();
        remoteIds.add(card.id);
        remoteIdsByUid.set(snapshotCard.uid, remoteIds);
      }
      const conflictingUids = new Set(
        [...remoteIdsByUid]
          .filter(([, remoteIds]) => remoteIds.size > 1)
          .map(([uid]) => uid),
      );
      const staleSnapshotTrashIds: number[] = [];
      const snapshots: ContactTrashDocumentEntry[] = [];
      for (const target of chunkTargets) {
        const card = cardsWithTrashUids.get(target.remoteId);
        if (!card) {
          result.succeededContactIds.push(target.contactId);
          result.destroyedContactIds.push(target.contactId);
          result.destroyedRemoteIds.push(target.remoteId);
          continue;
        }
        if (conflictingUids.has(card.uid)) {
          result.failures.push(failure(target.contactId, 'ambiguousUid'));
          continue;
        }
        const memberships = cardAddressBookIds(card);
        if (!memberships?.length) {
          result.failures.push(failure(target.contactId, 'invalidContactMembership'));
          continue;
        }
        if (sourceAddressBookRemoteId != null) {
          if (fetched.rights.get(sourceAddressBookRemoteId) !== true) {
            result.failures.push(failure(target.contactId, 'forbidden'));
            continue;
          }
          if (!memberships.includes(sourceAddressBookRemoteId)) {
            result.succeededContactIds.push(target.contactId);
            result.updatedContactIds.push(target.contactId);
            result.updatedRemoteIds.push(target.remoteId);
            continue;
          }
          if (memberships.length > 1) {
            const staleTrashId = trashIdByRemoteId.get(target.remoteId);
            if (staleTrashId != null) staleSnapshotTrashIds.push(staleTrashId);
            updates[target.remoteId] = {
              [`addressBookIds/${sourceAddressBookRemoteId
                .replace(/~/g, '~0')
                .replace(/\//g, '~1')}`]: null,
            };
            writeTargets.set(target.remoteId, target);
            continue;
          }
        } else if (memberships.some((id) => fetched.rights.get(id) !== true)) {
          result.failures.push(failure(target.contactId, 'forbidden'));
          continue;
        }
        const snapshot = contactTrashEntryFromCard(card);
        if (!snapshot) {
          result.failures.push(failure(target.contactId, 'invalidTrashSnapshot'));
          continue;
        }
        const existingSnapshot = document.doc.entries[snapshot.uid];
        if (
          existingSnapshot?.status === 'trashed'
          && existingSnapshot.remoteId !== snapshot.remoteId
        ) {
          result.failures.push(failure(target.contactId, 'ambiguousUid'));
          continue;
        }
        try {
          const durable = existingSnapshot && sameSnapshot(existingSnapshot, card)
            ? existingSnapshot
            : await preserveContactMedia({
              transport,
              account,
              entry: snapshot,
            });
          if (!contactTrashEntryFitsInShard(durable, snapshotWriteMaxBytes)) {
            result.failures.push(failure(
              target.contactId,
              'trashSnapshotTooLarge',
              { message: 'Contact snapshot exceeds the configured trash shard size limit' },
            ));
            continue;
          }
          snapshots.push(durable);
        } catch (error) {
          result.failures.push(failure(
            target.contactId,
            'mediaPreservationFailed',
            error,
          ));
          continue;
        }
        destroys.push(target.remoteId);
        writeTargets.set(target.remoteId, target);
      }
      if (staleSnapshotTrashIds.length > 0) {
        const cleaned = await tombstoneEntries({
          transport,
          account,
          handlers,
          trashIds: staleSnapshotTrashIds,
          useWebSocket,
        });
        if (cleaned.ok === false) {
          return { complete: false, result: total, error: cleaned.error };
        }
      }
      if (snapshots.length > 0) {
        const checkpoint = await checkpointTrashEntries({
          transport,
          account,
          handlers,
          entries: snapshots,
          maxBytes: snapshotWriteMaxBytes,
          onSnapshotSaved: () => onPhase?.(
            'snapshot-saved',
            { uids: snapshots.map((entry) => entry.uid) },
          ),
          useWebSocket,
        });
        if (checkpoint.ok === false) {
          if (
            checkpoint.error?.type === 'trashGroupTooLarge'
            && chunkTargets.length > 1
          ) {
            const splitAt = Math.ceil(chunkTargets.length / 2);
            for (const splitTargets of [
              chunkTargets.slice(0, splitAt),
              chunkTargets.slice(splitAt),
            ]) {
              const split = await deleteContactCardsWithTrash({
                transport,
                account,
                handlers,
                targets: splitTargets,
                sourceAddressBookRemoteId,
                onPhase,
                onChunk,
                maxTrashShardBytes: snapshotWriteMaxBytes,
                useWebSocket,
              });
              mergeDeleteResult(total, split.result);
              if (!split.complete) {
                return { complete: false, result: total, error: split.error };
              }
            }
            completed = true;
            break;
          }
          return { complete: false, result: total, error: checkpoint.error };
        }
        const stagedUids = new Set(snapshots.map((entry) => entry.uid));
        const stagedTrash = await handlers[DB_RPC.CONTACT_TRASH_LIST]({
          accountId: account.id,
        });
        for (const entry of stagedTrash) {
          if (stagedUids.has(entry.uid)) {
            trashIdByRemoteId.set(entry.prior_remote_id, Number(entry.id));
          }
        }
      }
      await onPhase?.('document-confirmed', { remoteIds: destroys });
      if (Object.keys(updates).length === 0 && destroys.length === 0) {
        mergeDeleteResult(total, result);
        await onChunk?.(result);
        completed = true;
        continue;
      }
      await onPhase?.('server-write-pending', { remoteIds: [...writeTargets.keys()] });
      let written;
      try {
        written = await callJmap(transport, {
          using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
          methodCalls: [['ContactCard/set', {
            accountId: account.remote_account_id,
            ifInState: fetched.state,
            ...(Object.keys(updates).length > 0 ? { update: updates } : {}),
            ...(destroys.length > 0 ? { destroy: destroys } : {}),
          }, 'trash-set']],
          useWebSocket,
        });
      } catch (error) {
        const mapped = contactWriteTransportError(error);
        if (mapped.terminal && destroys.length > 0) {
          const cleaned = await tombstoneEntries({
            transport,
            account,
            handlers,
            trashIds: trashIdsForRemoteIds(destroys, trashIdByRemoteId),
            useWebSocket,
          });
          if (cleaned.ok === false) {
            return { complete: false, result: total, error: cleaned.error };
          }
        }
        return { complete: false, result: total, error: mapped };
      }
      const set = pickResponseById(written, 'ContactCard/set', 'trash-set');
      if (!set) {
        const detail = pickResponse(written, 'error');
        const errorType = detail?.type ?? 'noResponse';
        if (errorType === 'stateMismatch' && attempt < 2) continue;
        if (
          !isRetryableContactWriteError(errorType, detail)
          && destroys.length > 0
        ) {
          const cleaned = await tombstoneEntries({
            transport,
            account,
            handlers,
            trashIds: trashIdsForRemoteIds(destroys, trashIdByRemoteId),
            useWebSocket,
          });
          if (cleaned.ok === false) {
            return { complete: false, result: total, error: cleaned.error };
          }
        }
        return {
          complete: false,
          result: total,
          error: {
            type: errorType,
            detail,
            ...(!isRetryableContactWriteError(errorType, detail)
              ? { terminal: true }
              : {}),
          },
        };
      }
      const failedTrashIds: number[] = [];
      let retryableError: any = null;
      for (const [remoteId, target] of writeTargets) {
        if (remoteId in updates) {
          if (set.updated && remoteId in set.updated) {
            result.succeededContactIds.push(target.contactId);
            result.updatedContactIds.push(target.contactId);
            result.updatedRemoteIds.push(remoteId);
            continue;
          }
          const reason = set.notUpdated?.[remoteId];
          const errorType = reason?.type ?? 'noResponse';
          if (isRetryableContactWriteError(errorType, reason)) {
            retryableError ??= { type: errorType, detail: reason };
          } else {
            result.failures.push(failure(target.contactId, errorType, reason));
          }
          continue;
        }
        if ((set.destroyed ?? []).includes(remoteId) || set.notDestroyed?.[remoteId]?.type === 'notFound') {
          result.succeededContactIds.push(target.contactId);
          result.destroyedContactIds.push(target.contactId);
          result.destroyedRemoteIds.push(remoteId);
          continue;
        }
        const reason = set.notDestroyed?.[remoteId];
        const errorType = reason?.type ?? 'noResponse';
        if (isRetryableContactWriteError(errorType, reason)) {
          retryableError ??= { type: errorType, detail: reason };
        } else {
          result.failures.push(failure(target.contactId, errorType, reason));
          const trashId = trashIdByRemoteId.get(remoteId);
          if (trashId != null) failedTrashIds.push(trashId);
        }
      }
      if (failedTrashIds.length > 0) {
        const cleaned = await tombstoneEntries({
          transport,
          account,
          handlers,
          trashIds: failedTrashIds,
          useWebSocket,
        });
        if (cleaned.ok === false) {
          return { complete: false, result: total, error: cleaned.error };
        }
      }
      mergeDeleteResult(total, result);
      await onChunk?.(result);
      if (retryableError) {
        return { complete: false, result: total, error: retryableError };
      }
      completed = true;
    }
    if (!completed) return { complete: false, result: total, error: { type: 'stateMismatch' } };
  }
  return { complete: true, result: total };
}

function emptyTrashMutationResult(): ContactTrashMutationResult {
  return {
    succeededTrashIds: [],
    restoredRemoteIds: [],
    destinationRequiredTrashIds: [],
    failures: [],
  };
}

async function writableAddressBooks({
  transport,
  account,
  useWebSocket,
}: any): Promise<Map<string, boolean>> {
  const response = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
    methodCalls: [['AddressBook/get', {
      accountId: account.remote_account_id,
      properties: ['id', 'myRights'],
    }, 'restore-books']],
    useWebSocket,
  });
  const answer = pickResponse(response, 'AddressBook/get');
  if (!answer || !Array.isArray(answer.list)) throw new Error('AddressBook/get failed');
  return new Map(answer.list.flatMap((book: any) =>
    typeof book?.id === 'string'
      ? [[book.id, book.myRights?.mayWrite === true]]
      : []));
}

type ContactUidResolution =
  | { status: 'ambiguous' }
  | { status: 'existing'; remoteId: string }
  | { status: 'missing' };

function uidQueryBatchSize(transport: any): number {
  return Math.max(1, Math.min(32, Math.floor(maxObjectsInGet(transport) / 2)));
}

async function resolveCardsByUid({
  transport,
  account,
  details,
  useWebSocket,
}: {
  transport: any;
  account: any;
  details: ContactTrashDetail[];
  useWebSocket: boolean;
}): Promise<Map<string, ContactUidResolution>> {
  const resolutions = new Map<string, ContactUidResolution>();
  const queryCap = uidQueryBatchSize(transport);
  const getCap = maxObjectsInGet(transport);
  for (let offset = 0; offset < details.length; offset += queryCap) {
    const chunk = details.slice(offset, offset + queryCap);
    const uids = [...new Set(chunk.map((detail) => detail.uid))];
    const queryCallId = `restore-uid-query-${offset}`;
    const response = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
      methodCalls: [[
        'ContactCard/query',
        {
          accountId: account.remote_account_id,
          filter: uids.length === 1
            ? { uid: uids[0] }
            : {
                operator: 'OR',
                conditions: uids.map((uid) => ({ uid })),
              },
          calculateTotal: true,
          limit: getCap,
        },
        queryCallId,
      ]],
      useWebSocket,
    });
    const answer = pickResponseById(response, 'ContactCard/query', queryCallId);
    if (
      !answer
      || !Array.isArray(answer.ids)
      || answer.ids.some((id: unknown) => typeof id !== 'string' || !id)
      || new Set(answer.ids).size !== answer.ids.length
      || !Number.isSafeInteger(answer.total)
      || answer.total !== answer.ids.length
    ) {
      const methodError = pickResponseById(response, 'error', queryCallId);
      throw new Error(
        `ContactCard/query did not answer uid recovery${
          methodError?.type ? ` (${methodError.type})` : ''
        }`,
      );
    }
    const cardsByUid = new Map<string, Array<{ id: string; uid: string }>>();
    for (let getOffset = 0; getOffset < answer.ids.length; getOffset += getCap) {
      const ids = answer.ids.slice(getOffset, getOffset + getCap);
      const getCallId = `restore-uid-get-${offset}-${getOffset}`;
      const getResponse = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
        methodCalls: [['ContactCard/get', {
          accountId: account.remote_account_id,
          ids,
          properties: ['id', 'uid'],
        }, getCallId]],
        useWebSocket,
      });
      const getAnswer = pickResponseById(getResponse, 'ContactCard/get', getCallId);
      if (
        !getAnswer
        || !Array.isArray(getAnswer.list)
        || !Array.isArray(getAnswer.notFound)
        || typeof getAnswer.state !== 'string'
        || getAnswer.notFound.length !== 0
      ) {
        throw new Error('ContactCard/get did not confirm uid recovery');
      }
      const selectedIds = new Set(ids);
      const seenIds = new Set<string>();
      for (const card of getAnswer.list) {
        if (
          typeof card?.id !== 'string'
          || typeof card?.uid !== 'string'
          || !selectedIds.has(card.id)
          || !uids.includes(card.uid)
          || seenIds.has(card.id)
        ) {
          throw new Error('ContactCard/get returned malformed uid recovery data');
        }
        seenIds.add(card.id);
        const matches = cardsByUid.get(card.uid) ?? [];
        matches.push({ id: card.id, uid: card.uid });
        cardsByUid.set(card.uid, matches);
      }
      if (seenIds.size !== ids.length) {
        throw new Error('ContactCard/get omitted uid recovery data');
      }
    }
    for (const detail of chunk) {
      const cards = cardsByUid.get(detail.uid) ?? [];
      if (cards.length > 1) {
        resolutions.set(detail.uid, { status: 'ambiguous' });
      } else if (cards.length === 1) {
        resolutions.set(detail.uid, {
          status: 'existing',
          remoteId: cards[0].id,
        });
      } else {
        resolutions.set(detail.uid, { status: 'missing' });
      }
    }
  }
  return resolutions;
}

export async function restoreContactTrash({
  transport,
  account,
  handlers,
  trashIds,
  destinationAddressBookRemoteId = null,
  useWebSocket = false,
}: any): Promise<ContactTrashMutationResult> {
  const result = emptyTrashMutationResult();
  const lookups = await handlers[DB_RPC.CONTACT_TRASH_GET_MANY]({
    accountId: account.id,
    trashIds,
  }) as ContactTrashLookup[];
  const details: ContactTrashDetail[] = [];
  for (const lookup of lookups) {
    switch (lookup.status) {
      case 'active':
        details.push(lookup.detail);
        break;
      case 'inactive':
      case 'missing':
        result.succeededTrashIds.push(lookup.trashId);
        break;
      case 'unreadable':
        result.failures.push({
          trashId: lookup.trashId,
          errorType: lookup.errorType,
        });
        break;
      default: {
        const exhaustive: never = lookup;
        throw new Error(`Unsupported contacts trash lookup: ${String(exhaustive)}`);
      }
    }
  }
  const resolutions = await resolveCardsByUid({
    transport,
    account,
    details,
    useWebSocket,
  });
  const needsCreate = details.some((detail) =>
    resolutions.get(detail.uid)?.status === 'missing');
  const rights = needsCreate
    ? await writableAddressBooks({ transport, account, useWebSocket })
    : new Map<string, boolean>();
  const create: Record<string, Record<string, unknown>> = {};
  const createDetails = new Map<string, ContactTrashDetail>();
  for (const detail of details) {
    const resolution = resolutions.get(detail.uid);
    if (!resolution) throw new Error('ContactCard uid recovery omitted a selected entry');
    switch (resolution.status) {
      case 'existing':
        result.succeededTrashIds.push(detail.id);
        result.restoredRemoteIds.push(resolution.remoteId);
        continue;
      case 'ambiguous':
        result.failures.push({
          trashId: detail.id,
          errorType: 'ambiguousUid',
        });
        continue;
      case 'missing':
        break;
      default: {
        const exhaustive: never = resolution;
        throw new Error(`Unsupported uid resolution: ${String(exhaustive)}`);
      }
    }
    const destinations = detail.original_addressbook_ids.filter((id) => rights.get(id) === true);
    if (
      destinations.length === 0
      && destinationAddressBookRemoteId
      && rights.get(destinationAddressBookRemoteId) === true
    ) {
      destinations.push(destinationAddressBookRemoteId);
    }
    if (destinations.length === 0) {
      result.destinationRequiredTrashIds.push(detail.id);
      continue;
    }
    const snapshot = structuredClone(detail.snapshot);
    delete snapshot.id;
    snapshot.uid = detail.uid;
    snapshot.addressBookIds = Object.fromEntries(destinations.map((id) => [id, true]));
    try {
      await restoreContactMedia({
        transport,
        account,
        snapshot,
        media: detail.media,
      });
    } catch (error: any) {
      if (error?.type !== 'invalidTrashSnapshot') throw error;
      result.failures.push({
        trashId: detail.id,
        errorType: 'invalidTrashSnapshot',
        message: error.message,
      });
      continue;
    }
    const key = `restore-${detail.id}`;
    create[key] = snapshot;
    createDetails.set(key, detail);
  }
  const keys = Object.keys(create);
  const cap = maxObjectsInSet(transport);
  for (let offset = 0; offset < keys.length; offset += cap) {
    const chunkKeys = keys.slice(offset, offset + cap);
    const response = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
      methodCalls: [['ContactCard/set', {
        accountId: account.remote_account_id,
        create: Object.fromEntries(chunkKeys.map((key) => [key, create[key]])),
      }, 'restore-set']],
      useWebSocket,
    });
    const set = pickResponse(response, 'ContactCard/set');
    if (!set) throw new Error('ContactCard/set did not answer restore');
    for (const key of chunkKeys) {
      const detail = createDetails.get(key)!;
      const remoteId = set.created?.[key]?.id;
      if (typeof remoteId === 'string') {
        result.succeededTrashIds.push(detail.id);
        result.restoredRemoteIds.push(remoteId);
      } else {
        const reason = set.notCreated?.[key];
        result.failures.push({
          trashId: detail.id,
          errorType: reason?.type ?? 'noResponse',
          ...(typeof reason?.description === 'string' ? { message: reason.description } : {}),
        });
      }
    }
  }
  if (result.succeededTrashIds.length > 0) {
    result.succeededTrashIds = [...new Set(result.succeededTrashIds)];
    result.restoredRemoteIds = [...new Set(result.restoredRemoteIds)];
  }
  return result;
}

export async function deleteContactTrashForever({
  transport,
  account,
  handlers,
  trashIds,
  useWebSocket = false,
}: any): Promise<ContactTrashMutationResult> {
  const result = emptyTrashMutationResult();
  const changed = await handlers[DB_RPC.CONTACT_TRASH_SET_STATUS]({
    accountId: account.id,
    trashIds,
    status: 'purged',
    ensurePush: true,
  });
  const pushed = await pushContactsTrash({
    transport,
    account,
    handlers,
    shardNames: changed.touchedShards,
    useWebSocket,
  });
  if (pushed.ok === false) throw Object.assign(new Error(pushed.error.message), pushed.error);
  result.succeededTrashIds.push(...changed.changedIds);
  for (const id of trashIds) {
    if (!changed.changedIds.includes(id)) result.succeededTrashIds.push(id);
  }
  return result;
}
