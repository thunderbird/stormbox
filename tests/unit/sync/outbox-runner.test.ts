/**
 * Tests for the worker-side OutboxRunner. The runner is the
 * self-driving replacement for the "callers must remember to call
 * drainOutbox" contract: every pending_mutations row enqueued via
 * the handlers gets auto-drained, retried with bounded backoff, and
 * survives a worker crash.
 *
 * These tests use the real in-memory engine + the production
 * handlers so the SQL bookkeeping (status transitions, attempts /
 * not_before / last_attempt_at columns, ready index) is exercised
 * exactly the way production does it. The JMAP dispatch itself is
 * stubbed via a per-test processRow function so we can simulate
 * success / serverFail / forbidden / transport throws without
 * standing up a transport.
 */

import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { OutboxRunner } from '../../../src/sync/backends/jmap/outbox-runner';

let engine;
let handlers;
let accountId;

/**
 * Externally-resolvable promise. Used as a synchronization primitive
 * inside processRow stubs so the test can pin "mutation A is mid-call;
 * mutation B must not have started yet" without timing flakes. Far
 * more reliable than counting microtasks against an async SQLite
 * engine.
 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Poll a predicate until it returns truthy or the deadline elapses.
 * Used in place of "yield 4 microtasks and hope" — the wa-sqlite step
 * loop is async and a single yield is not enough to wait for an
 * engine query to settle.
 */
async function waitFor(predicate, { timeoutMs = 1_000, pollMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error('waitFor timed out');
}

async function insertSetKeywords({ targetMessageId = null } = {}) {
  const r = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
    accountId,
    mutationType: 'setKeywords',
    targetMessageId,
    requestJson: JSON.stringify({ add: ['$seen'], remove: [] }),
    optimisticPatchJson: JSON.stringify({ is_seen: 1 }),
  });
  return r.id;
}

async function insertDestroy({ targetMessageId = null } = {}) {
  const r = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
    accountId,
    mutationType: 'destroy',
    targetMessageId,
    requestJson: JSON.stringify({}),
  });
  return r.id;
}

async function insertTargetlessWrite(mutationType = 'whitelistSender') {
  const result = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
    accountId,
    mutationType,
    targetMessageId: null,
    requestJson: JSON.stringify({ senders: [{ email: `${mutationType}@example.com` }] }),
  });
  return result.id;
}

async function insertComposeMutation(mutationType, draftSessionId, targetMessageId = null) {
  const result = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
    accountId,
    mutationType,
    targetMessageId,
    requestJson: JSON.stringify({ draftSessionId }),
  });
  return result.id;
}

async function loadRow(id) {
  const rows = await engine.all(
    'SELECT * FROM pending_mutations WHERE id = ?',
    [id],
  );
  return rows[0] ?? null;
}

async function seedMessage(remoteId) {
  // Insert directly so we get a stable target_message_id without
  // running the full sync stack. The runner only needs an FK target.
  const ts = Date.now();
  await engine.run(
    `INSERT INTO messages(
       account_id, remote_id, subject, keywords_json,
       metadata_fetched_at, updated_at
     ) VALUES (?, ?, 'subj', '{}', ?, ?)`,
    [accountId, remoteId, ts, ts],
  );
  const row = await engine.get(
    'SELECT id FROM messages WHERE account_id = ? AND remote_id = ?',
    [accountId, remoteId],
  );
  return row.id;
}

beforeEach(async () => {
  engine = await bootTestEngine();
  handlers = makeHandlers(engine);
  const account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
    displayName: 'T',
    primaryEmail: 't@example.com',
    serverOrigin: 'https://mail.example.com',
    remoteAccountId: 'acct-1',
    isPrimary: true,
  })).row;
  accountId = account.id;
});

afterEach(async () => {
  await engine.close();
});

