-- Contact membership and sweepable sync state (v7).
--
-- Two defects share one cause: a contact row was keyed to a single address
-- book. RFC 9610 lets a card belong to several (`addressBookIds` is a map),
-- and the sync collapsed that to whichever book it happened to know about
-- first, discarding the rest. Membership therefore becomes a relation, in
-- `addressbook_contacts`, and a card is one row per account whatever it is
-- filed under. That also removes a quieter hazard: with the book in the
-- uniqueness key, re-filing a card inserted a second row rather than moving
-- the one that existed.
--
-- `sync_generation` is what makes a full sync authoritative. Every row a
-- sync sees is stamped with that run's generation; once every page has
-- succeeded, rows still carrying an older stamp are the ones the server no
-- longer has, and only then are they swept. Stamping as we go and deciding
-- at the end is what keeps an interrupted sync from deleting contacts it
-- simply never got to (CS-4.2).
--
-- The rebuild is roundabout for a reason. Foreign keys are on and a
-- migration runs inside a transaction, where `PRAGMA foreign_keys` cannot
-- be turned off. `DROP TABLE contacts` therefore performs an implicit
-- delete, which would cascade into `contact_emails` and take every address
-- with it. The emails are copied to an unconstrained table first and put
-- back afterwards, so the cascade has nothing to destroy.

-- Which duplicate survives, and what the duplicates were filed under. Both
-- have to be read before the rebuild: the old rows are the only record of
-- it.
--
-- The survivor is the freshest live row, not the lowest id. Duplicates
-- exist because re-filing a card inserted a second row instead of moving
-- the first, so the lowest id is precisely the copy left behind — taking it
-- would resurrect a stale name and address over the current one, and a
-- deleted row over a live one. Live before deleted, then newest before
-- oldest, with the id only breaking a genuine tie.
CREATE TABLE _contact_survivors AS
  SELECT account_id, remote_id, keep_id FROM (
    SELECT
      account_id,
      remote_id,
      id AS keep_id,
      ROW_NUMBER() OVER (
        PARTITION BY account_id, remote_id
        ORDER BY is_deleted ASC, updated_at DESC, id DESC
      ) AS rank
      FROM contacts
  ) WHERE rank = 1;

CREATE TABLE _contact_books AS
  SELECT s.keep_id AS contact_id, c.addressbook_id AS addressbook_id
    FROM contacts c
    JOIN _contact_survivors s
      ON s.account_id = c.account_id AND s.remote_id = c.remote_id;

-- Every old row against the row that will represent it, so the addresses
-- of a row that is about to disappear can still be found.
CREATE TABLE _contact_dupes AS
  SELECT s.keep_id AS keep_id, c.id AS old_id
    FROM contacts c
    JOIN _contact_survivors s
      ON s.account_id = c.account_id AND s.remote_id = c.remote_id;

CREATE TABLE _contact_emails_keep AS
  SELECT contact_id, position, email, label, is_preferred FROM contact_emails;

CREATE TABLE contacts_v7 (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
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
  sync_generation INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(account_id, remote_id)
);

INSERT INTO contacts_v7 (
  id, account_id, remote_id, uid, etag, full_name, display_name,
  given_name, family_name, organization, vcard_text, vcard_version,
  raw_json, sync_generation, is_deleted, updated_at
)
SELECT
  c.id, c.account_id, c.remote_id, c.uid, c.etag, c.full_name, c.display_name,
  c.given_name, c.family_name, c.organization, c.vcard_text, c.vcard_version,
  c.raw_json, 0, c.is_deleted, c.updated_at
FROM contacts c
JOIN _contact_survivors s ON s.keep_id = c.id;

DROP TABLE contact_emails;
DROP TABLE contacts;
ALTER TABLE contacts_v7 RENAME TO contacts;

CREATE INDEX contacts_account_display_name
  ON contacts(account_id, display_name COLLATE NOCASE);

CREATE INDEX contacts_account_uid
  ON contacts(account_id, uid) WHERE uid IS NOT NULL;

-- Sweeping reads by account and generation, and the whole point of the
-- sweep is that it must not scan a directory to find three stale rows.
CREATE INDEX contacts_account_generation
  ON contacts(account_id, sync_generation);

CREATE TABLE contact_emails (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  email TEXT NOT NULL,
  email_lower TEXT GENERATED ALWAYS AS (lower(email)) STORED,
  label TEXT,
  is_preferred INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(contact_id, position)
);

-- Addresses follow the survivor, and where the survivor carries none of its
-- own they are taken from a duplicate that does. Folding two rows together
-- must not leave a contact with no way to reach it, and these rows are
-- copies of one card rather than two different address sets.
CREATE TABLE _contact_email_source AS
  SELECT
    keep_id,
    COALESCE(
      MIN(CASE WHEN old_id = keep_id THEN old_id END),
      MIN(old_id)
    ) AS source_id
    FROM _contact_dupes d
   WHERE EXISTS (SELECT 1 FROM _contact_emails_keep e WHERE e.contact_id = d.old_id)
   GROUP BY keep_id;

INSERT INTO contact_emails(contact_id, position, email, label, is_preferred)
  SELECT s.keep_id, e.position, e.email, e.label, e.is_preferred
    FROM _contact_email_source s
    JOIN _contact_emails_keep e ON e.contact_id = s.source_id
   WHERE s.keep_id IN (SELECT id FROM contacts);

CREATE INDEX contact_emails_lookup
  ON contact_emails(email_lower, contact_id);

CREATE TABLE addressbook_contacts (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  addressbook_id INTEGER NOT NULL REFERENCES addressbooks(id) ON DELETE CASCADE,
  PRIMARY KEY(contact_id, addressbook_id)
);

INSERT OR IGNORE INTO addressbook_contacts(contact_id, addressbook_id)
  SELECT contact_id, addressbook_id
    FROM _contact_books
   WHERE contact_id IN (SELECT id FROM contacts);

-- Listing one book's contacts reads the other way round from the primary
-- key, which orders by contact.
CREATE INDEX addressbook_contacts_book
  ON addressbook_contacts(addressbook_id, contact_id);

DROP TABLE _contact_emails_keep;
DROP TABLE _contact_email_source;
DROP TABLE _contact_dupes;
DROP TABLE _contact_books;
DROP TABLE _contact_survivors;
