-- Stable keyed contact details (v9).

ALTER TABLE contact_emails ADD COLUMN map_key TEXT;
ALTER TABLE contact_emails ADD COLUMN contexts_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE contact_emails ADD COLUMN pref INTEGER
  CHECK (pref IS NULL OR (pref >= 1 AND pref <= 100));

ALTER TABLE identities ADD COLUMN bcc_json TEXT;
ALTER TABLE identities ADD COLUMN text_signature TEXT;
ALTER TABLE identities ADD COLUMN html_signature TEXT;
ALTER TABLE identities ADD COLUMN may_delete INTEGER
  CHECK (may_delete IS NULL OR may_delete IN (0, 1));

-- Preserve fields already present in complete pre-v9 Identity snapshots.
UPDATE identities
   SET bcc_json = CASE
         WHEN json_valid(raw_json) THEN json_extract(raw_json, '$.bcc')
         ELSE NULL
       END,
       text_signature = CASE
         WHEN json_valid(raw_json) THEN json_extract(raw_json, '$.textSignature')
         ELSE NULL
       END,
       html_signature = CASE
         WHEN json_valid(raw_json) THEN json_extract(raw_json, '$.htmlSignature')
         ELSE NULL
       END,
       may_delete = CASE
         WHEN json_valid(raw_json) AND json_type(raw_json, '$.mayDelete') = 'true' THEN 1
         WHEN json_valid(raw_json) AND json_type(raw_json, '$.mayDelete') = 'false' THEN 0
         ELSE NULL
         END,
       name = COALESCE(name, '');

CREATE UNIQUE INDEX contact_emails_map_key
  ON contact_emails(contact_id, map_key)
  WHERE map_key IS NOT NULL;

CREATE TABLE contact_phones (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  map_key TEXT,
  value TEXT NOT NULL,
  label TEXT,
  contexts_json TEXT NOT NULL DEFAULT '[]',
  features_json TEXT NOT NULL DEFAULT '[]',
  pref INTEGER CHECK (pref IS NULL OR (pref >= 1 AND pref <= 100)),
  PRIMARY KEY(contact_id, position)
);

CREATE UNIQUE INDEX contact_phones_map_key
  ON contact_phones(contact_id, map_key)
  WHERE map_key IS NOT NULL;

CREATE TABLE contact_links (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  map_key TEXT,
  value TEXT NOT NULL,
  label TEXT,
  contexts_json TEXT NOT NULL DEFAULT '[]',
  pref INTEGER CHECK (pref IS NULL OR (pref >= 1 AND pref <= 100)),
  PRIMARY KEY(contact_id, position)
);

CREATE UNIQUE INDEX contact_links_map_key
  ON contact_links(contact_id, map_key)
  WHERE map_key IS NOT NULL;

CREATE TABLE contact_anniversaries (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  map_key TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('birth', 'death', 'wedding')),
  date_kind TEXT NOT NULL CHECK (date_kind IN ('partial', 'timestamp')),
  date_year INTEGER CHECK (date_year IS NULL OR date_year >= 0),
  date_month INTEGER CHECK (date_month IS NULL OR (date_month >= 1 AND date_month <= 12)),
  date_day INTEGER CHECK (date_day IS NULL OR (date_day >= 1 AND date_day <= 31)),
  date_utc TEXT,
  PRIMARY KEY(contact_id, position),
  CHECK (
    (
      date_kind = 'timestamp'
      AND date_utc IS NOT NULL
      AND date_year IS NULL
      AND date_month IS NULL
      AND date_day IS NULL
    )
    OR
    (
      date_kind = 'partial'
      AND date_utc IS NULL
      AND (
        (date_year IS NOT NULL AND date_month IS NULL AND date_day IS NULL)
        OR
        (date_year IS NULL AND date_month IS NOT NULL AND date_day IS NULL)
        OR
        (date_year IS NOT NULL AND date_month IS NOT NULL AND date_day IS NULL)
        OR
        (date_month IS NOT NULL AND date_day IS NOT NULL)
      )
    )
  )
);

CREATE UNIQUE INDEX contact_anniversaries_map_key
  ON contact_anniversaries(contact_id, map_key)
  WHERE map_key IS NOT NULL;

CREATE TABLE contact_notes (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  map_key TEXT,
  value TEXT NOT NULL,
  PRIMARY KEY(contact_id, position)
);

CREATE UNIQUE INDEX contact_notes_map_key
  ON contact_notes(contact_id, map_key)
  WHERE map_key IS NOT NULL;

CREATE TABLE contact_organizations (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  map_key TEXT,
  name TEXT,
  contexts_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(contact_id, position)
);

CREATE UNIQUE INDEX contact_organizations_map_key
  ON contact_organizations(contact_id, map_key)
  WHERE map_key IS NOT NULL;

CREATE TABLE contact_organization_units (
  contact_id INTEGER NOT NULL,
  organization_position INTEGER NOT NULL,
  position INTEGER NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY(contact_id, organization_position, position),
  FOREIGN KEY(contact_id, organization_position)
    REFERENCES contact_organizations(contact_id, position)
    ON DELETE CASCADE
);

CREATE TABLE contact_titles (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  map_key TEXT,
  value TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('role', 'title')),
  organization_map_key TEXT,
  PRIMARY KEY(contact_id, position)
);

CREATE UNIQUE INDEX contact_titles_map_key
  ON contact_titles(contact_id, map_key)
  WHERE map_key IS NOT NULL;

-- Contacts are a disposable server-backed cache. Cascades clear every
-- normalized detail, membership, search-token row, and ContactCard checkpoint;
-- durable outbox rows, AddressBooks, and independent recipient usage remain.
DELETE FROM contacts;
DELETE FROM sync_states WHERE object_type = 'ContactCard';
