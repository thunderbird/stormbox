-- Initial schema for the Stormbox local cache.
-- Mirrors docs/architecture/sqlite-storage.md. See that document for the rationale
-- behind every table, every index, and the message-folder model decisions.
-- Update both this file and the spec when changing the schema.
--
-- PRAGMA settings (foreign_keys, journal_mode, synchronous) are applied by
-- the engine when it opens the connection, not in the migration file: PRAGMAs
-- like synchronous cannot run inside a transaction, and migrations always run
-- in one. The applied-migration marker is tracked via PRAGMA user_version,
-- which the engine writes inside the migration transaction.

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  display_name TEXT,
  primary_email TEXT,
  server_origin TEXT NOT NULL,
  remote_account_id TEXT NOT NULL,
  server_kind TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_opened_at INTEGER,
  UNIQUE(server_origin, remote_account_id)
);

CREATE TABLE account_services (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  service_kind TEXT NOT NULL,
  base_url TEXT,
  api_url TEXT,
  download_url_template TEXT,
  upload_url_template TEXT,
  websocket_url TEXT,
  supports_websocket_push INTEGER NOT NULL DEFAULT 0,
  session_state TEXT,
  push_state TEXT,
  config_json TEXT,
  last_sync_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, service_kind)
);

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
  remote_membership_id TEXT,
  added_at INTEGER,
  sort_received_at INTEGER,
  sort_sent_at INTEGER,
  instance_state_json TEXT,
  PRIMARY KEY(folder_id, message_id),
  UNIQUE(account_id, folder_id, remote_membership_id)
);

CREATE INDEX folder_messages_by_folder_received
  ON folder_messages(folder_id, sort_received_at DESC, message_id DESC);

CREATE INDEX folder_messages_by_folder_sent
  ON folder_messages(folder_id, sort_sent_at DESC, message_id DESC);

CREATE TABLE message_addresses (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
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
  kind TEXT NOT NULL,
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
  view_type TEXT NOT NULL,
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
  object_type TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
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
  mutation_type TEXT NOT NULL,
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

CREATE TABLE addressbooks (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  service_kind TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  name TEXT,
  description TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_subscribed INTEGER NOT NULL DEFAULT 1,
  ctag TEXT,
  sync_token TEXT,
  raw_json TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(account_id, service_kind, remote_id)
);

CREATE TABLE contacts (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  addressbook_id INTEGER NOT NULL REFERENCES addressbooks(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,
  uid TEXT,
  etag TEXT,
  full_name TEXT,
  display_name TEXT,
  given_name TEXT,
  family_name TEXT,
  organization TEXT,
  vcard_text TEXT,
  vcard_version TEXT,
  raw_json TEXT,
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
  label TEXT,
  is_preferred INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(contact_id, position)
);

CREATE INDEX contact_emails_lookup
  ON contact_emails(email_lower, contact_id);
