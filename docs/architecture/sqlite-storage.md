# Stormbox SQLite Storage

This document describes the local SQLite storage layout used by
Stormbox and the sync strategy that fills it. It pairs with
`performance.md` (runtime architecture and patterns) and the spec at
`../../specs/001-mvp-scope/spec.md` (capabilities and requirements).

## Scope

The first implementation target is JMAP against Stalwart over
WebSocket, with wa-sqlite backed by IndexedDB
(`IDBBatchAtomicVFS`). The UI reads mail data from SQLite through
the `Repository` RPC; sync code is the only layer that talks to the
server and mutates the local mail cache.

The schema is intentionally multi-account and protocol-neutral.
Every table that stores remote identifiers scopes them by local
`account_id` and keeps server-assigned identifiers separate from
local database identifiers. This follows Thunderbird Panorama's
lesson that a global SQLite database should use DB-owned ids and
store protocol/server ids as data, because server ids are not
globally unique across accounts or protocols and some protocols
have folder-scoped ids.

## Design Principles

- Use local integer primary keys for all internal joins. Never make a JMAP id, future IMAP UID, Message-Id header, mailbox path, or account name the primary key.
- Scope all remote ids by `account_id`; JMAP ids are only unique within an account.
- Model folder/message membership as a join table. JMAP messages can be in multiple mailboxes, and future protocols may have folder-local state.
- Keep list data cheap and queryable. Message list rows should be satisfied from indexed metadata, not from parsing JSON blobs.
- Store raw JSON as compatibility padding where useful, but keep hot UI fields in columns.
- Store attachment metadata only. Attachment bytes and raw RFC 5322 blobs remain server-side.
- Treat body content as an on-demand cache, not durable source-of-truth data.
- Store sync state and query state explicitly so the sync worker can use `/changes` and `/queryChanges` without relying on in-memory state.
- Folder/message list views are live database views derived from server state. The database does not know how to sync; protocol backends maintain it as a reflection of the authoritative source.

## Message-Folder Model

JMAP allows a single `Email` to belong to multiple `Mailbox`es
(`mailboxIds` is a set). The schema models that with `messages` (a
logical message row) and a many-to-many `folder_messages` junction
(one row per (folder, message) pair).

The current implementation stores **one `messages` row per
`(account_id, JMAP Email id)`**, enforced by the
`UNIQUE(account_id, remote_id)` index on `messages`. When a message
appears in multiple JMAP mailboxes, that single row is joined to
multiple `folder_messages` rows. Read and flag state live on
`messages` because JMAP keywords are message-scoped; conversation
state lives on `threads`.

For future IMAP support without RFC 8474 `OBJECTID`, the same physical
message COPY'd to several folders can carry independent flag state
and folder-scoped UIDs. The schema reserves
`folder_messages.instance_state_json` and
`folder_messages.remote_membership_id` for that case; today's JMAP
sync leaves them null. Adding IMAP would mean populating those
columns rather than rewriting the model.

## Initial Schema

