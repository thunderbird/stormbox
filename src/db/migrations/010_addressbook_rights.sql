-- Protocol-neutral AddressBook write permission (v10).

ALTER TABLE addressbooks ADD COLUMN may_write INTEGER
  CHECK (may_write IS NULL OR may_write IN (0, 1));
