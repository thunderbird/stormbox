-- Send Later scheduling state on normal message rows (v16).
--
-- The scheduled Email itself is an ordinary cached message in the real
-- Scheduled mailbox; messages.sent_at already carries the canonical
-- target instant. These columns only track the EmailSubmission that
-- holds it: its server id and its last known undo status.

ALTER TABLE messages ADD COLUMN scheduled_submission_remote_id TEXT;

ALTER TABLE messages ADD COLUMN scheduled_undo_status TEXT
  CHECK (
    scheduled_undo_status IS NULL
    OR scheduled_undo_status IN ('pending', 'final', 'canceled', 'unknown')
  );

CREATE INDEX messages_scheduled_active
  ON messages(account_id, sent_at)
  WHERE scheduled_undo_status IS NOT NULL;