describe('OutboxRunner auto-drain', () => {
  it('drains a single setKeywords row on a notify() with no caller-side pump', async () => {
    // The point of the new architecture: stores call
    // insertPendingMutation and stop. The worker (via the
    // onMutationInserted hook) calls runner.notify() and the runner
    // does the rest. Here we drive that directly.
    const localMsg = await seedMessage('e-1');
    const calls = [];
    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async (row) => {
        calls.push(row.id);
        return { ok: true };
      },
      options: { notifyDelayMs: 0 },
    });

    const mutationId = await insertSetKeywords({ targetMessageId: localMsg });
    runner.notify({ immediate: true });
    await runner.drain();

    expect(calls).toEqual([mutationId]);
    const row = await loadRow(mutationId);
    expect(row).toBeNull();
    await runner.stop();
  });

  it('coalesces a burst of notify() calls into a single drain pass (debounce)', async () => {
    const localMsg = await seedMessage('e-1');
    let drainPasses = 0;
    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async () => {
        drainPasses += 1;
        return { ok: true };
      },
      // 25ms debounce — long enough that three notifies in a row
      // synchronously will only schedule one drain, short enough
      // that the test finishes promptly.
      options: { notifyDelayMs: 25 },
    });

    await insertSetKeywords({ targetMessageId: localMsg });
    runner.notify();
    runner.notify();
    runner.notify();
    // No drain yet — the debounce timer hasn't fired.
    expect(drainPasses).toBe(0);

    await waitFor(() => drainPasses >= 1);
    // Give the runner a chance to (incorrectly) start a second
    // pass; if the debounce works, it shouldn't.
    await new Promise((r) => setTimeout(r, 30));
    expect(drainPasses).toBe(1);
    await runner.stop();
  });
});