```sql
-- PRAGMA foreign_keys = ON is applied by the engine.
-- PRAGMA journal_mode is left at the engine default for IDBBatchAtomicVFS;
-- WAL has no effect on this VFS because IndexedDB transactions stand in
-- for SQLite's external journal. PRAGMA synchronous = NORMAL is set by
-- the engine as a documented performance win for this VFS.
--
-- The applied-migration version is tracked via PRAGMA user_version (a
-- single 32-bit integer in the database header). The engine writes it
-- inside each migration transaction; no schema-meta table is needed.

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  display_name TEXT,
  primary_email TEXT,
  server_origin TEXT NOT NULL,          -- e.g. https://mail.example.com
  remote_account_id TEXT NOT NULL,      -- JMAP accountId for now; CardDAV principal id, etc., later
  server_kind TEXT,                     -- optional vendor tag, e.g. 'stalwart'
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_opened_at INTEGER,
  UNIQUE(server_origin, remote_account_id)
);

-- Per-account, per-data-service transport state. One real-world account
-- (one user on one Stalwart server) hosts multiple services: JMAP-Mail,
-- CardDAV, optionally JMAP-Contacts/Calendars, possibly IMAP later. Each
-- service maintains its own endpoints, capabilities, and sync cursor.
--
-- service_kind values used by this implementation:
--   'jmap-mail'        JMAP Mail (urn:ietf:params:jmap:mail/submission/vacationresponse)
--   'jmap-contacts'    JMAP Contacts (urn:ietf:params:jmap:contacts)
--   'jmap-calendars'   JMAP Calendars (urn:ietf:params:jmap:calendars)
--   'carddav'          CardDAV (RFC 6352) for read-only contacts in MVP
--   'caldav'           CalDAV (RFC 4791) [future]
--   'imap'             IMAP4rev1+ optionally with OBJECTID (RFC 8474) [future]
CREATE TABLE account_services (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  service_kind TEXT NOT NULL,
  base_url TEXT,                              -- protocol-specific anchor URL
  api_url TEXT,                               -- main API endpoint (JMAP apiUrl, CardDAV principal collection)
  download_url_template TEXT,
  upload_url_template TEXT,
  websocket_url TEXT,                         -- JMAP WebSocket per RFC 8887
  supports_websocket_push INTEGER NOT NULL DEFAULT 0,
  session_state TEXT,                         -- JMAP Session state, or last DAV sync state
  push_state TEXT,                            -- JMAP RFC 8887 pushState (one-shot resume on reconnect)
  config_json TEXT,                           -- per-service extras (CardDAV principal URL, sync depth, etc.)
  last_sync_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, service_kind)
);

-- Per-(account, service) capabilities. JMAP servers list one row per
-- capability URI in the session document; CardDAV/CalDAV report them as
-- DAV property values. Stored as discrete rows so callers can ask
-- "does this service support FOO?" without parsing JSON.
CREATE TABLE account_capabilities (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  service_kind TEXT NOT NULL,
  capability TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(account_id, service_kind, capability)
);

CREATE TABLE folders (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,
  parent_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  role TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  total_emails INTEGER,
  unread_emails INTEGER,
  total_threads INTEGER,
  unread_threads INTEGER,
  may_read_items INTEGER,
  may_add_items INTEGER,
  may_remove_items INTEGER,
  rights_json TEXT,
  raw_json TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(account_id, remote_id),
  UNIQUE(account_id, parent_id, name)
);

CREATE INDEX folders_account_parent_sort
  ON folders(account_id, parent_id, sort_order, name);

CREATE INDEX folders_account_role
  ON folders(account_id, role) WHERE role IS NOT NULL;

CREATE TABLE identities (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,
  name TEXT,
  email TEXT NOT NULL,
  reply_to_json TEXT,
  raw_json TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(account_id, remote_id)
);

CREATE TABLE threads (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,
  email_ids_json TEXT,
  latest_received_at INTEGER,
  latest_sent_at INTEGER,
  message_count INTEGER,
  unread_count INTEGER,
  raw_json TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(account_id, remote_id)
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,
  thread_id INTEGER REFERENCES threads(id) ON DELETE SET NULL,
  remote_thread_id TEXT,
  blob_id TEXT,
  rfc822_message_id TEXT,
  in_reply_to_json TEXT,
  references_json TEXT,
  subject TEXT,
  preview TEXT,
  size INTEGER,
  received_at INTEGER,
  sent_at INTEGER,
  has_attachment INTEGER NOT NULL DEFAULT 0,
  keywords_json TEXT NOT NULL DEFAULT '{}',
  is_seen INTEGER NOT NULL DEFAULT 0,
  is_flagged INTEGER NOT NULL DEFAULT 0,
  is_answered INTEGER NOT NULL DEFAULT 0,
  is_draft INTEGER NOT NULL DEFAULT 0,
  is_forwarded INTEGER NOT NULL DEFAULT 0,
  is_junk INTEGER NOT NULL DEFAULT 0,
  from_text TEXT,
  to_text TEXT,
  raw_json TEXT,
  stale INTEGER NOT NULL DEFAULT 0,
  body_fetched_at INTEGER,
  metadata_fetched_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(account_id, remote_id)
);

CREATE INDEX messages_account_received
  ON messages(account_id, received_at DESC, id DESC);

CREATE INDEX messages_account_sent
  ON messages(account_id, sent_at DESC, id DESC);

CREATE INDEX messages_thread
  ON messages(thread_id, received_at ASC, id ASC);

CREATE INDEX messages_unread
  ON messages(account_id, is_seen, received_at DESC);

CREATE INDEX messages_flagged
  ON messages(account_id, is_flagged, received_at DESC);

CREATE INDEX messages_account_msgid
  ON messages(account_id, rfc822_message_id) WHERE rfc822_message_id IS NOT NULL;

CREATE INDEX messages_account_attachment_received
  ON messages(account_id, received_at DESC) WHERE has_attachment = 1;

CREATE TABLE folder_messages (
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  remote_membership_id TEXT,            -- protocol-neutral folder-local id, if any
  added_at INTEGER,
  sort_received_at INTEGER,
  sort_sent_at INTEGER,
  instance_state_json TEXT,             -- future per-folder/per-message mutable state
  PRIMARY KEY(folder_id, message_id),
  UNIQUE(account_id, folder_id, remote_membership_id)
);

CREATE INDEX folder_messages_by_folder_received
  ON folder_messages(folder_id, sort_received_at DESC, message_id DESC);

CREATE INDEX folder_messages_by_folder_sent
  ON folder_messages(folder_id, sort_sent_at DESC, message_id DESC);

CREATE TABLE message_addresses (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                   -- from, sender, to, cc, bcc, replyTo
  position INTEGER NOT NULL,
  name TEXT,
  email TEXT,
  PRIMARY KEY(message_id, kind, position)
);

CREATE INDEX message_addresses_email
  ON message_addresses(email COLLATE NOCASE);

CREATE TABLE message_keywords (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  PRIMARY KEY(message_id, keyword)
);

CREATE INDEX message_keywords_keyword
  ON message_keywords(keyword, message_id);

CREATE TABLE body_parts (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  blob_id TEXT,
  parent_part_id TEXT,
  media_type TEXT,
  charset TEXT,
  name TEXT,
  disposition TEXT,
  cid TEXT,
  language TEXT,
  location TEXT,
  size INTEGER,
  is_body_text INTEGER NOT NULL DEFAULT 0,
  is_body_html INTEGER NOT NULL DEFAULT 0,
  is_attachment INTEGER NOT NULL DEFAULT 0,
  is_inline INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT,
  UNIQUE(message_id, part_id)
);

CREATE INDEX body_parts_attachments
  ON body_parts(message_id, is_attachment, position);

CREATE TABLE body_values (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL,
  kind TEXT NOT NULL,                   -- text or html
  value TEXT NOT NULL,
  is_truncated INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  byte_size INTEGER,
  PRIMARY KEY(message_id, part_id, kind)
);

CREATE INDEX body_values_lru
  ON body_values(last_accessed_at);

CREATE TABLE query_views (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  view_type TEXT NOT NULL,              -- mailboxMessages, threadMessages, search, etc.
  folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  filter_json TEXT NOT NULL,
  sort_json TEXT NOT NULL,
  collapse_threads INTEGER NOT NULL DEFAULT 0,
  query_state TEXT,
  can_calculate_changes INTEGER,
  total INTEGER,
  up_to_remote_id TEXT,
  stale INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  UNIQUE(account_id, view_type, folder_id, filter_json, sort_json, collapse_threads)
);

CREATE TABLE query_view_items (
  view_id INTEGER NOT NULL REFERENCES query_views(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  remote_id TEXT NOT NULL,
  PRIMARY KEY(view_id, position),
  UNIQUE(view_id, remote_id)
);

CREATE INDEX query_view_items_message
  ON query_view_items(message_id);

CREATE TABLE query_view_ranges (
  view_id INTEGER NOT NULL REFERENCES query_views(id) ON DELETE CASCADE,
  start_position INTEGER NOT NULL,
  end_position INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY(view_id, start_position, end_position)
);

CREATE TABLE sync_states (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL,            -- Mailbox, Email, Thread, Identity, etc.
  scope TEXT NOT NULL DEFAULT '',       -- empty for account-wide; hash for scoped states
  state TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, object_type, scope)
);

CREATE TABLE sync_jobs (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX sync_jobs_ready
  ON sync_jobs(status, priority DESC, not_before, created_at);

CREATE TABLE pending_mutations (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mutation_type TEXT NOT NULL,          -- setSeen, move, delete, send, etc.
  local_status TEXT NOT NULL DEFAULT 'pending',
  target_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  request_json TEXT NOT NULL,
  optimistic_patch_json TEXT,
  server_response_json TEXT,
  error_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX pending_mutations_pending
  ON pending_mutations(account_id, local_status, created_at);

CREATE INDEX query_views_lru
  ON query_views(last_accessed_at);

-- ---------------------------------------------------------------------------
-- Contacts (read-only in MVP, for recipient autocomplete).
--
-- The implemented sync path is JMAP-Contacts when the session document
-- advertises urn:ietf:params:jmap:contacts. CardDAV is supported in the
-- schema (service_kind on addressbooks selects the source) but is not
-- implemented yet; both populate the same tables.
-- ---------------------------------------------------------------------------

CREATE TABLE addressbooks (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  service_kind TEXT NOT NULL,                 -- 'carddav' | 'jmap-contacts'
  remote_id TEXT NOT NULL,                    -- CardDAV collection URL or JMAP AddressBook id
  name TEXT,
  description TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_subscribed INTEGER NOT NULL DEFAULT 1,
  ctag TEXT,                                  -- CardDAV CTag
  sync_token TEXT,                            -- WebDAV-Sync token (RFC 6578) or JMAP changes state
  raw_json TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(account_id, service_kind, remote_id)
);

CREATE TABLE contacts (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  addressbook_id INTEGER NOT NULL REFERENCES addressbooks(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,                    -- CardDAV href or JMAP ContactCard id
  uid TEXT,                                   -- vCard UID (cross-source identity)
  etag TEXT,
  full_name TEXT,                             -- vCard FN
  display_name TEXT,                          -- effective display string for the UI
  given_name TEXT,
  family_name TEXT,
  organization TEXT,
  vcard_text TEXT,                            -- raw vCard 4.0 source if from CardDAV
  vcard_version TEXT,
  raw_json TEXT,                              -- JMAP ContactCard JSON when applicable
  is_deleted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(account_id, addressbook_id, remote_id)
);

CREATE INDEX contacts_account_display_name
  ON contacts(account_id, display_name COLLATE NOCASE);

CREATE INDEX contacts_account_uid
  ON contacts(account_id, uid) WHERE uid IS NOT NULL;

CREATE TABLE contact_emails (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  email TEXT NOT NULL,
  email_lower TEXT GENERATED ALWAYS AS (lower(email)) STORED,
  label TEXT,                                 -- 'home' | 'work' | ...
  is_preferred INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(contact_id, position)
);

CREATE INDEX contact_emails_lookup
  ON contact_emails(email_lower, contact_id);
```

