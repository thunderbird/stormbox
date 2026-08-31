-- Normalized JSContact media projection (v14).

CREATE TABLE contact_media (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  map_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  blob_id TEXT,
  uri TEXT,
  media_type TEXT,
  pref INTEGER CHECK (pref IS NULL OR (pref >= 1 AND pref <= 100)),
  PRIMARY KEY(contact_id, position),
  UNIQUE(contact_id, map_key),
  CHECK (blob_id IS NOT NULL OR uri IS NOT NULL)
);

CREATE INDEX contact_media_preferred_photo
  ON contact_media(contact_id, kind, pref, position);

-- A full sync projects media already present on the server. Existing contact
-- row ids stay stable because pending mutations may reference them.
DELETE FROM sync_states WHERE object_type = 'ContactCard';
