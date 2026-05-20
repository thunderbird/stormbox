/**
 * Worker-side outbox runner. One instance per account, owned by the
 * JmapBackend. Replaces the "callers must remember to call drainOutbox"
 * contract with a self-driving queue:
 *
 *   - notify() schedules a drain pass; the runner re-queries
 *     pending_mutations every iteration so anything inserted during
 *     the previous wave is picked up before exiting.
 *   - Single-flight: only one drain pass runs per account at a time.
 *     A notify() call during a drain is recorded via _kickPending so
 *     the runner immediately re-kicks once the in-flight pass finishes
 *     (covers the race where a row is enqueued just as the drain is
 *     scheduling its idle wake timer).
 *   - Per-target serialization via a small in-memory lock map keyed
 *     by target_message_id. Two mutations for the same message id
 *     (mark-read then destroy) chain onto the same Promise tail so
 *     they cannot interleave; mutations against different targets
 *     run concurrently.
 *   - Bounded exponential backoff: on a retryable failure the row's
 *     attempts/not_before columns get updated and a setTimeout wakes
 *     the runner exactly when the next row is eligible. A row that
 *     reaches the attempt cap (default 8) or returns a terminal
 *     error type (forbidden/notFound/unknownMessage/unsupportedMutation)
 *     becomes 'conflicted' and is left for manual recovery.
 *   - runMutation(mutationId) clears that row's backoff, kicks the
 *     drain immediately, and resolves with the per-row outcome once
 *     the runner reaches a terminal state for that id. Callers that
 *     do not need the result (markRead) can just enqueue and forget;
 *     the worker-side onMutationInserted hook will notify() us.
 *
 * The runner does not own the JMAP transport or any account-specific
 * state. It receives a processRow(row) function from the backend which
 * is responsible for translating the queued mutation into the right
 * Email/set / EmailSubmission/set call and returning { ok, error? }.
 * That keeps this file pure plumbing and reusable in tests with a
 * stub processRow.
 */

import { DB_RPC } from '../../../db/protocol.js';
import { wlog } from '../../../db/worker-log.js';

// SetError types that cannot succeed by retrying: no amount of waiting
// will turn 'forbidden' into 'success'. Anything else (serverFail,
// stateMismatch, transport, noResponse) gets the backoff treatment.
const TERMINAL_ERROR_TYPES = new Set([
  'forbidden',
  'notFound',
  'unknownMessage',
  'unsupportedMutation',
]);

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_NOTIFY_DELAY_MS = 10;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_CAP_MS = 60_000;
const DRAIN_BATCH_SIZE = 50;

export class OutboxRunner {
  _accountId: number;
  _handlers: Record<string, (p: any) => Promise<any>>;
  _processRow: (row: any) => Promise<{ ok: boolean; error?: any }>;
  _maxAttempts: number;
  _notifyDelayMs: number;
  _backoffBaseMs: number;
  _backoffCapMs: number;
  _setTimeout: any;
  _clearTimeout: any;
  _now: () => number;
  _stopped: boolean;
  _drainInflight: Promise<void> | null;
  _kickPending: boolean;
  _notifyTimer: any;
  _wakeTimer: any;
  _targetLocks: Map<string, Promise<void>>;
  _awaiters: Map<number, Array<{ resolve: (v: any) => void }>>;
  _tallyListeners: Set<(id: number, outcome: any) => void>;

  constructor({
    accountId,
    handlers,
    processRow,
    options = {},
  }: {
    accountId: number;
    handlers: Record<string, (p: any) => Promise<any>>;
    processRow: (row: any) => Promise<{ ok: boolean; error?: any }>;
    options?: any;
  }) {
    if (accountId == null) throw new Error('OutboxRunner requires accountId');
    if (!handlers) throw new Error('OutboxRunner requires handlers');
    if (typeof processRow !== 'function') {
      throw new Error('OutboxRunner requires a processRow function');
    }
    this._accountId = accountId;
    this._handlers = handlers;
    this._processRow = processRow;

    this._maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this._notifyDelayMs = options.notifyDelayMs ?? DEFAULT_NOTIFY_DELAY_MS;
    this._backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this._backoffCapMs = options.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
    this._setTimeout = options.setTimeoutFn
      ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
    this._clearTimeout = options.clearTimeoutFn
      ?? ((id: any) => clearTimeout(id));
    this._now = options.now ?? (() => Date.now());

    this._targetLocks = new Map();
    this._awaiters = new Map();
    this._tallyListeners = new Set();
    this._notifyTimer = null;
    this._wakeTimer = null;
    this._drainInflight = null;
    this._kickPending = false;
    this._stopped = false;
  }

