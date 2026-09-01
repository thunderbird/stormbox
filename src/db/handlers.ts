/**
 * Repository handlers. These are the worker-side implementations of the
 * RPC methods listed in protocol.js.
 *
 * Each handler is a pure async function (engine, params) => result. They
 * are exercised directly in unit tests against an in-memory Engine, and
 * exposed over MessagePort RPC by the SharedWorker entry point.
 *
 * Handlers must:
 *   - Return JSON-cloneable values only (no Engine, no functions).
 *   - Wrap multi-statement writes in engine.transaction() for atomicity.
 *   - Add their touched table families to the supplied broadcaster.
 */

import { addressKey, nameTokens } from '../utils/address-key';
import { IDENTITY_ERROR } from '../constants/identity-errors';
import { decodeIdentityAddresses, hasOwn } from '../utils/identity-fields';
import {
  ADDRESSBOOK_PHASE,
  DRAFT_PHASE,
  MUTATION_TYPE,
  SEND_PHASE,
} from '../constants/states';
import {
  CONTACTS_TRASH_MAX_DOCUMENT_BYTES,
  CONTACTS_TRASH_MAX_SHARD_ENTRIES,
  CONTACTS_TRASH_MAX_TOMBSTONE_SHARD_BYTES,
  CONTACTS_TRASH_SHARD_FILE_PREFIX,
  aggregateContactsTrashDocuments,
  contactTrashEntryFitsInShard,
  emptyContactsTrashShardDocument,
  mergeContactsTrashShardDocuments,
  normalizeContactsTrashDocument,
  normalizeContactTrashEntry,
  normalizeContactsTrashShardDocument,
  serializedContactsTrashShardBytes,
  type ContactTrashDocumentEntry,
  type ContactsTrashDocument,
  type ContactsTrashShardDocument,
} from '../constants/contacts-trash-document';
import type { ContactTrashDetail, ContactTrashLookup } from '../types/db';
import {
  emptySettingsDocument,
  mergeSettingsDocuments,
  normalizeSettingsDocument,
} from '../constants/settings-document';
import { autocompleteRecipients, ownedAddressKeys } from './autocomplete';
import {
  batchResult,
  compactViewAfterDeletingPositions,
  numericUnique,
  placeholdersFor,
} from './batch-helpers';
import { DB_RPC, TABLE_FAMILIES } from './protocol';

function identityRowFromDatabase(row: any) {
  if (!row) return null;
  return {
    ...row,
    name: typeof row.name === 'string' ? row.name : '',
    reply_to: decodeIdentityAddresses(row.reply_to_json),
    bcc: decodeIdentityAddresses(row.bcc_json),
  };
}

async function destroyMessagesByRemoteIdsInTransaction(
  tx: any,
  accountId: number,
  remoteIds: string[],
  ts: number,
) {
  const ids = [...new Set(remoteIds.filter(Boolean))];
  if (ids.length === 0) return { removed: 0, views: 0 };
  const placeholders = placeholdersFor(ids);
  const rows = await tx.all(
    `SELECT qv.id AS view_id, qi.position
       FROM query_views qv
       JOIN query_view_items qi ON qi.view_id = qv.id
      WHERE qv.account_id = ?
        AND qi.remote_id IN (${placeholders})`,
    [accountId, ...ids],
  );
  const byView = new Map<number, number[]>();
  for (const row of rows) {
    const viewId = Number(row.view_id);
    const positions = byView.get(viewId) ?? [];
    positions.push(Number(row.position));
    byView.set(viewId, positions);
  }
  let removed = 0;
  for (const [viewId, positions] of byView) {
    await tx.run(
      `DELETE FROM query_view_items
        WHERE view_id = ? AND remote_id IN (${placeholders})`,
      [viewId, ...ids],
    );
    const result = await compactViewAfterDeletingPositions(tx, viewId, positions, ts);
    removed += result.removed;
  }
  await tx.run(
    `DELETE FROM messages
      WHERE account_id = ? AND remote_id IN (${placeholders})`,
    [accountId, ...ids],
  );
  return { removed, views: byView.size };
}

/**
 * Build the handler map for a given engine. Broadcaster is optional in
 * tests; pass a no-op when you don't care about cross-tab invalidation.
 *
 * `hooks.onMutationInserted({ accountId, mutationId })` is an optional
 * callback fired (best effort, never blocking) right after a
 * pending_mutations row is committed. The sync host registers it once
 * a backend has started so the OutboxRunner gets woken without
 * main-thread callers having to remember to kick drainOutbox. Tests
 * that don't wire a backend just leave the hook unset; the no-op
 * default keeps the handler self-contained.
 */
