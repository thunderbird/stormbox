-- Per-account cache of a versioned settings JSON document mirrored through
-- JMAP FileNode when the account supports it.
CREATE TABLE user_settings (
  account_id     INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  doc_json       TEXT NOT NULL,
  remote_node_id TEXT,
  updated_at     INTEGER NOT NULL
);