describe('OutboxRunner per-target serialization', () => {
  it('serializes different sessions that claim the same draft row', async () => {
    const target = await seedMessage('shared-draft');
    const firstBlocked = deferred();
    const order = [];
    const firstId = await insertComposeMutation('saveDraft', 'tab-one', target);
    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async (row) => {
        order.push(`start:${row.id}`);
        if (row.id === firstId) await firstBlocked.promise;
        order.push(`end:${row.id}`);
        return { ok: true };
      },
      options: { notifyDelayMs: 0 },
    });
    const secondId = await insertComposeMutation('saveDraft', 'tab-two', target);

    const draining = runner.drain();
    await waitFor(() => order.includes(`start:${firstId}`));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).not.toContain(`start:${secondId}`);
    firstBlocked.resolve();
    await draining;

    expect(order).toEqual([
      `start:${firstId}`,
      `end:${firstId}`,
      `start:${secondId}`,
      `end:${secondId}`,
    ]);
    await runner.stop();
  });

  it('serializes save, discard, and send in one compose-session lane', async () => {
    const firstBlocked = deferred();
    const order = [];
    const firstId = await insertComposeMutation('saveDraft', 'compose-1');
    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async (row) => {
        order.push(`start:${row.mutation_type}`);
        if (row.id === firstId) await firstBlocked.promise;
        order.push(`end:${row.mutation_type}`);
        return { ok: true };
      },
      options: { notifyDelayMs: 0 },
    });
    await insertComposeMutation('discardDraft', 'compose-1');
    await insertComposeMutation('send', 'compose-1');

    const draining = runner.drain();
    await waitFor(() => order.includes('start:saveDraft'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['start:saveDraft']);

    firstBlocked.resolve();
    await draining;
    expect(order).toEqual([
      'start:saveDraft',
      'end:saveDraft',
      'start:discardDraft',
      'end:discardDraft',
      'start:send',
      'end:send',
    ]);
    await runner.stop();
  });

  it('serializes account-wide ContactCard writes with null message targets', async () => {
    const firstBlocked = deferred();
    const order = [];
    const firstId = await insertTargetlessWrite('whitelistSender');
    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async (row) => {
        order.push(`start:${row.id}`);
        if (row.id === firstId) await firstBlocked.promise;
        order.push(`end:${row.id}`);
        return { ok: true };
      },
      options: { notifyDelayMs: 0 },
    });
    const secondId = await insertTargetlessWrite('createContact');
    const drainPromise = runner.drain();

    await waitFor(() => order.includes(`start:${firstId}`));
    expect(order).not.toContain(`start:${secondId}`);
    firstBlocked.resolve();
    await drainPromise;

    expect(order).toEqual([
      `start:${firstId}`,
      `end:${firstId}`,
      `start:${secondId}`,
      `end:${secondId}`,
    ]);
    await runner.stop();
  });

  it('serializes account-wide Identity writes with null message targets', async () => {
    const firstBlocked = deferred();
    const order = [];
    const firstId = await insertTargetlessWrite('createIdentity');
    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async (row) => {
        order.push(`start:${row.id}`);
        if (row.id === firstId) await firstBlocked.promise;
        order.push(`end:${row.id}`);
        return { ok: true };
      },
      options: { notifyDelayMs: 0 },
    });
    const secondId = await insertTargetlessWrite('updateIdentity');
    const drainPromise = runner.drain();

    await waitFor(() => order.includes(`start:${firstId}`));
    expect(order).not.toContain(`start:${secondId}`);
    firstBlocked.resolve();
    await drainPromise;

    expect(order).toEqual([
      `start:${firstId}`,
      `end:${firstId}`,
      `start:${secondId}`,
      `end:${secondId}`,
    ]);
    await runner.stop();
  });

  it('serializes setKeywords + destroy against the same message id', async () => {
    // markRead followed by destroy must not interleave: if the
    // destroy Email/set lands before the setKeywords, the second
    // call hits notFound and the runner reports failure when in
    // reality both user actions were fine. Per-target lock chain
    // makes the order deterministic.
    const localMsg = await seedMessage('e-1');
    const order = [];
    const setKeywordsStarted = deferred();
    const setKeywordsRelease = deferred();
    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async (row) => {
        order.push(`start:${row.mutation_type}`);
        if (row.mutation_type === 'setKeywords') {
          setKeywordsStarted.resolve();
          await setKeywordsRelease.promise;
        }
        order.push(`end:${row.mutation_type}`);
        return { ok: true };
      },
      options: { notifyDelayMs: 0 },
    });

    await insertSetKeywords({ targetMessageId: localMsg });
    await insertDestroy({ targetMessageId: localMsg });

    const drainPromise = runner.drain();
    // Wait until the setKeywords dispatch has actually entered
    // processRow. Without this we'd race the wa-sqlite query that
    // _loadReadyRows does internally.
    await setKeywordsStarted.promise;
    expect(order).toEqual(['start:setKeywords']);

    // Give the runner several real-time ticks to (incorrectly)
    // schedule destroy if the lock chain were broken. Destroy must
    // still be blocked behind setKeywords.
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['start:setKeywords']);

    setKeywordsRelease.resolve();
    await drainPromise;

    expect(order).toEqual([
      'start:setKeywords',
      'end:setKeywords',
      'start:destroy',
      'end:destroy',
    ]);
    await runner.stop();
  });

  it('does NOT serialize rows for different message ids', async () => {
    // Per-target serialization must not turn into a global lock —
    // unrelated mutations should fire concurrently.
    const a = await seedMessage('e-a');
    const b = await seedMessage('e-b');
    const seen = [];
    const bDone = deferred();
    const aBlocked = deferred();
    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async (row) => {
        seen.push(`start:${row.target_message_id}`);
        if (Number(row.target_message_id) === a) {
          await aBlocked.promise;
        }
        seen.push(`end:${row.target_message_id}`);
        if (Number(row.target_message_id) === b) bDone.resolve();
        return { ok: true };
      },
      options: { notifyDelayMs: 0 },
    });
    await insertSetKeywords({ targetMessageId: a });
    await insertSetKeywords({ targetMessageId: b });
    const drainPromise = runner.drain();

    // Wait for B to finish independently of A. If the lock chain
    // were global, this would deadlock until aBlocked is released
    // and the test would time out — which is exactly the failure
    // mode we want to detect.
    await bDone.promise;
    expect(seen).toContain(`start:${a}`);
    expect(seen).toContain(`start:${b}`);
    expect(seen).toContain(`end:${b}`);
    expect(seen).not.toContain(`end:${a}`);

    aBlocked.resolve();
    await drainPromise;
    expect(seen).toContain(`end:${a}`);
    await runner.stop();
  });
});

