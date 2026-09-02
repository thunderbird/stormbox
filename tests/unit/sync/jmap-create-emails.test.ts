import {
  afterEach, beforeEach, describe, expect, it,
} from 'vitest';

import { CREATE_EMAILS_PHASE, MUTATION_RECOVERY_POLICIES } from '../../../src/constants/states';
import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { syncMailboxes } from '../../../src/sync/backends/jmap/mailboxes';
import { CACHE_REPAIR_MAX_ATTEMPTS } from '../../../src/sync/backends/jmap/mutation-checkpoint';
import { drainOutbox, MUTATION_TYPES } from '../../../src/sync/backends/jmap/outbox';
import { OutboxRunner } from '../../../src/sync/backends/jmap/outbox-runner';
import {
  buildEmailCreate,
  runCreateEmails,
  type CreateEmailSpec,
} from '../../../src/sync/backends/jmap/outbox/operations/create-emails';
import { MockTransport, mockSession } from './_mock-transport';

let engine;
let handlers;
let account;
let target;

const NOW = Date.parse('2026-09-01T12:00:00Z');

function spec(n: number, overrides: Partial<CreateEmailSpec> = {}): CreateEmailSpec {
  return {
    clientId: `seed${n}`,
    from: { name: `Sender ${n}`, email: `sender${n}@example.com` },
    to: [{ email: 'me@example.com' }],
    subject: `Subject ${n}`,
    receivedAt: NOW - n * 3_600_000,
    keywords: n % 2 === 0 ? { $seen: true } : {},
    textBody: `Body ${n}`,
    ...overrides,
  };
}

/**
 * Answers Email/set create with fresh ids and Email/get with matching
 * rows. `afterCommit` runs once the fake server has stored the chunk and
 * may throw to simulate a response lost after the commit.
 */
function wireCreatingServer(transport: MockTransport, {
  failClientIds = [] as string[],
  afterCommit = (_response: any, _call: number): any => undefined,
} = {}) {
  const store = new Map<string, any>();
  let counter = 0;
  let calls = 0;
  transport.handle('Email/set', (params) => {
    const created: Record<string, any> = {};
    const notCreated: Record<string, any> = {};
    for (const [clientId, create] of Object.entries<any>(params.create ?? {})) {
      if (failClientIds.includes(clientId)) {
        notCreated[clientId] = { type: 'overQuota' };
        continue;
      }
      counter += 1;
      const id = `e-new-${counter}`;
      store.set(id, {
        id,
        blobId: `b-${id}`,
        threadId: `t-${id}`,
        mailboxIds: create.mailboxIds,
        keywords: create.keywords ?? {},
        size: 100,
        receivedAt: create.receivedAt,
        sentAt: create.receivedAt,
        messageId: [`<${id}@example.com>`],
        from: create.from,
        to: create.to,
        sender: create.from,
        subject: create.subject,
        preview: create.bodyValues?.p1?.value?.slice(0, 40) ?? '',
        hasAttachment: false,
      });
      created[clientId] = { id, blobId: `b-${id}`, threadId: `t-${id}`, size: 100 };
    }
    const response = {
      accountId: params.accountId, oldState: 's0', newState: 's1', created, notCreated,
    };
    calls += 1;
    return afterCommit(response, calls) ?? response;
  });
  transport.handle('Email/get', (params) => ({
    list: (params.ids ?? []).map((id) => store.get(id)).filter(Boolean),
    notFound: (params.ids ?? []).filter((id) => !store.has(id)),
    state: 's1',
  }));
  return store;
}

beforeEach(async () => {
  engine = await bootTestEngine();
  handlers = makeHandlers(engine);
  account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
    displayName: 'T',
    primaryEmail: 'me@example.com',
    serverOrigin: 'https://mail.example.com',
    remoteAccountId: 'acct-1',
    isPrimary: true,
  })).row;
  const t = new MockTransport();
  t.handle('Mailbox/get', () => ({
    list: [
      { id: 'mb-inbox', name: 'Inbox', role: 'inbox' },
      { id: 'mb-archive', name: 'Archive', role: 'archive' },
      { id: 'mb-needs-reply', name: 'Needs Reply', role: null },
    ],
    state: 's0',
  }));
  await syncMailboxes({ transport: t, account, handlers });
  target = await engine.get(
    'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
    [account.id, 'mb-needs-reply'],
  );
});

afterEach(async () => {
  await engine.close();
});

