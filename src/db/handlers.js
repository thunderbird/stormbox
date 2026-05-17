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

import { DB_RPC, TABLE_FAMILIES } from './protocol.js';

/**
 * Build the handler map for a given engine. Broadcaster is optional in
 * tests; pass a no-op when you don't care about cross-tab invalidation.
 */
export function makeHandlers(engine, broadcaster = noopBroadcaster()) {
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
          const messageRow = await tx.get(
            `SELECT id FROM messages WHERE account_id = ? AND remote_id = ?`,
            [accountId, m.remoteId],
          );
          const messageId = messageRow.id;
          if (m.addresses) {
            await tx.run(`DELETE FROM message_addresses WHERE message_id = ?`, [messageId]);
            for (const addr of m.addresses) {
              await tx.run(
                `INSERT INTO message_addresses(message_id, kind, position, name, email)
                 VALUES (?, ?, ?, ?, ?)`,
                [messageId, addr.kind, addr.position, addr.name ?? null, addr.email ?? null],
              );
            }
          }
          if (m.keywords) {
            await tx.run(`DELETE FROM message_keywords WHERE message_id = ?`, [messageId]);
            for (const keyword of m.keywords) {
              await tx.run(
                `INSERT INTO message_keywords(message_id, keyword) VALUES (?, ?)`,
                [messageId, keyword],
              );
            }
          }
        }
      });
      broadcaster.touch(TABLE_FAMILIES.MESSAGES);
      return { upserted: messages.length };
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

    [DB_RPC.MESSAGE_FIND_BY_RFC822_MESSAGE_ID]: async ({ accountId, rfc822MessageId }) =>
      engine.get(
        `SELECT * FROM messages WHERE account_id = ? AND rfc822_message_id = ?`,
        [accountId, rfc822MessageId],
      ),

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
      const pattern = `${lowered.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const contactRows = await engine.all(
        `SELECT 'contact' AS source, c.display_name AS name, ce.email AS email, ce.is_preferred AS is_preferred
           FROM contact_emails ce
           JOIN contacts c ON c.id = ce.contact_id
          WHERE c.account_id = ?
            AND c.is_deleted = 0
            AND ce.email_lower LIKE ? ESCAPE '\\'
          ORDER BY ce.is_preferred DESC, c.display_name COLLATE NOCASE
          LIMIT ?`,
        [accountId, pattern, limit],
      );
      const historyLimit = Math.max(0, limit - contactRows.length);
      if (historyLimit === 0) {
        return contactRows;
      }
      const historyRows = await engine.all(
        `SELECT DISTINCT 'history' AS source, ma.name, ma.email, 0 AS is_preferred
           FROM message_addresses ma
           JOIN messages m ON m.id = ma.message_id
          WHERE m.account_id = ?
            AND ma.email IS NOT NULL
            AND lower(ma.email) LIKE ? ESCAPE '\\'
          LIMIT ?`,
        [accountId, pattern, historyLimit],
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
          input.targetMessageId ?? null,
          input.requestJson,
          input.optimisticPatchJson ?? null,
          null,
          null,
          ts,
          ts,
        ],
      );
      broadcaster.touch(TABLE_FAMILIES.MUTATIONS);
      return { id: result.lastInsertRowid };
    },

    [DB_RPC.PENDING_MUTATION_LIST_PENDING]: async ({ accountId, limit = 50 }) =>
      engine.all(
        `SELECT * FROM pending_mutations
          WHERE account_id = ? AND local_status IN ('pending','retry')
          ORDER BY created_at LIMIT ?`,
        [accountId, limit],
      ),

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
