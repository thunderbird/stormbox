-- Remove unused Identity Bcc storage (v12).

CREATE TABLE identities_v12 (
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

INSERT INTO identities_v12(
  id, account_id, remote_id, name, email, reply_to_json, raw_json, updated_at
)
SELECT
  id, account_id, remote_id, name, email, reply_to_json, raw_json, updated_at
FROM identities;

DROP TABLE identities;
ALTER TABLE identities_v12 RENAME TO identities;
