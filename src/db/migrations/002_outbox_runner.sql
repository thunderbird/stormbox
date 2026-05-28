-- Outbox runner schema (v2). Adds per-row retry bookkeeping so the
-- in-worker OutboxRunner can implement bounded exponential backoff,
-- crash recovery for in_flight rows, and ordered draining without
-- depending on a main-thread caller to pump the queue.
--
-- Columns:
--   attempts         number of drain attempts so far (incremented on every
--                    transient failure; reset to 0 only by an explicit
--                    INSERT of a new row).
--   not_before       earliest epoch-ms timestamp at which the row should
--                    next be picked up. NULL means "ready immediately".
--                    Drain queries filter `not_before IS NULL OR not_before
--                    <= now()` so rows in backoff sit out the window
--                    without being repeatedly skipped one at a time.
--   last_attempt_at  epoch-ms of the most recent attempt. Useful for
--                    debugging and for surfacing "stuck" rows in the UI
--                    later; not consulted by the drain loop.
--
-- Index pending_mutations_ready replaces the v1 pending index. It puts
-- (account_id, local_status, not_before, created_at) in that order so a
-- ready-rows scan for a single account can use the index without sorting:
-- equality on (account_id, local_status IN ('pending','retry')), then
-- range on not_before, then ordered by created_at to give FIFO inside the
-- backoff window.

ALTER TABLE pending_mutations ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pending_mutations ADD COLUMN not_before INTEGER;
ALTER TABLE pending_mutations ADD COLUMN last_attempt_at INTEGER;

DROP INDEX IF EXISTS pending_mutations_pending;

CREATE INDEX pending_mutations_ready
  ON pending_mutations(account_id, local_status, not_before, created_at);

-- Crash recovery: any row that was in_flight when the worker died is
-- now orphaned (no live runner is tracking the network call). Reset
-- those back to pending so the new runner picks them up. Doing this
-- inside the migration means it happens exactly once per worker boot,
-- before any new RPC traffic can land — i.e. before the OutboxRunner
-- even has a chance to see the stale rows.
--
-- We deliberately keep `attempts` as-is rather than reset it: a row
-- that got partway through several retries before the crash should
-- continue to age out toward the conflicted cap, not start over.
UPDATE pending_mutations
   SET local_status = 'pending',
       not_before = NULL,
       updated_at = strftime('%s','now') * 1000
 WHERE local_status = 'in_flight';
