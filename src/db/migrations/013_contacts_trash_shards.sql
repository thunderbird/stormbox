-- Preserve the applied v12 schema and migrate its single document into the
-- read-only legacy shard.
ALTER TABLE contacts_trash_documents RENAME TO contacts_trash_documents_v12;

CREATE TABLE contacts_trash_documents (
  account_id       INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  shard_name       TEXT NOT NULL,
  doc_json         TEXT NOT NULL,
  remote_node_id   TEXT,
  remote_blob_id   TEXT,
  dirty            INTEGER NOT NULL DEFAULT 0 CHECK (dirty IN (0, 1)),
  local_revision   INTEGER NOT NULL DEFAULT 1,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY(account_id, shard_name)
);

INSERT INTO contacts_trash_documents(
  account_id, shard_name, doc_json, remote_node_id, remote_blob_id,
  dirty, local_revision, updated_at
)
SELECT
  account_id, 'stormbox-contacts-trash.json', doc_json, remote_node_id, NULL,
  0, 1, updated_at
FROM contacts_trash_documents_v12;

DROP TABLE contacts_trash_documents_v12;

CREATE INDEX contacts_trash_documents_dirty
  ON contacts_trash_documents(account_id, dirty, shard_name);

CREATE TABLE contacts_trash_state (
  account_id                    INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  open_shard_name               TEXT NOT NULL,
  open_tombstone_shard_name     TEXT NOT NULL,
  updated_at                    INTEGER NOT NULL
);

DROP INDEX contacts_trash_account_status_expiry;
DROP INDEX contacts_trash_emails_account_key;
ALTER TABLE contacts_trash_emails RENAME TO contacts_trash_emails_v12;
ALTER TABLE contacts_trash RENAME TO contacts_trash_v12;

CREATE TABLE contacts_trash (
  id                       INTEGER PRIMARY KEY,
  account_id               INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  uid                      TEXT NOT NULL,
  prior_remote_id          TEXT NOT NULL,
  original_addressbook_ids_json TEXT NOT NULL,
  snapshot_json            TEXT,
  media_json               TEXT NOT NULL,
  projection_fingerprint   TEXT NOT NULL,
  display_name             TEXT NOT NULL,
  primary_email            TEXT,
  trashed_at               INTEGER NOT NULL,
  expires_at               INTEGER NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('trashed', 'restored', 'purged')),
  lifecycle_updated_at     INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  UNIQUE(account_id, uid)
);

INSERT INTO contacts_trash(
  id, account_id, uid, prior_remote_id, original_addressbook_ids_json,
  snapshot_json, media_json, projection_fingerprint, display_name,
  primary_email, trashed_at, expires_at, status, lifecycle_updated_at,
  updated_at
)
SELECT
  id, account_id, uid, prior_remote_id, original_addressbook_ids_json,
  snapshot_json, '[]', '', display_name,
  primary_email, trashed_at, expires_at, status, lifecycle_updated_at,
  updated_at
FROM contacts_trash_v12;

CREATE INDEX contacts_trash_account_status_expiry
  ON contacts_trash(account_id, status, expires_at, id);

CREATE TABLE contacts_trash_emails (
  trash_id   INTEGER NOT NULL REFERENCES contacts_trash(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL,
  position   INTEGER NOT NULL,
  email_key  TEXT NOT NULL,
  PRIMARY KEY(trash_id, email_key)
);

INSERT INTO contacts_trash_emails(trash_id, account_id, position, email_key)
SELECT trash_id, account_id, position, email_key
FROM contacts_trash_emails_v12;

DROP TABLE contacts_trash_emails_v12;
DROP TABLE contacts_trash_v12;

CREATE INDEX contacts_trash_emails_account_key
  ON contacts_trash_emails(account_id, email_key, trash_id);
