# Stormbox SQLite Storage

This document describes the local SQLite storage layout used by
Stormbox and the sync strategy that fills it. It pairs with
`performance.md` (runtime architecture and patterns) and the spec at
`../../specs/001-mvp-scope/spec.md` (capabilities and requirements).

## Scope

The first implementation target is JMAP against Stalwart over
WebSocket, with wa-sqlite backed by IndexedDB
(`IDBBatchAtomicVFS`). The UI reads mail data from SQLite through
the `Repository` RPC. Protocol backends are the only layer that talk
to the server; worker handlers own SQLite writes, including
client-local preferences requested through `Repository`.

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

## Effective Schema

The migrations in `src/db/migrations/` are canonical. This selected
schema shows the current architectural shape after migrations 001–015.

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
  is_personal INTEGER NOT NULL DEFAULT 1, -- JMAP Account isPersonal: 0 for accounts shared by other principals (RFC 8620 §1.6.2)
  quota_used_bytes INTEGER,
  quota_hard_limit_bytes INTEGER,
  quota_updated_at INTEGER,
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
--   'jmap-calendars'   JMAP Calendars (urn:ietf:params:jmap:calendars) [future]
--   'carddav'          CardDAV (RFC 6352) [future]
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

-- One marked, versioned settings document per account. The FileNode id is
-- only a cache; sync re-resolves thundermail/stormbox-settings.json.
CREATE TABLE user_settings (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  doc_json TEXT NOT NULL,
  remote_node_id TEXT,
  updated_at INTEGER NOT NULL
);

-- Physical contacts-trash shards are stored separately from settings.
-- Dirty state and revisions make uploads shard-local and race-safe.
CREATE TABLE contacts_trash_documents (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  shard_name TEXT NOT NULL,
  doc_json TEXT NOT NULL,
  remote_node_id TEXT,
  remote_blob_id TEXT,
  dirty INTEGER NOT NULL DEFAULT 0 CHECK (dirty IN (0, 1)),
  local_revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, shard_name)
);

CREATE INDEX contacts_trash_documents_dirty
  ON contacts_trash_documents(account_id, dirty, shard_name);

CREATE TABLE contacts_trash_state (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  open_shard_name TEXT NOT NULL,
  open_tombstone_shard_name TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Deterministic LWW projection across all physical shards.
CREATE TABLE contacts_trash (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  prior_remote_id TEXT NOT NULL,
  original_addressbook_ids_json TEXT NOT NULL,
  snapshot_json TEXT,
  media_json TEXT NOT NULL,
  projection_fingerprint TEXT NOT NULL,
  display_name TEXT NOT NULL,
  primary_email TEXT,
  trashed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('trashed', 'restored', 'purged')),
  lifecycle_updated_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(account_id, uid)
);

CREATE INDEX contacts_trash_account_status_expiry
  ON contacts_trash(account_id, status, expires_at, id);