Notes:

- If the selected wa-sqlite build lacks an extension we want, avoid depending on SQLite JSON functions for correctness. JSON columns are storage envelopes; hot query fields are normal columns.
- FTS should not be in the first schema unless we decide local full-text search is in scope. The MVP scope says advanced search is out of scope.

## Common Operations and Indexes

This section maps the typical mail-app read paths to the SQL the schema is shaped for, and explains why each index exists. Every index is a write-amplification cost on the hot inbound paths (`Email/get`, `Email/queryChanges`, vCard PUT-after-sync, etc.), so the set is kept tight: indexes that don't justify themselves against a known query are not added.

### Folder list view, sorted by date

Showing the messages in a folder (Inbox, Trash, an Archive folder) sorted newest-first.

```sql
SELECT m.id, m.remote_id, m.subject, m.from_text, m.preview,
       m.is_seen, m.is_flagged, m.has_attachment,
       fm.sort_received_at AS sort_key
FROM folder_messages fm
JOIN messages m ON m.id = fm.message_id
WHERE fm.folder_id = :folder_id
ORDER BY fm.sort_received_at DESC, fm.message_id DESC
LIMIT :limit OFFSET :offset;
```

`folder_messages_by_folder_received` covers the WHERE + ORDER BY entirely; the JOIN reads `messages` only for rows in the visible window. Sort is on the junction (denormalised `sort_received_at`) rather than `messages.received_at` so the query never visits messages it isn't going to render.