export function makeHandlers(engine: any, broadcaster: any = noopBroadcaster(), hooks: any = {}) {
  const onMutationInserted = typeof hooks.onMutationInserted === 'function'
    ? hooks.onMutationInserted
    : () => {};
  const now = () => Date.now();

  function notifyMutation(accountId: number, mutationId: number): void {
    try {
      const maybePromise = onMutationInserted({ accountId, mutationId });
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.catch(() => {});
      }
    } catch {
      // The durable row is sufficient; a later outbox wake will find it.
    }
  }

  function parseSettingsDocument(docJson: unknown) {
    if (typeof docJson !== 'string') return emptySettingsDocument();
    try {
      return normalizeSettingsDocument(JSON.parse(docJson));
    } catch {
      return emptySettingsDocument();
    }
  }

  async function loadSettingsInTx(tx: any, accountId: number) {
    const row = await tx.get(
      'SELECT doc_json, remote_node_id FROM user_settings WHERE account_id = ?',
      [accountId],
    );
    return {
      document: parseSettingsDocument(row?.doc_json),
      remoteNodeId: row?.remote_node_id ?? null,
    };
  }

  async function upsertSettingsInTx(
    tx: any,
    accountId: number,
    document: unknown,
    remoteNodeId: string | null,
    ts: number,
  ) {
    await tx.run(
      `INSERT INTO user_settings(account_id, doc_json, remote_node_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
          doc_json = excluded.doc_json,
          remote_node_id = excluded.remote_node_id,
          updated_at = excluded.updated_at`,
      [accountId, JSON.stringify(normalizeSettingsDocument(document)), remoteNodeId, ts],
    );
  }

  async function ensureSettingsPushInTx(tx: any, accountId: number, ts: number) {
    const rows = await tx.all(
      `SELECT id
         FROM pending_mutations
        WHERE account_id = ?
          AND mutation_type = ?
          AND local_status IN ('pending','retry')
        ORDER BY id`,
      [accountId, MUTATION_TYPE.PUSH_SETTINGS],
    );
    const existing = rows[0];
    if (existing) {
      await tx.run(
        `UPDATE pending_mutations
            SET local_status = 'pending',
                request_json = '{}',
                attempts = 0,
                last_attempt_at = NULL,
                not_before = NULL,
                server_response_json = NULL,
                error_json = NULL,
                updated_at = ?
          WHERE id = ?`,
        [ts, existing.id],
      );
      if (rows.length > 1) {
        await tx.run(
          `DELETE FROM pending_mutations
            WHERE account_id = ?
              AND mutation_type = ?
              AND local_status IN ('pending','retry')
              AND id <> ?`,
          [accountId, MUTATION_TYPE.PUSH_SETTINGS, existing.id],
        );
      }
      return { id: Number(existing.id), reused: true };
    }
    const result = await tx.run(
      `INSERT INTO pending_mutations(
          account_id, mutation_type, local_status, target_message_id,
          request_json, optimistic_patch_json, server_response_json, error_json,
          created_at, updated_at
       ) VALUES (?, ?, 'pending', NULL, '{}', NULL, NULL, NULL, ?, ?)`,
      [accountId, MUTATION_TYPE.PUSH_SETTINGS, ts, ts],
    );
    return { id: Number(result.lastInsertRowid), reused: false };
  }

  function parseContactsTrashDocument(
    docJson: unknown,
  ): ContactsTrashDocument | ContactsTrashShardDocument {
    if (typeof docJson !== 'string') return emptyContactsTrashShardDocument();
    try {
      const parsed = JSON.parse(docJson);
      return parsed?.version === 1
        ? normalizeContactsTrashDocument(parsed)
        : normalizeContactsTrashShardDocument(parsed);
    } catch {
      return emptyContactsTrashShardDocument();
    }
  }

  async function loadContactsTrashInTx(tx: any, accountId: number) {
    const rows = await tx.all(
      `SELECT shard_name, doc_json, remote_node_id, remote_blob_id,
              dirty, local_revision
         FROM contacts_trash_documents
        WHERE account_id = ?
        ORDER BY shard_name`,
      [accountId],
    );
    const shards = rows.map((row: any) => ({
      shardName: String(row.shard_name),
      document: parseContactsTrashDocument(row.doc_json),
      remoteNodeId: row.remote_node_id ?? null,
      remoteBlobId: row.remote_blob_id ?? null,
      dirty: Number(row.dirty) === 1,
      localRevision: Number(row.local_revision),
    }));
    return {
      document: aggregateContactsTrashDocuments(
        shards.map((shard: any) => shard.document),
      ),
      shards,
    };
  }

  function randomContactsTrashShardName(): string {
    return `${CONTACTS_TRASH_SHARD_FILE_PREFIX}${globalThis.crypto.randomUUID()}.json`;
  }

  function contactsTrashShardTooLarge(): Error & { type: 'tooLarge'; terminal: true } {
    return Object.assign(
      new Error('Contact trash entry exceeds the configured shard size limit'),
      { type: 'tooLarge' as const, terminal: true as const },
    );
  }

  function contactsTrashGroupTooLarge(): Error & { type: 'trashGroupTooLarge' } {
    return Object.assign(
      new Error('Contact trash checkpoint group does not fit one shard'),
      { type: 'trashGroupTooLarge' as const },
    );
  }

  function ambiguousContactsTrashUid(): Error & { type: 'ambiguousUid' } {
    return Object.assign(
      new Error('A different active contact already owns this trash UID'),
      { type: 'ambiguousUid' as const },
    );
  }

  type ContactsTrashShardLane = 'snapshot' | 'tombstone';

  async function openContactsTrashShardNameInTx(
    tx: any,
    accountId: number,
    ts: number,
    lane: ContactsTrashShardLane,
  ) {
    const state = await tx.get(
      `SELECT open_shard_name, open_tombstone_shard_name
         FROM contacts_trash_state
        WHERE account_id = ?`,
      [accountId],
    );
    const column = lane === 'snapshot' ? 'open_shard_name' : 'open_tombstone_shard_name';
    if (state?.[column]) return String(state[column]);
    const snapshotShardName = randomContactsTrashShardName();
    const tombstoneShardName = randomContactsTrashShardName();
    await tx.run(
      `INSERT INTO contacts_trash_state(
         account_id, open_shard_name, open_tombstone_shard_name, updated_at
       ) VALUES (?, ?, ?, ?)`,
      [accountId, snapshotShardName, tombstoneShardName, ts],
    );
    return lane === 'snapshot' ? snapshotShardName : tombstoneShardName;
  }

  async function rotateContactsTrashShardInTx(
    tx: any,
    accountId: number,
    ts: number,
    lane: ContactsTrashShardLane,
  ) {
    const shardName = randomContactsTrashShardName();
    const column = lane === 'snapshot' ? 'open_shard_name' : 'open_tombstone_shard_name';
    await tx.run(
      `UPDATE contacts_trash_state
          SET ${column} = ?, updated_at = ?
        WHERE account_id = ?`,
      [shardName, ts, accountId],
    );
    return shardName;
  }

  async function appendContactsTrashRecordsInTx(
    tx: any,
    accountId: number,
    entries: ContactTrashDocumentEntry[],
    ts: number,
    {
      maxBytes = CONTACTS_TRASH_MAX_DOCUMENT_BYTES,
      singleShard = false,
      lane = 'snapshot',
    }: {
      maxBytes?: number;
      singleShard?: boolean;
      lane?: ContactsTrashShardLane;
    } = {},
  ): Promise<string[]> {
    const touched = new Set<string>();
    let shardName = await openContactsTrashShardNameInTx(tx, accountId, ts, lane);
    if (singleShard && entries.length > 0) {
      for (const entry of entries) {
        if (!contactTrashEntryFitsInShard(entry, maxBytes)) throw contactsTrashShardTooLarge();
      }
      const records = entries.map((entry) => ({
        entry,
        recordId: globalThis.crypto.randomUUID(),
      }));
      for (let candidateIndex = 0; candidateIndex < 2; candidateIndex += 1) {
        const row = await tx.get(
          `SELECT doc_json
             FROM contacts_trash_documents
            WHERE account_id = ? AND shard_name = ?`,
          [accountId, shardName],
        );
        const document = row
          ? normalizeContactsTrashShardDocument(parseContactsTrashDocument(row.doc_json))
          : emptyContactsTrashShardDocument();
        const candidate = structuredClone(document);
        for (const record of records) {
          candidate.entries[record.recordId] = structuredClone(record.entry);
        }
        if (
          Object.keys(candidate.entries).length <= CONTACTS_TRASH_MAX_SHARD_ENTRIES
          && serializedContactsTrashShardBytes(candidate) <= maxBytes
        ) {
          if (row) {
            await tx.run(
              `UPDATE contacts_trash_documents
                  SET doc_json = ?, dirty = 1,
                      local_revision = local_revision + 1, updated_at = ?
                WHERE account_id = ? AND shard_name = ?`,
              [JSON.stringify(candidate), ts, accountId, shardName],
            );
          } else {
            await tx.run(
              `INSERT INTO contacts_trash_documents(
                 account_id, shard_name, doc_json, remote_node_id,
                 dirty, local_revision, updated_at
               ) VALUES (?, ?, ?, NULL, 1, 1, ?)`,
              [accountId, shardName, JSON.stringify(candidate), ts],
            );
          }
          return [shardName];
        }
        if (candidateIndex === 0) {
          shardName = await rotateContactsTrashShardInTx(tx, accountId, ts, lane);
        }
      }
      throw contactsTrashGroupTooLarge();
    }
    for (const entry of entries) {
      if (!contactTrashEntryFitsInShard(entry, maxBytes)) throw contactsTrashShardTooLarge();
      let appended = false;
      while (!appended) {
        const row = await tx.get(
          `SELECT doc_json, local_revision
             FROM contacts_trash_documents
            WHERE account_id = ? AND shard_name = ?`,
          [accountId, shardName],
        );
        const document = row
          ? normalizeContactsTrashShardDocument(parseContactsTrashDocument(row.doc_json))
          : emptyContactsTrashShardDocument();
        const recordId = globalThis.crypto.randomUUID();
        const candidate = structuredClone(document);
        candidate.entries[recordId] = structuredClone(entry);
        if (
          Object.keys(candidate.entries).length > CONTACTS_TRASH_MAX_SHARD_ENTRIES
          || serializedContactsTrashShardBytes(candidate) > maxBytes
        ) {
          shardName = await rotateContactsTrashShardInTx(tx, accountId, ts, lane);
          continue;
        }
        if (row) {
          await tx.run(
            `UPDATE contacts_trash_documents
                SET doc_json = ?, dirty = 1,
                    local_revision = local_revision + 1, updated_at = ?
              WHERE account_id = ? AND shard_name = ?`,
            [JSON.stringify(candidate), ts, accountId, shardName],
          );
        } else {
          await tx.run(
            `INSERT INTO contacts_trash_documents(
               account_id, shard_name, doc_json, remote_node_id,
               dirty, local_revision, updated_at
             ) VALUES (?, ?, ?, NULL, 1, 1, ?)`,
            [accountId, shardName, JSON.stringify(candidate), ts],
          );
        }
        touched.add(shardName);
        appended = true;
      }
    }
    return [...touched];
  }

  function contactsTrashEntryFingerprint(
    entry: ContactTrashDocumentEntry,
    includeUpdatedAt = true,
  ): string {
    const serialized = JSON.stringify(
      includeUpdatedAt ? entry : { ...entry, updatedAt: 0 },
    );
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < serialized.length; index += 1) {
      const code = serialized.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193);
      second = Math.imul(second ^ code, 0x5bd1e995);
    }
    return `${serialized.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
  }

  function contactsTrashTombstone(
    entry: ContactTrashDocumentEntry,
    status: 'purged' | 'restored',
    updatedAt: number,
  ): ContactTrashDocumentEntry {
    return {
      ...entry,
      addressBookIds: [],
      status,
      updatedAt,
      emailKeys: [],
      displayName: '(deleted)',
      primaryEmail: null,
      snapshot: null,
      media: [],
    };
  }

  async function persistContactsTrashInTx(
    tx: any,
    accountId: number,
    input: unknown,
    ts: number,
  ): Promise<ContactsTrashDocument> {
    const document = normalizeContactsTrashDocument(input);
    const existingRows = await tx.all(
      `SELECT id, uid, lifecycle_updated_at, projection_fingerprint
         FROM contacts_trash
        WHERE account_id = ?`,
      [accountId],
    );
    const existingByUid = new Map<string, any>(
      existingRows.map((row: any) => [String(row.uid), row]),
    );
    for (const entry of Object.values(document.entries)) {
      const projected = {
        priorRemoteId: entry.remoteId,
        addressBookIdsJson: JSON.stringify(entry.addressBookIds),
        snapshotJson: entry.snapshot == null ? null : JSON.stringify(entry.snapshot),
        mediaJson: JSON.stringify(entry.media),
        fingerprint: contactsTrashEntryFingerprint(entry),
        displayName: entry.displayName,
        primaryEmail: entry.primaryEmail,
        trashedAt: entry.trashedAt,
        expiresAt: entry.expiresAt,
        status: entry.status,
        lifecycleUpdatedAt: entry.updatedAt,
      };
      const existing = existingByUid.get(entry.uid);
      const unchanged = existing
        && existing.projection_fingerprint === projected.fingerprint
        && Number(existing.lifecycle_updated_at) === projected.lifecycleUpdatedAt;
      if (unchanged) {
        existingByUid.delete(entry.uid);
        continue;
      }
      let trashId: number;
      if (existing) {
        await tx.run(
          `UPDATE contacts_trash
              SET prior_remote_id = ?, original_addressbook_ids_json = ?,
                  snapshot_json = ?, media_json = ?, projection_fingerprint = ?,
                  display_name = ?, primary_email = ?, trashed_at = ?,
                  expires_at = ?, status = ?, lifecycle_updated_at = ?,
                  updated_at = ?
            WHERE id = ?`,
          [
            projected.priorRemoteId,
            projected.addressBookIdsJson,
            projected.snapshotJson,
            projected.mediaJson,
            projected.fingerprint,
            projected.displayName,
            projected.primaryEmail,
            projected.trashedAt,
            projected.expiresAt,
            projected.status,
            projected.lifecycleUpdatedAt,
            ts,
            existing.id,
          ],
        );
        trashId = Number(existing.id);
      } else {
        const inserted = await tx.run(
          `INSERT INTO contacts_trash(
             account_id, uid, prior_remote_id, original_addressbook_ids_json,
             snapshot_json, media_json, projection_fingerprint, display_name,
             primary_email, trashed_at, expires_at, status, lifecycle_updated_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            accountId,
            entry.uid,
            projected.priorRemoteId,
            projected.addressBookIdsJson,
            projected.snapshotJson,
            projected.mediaJson,
            projected.fingerprint,
            projected.displayName,
            projected.primaryEmail,
            projected.trashedAt,
            projected.expiresAt,
            projected.status,
            projected.lifecycleUpdatedAt,
            ts,
          ],
        );
        trashId = Number(inserted.lastInsertRowid);
      }
      existingByUid.delete(entry.uid);
      await tx.run('DELETE FROM contacts_trash_emails WHERE trash_id = ?', [trashId]);
      const projectedEmailKeys = entry.status === 'trashed' ? entry.emailKeys : [];
      for (let position = 0; position < projectedEmailKeys.length; position += 1) {
        await tx.run(
          `INSERT INTO contacts_trash_emails(
             trash_id, account_id, position, email_key
           ) VALUES (?, ?, ?, ?)`,
          [
            trashId,
            accountId,
            position,
            projectedEmailKeys[position],
          ],
        );
      }
    }
    const removedIds = [...existingByUid.values()].map((row: any) => Number(row.id));
    const deleteBatchSize = 250;
    for (let offset = 0; offset < removedIds.length; offset += deleteBatchSize) {
      const ids = removedIds.slice(offset, offset + deleteBatchSize);
      await tx.run(
        `DELETE FROM contacts_trash
          WHERE account_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
        [accountId, ...ids],
      );
    }
    return document;
  }

  function invalidTrashSnapshot(): Error & { type: 'invalidTrashSnapshot' } {
    return Object.assign(
      new Error('invalidTrashSnapshot: saved contact data is unreadable'),
      { type: 'invalidTrashSnapshot' as const },
    );
  }

  function contactTrashDetailFromRow(
    row: any,
    emailKeys: string[],
  ): ContactTrashDetail {
    let addressBookIds: unknown;
    let snapshot: unknown;
    let media: unknown;
    try {
      addressBookIds = JSON.parse(row.original_addressbook_ids_json);
      snapshot = JSON.parse(row.snapshot_json);
      media = JSON.parse(row.media_json);
    } catch {
      throw invalidTrashSnapshot();
    }
    const entry = normalizeContactTrashEntry({
      uid: row.uid,
      remoteId: row.prior_remote_id,
      addressBookIds,
      snapshot,
      media,
      displayName: row.display_name,
      primaryEmail: row.primary_email ?? null,
      trashedAt: Number(row.trashed_at),
      expiresAt: Number(row.expires_at),
      status: row.status,
      updatedAt: Number(row.lifecycle_updated_at),
      emailKeys,
    });
    if (!entry || entry.status !== 'trashed' || entry.snapshot == null) {
      throw invalidTrashSnapshot();
    }
    return {
      id: Number(row.id),
      uid: entry.uid,
      prior_remote_id: entry.remoteId,
      display_name: entry.displayName,
      primary_email: entry.primaryEmail,
      trashed_at: entry.trashedAt,
      expires_at: entry.expiresAt,
      status: entry.status,
      original_addressbook_ids: entry.addressBookIds,
      snapshot: entry.snapshot,
      email_keys: entry.emailKeys,
      media: entry.media,
    };
  }

  async function ensureContactsTrashPushInTx(tx: any, accountId: number, ts: number) {
    const rows = await tx.all(
      `SELECT id
         FROM pending_mutations
        WHERE account_id = ?
          AND mutation_type = ?
          AND local_status IN ('pending','retry')
        ORDER BY id`,
      [accountId, MUTATION_TYPE.PUSH_CONTACTS_TRASH],
    );
    const existing = rows[0];
    if (existing) {
      await tx.run(
        `UPDATE pending_mutations
            SET local_status = 'pending', request_json = '{}', attempts = 0,
                last_attempt_at = NULL, not_before = NULL,
                server_response_json = NULL, error_json = NULL, updated_at = ?
          WHERE id = ?`,
        [ts, existing.id],
      );
      if (rows.length > 1) {
        await tx.run(
          `DELETE FROM pending_mutations
            WHERE account_id = ? AND mutation_type = ?
              AND local_status IN ('pending','retry') AND id <> ?`,
          [accountId, MUTATION_TYPE.PUSH_CONTACTS_TRASH, existing.id],
        );
      }
      return { id: Number(existing.id), reused: true };
    }
    const result = await tx.run(
      `INSERT INTO pending_mutations(
         account_id, mutation_type, local_status, target_message_id,
         request_json, optimistic_patch_json, server_response_json, error_json,
         created_at, updated_at
       ) VALUES (?, ?, 'pending', NULL, '{}', NULL, NULL, NULL, ?, ?)`,
      [accountId, MUTATION_TYPE.PUSH_CONTACTS_TRASH, ts, ts],
    );
    return { id: Number(result.lastInsertRowid), reused: false };
  }

  function mutationReferencesRemovedData(
    value: unknown,
    folderIds: Set<number>,
    messageIds: Set<number>,
    key = '',
  ): boolean {
    if (Array.isArray(value)) {
      return value.some((item) =>
        mutationReferencesRemovedData(item, folderIds, messageIds, key));
    }
    if (value && typeof value === 'object') {
      return Object.entries(value).some(([childKey, childValue]) =>
        mutationReferencesRemovedData(childValue, folderIds, messageIds, childKey));
    }
    const id = Number(value);
    if (!Number.isFinite(id)) return false;
    if (/folder/i.test(key) && folderIds.has(id)) return true;
    if (/message/i.test(key) && messageIds.has(id)) return true;
    return false;
  }

  async function persistMessageRecordsInTx(
    tx: any,
    accountId: number,
    records: any[],
    ts: number,
  ) {
    const threadRemoteIds = [...new Set(
      records.map((message) => message.remoteThreadId).filter(Boolean),
    )];
    for (const remoteThreadId of threadRemoteIds) {
      await tx.run(
        `INSERT INTO threads(account_id, remote_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(account_id, remote_id) DO UPDATE SET
           updated_at = excluded.updated_at`,
        [accountId, remoteThreadId, ts],
      );
    }
    const threadRows = threadRemoteIds.length > 0
      ? await tx.all(
        `SELECT id, remote_id FROM threads
          WHERE account_id = ? AND remote_id IN (${placeholdersFor(threadRemoteIds)})`,
        [accountId, ...threadRemoteIds],
      )
      : [];
    const threadMap = new Map(threadRows.map((row) => [row.remote_id, row.id]));

    for (const message of records) {
      await tx.run(
        `INSERT INTO messages(
            account_id, remote_id, thread_id, remote_thread_id, blob_id,
            rfc822_message_id, in_reply_to_json, references_json,
            subject, preview, size, received_at, sent_at, has_attachment,
            keywords_json, is_seen, is_flagged, is_answered, is_draft,
            is_forwarded, is_junk, from_text, to_text, raw_json,
            stale, body_fetched_at, metadata_fetched_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, remote_id) DO UPDATE SET
            thread_id = excluded.thread_id,
            remote_thread_id = excluded.remote_thread_id,
            blob_id = excluded.blob_id,
            rfc822_message_id = excluded.rfc822_message_id,
            in_reply_to_json = excluded.in_reply_to_json,
            references_json = excluded.references_json,
            subject = excluded.subject,
            preview = excluded.preview,
            size = excluded.size,
            received_at = excluded.received_at,
            sent_at = excluded.sent_at,
            has_attachment = excluded.has_attachment,
            keywords_json = excluded.keywords_json,
            is_seen = excluded.is_seen,
            is_flagged = excluded.is_flagged,
            is_answered = excluded.is_answered,
            is_draft = excluded.is_draft,
            is_forwarded = excluded.is_forwarded,
            is_junk = excluded.is_junk,
            from_text = excluded.from_text,
            to_text = excluded.to_text,
            raw_json = excluded.raw_json,
            stale = excluded.stale,
            metadata_fetched_at = excluded.metadata_fetched_at,
            updated_at = excluded.updated_at`,
        [
          accountId,
          message.remoteId,
          threadMap.get(message.remoteThreadId) ?? null,
          message.remoteThreadId ?? null,
          message.blobId ?? null,
          message.rfc822MessageId ?? null,
          message.inReplyToJson ?? null,
          message.referencesJson ?? null,
          message.subject ?? null,
          message.preview ?? null,
          message.size ?? null,
          message.receivedAt ?? null,
          message.sentAt ?? null,
          message.hasAttachment ? 1 : 0,
          message.keywordsJson ?? '{}',
          message.isSeen ? 1 : 0,
          message.isFlagged ? 1 : 0,
          message.isAnswered ? 1 : 0,
          message.isDraft ? 1 : 0,
          message.isForwarded ? 1 : 0,
          message.isJunk ? 1 : 0,
          message.fromText ?? null,
          message.toText ?? null,
          message.rawJson ?? null,
          message.stale ? 1 : 0,
          message.bodyFetchedAt ?? null,
          message.metadataFetchedAt ?? ts,
          ts,
        ],
      );
    }

    if (records.length === 0) return;
    const recordRemoteIds = records.map((message) => message.remoteId);
    const messageRows = await tx.all(
      `SELECT id, remote_id FROM messages
        WHERE account_id = ? AND remote_id IN (${placeholdersFor(recordRemoteIds)})`,
      [accountId, ...recordRemoteIds],
    );
    const messageIdByRemote = new Map(
      messageRows.map((row) => [row.remote_id, row.id]),
    );
    const addressMessageIds = [];
    const addressRows = [];
    const keywordMessageIds = [];
    const keywordRows = [];
    const allMailboxIds = [...new Set(
      records.flatMap((message) => message.mailboxIds ?? []),
    )];
    const folderRows = allMailboxIds.length > 0
      ? await tx.all(
        `SELECT id, remote_id FROM folders
           WHERE account_id = ? AND remote_id IN (${placeholdersFor(allMailboxIds)})`,
        [accountId, ...allMailboxIds],
      )
      : [];
    const folderMap = new Map(folderRows.map((row) => [row.remote_id, row.id]));
    const membershipMessageIds = [];
    const membershipRows = [];

    for (const message of records) {
      const messageId = messageIdByRemote.get(message.remoteId);
      if (!messageId) continue;
      if (message.addresses) {
        addressMessageIds.push(messageId);
        for (const address of message.addresses) {
          addressRows.push([
            messageId,
            address.kind,
            address.position,
            address.name ?? null,
            address.email ?? null,
          ]);
        }
      }
      if (message.keywords) {
        keywordMessageIds.push(messageId);
        for (const keyword of message.keywords) {
          keywordRows.push([messageId, keyword]);
        }
      }
      const memberships = (message.mailboxIds ?? [])
        .map((mailboxId) => folderMap.get(mailboxId))
        .filter(Boolean);
      if (memberships.length > 0) {
        membershipMessageIds.push(messageId);
        for (const targetFolderId of memberships) {
          membershipRows.push([
            targetFolderId,
            messageId,
            accountId,
            null,
            null,
            message.receivedAt ?? null,
            message.sentAt ?? message.receivedAt ?? null,
            null,
          ]);
        }
      }
    }

    if (addressMessageIds.length > 0) {
      await tx.run(
        `DELETE FROM message_addresses
          WHERE message_id IN (${placeholdersFor(addressMessageIds)})`,
        addressMessageIds,
      );
      for (const params of addressRows) {
        await tx.run(
          `INSERT INTO message_addresses(message_id, kind, position, name, email)
           VALUES (?, ?, ?, ?, ?)`,
          params,
        );
      }
    }
    if (keywordMessageIds.length > 0) {
      await tx.run(
        `DELETE FROM message_keywords
          WHERE message_id IN (${placeholdersFor(keywordMessageIds)})`,
        keywordMessageIds,
      );
      for (const params of keywordRows) {
        await tx.run(
          `INSERT INTO message_keywords(message_id, keyword) VALUES (?, ?)`,
          params,
        );
      }
    }
    if (membershipMessageIds.length > 0) {
      const uniqueMembershipIds = numericUnique(membershipMessageIds);
      await tx.run(
        `DELETE FROM folder_messages
          WHERE message_id IN (${placeholdersFor(uniqueMembershipIds)})`,
        uniqueMembershipIds,
      );
      for (const params of membershipRows) {
        await tx.run(
          `INSERT INTO folder_messages(
              folder_id, message_id, account_id,
              remote_membership_id, added_at,
              sort_received_at, sort_sent_at, instance_state_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          params,
        );
      }
    }
  }

  async function applyQueryViewChangesInTx(
    tx: any,
    viewId: number,
    removed: string[],
    added: Array<{ id: string; index: number }>,
    ts: number,
  ) {
    if (removed.length > 0) {
      const removedRows = await tx.all(
        `SELECT position FROM query_view_items
          WHERE view_id = ? AND remote_id IN (${placeholdersFor(removed)})
          ORDER BY position DESC`,
        [viewId, ...removed],
      );
      await tx.run(
        `DELETE FROM query_view_items
          WHERE view_id = ? AND remote_id IN (${placeholdersFor(removed)})`,
        [viewId, ...removed],
      );
      await compactViewAfterDeletingPositions(
        tx,
        viewId,
        removedRows.map((row) => Number(row.position)),
        ts,
        { updateTotal: false },
      );
    }
    for (const entry of added) {
      const idx = Number(entry.index);
      const remoteId = entry.id;
      const existing = await tx.get(
        `SELECT position FROM query_view_items
          WHERE view_id = ? AND remote_id = ?`,
        [viewId, remoteId],
      );
      if (existing) {
        const oldPos = Number(existing.position);
        await tx.run(
          `DELETE FROM query_view_items
            WHERE view_id = ? AND remote_id = ?`,
          [viewId, remoteId],
        );
        await tx.run(
          `UPDATE query_view_items
              SET position = position - 1
            WHERE view_id = ? AND position > ?`,
          [viewId, oldPos],
        );
      }
      await tx.run(
        `UPDATE query_view_items
            SET position = -position - 1
          WHERE view_id = ? AND position >= ?`,
        [viewId, idx],
      );
      await tx.run(
        `INSERT INTO query_view_items(view_id, position, message_id, remote_id)
         VALUES (?, ?, NULL, ?)`,
        [viewId, idx, remoteId],
      );
      await tx.run(
        `UPDATE query_view_items
            SET position = -position
          WHERE view_id = ? AND position < 0`,
        [viewId],
      );
    }
  }

  async function applyFolderStars(folderIds: number[], isStarred: boolean) {
    const ids = numericUnique(folderIds);
    if (ids.length === 0) return batchResult(0);
    let applied = 0;
    await engine.transaction(async (tx) => {
      for (const folderId of ids) {
        const result = await tx.run(
          `UPDATE folders
              SET is_starred = ?
            WHERE id = ?
              AND (? = 0 OR is_subscribed IS NULL OR is_subscribed != 0)`,
          [isStarred ? 1 : 0, folderId, isStarred ? 1 : 0],
        );
        applied += result.changes ?? 0;
      }
    });
    broadcaster.touch(TABLE_FAMILIES.FOLDERS);
    return batchResult(applied);
  }

  async function applyFolderSubscriptions(
    updates: Array<{ folderId: number; isSubscribed: boolean }>,
  ) {
    if (updates.length === 0) return batchResult(0);
    let applied = 0;
    const ts = now();
    await engine.transaction(async (tx) => {
      for (const update of updates) {
        const result = await tx.run(
          `UPDATE folders
              SET is_subscribed = ?,
                  is_starred = CASE WHEN ? = 0 THEN 0 ELSE is_starred END,
                  updated_at = ?
            WHERE id = ?`,
          [
            update.isSubscribed ? 1 : 0,
            update.isSubscribed ? 1 : 0,
            ts,
            update.folderId,
          ],
        );
        applied += result.changes ?? 0;
      }
    });
    broadcaster.touch(TABLE_FAMILIES.FOLDERS);
    return batchResult(applied);
  }

  async function applyFolderCreates(creates: any[]) {
    if (creates.length === 0) return { applied: 0, folderIds: {} };
    const ts = now();
    const folderIds: Record<string, number | null> = {};
    await engine.transaction(async (tx) => {
      for (const create of creates) {
        await tx.run(
          `INSERT INTO folders(
              account_id, remote_id, parent_id, name, role, sort_order,
              total_emails, unread_emails, rights_json, raw_json,
              is_subscribed, is_deleted, updated_at
           ) VALUES (?, ?, ?, ?, NULL, ?, 0, 0, ?, ?, 1, 0, ?)
           ON CONFLICT(account_id, remote_id) DO UPDATE SET
              parent_id = excluded.parent_id,
              name = excluded.name,
              rights_json = COALESCE(excluded.rights_json, rights_json),
              raw_json = COALESCE(excluded.raw_json, raw_json),
              is_subscribed = 1,
              is_deleted = 0,
              updated_at = excluded.updated_at`,
          [
            create.accountId,
            create.remoteId,
            create.parentFolderId ?? null,
            create.name,
            create.sortOrder ?? 0,
            create.rightsJson ?? null,
            create.rawJson ?? null,
            ts,
          ],
        );
        const row = await tx.get(
          `SELECT id FROM folders WHERE account_id = ? AND remote_id = ?`,
          [create.accountId, create.remoteId],
        );
        folderIds[String(create.clientId)] = row?.id ?? null;
      }
    });
    broadcaster.touch(TABLE_FAMILIES.FOLDERS);
    return { applied: creates.length, folderIds };
  }

  async function applyFolderUpdates(updates: any[]) {
    if (updates.length === 0) return batchResult(0);
    let applied = 0;
    const ts = now();
    await engine.transaction(async (tx) => {
      for (const update of updates) {
        const sets = ['updated_at = ?'];
        const params: any[] = [ts];
        if (update.name != null) {
          sets.push('name = ?');
          params.push(update.name);
        }
        if (update.parentProvided) {
          sets.push('parent_id = ?');
          params.push(update.parentFolderId ?? null);
        }
        const result = await tx.run(
          `UPDATE folders SET ${sets.join(', ')} WHERE id = ?`,
          [...params, update.folderId],
        );
        applied += result.changes ?? 0;
      }
    });
    broadcaster.touch(TABLE_FAMILIES.FOLDERS);
    return batchResult(applied);
  }

  async function applyFolderDestroys(destroys: any[]) {
    if (destroys.length === 0) return batchResult(0, { destroyedMessageIds: [] });
    const ts = now();
    const candidatesByAccount = new Map<number, Map<number, string>>();
    const destroyedMessageIds: number[] = [];
    await engine.transaction(async (tx) => {
      for (const destroy of destroys) {
        const folder = await tx.get(
          `SELECT id, account_id FROM folders WHERE id = ? AND account_id = ?`,
          [destroy.folderId, destroy.accountId],
        );
        if (!folder) continue;
        if (destroy.onDestroyRemoveEmails) {
          const linked = await tx.all(
            `SELECT m.id, m.remote_id
               FROM folder_messages fm
               JOIN messages m ON m.id = fm.message_id
              WHERE fm.folder_id = ? AND m.account_id = ?`,
            [destroy.folderId, destroy.accountId],
          );
          const candidates = candidatesByAccount.get(destroy.accountId) ?? new Map();
          for (const message of linked) {
            candidates.set(Number(message.id), String(message.remote_id));
          }
          candidatesByAccount.set(destroy.accountId, candidates);
        }
        await tx.run(`DELETE FROM folder_messages WHERE folder_id = ?`, [destroy.folderId]);
        await tx.run(`DELETE FROM query_views WHERE folder_id = ?`, [destroy.folderId]);
        await tx.run(
          `UPDATE folders SET is_deleted = 1, updated_at = ? WHERE id = ?`,
          [ts, destroy.folderId],
        );
      }
      for (const [accountId, candidates] of candidatesByAccount) {
        const orphanRemoteIds: string[] = [];
        for (const [messageId, remoteId] of candidates) {
          const remaining = await tx.get(
            `SELECT 1 FROM folder_messages WHERE message_id = ? LIMIT 1`,
            [messageId],
          );
          if (!remaining) {
            orphanRemoteIds.push(remoteId);
            destroyedMessageIds.push(messageId);
          }
        }
        await destroyMessagesByRemoteIdsInTransaction(tx, accountId, orphanRemoteIds, ts);
      }
    });
    broadcaster.touch(TABLE_FAMILIES.FOLDERS);
    broadcaster.touch(TABLE_FAMILIES.MESSAGES);
    return batchResult(destroys.length, { destroyedMessageIds });
  }

  /** @type {Record<string, (params: any) => Promise<any>>} */
  const h = {
    [DB_RPC.HEALTHCHECK]: async () => ({ ok: true, time: now() }),

    [DB_RPC.EXEC]: async ({ sql }) => {
      await engine.exec(sql);
    },

    [DB_RPC.QUERY]: async ({ sql, params }) => engine.all(sql, params ?? []),

    [DB_RPC.TRANSACTION]: async ({ statements }) =>
      engine.transaction(async (tx) => {
        const out = [];
        for (const { sql, params } of statements) {
          out.push(await tx.run(sql, params ?? []));
        }
        return out;
      }),

    [DB_RPC.ACCOUNT_LIST]: async () =>
      engine.all(
        `SELECT * FROM accounts ORDER BY is_primary DESC, COALESCE(display_name, primary_email, server_origin)`,
      ),

    [DB_RPC.ACCOUNT_GET_BY_REMOTE]: async ({ serverOrigin, remoteAccountId }) =>
      engine.get(
        `SELECT * FROM accounts WHERE server_origin = ? AND remote_account_id = ?`,
        [serverOrigin, remoteAccountId],
      ),

    [DB_RPC.ACCOUNT_GET]: async ({ accountId }) =>
      engine.get(`SELECT * FROM accounts WHERE id = ?`, [accountId]),

    [DB_RPC.ACCOUNT_RECONCILE_SESSION]: async ({
      serverOrigin,
      remoteAccountIds = [],
    }) => {
      const remoteIds = [...new Set(
        (Array.isArray(remoteAccountIds) ? remoteAccountIds : []).filter(Boolean),
      )];
      if (!serverOrigin || remoteIds.length === 0) {
        throw new Error('account.reconcileSession requires origin and Session accounts');
      }
      const staleAccounts = await engine.all(
        `SELECT id FROM accounts
          WHERE server_origin = ? AND is_primary = 0
            AND remote_account_id NOT IN (${placeholdersFor(remoteIds)})`,
        [serverOrigin, ...remoteIds],
      );
      const staleAccountIds = numericUnique(staleAccounts.map((row) => row.id));
      if (staleAccountIds.length === 0) return batchResult(0);

      const result = await engine.transaction(async (tx) => {
        const folderRows = await tx.all(
          `SELECT id FROM folders
            WHERE account_id IN (${placeholdersFor(staleAccountIds)})`,
          staleAccountIds,
        );
        const messageRows = await tx.all(
          `SELECT id FROM messages
            WHERE account_id IN (${placeholdersFor(staleAccountIds)})`,
          staleAccountIds,
        );
        const folderIds = new Set<number>(folderRows.map((row) => Number(row.id)));
        const messageIds = new Set<number>(messageRows.map((row) => Number(row.id)));
        const mutations = await tx.all(
          `SELECT id, request_json FROM pending_mutations
            WHERE local_status IN ('pending','retry','in_flight')`,
        );
        const ts = now();
        for (const mutation of mutations) {
          let request;
          try {
            request = JSON.parse(mutation.request_json);
          } catch {
            continue;
          }
          if (!mutationReferencesRemovedData(request, folderIds, messageIds)) continue;
          await tx.run(
            `UPDATE pending_mutations
                SET local_status = 'conflicted',
                    error_json = ?,
                    updated_at = ?
              WHERE id = ?`,
            [
              JSON.stringify({
                type: 'accountUnavailable',
                terminal: true,
              }),
              ts,
              mutation.id,
            ],
          );
        }
        const deleted = await tx.run(
          `DELETE FROM accounts
            WHERE id IN (${placeholdersFor(staleAccountIds)})`,
          staleAccountIds,
        );
        return deleted.changes ?? 0;
      });
      broadcaster.touch(TABLE_FAMILIES.ACCOUNTS);
      broadcaster.touch(TABLE_FAMILIES.FOLDERS);
      broadcaster.touch(TABLE_FAMILIES.MESSAGES);
      broadcaster.touch(TABLE_FAMILIES.SYNC);
      return batchResult(result);
    },

    [DB_RPC.ACCOUNT_QUOTA_UPSERT]: async ({ accountId, usedBytes, hardLimitBytes }) => {
      const ts = now();
      await engine.run(
        `UPDATE accounts
         SET quota_used_bytes = ?,
             quota_hard_limit_bytes = ?,
             quota_updated_at = ?,
             updated_at = ?
         WHERE id = ?`,
        [usedBytes, hardLimitBytes, ts, ts, accountId],
      );
      broadcaster.touch(TABLE_FAMILIES.ACCOUNTS);
      return { ok: true };
    },

    [DB_RPC.ACCOUNT_UPSERT]: async (input) => {
      const ts = now();
      const result = await engine.run(
        `INSERT INTO accounts(
            display_name, primary_email, server_origin, remote_account_id,
            server_kind, is_primary, is_personal, created_at, updated_at, last_opened_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(server_origin, remote_account_id) DO UPDATE SET
            display_name = excluded.display_name,
            primary_email = excluded.primary_email,
            server_kind = excluded.server_kind,
            is_primary = excluded.is_primary,
            is_personal = excluded.is_personal,
            updated_at = excluded.updated_at,
            last_opened_at = COALESCE(excluded.last_opened_at, last_opened_at)`,
        [
          input.displayName ?? null,
          input.primaryEmail ?? null,
          input.serverOrigin,
          input.remoteAccountId,
          input.serverKind ?? null,
          input.isPrimary ? 1 : 0,
          input.isPersonal === false ? 0 : 1,
          input.createdAt ?? ts,
          ts,
          input.lastOpenedAt ?? null,
        ],
      );
      broadcaster.touch(TABLE_FAMILIES.ACCOUNTS);
      const row = await engine.get(
        `SELECT * FROM accounts WHERE server_origin = ? AND remote_account_id = ?`,
        [input.serverOrigin, input.remoteAccountId],
      );
      return { row, changes: result.changes };
    },

    [DB_RPC.ACCOUNT_SERVICE_UPSERT]: async (input) => {
      const ts = now();
      await engine.run(
        `INSERT INTO account_services(
            account_id, service_kind, base_url, api_url,
            download_url_template, upload_url_template,
            websocket_url, supports_websocket_push,
            session_state, push_state, config_json, last_sync_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, service_kind) DO UPDATE SET
            base_url = excluded.base_url,
            api_url = excluded.api_url,
            download_url_template = excluded.download_url_template,
            upload_url_template = excluded.upload_url_template,
            websocket_url = excluded.websocket_url,
            supports_websocket_push = excluded.supports_websocket_push,
            session_state = COALESCE(excluded.session_state, session_state),
            push_state = COALESCE(excluded.push_state, push_state),
            config_json = excluded.config_json,
            last_sync_at = COALESCE(excluded.last_sync_at, last_sync_at),
            updated_at = excluded.updated_at`,
        [
          input.accountId,
          input.serviceKind,
          input.baseUrl ?? null,
          input.apiUrl ?? null,
          input.downloadUrlTemplate ?? null,
          input.uploadUrlTemplate ?? null,
          input.websocketUrl ?? null,
          input.supportsWebsocketPush ? 1 : 0,
          input.sessionState ?? null,
          input.pushState ?? null,
          input.configJson ?? null,
          input.lastSyncAt ?? null,
          ts,
        ],
      );
      broadcaster.touch(TABLE_FAMILIES.ACCOUNTS);
    },

    [DB_RPC.ACCOUNT_CAPABILITIES_REPLACE]: async ({ accountId, serviceKind, capabilities }) => {
      await engine.transaction(async (tx) => {
        await tx.run(
          `DELETE FROM account_capabilities WHERE account_id = ? AND service_kind = ?`,
          [accountId, serviceKind],
        );
        for (const [capability, payload] of Object.entries(capabilities ?? {})) {
          await tx.run(
            `INSERT INTO account_capabilities(account_id, service_kind, capability, payload_json)
             VALUES (?, ?, ?, ?)`,
            [accountId, serviceKind, capability, JSON.stringify(payload ?? {})],
          );
        }
      });
      broadcaster.touch(TABLE_FAMILIES.ACCOUNTS);
    },

    [DB_RPC.ACCOUNT_CAPABILITIES_GET]: async ({ accountId, serviceKind }) => {
      const rows = await engine.all(
        `SELECT capability, payload_json
           FROM account_capabilities
          WHERE account_id = ? AND service_kind = ?`,
        [accountId, serviceKind],
      );
      const capabilities: Record<string, unknown> = {};
      for (const row of rows) {
        try {
          capabilities[row.capability] = JSON.parse(row.payload_json);
        } catch {
          capabilities[row.capability] = null;
        }
      }
      return capabilities;
    },

    [DB_RPC.FOLDER_LIST]: async ({ accountId, includeDeleted = false }) =>
      engine.all(
        `SELECT * FROM folders
          WHERE account_id = ? AND (? OR is_deleted = 0)
          ORDER BY parent_id IS NULL DESC, parent_id, sort_order, name COLLATE NOCASE`,
        [accountId, includeDeleted ? 1 : 0],
      ),

    [DB_RPC.FOLDER_BY_ROLE]: async ({ accountId, role }) =>
      engine.get(
        `SELECT * FROM folders WHERE account_id = ? AND role = ? AND is_deleted = 0`,
        [accountId, role],
      ),

    /**
     * Client-local star flag (priority pin in the sidebar). Purely a
     * UI preference: no outbox mutation, nothing goes to the server,
     * and folder sync never writes this column so it survives
     * FOLDER_UPSERT_MANY refreshes.
     */
    [DB_RPC.FOLDER_SET_STARRED]: async ({ folderId, isStarred }) =>
      applyFolderStars([folderId], isStarred),

    [DB_RPC.FOLDER_SET_STARRED_MANY]: async ({ folderIds = [], isStarred }) =>
      applyFolderStars(folderIds, isStarred),

    [DB_RPC.FOLDER_UPSERT_MANY]: async ({ accountId, folders }) => {
      if (!folders?.length) {
        return { upserted: 0 };
      }
      const ts = now();
      let upserted = 0;
      await engine.transaction(async (tx) => {
        for (const f of folders) {
          await tx.run(
            `INSERT INTO folders(
                account_id, remote_id, parent_id, name, role, sort_order,
                total_emails, unread_emails, total_threads, unread_threads,
                may_read_items, may_add_items, may_remove_items,
                rights_json, raw_json, is_subscribed, is_deleted, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(account_id, remote_id) DO UPDATE SET
                parent_id = excluded.parent_id,
                name = excluded.name,
                role = excluded.role,
                sort_order = excluded.sort_order,
                total_emails = excluded.total_emails,
                unread_emails = excluded.unread_emails,
                total_threads = excluded.total_threads,
                unread_threads = excluded.unread_threads,
                may_read_items = excluded.may_read_items,
                may_add_items = excluded.may_add_items,
                may_remove_items = excluded.may_remove_items,
                rights_json = excluded.rights_json,
                raw_json = excluded.raw_json,
                is_subscribed = COALESCE(excluded.is_subscribed, is_subscribed),
                is_deleted = excluded.is_deleted,
                updated_at = excluded.updated_at`,
            [
              accountId,
              f.remoteId,
              f.parentId ?? null,
              f.name,
              f.role ?? null,
              f.sortOrder ?? 0,
              f.totalEmails ?? null,
              f.unreadEmails ?? null,
              f.totalThreads ?? null,
              f.unreadThreads ?? null,
              f.mayReadItems == null ? null : (f.mayReadItems ? 1 : 0),
              f.mayAddItems == null ? null : (f.mayAddItems ? 1 : 0),
              f.mayRemoveItems == null ? null : (f.mayRemoveItems ? 1 : 0),
              f.rightsJson ?? null,
              f.rawJson ?? null,
              f.isSubscribed == null ? null : (f.isSubscribed ? 1 : 0),
              f.isDeleted ? 1 : 0,
              ts,
            ],
          );
          upserted += 1;
        }
      });
      broadcaster.touch(TABLE_FAMILIES.FOLDERS);
      return { upserted };
    },

    [DB_RPC.FOLDER_UPDATE_COUNTS_MANY]: async ({ accountId, folders = [] }) => {
      const items = Array.isArray(folders)
        ? folders.filter((folder) => folder?.remoteId)
        : [];
      if (items.length === 0) return batchResult(0);
      const ts = now();
      let applied = 0;
      await engine.transaction(async (tx) => {
        for (const folder of items) {
          const result = await tx.run(
            `UPDATE folders
                SET total_emails = ?,
                    unread_emails = ?,
                    total_threads = ?,
                    unread_threads = ?,
                    updated_at = ?
              WHERE account_id = ? AND remote_id = ? AND is_deleted = 0`,
            [
              folder.totalEmails ?? null,
              folder.unreadEmails ?? null,
              folder.totalThreads ?? null,
              folder.unreadThreads ?? null,
              ts,
              accountId,
              folder.remoteId,
            ],
          );
          applied += result.changes ?? 0;
        }
      });
      if (applied > 0) broadcaster.touch(TABLE_FAMILIES.FOLDERS);
      return batchResult(applied);
    },

    [DB_RPC.IDENTITY_LIST]: async ({ accountId }) => {
      const rows = await engine.all(
        `SELECT * FROM identities WHERE account_id = ? ORDER BY name COLLATE NOCASE, email COLLATE NOCASE`,
        [accountId],
      );
      return rows.map(identityRowFromDatabase);
    },

    [DB_RPC.IDENTITY_GET_BY_REMOTE]: async ({ accountId, remoteId }) => {
      const row = await engine.get(
        `SELECT * FROM identities WHERE account_id = ? AND remote_id = ?`,
        [accountId, remoteId],
      );
      return identityRowFromDatabase(row);
    },

    /**
     * @param {object} args
     * @param {boolean} [args.snapshot] the list is everything this account
     *   has: an identity missing from it has been removed server-side and
     *   goes here too (CS-4.5). Upsert-only left a deleted alias in the From
     *   picker for the life of the account, where choosing it means sending
     *   as an address the server will reject. An empty snapshot is a real
     *   answer — an account whose last identity was removed — so unlike an
     *   upsert it is not treated as nothing to do.
     */
    [DB_RPC.IDENTITY_UPSERT_MANY]: async ({ accountId, identities, snapshot = false }) => {
      if (!identities?.length && !snapshot) {
        return { upserted: 0 };
      }
      const ts = now();
      let removed = 0;
      await engine.transaction(async (tx) => {
        for (const id of identities ?? []) {
          const replyToJson = hasOwn(id, 'replyTo')
            ? (id.replyTo === null ? null : JSON.stringify(id.replyTo))
            : id.replyToJson ?? null;
          const bccJson = hasOwn(id, 'bcc')
            ? (id.bcc === null ? null : JSON.stringify(id.bcc))
            : id.bccJson ?? null;
          const mayDelete = hasOwn(id, 'mayDelete')
            ? (typeof id.mayDelete === 'boolean' ? Number(id.mayDelete) : null)
            : id.mayDeleteValue ?? null;
          await tx.run(
            `INSERT INTO identities(
                account_id, remote_id, name, email, reply_to_json, bcc_json,
                text_signature, html_signature, may_delete, raw_json, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(account_id, remote_id) DO UPDATE SET
                name = excluded.name,
                email = excluded.email,
                reply_to_json = excluded.reply_to_json,
                bcc_json = excluded.bcc_json,
                text_signature = excluded.text_signature,
                html_signature = excluded.html_signature,
                may_delete = excluded.may_delete,
                raw_json = excluded.raw_json,
                updated_at = excluded.updated_at`,
            [
              accountId,
              id.remoteId,
              typeof id.name === 'string' ? id.name : '',
              id.email,
              replyToJson,
              bccJson,
              id.textSignature ?? null,
              id.htmlSignature ?? null,
              mayDelete,
              id.rawJson ?? null,
              ts,
            ],
          );
        }
        if (!snapshot) return;
        const kept = (identities ?? []).map((id) => id.remoteId);
        const placeholders = kept.map(() => '?').join(',');
        // A hard delete, unlike contacts: an identity has no local edits to
        // preserve and nothing references the row, so a tombstone would only
        // be a row every query has to remember to exclude.
        const result = await tx.run(
          `DELETE FROM identities
            WHERE account_id = ?
              ${kept.length > 0 ? `AND remote_id NOT IN (${placeholders})` : ''}`,
          [accountId, ...kept],
        );
        removed = result?.changes ?? 0;
      });
      broadcaster.touch(TABLE_FAMILIES.IDENTITIES);
      return { upserted: identities?.length ?? 0, removed };
    },

    [DB_RPC.IDENTITY_DELETE_LOCAL]: async ({ accountId, remoteId }) => {
      const result = await engine.run(
        `DELETE FROM identities WHERE account_id = ? AND remote_id = ?`,
        [accountId, remoteId],
      );
      if ((result.changes ?? 0) > 0) {
        broadcaster.touch(TABLE_FAMILIES.IDENTITIES);
      }
      return { removed: result.changes ?? 0 };
    },

    [DB_RPC.THREAD_UPSERT_MANY]: async ({ accountId, threads }) => {
      if (!threads?.length) {
        return { upserted: 0 };
      }
      const ts = now();
      await engine.transaction(async (tx) => {
        for (const t of threads) {
          await tx.run(
            `INSERT INTO threads(
                account_id, remote_id, email_ids_json,
                latest_received_at, latest_sent_at,
                message_count, unread_count, raw_json, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(account_id, remote_id) DO UPDATE SET
                email_ids_json = excluded.email_ids_json,
                latest_received_at = excluded.latest_received_at,
                latest_sent_at = excluded.latest_sent_at,
                message_count = excluded.message_count,
                unread_count = excluded.unread_count,
                raw_json = excluded.raw_json,
                updated_at = excluded.updated_at`,
            [
              accountId,
              t.remoteId,
              t.emailIdsJson ?? null,
              t.latestReceivedAt ?? null,
              t.latestSentAt ?? null,
              t.messageCount ?? null,
              t.unreadCount ?? null,
              t.rawJson ?? null,
              ts,
            ],
          );
        }
      });
      broadcaster.touch(TABLE_FAMILIES.THREADS);
      return { upserted: threads.length };
    },

    [DB_RPC.MESSAGE_UPSERT_MANY]: async ({ accountId, messages }) => {
      if (!messages?.length) {
        return { upserted: 0 };
      }
      const ts = now();
      await engine.transaction(async (tx) => {
        for (const m of messages) {
          await tx.run(
            `INSERT INTO messages(
                account_id, remote_id, thread_id, remote_thread_id, blob_id,
                rfc822_message_id, in_reply_to_json, references_json,
                subject, preview, size, received_at, sent_at, has_attachment,
                keywords_json, is_seen, is_flagged, is_answered, is_draft,
                is_forwarded, is_junk, from_text, to_text, raw_json,
                stale, body_fetched_at, metadata_fetched_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(account_id, remote_id) DO UPDATE SET
                thread_id = excluded.thread_id,
                remote_thread_id = excluded.remote_thread_id,
                blob_id = excluded.blob_id,
                rfc822_message_id = excluded.rfc822_message_id,
                in_reply_to_json = excluded.in_reply_to_json,
                references_json = excluded.references_json,
                subject = excluded.subject,
                preview = excluded.preview,
                size = excluded.size,
                received_at = excluded.received_at,
                sent_at = excluded.sent_at,
                has_attachment = excluded.has_attachment,
                keywords_json = excluded.keywords_json,
                is_seen = excluded.is_seen,
                is_flagged = excluded.is_flagged,
                is_answered = excluded.is_answered,
                is_draft = excluded.is_draft,
                is_forwarded = excluded.is_forwarded,
                is_junk = excluded.is_junk,
                from_text = excluded.from_text,
                to_text = excluded.to_text,
                raw_json = excluded.raw_json,
                stale = excluded.stale,
                metadata_fetched_at = excluded.metadata_fetched_at,
                updated_at = excluded.updated_at`,
            [
              accountId,
              m.remoteId,
              m.threadId ?? null,
              m.remoteThreadId ?? null,
              m.blobId ?? null,
              m.rfc822MessageId ?? null,
              m.inReplyToJson ?? null,
              m.referencesJson ?? null,
              m.subject ?? null,
              m.preview ?? null,
              m.size ?? null,
              m.receivedAt ?? null,
              m.sentAt ?? null,
              m.hasAttachment ? 1 : 0,
              m.keywordsJson ?? '{}',
              m.isSeen ? 1 : 0,
              m.isFlagged ? 1 : 0,
              m.isAnswered ? 1 : 0,
              m.isDraft ? 1 : 0,
              m.isForwarded ? 1 : 0,
              m.isJunk ? 1 : 0,
              m.fromText ?? null,
              m.toText ?? null,
              m.rawJson ?? null,
              m.stale ? 1 : 0,
              m.bodyFetchedAt ?? null,
              m.metadataFetchedAt ?? ts,
              ts,
            ],
          );
        }

        const remoteIds = messages.map((m) => m.remoteId).filter(Boolean);
        const placeholders = remoteIds.map(() => '?').join(',');
        const rows = placeholders
          ? await tx.all(
            `SELECT id, remote_id FROM messages
              WHERE account_id = ? AND remote_id IN (${placeholders})`,
            [accountId, ...remoteIds],
          )
          : [];
        const messageIdByRemote = new Map(rows.map((row) => [row.remote_id, row.id]));

        const addressMessageIds = [];
        const addressRows = [];
        const keywordMessageIds = [];
        const keywordRows = [];
        for (const m of messages) {
          const messageId = messageIdByRemote.get(m.remoteId);
          if (!messageId) continue;
          if (m.addresses) {
            addressMessageIds.push(messageId);
            for (const addr of m.addresses) {
              addressRows.push([messageId, addr.kind, addr.position, addr.name ?? null, addr.email ?? null]);
            }
          }
          if (m.keywords) {
            keywordMessageIds.push(messageId);
            for (const keyword of m.keywords) {
              keywordRows.push([messageId, keyword]);
            }
          }
        }

        if (addressMessageIds.length > 0) {
          const deletePlaceholders = addressMessageIds.map(() => '?').join(',');
          await tx.run(
            `DELETE FROM message_addresses WHERE message_id IN (${deletePlaceholders})`,
            addressMessageIds,
          );
          for (const params of addressRows) {
            await tx.run(
              `INSERT INTO message_addresses(message_id, kind, position, name, email)
               VALUES (?, ?, ?, ?, ?)`,
              params,
            );
          }
        }

        if (keywordMessageIds.length > 0) {
          const deletePlaceholders = keywordMessageIds.map(() => '?').join(',');
          await tx.run(
            `DELETE FROM message_keywords WHERE message_id IN (${deletePlaceholders})`,
            keywordMessageIds,
          );
          for (const params of keywordRows) {
            await tx.run(
              `INSERT INTO message_keywords(message_id, keyword) VALUES (?, ?)`,
              params,
            );
          }
        }
      });
      broadcaster.touch(TABLE_FAMILIES.MESSAGES);
      return { upserted: messages.length };
    },

    [DB_RPC.FOLDER_WINDOW_PERSIST_BATCH]: async ({
      accountId,
      folderId,
      folderRemoteId,
      sortProp = 'receivedAt',
      sortAscending = false,
      collapseThreads = false,
      queryState = null,
      canCalculateChanges = null,
      total = null,
      position = 0,
      ids = [],
      messages = [],
    }) => {
      const safeFolderId = Number(folderId);
      if (!Number.isFinite(safeFolderId)) {
        throw new Error('folderWindow.persistBatch requires a numeric folderId');
      }
      const safePosition = Number(position);
      const remoteIds = Array.isArray(ids) ? ids.filter(Boolean) : [];
      const records = Array.isArray(messages) ? messages.filter((m) => m?.remoteId) : [];
      const ts = now();
      let viewId = null;

      await engine.transaction(async (tx) => {
        const filterJson = JSON.stringify({ inMailbox: folderRemoteId });
        const sortJson = JSON.stringify([{ property: sortProp, isAscending: !!sortAscending }]);
        await tx.run(
          `INSERT INTO query_views(
              account_id, view_type, folder_id, filter_json, sort_json,
              collapse_threads, query_state, can_calculate_changes, total, stale,
              created_at, updated_at, last_accessed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(account_id, view_type, folder_id, filter_json, sort_json, collapse_threads)
            DO UPDATE SET
              query_state = excluded.query_state,
              can_calculate_changes = excluded.can_calculate_changes,
              total = excluded.total,
              stale = excluded.stale,
              updated_at = excluded.updated_at,
              last_accessed_at = excluded.last_accessed_at`,
          [
            accountId,
            'mailbox-window',
            safeFolderId,
            filterJson,
            sortJson,
            collapseThreads ? 1 : 0,
            queryState,
            canCalculateChanges == null ? null : (canCalculateChanges ? 1 : 0),
            total,
            0,
            ts,
            ts,
            ts,
          ],
        );
        const viewRow = await tx.get(
          `SELECT id FROM query_views
             WHERE account_id = ? AND view_type = ? AND folder_id = ?
               AND filter_json = ? AND sort_json = ? AND collapse_threads = ?`,
          [accountId, 'mailbox-window', safeFolderId, filterJson, sortJson, collapseThreads ? 1 : 0],
        );
        viewId = Number(viewRow?.id);
        if (!Number.isFinite(viewId)) {
          throw new Error('folderWindow.persistBatch failed to resolve query view id');
        }

        if (remoteIds.length > 0) {
          await tx.run(
            `DELETE FROM query_view_items
              WHERE view_id = ? AND position >= ? AND position < ?`,
            [viewId, safePosition, safePosition + remoteIds.length],
          );
          await tx.run(
            `DELETE FROM query_view_items
              WHERE view_id = ? AND remote_id IN (${placeholdersFor(remoteIds)})`,
            [viewId, ...remoteIds],
          );
          for (let i = 0; i < remoteIds.length; i += 1) {
            await tx.run(
              `INSERT INTO query_view_items(view_id, position, message_id, remote_id)
               VALUES (?, ?, NULL, ?)`,
              [viewId, safePosition + i, remoteIds[i]],
            );
          }
          await tx.run(
            `INSERT INTO query_view_ranges(view_id, start_position, end_position, fetched_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(view_id, start_position, end_position) DO NOTHING`,
            [viewId, safePosition, safePosition + remoteIds.length, ts],
          );
        }

        await persistMessageRecordsInTx(tx, accountId, records, ts);
      });
      broadcaster.touch(TABLE_FAMILIES.THREADS);
      broadcaster.touch(TABLE_FAMILIES.FOLDERS);
      broadcaster.touch(TABLE_FAMILIES.MESSAGES);
      return batchResult(records.length, { viewId });
    },

    [DB_RPC.MESSAGE_LIST_FOR_FOLDER]: async ({ folderId, sort = 'received', limit = 100, offset = 0 }) => {
      const sortColumn = sort === 'sent' ? 'sort_sent_at' : 'sort_received_at';
      return engine.all(
        `SELECT m.*, fm.${sortColumn} AS sort_key
           FROM folder_messages fm
           JOIN messages m ON m.id = fm.message_id
          WHERE fm.folder_id = ?
          ORDER BY fm.${sortColumn} DESC, fm.message_id DESC
          LIMIT ? OFFSET ?`,
        [folderId, limit, offset],
      );
    },

    /**
     * Positional read out of a stored Email/query result. Unlike
     * MESSAGE_LIST_FOR_FOLDER (which uses SQL OFFSET over folder_messages
     * and only works when the cache is dense from position 0), this
     * reads the JMAP "position" column out of query_view_items. That
     * means it correctly returns rows at offset=1500 in a 3000-message
     * folder even when only a few hundred rows are cached locally,
     * because the rows we have for that page are keyed by their actual
     * position in the server-side query result.
     *
     * The handler reproduces the JSON strings that
     * sync/backends/jmap/messages.js#upsertQueryView writes when it
     * inserts the matching query_views row, so the lookup can use the
     * UNIQUE(account_id, view_type, folder_id, filter_json, sort_json,
     * collapse_threads) constraint as an index probe.
     */
    [DB_RPC.MESSAGE_LIST_FOR_VIEW]: async ({
      accountId, folderId, sort = 'received', offset = 0, limit = 100,
    }) => {
      const view = await loadMailboxQueryView(engine, { accountId, folderId, sort });
      if (!view) return [];
      return engine.all(
        `SELECT m.*, qi.position AS view_position
           FROM query_view_items qi
           JOIN messages m
             ON m.account_id = ?
            AND m.remote_id = qi.remote_id
          WHERE qi.view_id = ?
            AND qi.position >= ?
            AND qi.position < ?
          ORDER BY qi.position`,
        [accountId, view.id, offset, offset + limit],
      );
    },

    /**
     * Diagnostic snapshot comparing the canonical mailbox-window query
     * view against folder_messages membership for the same folder. The
     * mail-store calls this on folder open to detect drift between the
     * two projections; if membership shows more rows than the query
     * view's claimed total, the store treats the local query view as
     * stale and rebuilds it through resetViewForFolder + the JMAP
     * ensureFolderWindow path. This handler must NOT be used to render
     * messages; that always goes through MESSAGE_LIST_FOR_VIEW so the
     * UI's All-mail count and Unread filter stay derived from one
     * source.
     */
    [DB_RPC.FOLDER_VIEW_CONSISTENCY]: async ({ accountId, folderId, sort = 'received' }) => {
      const view = await loadMailboxQueryView(engine, { accountId, folderId, sort });
      let queryViewTotal = 0;
      let queryViewCovered = 0;
      let queryViewMaterialized = 0;
      let queryViewStale = false;
      if (view) {
        queryViewTotal = Number(view.total ?? 0);
        queryViewStale = Number(view.stale ?? 0) === 1;
        const ranges = await engine.all(
          `SELECT start_position, end_position
             FROM query_view_ranges
            WHERE view_id = ?
            ORDER BY start_position, end_position`,
          [view.id],
        );
        queryViewCovered = mergeRangeCoverage(ranges, queryViewTotal);
        const materializedRow = await engine.get(
          `SELECT COUNT(*) AS materialized
             FROM query_view_items qi
             JOIN messages m
               ON m.account_id = ?
              AND m.remote_id = qi.remote_id
            WHERE qi.view_id = ?`,
          [accountId, view.id],
        );
        queryViewMaterialized = Number(materializedRow?.materialized ?? 0);
      }
      const membershipRow = await engine.get(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN m.is_seen = 0 THEN 1 ELSE 0 END) AS unread
           FROM folder_messages fm
           JOIN messages m
             ON m.id = fm.message_id
            AND m.account_id = ?
          WHERE fm.account_id = ?
            AND fm.folder_id = ?`,
        [accountId, accountId, folderId],
      );
      return {
        queryViewExists: !!view,
        queryViewTotal,
        queryViewCovered,
        queryViewMaterialized,
        queryViewStale,
        membershipTotal: Number(membershipRow?.total ?? 0),
        membershipUnread: Number(membershipRow?.unread ?? 0),
      };
    },

    [DB_RPC.QUERY_VIEW_PROGRESS]: async ({ accountId, folderId, sort = 'received' }) => {
      const view = await loadMailboxQueryView(engine, { accountId, folderId, sort });
      if (!view) {
        const folder = await engine.get(
          `SELECT total_emails FROM folders WHERE account_id = ? AND id = ?`,
          [accountId, folderId],
        );
        return {
          total: Number(folder?.total_emails ?? 0),
          covered: 0,
          percent: 0,
        };
      }
      const ranges = await engine.all(
        `SELECT start_position, end_position
           FROM query_view_ranges
          WHERE view_id = ?
          ORDER BY start_position, end_position`,
        [view.id],
      );
      const total = Number(view.total ?? 0);
      const covered = mergeRangeCoverage(ranges, total);
      return {
        total,
        covered,
        stale: Number(view.stale ?? 0) === 1,
        percent: total > 0 ? Math.min(100, Math.round((covered / total) * 100)) : 0,
      };
    },

    /**
     * Apply an Email/queryChanges delta to a stored query view per the
     * RFC 8620 §5.5 algorithm: first delete all `removed` ids and
     * compact the positions above them, then insert each `added`
     * entry at its specified index, shifting positions at or after
     * the insertion point up by one.
     *
     * Why this exists as its own RPC: the previous implementation did
     * raw UPSERT-on-position writes which lost any row already sitting
     * at the addition's target index. New deliveries at position 0 in
     * a fully-cached inbox would silently overwrite the previous top
     * row. The shift-and-insert sequence below uses negative-position
     * parking to avoid UNIQUE(view_id, position) conflicts during the
     * shift step, and broadcasts MESSAGES so the message-list store
     * picks up the change even on remove-only deltas (which used to
     * fire no broadcast at all).
     */
    [DB_RPC.FOLDER_WINDOW_APPLY_CHANGES_BATCH]: async ({
      accountId,
      folderId,
      folderRemoteId,
      sortProp = 'receivedAt',
      sortAscending = false,
      collapseThreads = false,
      queryState,
      total = null,
      removed = [],
      added = [],
      messages = [],
    }) => {
      const safeFolderId = Number(folderId);
      if (!Number.isFinite(safeFolderId) || !queryState) {
        throw new Error('folderWindow.applyChangesBatch requires folder and query state');
      }
      const removedList = Array.isArray(removed)
        ? removed.filter((id) => id != null)
        : [];
      const addedList = Array.isArray(added)
        ? added.filter((entry) =>
          entry && entry.id != null && Number.isFinite(Number(entry.index)))
        : [];
      const records = Array.isArray(messages)
        ? messages.filter((message) => message?.remoteId)
        : [];
      const ts = now();
      let viewId: number | null = null;

      await engine.transaction(async (tx) => {
        const filterJson = JSON.stringify({ inMailbox: folderRemoteId });
        const sortJson = JSON.stringify([{ property: sortProp, isAscending: !!sortAscending }]);
        const view = await tx.get(
          `SELECT id FROM query_views
            WHERE account_id = ? AND view_type = 'mailbox-window'
              AND folder_id = ? AND filter_json = ? AND sort_json = ?
              AND collapse_threads = ?`,
          [
            accountId,
            safeFolderId,
            filterJson,
            sortJson,
            collapseThreads ? 1 : 0,
          ],
        );
        viewId = Number(view?.id);
        if (!Number.isFinite(viewId)) {
          throw new Error('folderWindow.applyChangesBatch requires an existing query view');
        }

        await persistMessageRecordsInTx(tx, accountId, records, ts);
        await applyQueryViewChangesInTx(
          tx,
          viewId!,
          removedList,
          addedList,
          ts,
        );
        await tx.run(
          `UPDATE query_views
              SET query_state = ?,
                  can_calculate_changes = 1,
                  total = COALESCE(?, total),
                  stale = 0,
                  updated_at = ?,
                  last_accessed_at = ?
            WHERE id = ?`,
          [queryState, total, ts, ts, viewId],
        );
      });

      if (removedList.length > 0 || addedList.length > 0 || records.length > 0) {
        broadcaster.touch(TABLE_FAMILIES.THREADS);
        broadcaster.touch(TABLE_FAMILIES.FOLDERS);
        broadcaster.touch(TABLE_FAMILIES.MESSAGES);
      }
      return batchResult(records.length, {
        viewId,
        removed: removedList.length,
        added: addedList.length,
      });
    },

    [DB_RPC.QUERY_VIEW_APPLY_CHANGES]: async ({
      viewId, removed = [], added = [],
    }) => {
      const safeViewId = Number(viewId);
      if (!Number.isFinite(safeViewId)) {
        throw new Error('queryView.applyChanges requires a numeric viewId');
      }
      const removedList = Array.isArray(removed) ? removed.filter((id) => id != null) : [];
      const addedList = Array.isArray(added)
        ? added.filter((a) => a && a.id != null && Number.isFinite(Number(a.index)))
        : [];
      if (removedList.length === 0 && addedList.length === 0) {
        return { removed: 0, added: 0 };
      }
      await engine.transaction(async (tx) => {
        await applyQueryViewChangesInTx(
          tx,
          safeViewId,
          removedList,
          addedList,
          now(),
        );
      });
      broadcaster.touch(TABLE_FAMILIES.MESSAGES);
      return { removed: removedList.length, added: addedList.length };
    },

    [DB_RPC.QUERY_VIEW_DROP_REMOTE_IDS]: async ({ accountId, remoteIds = [] }) => {
      const ids = [...new Set((Array.isArray(remoteIds) ? remoteIds : []).filter(Boolean))];
      if (ids.length === 0) return batchResult(0, { views: 0 });
      const ts = now();
      let removed = 0;
      let views = 0;
      await engine.transaction(async (tx) => {
        const rows = await tx.all(
          `SELECT qv.id AS view_id, qi.position
             FROM query_views qv
             JOIN query_view_items qi ON qi.view_id = qv.id
            WHERE qv.account_id = ?
              AND qi.remote_id IN (${placeholdersFor(ids)})`,
          [accountId, ...ids],
        );
        if (rows.length === 0) return;
        const byView = new Map();
        for (const row of rows) {
          const viewId = Number(row.view_id);
          const positions = byView.get(viewId) ?? [];
          positions.push(Number(row.position));
          byView.set(viewId, positions);
        }
        for (const [viewId, positions] of byView) {
          await tx.run(
            `DELETE FROM query_view_items
              WHERE view_id = ? AND remote_id IN (${placeholdersFor(ids)})`,
            [viewId, ...ids],
          );
          const result = await compactViewAfterDeletingPositions(tx, viewId, positions, ts);
          removed += result.removed;
          views += 1;
        }
      });
      broadcaster.touch(TABLE_FAMILIES.MESSAGES);
      return batchResult(removed, { views });
    },

    [DB_RPC.MESSAGE_DESTROY_REMOTE_IDS_BATCH]: async ({ accountId, remoteIds = [] }) => {
      const ids = [...new Set((Array.isArray(remoteIds) ? remoteIds : []).filter(Boolean))];
      if (ids.length === 0) return batchResult(0, { views: 0 });
      const ts = now();
      let result = { removed: 0, views: 0 };
      await engine.transaction(async (tx) => {
        result = await destroyMessagesByRemoteIdsInTransaction(tx, accountId, ids, ts);
      });
      broadcaster.touch(TABLE_FAMILIES.MESSAGES);
      return batchResult(result.removed, { views: result.views });
    },

    /**
     * Nuke the mailbox-window query_view for a folder so it can be
     * rebuilt from scratch. Deleting query_views.id cascades to the
     * matching query_view_items + query_view_ranges rows, leaving the
     * messages and folder_messages tables alone (rows that only exist
     * locally remain as orphans but are no longer reachable through
     * any view, so the UI won't render them).
     *
     * Broadcasts MESSAGES so subscribers re-read after the nuke.
     */
    [DB_RPC.QUERY_VIEW_RESET_FOR_FOLDER]: async ({ accountId, folderId }) => {
      const result = await engine.run(
        `DELETE FROM query_views
          WHERE account_id = ? AND folder_id = ?
            AND view_type = 'mailbox-window'`,
        [accountId, folderId],
      );
      broadcaster.touch(TABLE_FAMILIES.MESSAGES);
      return { deleted: result.changes ?? 0 };
    },

    [DB_RPC.MESSAGE_GET_BY_REMOTE]: async ({ accountId, remoteId }) =>
      engine.get(
        `SELECT * FROM messages WHERE account_id = ? AND remote_id = ?`,
        [accountId, remoteId],
      ),

    /**
     * Send Later scheduling state on a normal message row, keyed by the
     * Email's remote id. A null undoStatus clears both columns (the
     * schedule resolved and the row is ordinary mail again); otherwise
     * the status is replaced and the submission id is kept unless a
     * better one is supplied, because acceptance can be proven before
     * the record's id is known.
     */
    [DB_RPC.MESSAGE_SET_SCHEDULED]: async ({
      accountId, emailRemoteId, submissionRemoteId = null, undoStatus,
    }) => {
      const statuses = new Set(['pending', 'final', 'canceled', 'unknown']);
      if (undoStatus != null && !statuses.has(undoStatus)) {
        throw new Error(`message.setScheduled got an unknown undo status: ${undoStatus}`);
      }
      const result = undoStatus == null
        ? await engine.run(
          `UPDATE messages
              SET scheduled_submission_remote_id = NULL,
                  scheduled_undo_status = NULL
            WHERE account_id = ? AND remote_id = ?`,
          [accountId, emailRemoteId],
        )
        : await engine.run(
          `UPDATE messages
              SET scheduled_submission_remote_id =
                    COALESCE(?, scheduled_submission_remote_id),
                  scheduled_undo_status = ?
            WHERE account_id = ? AND remote_id = ?`,
          [submissionRemoteId, undoStatus, accountId, emailRemoteId],
        );
      if (result.changes) broadcaster.touch(TABLE_FAMILIES.MESSAGES);
      return { updated: result.changes ?? 0 };
    },

    [DB_RPC.MESSAGE_LIST_FOR_THREAD]: async ({ threadId }) =>
      engine.all(
        `SELECT * FROM messages WHERE thread_id = ? ORDER BY received_at ASC, id ASC`,
        [threadId],
      ),

    [DB_RPC.MESSAGE_BODY_READ]: async ({ messageId }) => {
      // Join the part's media type so display classification follows the
      // actual content type rather than the stored `kind`. A plaintext-
      // only message lists its text/plain part in both textBody and
      // htmlBody (RFC 8621), which historically got persisted as
      // kind='html' and rendered through the HTML iframe — collapsing
      // newlines into one unformatted block (issue #25). Preferring
      // media_type heals those rows without a re-fetch.
      const values = await engine.all(
        `SELECT bv.kind, bv.value, bv.is_truncated, bv.part_id,
                bp.media_type, bp.blob_id, bp.charset
           FROM body_values bv
           LEFT JOIN body_parts bp
             ON bp.message_id = bv.message_id AND bp.part_id = bv.part_id
          WHERE bv.message_id = ?
          ORDER BY bp.position, bv.part_id`,
        [messageId],
      );
      const attachments = await engine.all(
        `SELECT part_id, blob_id, name, media_type AS mime_type, size, disposition, cid, charset
           FROM body_parts
          WHERE message_id = ? AND is_attachment = 1
          ORDER BY position`,
        [messageId],
      );
      if (values.length === 0 && attachments.length === 0) {
        return null;
      }
      const isHtmlValue = (row) => {
        const mediaType = String(row.media_type ?? '').toLowerCase();
        if (mediaType === 'text/html') return true;
        if (mediaType === 'text/plain') return false;
        return row.kind === 'html';
      };
      const text = values.find((r) => !isHtmlValue(r))?.value ?? '';
      const html = values.find((r) => isHtmlValue(r))?.value ?? '';
      const bodyParts = values.map((row) => ({
        kind: isHtmlValue(row) ? 'html' : 'text',
        value: row.value ?? '',
        isTruncated: Number(row.is_truncated) === 1,
        blob_id: row.blob_id ?? null,
        mime_type: row.media_type ?? null,
        charset: row.charset ?? null,
      }));
      const truncatedParts = values
        .filter((row) => Number(row.is_truncated) === 1)
        .map((row) => ({
          kind: isHtmlValue(row) ? 'html' : 'text',
          blob_id: row.blob_id ?? null,
          mime_type: row.media_type ?? null,
          charset: row.charset ?? null,
        }));
      return {
        text,
        html,
        attachments,
        isComplete: truncatedParts.length === 0,
        bodyParts,
        truncatedParts,
      };
    },

    [DB_RPC.MESSAGE_FIND_BY_RFC822_MESSAGE_ID]: async ({ accountId, rfc822MessageId }) =>
      engine.get(
        `SELECT * FROM messages WHERE account_id = ? AND rfc822_message_id = ?`,
        [accountId, rfc822MessageId],
      ),

    /**
     * The message's addresses as sync recorded them, one row per address.
     *
     * Reply and Reply All are computed from these rather than from the
     * rendered `from_text` / `to_text`, which cannot say which address is
     * the user's own or whether two spellings are the same person. `cc`
     * and `replyTo` are only available here: neither has a display column.
     */
    [DB_RPC.MESSAGE_LIST_ADDRESSES]: async ({ messageId }) =>
      engine.all(
        `SELECT kind, position, name, email
           FROM message_addresses
          WHERE message_id = ?
          ORDER BY kind, position`,
        [messageId],
      ),

    /**
     * Return the subset of `ids` that still resolve to a row in
     * `messages` for `accountId`. Stores call this before enqueuing
     * a mutation so a stale UI id (e.g. a row the user double-clicked
     * Delete on) is dropped instead of failing the mutation FK check.
     */
    [DB_RPC.MESSAGE_FILTER_EXISTING_IDS]: async ({
      accountId, ids, excludeScheduled = false,
    }) => {
      const numeric = (Array.isArray(ids) ? ids : [])
        .map(Number)
        .filter((id) => Number.isFinite(id));
      if (numeric.length === 0) return [];
      const placeholders = numeric.map(() => '?').join(',');
      const rows = await engine.all(
        `SELECT id FROM messages
          WHERE account_id = ? AND id IN (${placeholders})
            ${excludeScheduled ? 'AND scheduled_undo_status IS NULL' : ''}`,
        [accountId, ...numeric],
      );
      return rows.map((r) => Number(r.id));
    },

    [DB_RPC.MESSAGE_REPLACE_KEYWORDS]: async ({ messageId, keywords, keywordsJson }) => {
      const ts = now();
      await engine.transaction(async (tx) => {
        await tx.run(
          `UPDATE messages
              SET keywords_json = ?,
                  is_seen = ?,
                  is_flagged = ?,
                  is_answered = ?,
                  is_draft = ?,
                  is_forwarded = ?,
                  is_junk = ?,
                  updated_at = ?
            WHERE id = ?`,
          [
            keywordsJson,
            keywords.includes('$seen') ? 1 : 0,
            keywords.includes('$flagged') ? 1 : 0,
            keywords.includes('$answered') ? 1 : 0,
            keywords.includes('$draft') ? 1 : 0,
            keywords.includes('$forwarded') ? 1 : 0,
            keywords.includes('$junk') ? 1 : 0,
            ts,
            messageId,
          ],
        );
        await tx.run(`DELETE FROM message_keywords WHERE message_id = ?`, [messageId]);
        for (const k of keywords) {
          await tx.run(
            `INSERT INTO message_keywords(message_id, keyword) VALUES (?, ?)`,
            [messageId, k],
          );
        }
      });
      broadcaster.touch(TABLE_FAMILIES.MESSAGES);
    },

    [DB_RPC.MESSAGE_REPLACE_KEYWORDS_MANY]: async ({ items = [] }) => {
      const rows = (Array.isArray(items) ? items : [])
        .map((item) => ({
          messageId: Number(item?.messageId),
          keywords: Array.isArray(item?.keywords) ? item.keywords : [],
          keywordsJson: item?.keywordsJson ?? '{}',
        }))
        .filter((item) => Number.isFinite(item.messageId));
      if (rows.length === 0) return batchResult(0);
      const ts = now();
      const messageIds = numericUnique(rows.map((row) => row.messageId));
      await engine.transaction(async (tx) => {
        for (const row of rows) {
          const keywords = row.keywords;
          await tx.run(
            `UPDATE messages
                SET keywords_json = ?,
                    is_seen = ?,
                    is_flagged = ?,
                    is_answered = ?,
                    is_draft = ?,
                    is_forwarded = ?,
                    is_junk = ?,
                    updated_at = ?
              WHERE id = ?`,
            [
              row.keywordsJson,
              keywords.includes('$seen') ? 1 : 0,
              keywords.includes('$flagged') ? 1 : 0,
              keywords.includes('$answered') ? 1 : 0,
              keywords.includes('$draft') ? 1 : 0,
              keywords.includes('$forwarded') ? 1 : 0,
              keywords.includes('$junk') ? 1 : 0,
              ts,
              row.messageId,
            ],
          );
        }
        await tx.run(
          `DELETE FROM message_keywords
            WHERE message_id IN (${placeholdersFor(messageIds)})`,
          messageIds,
        );
        for (const row of rows) {
          for (const keyword of row.keywords) {
            await tx.run(
              `INSERT INTO message_keywords(message_id, keyword) VALUES (?, ?)`,
              [row.messageId, keyword],
            );
          }
        }
      });
      broadcaster.touch(TABLE_FAMILIES.MESSAGES);
      return batchResult(rows.length);
    },

    [DB_RPC.MESSAGE_BODY_PERSIST_BATCH]: async ({ accountId, bodies = [] }) => {
      const items = (Array.isArray(bodies) ? bodies : [])
        .filter((item) => item?.remoteId);
      if (items.length === 0) return batchResult(0);
      const remoteIds = [...new Set(items.map((item) => item.remoteId))];
      const ts = now();
      let applied = 0;
      await engine.transaction(async (tx) => {
        const messageRows = await tx.all(
          `SELECT id, remote_id FROM messages
            WHERE account_id = ? AND remote_id IN (${placeholdersFor(remoteIds)})`,
          [accountId, ...remoteIds],
        );
        const messageIdByRemote = new Map(
          messageRows.map((row) => [row.remote_id, Number(row.id)]),
        );
        const messageIds = numericUnique(messageRows.map((row) => row.id));
        if (messageIds.length === 0) return;

        await tx.run(
          `DELETE FROM body_parts WHERE message_id IN (${placeholdersFor(messageIds)})`,
          messageIds,
        );
        await tx.run(
          `DELETE FROM body_values WHERE message_id IN (${placeholdersFor(messageIds)})`,
          messageIds,
        );

        for (const item of items) {
          const messageId = messageIdByRemote.get(item.remoteId);
          if (!Number.isFinite(messageId)) continue;
          applied += 1;
          for (const part of item.parts ?? []) {
            await tx.run(
              `INSERT INTO body_parts(
                  message_id, part_id, position, blob_id, parent_part_id,
                  media_type, charset, name, disposition, cid,
                  language, location, size,
                  is_body_text, is_body_html, is_attachment, is_inline,
                  raw_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(message_id, part_id) DO UPDATE SET
                  position = excluded.position,
                  blob_id = excluded.blob_id,
                  parent_part_id = excluded.parent_part_id,
                  media_type = excluded.media_type,
                  charset = excluded.charset,
                  name = excluded.name,
                  disposition = excluded.disposition,
                  cid = excluded.cid,
                  language = excluded.language,
                  location = excluded.location,
                  size = excluded.size,
                  is_body_text = excluded.is_body_text,
                  is_body_html = excluded.is_body_html,
                  is_attachment = excluded.is_attachment,
                  is_inline = excluded.is_inline,
                  raw_json = excluded.raw_json`,
              [
                messageId,
                part.partId,
                part.position,
                part.blobId ?? null,
                part.parentPartId ?? null,
                part.mediaType ?? null,
                part.charset ?? null,
                part.name ?? null,
                part.disposition ?? null,
                part.cid ?? null,
                part.language ?? null,
                part.location ?? null,
                part.size ?? null,
                part.isBodyText ? 1 : 0,
                part.isBodyHtml ? 1 : 0,
                part.isAttachment ? 1 : 0,
                part.isInline ? 1 : 0,
                part.rawJson ?? null,
              ],
            );
          }
          for (const value of item.values ?? []) {
            await tx.run(
              `INSERT INTO body_values(
                  message_id, part_id, kind, value, is_truncated,
                  fetched_at, last_accessed_at, byte_size
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(message_id, part_id, kind) DO UPDATE SET
                  value = excluded.value,
                  is_truncated = excluded.is_truncated,
                  fetched_at = excluded.fetched_at,
                  last_accessed_at = excluded.last_accessed_at,
                  byte_size = excluded.byte_size`,
              [
                messageId,
                value.partId,
                value.kind,
                value.value ?? '',
                value.isTruncated ? 1 : 0,
                ts,
                ts,
                value.byteSize ?? null,
              ],
            );
          }
        }

        await tx.run(
          `UPDATE messages
              SET body_fetched_at = ?,
                  updated_at = ?
            WHERE id IN (${placeholdersFor(messageIds)})`,
          [ts, ts, ...messageIds],
        );
      });
      broadcaster.touch(TABLE_FAMILIES.MESSAGES);
      return batchResult(applied);
    },

    [DB_RPC.FOLDER_MEMBERSHIP_REPLACE]: async ({ accountId, messageId, memberships }) => {
      await engine.transaction(async (tx) => {
        await tx.run(`DELETE FROM folder_messages WHERE message_id = ?`, [messageId]);
        for (const m of memberships ?? []) {
          await tx.run(
            `INSERT INTO folder_messages(
                folder_id, message_id, account_id,
                remote_membership_id, added_at,
                sort_received_at, sort_sent_at, instance_state_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              m.folderId,
              messageId,
              accountId,
              m.remoteMembershipId ?? null,
              m.addedAt ?? null,
              m.sortReceivedAt ?? null,
              m.sortSentAt ?? null,
              m.instanceStateJson ?? null,
            ],
          );
        }
      });
      broadcaster.touch(TABLE_FAMILIES.FOLDERS);
      broadcaster.touch(TABLE_FAMILIES.MESSAGES);
    },

    /**
     * Apply the local-cache half of a successful Email/set update
     * {mailboxIds/*} for a single message inside ONE engine
     * transaction. Replaces the previous orchestration in
     * outbox-apply.ts which used 6-9 separate handler RPCs and paid a
     * per-call lock-acquisition + fsync each time. With the indexer or
     * any other background work holding the engine lock, that pattern
     * stretched a 200 ms applyMove to 800-1500 ms (measured against
     * local Stalwart). Doing everything in one transaction means
     * exactly one lock wait and one fsync per delete / move.
     *
     * Behaviour:
     *   - Replace folder_messages rows for this messageId (delete +
     *     insert the new set, preserving sort timestamps from the
     *     existing membership for added folders so the row keeps its
     *     position in any other folder view it appears in).
     *   - For each removeFolderId: drop the remote_id from every
     *     active mailbox-window query_view for that folder, compact
     *     positions, and decrement query_views.total.
     *   - For each addFolderId: mark every active mailbox-window
     *     query_view for that folder stale. Keep existing painted
     *     ranges so large destination folders do not get re-indexed
     *     from scratch; the next foreground visit reconciles the
     *     visible window against the new query state.
     */
    [DB_RPC.OUTBOX_APPLY_MOVE]: async ({
      accountId, messageId, addFolderIds = [], removeFolderIds = [],
    }) => {
      const msgId = Number(messageId);
      if (!Number.isFinite(msgId)) return { ok: false };
      const ts = now();
      await engine.transaction(async (tx) => {
        const remoteRow = await tx.get(
          `SELECT remote_id, is_seen FROM messages WHERE account_id = ? AND id = ?`,
          [accountId, msgId],
        );
        const remoteId = remoteRow?.remote_id ?? null;
        if (!remoteId) return;
        const unreadDelta = Number(remoteRow?.is_seen ?? 1) === 0 ? 1 : 0;

        const existing = await tx.all(
          `SELECT folder_id, remote_membership_id, added_at,
                  sort_received_at, sort_sent_at, instance_state_json
             FROM folder_messages WHERE message_id = ?`,
          [msgId],
        );
        const removeSet = new Set((removeFolderIds ?? []).map(Number));
        const addList = (addFolderIds ?? []).map(Number);
        const carriedSortReceived = existing[0]?.sort_received_at ?? null;
        const carriedSortSent = existing[0]?.sort_sent_at ?? null;
        const keep = existing.filter((row) => !removeSet.has(Number(row.folder_id)));
        const removed = existing.filter((row) => removeSet.has(Number(row.folder_id)));
        const keepIds = new Set(keep.map((row) => Number(row.folder_id)));
        const additions = addList
          .filter((folderId) => !keepIds.has(folderId))
          .map((folderId) => ({
            folderId,
            sortReceivedAt: carriedSortReceived,
            sortSentAt: carriedSortSent,
          }));

        await tx.run(`DELETE FROM folder_messages WHERE message_id = ?`, [msgId]);
        for (const row of keep) {
          await tx.run(
            `INSERT INTO folder_messages(
                folder_id, message_id, account_id,
                remote_membership_id, added_at,
                sort_received_at, sort_sent_at, instance_state_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              Number(row.folder_id),
              msgId,
              accountId,
              row.remote_membership_id ?? null,
              row.added_at ?? null,
              row.sort_received_at ?? null,
              row.sort_sent_at ?? null,
              row.instance_state_json ?? null,
            ],
          );
        }
        for (const add of additions) {
          await tx.run(
            `INSERT INTO folder_messages(
                folder_id, message_id, account_id,
                remote_membership_id, added_at,
                sort_received_at, sort_sent_at, instance_state_json
             ) VALUES (?, ?, ?, NULL, ?, ?, ?, NULL)`,
            [add.folderId, msgId, accountId, ts, add.sortReceivedAt, add.sortSentAt],
          );
        }

        for (const row of removed) {
          await tx.run(
            `UPDATE folders
                SET total_emails = CASE
                      WHEN total_emails IS NULL THEN NULL
                      ELSE MAX(0, total_emails - 1)
                    END,
                    unread_emails = CASE
                      WHEN unread_emails IS NULL THEN NULL
                      ELSE MAX(0, unread_emails - ?)
                    END,
                    updated_at = ?
              WHERE account_id = ? AND id = ?`,
            [unreadDelta, ts, accountId, Number(row.folder_id)],
          );
        }
        for (const add of additions) {
          await tx.run(
            `UPDATE folders
                SET total_emails = COALESCE(total_emails, 0) + 1,
                    unread_emails = COALESCE(unread_emails, 0) + ?,
                    updated_at = ?
              WHERE account_id = ? AND id = ?`,
            [unreadDelta, ts, accountId, add.folderId],
          );
        }

        for (const folderId of removeSet) {
          const viewRows = await tx.all(
            `SELECT id FROM query_views
              WHERE account_id = ? AND folder_id = ?
                AND view_type = 'mailbox-window'`,
            [accountId, folderId],
          );
          for (const view of viewRows) {
            const viewId = Number(view.id);
            const removedRows = await tx.all(
              `SELECT position FROM query_view_items
                WHERE view_id = ? AND remote_id = ?
                ORDER BY position DESC`,
              [viewId, remoteId],
            );
            if (removedRows.length === 0) continue;
            await tx.run(
              `DELETE FROM query_view_items
                WHERE view_id = ? AND remote_id = ?`,
              [viewId, remoteId],
            );
            for (const r of removedRows) {
              await tx.run(
                `UPDATE query_view_items
                    SET position = position - 1
                  WHERE view_id = ? AND position > ?`,
                [viewId, Number(r.position)],
              );
            }
            await tx.run(
              `UPDATE query_views
                  SET total = MAX(0, COALESCE(total, 0) - ?),
                      updated_at = ?
                WHERE id = ?`,
              [removedRows.length, ts, viewId],
            );
          }
        }

        for (const add of additions) {
          const viewRows = await tx.all(
            `SELECT id FROM query_views
              WHERE account_id = ? AND folder_id = ?
                AND view_type = 'mailbox-window'`,
            [accountId, add.folderId],
          );
          if (viewRows.length === 0) continue;
          const placeholders = viewRows.map(() => '?').join(',');
          const viewIds = viewRows.map((r) => Number(r.id));
          await tx.run(
            `UPDATE query_views
                SET stale = 1,
                    total = COALESCE(total, 0) + 1,
                    updated_at = ?
              WHERE id IN (${placeholders})`,
            [ts, ...viewIds],
          );
        }
      });
      broadcaster.touch(TABLE_FAMILIES.FOLDERS);
      broadcaster.touch(TABLE_FAMILIES.MESSAGES);
      return { ok: true };
    },

    [DB_RPC.OUTBOX_APPLY_MOVE_BATCH]: async ({
      accountId, messageIds = [], addFolderIds = [], removeFolderIds = [],
    }) => {
      const msgIds = numericUnique(messageIds);
      if (msgIds.length === 0) return batchResult(0);
      const addList = numericUnique(addFolderIds);
      const removeList = numericUnique(removeFolderIds);
      const removeSet = new Set(removeList);
      const ts = now();
      let applied = 0;

      await engine.transaction(async (tx) => {
        const idPlaceholders = placeholdersFor(msgIds);
        const messageRows = await tx.all(
          `SELECT id, remote_id, is_seen
             FROM messages
            WHERE account_id = ? AND id IN (${idPlaceholders})`,
          [accountId, ...msgIds],
        );
        if (messageRows.length === 0) return;
        const liveIds = messageRows.map((row) => Number(row.id));
        const livePlaceholders = placeholdersFor(liveIds);
        const membershipRows = await tx.all(
          `SELECT folder_id, message_id, remote_membership_id, added_at,
                  sort_received_at, sort_sent_at, instance_state_json
             FROM folder_messages
            WHERE account_id = ? AND message_id IN (${livePlaceholders})`,
          [accountId, ...liveIds],
        );
        const membershipsByMessage = new Map();
        for (const row of membershipRows) {
          const id = Number(row.message_id);
          const list = membershipsByMessage.get(id) ?? [];
          list.push(row);
          membershipsByMessage.set(id, list);
        }

        const deltas = new Map();
        const removedRemoteIdsByFolder = new Map();
        const additions = [];
        const deltaFor = (folderId) => {
          const id = Number(folderId);
          const current = deltas.get(id) ?? {
            removeTotal: 0, removeUnread: 0, addTotal: 0, addUnread: 0,
          };
          deltas.set(id, current);
          return current;
        };

        for (const message of messageRows) {
          const msgId = Number(message.id);
          const remoteId = message.remote_id ?? null;
          if (!remoteId) continue;
          applied += 1;
          const unreadDelta = Number(message.is_seen ?? 1) === 0 ? 1 : 0;
          const existing = membershipsByMessage.get(msgId) ?? [];
          const keepIds = new Set(
            existing
              .map((row) => Number(row.folder_id))
              .filter((folderId) => !removeSet.has(folderId)),
          );
          const carriedSortReceived = existing[0]?.sort_received_at ?? null;
          const carriedSortSent = existing[0]?.sort_sent_at ?? null;

          for (const row of existing) {
            const folderId = Number(row.folder_id);
            if (!removeSet.has(folderId)) continue;
            const delta = deltaFor(folderId);
            delta.removeTotal += 1;
            delta.removeUnread += unreadDelta;
            const remoteIds = removedRemoteIdsByFolder.get(folderId) ?? new Set();
            remoteIds.add(remoteId);
            removedRemoteIdsByFolder.set(folderId, remoteIds);
          }

          for (const folderId of addList) {
            if (keepIds.has(folderId)) continue;
            additions.push({
              folderId,
              messageId: msgId,
              sortReceivedAt: carriedSortReceived,
              sortSentAt: carriedSortSent,
              unreadDelta,
            });
            const delta = deltaFor(folderId);
            delta.addTotal += 1;
            delta.addUnread += unreadDelta;
            keepIds.add(folderId);
          }
        }

        if (removeList.length > 0) {
          const removePlaceholders = placeholdersFor(removeList);
          await tx.run(
            `DELETE FROM folder_messages
              WHERE account_id = ?
                AND message_id IN (${livePlaceholders})
                AND folder_id IN (${removePlaceholders})`,
            [accountId, ...liveIds, ...removeList],
          );
        }

        for (const add of additions) {
          await tx.run(
            `INSERT INTO folder_messages(
                folder_id, message_id, account_id,
                remote_membership_id, added_at,
                sort_received_at, sort_sent_at, instance_state_json
             ) VALUES (?, ?, ?, NULL, ?, ?, ?, NULL)
             ON CONFLICT(folder_id, message_id) DO NOTHING`,
            [add.folderId, add.messageId, accountId, ts, add.sortReceivedAt, add.sortSentAt],
          );
        }

        for (const [folderId, delta] of deltas) {
          await tx.run(
            `UPDATE folders
                SET total_emails = CASE
                      WHEN total_emails IS NULL AND ? = 0 THEN NULL
                      ELSE MAX(0, COALESCE(total_emails, 0) - ?) + ?
                    END,
                    unread_emails = CASE
                      WHEN unread_emails IS NULL AND ? = 0 THEN NULL
                      ELSE MAX(0, COALESCE(unread_emails, 0) - ?) + ?
                    END,
                    updated_at = ?
              WHERE account_id = ? AND id = ?`,
            [
              delta.addTotal,
              delta.removeTotal,
              delta.addTotal,
              delta.addUnread,
              delta.removeUnread,
              delta.addUnread,
              ts,
              accountId,
              folderId,
            ],
          );
        }

        for (const [folderId, remoteIdsSet] of removedRemoteIdsByFolder) {
          const remoteIds = [...remoteIdsSet];
          if (remoteIds.length === 0) continue;
          const viewRows = await tx.all(
            `SELECT id FROM query_views
              WHERE account_id = ? AND folder_id = ?
                AND view_type = 'mailbox-window'`,
            [accountId, folderId],
          );
          if (viewRows.length === 0) continue;
          const remotePlaceholders = placeholdersFor(remoteIds);
          for (const view of viewRows) {
            const viewId = Number(view.id);
            const removedRows = await tx.all(
              `SELECT position FROM query_view_items
                WHERE view_id = ? AND remote_id IN (${remotePlaceholders})
                ORDER BY position`,
              [viewId, ...remoteIds],
            );
            if (removedRows.length === 0) continue;
            await tx.run(
              `DELETE FROM query_view_items
                WHERE view_id = ? AND remote_id IN (${remotePlaceholders})`,
              [viewId, ...remoteIds],
            );
            await compactViewAfterDeletingPositions(
              tx,
              viewId,
              removedRows.map((row) => Number(row.position)),
              ts,
            );
          }
        }

        for (const folderId of addList) {
          const delta = deltas.get(folderId);
          const added = Number(delta?.addTotal ?? 0);
          if (added <= 0) continue;
          const viewRows = await tx.all(
            `SELECT id FROM query_views
              WHERE account_id = ? AND folder_id = ?
                AND view_type = 'mailbox-window'`,
            [accountId, folderId],
          );
          if (viewRows.length === 0) continue;
          const viewIds = viewRows.map((r) => Number(r.id));
          await tx.run(
            `UPDATE query_views
                SET stale = 1,
                    total = COALESCE(total, 0) + ?,
                    updated_at = ?
              WHERE id IN (${placeholdersFor(viewIds)})`,
            [added, ts, ...viewIds],
          );
        }
      });
      broadcaster.touch(TABLE_FAMILIES.FOLDERS);
      broadcaster.touch(TABLE_FAMILIES.MESSAGES);
      return batchResult(applied);
    },

    /**
     * Apply the local-cache half of a successful Email/set destroy
     * for a single message inside ONE engine transaction. Same
     * motivation as OUTBOX_APPLY_MOVE: cuts the count of fsyncs and
     * lock acquisitions to one.
     */
    [DB_RPC.OUTBOX_APPLY_DESTROY]: async ({ accountId, messageId }) => {
      const msgId = Number(messageId);
      if (!Number.isFinite(msgId)) return { ok: false };
      const ts = now();
      await engine.transaction(async (tx) => {
        const row = await tx.get(
          `SELECT remote_id, is_seen FROM messages WHERE account_id = ? AND id = ?`,
          [accountId, msgId],
        );
        const remoteId = row?.remote_id ?? null;
        const unreadDelta = Number(row?.is_seen ?? 1) === 0 ? 1 : 0;
        const memberships = await tx.all(
          `SELECT folder_id FROM folder_messages WHERE message_id = ?`,
          [msgId],
        );
        // The DELETE cascades via FK to folder_messages,
        // message_addresses, message_keywords, body_parts, body_values.
        await tx.run(
          `DELETE FROM messages WHERE id = ? AND account_id = ?`,
          [msgId, accountId],
        );
        if (!remoteId) return;

        for (const membership of memberships) {
          await tx.run(
            `UPDATE folders
                SET total_emails = CASE
                      WHEN total_emails IS NULL THEN NULL
                      ELSE MAX(0, total_emails - 1)
                    END,
                    unread_emails = CASE
                      WHEN unread_emails IS NULL THEN NULL
                      ELSE MAX(0, unread_emails - ?)
                    END,
                    updated_at = ?
              WHERE account_id = ? AND id = ?`,
            [unreadDelta, ts, accountId, Number(membership.folder_id)],
          );
        }

        const viewRows = await tx.all(
          `SELECT DISTINCT qv.id
             FROM query_views qv
             JOIN query_view_items qi ON qi.view_id = qv.id
            WHERE qv.account_id = ?
              AND qi.remote_id = ?`,
          [accountId, remoteId],
        );
        for (const view of viewRows) {
          const viewId = Number(view.id);
          const removedRows = await tx.all(
            `SELECT position FROM query_view_items
              WHERE view_id = ? AND remote_id = ?
              ORDER BY position DESC`,
            [viewId, remoteId],
          );
          if (removedRows.length === 0) continue;
          await tx.run(
            `DELETE FROM query_view_items
              WHERE view_id = ? AND remote_id = ?`,
            [viewId, remoteId],
          );
          for (const r of removedRows) {
            await tx.run(
              `UPDATE query_view_items
                  SET position = position - 1
                WHERE view_id = ? AND position > ?`,
              [viewId, Number(r.position)],
            );
          }
          await tx.run(
            `UPDATE query_views
                SET total = MAX(0, COALESCE(total, 0) - ?),
                    updated_at = ?
              WHERE id = ?`,
            [removedRows.length, ts, viewId],
          );
        }
      });
      broadcaster.touch(TABLE_FAMILIES.FOLDERS);
      broadcaster.touch(TABLE_FAMILIES.MESSAGES);
      return { ok: true };
    },

    [DB_RPC.OUTBOX_APPLY_DESTROY_BATCH]: async ({ accountId, messageIds = [] }) => {
      const msgIds = numericUnique(messageIds);
      if (msgIds.length === 0) return batchResult(0);
      const ts = now();
      let applied = 0;

      await engine.transaction(async (tx) => {
        const idPlaceholders = placeholdersFor(msgIds);
        const messageRows = await tx.all(
          `SELECT id, remote_id, is_seen
             FROM messages
            WHERE account_id = ? AND id IN (${idPlaceholders})`,
          [accountId, ...msgIds],
        );
        if (messageRows.length === 0) return;
        applied = messageRows.length;
        const liveIds = messageRows.map((row) => Number(row.id));
        const livePlaceholders = placeholdersFor(liveIds);
        const messagesById = new Map<number, any>(messageRows.map((row) => [Number(row.id), row]));
        const remoteIds = messageRows
          .map((row) => row.remote_id)
          .filter((remoteId) => typeof remoteId === 'string' && remoteId.length > 0);

        const memberships = await tx.all(
          `SELECT message_id, folder_id
             FROM folder_messages
            WHERE account_id = ? AND message_id IN (${livePlaceholders})`,
          [accountId, ...liveIds],
        );
        const deltas = new Map();
        for (const membership of memberships) {
          const message = messagesById.get(Number(membership.message_id));
          const unreadDelta = Number(message?.is_seen ?? 1) === 0 ? 1 : 0;
          const folderId = Number(membership.folder_id);
          const current = deltas.get(folderId) ?? { removeTotal: 0, removeUnread: 0 };
          current.removeTotal += 1;
          current.removeUnread += unreadDelta;
          deltas.set(folderId, current);
        }

        await tx.run(
          `DELETE FROM messages
            WHERE account_id = ? AND id IN (${livePlaceholders})`,
          [accountId, ...liveIds],
        );

        for (const [folderId, delta] of deltas) {
          await tx.run(
            `UPDATE folders
                SET total_emails = CASE
                      WHEN total_emails IS NULL THEN NULL
                      ELSE MAX(0, total_emails - ?)
                    END,
                    unread_emails = CASE
                      WHEN unread_emails IS NULL THEN NULL
                      ELSE MAX(0, unread_emails - ?)
                    END,
                    updated_at = ?
              WHERE account_id = ? AND id = ?`,
            [delta.removeTotal, delta.removeUnread, ts, accountId, folderId],
          );
        }

        if (remoteIds.length > 0) {
          const remotePlaceholders = placeholdersFor(remoteIds);
          const viewRows = await tx.all(
            `SELECT DISTINCT qv.id
               FROM query_views qv
               JOIN query_view_items qi ON qi.view_id = qv.id
              WHERE qv.account_id = ?
                AND qi.remote_id IN (${remotePlaceholders})`,
            [accountId, ...remoteIds],
          );
          for (const view of viewRows) {
            const viewId = Number(view.id);
            const removedRows = await tx.all(
              `SELECT position FROM query_view_items
                WHERE view_id = ? AND remote_id IN (${remotePlaceholders})
                ORDER BY position`,
              [viewId, ...remoteIds],
            );
            if (removedRows.length === 0) continue;
            await tx.run(
              `DELETE FROM query_view_items
                WHERE view_id = ? AND remote_id IN (${remotePlaceholders})`,
              [viewId, ...remoteIds],
            );
            await compactViewAfterDeletingPositions(
              tx,
              viewId,
              removedRows.map((row) => Number(row.position)),
              ts,
            );
          }
        }
      });
      broadcaster.touch(TABLE_FAMILIES.FOLDERS);
      broadcaster.touch(TABLE_FAMILIES.MESSAGES);
      return batchResult(applied);
    },

    /**
     * Post-success cache effect for the setMailboxSubscription
     * mutation: mirror the server-confirmed Mailbox isSubscribed flag
     * on the local folder row before the mutation RPC resolves.
     */
    [DB_RPC.OUTBOX_APPLY_FOLDER_SUBSCRIPTION]: async ({ folderId, isSubscribed }) =>
      applyFolderSubscriptions([{ folderId, isSubscribed }]),

    [DB_RPC.OUTBOX_APPLY_FOLDER_SUBSCRIPTIONS]: async ({ updates = [] }) =>
      applyFolderSubscriptions(updates),

    /**
     * Post-success cache effect for createMailbox: insert the server-
     * confirmed folder row so the sidebar shows it before any
     * StateChange push. Upsert keyed on (account_id, remote_id) — a
     * concurrent Mailbox/changes sync may have ingested the row first.
     */
    [DB_RPC.OUTBOX_APPLY_FOLDER_CREATE]: async (create) => {
      const result = await applyFolderCreates([{ ...create, clientId: 'single' }]);
      return { folderId: result.folderIds.single ?? null };
    },

    [DB_RPC.OUTBOX_APPLY_FOLDER_CREATES]: async ({ creates = [] }) =>
      applyFolderCreates(creates),

    /**
     * Post-success cache effect for updateMailbox (rename and/or move).
     * `parentProvided` distinguishes "move to root" (parentFolderId
     * null) from "parent untouched" — JSON round-trips drop undefined.
     */
    [DB_RPC.OUTBOX_APPLY_FOLDER_UPDATE]: async (update) =>
      applyFolderUpdates([update]),

    [DB_RPC.OUTBOX_APPLY_FOLDER_UPDATES]: async ({ updates = [] }) =>
      applyFolderUpdates(updates),

    /**
     * Post-success cache effect for destroyMailbox: soft-delete the
     * folder row and drop its memberships and cached query views in one
     * transaction. Messages that lived only in this folder are cleaned
     * up by the next Email/changes sync (the server already destroyed
     * them when onDestroyRemoveEmails was true); rows in other folders
     * keep their remaining memberships.
     */
    [DB_RPC.OUTBOX_APPLY_FOLDER_DESTROY]: async ({
      folderId, accountId, onDestroyRemoveEmails = false,
    }) => {
      let ownerAccountId = accountId;
      if (ownerAccountId == null) {
        const folder = await engine.get(`SELECT account_id FROM folders WHERE id = ?`, [folderId]);
        ownerAccountId = folder?.account_id;
      }
      return applyFolderDestroys([{
        folderId,
        accountId: ownerAccountId,
        onDestroyRemoveEmails,
      }]);
    },

    [DB_RPC.OUTBOX_APPLY_FOLDER_DESTROYS]: async ({ destroys = [] }) =>
      applyFolderDestroys(destroys),

    [DB_RPC.FOLDER_MEMBERSHIP_REPLACE_MANY]: async ({ accountId, replacements }) => {
      const items = (replacements ?? []).filter((r) => r?.messageId != null);
      if (items.length === 0) return { replaced: 0, inserted: 0 };
      let inserted = 0;
      await engine.transaction(async (tx) => {
        const messageIds = [...new Set(items.map((r) => r.messageId))];
        const placeholders = messageIds.map(() => '?').join(',');
        await tx.run(`DELETE FROM folder_messages WHERE message_id IN (${placeholders})`, messageIds);
        for (const item of items) {
          for (const m of item.memberships ?? []) {
            await tx.run(
              `INSERT INTO folder_messages(
                  folder_id, message_id, account_id,
                  remote_membership_id, added_at,
                  sort_received_at, sort_sent_at, instance_state_json
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                m.folderId,
                item.messageId,
                accountId,
                m.remoteMembershipId ?? null,
                m.addedAt ?? null,
                m.sortReceivedAt ?? null,
                m.sortSentAt ?? null,
                m.instanceStateJson ?? null,
              ],
            );
            inserted += 1;
          }
        }
      });
      broadcaster.touch(TABLE_FAMILIES.FOLDERS);
      broadcaster.touch(TABLE_FAMILIES.MESSAGES);
      return { replaced: items.length, inserted };
    },

    [DB_RPC.ADDRESSBOOK_LIST]: async ({ accountId }) =>
      engine.all(
        `SELECT * FROM addressbooks
          WHERE account_id = ? AND is_deleted = 0
          ORDER BY is_default DESC, sort_order, name COLLATE NOCASE`,
        [accountId],
      ),

    /**
     * @param {object} args
     * @param {boolean} [args.snapshot] treat the list as the whole truth for
     *   this account and service: a book that is not in it has been removed
     *   server-side and is retired here too (CS-4.8). Without this an
     *   address book deleted elsewhere stays on offer as a filing target
     *   forever, since `AddressBook/get` has no way to mention it again.
     *   An empty snapshot is meaningful and removes everything.
     */
    [DB_RPC.ADDRESSBOOK_UPSERT_MANY]: async ({
      accountId, serviceKind, addressbooks, snapshot = false, broadcast = true,
    }) => {
      if (!addressbooks?.length && !snapshot) {
        return { upserted: 0 };
      }
      const ts = now();
      let retired = 0;
      await engine.transaction(async (tx) => {
        for (const ab of addressbooks ?? []) {
          await tx.run(
            `INSERT INTO addressbooks(
                account_id, service_kind, remote_id, name, description,
                sort_order, is_default, is_subscribed, may_write, may_delete,
                ctag, sync_token, raw_json, is_deleted, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(account_id, service_kind, remote_id) DO UPDATE SET
                name = excluded.name,
                description = excluded.description,
                sort_order = excluded.sort_order,
                is_default = excluded.is_default,
                is_subscribed = excluded.is_subscribed,
                may_write = excluded.may_write,
                may_delete = excluded.may_delete,
                ctag = excluded.ctag,
                sync_token = excluded.sync_token,
                raw_json = excluded.raw_json,
                is_deleted = excluded.is_deleted,
                updated_at = excluded.updated_at`,
            [
              accountId,
              serviceKind,
              ab.remoteId,
              ab.name ?? null,
              ab.description ?? null,
              Number.isSafeInteger(ab.sortOrder) && ab.sortOrder >= 0 ? ab.sortOrder : 0,
              ab.isDefault ? 1 : 0,
              ab.isSubscribed === false ? 0 : 1,
              ab.mayWrite === true ? 1 : (ab.mayWrite === false ? 0 : null),
              ab.mayDelete === true ? 1 : (ab.mayDelete === false ? 0 : null),
              ab.ctag ?? null,
              ab.syncToken ?? null,
              ab.rawJson ?? null,
              ab.isDeleted ? 1 : 0,
              ts,
            ],
          );
        }
        if (!snapshot) return;
        const kept = (addressbooks ?? []).map((ab) => ab.remoteId);
        const placeholders = kept.map(() => '?').join(',');
        const result = await tx.run(
          `UPDATE addressbooks SET is_deleted = 1, updated_at = ?
            WHERE account_id = ? AND service_kind = ? AND is_deleted = 0
              ${kept.length > 0 ? `AND remote_id NOT IN (${placeholders})` : ''}`,
          [ts, accountId, serviceKind, ...kept],
        );
        retired = result?.changes ?? 0;
      });
      if (broadcast) broadcaster.touch(TABLE_FAMILIES.CONTACTS);
      return { upserted: addressbooks?.length ?? 0, retired };
    },

    [DB_RPC.ADDRESSBOOK_MUTATION_ENSURE]: async (input) => {
      const mutationTypes = new Set([
        MUTATION_TYPE.CREATE_ADDRESSBOOK,
        MUTATION_TYPE.UPDATE_ADDRESSBOOK,
        MUTATION_TYPE.DESTROY_ADDRESSBOOK,
      ]);
      let nextRequest;
      try {
        nextRequest = JSON.parse(input.requestJson);
      } catch {
        nextRequest = null;
      }
      if (
        !mutationTypes.has(input.mutationType)
        || typeof input.operationId !== 'string'
        || !input.operationId
        || nextRequest?.operationId !== input.operationId
      ) {
        throw new Error(
          'addressbook.ensureMutation requires an AddressBook mutation operation',
        );
      }

      const ts = now();
      let ensured: {
        id: number;
        reused: boolean;
        requestMatches: boolean;
        storedRequestJson: string;
        errorType?: string;
      } | null = null;
      await engine.transaction(async (tx) => {
        const rows = await tx.all(
          `SELECT *
             FROM pending_mutations
            WHERE account_id = ?
              AND mutation_type = ?
              AND local_status IN ('pending','retry','in_flight','conflicted')
            ORDER BY id`,
          [input.accountId, input.mutationType],
        );
        for (const row of rows) {
          let request;
          try {
            request = JSON.parse(row.request_json);
          } catch {
            continue;
          }
          if (request?.operationId !== input.operationId) continue;
          const requestMatches = row.request_json === input.requestJson;
          const prewrite = row.phase == null;
          if (
            prewrite
            && !requestMatches
            && row.local_status !== 'in_flight'
          ) {
            await tx.run(
              `UPDATE pending_mutations
                  SET local_status = 'pending',
                      request_json = ?,
                      attempts = 0,
                      not_before = NULL,
                      error_json = NULL,
                      updated_at = ?
                WHERE id = ?`,
              [input.requestJson, ts, row.id],
            );
            ensured = {
              id: Number(row.id),
              reused: true,
              requestMatches: true,
              storedRequestJson: input.requestJson,
            };
            return;
          }
          if (row.local_status !== 'conflicted') {
            ensured = {
              id: Number(row.id),
              reused: true,
              requestMatches,
              storedRequestJson: row.request_json,
            };
            return;
          }

          let recordedError;
          let checkpoint;
          try {
            recordedError = JSON.parse(row.error_json ?? 'null');
          } catch {
            recordedError = null;
          }
          try {
            checkpoint = JSON.parse(
              row.server_response_json ?? 'null',
            )?.addressBook;
          } catch {
            checkpoint = null;
          }
          const cachePending = row.phase === ADDRESSBOOK_PHASE.CACHE_PENDING
            && checkpoint?.version === 1
            && typeof checkpoint.remoteId === 'string';
          const destroyPending =
            row.phase === ADDRESSBOOK_PHASE.DESTROY_SUBMITTING
            && checkpoint?.version === 1
            && checkpoint.operation === 'destroy'
            && typeof checkpoint.remoteId === 'string'
            && checkpoint.confirmationInventory?.version === 1;
          const retryablePrewrite = prewrite
            && recordedError
            && recordedError.terminal !== true;
          if (!cachePending && !destroyPending && !retryablePrewrite) {
            ensured = {
              id: Number(row.id),
              reused: true,
              requestMatches,
              storedRequestJson: row.request_json,
              ...(typeof recordedError?.type === 'string'
                ? { errorType: recordedError.type }
                : {}),
            };
            return;
          }
          if (cachePending) checkpoint.attempts = 0;
          await tx.run(
            `UPDATE pending_mutations
                SET local_status = 'retry',
                    attempts = 0,
                    not_before = NULL,
                    error_json = NULL,
                    server_response_json = ?,
                    updated_at = ?
              WHERE id = ?`,
            [
              checkpoint
                ? JSON.stringify({ addressBook: checkpoint })
                : row.server_response_json,
              ts,
              row.id,
            ],
          );
          ensured = {
            id: Number(row.id),
            reused: true,
            requestMatches,
            storedRequestJson: row.request_json,
          };
          return;
        }

        const inserted = await tx.run(
          `INSERT INTO pending_mutations(
              account_id, mutation_type, local_status, target_message_id,
              request_json, optimistic_patch_json, server_response_json, error_json,
              created_at, updated_at
           ) VALUES (?, ?, 'pending', NULL, ?, NULL, NULL, NULL, ?, ?)`,
          [input.accountId, input.mutationType, input.requestJson, ts, ts],
        );
        ensured = {
          id: Number(inserted.lastInsertRowid),
          reused: false,
          requestMatches: true,
          storedRequestJson: input.requestJson,
        };
      });
      broadcaster.touch(TABLE_FAMILIES.MUTATIONS);
      notifyMutation(input.accountId, ensured!.id);
      return ensured;
    },

    /**
     * List contacts joined with their preferred (or first) email,
     * suitable for the contact-book view. Returns a flat row shape so
     * the caller does not have to JOIN `contact_emails` itself.
     * Unbounded by default so the contact book shows the whole account;
     * callers that want a window pass an explicit `limit`.
     */
    [DB_RPC.CONTACT_LIST]: async ({ accountId, limit = null }) => {
      const rows = await engine.all(
        `SELECT c.id,
                c.remote_id,
                c.uid,
                c.display_name,
                (SELECT email FROM contact_emails ce
                  WHERE ce.contact_id = c.id
                  ORDER BY is_preferred DESC, position
                  LIMIT 1) AS email,
                (SELECT map_key FROM contact_media cm
                  WHERE cm.contact_id = c.id AND cm.kind = 'photo'
                  ORDER BY pref IS NULL, pref, position
                  LIMIT 1) AS photo_map_key,
                (SELECT uri FROM contact_media cm
                  WHERE cm.contact_id = c.id AND cm.kind = 'photo'
                  ORDER BY pref IS NULL, pref, position
                  LIMIT 1) AS photo_uri,
                (SELECT blob_id FROM contact_media cm
                  WHERE cm.contact_id = c.id AND cm.kind = 'photo'
                  ORDER BY pref IS NULL, pref, position
                  LIMIT 1) AS photo_blob_id,
                (SELECT media_type FROM contact_media cm
                  WHERE cm.contact_id = c.id AND cm.kind = 'photo'
                  ORDER BY pref IS NULL, pref, position
                  LIMIT 1) AS photo_media_type,
                (SELECT pref FROM contact_media cm
                  WHERE cm.contact_id = c.id AND cm.kind = 'photo'
                  ORDER BY pref IS NULL, pref, position
                  LIMIT 1) AS photo_pref,
                -- A card can be filed in several books (RFC 9610), so the
                -- view is given all of them and decides what to show.
                (SELECT group_concat(ac.addressbook_id)
                   FROM addressbook_contacts ac
                  WHERE ac.contact_id = c.id) AS addressbook_ids
           FROM contacts c
          WHERE c.account_id = ? AND c.is_deleted = 0
          ORDER BY c.display_name COLLATE NOCASE
          LIMIT ?`,
        [accountId, Number.isFinite(limit) && limit > 0 ? limit : -1],
      );
      return rows.map((row) => {
        const {
          photo_map_key: photoMapKey,
          photo_uri: photoUri,
          photo_blob_id: photoBlobId,
          photo_media_type: photoMediaType,
          photo_pref: photoPref,
          ...contact
        } = row;
        return {
          ...contact,
          addressbook_ids: splitIds(row.addressbook_ids),
          photo: photoMapKey
            ? {
                mapKey: photoMapKey,
                uri: photoUri ?? null,
                blobId: photoBlobId ?? null,
                mediaType: photoMediaType ?? null,
                pref: photoPref == null ? null : Number(photoPref),
              }
            : null,
        };
      });
    },

    /**
     * Fetch the protocol-neutral normalized detail model for one contact.
     */
    [DB_RPC.CONTACT_GET]: async ({ accountId, contactId }) => {
      const row = await engine.get(
        `SELECT id, remote_id, display_name, full_name
           FROM contacts
          WHERE id = ? AND account_id = ? AND is_deleted = 0`,
        [contactId, accountId],
      );
      if (!row) return null;
      const emailRows = await engine.all(
        `SELECT map_key, position, email, label, contexts_json, pref, is_preferred
           FROM contact_emails WHERE contact_id = ? ORDER BY position`,
        [contactId],
      );
      const phoneRows = await engine.all(
        `SELECT map_key, position, value, label, contexts_json, features_json, pref
           FROM contact_phones WHERE contact_id = ? ORDER BY position`,
        [contactId],
      );
      const linkRows = await engine.all(
        `SELECT map_key, position, value, label, contexts_json, pref
           FROM contact_links WHERE contact_id = ? ORDER BY position`,
        [contactId],
      );
      const anniversaryRows = await engine.all(
        `SELECT map_key, position, kind, date_kind, date_year, date_month, date_day, date_utc
           FROM contact_anniversaries WHERE contact_id = ? ORDER BY position`,
        [contactId],
      );
      const noteRows = await engine.all(
        `SELECT map_key, position, value
           FROM contact_notes WHERE contact_id = ? ORDER BY position`,
        [contactId],
      );
      const organizationRows = await engine.all(
        `SELECT map_key, position, name, contexts_json
           FROM contact_organizations WHERE contact_id = ? ORDER BY position`,
        [contactId],
      );
      const unitRows = await engine.all(
        `SELECT organization_position, position, value
           FROM contact_organization_units
          WHERE contact_id = ?
          ORDER BY organization_position, position`,
        [contactId],
      );
      const titleRows = await engine.all(
        `SELECT map_key, position, value, kind, organization_map_key
           FROM contact_titles WHERE contact_id = ? ORDER BY position`,
        [contactId],
      );
      const photoRow = await engine.get(
        `SELECT map_key, uri, blob_id, media_type, pref
           FROM contact_media
          WHERE contact_id = ? AND kind = 'photo'
          ORDER BY pref IS NULL, pref, position
          LIMIT 1`,
        [contactId],
      );
      const books = await engine.all(
        `SELECT addressbook_id FROM addressbook_contacts
          WHERE contact_id = ? ORDER BY addressbook_id`,
        [contactId],
      );
      const emails = emailRows.map((email) => ({
        mapKey: email.map_key ?? null,
        position: Number(email.position),
        value: email.email,
        label: email.label ?? null,
        contexts: parseStringArray(email.contexts_json),
        pref: email.pref == null ? null : Number(email.pref),
        isPreferred: Number(email.is_preferred) === 1,
      }));
      const phones = phoneRows.map((phone) => ({
        mapKey: phone.map_key ?? null,
        position: Number(phone.position),
        value: phone.value,
        label: phone.label ?? null,
        contexts: parseStringArray(phone.contexts_json),
        features: parseStringArray(phone.features_json),
        pref: phone.pref == null ? null : Number(phone.pref),
      }));
      const links = linkRows.map((link) => ({
        mapKey: link.map_key ?? null,
        position: Number(link.position),
        value: link.value,
        label: link.label ?? null,
        contexts: parseStringArray(link.contexts_json),
        pref: link.pref == null ? null : Number(link.pref),
      }));
      const anniversaries = anniversaryRows.map((anniversary) => ({
        mapKey: anniversary.map_key ?? null,
        position: Number(anniversary.position),
        kind: anniversary.kind,
        date: anniversary.date_kind === 'timestamp'
          ? { kind: 'timestamp', utc: anniversary.date_utc }
          : {
              kind: 'partial',
              year: anniversary.date_year == null ? null : Number(anniversary.date_year),
              month: anniversary.date_month == null ? null : Number(anniversary.date_month),
              day: anniversary.date_day == null ? null : Number(anniversary.date_day),
            },
      }));
      const notes = noteRows.map((note) => ({
        mapKey: note.map_key ?? null,
        position: Number(note.position),
        value: note.value,
      }));
      const organizations = organizationRows.map((organization) => ({
        mapKey: organization.map_key ?? null,
        position: Number(organization.position),
        name: organization.name ?? null,
        contexts: parseStringArray(organization.contexts_json),
        units: unitRows
          .filter((unit) => Number(unit.organization_position) === Number(organization.position))
          .map((unit) => ({ position: Number(unit.position), value: unit.value })),
      }));
      const titles = titleRows.map((title) => ({
        mapKey: title.map_key ?? null,
        position: Number(title.position),
        value: title.value,
        kind: title.kind,
        organizationMapKey: title.organization_map_key ?? null,
      }));
      return {
        ...row,
        emails,
        phones,
        links,
        anniversaries,
        notes,
        organizations,
        titles,
        photo: photoRow
          ? {
              mapKey: photoRow.map_key,
              uri: photoRow.uri ?? null,
              blobId: photoRow.blob_id ?? null,
              mediaType: photoRow.media_type ?? null,
              pref: photoRow.pref == null ? null : Number(photoRow.pref),
            }
          : null,
        addressbook_ids: books.map((book) => book.addressbook_id),
      };
    },

    /**
     * @param {object} args
     * @param {number} [args.generation] stamp each row with the full sync
     *   that saw it, so `CONTACT_SWEEP_STALE` can afterwards tell the rows
     *   the server still has from the ones it no longer does.
     */
    [DB_RPC.CONTACT_UPSERT_MANY]: async ({
      accountId, contacts, generation = null, broadcast = true,
    }) => {
      if (!contacts?.length) {
        return { upserted: 0 };
      }
      const ts = now();
      await engine.transaction(async (tx) => {
        const preparedContacts = [];
        for (const c of contacts) {
          await tx.run(
            `INSERT INTO contacts(
                account_id, remote_id, uid, etag,
                full_name, display_name, given_name, family_name, organization,
                vcard_text, vcard_version, raw_json, sync_generation, is_deleted, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(account_id, remote_id) DO UPDATE SET
                uid = excluded.uid,
                etag = excluded.etag,
                full_name = excluded.full_name,
                display_name = excluded.display_name,
                given_name = excluded.given_name,
                family_name = excluded.family_name,
                organization = excluded.organization,
                vcard_text = excluded.vcard_text,
                vcard_version = excluded.vcard_version,
                raw_json = excluded.raw_json,
                -- A targeted reconcile passes no generation and must not
                -- backdate a row out from under a sweep that is running.
                sync_generation = MAX(excluded.sync_generation, contacts.sync_generation),
                is_deleted = excluded.is_deleted,
                updated_at = excluded.updated_at`,
            [
              accountId,
              c.remoteId,
              c.uid ?? null,
              c.etag ?? null,
              c.fullName ?? null,
              c.displayName ?? null,
              c.givenName ?? null,
              c.familyName ?? null,
              c.organization ?? null,
              c.vcardText ?? null,
              c.vcardVersion ?? null,
              c.rawJson ?? null,
              generation ?? 0,
              c.isDeleted ? 1 : 0,
              ts,
            ],
          );
          const contactRow = await tx.get(
            `SELECT id FROM contacts WHERE account_id = ? AND remote_id = ?`,
            [accountId, c.remoteId],
          );
          const contactId = contactRow.id;
          preparedContacts.push({ c, contactId });
        }
        const detailTables = [
          ['contact_emails', 'emails'],
          ['contact_phones', 'phones'],
          ['contact_links', 'links'],
          ['contact_anniversaries', 'anniversaries'],
          ['contact_notes', 'notes'],
          ['contact_organizations', 'organizations'],
          ['contact_titles', 'titles'],
          ['contact_media', 'media'],
        ];
        for (const [table, property] of detailTables) {
          const ids = preparedContacts
            .filter(({ c }) => Array.isArray(c[property]))
            .map(({ contactId }) => contactId);
          if (ids.length === 0) continue;
          await tx.run(
            `DELETE FROM ${table} WHERE contact_id IN (${ids.map(() => '?').join(',')})`,
            ids,
          );
        }
        for (const { c, contactId } of preparedContacts) {
          // Membership is replaced, not added to: a card removed from a
          // book must leave it, and the card names every book it is in.
          if (c.addressbookIds) {
            await tx.run('DELETE FROM addressbook_contacts WHERE contact_id = ?', [contactId]);
            for (const bookId of c.addressbookIds) {
              await tx.run(
                `INSERT OR IGNORE INTO addressbook_contacts(contact_id, addressbook_id)
                 VALUES (?, ?)`,
                [contactId, bookId],
              );
            }
          }
          if (Array.isArray(c.emails)) {
            for (let i = 0; i < c.emails.length; i += 1) {
              const e = c.emails[i];
              await tx.run(
                `INSERT INTO contact_emails(
                   contact_id, account_id, position, email, email_key, label, is_preferred,
                   map_key, contexts_json, pref
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                // The address is stored verbatim for display and sending
                // (CS-3.5); the key beside it is what lookups compare, and it
                // is computed here rather than in SQL because SQLite's
                // `lower()` folds ASCII only.
                [
                  contactId,
                  accountId,
                  i,
                  e.email,
                  addressKey(e.email),
                  e.label ?? null,
                  e.isPreferred ? 1 : 0,
                  e.mapKey ?? null,
                  JSON.stringify(e.contexts ?? []),
                  e.pref ?? null,
                ],
              );
            }
          }

          if (Array.isArray(c.phones)) {
            for (let i = 0; i < c.phones.length; i += 1) {
              const phone = c.phones[i];
              await tx.run(
                `INSERT INTO contact_phones(
                   contact_id, position, map_key, value, label,
                   contexts_json, features_json, pref
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  contactId,
                  i,
                  phone.mapKey ?? null,
                  phone.value,
                  phone.label ?? null,
                  JSON.stringify(phone.contexts ?? []),
                  JSON.stringify(phone.features ?? []),
                  phone.pref ?? null,
                ],
              );
            }
          }

          if (Array.isArray(c.links)) {
            for (let i = 0; i < c.links.length; i += 1) {
              const link = c.links[i];
              await tx.run(
                `INSERT INTO contact_links(
                   contact_id, position, map_key, value, label, contexts_json, pref
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                  contactId,
                  i,
                  link.mapKey ?? null,
                  link.value,
                  link.label ?? null,
                  JSON.stringify(link.contexts ?? []),
                  link.pref ?? null,
                ],
              );
            }
          }

          if (Array.isArray(c.anniversaries)) {
            for (let i = 0; i < c.anniversaries.length; i += 1) {
              const anniversary = c.anniversaries[i];
              const partial = anniversary.date.kind === 'partial' ? anniversary.date : null;
              const timestamp = anniversary.date.kind === 'timestamp' ? anniversary.date : null;
              await tx.run(
                `INSERT INTO contact_anniversaries(
                   contact_id, position, map_key, kind, date_kind,
                   date_year, date_month, date_day, date_utc
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  contactId,
                  i,
                  anniversary.mapKey ?? null,
                  anniversary.kind,
                  anniversary.date.kind,
                  partial?.year ?? null,
                  partial?.month ?? null,
                  partial?.day ?? null,
                  timestamp?.utc ?? null,
                ],
              );
            }
          }

          if (Array.isArray(c.notes)) {
            for (let i = 0; i < c.notes.length; i += 1) {
              const note = c.notes[i];
              await tx.run(
                `INSERT INTO contact_notes(contact_id, position, map_key, value)
                 VALUES (?, ?, ?, ?)`,
                [contactId, i, note.mapKey ?? null, note.value],
              );
            }
          }

          if (Array.isArray(c.organizations)) {
            for (let i = 0; i < c.organizations.length; i += 1) {
              const organization = c.organizations[i];
              await tx.run(
                `INSERT INTO contact_organizations(
                   contact_id, position, map_key, name, contexts_json
                 ) VALUES (?, ?, ?, ?, ?)`,
                [
                  contactId,
                  i,
                  organization.mapKey ?? null,
                  organization.name ?? null,
                  JSON.stringify(organization.contexts ?? []),
                ],
              );
              for (
                let unitIndex = 0;
                unitIndex < (organization.units ?? []).length;
                unitIndex += 1
              ) {
                const unit = organization.units[unitIndex];
                await tx.run(
                  `INSERT INTO contact_organization_units(
                     contact_id, organization_position, position, value
                   ) VALUES (?, ?, ?, ?)`,
                  [contactId, i, unitIndex, unit.value],
                );
              }
            }
          }

          if (Array.isArray(c.titles)) {
            for (let i = 0; i < c.titles.length; i += 1) {
              const title = c.titles[i];
              await tx.run(
                `INSERT INTO contact_titles(
                   contact_id, position, map_key, value, kind, organization_map_key
                 ) VALUES (?, ?, ?, ?, ?, ?)`,
                [
                  contactId,
                  i,
                  title.mapKey ?? null,
                  title.value,
                  title.kind,
                  title.organizationMapKey ?? null,
                ],
              );
            }
          }
          if (Array.isArray(c.media)) {
            for (let i = 0; i < c.media.length; i += 1) {
              const media = c.media[i];
              await tx.run(
                `INSERT INTO contact_media(
                   contact_id, position, map_key, kind, blob_id, uri, media_type, pref
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  contactId,
                  i,
                  media.mapKey,
                  media.kind,
                  media.blobId ?? null,
                  media.uri ?? null,
                  media.mediaType ?? null,
                  media.pref ?? null,
                ],
              );
            }
          }
          // Search tokens are replaced rather than added to, so renaming a
          // contact stops matching the name it used to have (CS-3.2). A
          // deleted card keeps none: it is not a suggestion.
          await tx.run('DELETE FROM contact_search_tokens WHERE contact_id = ?', [contactId]);
          if (!c.isDeleted) {
            const tokens = nameTokens(
              c.displayName, c.fullName, c.givenName, c.familyName, c.organization,
              ...(c.organizations ?? []).flatMap((organization) => [
                organization.name,
                ...(organization.units ?? []).map((unit) => unit.value),
              ]),
              ...(c.titles ?? []).map((title) => title.value),
              ...(c.nicknames ?? []),
            );
            for (const token of tokens) {
              await tx.run(
                `INSERT OR IGNORE INTO contact_search_tokens(contact_id, account_id, token)
                 VALUES (?, ?, ?)`,
                [contactId, accountId, token],
              );
            }
          }
        }
      });
      if (broadcast) broadcaster.touch(TABLE_FAMILIES.CONTACTS);
      return { upserted: contacts.length };
    },

    /**
     * Remove the contacts a completed full sync did not see.
     *
     * A card the server no longer has is named by no page of the sweep's
     * own generation, and a sync that did not finish must not call: the
     * caller is responsible for only reaching here once every page
     * succeeded (CS-4.2). Soft delete, to match the `destroyed` path.
     *
     * The `remote_id IS NOT NULL` clause is inert today — the column is
     * declared NOT NULL — and is kept for the case it is written against:
     * a contact created locally and not yet pushed has no remote id, and
     * carries generation 0, so the first sync to run after it would
     * otherwise sweep it. Making that column nullable is what turns the
     * clause on; nothing currently inserts such a row.
     */
    [DB_RPC.CONTACT_SWEEP_STALE]: async ({ accountId, generation }) => {
      if (!Number.isFinite(generation) || generation <= 0) {
        throw new Error('CONTACT_SWEEP_STALE requires the generation the sync stamped');
      }
      const swept = await engine.transaction(async (tx) => {
        const result = await tx.run(
          `UPDATE contacts SET is_deleted = 1, updated_at = ?
            WHERE account_id = ?
              AND is_deleted = 0
              AND sync_generation < ?
              AND remote_id IS NOT NULL`,
          [now(), accountId, generation],
        );
        // A card the server no longer has must leave the name index with it.
        // Written as "every deleted contact in the account" so it is
        // idempotent rather than dependent on what this pass changed.
        await tx.run(
          `DELETE FROM contact_search_tokens
            WHERE contact_id IN (
                    SELECT id FROM contacts WHERE account_id = ? AND is_deleted = 1
                  )`,
          [accountId],
        );
        return result?.changes ?? 0;
      });
      if (swept > 0) broadcaster.touch(TABLE_FAMILIES.CONTACTS);
      return { swept };
    },

    /**
     * Soft-delete contacts by remote id after the server cards have been
     * destroyed — one id or a batch, so ContactCard/changes destroyed
     * handling goes through here too rather than around it. Soft delete
     * (rather than a row delete) lets the autocomplete / list queries
     * filter on is_deleted; the search tokens go in the same transaction,
     * because a deleted card is not a suggestion (CS-3.2).
     */
    [DB_RPC.CONTACT_DELETE_LOCAL]: async ({
      accountId, remoteId = null, remoteIds = null, broadcast = true,
    }) => {
      const ids = remoteIds ?? (remoteId == null ? [] : [remoteId]);
      if (ids.length === 0) {
        if (broadcast) broadcaster.touch(TABLE_FAMILIES.CONTACTS);
        return { deleted: 0 };
      }
      const placeholders = ids.map(() => '?').join(',');
      const deleted = await engine.transaction(async (tx) => {
        const result = await tx.run(
          `UPDATE contacts SET is_deleted = 1, updated_at = ?
             WHERE account_id = ? AND remote_id IN (${placeholders})`,
          [now(), accountId, ...ids],
        );
        await tx.run(
          `DELETE FROM contact_search_tokens
            WHERE contact_id IN (
                    SELECT id FROM contacts
                     WHERE account_id = ? AND remote_id IN (${placeholders})
                  )`,
          [accountId, ...ids],
        );
        return result?.changes ?? 0;
      });
      if (broadcast) broadcaster.touch(TABLE_FAMILIES.CONTACTS);
      return { deleted };
    },

    [DB_RPC.CONTACT_AUTOCOMPLETE]: async (params) =>
      autocompleteRecipients(engine, params),

    [DB_RPC.CONTACT_TRASH_LIST]: async ({ accountId }) =>
      engine.all(
        `SELECT id, uid, prior_remote_id, display_name, primary_email,
                trashed_at, expires_at, status
           FROM contacts_trash
          WHERE account_id = ? AND status = 'trashed'
          ORDER BY trashed_at DESC, id DESC`,
        [accountId],
      ),

    [DB_RPC.CONTACT_TRASH_GET]: async ({ accountId, trashId }) => {
      const row = await engine.get(
        `SELECT id, uid, prior_remote_id, original_addressbook_ids_json,
                snapshot_json, media_json, display_name, primary_email,
                trashed_at, expires_at, status, lifecycle_updated_at
           FROM contacts_trash
          WHERE account_id = ? AND id = ?
            AND status = 'trashed'`,
        [accountId, trashId],
      );
      if (!row) return null;
      const emails = await engine.all(
        `SELECT email_key FROM contacts_trash_emails
          WHERE trash_id = ? ORDER BY position`,
        [trashId],
      );
      return contactTrashDetailFromRow(
        row,
        emails.map((email) => String(email.email_key)),
      );
    },

    [DB_RPC.CONTACT_TRASH_GET_MANY]: async ({ accountId, trashIds }) => {
      const ids = numericUnique(trashIds ?? []);
      if (ids.length === 0) return [];
      const byId = new Map<number, any>();
      const emailKeys = new Map<number, string[]>();
      const chunkSize = 250;
      for (let offset = 0; offset < ids.length; offset += chunkSize) {
        const chunk = ids.slice(offset, offset + chunkSize);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = await engine.all(
          `SELECT id, uid, prior_remote_id, original_addressbook_ids_json,
                  snapshot_json, media_json, display_name, primary_email,
                  trashed_at, expires_at, status, lifecycle_updated_at
             FROM contacts_trash
            WHERE account_id = ? AND id IN (${placeholders})`,
          [accountId, ...chunk],
        );
        for (const row of rows) byId.set(Number(row.id), row);
        const emailRows = await engine.all(
          `SELECT trash_id, email_key
             FROM contacts_trash_emails
            WHERE account_id = ? AND trash_id IN (${placeholders})
            ORDER BY trash_id, position`,
          [accountId, ...chunk],
        );
        for (const email of emailRows) {
          const trashId = Number(email.trash_id);
          const keys = emailKeys.get(trashId) ?? [];
          keys.push(String(email.email_key));
          emailKeys.set(trashId, keys);
        }
      }
      return ids.map((trashId): ContactTrashLookup => {
        const row = byId.get(trashId);
        if (!row) return { trashId, status: 'missing' };
        if (row.status !== 'trashed') return { trashId, status: 'inactive' };
        try {
          return {
            trashId,
            status: 'active',
            detail: contactTrashDetailFromRow(row, emailKeys.get(trashId) ?? []),
          };
        } catch {
          return {
            trashId,
            status: 'unreadable',
            errorType: 'invalidTrashSnapshot',
          };
        }
      });
    },

    [DB_RPC.CONTACT_TRASH_GET_DOCUMENT]: async ({ accountId }) => {
      const current = await loadContactsTrashInTx(engine, accountId);
      return { doc: current.document };
    },

    [DB_RPC.CONTACT_TRASH_GET_SHARDS]: async ({
      accountId,
      shardNames = null,
      dirtyOnly = false,
      metadataOnly = false,
    }) => {
      const names = Array.isArray(shardNames)
        ? [...new Set(shardNames.filter((name) => typeof name === 'string' && name))]
        : null;
      if (names?.length === 0) return [];
      const whereNames = names
        ? ` AND shard_name IN (${names.map(() => '?').join(',')})`
        : '';
      const rows = await engine.all(
        `SELECT shard_name, ${metadataOnly ? '' : 'doc_json,'}
                remote_node_id, remote_blob_id,
                dirty, local_revision
           FROM contacts_trash_documents
          WHERE account_id = ?
            ${dirtyOnly ? 'AND dirty = 1' : ''}
            ${whereNames}
          ORDER BY shard_name`,
        [accountId, ...(names ?? [])],
      );
      return rows.map((row: any) => ({
        shardName: String(row.shard_name),
        ...(!metadataOnly ? { doc: parseContactsTrashDocument(row.doc_json) } : {}),
        remoteNodeId: row.remote_node_id ?? null,
        remoteBlobId: row.remote_blob_id ?? null,
        dirty: Number(row.dirty) === 1,
        localRevision: Number(row.local_revision),
      }));
    },

    [DB_RPC.CONTACT_TRASH_MERGE_REMOTE_SHARDS]: async ({
      accountId,
      shards,
      ensurePush = true,
      finalize = true,
    }) => {
      const ts = now();
      const result = await engine.transaction(async (tx) => {
        let localNewer = false;
        for (const shard of shards ?? []) {
          const shardName = typeof shard?.shardName === 'string' ? shard.shardName : '';
          if (!shardName) throw new Error('contactTrash.mergeRemoteShards requires a shard name');
          const existing = await tx.get(
            `SELECT doc_json, dirty, local_revision
               FROM contacts_trash_documents
              WHERE account_id = ? AND shard_name = ?`,
            [accountId, shardName],
          );
          const isLegacy = shard.legacy === true;
          const remoteDocument = isLegacy
            ? normalizeContactsTrashDocument(shard.doc)
            : normalizeContactsTrashShardDocument(shard.doc);
          const merged = isLegacy || !existing
            ? { document: remoteDocument, localNewer: false }
            : mergeContactsTrashShardDocuments(
              parseContactsTrashDocument(existing.doc_json),
              remoteDocument,
            );
          const serialized = JSON.stringify(merged.document);
          const changed = !existing || existing.doc_json !== serialized;
          const dirty = !isLegacy
            && (Number(existing?.dirty) === 1 || merged.localNewer);
          if (merged.localNewer) localNewer = true;
          await tx.run(
            `INSERT INTO contacts_trash_documents(
               account_id, shard_name, doc_json, remote_node_id, remote_blob_id,
               dirty, local_revision, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
             ON CONFLICT(account_id, shard_name) DO UPDATE SET
               doc_json = excluded.doc_json,
               remote_node_id = excluded.remote_node_id,
               remote_blob_id = excluded.remote_blob_id,
               dirty = excluded.dirty,
               local_revision = CASE
                 WHEN contacts_trash_documents.doc_json <> excluded.doc_json
                   THEN contacts_trash_documents.local_revision + 1
                 ELSE contacts_trash_documents.local_revision
               END,
               updated_at = excluded.updated_at`,
            [
              accountId,
              shardName,
              serialized,
              shard.remoteNodeId ?? null,
              shard.remoteBlobId ?? null,
              dirty ? 1 : 0,
              ts,
            ],
          );
          if (changed && dirty) localNewer = true;
        }
        if (!finalize) {
          return {
            doc: null,
            localNewer,
            touchedShards: [],
            mutation: null,
          };
        }
        let current = await loadContactsTrashInTx(tx, accountId);
        const expired: ContactTrashDocumentEntry[] = [];
        for (const entry of Object.values(current.document.entries)) {
          if (entry.status === 'trashed' && entry.expiresAt <= ts) {
            expired.push(contactsTrashTombstone(
              entry,
              'purged',
              Math.max(ts, entry.updatedAt + 1),
            ));
            localNewer = true;
          }
        }
        const touchedShards = await appendContactsTrashRecordsInTx(
          tx,
          accountId,
          expired,
          ts,
          {
            lane: 'tombstone',
            maxBytes: CONTACTS_TRASH_MAX_TOMBSTONE_SHARD_BYTES,
          },
        );
        if (expired.length > 0) current = await loadContactsTrashInTx(tx, accountId);
        const document = await persistContactsTrashInTx(tx, accountId, current.document, ts);
        const dirtyShard = await tx.get(
          `SELECT 1 AS present
             FROM contacts_trash_documents
            WHERE account_id = ? AND dirty = 1
            LIMIT 1`,
          [accountId],
        );
        const mutation = ensurePush && (localNewer || dirtyShard != null)
          ? await ensureContactsTrashPushInTx(tx, accountId, ts)
          : null;
        return {
          doc: document,
          localNewer,
          touchedShards,
          mutation,
        };
      });
      broadcaster.touch(TABLE_FAMILIES.CONTACTS_TRASH);
      if (result.mutation) {
        broadcaster.touch(TABLE_FAMILIES.MUTATIONS);
        notifyMutation(accountId, result.mutation.id);
      }
      return result;
    },

    [DB_RPC.CONTACT_TRASH_PUT_ENTRIES]: async ({
      accountId,
      entries,
      ensurePush = false,
      maxBytes = CONTACTS_TRASH_MAX_DOCUMENT_BYTES,
      singleShard = false,
    }) => {
      const ts = now();
      const result = await engine.transaction(async (tx) => {
        const current = await loadContactsTrashInTx(tx, accountId);
        const appended: ContactTrashDocumentEntry[] = [];
        const requiredShards = new Set<string>();
        const incomingRemoteIds = new Map<string, string>();
        for (const value of entries ?? []) {
          const entry = normalizeContactTrashEntry(value);
          if (!entry) throw new Error('contactTrash.putEntries received an invalid entry');
          const existing = current.document.entries[entry.uid];
          const incomingRemoteId = incomingRemoteIds.get(entry.uid);
          if (
            (incomingRemoteId != null && incomingRemoteId !== entry.remoteId)
            || (
              existing?.status === 'trashed'
              && existing.remoteId !== entry.remoteId
            )
          ) {
            throw ambiguousContactsTrashUid();
          }
          incomingRemoteIds.set(entry.uid, entry.remoteId);
          if (existing) {
            const logicalChange = contactsTrashEntryFingerprint(entry, false)
              !== contactsTrashEntryFingerprint(existing, false);
            if (!logicalChange) {
              const serialized = JSON.stringify(existing);
              for (const shard of current.shards) {
                if (
                  shard.dirty
                  && Object.values(shard.document.entries)
                    .some((record) => JSON.stringify(record) === serialized)
                ) {
                  requiredShards.add(shard.shardName);
                }
              }
              continue;
            }
            entry.updatedAt = Math.max(ts, existing.updatedAt + 1, entry.updatedAt);
          }
          appended.push(entry);
        }
        const touchedShards = await appendContactsTrashRecordsInTx(
          tx,
          accountId,
          appended,
          ts,
          { maxBytes, singleShard },
        );
        for (const shardName of touchedShards) requiredShards.add(shardName);
        if (
          singleShard
          && appended.length > 0
          && requiredShards.size > 1
        ) {
          throw contactsTrashGroupTooLarge();
        }
        const updated = appended.length > 0
          ? await loadContactsTrashInTx(tx, accountId)
          : current;
        const saved = await persistContactsTrashInTx(
          tx,
          accountId,
          updated.document,
          ts,
        );
        const mutation = ensurePush && touchedShards.length > 0
          ? await ensureContactsTrashPushInTx(tx, accountId, ts)
          : null;
        return { doc: saved, touchedShards: [...requiredShards], mutation };
      });
      broadcaster.touch(TABLE_FAMILIES.CONTACTS_TRASH);
      if (result.mutation) {
        broadcaster.touch(TABLE_FAMILIES.MUTATIONS);
        notifyMutation(accountId, result.mutation.id);
      }
      return result;
    },

    [DB_RPC.CONTACT_TRASH_ROLLBACK_ENTRIES]: async ({
      accountId,
      stagedEntries,
    }) => {
      const staged = new Map<string, ContactTrashDocumentEntry>();
      for (const value of stagedEntries ?? []) {
        const entry = normalizeContactTrashEntry(value);
        if (!entry) throw new Error('contactTrash.rollbackEntries received an invalid staged entry');
        staged.set(entry.uid, entry);
      }
      const ts = now();
      const result = await engine.transaction(async (tx) => {
        const current = await loadContactsTrashInTx(tx, accountId);
        const rollback: ContactTrashDocumentEntry[] = [];
        for (const [uid, stagedEntry] of staged) {
          if (JSON.stringify(current.document.entries[uid]) !== JSON.stringify(stagedEntry)) {
            continue;
          }
          rollback.push(contactsTrashTombstone(
            stagedEntry,
            'purged',
            Math.max(ts, stagedEntry.updatedAt + 1),
          ));
        }
        if (rollback.length === 0) return { changed: false, doc: current.document };
        const touchedShards = await appendContactsTrashRecordsInTx(
          tx,
          accountId,
          rollback,
          ts,
          {
            lane: 'tombstone',
            maxBytes: CONTACTS_TRASH_MAX_TOMBSTONE_SHARD_BYTES,
          },
        );
        const updated = await loadContactsTrashInTx(tx, accountId);
        const doc = await persistContactsTrashInTx(tx, accountId, updated.document, ts);
        return { changed: true, doc, touchedShards };
      });
      if (result.changed) broadcaster.touch(TABLE_FAMILIES.CONTACTS_TRASH);
      return result;
    },

    [DB_RPC.CONTACT_TRASH_SET_STATUS]: async ({
      accountId,
      trashIds,
      status,
      ensurePush = false,
    }) => {
      if (status !== 'restored' && status !== 'purged') {
        throw new Error('contactTrash.setStatus requires a tombstone status');
      }
      const ids = numericUnique(trashIds ?? []);
      const ts = now();
      const result = await engine.transaction(async (tx) => {
        const current = await loadContactsTrashInTx(tx, accountId);
        if (ids.length === 0) {
          return {
            doc: current.document,
            changedIds: [],
            touchedShards: [],
            mutation: null,
          };
        }
        const rows = await tx.all(
          `SELECT id, uid FROM contacts_trash
            WHERE account_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
          [accountId, ...ids],
        );
        const changedIds: number[] = [];
        const tombstones: ContactTrashDocumentEntry[] = [];
        for (const row of rows) {
          const entry = current.document.entries[row.uid] as ContactTrashDocumentEntry | undefined;
          if (!entry || entry.status !== 'trashed') continue;
          tombstones.push(contactsTrashTombstone(
            entry,
            status,
            Math.max(ts, entry.updatedAt + 1),
          ));
          changedIds.push(Number(row.id));
        }
        const touchedShards = await appendContactsTrashRecordsInTx(
          tx,
          accountId,
          tombstones,
          ts,
          {
            lane: 'tombstone',
            maxBytes: CONTACTS_TRASH_MAX_TOMBSTONE_SHARD_BYTES,
          },
        );
        const updated = tombstones.length > 0
          ? await loadContactsTrashInTx(tx, accountId)
          : current;
        const saved = await persistContactsTrashInTx(
          tx,
          accountId,
          updated.document,
          ts,
        );
        const mutation = ensurePush && changedIds.length > 0
          ? await ensureContactsTrashPushInTx(tx, accountId, ts)
          : null;
        return { doc: saved, changedIds, touchedShards, mutation };
      });
      broadcaster.touch(TABLE_FAMILIES.CONTACTS_TRASH);
      if (result.mutation) {
        broadcaster.touch(TABLE_FAMILIES.MUTATIONS);
        notifyMutation(accountId, result.mutation.id);
      }
      return result;
    },

    [DB_RPC.CONTACT_TRASH_ENSURE_PUSH]: async ({ accountId, force = false }) => {
      const ts = now();
      const result = await engine.transaction(async (tx) => {
        const dirty = await tx.get(
          `SELECT 1 AS present
             FROM contacts_trash_documents
            WHERE account_id = ? AND dirty = 1
            LIMIT 1`,
          [accountId],
        );
        if (!dirty && !force) {
          return { mutation: null };
        }
        return { mutation: await ensureContactsTrashPushInTx(tx, accountId, ts) };
      });
      if (result.mutation) {
        broadcaster.touch(TABLE_FAMILIES.MUTATIONS);
        notifyMutation(accountId, result.mutation.id);
      }
      return result;
    },

    [DB_RPC.CONTACT_TRASH_CONFIRM_SHARD]: async ({
      accountId,
      shardName,
      remoteNodeId,
      remoteBlobId,
      localRevision,
    }) => {
      const result = await engine.transaction(async (tx) => {
        await tx.run(
          `UPDATE contacts_trash_documents
              SET remote_node_id = ?, remote_blob_id = ?, updated_at = ?
            WHERE account_id = ? AND shard_name = ?`,
          [remoteNodeId, remoteBlobId, now(), accountId, shardName],
        );
        const clean = await tx.run(
          `UPDATE contacts_trash_documents
              SET dirty = 0
            WHERE account_id = ? AND shard_name = ?
              AND local_revision = ?`,
          [accountId, shardName, localRevision],
        );
        return { clean: (clean.changes ?? 0) > 0 };
      });
      return result;
    },

    /**
     * Rebuild contact ranking evidence from the latest bounded Sent window.
     *
     * Recipient identity lives only in ContactCards. This cache is replaced
     * atomically, so it has no progress cursor and can never make a deleted
     * contact reappear as a suggestion.
     */
    [DB_RPC.RECIPIENT_USAGE_REBUILD]: async ({ accountId, limit = 300 }) => {
      const result = await rebuildRecipientUsage(engine, { accountId, limit });
      broadcaster.touch(TABLE_FAMILIES.CONTACTS);
      return result;
    },

    /**
     * Cross the submission checkpoint and enqueue its trusted-contact effect
     * in one SQLite transaction. A crash can leave both writes or neither,
     * never a delivered send whose recipients are permanently uncollected.
     */
    [DB_RPC.SEND_ACCEPT_AND_QUEUE_TRUST]: async ({
      accountId, rowId, checkpoint, senders,
    }) => {
      const ts = now();
      const alreadyQueued = checkpoint?.trustedRecipientsQueued === true;
      const saved = {
        ...checkpoint,
        trustedRecipientsQueued: true,
      };
      let mutationId: number | null = null;
      await engine.transaction(async (tx) => {
        if (!alreadyQueued && Array.isArray(senders) && senders.length > 0) {
          const inserted = await tx.run(
            `INSERT INTO pending_mutations(
               account_id, mutation_type, local_status, target_message_id,
               request_json, created_at, updated_at
             ) VALUES (?, ?, 'pending', NULL, ?, ?, ?)`,
            [
              accountId,
              MUTATION_TYPE.WHITELIST_SENDER,
              JSON.stringify({ senders }),
              ts,
              ts,
            ],
          );
          mutationId = Number(inserted.lastInsertRowid);
        }
        const updated = await tx.run(
          `UPDATE pending_mutations
              SET phase = ?, server_response_json = ?, attempts = 0, updated_at = ?
            WHERE id = ? AND account_id = ?`,
          [SEND_PHASE.SUBMITTED, JSON.stringify(saved), ts, rowId, accountId],
        );
        if ((updated?.changes ?? 0) !== 1) {
          throw new Error('accepted send row was not found');
        }
      });
      broadcaster.touch(TABLE_FAMILIES.MUTATIONS);
      if (mutationId != null) {
        try {
          const maybePromise = onMutationInserted({ accountId, mutationId });
          if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise.catch(() => {});
          }
        } catch {
          // The durable row is enough; a later runner sweep will pick it up.
        }
      }
      return saved;
    },

    [DB_RPC.SETTINGS_GET]: async ({ accountId }) => {
      const row = await engine.get(
        'SELECT doc_json, remote_node_id FROM user_settings WHERE account_id = ?',
        [accountId],
      );
      return {
        doc: parseSettingsDocument(row?.doc_json),
        remoteNodeId: row?.remote_node_id ?? null,
      };
    },

    [DB_RPC.SETTINGS_APPLY_PATCH]: async ({ accountId, patch }) => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('settings.applyPatch requires an object patch');
      }
      const serializedPatch = JSON.stringify(patch);
      const safePatch = JSON.parse(serializedPatch);
      const ts = now();
      const result = await engine.transaction(async (tx) => {
        const current = await loadSettingsInTx(tx, accountId);
        const document = normalizeSettingsDocument(current.document);
        for (const [key, value] of Object.entries(safePatch)) {
          document.settings[key] = value;
          document.updatedAt[key] = Math.max(ts, (document.updatedAt[key] ?? 0) + 1);
        }
        await upsertSettingsInTx(
          tx,
          accountId,
          document,
          current.remoteNodeId,
          ts,
        );
        const mutation = await ensureSettingsPushInTx(tx, accountId, ts);
        return { doc: document, remoteNodeId: current.remoteNodeId, mutation };
      });
      broadcaster.touch(TABLE_FAMILIES.SETTINGS);
      broadcaster.touch(TABLE_FAMILIES.MUTATIONS);
      notifyMutation(accountId, result.mutation.id);
      return result;
    },

    [DB_RPC.SETTINGS_MERGE_REMOTE]: async ({
      accountId,
      doc,
      remoteNodeId,
      ensurePush = true,
    }) => {
      const ts = now();
      const result = await engine.transaction(async (tx) => {
        const current = await loadSettingsInTx(tx, accountId);
        const merged = mergeSettingsDocuments(current.document, doc);
        await upsertSettingsInTx(
          tx,
          accountId,
          merged.document,
          remoteNodeId ?? null,
          ts,
        );
        const mutation = ensurePush && merged.localNewer
          ? await ensureSettingsPushInTx(tx, accountId, ts)
          : null;
        return {
          doc: merged.document,
          remoteNodeId: remoteNodeId ?? null,
          localNewer: merged.localNewer,
          mutation,
        };
      });
      broadcaster.touch(TABLE_FAMILIES.SETTINGS);
      if (result.mutation) {
        broadcaster.touch(TABLE_FAMILIES.MUTATIONS);
        notifyMutation(accountId, result.mutation.id);
      }
      return result;
    },

    [DB_RPC.SETTINGS_ENSURE_PUSH]: async ({ accountId }) => {
      const ts = now();
      const result = await engine.transaction(async (tx) => {
        const current = await loadSettingsInTx(tx, accountId);
        if (Object.keys(current.document.settings).length === 0) {
          return { mutation: null };
        }
        return { mutation: await ensureSettingsPushInTx(tx, accountId, ts) };
      });
      if (result.mutation) {
        broadcaster.touch(TABLE_FAMILIES.MUTATIONS);
        notifyMutation(accountId, result.mutation.id);
      }
      return result;
    },

    [DB_RPC.SETTINGS_SET_REMOTE_NODE]: async ({ accountId, remoteNodeId }) => {
      const result = await engine.run(
        `UPDATE user_settings
            SET remote_node_id = ?, updated_at = ?
          WHERE account_id = ?`,
        [remoteNodeId ?? null, now(), accountId],
      );
      return { updated: result.changes ?? 0 };
    },

    [DB_RPC.SYNC_STATE_GET]: async ({ accountId, objectType, scope = '' }) =>
      engine.get(
        `SELECT * FROM sync_states WHERE account_id = ? AND object_type = ? AND scope = ?`,
        [accountId, objectType, scope],
      ),

    [DB_RPC.SYNC_STATE_SET]: async ({ accountId, objectType, scope = '', state }) => {
      const ts = now();
      await engine.run(
        `INSERT INTO sync_states(account_id, object_type, scope, state, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id, object_type, scope) DO UPDATE SET
            state = excluded.state,
            updated_at = excluded.updated_at`,
        [accountId, objectType, scope, state, ts],
      );
      broadcaster.touch(TABLE_FAMILIES.SYNC);
    },

    [DB_RPC.IDENTITY_MUTATION_ENSURE]: async (input) => {
      const identityMutationTypes = new Set([
        MUTATION_TYPE.CREATE_IDENTITY,
        MUTATION_TYPE.UPDATE_IDENTITY,
        MUTATION_TYPE.DELETE_IDENTITY,
      ]);
      if (
        !identityMutationTypes.has(input.mutationType)
        || typeof input.operationId !== 'string'
        || !input.operationId
      ) {
        throw new Error('identity.ensureMutation requires an Identity mutation operation');
      }

      const ts = now();
      let ensured: {
        id: number;
        reused: boolean;
        requestMatches: boolean;
        storedRequestJson: string;
        errorType?: string;
      } | null = null;
      await engine.transaction(async (tx) => {
        const rows = await tx.all(
          `SELECT *
             FROM pending_mutations
            WHERE account_id = ?
              AND mutation_type = ?
              AND local_status IN ('pending','retry','in_flight','conflicted')
            ORDER BY id`,
          [input.accountId, input.mutationType],
        );
        for (const row of rows) {
          let request;
          try {
            request = JSON.parse(row.request_json);
          } catch {
            continue;
          }
          if (request?.operationId !== input.operationId) continue;
          const requestMatches = JSON.stringify(request) === JSON.stringify(
            JSON.parse(input.requestJson),
          );
          const prewrite = row.phase == null || row.phase === SEND_PHASE.QUEUED;
          if (
            prewrite
            && !requestMatches
            && ['pending', 'retry', 'failed', 'conflicted'].includes(row.local_status)
          ) {
            await tx.run(
              `UPDATE pending_mutations
                  SET local_status = 'pending',
                      request_json = ?,
                      attempts = 0,
                      not_before = NULL,
                      error_json = NULL,
                      updated_at = ?
                WHERE id = ?`,
              [input.requestJson, ts, row.id],
            );
            ensured = {
              id: Number(row.id),
              reused: true,
              requestMatches: true,
              storedRequestJson: input.requestJson,
            };
            return;
          }
          if (row.local_status !== 'conflicted') {
            ensured = {
              id: Number(row.id),
              reused: true,
              requestMatches,
              storedRequestJson: row.request_json,
            };
            return;
          }
          let recordedError;
          try {
            recordedError = JSON.parse(row.error_json ?? 'null');
          } catch {
            recordedError = null;
          }
          const errorType = typeof recordedError?.type === 'string'
            ? recordedError.type
            : undefined;
          const recoverable = row.phase === SEND_PHASE.CACHE_PENDING
            || (prewrite && recordedError && recordedError.terminal !== true);
          if (!recoverable) {
            ensured = {
              id: Number(row.id),
              reused: true,
              requestMatches,
              storedRequestJson: row.request_json,
              ...(errorType ? { errorType } : {}),
            };
            return;
          }
          let checkpoint;
          try {
            checkpoint = JSON.parse(row.server_response_json ?? 'null');
          } catch {
            checkpoint = null;
          }
          const validCheckpoint = row.phase !== SEND_PHASE.CACHE_PENDING
            || typeof checkpoint?.identityRemoteId === 'string';
          if (!validCheckpoint) {
            ensured = {
              id: Number(row.id),
              reused: true,
              requestMatches,
              storedRequestJson: row.request_json,
              errorType: IDENTITY_ERROR.AMBIGUOUS_CREATE,
            };
            return;
          }
          if (row.phase === SEND_PHASE.CACHE_PENDING) checkpoint.attempts = 0;
          await tx.run(
            `UPDATE pending_mutations
                SET local_status = 'retry',
                    attempts = 0,
                    not_before = NULL,
                    error_json = NULL,
                    server_response_json = ?,
                    updated_at = ?
              WHERE id = ?`,
            [
              row.phase === SEND_PHASE.CACHE_PENDING
                ? JSON.stringify(checkpoint)
                : row.server_response_json,
              ts,
              row.id,
            ],
          );
          ensured = {
            id: Number(row.id),
            reused: true,
            requestMatches,
            storedRequestJson: row.request_json,
          };
          return;
        }

        const inserted = await tx.run(
          `INSERT INTO pending_mutations(
              account_id, mutation_type, local_status, target_message_id,
              request_json, optimistic_patch_json, server_response_json, error_json,
              created_at, updated_at
           ) VALUES (?, ?, 'pending', NULL, ?, NULL, NULL, NULL, ?, ?)`,
          [input.accountId, input.mutationType, input.requestJson, ts, ts],
        );
        ensured = {
          id: Number(inserted.lastInsertRowid),
          reused: false,
          requestMatches: true,
          storedRequestJson: input.requestJson,
        };
      });
      broadcaster.touch(TABLE_FAMILIES.MUTATIONS);
      try {
        const maybePromise = onMutationInserted({
          accountId: input.accountId,
          mutationId: ensured!.id,
        });
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.catch(() => {});
        }
      } catch {
        // The durable row is sufficient; another outbox wake will find it.
      }
      return ensured;
    },

    [DB_RPC.PENDING_MUTATION_INSERT]: async (input) => {
      const ts = now();
      // target_message_id has a FK to messages(id). If the caller
      // passes an id that no longer exists (e.g. a ghost row the
      // user double-clicked Delete on after the first click already
      // removed it from messages), the INSERT throws "FOREIGN KEY
      // constraint failed" and the UI sees an unhandled rejection.
      // Verify the FK target first and null it out so the mutation
      // can still be enqueued; the outbox will resolve via
      // request_json.messageId or report 'unknownMessage' cleanly.
      let targetMessageId = input.targetMessageId ?? null;
      if (targetMessageId != null) {
        const row = await engine.get(
          'SELECT id FROM messages WHERE id = ? AND account_id = ?',
          [targetMessageId, input.accountId],
        );
        if (!row) targetMessageId = null;
      }
      const result = await engine.run(
        `INSERT INTO pending_mutations(
            account_id, mutation_type, local_status, target_message_id,
            request_json, optimistic_patch_json, server_response_json, error_json,
            created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.accountId,
          input.mutationType,
          input.localStatus ?? 'pending',
          targetMessageId,
          input.requestJson,
          input.optimisticPatchJson ?? null,
          null,
          null,
          ts,
          ts,
        ],
      );
      broadcaster.touch(TABLE_FAMILIES.MUTATIONS);
      // Wake the outbox runner once the row is durably committed. The
      // hook is fire-and-forget: a thrown error or rejected promise
      // here must never fail the original insert (the row is already
      // in the DB and another notify path — startup sweep, state
      // change, periodic — will eventually pick it up).
      try {
        const maybePromise = onMutationInserted({
          accountId: input.accountId,
          mutationId: result.lastInsertRowid,
        });
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.catch(() => {});
        }
      } catch {
        // Swallow synchronous throws from the hook for the same reason.
      }
      return { id: result.lastInsertRowid };
    },

    [DB_RPC.PENDING_MUTATION_INSERT_MANY]: async ({ accountId, mutations = [] }) => {
      const items = (Array.isArray(mutations) ? mutations : [])
        .filter((item) => item?.mutationType && item?.requestJson);
      if (items.length === 0) return { ids: [] };
      const ts = now();
      const ids = [];
      await engine.transaction(async (tx) => {
        for (const item of items) {
          let targetMessageId = item.targetMessageId ?? null;
          if (targetMessageId != null) {
            const row = await tx.get(
              'SELECT id FROM messages WHERE id = ? AND account_id = ?',
              [targetMessageId, accountId],
            );
            if (!row) targetMessageId = null;
          }
          const result = await tx.run(
            `INSERT INTO pending_mutations(
                account_id, mutation_type, local_status, target_message_id,
                request_json, optimistic_patch_json, server_response_json, error_json,
                created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              accountId,
              item.mutationType,
              item.localStatus ?? 'pending',
              targetMessageId,
              item.requestJson,
              item.optimisticPatchJson ?? null,
              null,
              null,
              ts,
              ts,
            ],
          );
          ids.push(result.lastInsertRowid);
        }
      });
      broadcaster.touch(TABLE_FAMILIES.MUTATIONS);
      for (const mutationId of ids) {
        try {
          const maybePromise = onMutationInserted({ accountId, mutationId });
          if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise.catch(() => {});
          }
        } catch {
          // Same best-effort wakeup semantics as single insert.
        }
      }
      return { ids };
    },

    [DB_RPC.PENDING_MUTATION_LIST_PENDING]: async ({ accountId, limit = 50 }) =>
      engine.all(
        `SELECT * FROM pending_mutations
          WHERE account_id = ? AND local_status IN ('pending','retry')
          ORDER BY created_at LIMIT ?`,
        [accountId, limit],
      ),

    /**
     * Read the error fields a failed mutation row left behind. The
     * mail-store uses this to format a user-facing failure message
     * after runMutation reports `failed > 0`. `server_response_json`
     * rides along for sends: it holds the send checkpoint, whose
     * `emailRemoteId` tells the composer whether the message text
     * already exists on the server when the outcome is unknown.
     */
    [DB_RPC.PENDING_MUTATION_GET_ERROR]: async ({ mutationId }) => {
      if (mutationId == null) return null;
      const row = await engine.get(
        `SELECT mutation_type, local_status, error_json, server_response_json
           FROM pending_mutations WHERE id = ?`,
        [mutationId],
      );
      return row ?? null;
    },

    [DB_RPC.PENDING_MUTATION_RETRY]: async ({ accountId, mutationId }) => {
      const ts = now();
      const result = await engine.transaction(async (tx: any) => {
        const row = await tx.get(
          `SELECT error_json
             FROM pending_mutations
            WHERE id = ?
              AND account_id = ?
              AND mutation_type = ?
              AND local_status IN ('failed','conflicted','retry')`,
          [mutationId, accountId, MUTATION_TYPE.SAVE_DRAFT],
        );
        const error = jsonRecord(row?.error_json);
        if (error?.type === 'draftAbandonedPreserveCopies') {
          return { changes: 0 };
        }
        return tx.run(
          `UPDATE pending_mutations
              SET local_status = 'retry',
                  attempts = 0,
                  not_before = NULL,
                  error_json = NULL,
                  updated_at = ?
            WHERE id = ?
              AND account_id = ?
              AND mutation_type = ?
              AND local_status IN ('failed','conflicted','retry')`,
          [ts, mutationId, accountId, MUTATION_TYPE.SAVE_DRAFT],
        );
      });
      if ((result.changes ?? 0) > 0) {
        broadcaster.touch(TABLE_FAMILIES.MUTATIONS);
        try {
          const maybePromise = onMutationInserted({ accountId, mutationId });
          if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise.catch(() => {});
          }
        } catch {
          // The durable retry row is enough; a later runner pass will pick it up.
        }
      }
      return { retried: result.changes ?? 0 };
    },

    [DB_RPC.PENDING_MUTATION_ABANDON_DRAFT]: async ({
      accountId,
      mutationId,
      intent = 'keep-confirmed',
      confirmedEmailIds = [],
      draftSessionId = null,
      draftsFolderId = null,
    }) => {
      const result = await engine.transaction(async (tx: any) => {
        const row = await tx.get(
          `SELECT *
             FROM pending_mutations
            WHERE id = ? AND account_id = ? AND mutation_type = ?`,
          [mutationId, accountId, MUTATION_TYPE.SAVE_DRAFT],
        );
        if (!row) {
          return {
            abandoned: 0,
            converted: 0,
            parked: 0,
            inFlight: 0,
            mutationId: null,
          };
        }
        if (row.local_status === 'in_flight') {
          return {
            abandoned: 0,
            converted: 0,
            parked: 0,
            inFlight: 1,
            mutationId: null,
          };
        }
        const plan = draftAbandonPlan(row, intent, confirmedEmailIds, {
          draftSessionId,
          draftsFolderId,
        });
        if (plan.kind === 'park') {
          const parked = await tx.run(
            `UPDATE pending_mutations
                SET local_status = 'conflicted',
                    not_before = NULL,
                    error_json = ?,
                    updated_at = ?
              WHERE id = ? AND account_id = ? AND mutation_type = ?`,
            [
              JSON.stringify({
                type: 'draftAbandonedPreserveCopies',
                reason: plan.reason,
                terminal: true,
              }),
              now(),
              mutationId,
              accountId,
              MUTATION_TYPE.SAVE_DRAFT,
            ],
          );
          return {
            abandoned: 0,
            converted: 0,
            parked: parked.changes ?? 0,
            inFlight: 0,
            mutationId: null,
          };
        }
        if (plan.kind === 'delete') {
          const abandoned = await tx.run(
            `DELETE FROM pending_mutations
              WHERE id = ? AND account_id = ? AND mutation_type = ?`,
            [mutationId, accountId, MUTATION_TYPE.SAVE_DRAFT],
          );
          return {
            abandoned: abandoned.changes ?? 0,
            converted: 0,
            parked: 0,
            inFlight: 0,
            mutationId: null,
          };
        }
        const converted = await tx.run(
          `UPDATE pending_mutations
              SET mutation_type = ?,
                  local_status = 'pending',
                  target_message_id = NULL,
                  request_json = ?,
                  optimistic_patch_json = NULL,
                  server_response_json = ?,
                  error_json = NULL,
                  phase = NULL,
                  attempts = 0,
                  last_attempt_at = NULL,
                  not_before = NULL,
                  updated_at = ?
            WHERE id = ? AND account_id = ? AND mutation_type = ?`,
          [
            MUTATION_TYPE.DISCARD_DRAFT,
            JSON.stringify(plan.request),
            plan.preserveCheckpoint ? row.server_response_json : null,
            now(),
            mutationId,
            accountId,
            MUTATION_TYPE.SAVE_DRAFT,
          ],
        );
        return {
          abandoned: 0,
          converted: converted.changes ?? 0,
          parked: 0,
          inFlight: 0,
          mutationId: (converted.changes ?? 0) > 0 ? mutationId : null,
        };
      });
      if (result.abandoned > 0 || result.converted > 0 || result.parked > 0) {
        broadcaster.touch(TABLE_FAMILIES.MUTATIONS);
      }
      if (result.converted > 0) {
        try {
          const maybePromise = onMutationInserted({ accountId, mutationId });
          if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise.catch(() => {});
          }
        } catch {
          // The converted row is durable; a later runner pass will find it.
        }
      }
      return result;
    },

    [DB_RPC.SYNC_JOB_INSERT]: async (input) => {
      const ts = now();
      const result = await engine.run(
        `INSERT INTO sync_jobs(
            account_id, job_type, priority, payload_json,
            status, attempts, not_before, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
        [
          input.accountId,
          input.jobType,
          input.priority ?? 0,
          input.payloadJson ?? '{}',
          input.notBefore ?? null,
          ts,
          ts,
        ],
      );
      broadcaster.touch(TABLE_FAMILIES.SYNC);
      return { id: result.lastInsertRowid };
    },

    [DB_RPC.SYNC_JOB_NEXT_BATCH]: async ({ now: nowMs = Date.now(), limit = 10 } = {}) =>
      engine.all(
        `SELECT * FROM sync_jobs
          WHERE status = 'pending'
            AND (not_before IS NULL OR not_before <= ?)
          ORDER BY priority DESC, not_before, created_at
          LIMIT ?`,
        [nowMs, limit],
      ),
  };

  return h;
}

type DraftAbandonPlan =
  | { kind: 'delete' }
  | { kind: 'park'; reason: string }
  | {
      kind: 'convert';
      preserveCheckpoint: boolean;
      request: {
        draftSessionId: string | null;
        draftsFolderId: number | null;
        draftEmailIds: string[];
        probeRevision?: true;
      };
    };

function draftRemoteId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function draftRemoteIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((id) => !draftRemoteId(id))) return null;
  return [...new Set<string>(value)];
}

function exactDraftRemoteIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = draftRemoteIds(value);
  return ids && ids.length === value.length ? ids : null;
}

function jsonRecord(value: unknown): Record<string, any> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sameDraftIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

function draftAbandonPlan(
  row: any,
  intent: unknown,
  confirmedEmailIds: unknown,
  fallback: { draftSessionId: unknown; draftsFolderId: unknown },
): DraftAbandonPlan {
  const discardAll = intent === 'discard-all';
  const confirmed = draftRemoteIds(confirmedEmailIds) ?? [];
  const request = jsonRecord(row.request_json);
  const draftSessionId = typeof request?.draftSessionId === 'string'
    ? request.draftSessionId
    : (typeof fallback.draftSessionId === 'string' ? fallback.draftSessionId : null);
  const requestedFolderId = Number(request?.draftsFolderId ?? fallback.draftsFolderId);
  const draftsFolderId = Number.isSafeInteger(requestedFolderId) && requestedFolderId > 0
    ? requestedFolderId
    : null;
  if (row.phase == null) {
    if (row.server_response_json != null) {
      return { kind: 'park', reason: 'checkpointWithoutPhase' };
    }
    if (!discardAll || confirmed.length === 0) return { kind: 'delete' };
    return {
      kind: 'convert',
      preserveCheckpoint: false,
      request: {
        draftSessionId,
        draftsFolderId,
        draftEmailIds: confirmed,
      },
    };
  }
  if (row.phase === DRAFT_PHASE.CONFLICT) {
    return { kind: 'park', reason: 'checkpointConflict' };
  }
  if (!Object.values(DRAFT_PHASE).includes(row.phase)) {
    return { kind: 'park', reason: 'unrecognizedPhase' };
  }
  const phase = row.phase as (typeof DRAFT_PHASE)[keyof typeof DRAFT_PHASE];
  const checkpoint = jsonRecord(row.server_response_json);
  const baseEmailIds = exactDraftRemoteIds(checkpoint?.baseEmailIds);
  const pendingDestroyIds = exactDraftRemoteIds(checkpoint?.pendingDestroyIds);
  const preparedEmail = checkpoint?.preparedEmail;
  const successor = draftRemoteId(checkpoint?.newEmailId) ? checkpoint.newEmailId : null;
  const localSuccessor = Number.isSafeInteger(checkpoint?.localMessageId)
    && Number(checkpoint.localMessageId) > 0;
  const validSuccessor = checkpoint?.newEmailId == null || successor != null;
  const validLocalSuccessor = checkpoint?.localMessageId == null || localSuccessor;
  if (
    !checkpoint
    || !draftRemoteId(checkpoint.operationId)
    || !draftRemoteId(checkpoint.draftSessionId)
    || !Number.isSafeInteger(checkpoint.revision)
    || checkpoint.revision < 1
    || typeof checkpoint.payloadHash !== 'string'
    || !baseEmailIds
    || !pendingDestroyIds
    || !preparedEmail
    || typeof preparedEmail !== 'object'
    || Array.isArray(preparedEmail)
    || !draftRemoteId(checkpoint.revisionMessageId)
    || !validSuccessor
    || !validLocalSuccessor
  ) {
    return { kind: 'park', reason: 'unreadableCheckpoint' };
  }
  if (successor && pendingDestroyIds.includes(successor)) {
    return { kind: 'park', reason: 'successorPendingDestroy' };
  }
  let probeRevision = false;
  switch (phase) {
    case DRAFT_PHASE.QUEUED:
      if (successor || localSuccessor) {
        return { kind: 'park', reason: 'queuedHasSuccessor' };
      }
      if (!sameDraftIds(pendingDestroyIds, baseEmailIds)) {
        return { kind: 'park', reason: 'queuedDestroySetChanged' };
      }
      probeRevision = true;
      break;
    case DRAFT_PHASE.CREATED:
      if (!successor) return { kind: 'park', reason: 'createdMissingSuccessor' };
      if (localSuccessor) return { kind: 'park', reason: 'createdHasLocalSuccessor' };
      break;
    case DRAFT_PHASE.CACHE_PENDING:
    case DRAFT_PHASE.CLEANUP_PENDING:
      if (!successor) return { kind: 'park', reason: 'pendingMissingSuccessor' };
      if (!localSuccessor) return { kind: 'park', reason: 'pendingMissingLocalSuccessor' };
      break;
    case DRAFT_PHASE.CONFLICT:
      return { kind: 'park', reason: 'checkpointConflict' };
    default: {
      const unhandled: never = phase;
      return unhandled;
    }
  }
  const explicitIds = discardAll
    ? [...new Set([
        ...confirmed,
        ...baseEmailIds,
        ...pendingDestroyIds,
        ...(successor ? [successor] : []),
      ])]
    : (successor && !confirmed.includes(successor) ? [successor] : []);
  if (explicitIds.length === 0 && !probeRevision) return { kind: 'delete' };
  return {
    kind: 'convert',
    preserveCheckpoint: probeRevision,
    request: {
      draftSessionId,
      draftsFolderId,
      draftEmailIds: explicitIds,
      ...(probeRevision ? { probeRevision: true as const } : {}),
    },
  };
}

/**
 * The address-book ids `group_concat` returned, as numbers. A contact in no
 * book concatenates to null rather than an empty string.
 */
function splitIds(concatenated: unknown): number[] {
  if (typeof concatenated !== 'string' || concatenated === '') return [];
  return concatenated.split(',').map(Number);
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

interface RecipientUsage {
  count: number;
  lastSentAt: number;
}

/**
 * Replace ranking evidence with aggregates from the newest cached Sent
 * messages. Contact rows remain the only source of suggestions.
 */
async function rebuildRecipientUsage(
  engine: any,
  { accountId, limit }: { accountId: number; limit: number },
): Promise<{ scanned: number; ranked: number }> {
  const boundedLimit = Math.min(Math.max(Math.trunc(Number(limit) || 0), 1), 300);
  const messages = await engine.all(
    `SELECT m.id AS message_id,
            MAX(COALESCE(m.sent_at, fm.sort_sent_at)) AS sent_at
       FROM messages m
       JOIN folder_messages fm ON fm.message_id = m.id
       JOIN folders f ON f.id = fm.folder_id
      WHERE m.account_id = ?
        AND f.account_id = ?
        AND f.role = 'sent'
        AND COALESCE(m.sent_at, fm.sort_sent_at) IS NOT NULL
      GROUP BY m.id
      ORDER BY sent_at DESC, m.id DESC
      LIMIT ?`,
    [accountId, accountId, boundedLimit],
  );
  const contactRows = await engine.all(
    `SELECT DISTINCT ce.email_key
       FROM contact_emails ce
       JOIN contacts c ON c.id = ce.contact_id
      WHERE c.account_id = ?
        AND c.is_deleted = 0
        AND ce.email_key IS NOT NULL`,
    [accountId],
  );
  const contactKeys = new Set(contactRows.map((row) => String(row.email_key)));
  const owned = await ownedAddressKeys(engine, accountId);
  const messageIds = messages.map((row) => Number(row.message_id));
  const sentAtById = new Map<number, number>(
    messages.map((row) => [Number(row.message_id), Number(row.sent_at)]),
  );
  const addresses = messageIds.length === 0
    ? []
    : await engine.all(
      `SELECT message_id, kind, email
         FROM message_addresses
        WHERE message_id IN (${placeholdersFor(messageIds)})
          AND email IS NOT NULL`,
      messageIds,
    );
  const byMessage = new Map<number, any[]>();
  for (const row of addresses) {
    const messageId = Number(row.message_id);
    const list = byMessage.get(messageId) ?? [];
    list.push(row);
    byMessage.set(messageId, list);
  }

  const usage = new Map<string, RecipientUsage>();
  for (const [messageId, rows] of byMessage) {
    const sentByUser = rows.some(
      (row) => row.kind === 'from' && owned.has(addressKey(row.email)),
    );
    if (!sentByUser) continue;
    const sentAt = sentAtById.get(messageId);
    if (!sentAt) continue;
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.kind !== 'to' && row.kind !== 'cc' && row.kind !== 'bcc') continue;
      const key = addressKey(row.email);
      if (!key || owned.has(key) || !contactKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      const current = usage.get(key);
      if (current) {
        current.count += 1;
        current.lastSentAt = Math.max(current.lastSentAt, sentAt);
      } else {
        usage.set(key, { count: 1, lastSentAt: sentAt });
      }
    }
  }

  const entries = [...usage.entries()];
  await engine.transaction(async (tx) => {
    await tx.run('DELETE FROM recipient_usage WHERE account_id = ?', [accountId]);
    for (let offset = 0; offset < entries.length; offset += 200) {
      const chunk = entries.slice(offset, offset + 200);
      const values = chunk.map(() => '(?, ?, ?, ?)').join(', ');
      const params = chunk.flatMap(([key, value]) => [
        accountId, key, value.count, value.lastSentAt,
      ]);
      await tx.run(
        `INSERT INTO recipient_usage(account_id, email_key, send_count, last_sent_at)
         VALUES ${values}`,
        params,
      );
    }
  });
  return { scanned: messages.length, ranked: entries.length };
}

/**
 * The Email/query sort spec a JmapViewSort value stands for. The JSON
 * string of this spec is part of the query_views identity, so writers
 * (FOLDER_WINDOW_* batches) and readers must agree on it exactly.
 */
function mailboxViewSortSpec(sort) {
  if (sort === 'sent') return { property: 'sentAt', isAscending: false };
  // Soonest scheduled send first.
  if (sort === 'scheduled') return { property: 'sentAt', isAscending: true };
  return { property: 'receivedAt', isAscending: false };
}

async function loadMailboxQueryView(engine, { accountId, folderId, sort = 'received' }) {
  const folder = await engine.get(
    `SELECT id, remote_id FROM folders WHERE id = ? AND account_id = ?`,
    [folderId, accountId],
  );
  if (!folder?.remote_id) return null;
  const filterJson = JSON.stringify({ inMailbox: folder.remote_id });
  const sortJson = JSON.stringify([mailboxViewSortSpec(sort)]);
  return engine.get(
    `SELECT *
       FROM query_views
      WHERE account_id = ?
        AND folder_id = ?
        AND view_type = 'mailbox-window'
        AND filter_json = ?
        AND sort_json = ?
        AND collapse_threads = 0`,
    [accountId, folderId, filterJson, sortJson],
  );
}

function mergeRangeCoverage(ranges, total = 0) {
  let covered = 0;
  let activeStart = null;
  let activeEnd = null;
  for (const range of ranges ?? []) {
    let start = Number(range.start_position ?? 0);
    let end = Number(range.end_position ?? 0);
    if (Number.isFinite(total) && total > 0) {
      start = Math.max(0, Math.min(start, total));
      end = Math.max(0, Math.min(end, total));
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      continue;
    }
    if (activeStart == null) {
      activeStart = start;
      activeEnd = end;
      continue;
    }
    if (start <= activeEnd) {
      activeEnd = Math.max(activeEnd, end);
    } else {
      covered += activeEnd - activeStart;
      activeStart = start;
      activeEnd = end;
    }
  }
  if (activeStart != null) {
    covered += activeEnd - activeStart;
  }
  return covered;
}

/**
 * Test broadcaster that swallows touches. Production code uses a real
 * BroadcastChannel-backed implementation; see shared-worker.js.
 */
export function noopBroadcaster() {
  const touched = new Set();
  return {
    touch(family) {
      touched.add(family);
    },
    flush() {
      const out = Array.from(touched);
      touched.clear();
      return out;
    },
  };
}