CREATE TABLE contacts_trash_emails (
  trash_id INTEGER NOT NULL REFERENCES contacts_trash(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  email_key TEXT NOT NULL,
  PRIMARY KEY(trash_id, email_key)
);

CREATE INDEX contacts_trash_emails_account_key
  ON contacts_trash_emails(account_id, email_key, trash_id);

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
  is_subscribed INTEGER,                -- JMAP Mailbox isSubscribed (RFC 8621 §2); NULL = server never reported it
  is_starred INTEGER NOT NULL DEFAULT 0, -- client-local
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
  bcc_json TEXT,
  text_signature TEXT,
  html_signature TEXT,
  may_delete INTEGER CHECK (may_delete IS NULL OR may_delete IN (0, 1)),
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
  view_type TEXT NOT NULL,              -- implemented value: mailbox-window
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
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER,
  last_attempt_at INTEGER,
  phase TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX pending_mutations_ready
  ON pending_mutations(account_id, local_status, not_before, created_at);

CREATE INDEX query_views_lru
  ON query_views(last_accessed_at);

-- ---------------------------------------------------------------------------
-- Contacts (synced and mutated for address-book management, trust, and
-- recipient autocomplete).
--
-- The implemented sync path is JMAP-Contacts when the session document
-- advertises urn:ietf:params:jmap:contacts. CardDAV is schema-only
-- (service_kind on addressbooks); it does not populate these tables.
-- ---------------------------------------------------------------------------

CREATE TABLE addressbooks (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  service_kind TEXT NOT NULL,                 -- 'carddav' | 'jmap-contacts'
  remote_id TEXT NOT NULL,                    -- CardDAV collection URL or JMAP AddressBook id
  name TEXT,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_subscribed INTEGER NOT NULL DEFAULT 1,
  may_write INTEGER CHECK (may_write IS NULL OR may_write IN (0, 1)),
  may_delete INTEGER CHECK (may_delete IS NULL OR may_delete IN (0, 1)),
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
  sync_generation INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(account_id, remote_id)
);

CREATE INDEX contacts_account_display_name
  ON contacts(account_id, display_name COLLATE NOCASE);

CREATE INDEX contacts_account_uid
  ON contacts(account_id, uid) WHERE uid IS NOT NULL;

CREATE INDEX contacts_account_generation
  ON contacts(account_id, sync_generation);

CREATE TABLE contact_emails (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL,                    -- denormalized from contacts for account-scoped lookup
  position INTEGER NOT NULL DEFAULT 0,
  email TEXT NOT NULL,
  email_key TEXT,                             -- written by addressKey(), not SQL
  map_key TEXT,
  label TEXT,                                 -- 'home' | 'work' | ...
  contexts_json TEXT NOT NULL DEFAULT '[]',
  pref INTEGER CHECK (pref IS NULL OR (pref >= 1 AND pref <= 100)),
  is_preferred INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(contact_id, position)
);

CREATE INDEX contact_emails_key_lookup
  ON contact_emails(account_id, email_key, contact_id);

CREATE UNIQUE INDEX contact_emails_map_key
  ON contact_emails(contact_id, map_key) WHERE map_key IS NOT NULL;

CREATE TABLE contact_phones (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  map_key TEXT,
  value TEXT NOT NULL,
  label TEXT,
  contexts_json TEXT NOT NULL DEFAULT '[]',
  features_json TEXT NOT NULL DEFAULT '[]',
  pref INTEGER CHECK (pref IS NULL OR (pref >= 1 AND pref <= 100)),
  PRIMARY KEY(contact_id, position)
);

CREATE UNIQUE INDEX contact_phones_map_key
  ON contact_phones(contact_id, map_key) WHERE map_key IS NOT NULL;

CREATE TABLE contact_links (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  map_key TEXT,
  value TEXT NOT NULL,
  label TEXT,
  contexts_json TEXT NOT NULL DEFAULT '[]',
  pref INTEGER CHECK (pref IS NULL OR (pref >= 1 AND pref <= 100)),
  PRIMARY KEY(contact_id, position)
);

CREATE UNIQUE INDEX contact_links_map_key
  ON contact_links(contact_id, map_key) WHERE map_key IS NOT NULL;

CREATE TABLE contact_anniversaries (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  map_key TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('birth', 'death', 'wedding')),
  date_kind TEXT NOT NULL CHECK (date_kind IN ('partial', 'timestamp')),
  date_year INTEGER,
  date_month INTEGER,
  date_day INTEGER,
  date_utc TEXT,
  PRIMARY KEY(contact_id, position)
);

CREATE UNIQUE INDEX contact_anniversaries_map_key
  ON contact_anniversaries(contact_id, map_key) WHERE map_key IS NOT NULL;

CREATE TABLE contact_notes (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  map_key TEXT,
  value TEXT NOT NULL,
  PRIMARY KEY(contact_id, position)
);

CREATE UNIQUE INDEX contact_notes_map_key
  ON contact_notes(contact_id, map_key) WHERE map_key IS NOT NULL;

CREATE TABLE contact_organizations (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  map_key TEXT,
  name TEXT,
  contexts_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(contact_id, position)
);

CREATE UNIQUE INDEX contact_organizations_map_key
  ON contact_organizations(contact_id, map_key) WHERE map_key IS NOT NULL;

CREATE TABLE contact_organization_units (
  contact_id INTEGER NOT NULL,
  organization_position INTEGER NOT NULL,
  position INTEGER NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY(contact_id, organization_position, position),
  FOREIGN KEY(contact_id, organization_position)
    REFERENCES contact_organizations(contact_id, position)
    ON DELETE CASCADE
);

CREATE TABLE contact_titles (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  map_key TEXT,
  value TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('role', 'title')),
  organization_map_key TEXT,
  PRIMARY KEY(contact_id, position)
);

CREATE UNIQUE INDEX contact_titles_map_key
  ON contact_titles(contact_id, map_key) WHERE map_key IS NOT NULL;