For the Sent folder—or any folder where sent date is the natural sort—use `sort_sent_at` and `folder_messages_by_folder_sent`. The sync engine writes both columns when materialising junction rows.

### Folder list filtered to unread

```sql
SELECT m.*
FROM folder_messages fm
JOIN messages m
  ON m.id = fm.message_id AND m.is_seen = 0
WHERE fm.folder_id = :folder_id
ORDER BY fm.sort_received_at DESC
LIMIT :limit;
```

Window is found by `folder_messages_by_folder_received`; filter is post-join on `messages.is_seen`. Acceptable for typical folder sizes—we explicitly do not add a `(folder_id, is_seen, sort_received_at)` covering index because (a) "unread only" is a toggle, not the default view, (b) the index would be carried on every folder-membership write, and (c) once Model B (per-folder flag state) lands, the filter belongs on the junction, not the message.

### Conversation / thread view

All messages in a thread, oldest-first.

```sql
SELECT * FROM messages
WHERE thread_id = :thread_id
ORDER BY received_at ASC, id ASC;
```

`messages_thread` covers this. The same index also lets the sync engine ask "what message ids do we have for this thread?" cheaply when reconciling `Thread/get` responses.

### Smart folder: account-wide flagged / unread

```sql
SELECT * FROM messages
WHERE account_id = :account_id AND is_flagged = 1
ORDER BY received_at DESC;
```

