-- Learned recipients, and names made searchable (v9).
--
-- Autocomplete has drawn its history from `message_addresses`, which holds
-- every address on every synced message. That makes a suggestion out of
-- anyone who has ever mailed you, including senders you would never write
-- to (CS-3.3). Learned history has to come from mail the user actually sent,
-- so it gets a table of its own rather than a filter over that one.
--
-- Names get a token table because the old query could only match an address
-- prefix: a contact called "Smith, Jane" at `jsmith@example.com` was
-- unreachable by typing "jane" (CS-3.1, CS-3.2). One row per word per
-- contact turns that into an indexed range scan, and matching every typed
-- word independently is what lets "jane smi" find her.

CREATE TABLE recipient_history (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- `email` is verbatim: the local part is case-sensitive to the receiving
  -- server (RFC 5321 §2.4), so this is what gets suggested and sent.
  -- `email_key` is the folded comparison key (CS-3.5) and exists only to
  -- decide whether two rows are the same recipient.
  email TEXT NOT NULL,
  email_key TEXT NOT NULL,
  name TEXT,
  name_key TEXT,
  send_count INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER,
  -- Set when the user removes a suggestion (CS-3.13). Suppressing rather
  -- than deleting is what makes the removal stick: a deleted row would be
  -- learned again by the next send to that address, so the control would
  -- appear to do nothing.
  is_suppressed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- One row per recipient per account. The key, not the verbatim address,
  -- is what has to be unique, or `Jane@x.com` and `jane@x.com` would both
  -- be learned and both be suggested.
  UNIQUE(account_id, email_key)
);

-- The UNIQUE index above already serves address-prefix scans. This one is
-- for matching what the user typed against the name we learned.
CREATE INDEX recipient_history_name ON recipient_history(account_id, name_key);

CREATE TABLE contact_search_tokens (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- Denormalized from `contacts` so a prefix scan is one index range rather
  -- than a join per candidate token.
  account_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  PRIMARY KEY(contact_id, token)
);

-- `contact_id` is in the index so a token scan answers "which contacts"
-- without touching the table.
CREATE INDEX contact_search_tokens_prefix
  ON contact_search_tokens(account_id, token, contact_id);

-- Backfill, so existing contacts are searchable by name before anything
-- re-syncs them. Each recursion step takes one word off the front.
--
-- SQLite's `lower()` folds ASCII only, so a name in another script keeps its
-- case here and is matched case-sensitively until the contact is next
-- persisted, at which point the application tokenizer replaces these rows.
-- The alternative is leaving every existing contact unsearchable by name
-- until a full re-sync, which is worse.
INSERT OR IGNORE INTO contact_search_tokens(contact_id, account_id, token)
WITH RECURSIVE words(contact_id, account_id, token, rest) AS (
  SELECT
    id,
    account_id,
    '',
    replace(replace(replace(replace(replace(replace(replace(replace(
      lower(
        coalesce(full_name, '') || ' ' || coalesce(display_name, '') || ' '
        || coalesce(given_name, '') || ' ' || coalesce(family_name, '') || ' '
        || coalesce(organization, '')
      ),
    ',', ' '), '.', ' '), ';', ' '), ':', ' '), '(', ' '), ')', ' '), '"', ' '), '/', ' ')
    || ' '
    FROM contacts
   WHERE is_deleted = 0
  UNION ALL
  SELECT
    contact_id,
    account_id,
    substr(rest, 1, instr(rest, ' ') - 1),
    substr(rest, instr(rest, ' ') + 1)
    FROM words
   WHERE instr(rest, ' ') > 0
)
SELECT contact_id, account_id, token FROM words WHERE token <> '';
