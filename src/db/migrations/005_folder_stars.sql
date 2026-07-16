-- Client-local folder starring: starred folders float to the top of
-- the sidebar folder list as a priority group.
--
-- Deliberately NOT synced to JMAP. Mailbox sortOrder (RFC 8621 §2)
-- only orders siblings under one parent and forbids negative values,
-- so a cross-tree "pinned to top" flag cannot be expressed with it
-- without rewriting sortOrder across whole sibling groups on every
-- toggle. This column is a per-client UI preference, like collapse
-- state.

ALTER TABLE folders ADD COLUMN is_starred INTEGER NOT NULL DEFAULT 0;
