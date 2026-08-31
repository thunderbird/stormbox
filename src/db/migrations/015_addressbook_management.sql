-- AddressBook ordering and fail-closed delete permission (v15).

ALTER TABLE addressbooks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0
  CHECK (sort_order >= 0);

ALTER TABLE addressbooks ADD COLUMN may_delete INTEGER
  CHECK (may_delete IS NULL OR may_delete IN (0, 1));