describe('OutboxRunner exponential backoff', () => {
  it('retries with exponential backoff and reaches conflicted at the attempt cap', async () => {
    // Always-failing processRow drives the row through the full
    // pending -> retry -> ... -> conflicted state machine. Uses real
    // timers with very short windows (5ms base, 4 attempts: 5+10+20
    // = 35ms total) so the test finishes well under the default
    // vitest timeout while still going through the real setTimeout
    // wake path the runner uses in production.
    const localMsg = await seedMessage('e-1');
    let attempts = 0;
    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async () => {
        attempts += 1;
        return { ok: false, error: { type: 'serverFail' } };
      },
      options: {
        notifyDelayMs: 0,
        backoffBaseMs: 5,
        backoffCapMs: 1_000,
        maxAttempts: 4,
      },
    });

    const mutationId = await insertSetKeywords({ targetMessageId: localMsg });
    runner.notify({ immediate: true });

    // Wait for the row to land in 'conflicted' — the runner will
    // chain through 4 attempts with growing not_before windows on
    // its own.
    await waitFor(async () => {
      const row = await loadRow(mutationId);
      return row?.local_status === 'conflicted';
    });

    expect(attempts).toBe(4);
    const row = await loadRow(mutationId);
    expect(row.local_status).toBe('conflicted');
    expect(Number(row.attempts)).toBe(4);
    expect(row.error_json).toMatch(/serverFail/);
    await runner.stop();
  });

  it('applies a smaller retry cap to draft saves', async () => {
    let attempts = 0;
    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async () => {
        attempts += 1;
        return { ok: false, error: { type: 'serverFail' } };
      },
      options: {
        notifyDelayMs: 0,
        backoffBaseMs: 5,
        maxAttempts: 8,
        maxAttemptsByType: { saveDraft: 3 },
      },
    });
    const mutationId = await insertComposeMutation('saveDraft', 'draft-session');

    const result = await runner.runMutation(mutationId);

    expect(result).toMatchObject({ succeeded: 0, failed: 1 });
    expect(attempts).toBe(3);
    expect(Number((await loadRow(mutationId)).attempts)).toBe(3);
    await runner.stop();
  });

  it('does not retry an HTTP authentication failure', async () => {
    let attempts = 0;
    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async () => {
        attempts += 1;
        const error: any = new Error('JMAP request failed: 401 Unauthorized');
        error.status = 401;
        throw error;
      },
      options: {
        notifyDelayMs: 0,
        backoffBaseMs: 5,
        maxAttempts: 8,
      },
    });
    const mutationId = await insertComposeMutation('saveDraft', 'draft-session');

    await expect(runner.runMutation(mutationId)).resolves.toMatchObject({
      succeeded: 0,
      failed: 1,
      errorType: 'authenticationFailed',
    });
    expect(attempts).toBe(1);
    expect(Number((await loadRow(mutationId)).attempts)).toBe(1);
    await runner.stop();
  });

  it('does not retry an HTTP authorization failure', async () => {
    let attempts = 0;
    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async () => {
        attempts += 1;
        const error: any = new Error('JMAP request failed: 403 Forbidden');
        error.status = 403;
        throw error;
      },
      options: {
        notifyDelayMs: 0,
        backoffBaseMs: 5,
        maxAttempts: 8,
      },
    });
    const mutationId = await insertComposeMutation('saveDraft', 'draft-session');

    await expect(runner.runMutation(mutationId)).resolves.toMatchObject({
      succeeded: 0,
      failed: 1,
      errorType: 'authorizationFailed',
    });
    expect(attempts).toBe(1);
    expect(Number((await loadRow(mutationId)).attempts)).toBe(1);
    await runner.stop();
  });

  it('records a not_before window in the future after a single transient failure', async () => {
    // Pins the per-attempt backoff math: after attempt N fails, the
    // row's not_before should be ~now + 2^(N-1) * base. We only
    // check the first attempt here because the wake-driven retry
    // would race the assertion otherwise.
    const localMsg = await seedMessage('e-1');
    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async () => ({ ok: false, error: { type: 'serverFail' } }),
      options: {
        // Long base so the wake timer cannot fire before the
        // assertion below runs.
        notifyDelayMs: 0,
        backoffBaseMs: 5_000,
        backoffCapMs: 60_000,
        maxAttempts: 8,
      },
    });
    const before = Date.now();
    const mutationId = await insertSetKeywords({ targetMessageId: localMsg });
    runner.notify({ immediate: true });
    await waitFor(async () => {
      const row = await loadRow(mutationId);
      return row?.local_status === 'retry';
    });
    const row = await loadRow(mutationId);
    expect(Number(row.attempts)).toBe(1);
    expect(Number(row.not_before)).toBeGreaterThanOrEqual(before + 4_000);
    expect(Number(row.not_before)).toBeLessThanOrEqual(before + 10_000);
    // Stop before the wake timer fires so the test exits cleanly.
    await runner.stop();
  });

  it('treats terminal SetError types as immediate failures without burning the retry budget', async () => {
    const localMsg = await seedMessage('e-1');
    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async () => ({
        ok: false,
        error: { type: 'forbidden', description: 'denied' },
      }),
      options: { notifyDelayMs: 0, maxAttempts: 8 },
    });
    const mutationId = await insertSetKeywords({ targetMessageId: localMsg });
    runner.notify({ immediate: true });
    await runner.drain();
    const row = await loadRow(mutationId);
    expect(row.local_status).toBe('conflicted');
    // attempt counter still moves so the per-row failure history is
    // accurate, but we did NOT retry.
    expect(Number(row.attempts)).toBe(1);
    expect(row.error_json).toMatch(/forbidden/);
    await runner.stop();
  });

  it('promotes a thrown processRow to a transport failure that retries', async () => {
    const localMsg = await seedMessage('e-1');
    let calls = 0;
    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async () => {
        calls += 1;
        throw new Error('socket reset');
      },
      options: {
        notifyDelayMs: 0,
        maxAttempts: 8,
        // Long backoff so we observe the post-first-failure retry
        // state instead of racing the second attempt.
        backoffBaseMs: 10_000,
      },
    });
    const mutationId = await insertSetKeywords({ targetMessageId: localMsg });
    runner.notify({ immediate: true });
    await waitFor(async () => {
      const row = await loadRow(mutationId);
      return row?.local_status === 'retry';
    });
    const row = await loadRow(mutationId);
    expect(calls).toBe(1);
    expect(row.local_status).toBe('retry');
    expect(row.error_json).toMatch(/socket reset/);
    await runner.stop();
  });
});