CREATE TABLE contact_media (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  map_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  blob_id TEXT,
  uri TEXT,
  media_type TEXT,
  pref INTEGER CHECK (pref IS NULL OR (pref >= 1 AND pref <= 100)),
  PRIMARY KEY(contact_id, position),
  UNIQUE(contact_id, map_key),
  CHECK (blob_id IS NOT NULL OR uri IS NOT NULL)
);

CREATE INDEX contact_media_preferred_photo
  ON contact_media(contact_id, kind, pref, position);

CREATE TABLE addressbook_contacts (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  addressbook_id INTEGER NOT NULL REFERENCES addressbooks(id) ON DELETE CASCADE,
  PRIMARY KEY(contact_id, addressbook_id)
);

CREATE INDEX addressbook_contacts_book
  ON addressbook_contacts(addressbook_id, contact_id);

CREATE TABLE contact_search_tokens (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL,
  token TEXT NOT NULL,                        -- written by nameTokens(), not SQL
  PRIMARY KEY(contact_id, token)
);

CREATE INDEX contact_search_tokens_prefix
  ON contact_search_tokens(account_id, token, contact_id);

CREATE TABLE recipient_usage (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email_key TEXT NOT NULL,
  send_count INTEGER NOT NULL,
  last_sent_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, email_key)
);
```

Notes:

- Contact-detail and media tables keep ordered `position` keys and unique `map_key` indexes so JSContact map entries survive round-trips. Migration 009 enforces the anniversary date-kind CHECK. Migration 014 adds media and clears the ContactCard sync state so existing server photos are projected without changing contact row ids. Migration 015 adds AddressBook ordering and fail-closed delete rights.
- Migrated contact addresses keep `email_key = NULL` and migrated contacts have no search-token rows. Bootstrap's full contact sync writes both through the application tokenizer, avoiding SQLite's ASCII-only `lower()` and different punctuation rules.
- If the selected wa-sqlite build lacks an extension we want, avoid depending on SQLite JSON functions for correctness. JSON columns are storage envelopes; hot query fields are normal columns.
- FTS should not be in the first schema unless we decide local full-text search is in scope. The MVP scope says advanced search is out of scope.

## Common Operations and Indexes

This section maps the typical mail-app read paths to the SQL the schema is shaped for, and explains why each index exists. Every index is a write-amplification cost on the hot inbound paths (`Email/get`, `Email/queryChanges`, vCard PUT-after-sync, etc.), so the set is kept tight: indexes that don't justify themselves against a known query are not added.

### Folder list view

The painted folder list is `MESSAGE_LIST_FOR_VIEW`: JMAP `Email/query`
positions in `query_view_items`, joined to `messages` on
`(account_id, remote_id)`. `view_type` is `mailbox-window`. The matching
`query_views` row is the unique
`(account_id, view_type, folder_id, filter_json, sort_json, collapse_threads)`
probe. `query_views.total` is the list count.

```sql
SELECT m.*, qi.position AS view_position
FROM query_view_items qi
JOIN messages m
  ON m.account_id = :account_id
 AND m.remote_id = qi.remote_id
WHERE qi.view_id = :view_id
  AND qi.position >= :offset
  AND qi.position < :offset + :limit
ORDER BY qi.position;
```

`folder_messages_by_folder_received` / `_sent` still cover membership
writes and `MESSAGE_LIST_FOR_FOLDER`. An `OFFSET` over `folder_messages`
is the sparse-cache failure described in `performance.md`; the mail store
does not use that handler to paint.

Unread is a client filter over the same `query_view_items` window
(`MessageList.vue` `unreadOnly`), not a `folder_messages` + `is_seen`
SQL path.

### Conversation / thread view

`messages_thread` and `MESSAGE_LIST_FOR_THREAD` are reserved. No
implemented list or `Thread/get` path uses them. Thread rows are upserted
from `Email.threadId`.

### Smart folder: account-wide flagged / unread

`messages_flagged` and `messages_unread` are reserved. No implemented
list uses these queries.

### Smart folder: arbitrary keyword

`message_keywords_keyword ON (keyword, message_id)` is reserved for a
future keyword filter. No implemented list uses it.

### Recipient autocomplete

Compose typeahead sources candidates only from live ContactCards. A disposable
`recipient_usage` table supplies count/recency boosts derived from the newest
300 Sent messages; it cannot make a deleted or unsaved address suggestible.

```sql
SELECT c.display_name AS name,
       ce.email,
       ce.is_preferred,
       coalesce(ru.send_count, 0) AS send_count,
       ru.last_sent_at
