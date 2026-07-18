-- Folder subscriptions (JMAP Mailbox isSubscribed, RFC 8621 §2) and
-- shared-account support (RFC 8620 §1.6.2 / RFC 9670).
--
-- folders.is_subscribed mirrors the per-user Mailbox isSubscribed flag.
-- NULL means the server never reported the property (pre-existing rows
-- before this migration); the sync layer backfills it on the next
-- Mailbox/get.
--
-- accounts.is_personal mirrors the session Account isPersonal flag:
-- 1 for the signed-in user's own account, 0 for accounts shared with
-- them by other principals. Existing rows default to 1 because only the
-- primary (personal) account was ever ingested before this migration.

ALTER TABLE folders ADD COLUMN is_subscribed INTEGER;

ALTER TABLE accounts ADD COLUMN is_personal INTEGER NOT NULL DEFAULT 1;