`messages_flagged ON (account_id, is_flagged, received_at DESC)` and the parallel `messages_unread` cover the two hot keyword filters (`$flagged`, `$seen`). Equivalent queries against arbitrary keywords go through `message_keywords` (below).

### Smart folder: arbitrary keyword

For non-hot keywords (`$answered`, `$junk`, `$forwarded`, custom labels):

```sql
SELECT m.*
FROM message_keywords mk
JOIN messages m ON m.id = mk.message_id
WHERE mk.keyword = :keyword AND m.account_id = :account_id
ORDER BY m.received_at DESC;
```

`message_keywords_keyword ON (keyword, message_id)` is the join driver. Sort comes from `messages` and is post-join; small result sets (custom-keyword filters are usually narrow) make this fine.

### Recipient autocomplete

Compose typeahead, sourcing from both the contacts store (CardDAV / JMAP-Contacts) and from sender/recipient history (`message_addresses`).

```sql
SELECT 'contact' AS source, c.display_name AS name, ce.email AS email
FROM contact_emails ce
JOIN contacts c ON c.id = ce.contact_id
WHERE ce.email_lower LIKE :prefix || '%'
  AND c.account_id = :account_id
  AND c.is_deleted = 0
LIMIT 10
UNION ALL
SELECT 'history' AS source, ma.name, ma.email
FROM message_addresses ma
JOIN messages m ON m.id = ma.message_id
WHERE ma.email LIKE :prefix || '%' COLLATE NOCASE
  AND m.account_id = :account_id
LIMIT 20;
```

`contact_emails_lookup ON (email_lower, contact_id)` and `message_addresses_email ON (email COLLATE NOCASE)` both serve `LIKE :prefix || '%'` as range scans. The stored generated `email_lower` column on `contact_emails` is what makes the prefix match index-friendly across vCards regardless of original case.

### Search by sender

```sql
SELECT m.*
FROM message_addresses ma
JOIN messages m ON m.id = ma.message_id
WHERE ma.kind IN ('from','sender')
  AND ma.email = :email COLLATE NOCASE
  AND m.account_id = :account_id
ORDER BY m.received_at DESC;
```

Driven off `message_addresses_email` for the lookup, sort fulfilled by `messages_account_received` if the engine chooses to use it for the order. This is the path future "show emails from X" features take, and it's the reason addresses live in their own table at all rather than in JSON on the message row.

### Folder by role

"Where is the inbox/sent/drafts/trash for this account?"

```sql
SELECT * FROM folders
WHERE account_id = :account_id AND role = :role;
```

`folders_account_role ON (account_id, role) WHERE role IS NOT NULL` (partial). Most folders have no role; the partial index keeps the index size proportional to the number of role-bearing folders.