FROM contact_emails ce
JOIN contacts c ON c.id = ce.contact_id
LEFT JOIN recipient_usage ru
  ON ru.account_id = c.account_id
 AND ru.email_key = ce.email_key
WHERE ce.account_id = :account_id
  AND c.account_id = ce.account_id
  AND c.is_deleted = 0
  AND ce.email_key >= :prefix
  AND ce.email_key < :prefix_upper
LIMIT :pool;
```

Prefix SQL uses `poolSize(limit)` (`min(max(limit*4, 40), 200)`). The
default cut is 20 (`autocomplete.ts` / `repository.autocompleteContacts`).
`contact_emails_key_lookup` drives exact and prefix address matching within
one account; the denormalized `contact_emails.account_id` keeps those reads
inside one bounded index range before joining the matching contacts.
`contact_search_tokens_prefix` supplies unordered word-prefix name matching.
Autocomplete merges duplicate card rows by `addressKey`, applies match tier
before preferred/recency/frequency boosts, then cuts to `limit`.

The usage cache is replaced transactionally at startup/reconnect and after a
Sent change batch. Confirmed sends create missing ContactCards in the
server-synchronized `Trusted senders` book through the mutation outbox; the
cache itself never creates contacts.

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

`messages_account_msgid ON (account_id, rfc822_message_id) WHERE rfc822_message_id IS NOT NULL`. Reserved for compose/reply and a future second source. JMAP sync keys messages by `(account_id, remote_id)`; nothing in sync or the outbox reads this index.

### Has-attachment filter

`messages_account_attachment_received` is reserved. No implemented list uses it.

### Sync job draining

`sync_jobs` and `SYNC_JOB_INSERT` / `SYNC_JOB_NEXT_BATCH` exist; only
unit tests call them. Background work is the in-memory metadata indexer
in `JmapBackend`, not this table.

### Pending mutations awaiting send

```sql
SELECT * FROM pending_mutations
WHERE account_id = :account_id
  AND local_status IN ('pending','retry')
  AND (not_before IS NULL OR not_before <= :now)
ORDER BY created_at;
```

`pending_mutations_ready ON (account_id, local_status, not_before, created_at)`.

### Cache eviction metadata

`body_values_lru` and `query_views_lru` support future eviction by
`last_accessed_at`. No body or query-view eviction loop or total-byte cap is
implemented yet.

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
- Short-lived sanitized HTML render output, object URLs for inline
  blobs, and ephemeral attachment-preview object URLs.

SQLite (IndexedDB-backed):

- Account/session metadata, endpoints, capabilities, push state.
- Folder tree, identities, message list metadata, thread metadata, keywords, address rows.
- Address books, contacts, keyed contact details, and recipient-usage ranking.
- User settings and contacts-trash shards/projection.
- Query view state and sparse query result positions.
- Body part metadata and attachment metadata.
- Fetched body text/html values; eviction is not implemented yet.
- Pending mutations. `sync_jobs` exists but is unused.

Server only:

- Attachment bytes.
- Raw RFC5322 message blobs.
- Body values that have not been fetched into the local cache.
- Mail outside any locally cached query range, except for server counts and query state.

## JMAP Sync Strategy

Initial connect:

1. Fetch the JMAP Session document over HTTPS.
2. Upsert the primary account and every other session account (`is_personal` from the session). Fan out `account_services` / `account_capabilities` for advertised mail and contacts. A `jmap-calendars` row may be written; there is no calendar sync.
3. Blocking: `Mailbox/get` for the primary account, then each shared account (best-effort). `start()` returns here. The UI paints from SQLite folder rows. There is no persisted last-opened mailbox (`last_opened_at` is never written).
4. Background: identities → settings FileNode → contacts-trash FileNodes → JMAP contacts (if advertised) → Sent `recipient_usage` rebuild → open WS + `WebSocketPushEnable` (`Mailbox`, `Email`, `Thread`, `Identity`, `EmailDelivery`, `AddressBook`, `ContactCard`, and `FileNode` when the primary account has the capability) → `_refreshActiveQueryViews` (existing `mailbox-window` rows) → metadata indexer. If WS fails, the backend stays on HTTP. The first visible window is created when the UI calls `ensureFolderWindow`. CardDAV remains a schema-compatible future backend.

Visible mailbox sync:

1. One envelope: chained `Email/query` + `Email/get` with back-references (`#ids` `/ids`, or `/added/*/id` after `Email/queryChanges`).
2. Persist through `FOLDER_WINDOW_PERSIST_BATCH` / `FOLDER_WINDOW_APPLY_CHANGES_BATCH`: `query_state`, `total`, positional ids, threads, messages, addresses, keywords, and folder memberships.
3. Fast `Email/get` properties: `id`, `blobId`, `threadId`, `mailboxIds`, `keywords`, `size`, `receivedAt`, `messageId`, `inReplyTo`, `references`, `sender`, `from`, `to`, `cc`, `bcc`, `replyTo`, `subject`, `sentAt`, `hasAttachment`, and `preview`.