describe('buildEmailCreate', () => {
  it('produces the RFC 8621 Email/set create shape with a plain-text body', () => {
    const create = buildEmailCreate(spec(2), 'mb-needs-reply');
    expect(create).toEqual({
      mailboxIds: { 'mb-needs-reply': true },
      keywords: { $seen: true },
      from: [{ name: 'Sender 2', email: 'sender2@example.com' }],
      to: [{ name: '', email: 'me@example.com' }],
      subject: 'Subject 2',
      receivedAt: new Date(NOW - 2 * 3_600_000).toISOString(),
      bodyStructure: { type: 'text/plain', partId: 'p1' },
      bodyValues: { p1: { value: 'Body 2' } },
    });
  });

  it('falls back to now for an unparseable receivedAt', () => {
    const before = Date.now();
    const create = buildEmailCreate(spec(1, { receivedAt: 'not a date' }), 'mb');
    expect(Date.parse(create.receivedAt)).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe('createEmails outbox operation', () => {
  it('creates every email in the target mailbox and mirrors them into the cache', async () => {
    const transport = new MockTransport();
    wireCreatingServer(transport);
    const emails = [spec(1), spec(2), spec(3)];

    const result = await runOp(transport, await insertCreate(emails));

    expect(result.ok).toBe(true);
    expect(result.result.succeededIds).toEqual(['seed1', 'seed2', 'seed3']);
    expect(Object.keys(result.result.created ?? {})).toEqual(['seed1', 'seed2', 'seed3']);

    const setCall = transport.requests[0].methodCalls[0];
    expect(setCall[0]).toBe('Email/set');
    expect(setCall[1].accountId).toBe('acct-1');
    expect(setCall[1].create.seed1.mailboxIds).toEqual({ 'mb-needs-reply': true });
    expect(setCall[1].create.seed1.receivedAt).toBe(new Date(NOW - 3_600_000).toISOString());

    const rows = await engine.all(
      `SELECT m.subject, m.is_seen, m.received_at
         FROM messages m
         JOIN folder_messages fm ON fm.message_id = m.id
        WHERE fm.folder_id = ?
        ORDER BY m.subject`,
      [target.id],
    );
    expect(rows.map((r) => r.subject)).toEqual(['Subject 1', 'Subject 2', 'Subject 3']);
    expect(rows.map((r) => Number(r.is_seen))).toEqual([0, 1, 0]);
  });

  it('is dispatched by the outbox and the pending row is removed on success', async () => {
    const transport = new MockTransport();
    wireCreatingServer(transport);
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.CREATE_EMAILS,
      targetMessageId: null,
      requestJson: JSON.stringify({ folderId: target.id, emails: [spec(1)] }),
    });

    const summary = await drainOutbox({ transport, account, handlers });

    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    const pending = await engine.all('SELECT * FROM pending_mutations');
    expect(pending).toEqual([]);
  });

  it('chunks the create by maxObjectsInSet', async () => {
    const transport = new MockTransport(mockSession({ core: { maxObjectsInSet: 10 } }));
    wireCreatingServer(transport);
    const emails = Array.from({ length: 23 }, (_, i) => spec(i + 1));

    const result = await runOp(transport, await insertCreate(emails));

    expect(result.ok).toBe(true);
    const setCalls = transport.requests
      .flatMap((r) => r.methodCalls)
      .filter((call) => call[0] === 'Email/set');
    expect(setCalls.map((call) => Object.keys(call[1].create).length)).toEqual([10, 10, 3]);
    const count = await engine.get(
      'SELECT COUNT(*) AS n FROM folder_messages WHERE folder_id = ?',
      [target.id],
    );
    expect(Number(count.n)).toBe(23);
  });

  it('rejects an unknown folder without calling the server', async () => {
    const transport = new MockTransport();
    const row = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.CREATE_EMAILS,
      targetMessageId: null,
      requestJson: JSON.stringify({ folderId: 9999, emails: [spec(1)] }),
    });
    const result = await runOp(transport, row);
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ type: 'unknownFolder', terminal: true });
    expect(transport.requests).toEqual([]);
  });

  it('marks a partial failure terminal so a retry cannot duplicate the created emails', async () => {
    const transport = new MockTransport();
    wireCreatingServer(transport, { failClientIds: ['seed2'] });

    const result = await runOp(transport, await insertCreate([spec(1), spec(2), spec(3)]));

    expect(result.ok).toBe(false);
    expect(result.error.terminal).toBe(true);
    expect(result.result.succeededIds).toEqual(['seed1', 'seed3']);
    expect(result.result.errors.seed2).toMatchObject({ type: 'notCreated', detail: { type: 'overQuota' } });
  });

  it('retries a method-level rejection that created nothing', async () => {
    // A method error means the server did not run the call (RFC 8620
    // §3.6.2), so nothing exists to duplicate and a replay is safe.
    const transport = new MockTransport();
    transport.handleError('Email/set', { type: 'serverUnavailable' });
    const row = await insertCreate([spec(1)]);

    const result = await runOp(transport, row);

    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('serverUnavailable');
    expect(result.error.terminal).toBeUndefined();
    expect(result.result.succeededIds).toEqual([]);
    // The row is left without a phase so the replay starts from scratch.
    expect((await loadRow(row.id)).phase).toBeNull();
  });
});