  /**
   * Schedule a drain pass. Debounced by notifyDelayMs unless
   * immediate=true. Safe to call concurrently with an in-flight drain:
   * the call is recorded and a fresh pass will start as soon as the
   * current one finishes, so a row inserted right as the runner was
   * scheduling its idle wake timer is not lost.
   */
  notify({ immediate = false } = {}) {
    if (this._stopped) return;
    this._kickPending = true;
    if (this._drainInflight) {
      // The trailing-kick in _kickDrain.finally will pick this up.
      return;
    }
    if (immediate) {
      this._cancelNotifyTimer();
      this._kickDrain();
      return;
    }
    if (this._notifyTimer != null) return;
    this._notifyTimer = this._setTimeout(() => {
      this._notifyTimer = null;
      this._kickDrain();
    }, this._notifyDelayMs);
  }

  /**
   * Run a single mutation now and resolve when it reaches a terminal
   * state (success, conflicted, or attempt cap). Clears the row's
   * backoff so it is immediately eligible; subsequent failures still
   * apply backoff for further attempts that this caller will continue
   * to await.
   *
   * Returns { attempted, succeeded, failed } so the existing
   * Repository.runMutation contract (used by compose-store and
   * destroyMessage) keeps working.
   */
  async runMutation(mutationId) {
    if (this._stopped) {
      return { attempted: 0, succeeded: 0, failed: 0 };
    }
    const row = await this._loadRow(mutationId);
    if (!row) {
      // Already deleted = already succeeded by a prior pass.
      return { attempted: 0, succeeded: 1, failed: 0 };
    }
    if (row.local_status === 'conflicted') {
      return { attempted: 0, succeeded: 0, failed: 1 };
    }
    if (row.local_status !== 'pending'
        && row.local_status !== 'retry'
        && row.local_status !== 'in_flight') {
      return { attempted: 0, succeeded: 0, failed: 0 };
    }

    // Reset backoff so this row is immediately eligible. Don't touch
    // attempts — the per-row retry budget should keep aging toward the
    // conflicted cap even when the user re-triggers the mutation
    // manually.
    await this._handlers[DB_RPC.QUERY]({
      sql: `UPDATE pending_mutations
               SET not_before = NULL, updated_at = ?
             WHERE account_id = ? AND id = ?
               AND local_status IN ('pending','retry')`,
      params: [this._now(), this._accountId, mutationId],
    });

    const outcomePromise = new Promise<{ ok: boolean }>((resolve) => {
      const list = this._awaiters.get(mutationId) ?? [];
      list.push({ resolve });
      this._awaiters.set(mutationId, list);
    });
    this.notify({ immediate: true });
    const outcome = await outcomePromise;
    return {
      attempted: 1,
      succeeded: outcome.ok ? 1 : 0,
      failed: outcome.ok ? 0 : 1,
    };
  }

  /**
   * Drain every ready row for the account and return aggregate
   * { attempted, succeeded, failed } counts. Kept for the legacy
   * drainOutbox RPC contract; new callers should prefer notify() (fire
   * and forget) or runMutation(id) (await a specific row). Counts
   * include rows settled by any concurrent drain triggered during this
   * call, which is what the prior drainOutbox implementation did too.
   */
  async drain() {
    if (this._stopped) {
      return { attempted: 0, succeeded: 0, failed: 0 };
    }
    const tally = { attempted: 0, succeeded: 0, failed: 0 };
    const onSettle = (_id, outcome) => {
      tally.attempted += 1;
      if (outcome.ok) tally.succeeded += 1;
      else tally.failed += 1;
    };
    this._tallyListeners.add(onSettle);
    try {
      // Wait for any in-flight pass first so its counts have already
      // settled into the tally listener. Then force a fresh pass so we
      // pick up anything inserted after the inflight pass started its
      // _loadReadyRows query.
      while (this._drainInflight) {
        await this._drainInflight.catch(() => {});
      }
      this._kickPending = true;
      this._kickDrain();
      while (this._drainInflight) {
        await this._drainInflight.catch(() => {});
      }
    } finally {
      this._tallyListeners.delete(onSettle);
    }
    return tally;
  }