Delta sync:

- Use `Email/queryChanges` for active query views. Apply `removed` and `added` by updating `query_view_items` positions, then fetch metadata for newly visible/missing ids.
- Use `Email/changes` for account-wide object cache freshness where we have cached objects outside active views.
- Use `Mailbox/changes` to maintain the folder tree and counts. Error or missing payload → `needsFullSync`, then full reload of that slice.
- `Thread/changes` / targeted `Thread/get` are not implemented. Thread rows are upserted from `Email.threadId`.
- Mail/email `tooManyChanges` falls through to full sync; there is no larger-limit retry. FileNode discovery can report `tooManyChanges`.
- `query_views.up_to_remote_id` exists; nothing reads or writes it.

Message detail:

1. Render metadata from SQLite immediately.
2. If body values are missing or stale, fetch `Email/get` with `bodyStructure`, `textBody`, `htmlBody`, `attachments`, body properties, and `fetchTextBodyValues`/`fetchHTMLBodyValues`.
3. Store body part, attachment metadata, and fetched text/html body values.
4. If a body value is truncated, fetch the body part blob as text for display, but do not store attachment blobs. Attachment preview and download bytes remain ephemeral worker transfers (`specs/010-attachments/spec.md` AT-3).

Mutation flow:

- UI actions write a `pending_mutations` row and apply an optimistic SQLite transaction. A settings patch and its coalesced `pushSettings` row are committed together.
- The outbox records retry timing and durable phases for send, contact, and
  AddressBook operations whose server result may outlive a lost response.
- AddressBook create snapshots the pre-create set for unique recovery.
  Confirmed permanent deletion rechecks an authoritative contact inventory,
  sends `onDestroyRemoveContents: true`, then repairs both AddressBooks and
  ContactCards before resolving.
- The sync worker sends the JMAP request.
- On success, reconcile from the returned ids/states and then from `/changes` if necessary.
- On failure, either roll back the optimistic patch or mark the row conflicted and resync the affected message/query.

## Loading Policy

The UI should be responsive from local data first and increasingly correct as sync catches up:

- On app start, show the cached folder list immediately. Session
  `folderStates` remember open folders for the tab; there is no last-mailbox
  persistence.
- Prioritize network work in this order: session/endpoints, folder tree, visible mailbox query, visible rows metadata, selected message body, ahead-of-scroll rows, adjacent message bodies, low-priority background refresh.
- For virtual scrolling, fetch by visible range rather than by arbitrary pages. The virtualizer `overscan` is 8 rows; `ensureLoaded` uses the visible range / `PAGE_SIZE` 100.
- When the user selects a message, `selectMessage` always enqueues idx+1, idx+2, and idx−1.
- Background prefetch is cancellable on folder switch. Live clamps are Core `maxObjectsInGet` / `maxObjectsInSet` / `maxSizeUpload`.
- Future body-cache eviction should use a total byte cap and
  `last_accessed_at`, not message age alone.

## Thunderbird Panorama Takeaways

Thunderbird's Panorama project stores all folders and messages in one SQLite database rather than one database per folder. The design uses DB-assigned IDs, folder and message tables, property side tables, indexes for folder/date/flags/thread, and LiveView adapters that keep front-end message lists current.

The most relevant lessons for this webmail app are:

- A global DB needs local IDs; remote IDs belong in separate scoped columns.
- Folder/message list views should be live database views, not protocol objects held in memory.
- Front-end rows should be plain objects produced from queries for performance.
- Sparse/lazy list loading is a first-class design concern.
- The database should not know how to sync. Protocol adapters maintain it as a reflection of authoritative sources.