describe('OutboxRunner crash recovery', () => {
  it('migration 002 resets stuck in_flight rows to pending so the runner picks them up', async () => {
    // The migration ran during bootTestEngine(); pretend a previous
    // worker crashed mid-dispatch by writing a row directly with
    // local_status='in_flight'. The runner does not see it on its
    // own — but on the next engine boot the migration sweep would
    // reset it. Simulate that by running an UPDATE matching what
    // the migration does on a real reboot.
    const localMsg = await seedMessage('e-1');
    const mutationId = await insertSetKeywords({ targetMessageId: localMsg });
    await engine.run(
      `UPDATE pending_mutations
          SET local_status = 'in_flight',
              attempts = 4,
              last_attempt_at = ?
        WHERE id = ?`,
      [Date.now() - 5_000, mutationId],
    );

    // Reboot scenario: re-run the in_flight sweep that 002 ships.
    await engine.run(
      `UPDATE pending_mutations
          SET local_status = 'pending', not_before = NULL,
              updated_at = ?
        WHERE local_status = 'in_flight'`,
      [Date.now()],
    );

    const calls = [];
    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async (row) => {
        calls.push({ id: row.id, attempts: Number(row.attempts) });
        return { ok: true };
      },
      options: { notifyDelayMs: 0 },
    });
    runner.notify({ immediate: true });
    await runner.drain();
    expect(calls).toEqual([{ id: mutationId, attempts: 4 }]);
    // Attempt counter preserved through the crash: the row that
    // got partway through several retries should continue aging
    // toward the cap, not start over.
    const row = await loadRow(mutationId);
    expect(row).toBeNull(); // succeeded -> deleted
    await runner.stop();
  });
});

