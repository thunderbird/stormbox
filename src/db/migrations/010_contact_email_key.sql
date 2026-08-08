-- A comparison key for contact addresses, computed the same way as every
-- other address key in the schema.
--
-- `contact_emails.email_lower` is `lower(email)`, and SQLite's `lower()` folds
-- A-Z and nothing else. The autocomplete builds its lookup key in JavaScript,
-- where `toLowerCase()` folds the whole of Unicode, so the two disagree the
-- moment an address carries an uppercase non-ASCII letter:
--
--   stored:  JOSÉ@example.com  ->  email_lower = 'josÉ@example.com'
--   queried:                       key         = 'josé@example.com'
--
-- Those never match, so such a contact was unreachable by address in every
-- tier — including by the address typed exactly as it was stored — while
-- remaining findable by name, because name tokens are written by the
-- application rather than derived in SQL. CS-3.1 requires both.
--
-- The fix is to stop asking SQLite to normalize. `email_key` is written by
-- `addressKey`, the same function recipient comparison and ranking use: NFC,
-- an IDNA-normalized domain, and a case-folded local part.
ALTER TABLE contact_emails ADD COLUMN email_key TEXT;

-- Existing rows get the best SQL can do, which is what `email_lower` already
-- held. It is not the real key for a non-ASCII address, and it does not need
-- to be for long: `CONTACT_UPSERT_MANY` deletes and rewrites a contact's
-- addresses wholesale from the server card, so the first contact sync after
-- this migration replaces every one of these with a properly computed key.
-- Until then such an address is no less reachable than it was before.
UPDATE contact_emails SET email_key = lower(email);

-- The index the address-prefix range scan and the exact lookup ride on
-- (CS-3.14). `email_lower` keeps its own index: nothing reads it now, but
-- dropping a column from a table this size is a rewrite, and the generated
-- column is harmless where it sits.
CREATE INDEX contact_emails_key_lookup
  ON contact_emails(email_key, contact_id);
