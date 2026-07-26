-- Identity Bcc as a column of its own (v8).
--
-- RFC 8621 §6.1 gives an identity a `bcc` default alongside `replyTo`, and
-- the sync has always requested both. Only `replyTo` was given a column;
-- `bcc` survived inside `raw_json`, which is the row's verbatim copy of the
-- server object rather than anything the application reads. A default that
-- can only be reached by parsing a blob is a default nothing will apply.
--
-- Nothing populates this yet — silently adding a Bcc recipient the user did
-- not type is a product decision (CS-2.8), and this migration only makes the
-- value addressable so that decision is not blocked on a schema change.

ALTER TABLE identities ADD COLUMN bcc_json TEXT;