describe('OutboxRunner runMutation', () => {
  it('resolves with success once the targeted row terminates', async () => {
    const localMsg = await seedMessage('e-1');
    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async () => ({ ok: true }),
      options: { notifyDelayMs: 0 },
    });
    const mutationId = await insertSetKeywords({ targetMessageId: localMsg });
    const result = await runner.runMutation(mutationId);
    expect(result).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(await loadRow(mutationId)).toBeNull();
    await runner.stop();
  });

  it('reports failure once a transient error blows through the attempt cap', async () => {
    const localMsg = await seedMessage('e-1');
    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async () => ({ ok: false, error: { type: 'serverFail' } }),
      options: {
        notifyDelayMs: 0,
        maxAttempts: 2,
        // 5ms base so the second attempt runs quickly.
        backoffBaseMs: 5,
      },
    });
    const mutationId = await insertSetKeywords({ targetMessageId: localMsg });
    // runMutation only resolves when the row reaches a terminal
    // state (success / conflicted / cap reached). The wake-driven
    // second attempt will fire after the 5ms backoff and push the
    // row to conflicted.
    const result = await runner.runMutation(mutationId);
    expect(result).toEqual({
      attempted: 1, succeeded: 0, failed: 1, errorType: 'serverFail',
    });
    const row = await loadRow(mutationId);
    expect(row.local_status).toBe('conflicted');
    expect(Number(row.attempts)).toBe(2);
    await runner.stop();
  });

  it('returns durable per-id folder outcomes to the Repository caller', async () => {
    const localMsg = await seedMessage('e-results');
    const perId = {
      succeededIds: [10],
      errors: { 11: { type: 'notUpdated', detail: { type: 'forbidden' } } },
    };
    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async () => ({
        ok: false,
        error: { type: 'notUpdated', terminal: true, result: perId },
        result: perId,
      }),
      options: { notifyDelayMs: 0 },
    });
    const mutationId = await insertSetKeywords({ targetMessageId: localMsg });

    expect(await runner.runMutation(mutationId)).toEqual({
      attempted: 1,
      succeeded: 0,
      failed: 1,
      result: perId,
      errorType: 'notUpdated',
    });
    await runner.stop();
  });

  it('returns succeeded=1 for an id that is already deleted (a prior pass already pushed it)', async () => {
    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async () => ({ ok: true }),
      options: { notifyDelayMs: 0 },
    });
    const result = await runner.runMutation(999_999);
    expect(result).toEqual({ attempted: 0, succeeded: 1, failed: 0 });
    await runner.stop();
  });

  it('does not hang if a concurrent auto-drain deletes the row before the awaiter is registered', async () => {
    // Production inserts trigger the handlers hook, which notifies
    // the runner before the store calls runMutation(id). Firefox can
    // schedule that drain tightly enough that the row is deleted after
    // runMutation's initial _loadRow() observes it but before
    // runMutation registers its awaiter. Without the post-registration
    // re-read, the awaiter was orphaned forever and the bulk progress
    // overlay never disappeared even though the server-side move
    // succeeded.
    const localMsg = await seedMessage('e-race');
    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async () => ({ ok: true }),
      options: { notifyDelayMs: 0 },
    });
    const mutationId = await insertSetKeywords({ targetMessageId: localMsg });
    const originalLoadRow = runner._loadRow.bind(runner);
    let loads = 0;
    runner._loadRow = async (id) => {
      const row = await originalLoadRow(id);
      loads += 1;
      if (loads === 1) {
        await handlers[DB_RPC.QUERY]({
          sql: 'DELETE FROM pending_mutations WHERE id = ?',
          params: [id],
        });
      }
      return row;
    };

    const result = await Promise.race([
      runner.runMutation(mutationId),
      new Promise((_, reject) => setTimeout(() => reject(new Error('runMutation hung')), 250)),
    ]);

    expect(result).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(await loadRow(mutationId)).toBeNull();
    await runner.stop();
  });
});

describe('OutboxRunner integration with the handlers hook', () => {
  it('drains a row that was inserted via PENDING_MUTATION_INSERT once a notifier is wired', async () => {
    // Mirrors the production wiring: shared-worker.js gives
    // makeHandlers an onMutationInserted callback that defers to
    // the runner's notify(). We re-create that here so a regression
    // in handlers.js (e.g. someone drops the hook invocation) is
    // caught at the worker layer too.
    let notified = 0;
    let runner;
    const localEngine = await bootTestEngine();
    try {
      const handlersWithHook = makeHandlers(localEngine, undefined, {
        onMutationInserted: () => {
          notified += 1;
          runner?.notify({ immediate: true });
        },
      });
      const account = (await handlersWithHook[DB_RPC.ACCOUNT_UPSERT]({
        displayName: 'T', primaryEmail: 't@x', serverOrigin: 'https://x',
        remoteAccountId: 'acct-1', isPrimary: true,
      })).row;
      const ts = Date.now();
      await localEngine.run(
        `INSERT INTO messages(account_id, remote_id, subject, keywords_json,
           metadata_fetched_at, updated_at)
         VALUES (?, 'e-1', 's', '{}', ?, ?)`,
        [account.id, ts, ts],
      );
      const msg = await localEngine.get(
        'SELECT id FROM messages WHERE account_id = ? AND remote_id = ?',
        [account.id, 'e-1'],
      );

      const seen = [];
      runner = new OutboxRunner({
        accountId: account.id,
        handlers: handlersWithHook,
        processRow: async (row) => {
          seen.push(row.id);
          return { ok: true };
        },
        options: { notifyDelayMs: 0 },
      });

      const insert = await handlersWithHook[DB_RPC.PENDING_MUTATION_INSERT]({
        accountId: account.id,
        mutationType: 'setKeywords',
        targetMessageId: msg.id,
        requestJson: JSON.stringify({ add: ['$seen'], remove: [] }),
      });
      // Settle the drain triggered by the hook.
      await runner.drain();
      expect(notified).toBe(1);
      expect(seen).toEqual([insert.id]);
      const row = await localEngine.get(
        'SELECT * FROM pending_mutations WHERE id = ?',
        [insert.id],
      );
      expect(row).toBeNull();
    } finally {
      if (runner) await runner.stop();
      await localEngine.close();
    }
  });
});

