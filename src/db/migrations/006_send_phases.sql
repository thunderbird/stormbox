-- Durable send phases (v6). A send is not one atomic protocol act: the
-- Email is created, then submitted, then filed into Sent, then mirrored
-- into the local cache. Only creation and submission touch irreversible
-- server state, and only submission can deliver mail.
--
-- Before this migration the whole sequence was one chained JMAP call with
-- no durable record of how far it had progressed, so a lost response left
-- the client unable to tell "nothing happened" from "already delivered".
-- The only safe response was to stop and hand the row to the user.
--
-- `phase` records the furthest point known to have succeeded, written
-- before the next protocol call is issued. A resume reads it and skips
-- anything already confirmed, so a retry can never repeat submission.
-- The accompanying checkpoint (operation id, client-generated Message-ID,
-- remote Email id, remote submission id) lives in the existing
-- `server_response_json` column, which was already the row's scratch
-- space for server results.
--
-- Values, in order of progress:
--   NULL           legacy rows and every non-send mutation type
--   'queued'       checkpoint persisted, nothing sent yet
--   'created'      an Email exists on the server with our Message-ID
--   'submitted'    a submission was accepted; the mail may be in transit
--   'cache_pending' submitted, but the local cache does not match yet
--   'unknown'      a response was lost and reconciliation was inconclusive
--
-- 'unknown' is deliberately terminal for automation. It exists so an
-- ambiguous outcome is a recorded state a human can act on rather than an
-- invitation for the runner to guess.

ALTER TABLE pending_mutations ADD COLUMN phase TEXT;

-- Startup recovery scans for rows parked in a send phase, which is a
-- small subset of the table, so a partial index keeps it cheap without
-- competing with pending_mutations_ready for the drain path.
CREATE INDEX pending_mutations_phase
  ON pending_mutations(account_id, phase)
  WHERE phase IS NOT NULL;
