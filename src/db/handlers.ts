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

import {
  batchResult,
  compactViewAfterDeletingPositions,
  numericUnique,
  placeholdersFor,
} from './batch-helpers';
import { DB_RPC, TABLE_FAMILIES } from './protocol';

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
            server_kind, is_primary, created_at, updated_at, last_opened_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(server_origin, remote_account_id) DO UPDATE SET
            display_name = excluded.display_name,
            primary_email = excluded.primary_email,
            server_kind = excluded.server_kind,
            is_primary = excluded.is_primary,
            updated_at = excluded.updated_at,
            last_opened_at = COALESCE(excluded.last_opened_at, last_opened_at)`,
        [
          input.displayName ?? null,
          input.primaryEmail ?? null,
          input.serverOrigin,
          input.remoteAccountId,
          input.serverKind ?? null,
          input.isPrimary ? 1 : 0,
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
                rights_json, raw_json, is_deleted, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    [DB_RPC.IDENTITY_LIST]: async ({ accountId }) =>
      engine.all(
        `SELECT * FROM identities WHERE account_id = ? ORDER BY name COLLATE NOCASE, email COLLATE NOCASE`,
        [accountId],
      ),

    [DB_RPC.IDENTITY_UPSERT_MANY]: async ({ accountId, identities }) => {
      if (!identities?.length) {
        return { upserted: 0 };
      }
      const ts = now();
      await engine.transaction(async (tx) => {
        for (const id of identities) {
          await tx.run(
            `INSERT INTO identities(
                account_id, remote_id, name, email, reply_to_json, raw_json, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(account_id, remote_id) DO UPDATE SET
                name = excluded.name,
                email = excluded.email,
                reply_to_json = excluded.reply_to_json,
                raw_json = excluded.raw_json,
                updated_at = excluded.updated_at`,
            [
              accountId,
              id.remoteId,
              id.name ?? null,
              id.email,
              id.replyToJson ?? null,
              id.rawJson ?? null,
              ts,
            ],
          );
        }
      });
      broadcaster.touch(TABLE_FAMILIES.IDENTITIES);
      return { upserted: identities.length };
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

        const threadRemoteIds = [...new Set(records.map((m) => m.remoteThreadId).filter(Boolean))];
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

        for (const m of records) {
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
              threadMap.get(m.remoteThreadId) ?? null,
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

        if (records.length > 0) {
          const recordRemoteIds = records.map((m) => m.remoteId);
          const messageRows = await tx.all(
            `SELECT id, remote_id FROM messages
              WHERE account_id = ? AND remote_id IN (${placeholdersFor(recordRemoteIds)})`,
            [accountId, ...recordRemoteIds],
          );
          const messageIdByRemote = new Map(messageRows.map((row) => [row.remote_id, row.id]));
          const addressMessageIds = [];
          const addressRows = [];
          const keywordMessageIds = [];
          const keywordRows = [];
          const allMailboxIds = [...new Set(records.flatMap((m) => m.mailboxIds ?? []))];
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

          for (const m of records) {
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
              for (const keyword of m.keywords) keywordRows.push([messageId, keyword]);
            }
            const memberships = (m.mailboxIds ?? [])
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
                  m.receivedAt ?? null,
                  m.sentAt ?? m.receivedAt ?? null,
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
        if (removedList.length > 0) {
          const placeholders = removedList.map(() => '?').join(',');
          const removedRows = await tx.all(
            `SELECT position FROM query_view_items
              WHERE view_id = ? AND remote_id IN (${placeholders})
              ORDER BY position DESC`,
            [safeViewId, ...removedList],
          );
          await tx.run(
            `DELETE FROM query_view_items
              WHERE view_id = ? AND remote_id IN (${placeholders})`,
            [safeViewId, ...removedList],
          );
          await compactViewAfterDeletingPositions(
            tx,
            safeViewId,
            removedRows.map((row) => Number(row.position)),
            now(),
            { updateTotal: false },
          );
        }
        for (const entry of addedList) {
          const idx = Number(entry.index);
          const remoteId = entry.id;
          // Move within view: drop the old slot and compact above
          // before re-inserting at the new index.
          const existing = await tx.get(
            `SELECT position FROM query_view_items
              WHERE view_id = ? AND remote_id = ?`,
            [safeViewId, remoteId],
          );
          if (existing) {
            const oldPos = Number(existing.position);
            await tx.run(
              `DELETE FROM query_view_items
                WHERE view_id = ? AND remote_id = ?`,
              [safeViewId, remoteId],
            );
            await tx.run(
              `UPDATE query_view_items
                  SET position = position - 1
                WHERE view_id = ? AND position > ?`,
              [safeViewId, oldPos],
            );
          }
          // Park positions >= idx in the negative range so the
          // UNIQUE(view_id, position) index stays satisfied during
          // the shift. The mapping `p -> -p - 1` keeps the original
          // order and is reversed by `p -> -p` after the insert.
          await tx.run(
            `UPDATE query_view_items
                SET position = -position - 1
              WHERE view_id = ? AND position >= ?`,
            [safeViewId, idx],
          );
          await tx.run(
            `INSERT INTO query_view_items(view_id, position, message_id, remote_id)
             VALUES (?, ?, NULL, ?)`,
            [safeViewId, idx, remoteId],
          );
          await tx.run(
            `UPDATE query_view_items
                SET position = -position
              WHERE view_id = ? AND position < 0`,
            [safeViewId],
          );
        }
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
        await tx.run(
          `DELETE FROM messages
            WHERE account_id = ? AND remote_id IN (${placeholdersFor(ids)})`,
          [accountId, ...ids],
        );
      });
      broadcaster.touch(TABLE_FAMILIES.MESSAGES);
      return batchResult(removed, { views });
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
      const values = await engine.all(
        `SELECT kind, value, is_truncated
           FROM body_values
          WHERE message_id = ?`,
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
      const text = values.find((r) => r.kind === 'text')?.value ?? '';
      const html = values.find((r) => r.kind === 'html')?.value ?? '';
      return { text, html, attachments };
    },

    [DB_RPC.MESSAGE_FIND_BY_RFC822_MESSAGE_ID]: async ({ accountId, rfc822MessageId }) =>
      engine.get(
        `SELECT * FROM messages WHERE account_id = ? AND rfc822_message_id = ?`,
        [accountId, rfc822MessageId],
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

    [DB_RPC.ADDRESSBOOK_UPSERT_MANY]: async ({ accountId, serviceKind, addressbooks }) => {
      if (!addressbooks?.length) {
        return { upserted: 0 };
      }
      const ts = now();
      await engine.transaction(async (tx) => {
        for (const ab of addressbooks) {
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
      });
      broadcaster.touch(TABLE_FAMILIES.CONTACTS);
      return { upserted: addressbooks.length };
    },

    /**
     * List contacts joined with their preferred (or first) email,
     * suitable for the contact-book view. Returns a flat row shape so
     * the caller does not have to JOIN `contact_emails` itself.
     */
    [DB_RPC.CONTACT_LIST]: async ({ accountId, limit = 500 }) =>
      engine.all(
        `SELECT c.id,
                c.display_name,
                c.organization,
                (SELECT email FROM contact_emails ce
                  WHERE ce.contact_id = c.id
                  ORDER BY is_preferred DESC, position
                  LIMIT 1) AS email
           FROM contacts c
          WHERE c.account_id = ? AND c.is_deleted = 0
          ORDER BY c.display_name COLLATE NOCASE
          LIMIT ?`,
        [accountId, limit],
      ),

    [DB_RPC.CONTACT_UPSERT_MANY]: async ({ accountId, contacts }) => {
      if (!contacts?.length) {
        return { upserted: 0 };
      }
      const ts = now();
      await engine.transaction(async (tx) => {
        for (const c of contacts) {
          await tx.run(
            `INSERT INTO contacts(
                account_id, addressbook_id, remote_id, uid, etag,
                full_name, display_name, given_name, family_name, organization,
                vcard_text, vcard_version, raw_json, is_deleted, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(account_id, addressbook_id, remote_id) DO UPDATE SET
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
                is_deleted = excluded.is_deleted,
                updated_at = excluded.updated_at`,
            [
              accountId,
              c.addressbookId,
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
              c.isDeleted ? 1 : 0,
              ts,
            ],
          );
          const contactRow = await tx.get(
            `SELECT id FROM contacts WHERE account_id = ? AND addressbook_id = ? AND remote_id = ?`,
            [accountId, c.addressbookId, c.remoteId],
          );
          const contactId = contactRow.id;
          if (c.emails) {
            await tx.run(`DELETE FROM contact_emails WHERE contact_id = ?`, [contactId]);
            for (let i = 0; i < c.emails.length; i += 1) {
              const e = c.emails[i];
              await tx.run(
                `INSERT INTO contact_emails(contact_id, position, email, label, is_preferred)
                 VALUES (?, ?, ?, ?, ?)`,
                [contactId, i, e.email, e.label ?? null, e.isPreferred ? 1 : 0],
              );
            }
          }
        }
      });
      broadcaster.touch(TABLE_FAMILIES.CONTACTS);
      return { upserted: contacts.length };
    },

    [DB_RPC.CONTACT_AUTOCOMPLETE]: async ({ accountId, prefix, limit = 20 }) => {
      const lowered = String(prefix ?? '').toLowerCase();
      if (!lowered) {
        return [];
      }
      // Use a half-open range over email_lower so the planner uses
      // contact_emails_lookup directly. LIKE with parameter binding does
      // not get rewritten into a range scan because the column has BINARY
      // collation, but `>= prefix AND < prefixUpperBound` always does.
      const upper = nextPrefix(lowered);
      const contactRows = await engine.all(
        `SELECT 'contact' AS source, c.display_name AS name, ce.email AS email, ce.is_preferred AS is_preferred
           FROM contact_emails ce
           JOIN contacts c ON c.id = ce.contact_id
          WHERE c.account_id = ?
            AND c.is_deleted = 0
            AND ce.email_lower >= ?
            AND ce.email_lower < ?
          ORDER BY ce.is_preferred DESC, c.display_name COLLATE NOCASE
          LIMIT ?`,
        [accountId, lowered, upper, limit],
      );
      const historyLimit = Math.max(0, limit - contactRows.length);
      if (historyLimit === 0) {
        return contactRows;
      }
      // message_addresses(email COLLATE NOCASE) lets us prefix-scan the
      // sender/recipient history without lowercasing on read.
      const historyRows = await engine.all(
        `SELECT DISTINCT 'history' AS source, ma.name, ma.email, 0 AS is_preferred
           FROM message_addresses ma
           JOIN messages m ON m.id = ma.message_id
          WHERE m.account_id = ?
            AND ma.email IS NOT NULL
            AND ma.email >= ? COLLATE NOCASE
            AND ma.email < ? COLLATE NOCASE
          LIMIT ?`,
        [accountId, lowered, upper, historyLimit],
      );
      return [...contactRows, ...historyRows];
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
 * Half-open upper bound for a prefix range scan. For 'pers' returns 'pert';
 * for 'foo\uffff' returns the next code point. Returns null when there is
 * no representable next code point - callers should fall back to LIKE then.
 */
function nextPrefix(prefix: string): string | null {
  if (!prefix) {
    return prefix;
  }
  const codePoints = Array.from(prefix);
  for (let i = codePoints.length - 1; i >= 0; i -= 1) {
    const cp = codePoints[i].codePointAt(0)!;
    if (cp < 0x10ffff) {
      codePoints[i] = String.fromCodePoint(cp + 1);
      return codePoints.slice(0, i + 1).join('');
    }
  }
  return null;
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
