-- Contact-only recipient ranking (v8).
--
-- ContactCards are the only autocomplete candidates. This table is a
-- rebuildable ranking cache derived from the latest bounded Sent window; it
-- carries no recipient identity, suppression state, or durable history.

CREATE TABLE recipient_usage (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email_key TEXT NOT NULL,
  send_count INTEGER NOT NULL,
  last_sent_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, email_key)
);
