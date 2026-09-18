-- Case-insensitive keyword lookups for tag views (v17).
--
-- Keywords are matched lowercase (specs/011 MK-1.5) but the cache keeps
-- the server's spelling, which other clients may have written in any
-- case. The tag view reads match on LOWER(keyword); this expression index
-- serves them so they do not scan message_keywords.

CREATE INDEX message_keywords_lower
  ON message_keywords(LOWER(keyword), message_id);