  /**
   * Cancel timers, reject outstanding runMutation awaiters, and wait
   * for any in-flight drain to settle so the caller observes a
   * quiesced runner.
   */
  async stop() {
    if (this._stopped) return;
    this._stopped = true;
    this._cancelNotifyTimer();
    if (this._wakeTimer != null) {
      this._clearTimeout(this._wakeTimer);
      this._wakeTimer = null;
    }
    if (this._drainInflight) {
      await this._drainInflight.catch(() => {});
    }
    for (const list of this._awaiters.values()) {
      for (const { resolve } of list) {
        // Resolve with a synthetic "stopped" outcome so awaited
        // callers (compose-store, destroyMessage) don't hang
        // forever when the backend tears down. They treat ok=false
        // as a failure that surfaces an error to the user.
        try {
          resolve({ ok: false, error: { type: 'stopped' } });
        } catch {
          // ignore
        }
      }
    }
    this._awaiters.clear();
    this._targetLocks.clear();
  }

  // ----- internals -----------------------------------------------------

  _cancelNotifyTimer() {
    if (this._notifyTimer != null) {
      this._clearTimeout(this._notifyTimer);
      this._notifyTimer = null;
    }
  }

  _kickDrain() {
    if (this._stopped) return null;
    if (this._drainInflight) return this._drainInflight;
    this._kickPending = false;
    this._drainInflight = this._drainLoop()
      .catch((err) => {
        wlog.error('outbox-runner', `drain failed (account ${this._accountId})`, err);
      })
      .finally(() => {
        this._drainInflight = null;
        if (this._kickPending && !this._stopped) {
          // notify() arrived during the drain; re-kick. The new pass
          // will clear _kickPending on entry.
          this._kickDrain();
        }
      });
    return this._drainInflight;
  }

  async _drainLoop() {
    while (!this._stopped) {
      const rows = await this._loadReadyRows();
      if (rows.length === 0) {
        await this._scheduleNextWake();
        return;
      }
      // Dispatch all ready rows in parallel; per-target locks keep
      // mutations for the same message id from interleaving. Wait for
      // the whole wave before re-querying so this loop terminates
      // deterministically when the queue is empty.
      const tasks = rows.map((row) => this._dispatch(row));
      await Promise.allSettled(tasks);
    }
  }

  /**
   * Schedule the dispatch of one row behind any previously-queued
   * dispatches for the same target_message_id. Rows with no target
   * (currently only the SEND mutation type) get a unique key so they
   * run concurrently with each other.
   */
  _dispatch(row) {
    const key = row.target_message_id == null
      ? `row:${row.id}`
      : `target:${Number(row.target_message_id)}`;
    const prev = this._targetLocks.get(key) ?? Promise.resolve();
    // suppressed-rejection chain: if row N for target T fails, row
    // N+1 for the same target should still get a chance to run.
    const tail = prev.catch(() => {}).then(() => this._runWithRetry(row));
    const guarded = tail.catch(() => {});
    this._targetLocks.set(key, guarded);
    // Best-effort cleanup so the lock map doesn't accumulate dead
    // entries over a long session; ignored if a follow-on dispatch
    // already chained onto this key.
    guarded.then(() => {
      if (this._targetLocks.get(key) === guarded) {
        this._targetLocks.delete(key);
      }
    });
    return tail;
  }

