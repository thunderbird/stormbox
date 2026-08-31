-- Original single-document Contacts Trash storage.
CREATE TABLE contacts_trash_documents (
  account_id     INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  doc_json       TEXT NOT NULL,
  remote_node_id TEXT,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE contacts_trash (
  id                       INTEGER PRIMARY KEY,
  account_id               INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  uid                      TEXT NOT NULL,
  prior_remote_id          TEXT NOT NULL,
  original_addressbook_ids_json TEXT NOT NULL,
  snapshot_json            TEXT,
  display_name             TEXT NOT NULL,
  primary_email            TEXT,
  trashed_at               INTEGER NOT NULL,
  expires_at               INTEGER NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('trashed', 'restored', 'purged')),
  lifecycle_updated_at     INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  UNIQUE(account_id, uid)
);

CREATE INDEX contacts_trash_account_status_expiry
  ON contacts_trash(account_id, status, expires_at, id);

CREATE TABLE contacts_trash_emails (
  trash_id   INTEGER NOT NULL REFERENCES contacts_trash(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL,
  position   INTEGER NOT NULL,
  email      TEXT,
  email_key  TEXT NOT NULL,
  PRIMARY KEY(trash_id, email_key)
);

CREATE INDEX contacts_trash_emails_account_key
  ON contacts_trash_emails(account_id, email_key, trash_id);
