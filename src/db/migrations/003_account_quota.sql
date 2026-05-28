-- Per-account mail storage quota snapshot from JMAP Quota/get.

ALTER TABLE accounts ADD COLUMN quota_used_bytes INTEGER;
ALTER TABLE accounts ADD COLUMN quota_hard_limit_bytes INTEGER;
ALTER TABLE accounts ADD COLUMN quota_updated_at INTEGER;