  /**
   * Execute one row: mark in_flight, call processRow, then apply
   * success / retry / conflicted bookkeeping. Notifies any
   * runMutation awaiters once a terminal state is reached.
   */
  async _runWithRetry(row) {
    if (this._stopped) return;
    const attemptNumber = Number(row.attempts ?? 0) + 1;
    await this._markInFlight(row.id, attemptNumber);
    let result;
    try {
      result = await this._processRow(row);
    } catch (err) {
      result = {
        ok: false,
        error: { type: 'transport', message: err?.message ?? String(err) },
      };
    }
    if (result?.ok) {
      await this._deleteRow(row.id);
      this._resolveAwaiters(row.id, { ok: true });
      this._fireTally(row.id, { ok: true });
      return;
    }
    const errorType = result?.error?.type ?? 'unknown';
    const terminal = TERMINAL_ERROR_TYPES.has(errorType)
      || attemptNumber >= this._maxAttempts;
    if (terminal) {
      await this._markConflicted(row.id, result?.error);
      this._resolveAwaiters(row.id, { ok: false, error: result?.error });
      this._fireTally(row.id, { ok: false, error: result?.error });
      return;
    }
    const delay = Math.min(
      this._backoffBaseMs * 2 ** (attemptNumber - 1),
      this._backoffCapMs,
    );
    await this._markRetry(row.id, this._now() + delay, result?.error);
    // Awaiters intentionally not resolved on transient retry — the
    // next drain pass picks this row up after the backoff window
    // and will eventually resolve the awaiter when it terminates.
  }

  async _scheduleNextWake() {
    if (this._wakeTimer != null) {
      this._clearTimeout(this._wakeTimer);
      this._wakeTimer = null;
    }
    const rows = await this._handlers[DB_RPC.QUERY]({
      sql: `SELECT MIN(not_before) AS next_ms
              FROM pending_mutations
             WHERE account_id = ?
               AND local_status IN ('pending','retry')
               AND not_before IS NOT NULL`,
      params: [this._accountId],
    });
    const nextMs = Number(rows?.[0]?.next_ms ?? 0);
    if (!nextMs) return;
    const delay = Math.max(0, nextMs - this._now());
    this._wakeTimer = this._setTimeout(() => {
      this._wakeTimer = null;
      this._kickDrain();
    }, delay);
  }

  async _loadReadyRows() {
    return this._handlers[DB_RPC.QUERY]({
      sql: `SELECT * FROM pending_mutations
             WHERE account_id = ?
               AND local_status IN ('pending','retry')
               AND (not_before IS NULL OR not_before <= ?)
             ORDER BY created_at, id
             LIMIT ?`,
      params: [this._accountId, this._now(), DRAIN_BATCH_SIZE],
    });
  }

  async _loadRow(mutationId) {
    const rows = await this._handlers[DB_RPC.QUERY]({
      sql: `SELECT * FROM pending_mutations
             WHERE account_id = ? AND id = ?
             LIMIT 1`,
      params: [this._accountId, mutationId],
    });
    return rows[0] ?? null;
  }

  async _markInFlight(mutationId, attempts) {
    const ts = this._now();
    await this._handlers[DB_RPC.QUERY]({
      sql: `UPDATE pending_mutations
               SET local_status = 'in_flight',
                   attempts = ?,
                   last_attempt_at = ?,
                   updated_at = ?
             WHERE id = ?`,
      params: [attempts, ts, ts, mutationId],
    });
  }

  async _markRetry(mutationId, notBefore, error) {
    await this._handlers[DB_RPC.QUERY]({
      sql: `UPDATE pending_mutations
               SET local_status = 'retry',
                   not_before = ?,
                   error_json = ?,
                   updated_at = ?
             WHERE id = ?`,
      params: [
        Math.floor(notBefore),
        JSON.stringify(error ?? {}),
        this._now(),
        mutationId,
      ],
    });
  }

  async _markConflicted(mutationId, error) {
    await this._handlers[DB_RPC.QUERY]({
      sql: `UPDATE pending_mutations
               SET local_status = 'conflicted',
                   error_json = ?,
                   updated_at = ?
             WHERE id = ?`,
      params: [JSON.stringify(error ?? {}), this._now(), mutationId],
    });
  }

  async _deleteRow(mutationId) {
    await this._handlers[DB_RPC.QUERY]({
      sql: `DELETE FROM pending_mutations WHERE id = ?`,
      params: [mutationId],
    });
  }

  _resolveAwaiters(mutationId, outcome) {
    const list = this._awaiters.get(mutationId);
    if (!list) return;
    this._awaiters.delete(mutationId);
    for (const { resolve } of list) {
      try {
        resolve(outcome);
      } catch {
        // listeners are simple resolve() calls; nothing to recover
      }
    }
  }

  _fireTally(mutationId, outcome) {
    for (const listener of this._tallyListeners) {
      try {
        listener(mutationId, outcome);
      } catch {
        // tally listeners must not break the drain loop
      }
    }
  }
}