### Message-Id-based dedup and reverse threading

```sql
SELECT id FROM messages
WHERE account_id = :account_id AND rfc822_message_id = :msgid;
```

`messages_account_msgid ON (account_id, rfc822_message_id) WHERE rfc822_message_id IS NOT NULL`. The sync engine uses this when a second source (a future IMAP feed, an `Email/import`, a duplicate that came in via different folders before threadId was assigned) needs to detect "we already have this logical message". Also used to reconstruct in-reply-to / references graphs locally when a server's threadId algorithm is unavailable.

### Has-attachment filter

```sql
SELECT * FROM messages
WHERE account_id = :account_id AND has_attachment = 1
ORDER BY received_at DESC;
```

`messages_account_attachment_received ON (account_id, received_at DESC) WHERE has_attachment = 1`. Partial on `has_attachment = 1` keeps it small (most messages aren't attachments) while answering the common "files" view directly from the index.

### Sync job draining

```sql
SELECT id, job_type, payload_json
FROM sync_jobs
WHERE status = 'pending'
  AND (not_before IS NULL OR not_before <= :now)
ORDER BY priority DESC, not_before, created_at
LIMIT :batch_size;
```

`sync_jobs_ready ON (status, priority DESC, not_before, created_at)`.

### Pending mutations awaiting send

```sql
SELECT * FROM pending_mutations
WHERE account_id = :account_id
  AND local_status IN ('pending','retry')
ORDER BY created_at;
```

`pending_mutations_pending ON (account_id, local_status, created_at)`.

### LRU eviction (bodies, query views)

```sql
DELETE FROM body_values
WHERE last_accessed_at < :cutoff
ORDER BY last_accessed_at LIMIT :batch;
```

```sql
DELETE FROM query_views
WHERE last_accessed_at < :cutoff;
```

`body_values_lru` and `query_views_lru`. Both eviction paths work newest-first and respect a total byte cap maintained in code.

### Operations we deliberately do not index for

- **Sort by subject across an account.** JMAP `Email/query` with `sort: subject` returns an authoritative order; we cache it via `query_views`/`query_view_items`. A `messages(subject)` index is read rarely enough that the write cost isn't justified.
- **Body full-text search.** Out of scope for MVP. When added, the right tool is FTS5 over `messages(subject, preview)` and `body_values(value)`, not a B-tree index.
- **Threaded folder list with collapsed conversations.** JMAP's `Email/query` with `collapseThreads: true` returns the threads-in-folder ordering; we cache it as a query view. There is no client-side computation that would benefit from a different index.
- **Cross-folder unified inbox.** Already supported by `messages_account_received` if needed; no folder index required.

## What Lives Where

Memory:

- Current route, selected account/folder/message, compose editor state, transient loading/error state.
- Current viewport rows and a small overscan window loaded from SQLite.
- WebSocket connection state and in-flight request bookkeeping.
- Short-lived sanitized HTML render output and object URLs for inline blobs.

SQLite (IndexedDB-backed):

- Account/session metadata, endpoints, capabilities, push state.
- Folder tree, identities, message list metadata, thread metadata, keywords, address rows.
- Query view state and sparse query result positions.
- Body part metadata and attachment metadata.
- Recently viewed body text/html values, subject to an LRU/size cap.
- Pending mutations and sync job state.

Server only:

- Attachment bytes.
- Raw RFC5322 message blobs.
- Large body values that have not been opened or are past the local body-cache cap.
- Mail outside any locally cached query range, except for server counts and query state.

## JMAP Sync Strategy

Initial connect:

1. Fetch the JMAP Session document over HTTPS.
2. Upsert `accounts` and one `account_services` row per advertised data service (`jmap-mail` always; `jmap-contacts`/`jmap-calendars` when their capabilities are present). Capabilities are fanned out into `account_capabilities` rows keyed by `(account_id, service_kind, capability)`.
3. Open the JMAP WebSocket if `urn:ietf:params:jmap:websocket` is present; send `WebSocketPushEnable` for `Mailbox`, `Email`, `Thread`, `Identity`, and `EmailDelivery`, passing the stored `push_state` from `account_services` if any. The server will immediately push any state changes that occurred while disconnected.
4. Load cached folders, the last opened view, and the contacts cache from SQLite immediately for the UI.
5. Sync `Mailbox/get` or `Mailbox/changes`, then create/update the Inbox query view. In parallel, run the addressbook discovery and initial contacts sync (CardDAV `PROPFIND` + `addressbook-multiget`, or `AddressBook/get` + `ContactCard/get` if using JMAP-Contacts) so autocomplete is ready.

Visible mailbox sync:

1. Run `Email/query` for the visible mailbox with `position`/`limit` sized for the viewport plus overscan.
2. Store `query_state`, `total`, and returned ids in `query_views` and `query_view_items`.
3. Fetch list metadata for missing ids with `Email/get`, using only fast properties: `id`, `blobId`, `threadId`, `mailboxIds`, `keywords`, `size`, `receivedAt`, `messageId`, `inReplyTo`, `references`, `sender`, `from`, `to`, `cc`, `bcc`, `replyTo`, `subject`, `sentAt`, `hasAttachment`, and `preview`.
4. Upsert `messages`, `threads`, `folder_messages`, `message_addresses`, and `message_keywords` in one transaction.

Delta sync:

- Use `Email/queryChanges` for active query views. Apply `removed` and `added` by updating `query_view_items` positions, then fetch metadata for newly visible/missing ids.
- Use `Email/changes` for account-wide object cache freshness where we have cached objects outside active views.
- Use `Mailbox/changes` to maintain the folder tree and counts.
- Use `Thread/changes` or targeted `Thread/get` when changed messages affect visible conversations.
- On `tooManyChanges`, retry with a larger limit within Stalwart's advertised limits. On `cannotCalculateChanges`, invalidate only the affected object/query cache and reload visible ranges first.
- Use `upToId` for large immutable-sort query ranges when possible, so the server can omit changes beyond the locally cached prefix.

Message detail:

1. Render metadata from SQLite immediately.
2. If body values are missing or stale, fetch `Email/get` with `bodyStructure`, `textBody`, `htmlBody`, `attachments`, body properties, and `fetchTextBodyValues`/`fetchHTMLBodyValues`.
3. Store body part and attachment metadata. Store text/html body values only if under the body-cache policy.
4. If a body value is truncated, fetch the body part blob as text for display, but do not store attachment blobs.

Mutation flow:

- UI actions write a `pending_mutations` row and apply an optimistic SQLite transaction.
- The sync worker sends the JMAP request.
- On success, reconcile from the returned ids/states and then from `/changes` if necessary.
- On failure, either roll back the optimistic patch or mark the row conflicted and resync the affected message/query.

## Loading Policy

The UI should be responsive from local data first and increasingly correct as sync catches up:

- On app start, show cached folder list and cached first page for the last opened mailbox immediately.
- Prioritize network work in this order: session/endpoints, folder tree, visible mailbox query, visible rows metadata, selected message body, ahead-of-scroll rows, adjacent message bodies, low-priority background refresh.
- For virtual scrolling, fetch by visible range rather than by arbitrary pages. Keep the current viewport plus 2-3 screens ahead warm.
- When the user selects a message, prefetch metadata/body for the next and previous visible messages only if the network queue is idle.
- Background prefetch should be cancellable on folder switch and should respect Stalwart limits such as `getMaxResults`, `queryMaxResults`, `changesMaxResults`, and `maxConcurrentRequests`.
- Body cache eviction should be based on total byte cap and `last_accessed_at`, not message age alone.

## Thunderbird Panorama Takeaways

Thunderbird's Panorama project stores all folders and messages in one SQLite database rather than one database per folder. The design uses DB-assigned IDs, folder and message tables, property side tables, indexes for folder/date/flags/thread, and LiveView adapters that keep front-end message lists current.

The most relevant lessons for this webmail app are:

- A global DB needs local IDs; remote IDs belong in separate scoped columns.
- Folder/message list views should be live database views, not protocol objects held in memory.
- Front-end rows should be plain objects produced from queries for performance.
- Sparse/lazy list loading is a first-class design concern.
- The database should not know how to sync. Protocol adapters maintain it as a reflection of authoritative sources.