async function insertCreate(emails: CreateEmailSpec[]) {
  return handlers[DB_RPC.PENDING_MUTATION_INSERT]({
    accountId: account.id,
    mutationType: MUTATION_TYPES.CREATE_EMAILS,
    targetMessageId: null,
    requestJson: JSON.stringify({ folderId: target.id, emails }),
  });
}

async function loadRow(id: number) {
  return engine.get('SELECT * FROM pending_mutations WHERE id = ?', [id]);
}

async function runOp(transport: MockTransport, row: any) {
  const current = await loadRow(row.id);
  return runCreateEmails({
    transport,
    account,
    handlers,
    row: current,
    request: JSON.parse(current.request_json),
    useWebSocket: false,
  });
}

async function cachedCount() {
  const count = await engine.get(
    'SELECT COUNT(*) AS n FROM folder_messages WHERE folder_id = ?',
    [target.id],
  );
  return Number(count.n);
}

describe('createEmails replay safety', () => {
  it('a response lost after the server committed is an unknown outcome and is never replayed', async () => {
    const transport = new MockTransport();
    const store = wireCreatingServer(transport, {
      afterCommit: (_response, call) => {
        if (call === 1) throw new Error('socket closed');
      },
    });
    const row = await insertCreate([spec(1), spec(2)]);

    const first = await drainOutbox({ transport, account, handlers });
    expect(first).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
    // The server holds exactly one copy of each seed mail.
    expect(store.size).toBe(2);

    const parked = await loadRow(row.id);
    expect(parked.local_status).toBe('conflicted');
    expect(JSON.parse(parked.error_json)).toMatchObject({
      protocolType: 'createOutcomeUnknown',
      terminal: true,
    });
    expect(parked.phase).toBe(CREATE_EMAILS_PHASE.SUBMITTING);

    // A later drain does not pick the row up again, so the server count
    // stays at one copy per seed mail.
    const second = await drainOutbox({ transport, account, handlers });
    expect(second).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect(store.size).toBe(2);
    const setCalls = transport.requests
      .flatMap((r) => r.methodCalls)
      .filter((call) => call[0] === 'Email/set');
    expect(setCalls).toHaveLength(1);
  });

  it('serverPartialFail is an unknown outcome rather than a retry', async () => {
    // RFC 8620 §3.6.2: some changes may have been made; the client must
    // resynchronise rather than replay.
    const transport = new MockTransport();
    transport.handleError('Email/set', { type: 'serverPartialFail' });
    const row = await insertCreate([spec(1)]);

    const result = await runOp(transport, row);

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      protocolType: 'createOutcomeUnknown',
      terminal: true,
    });
  });

  it('a chunk lost after earlier chunks were created still files the created ones', async () => {
    const transport = new MockTransport(mockSession({ core: { maxObjectsInSet: 2 } }));
    const store = wireCreatingServer(transport, {
      afterCommit: (_response, call) => {
        if (call === 2) throw new Error('socket closed');
      },
    });
    const row = await insertCreate([spec(1), spec(2), spec(3), spec(4)]);

    const result = await runOp(transport, row);

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ protocolType: 'createOutcomeUnknown', terminal: true });
    // Chunk one was acknowledged and is mirrored into the cache; chunk
    // two's outcome is unknown and is neither mirrored nor replayed.
    expect(result.result.succeededIds).toEqual(['seed1', 'seed2']);
    expect(store.size).toBe(4);
    expect(await cachedCount()).toBe(2);
    const setCalls = transport.requests
      .flatMap((r) => r.methodCalls)
      .filter((call) => call[0] === 'Email/set');
    expect(setCalls).toHaveLength(2);
  });

  it('a failed cache mirror after an accepted create is repaired without a second create', async () => {
    const transport = new MockTransport();
    const store = wireCreatingServer(transport);
    let getCalls = 0;
    const serveGet = transport._handlers.get('Email/get')!;
    transport.handle('Email/get', (params, callId) => {
      getCalls += 1;
      if (getCalls === 1) throw new Error('socket closed');
      return serveGet(params, callId);
    });
    const row = await insertCreate([spec(1), spec(2)]);

    const first = await runOp(transport, row);
    expect(first.ok).toBe(false);
    expect(first.error.terminal).toBeUndefined();
    expect(first.error.protocolType).toBe('cacheReconcileFailed');
    expect(store.size).toBe(2);
    expect(await cachedCount()).toBe(0);
    const checkpointed = await loadRow(row.id);
    expect(checkpointed.phase).toBe(CREATE_EMAILS_PHASE.CACHE_PENDING);

    const second = await runOp(transport, row);
    expect(second.ok).toBe(true);
    expect(second.result.succeededIds).toEqual(['seed1', 'seed2']);
    // Repair only re-reads: still one Email/set, still two server copies.
    const setCalls = transport.requests
      .flatMap((r) => r.methodCalls)
      .filter((call) => call[0] === 'Email/set');
    expect(setCalls).toHaveLength(1);
    expect(store.size).toBe(2);
    expect(await cachedCount()).toBe(2);
  });

  it('gives up on cache repair after the attempt cap, reporting the create as applied', async () => {
    const transport = new MockTransport();
    wireCreatingServer(transport);
    transport.handle('Email/get', () => { throw new Error('socket closed'); });
    const row = await insertCreate([spec(1)]);

    let result;
    for (let attempt = 0; attempt < CACHE_REPAIR_MAX_ATTEMPTS; attempt += 1) {
      result = await runOp(transport, row);
      expect(result.ok).toBe(false);
    }
    expect(result.error).toMatchObject({
      protocolType: 'cacheReconcileFailed',
      terminal: true,
      result: { applied: true, cached: false },
    });
  });

  it('a stranded in-flight create is only replayed before its request went out', async () => {
    // Mirrors the send policy: no phase means nothing was sent; the
    // submitting phase is indistinguishable from a committed create and
    // must park; cache_pending only owes the local mirror.
    const policy = MUTATION_RECOVERY_POLICIES
      .find((entry) => entry.mutationType === MUTATION_TYPES.CREATE_EMAILS);
    expect(policy).toBeDefined();
    expect(policy!.replayablePhases).toEqual([]);
    expect(policy!.completedPhases).toEqual([CREATE_EMAILS_PHASE.CACHE_PENDING]);

    const fresh = await insertCreate([spec(1)]);
    const submitting = await insertCreate([spec(2)]);
    const filing = await insertCreate([spec(3)]);
    await engine.run(
      "UPDATE pending_mutations SET local_status = 'in_flight' WHERE id IN (?, ?, ?)",
      [fresh.id, submitting.id, filing.id],
    );
    await engine.run(
      'UPDATE pending_mutations SET phase = ? WHERE id = ?',
      [CREATE_EMAILS_PHASE.SUBMITTING, submitting.id],
    );
    await engine.run(
      'UPDATE pending_mutations SET phase = ? WHERE id = ?',
      [CREATE_EMAILS_PHASE.CACHE_PENDING, filing.id],
    );

    const runner = new OutboxRunner({
      accountId: account.id,
      handlers,
      processRow: async () => ({ ok: true }),
      options: {
        notifyDelayMs: 0,
        unsafeToReplayTypes: MUTATION_RECOVERY_POLICIES.map((entry) => entry.mutationType),
        replayablePhases: MUTATION_RECOVERY_POLICIES.flatMap((entry) => entry.replayablePhases),
        completedPhases: MUTATION_RECOVERY_POLICIES.flatMap((entry) => entry.completedPhases),
      },
    });
    await runner.recoverStranded();

    expect((await loadRow(fresh.id)).local_status).toBe('pending');
    expect((await loadRow(filing.id)).local_status).toBe('pending');
    const parked = await loadRow(submitting.id);
    expect(parked.local_status).toBe('conflicted');
    expect(JSON.parse(parked.error_json).type).toBe('outcomeUnknown');
    await runner.stop();
  });
});
