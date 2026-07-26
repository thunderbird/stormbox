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
import { autocompleteRecipients, ownedAddressKeys } from './autocomplete';
import {
  batchResult,
  compactViewAfterDeletingPositions,
  numericUnique,
  placeholdersFor,
} from './batch-helpers';
import { DB_RPC, TABLE_FAMILIES } from './protocol';

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

    [DB_RPC.IDENTITY_LIST]: async ({ accountId }) =>
      engine.all(
        `SELECT * FROM identities WHERE account_id = ? ORDER BY name COLLATE NOCASE, email COLLATE NOCASE`,
        [accountId],
      ),

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
          await tx.run(
            `INSERT INTO identities(
                account_id, remote_id, name, email, reply_to_json, bcc_json,
                raw_json, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(account_id, remote_id) DO UPDATE SET
                name = excluded.name,
                email = excluded.email,
                reply_to_json = excluded.reply_to_json,
                bcc_json = excluded.bcc_json,
                raw_json = excluded.raw_json,
                updated_at = excluded.updated_at`,
            [
              accountId,
              id.remoteId,
              id.name ?? null,
              id.email,
              id.replyToJson ?? null,
              id.bccJson ?? null,
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
        const sortJson = JSON.stringify([{ property: sortProp, isAscending: false }]);
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
        const sortJson = JSON.stringify([{ property: sortProp, isAscending: false }]);
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
        `SELECT bv.kind, bv.value, bv.is_truncated, bp.media_type
           FROM body_values bv
           LEFT JOIN body_parts bp
             ON bp.message_id = bv.message_id AND bp.part_id = bv.part_id
          WHERE bv.message_id = ?`,
        [messageId],
      );
      const attachments = await engine.all(
        `SELECT part_id, blob_id, name, media_type AS mime_type, size, disposition, cid
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
      return { text, html, attachments };
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
    [DB_RPC.MESSAGE_FILTER_EXISTING_IDS]: async ({ accountId, ids }) => {
      const numeric = (Array.isArray(ids) ? ids : [])
        .map(Number)
        .filter((id) => Number.isFinite(id));
      if (numeric.length === 0) return [];
      const placeholders = numeric.map(() => '?').join(',');
      const rows = await engine.all(
        `SELECT id FROM messages
          WHERE account_id = ? AND id IN (${placeholders})`,
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
        `SELECT * FROM addressbooks WHERE account_id = ? AND is_deleted = 0 ORDER BY is_default DESC, name COLLATE NOCASE`,
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
      accountId, serviceKind, addressbooks, snapshot = false,
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
                is_default, is_subscribed, ctag, sync_token,
                raw_json, is_deleted, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(account_id, service_kind, remote_id) DO UPDATE SET
                name = excluded.name,
                description = excluded.description,
                is_default = excluded.is_default,
                is_subscribed = excluded.is_subscribed,
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
              ab.isDefault ? 1 : 0,
              ab.isSubscribed === false ? 0 : 1,
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
      broadcaster.touch(TABLE_FAMILIES.CONTACTS);
      return { upserted: addressbooks?.length ?? 0, retired };
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
                c.display_name,
                c.organization,
                (SELECT email FROM contact_emails ce
                  WHERE ce.contact_id = c.id
                  ORDER BY is_preferred DESC, position
                  LIMIT 1) AS email,
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
      return rows.map((row) => ({ ...row, addressbook_ids: splitIds(row.addressbook_ids) }));
    },

    /**
     * Fetch a single contact plus its full ordered email list, for the
     * edit form (which needs every address, not just the preferred one).
     */
    [DB_RPC.CONTACT_GET]: async ({ accountId, contactId }) => {
      const row = await engine.get(
        `SELECT id, remote_id, display_name, full_name, organization
           FROM contacts
          WHERE id = ? AND account_id = ? AND is_deleted = 0`,
        [contactId, accountId],
      );
      if (!row) return null;
      const emails = await engine.all(
        `SELECT email, label, is_preferred, position
           FROM contact_emails WHERE contact_id = ? ORDER BY position`,
        [contactId],
      );
      const books = await engine.all(
        `SELECT addressbook_id FROM addressbook_contacts
          WHERE contact_id = ? ORDER BY addressbook_id`,
        [contactId],
      );
      return { ...row, emails, addressbook_ids: books.map((book) => book.addressbook_id) };
    },

    /**
     * @param {object} args
     * @param {number} [args.generation] stamp each row with the full sync
     *   that saw it, so `CONTACT_SWEEP_STALE` can afterwards tell the rows
     *   the server still has from the ones it no longer does.
     */
    [DB_RPC.CONTACT_UPSERT_MANY]: async ({ accountId, contacts, generation = null }) => {
      if (!contacts?.length) {
        return { upserted: 0 };
      }
      const ts = now();
      await engine.transaction(async (tx) => {
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
          if (c.emails) {
            await tx.run(`DELETE FROM contact_emails WHERE contact_id = ?`, [contactId]);
            for (let i = 0; i < c.emails.length; i += 1) {
              const e = c.emails[i];
              await tx.run(
                `INSERT INTO contact_emails(
                   contact_id, position, email, email_key, label, is_preferred
                 ) VALUES (?, ?, ?, ?, ?, ?)`,
                // The address is stored verbatim for display and sending
                // (CS-3.5); the key beside it is what lookups compare, and it
                // is computed here rather than in SQL because SQLite's
                // `lower()` folds ASCII only.
                [
                  contactId,
                  i,
                  e.email,
                  addressKey(e.email),
                  e.label ?? null,
                  e.isPreferred ? 1 : 0,
                ],
              );
            }
          }
          // Search tokens are replaced rather than added to, so renaming a
          // contact stops matching the name it used to have (CS-3.2). A
          // deleted card keeps none: it is not a suggestion.
          //
          // No nickname is tokenized because nothing maps one — CS-3.2 asks
          // for it "where available", and no column or sync field carries it.
          await tx.run('DELETE FROM contact_search_tokens WHERE contact_id = ?', [contactId]);
          if (!c.isDeleted) {
            const tokens = nameTokens(
              c.displayName, c.fullName, c.givenName, c.familyName, c.organization,
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
      broadcaster.touch(TABLE_FAMILIES.CONTACTS);
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
     * Soft-delete a contact by its remote id after the server card has
     * been destroyed. Soft delete (rather than a row delete) keeps the
     * behaviour consistent with ContactCard/changes destroyed handling
     * and lets the autocomplete / list queries filter on is_deleted.
     */
    [DB_RPC.CONTACT_DELETE_LOCAL]: async ({ accountId, remoteId }) => {
      if (remoteId == null) return { deleted: 0 };
      const deleted = await engine.transaction(async (tx) => {
        const result = await tx.run(
          `UPDATE contacts SET is_deleted = 1, updated_at = ?
             WHERE account_id = ? AND remote_id = ?`,
          [now(), accountId, remoteId],
        );
        await tx.run(
          `DELETE FROM contact_search_tokens
            WHERE contact_id IN (
                    SELECT id FROM contacts WHERE account_id = ? AND remote_id = ?
                  )`,
          [accountId, remoteId],
        );
        return result?.changes ?? 0;
      });
      broadcaster.touch(TABLE_FAMILIES.CONTACTS);
      return { deleted };
    },

    [DB_RPC.CONTACT_AUTOCOMPLETE]: async (params) =>
      autocompleteRecipients(engine, params),

    /**
     * Learn the recipients of a send (CS-3.3).
     *
     * Only a confirmed submission may reach here. That is the whole point
     * of the table: autocomplete used to draw on every address on every
     * synced message, so anyone who had ever mailed the user became a
     * suggestion, including senders they would never write to.
     *
     * A repeat send bumps the count and the timestamp rather than adding a
     * row, because both are ranking inputs (CS-3.6) and one recipient is
     * one suggestion (CS-3.4). A name only overwrites a stored name when
     * there is one to store: a later send with no display name must not
     * erase the name an earlier send taught us.
     *
     * A suppressed recipient stays suppressed (CS-3.13), and stops being
     * recorded at all: un-suppressing on the next send would make the removal
     * look like it had not worked, and going on collecting names and counts
     * for a row that will never be offered keeps data about someone the user
     * asked to be left out of this.
     */
    [DB_RPC.RECIPIENT_HISTORY_RECORD]: async ({ accountId, recipients }) => {
      const byKey = new Map<string, { email: string; key: string; name: string | null }>();
      for (const r of recipients ?? []) {
        const email = String(r?.email ?? '').trim();
        const key = addressKey(r?.email);
        if (!email || !key) continue;
        // One send to one person counts once, whatever spelling it arrived in
        // and however many fields it was written into. The same address in To
        // and Cc is one recipient (CS-3.4), and send frequency is a ranking
        // input (CS-3.6), so counting it twice would quietly promote it.
        const seen = byKey.get(key);
        const name = r?.name ? String(r.name).trim() : null;
        if (!seen) byKey.set(key, { email, key, name });
        else if (!seen.name && name) seen.name = name;
      }
      const rows = [...byKey.values()];
      if (rows.length === 0) return { learned: 0 };
      const ts = now();
      await engine.transaction(async (tx) => {
        for (const row of rows) {
          await tx.run(
            `INSERT INTO recipient_history(
               account_id, email, email_key, name, name_key,
               send_count, last_sent_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
             ON CONFLICT(account_id, email_key) DO UPDATE SET
                email = excluded.email,
                name = COALESCE(excluded.name, recipient_history.name),
                name_key = COALESCE(excluded.name_key, recipient_history.name_key),
                send_count = recipient_history.send_count + 1,
                last_sent_at = excluded.last_sent_at,
                updated_at = excluded.updated_at
              WHERE recipient_history.is_suppressed = 0`,
            [
              accountId,
              row.email,
              row.key,
              row.name,
              row.name ? row.name.normalize('NFC').toLowerCase() : null,
              ts,
              ts,
              ts,
            ],
          );
        }
      });
      broadcaster.touch(TABLE_FAMILIES.CONTACTS);
      return { learned: rows.length };
    },

    /**
     * Stop offering one learned recipient (CS-3.13).
     *
     * Suppressed rather than deleted, so the next send to that address does
     * not learn it again and undo what the user asked for. The row keeps its
     * counts, so un-suppressing later would restore its ranking — nothing
     * offers that yet, and nothing depends on it either.
     */
    [DB_RPC.RECIPIENT_HISTORY_SUPPRESS]: async ({ accountId, email }) => {
      const key = addressKey(email);
      if (!key) return { suppressed: 0 };
      const result = await engine.run(
        `UPDATE recipient_history SET is_suppressed = 1, updated_at = ?
          WHERE account_id = ? AND email_key = ?`,
        [now(), accountId, key],
      );
      const suppressed = result?.changes ?? 0;
      if (suppressed > 0) broadcaster.touch(TABLE_FAMILIES.CONTACTS);
      return { suppressed };
    },

    /**
     * Forget every learned recipient for the account (CS-3.13).
     *
     * Deleted outright, not suppressed: "clear my history" means the rows
     * are gone, and learning an address again afterwards is the expected
     * result of sending to it again.
     */
    /**
     * Learn recipients from mail already in the Sent folder, one bounded
     * batch at a time.
     *
     * Without this, a returning user's suggestions start empty and stay
     * that way until they have written to each person again — the address
     * book knows the contacts, but not who they actually write to.
     *
     * Three bounds, each for a reason:
     *
     * - **The newest `maxMessages` only.** A Sent folder can hold tens of
     *   thousands of messages, and a five-year-old recipient is not a
     *   suggestion worth the scan.
     * - **The local cache only**, never the server. Paging a mailbox to
     *   populate a typeahead is the wrong trade at any size.
     * - **`batchSize` messages per call**, with where it stopped recorded,
     *   so this can be run from an idle moment and resumed at the next one
     *   rather than having to finish in one go.
     *
     * The From address must be one of the user's own. A Sent folder is not
     * proof of authorship: an imported or shared mailbox can hold someone
     * else's sent mail, and CS-3.3 asks for the user's confirmed sends.
     *
     * Messages with no send time are skipped. Ordering by recency is what
     * makes "the newest N" mean anything, and a message with no time cannot
     * be placed in that order.
     */
    [DB_RPC.RECIPIENT_HISTORY_BACKFILL]: async ({
      accountId, batchSize = 200, maxMessages = 2000,
    }) => {
      const progress = await readBackfillProgress(engine, accountId);
      if (progress.done) return { scanned: 0, learned: 0, done: true };

      const sent = await engine.get(
        `SELECT id FROM folders WHERE account_id = ? AND role = 'sent'`,
        [accountId],
      );
      // No Sent folder cached yet. Not done — a later pass, after mail has
      // synced, will find one.
      if (!sent) return { scanned: 0, learned: 0, done: false };

      const remaining = Math.max(0, maxMessages - progress.scanned);
      if (remaining === 0) {
        await writeBackfillProgress(engine, accountId, { ...progress, done: true });
        return { scanned: 0, learned: 0, done: true };
      }
      const take = Math.min(batchSize, remaining);
      const cursorClause = progress.cursorSentAt == null
        ? ''
        : `AND (fm.sort_sent_at < ?
                OR (fm.sort_sent_at = ? AND fm.message_id < ?))`;
      const cursorParams = progress.cursorSentAt == null
        ? []
        : [progress.cursorSentAt, progress.cursorSentAt, progress.cursorId];
      const batch = await engine.all(
        `SELECT fm.message_id AS message_id, fm.sort_sent_at AS sent_at
           FROM folder_messages fm
          WHERE fm.folder_id = ?
            AND fm.sort_sent_at IS NOT NULL
            ${cursorClause}
          ORDER BY fm.sort_sent_at DESC, fm.message_id DESC
          LIMIT ?`,
        [sent.id, ...cursorParams, take],
      );
      if (batch.length === 0) {
        // Nothing more to read *for now*, which is not the same as finished.
        // `folder_messages` fills in as Sent syncs and as the user pages back
        // through it, and anything that arrives later is older than the cursor
        // — so a resumed scan will reach it. Only the message budget retires
        // this work; see below.
        return { scanned: 0, learned: 0, done: false };
      }

      const ownedKeys = await ownedAddressKeys(engine, accountId);
      if (ownedKeys.size === 0) {
        // Not one address of the user's own is known yet, so there is no way
        // to tell which of this folder's mail they sent: every message would
        // be skipped and the cursor would move past them for good. Identities
        // sync separately and a failure there is tolerated rather than fatal,
        // which is what makes this reachable.
        //
        // A partly-synced identity list has a thinner version of the same
        // problem — mail sent from an alias that has not arrived yet is read,
        // skipped, and not reconsidered — which this cannot fix without
        // rescanning the folder whenever an identity appears.
        return { scanned: 0, learned: 0, done: false };
      }
      const last = batch[batch.length - 1];
      const scanned = progress.scanned + batch.length;
      // The budget is the only thing that finishes this. A batch shorter than
      // the one asked for used to count as the end of the folder, and it is
      // not: it is the ordinary state of a Sent folder that is still filling
      // in, so a single cached message retired the backfill and every message
      // that synced afterwards went unread.
      const done = scanned >= maxMessages;

      // What was learned and the cursor that says so commit together. Apart,
      // a crash between them left the counts raised and the cursor where it
      // was, so the next pass read the same messages and raised them again —
      // and send frequency is a ranking input, so the addresses in whichever
      // batch was interrupted would quietly climb the list.
      let learned = 0;
      await engine.transaction(async (tx) => {
        learned = await learnFromSentMessages(tx, {
          accountId,
          messageIds: batch.map((row) => row.message_id),
          sentAtById: new Map(batch.map((row) => [row.message_id, Number(row.sent_at)])),
          owned: ownedKeys,
        });
        await writeBackfillProgress(tx, accountId, {
          cursorSentAt: Number(last.sent_at),
          cursorId: last.message_id,
          scanned,
          done,
        });
      });
      if (learned > 0) broadcaster.touch(TABLE_FAMILIES.CONTACTS);
      return { scanned: batch.length, learned, done };
    },

    /**
     * Forget every learned address (CS-3.13), while keeping the answer the
     * user already gave about individual ones.
     *
     * "Clear the addresses you have suggested" and "never suggest this one
     * again" are different statements, and the second outlives the first: an
     * address removed on purpose must not come back as a suggestion because
     * the history was later cleared. So a suppressed row survives as a
     * tombstone — the flag and the key, and nothing else worth keeping.
     */
    [DB_RPC.RECIPIENT_HISTORY_CLEAR]: async ({ accountId }) => {
      let cleared = 0;
      await engine.transaction(async (tx) => {
        const result = await tx.run(
          `DELETE FROM recipient_history WHERE account_id = ? AND is_suppressed = 0`,
          [accountId],
        );
        cleared = result?.changes ?? 0;
        await tx.run(
          `UPDATE recipient_history
              SET name = NULL, name_key = NULL, send_count = 0,
                  last_sent_at = NULL, updated_at = ?
            WHERE account_id = ? AND is_suppressed = 1`,
          [now(), accountId],
        );
      });
      broadcaster.touch(TABLE_FAMILIES.CONTACTS);
      return { cleared };
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
     * after runMutation reports `failed > 0`.
     */
    [DB_RPC.PENDING_MUTATION_GET_ERROR]: async ({ mutationId }) => {
      if (mutationId == null) return null;
      const row = await engine.get(
        `SELECT mutation_type, local_status, error_json
           FROM pending_mutations WHERE id = ?`,
        [mutationId],
      );
      return row ?? null;
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

/**
 * The address-book ids `group_concat` returned, as numbers. A contact in no
 * book concatenates to null rather than an empty string.
 */
function splitIds(concatenated: unknown): number[] {
  if (typeof concatenated !== 'string' || concatenated === '') return [];
  return concatenated.split(',').map(Number);
}

/** Where the Sent-folder backfill stopped, as `sync_states` records it. */
const BACKFILL_OBJECT_TYPE = 'RecipientHistoryBackfill';

interface BackfillProgress {
  cursorSentAt: number | null;
  cursorId: number | null;
  scanned: number;
  done: boolean;
}

async function readBackfillProgress(engine, accountId): Promise<BackfillProgress> {
  const row = await engine.get(
    `SELECT state FROM sync_states
      WHERE account_id = ? AND object_type = ? AND scope = ''`,
    [accountId, BACKFILL_OBJECT_TYPE],
  );
  const blank: BackfillProgress = {
    cursorSentAt: null, cursorId: null, scanned: 0, done: false,
  };
  if (!row?.state) return blank;
  try {
    const parsed = JSON.parse(row.state);
    return {
      cursorSentAt: parsed.cursorSentAt ?? null,
      cursorId: parsed.cursorId ?? null,
      scanned: Number(parsed.scanned ?? 0),
      done: !!parsed.done,
    };
  } catch {
    // An unreadable checkpoint means starting over, which costs one bounded
    // pass and cannot corrupt anything: the upsert is by address.
    return blank;
  }
}

function writeBackfillProgress(engine, accountId, progress: BackfillProgress) {
  return engine.run(
    `INSERT INTO sync_states(account_id, object_type, scope, state, updated_at)
     VALUES (?, ?, '', ?, ?)
     ON CONFLICT(account_id, object_type, scope) DO UPDATE SET
        state = excluded.state,
        updated_at = excluded.updated_at`,
    [accountId, BACKFILL_OBJECT_TYPE, JSON.stringify(progress), Date.now()],
  );
}

/**
 * Learn the recipients of those messages in the batch the user actually
 * sent, adding to the counts rather than replacing them.
 *
 * `last_sent_at` only ever moves forward: a backfilled message is older
 * than anything learned live, and letting it win would make a recipient
 * written to yesterday look years stale to the ranking.
 *
 * Takes a transaction rather than the engine, because what it writes and the
 * cursor that records having written it have to land together: committing the
 * counts and then failing to move the cursor means the next pass reads the
 * same messages and adds them again.
 */
async function learnFromSentMessages(tx, { accountId, messageIds, sentAtById, owned }): Promise<number> {
  if (messageIds.length === 0) return 0;
  const rows = await tx.all(
    `SELECT message_id, kind, name, email
       FROM message_addresses
      WHERE message_id IN (${placeholdersFor(messageIds)})
        AND email IS NOT NULL`,
    messageIds,
  );
  const byMessage = new Map<number, any[]>();
  for (const row of rows) {
    const list = byMessage.get(row.message_id);
    if (list) list.push(row);
    else byMessage.set(row.message_id, [row]);
  }

  const totals = new Map<string, { email: string; name: string | null; count: number; lastSentAt: number }>();
  for (const [messageId, addresses] of byMessage) {
    const sentByUser = addresses.some(
      (row) => row.kind === 'from' && owned.has(addressKey(row.email)),
    );
    if (!sentByUser) continue;
    const sentAt = sentAtById.get(messageId) ?? 0;
    for (const row of addresses) {
      if (row.kind !== 'to' && row.kind !== 'cc' && row.kind !== 'bcc') continue;
      const key = addressKey(row.email);
      if (!key || owned.has(key)) continue;
      const existing = totals.get(key);
      if (existing) {
        existing.count += 1;
        existing.lastSentAt = Math.max(existing.lastSentAt, sentAt);
        existing.name = existing.name ?? (row.name || null);
      } else {
        totals.set(key, {
          email: row.email, name: row.name || null, count: 1, lastSentAt: sentAt,
        });
      }
    }
  }
  if (totals.size === 0) return 0;

  const ts = Date.now();
  {
    for (const [key, value] of totals) {
      await tx.run(
        `INSERT INTO recipient_history(
           account_id, email, email_key, name, name_key,
           send_count, last_sent_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, email_key) DO UPDATE SET
            name = COALESCE(recipient_history.name, excluded.name),
            name_key = COALESCE(recipient_history.name_key, excluded.name_key),
            send_count = recipient_history.send_count + excluded.send_count,
            last_sent_at = MAX(COALESCE(recipient_history.last_sent_at, 0), excluded.last_sent_at),
            updated_at = excluded.updated_at
          WHERE recipient_history.is_suppressed = 0`,
        [
          accountId,
          value.email,
          key,
          value.name,
          value.name ? value.name.normalize('NFC').toLowerCase() : null,
          value.count,
          value.lastSentAt,
          ts,
          ts,
        ],
      );
    }
  }
  return totals.size;
}

async function loadMailboxQueryView(engine, { accountId, folderId, sort = 'received' }) {
  const folder = await engine.get(
    `SELECT id, remote_id FROM folders WHERE id = ? AND account_id = ?`,
    [folderId, accountId],
  );
  if (!folder?.remote_id) return null;
  const sortProp = sort === 'sent' ? 'sentAt' : 'receivedAt';
  const filterJson = JSON.stringify({ inMailbox: folder.remote_id });
  const sortJson = JSON.stringify([{ property: sortProp, isAscending: false }]);
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