describe('OutboxRunner replay safety', () => {
  async function strand(mutationId) {
    await engine.run(
      `UPDATE pending_mutations SET local_status = 'in_flight', attempts = 3
        WHERE id = ?`,
      [mutationId],
    );
  }

  async function insertSend({ phase = null } = {}) {
    const r = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId,
      mutationType: 'send',
      requestJson: JSON.stringify({ identityId: 1, to: [{ email: 'a@b.test' }] }),
    });
    if (phase) {
      await engine.run('UPDATE pending_mutations SET phase = ? WHERE id = ?', [phase, r.id]);
    }
    return r.id;
  }

  const PHASE_POLICY = {
    unsafeToReplayTypes: ['send'],
    replayablePhases: ['queued', 'created'],
    completedPhases: ['submitted', 'cache_pending'],
  };
  // 'submitting' is deliberately in neither list: a crash there is
  // indistinguishable from a delivered message.

  it('returns a stranded row to pending so a later boot can retry it', async () => {
    // Migration 002 resets in_flight rows, but migrations run once per
    // database version, so a crash after that boot leaves the row
    // invisible to _loadReadyRows forever.
    const localMsg = await seedMessage('e-1');
    const mutationId = await insertSetKeywords({ targetMessageId: localMsg });
    await strand(mutationId);

    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async () => ({ ok: true }),
      options: { notifyDelayMs: 0 },
    });
    await runner.recoverStranded();

    const row = await loadRow(mutationId);
    expect(row.local_status).toBe('pending');
    expect(row.not_before).toBeNull();
    // Preserved so the row keeps aging toward the attempt cap.
    expect(Number(row.attempts)).toBe(3);
    await runner.stop();
  });

  it('resumes a stranded send that never recorded its first phase', async () => {
    // The first checkpoint precedes Email creation and submission, so a
    // phaseless row cannot conceal an irreversible send.
    const mutationId = await insertSend();
    await strand(mutationId);

    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async () => ({ ok: true }),
      options: { notifyDelayMs: 0, ...PHASE_POLICY },
    });
    await runner.recoverStranded();

    const row = await loadRow(mutationId);
    expect(row.local_status).toBe('pending');
    expect(row.error_json).toBeNull();
    expect(JSON.parse(row.request_json).to[0].email).toBe('a@b.test');
    await runner.stop();
  });

  it('resumes a stranded send that had not reached submission', async () => {
    // The checkpoint says an Email exists but was never submitted, so
    // nothing irreversible happened and the row can safely continue.
    const mutationId = await insertSend({ phase: 'created' });
    await strand(mutationId);

    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async () => ({ ok: true }),
      options: { notifyDelayMs: 0, ...PHASE_POLICY },
    });
    await runner.recoverStranded();

    const row = await loadRow(mutationId);
    expect(row.local_status).toBe('pending');
    expect(row.phase).toBe('created');
    await runner.stop();
  });

  it('requeues a stranded send that had already been submitted', async () => {
    // The message went out before the crash, so reporting a failure would
    // be a lie and replaying the submission would send a second copy.
    // The row returns to the queue, where the checkpoint makes it skip to
    // filing the local copy.
    const submitted = await insertSend({ phase: 'submitted' });
    const filing = await insertSend({ phase: 'cache_pending' });
    await strand(submitted);
    await strand(filing);

    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async () => ({ ok: true }),
      options: { notifyDelayMs: 0, ...PHASE_POLICY },
    });
    await runner.recoverStranded();

    expect((await loadRow(submitted)).local_status).toBe('pending');
    expect((await loadRow(filing)).local_status).toBe('pending');
    // The phase survives, which is what stops the resume from
    // re-submitting.
    expect((await loadRow(submitted)).phase).toBe('submitted');
    await runner.stop();
  });

  it('conflicts a send stranded while its submission was in flight', async () => {
    // The crash happened inside the submission round trip, so the server
    // may already have accepted it. This is the case that must never be
    // replayed, and the reason 'submitting' is written before the call.
    const mutationId = await insertSend({ phase: 'submitting' });
    await strand(mutationId);

    const attempted = [];
    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async (row) => {
        attempted.push(row.id);
        return { ok: true };
      },
      options: { notifyDelayMs: 0, ...PHASE_POLICY },
    });
    await runner.recoverStranded();

    const row = await loadRow(mutationId);
    expect(row.local_status).toBe('conflicted');
    expect(JSON.parse(row.error_json).type).toBe('outcomeUnknown');
    await runner.drain();
    expect(attempted).toEqual([]);
    await runner.stop();
  });

  it('recovers stranded non-send and phaseless-send rows together', async () => {
    const localMsg = await seedMessage('e-2');
    const keywordsId = await insertSetKeywords({ targetMessageId: localMsg });
    const sendId = await insertSend();
    await strand(keywordsId);
    await strand(sendId);

    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async () => ({ ok: true }),
      options: { notifyDelayMs: 0, ...PHASE_POLICY },
    });
    await runner.recoverStranded();

    expect((await loadRow(keywordsId)).local_status).toBe('pending');
    expect((await loadRow(sendId)).local_status).toBe('pending');
    await runner.stop();
  });

  it('does not retry a send after a transport error', async () => {
    // The socket can die after the server accepted the submission, so a
    // retry could deliver a second copy. Compare with the setKeywords
    // case above, which does retry a thrown processRow.
    let calls = 0;
    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async () => {
        calls += 1;
        throw new Error('socket reset mid-submission');
      },
      options: {
        notifyDelayMs: 0,
        backoffBaseMs: 10_000,
        unsafeToReplayTypes: ['send'],
      },
    });
    const mutationId = await insertSend();

    expect(await runner.runMutation(mutationId)).toEqual({
      attempted: 1,
      succeeded: 0,
      failed: 1,
      errorType: 'transport',
    });

    const row = await loadRow(mutationId);
    expect(calls).toBe(1);
    expect(row.local_status).toBe('conflicted');
    const error = JSON.parse(row.error_json);
    expect(error.type).toBe('transport');
    expect(error.terminal).toBe(true);
    await runner.stop();
  });

  it('tells a caller waiting on a send at teardown that the outcome is unknown', async () => {
    // The row is parked for a retry that will never come, because the
    // worker is going away. Nobody can say how far the send got, and
    // reporting a plain failure is what makes the composer offer Send
    // again — a second press is a second delivery.
    const runner = new OutboxRunner({
      accountId,
      handlers,
      // Not thrown, so the runner keeps a retry budget rather than
      // conflicting the row outright.
      processRow: async () => ({ ok: false, error: { type: 'serverFail' } }),
      options: { notifyDelayMs: 0, backoffBaseMs: 60_000, ...PHASE_POLICY },
    });
    const mutationId = await insertSend({ phase: 'queued' });

    const pending = runner.runMutation(mutationId);
    await vi.waitUntil(async () => (await loadRow(mutationId))?.local_status === 'retry');
    await runner.stop();

    expect(await pending).toEqual({
      attempted: 1,
      succeeded: 0,
      failed: 1,
      errorType: 'outcomeUnknown',
    });
  });

  it('tells a caller waiting on a replayable mutation at teardown that it simply stopped', async () => {
    // Nothing irreversible can be hiding behind a keyword change, so this
    // caller is free to report an ordinary failure and try again.
    const localMsg = await seedMessage('e-stop');
    const runner = new OutboxRunner({
      accountId,
      handlers,
      processRow: async () => ({ ok: false, error: { type: 'serverFail' } }),
      options: { notifyDelayMs: 0, backoffBaseMs: 60_000, ...PHASE_POLICY },
    });
    const mutationId = await insertSetKeywords({ targetMessageId: localMsg });

    const pending = runner.runMutation(mutationId);
    await vi.waitUntil(async () => (await loadRow(mutationId))?.local_status === 'retry');
    await runner.stop();

    expect(await pending).toEqual({
      attempted: 1,
      succeeded: 0,
      failed: 1,
      errorType: 'stopped',
    });
  });
});
