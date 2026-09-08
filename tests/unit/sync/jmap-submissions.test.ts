/**
 * EmailSubmission synchronizer tests: the Stalwart 0.15.4 read path,
 * tracked-row transitions, external-schedule discovery, settled-row
 * handoffs to durable operations, account isolation, and discovery,
 * adoption, and creation of the Scheduled role folder.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { DB_RPC } from '../../../src/db/protocol';
import { MUTATION_TYPE } from '../../../src/constants/states';
import { syncFolderWindow } from '../../../src/sync/backends/jmap/messages';
import {
  fetchSubmissionRecords,
  syncSubmissionsForAccount,
} from '../../../src/sync/backends/jmap/submissions';
import { ensureScheduledMailbox } from '../../../src/sync/backends/jmap/scheduled-mailbox';
import { MockTransport } from './_mock-transport';
import {
  bootScheduledAccount,
  FUTURE_AT,
  NOW,
  PAST_AT,
  scheduledEmailFixture,
  seedScheduledMessage as seedScheduled,
  type ScheduledAccountContext,
  type SeedScheduledMessageOptions,
} from './_scheduled-fixtures';

let ctx: ScheduledAccountContext;
let engine;
let handlers;
let account;
let scheduledFolder;
let sentFolder;

function emailFixture(id: string, { sentAt = FUTURE_AT, mailbox = 'mb-sched' } = {}) {
  return scheduledEmailFixture(id, { sentAt, mailboxIds: { [mailbox]: true } });
}

/**
 * Transport answering the synchronizer's reads: the unfiltered
 * submission query/get pair, Mailbox/get existence probes, and
 * Email/get for external discovery.
 */
function submissionTransport(records: any[], emailsById: Record<string, any> = {}) {
  const t = new MockTransport();
  t.handle('EmailSubmission/query', (params) => ({
    ids: records
      .map((r) => r.id)
      .slice(params.position ?? 0, (params.position ?? 0) + params.limit),
    position: params.position ?? 0,
    total: records.length,
    canCalculateChanges: false,
    queryState: 'subq-state',
  }));
  t.handle('EmailSubmission/get', (params) => ({
    list: records.filter((r) => (params.ids ?? []).includes(r.id)),
    notFound: [],
    state: 'subg-state',
  }));
  t.handle('Email/get', (params) => ({
    list: (params.ids ?? []).map((id) => emailsById[id]).filter(Boolean),
    notFound: (params.ids ?? []).filter((id) => !emailsById[id]),
    state: 'eg-state',
  }));
  t.handle('Mailbox/get', (params) => ({
    list: (params.ids ?? []).map((id) => ({
      id,
      name: id === 'mb-sched' ? 'Scheduled' : id,
      parentId: null,
      role: id === 'mb-sched' ? 'scheduled' : null,
      isSubscribed: true,
    })),
    notFound: [],
    state: 'mg-state',
  }));
  return t;
}

/** Mailbox/query response listing `ids` as one complete page. */
function mailboxPage(ids: string[]) {
  return {
    ids,
    position: 0,
    total: ids.length,
    canCalculateChanges: false,
    queryState: `mq-${ids.join(',') || 'empty'}`,
  };
}

async function folderRow(remoteId: string) {
  return engine.get(
    'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
    [account.id, remoteId],
  );
}

function seedScheduledMessage(remoteId: string, options: SeedScheduledMessageOptions = {}) {
  return seedScheduled(ctx, remoteId, options);
}

async function messageRow(remoteId: string, accountId = account.id) {
  return engine.get(
    'SELECT * FROM messages WHERE account_id = ? AND remote_id = ?',
    [accountId, remoteId],
  );
}

/**
 * Schedule-related pending mutations only. Settings writes enqueue
 * their own push mutation, which is not what these tests are about.
 */
const SCHEDULE_MUTATION_TYPES = new Set<string>([
  MUTATION_TYPE.MOVE_TO_FOLDERS,
  MUTATION_TYPE.CANCEL_SCHEDULED_SEND,
  MUTATION_TYPE.SET_MAILBOX_SUBSCRIPTION,
]);

async function pendingMutations(type?: string) {
  const rows = await engine.all(
    'SELECT * FROM pending_mutations WHERE account_id = ? ORDER BY id',
    [account.id],
  );
  return rows.filter((r) => (
    type ? r.mutation_type === type : SCHEDULE_MUTATION_TYPES.has(r.mutation_type)
  ));
}

beforeEach(async () => {
  ctx = await bootScheduledAccount();
  ({ engine, handlers, account, scheduledFolder, sentFolder } = ctx);
});

afterEach(async () => {
  await engine.close();
});

describe('fetchSubmissionRecords (Stalwart 0.15.4 read path)', () => {
  it('queries without a filter and gets ids explicitly', async () => {
    const t = submissionTransport([
      { id: 'sub-1', emailId: 'e-1', undoStatus: 'pending', sendAt: FUTURE_AT },
    ]);
    const records = await fetchSubmissionRecords({ transport: t, account });

    const calls = t.requests.flatMap((r) => r.methodCalls);
    const query = calls.find(([name]) => name === 'EmailSubmission/query');
    expect(query[1].filter).toBeUndefined();
    expect(query[1].limit).toBeGreaterThan(0);
    expect(query[1].calculateTotal).toBe(true);
    const get = calls.find(([name]) => name === 'EmailSubmission/get');
    expect(get[1]['#ids']).toMatchObject({
      resultOf: query[2],
      path: '/ids',
    });

    expect(records).toEqual([
      { id: 'sub-1', emailId: 'e-1', undoStatus: 'pending', sendAt: FUTURE_AT },
    ]);
  });

  it('maps an out-of-spec undoStatus to null instead of trusting it', async () => {
    const t = submissionTransport([
      { id: 'sub-1', emailId: 'e-1', undoStatus: 'held', sendAt: FUTURE_AT },
      { id: 'sub-2', emailId: 'e-2' },
    ]);
    const records = await fetchSubmissionRecords({ transport: t, account });
    expect(records.map((r) => r.undoStatus)).toEqual([null, null]);
  });

  it('pages through the complete unfiltered submission id set', async () => {
    const records = Array.from({ length: 1_101 }, (_, index) => ({
      id: `sub-${index}`,
      emailId: `email-${index}`,
      undoStatus: index === 1_100 ? 'pending' : 'final',
      sendAt: FUTURE_AT,
    }));
    const t = submissionTransport(records);

    const fetched = await fetchSubmissionRecords({ transport: t, account });

    expect(fetched).toHaveLength(records.length);
    expect(fetched.at(-1)).toMatchObject({
      id: 'sub-1100',
      emailId: 'email-1100',
      undoStatus: 'pending',
    });
    const queries = t.requests
      .flatMap((request) => request.methodCalls)
      .filter(([name]) => name === 'EmailSubmission/query');
    expect(queries).toHaveLength(3);
    expect(queries.map(([, params]) => params.position)).toEqual([0, 500, 1_000]);
    expect(queries.every(([, params]) => params.filter == null)).toBe(true);
  });

  it('rejects submission pages from different query states', async () => {
    const records = [
      { id: 'sub-1', emailId: 'email-1', undoStatus: 'final', sendAt: FUTURE_AT },
      { id: 'sub-2', emailId: 'email-2', undoStatus: 'pending', sendAt: FUTURE_AT },
    ];
    const t = submissionTransport(records);
    t.session = {
      capabilities: {
        'urn:ietf:params:jmap:core': {
          maxObjectsInGet: 1,
          maxObjectsInSet: 500,
        },
      },
    };
    t.handle('EmailSubmission/query', ({ position, limit }) => ({
      ids: records.slice(position, position + limit).map((record) => record.id),
      position,
      limit,
      total: records.length,
      queryState: `submissions-${position}`,
    }));

    await expect(fetchSubmissionRecords({ transport: t, account }))
      .rejects.toThrow('EmailSubmission query changed while paging');
  });
});

describe('syncSubmissionsForAccount', () => {
  it('keeps a still-pending schedule and reports it as the nearest wake-up', async () => {
    await seedScheduledMessage('e-1', { sentAt: FUTURE_AT });
    const t = submissionTransport([
      { id: 'sub-e-1', emailId: 'e-1', undoStatus: 'pending', sendAt: FUTURE_AT },
    ]);

    const result = await syncSubmissionsForAccount({ transport: t, account, handlers });

    const row = await messageRow('e-1');
    expect(row.scheduled_undo_status).toBe('pending');
    expect(result.nearestPendingAt).toBe(Date.parse(FUTURE_AT));
    expect(result.unresolvedSettled).toBe(false);
    expect(await pendingMutations()).toHaveLength(0);
  });

  it('marks a released schedule final and enqueues one move to Sent', async () => {
    const seeded = await seedScheduledMessage('e-1');
    const t = submissionTransport([
      { id: 'sub-e-1', emailId: 'e-1', undoStatus: 'final', sendAt: FUTURE_AT },
    ]);

    const result = await syncSubmissionsForAccount({ transport: t, account, handlers });

    const row = await messageRow('e-1');
    expect(row.scheduled_undo_status).toBe('final');
    expect(result.unresolvedSettled).toBe(true);

    const moves = await pendingMutations(MUTATION_TYPE.MOVE_TO_FOLDERS);
    expect(moves).toHaveLength(1);
    expect(Number(moves[0].target_message_id)).toBe(seeded.id);
    expect(JSON.parse(moves[0].request_json)).toEqual({
      messageIds: [seeded.id],
      addFolderIds: [sentFolder.id],
      removeFolderIds: [scheduledFolder.id],
    });

    // Level-based: a second pass converges without duplicating the move.
    await syncSubmissionsForAccount({ transport: t, account, handlers });
    expect(await pendingMutations(MUTATION_TYPE.MOVE_TO_FOLDERS)).toHaveLength(1);
  });

  it('never switches a tracked row to a different submission for the same Email', async () => {
    await seedScheduledMessage('e-1', { submissionId: 'sub-original' });
    const t = submissionTransport([
      {
        id: 'sub-replacement',
        emailId: 'e-1',
        undoStatus: 'pending',
        sendAt: FUTURE_AT,
      },
    ]);

    await syncSubmissionsForAccount({ transport: t, account, handlers });

    expect(await messageRow('e-1')).toMatchObject({
      scheduled_submission_remote_id: 'sub-original',
      scheduled_undo_status: 'pending',
    });
  });

  it('does not re-enqueue or poll a settled handoff that already conflicted', async () => {
    await seedScheduledMessage('e-1');
    const t = submissionTransport([
      { id: 'sub-e-1', emailId: 'e-1', undoStatus: 'final', sendAt: FUTURE_AT },
    ]);
    await syncSubmissionsForAccount({ transport: t, account, handlers });
    const [move] = await pendingMutations(MUTATION_TYPE.MOVE_TO_FOLDERS);
    await engine.run(
      "UPDATE pending_mutations SET local_status = 'conflicted' WHERE id = ?",
      [move.id],
    );

    const result = await syncSubmissionsForAccount({ transport: t, account, handlers });

    expect(await pendingMutations(MUTATION_TYPE.MOVE_TO_FOLDERS)).toHaveLength(1);
    expect(result.unresolvedSettled).toBe(false);
  });

  it('waits for mailbox sync without polling submissions when handoff folders are absent', async () => {
    await seedScheduledMessage('e-1');
    await engine.run('UPDATE folders SET is_deleted = 1 WHERE id = ?', [sentFolder.id]);
    const t = submissionTransport([
      { id: 'sub-e-1', emailId: 'e-1', undoStatus: 'final', sendAt: FUTURE_AT },
    ]);

    const missing = await syncSubmissionsForAccount({ transport: t, account, handlers });
    expect(missing.unresolvedSettled).toBe(false);
    expect(await pendingMutations(MUTATION_TYPE.MOVE_TO_FOLDERS)).toHaveLength(0);

    await engine.run('UPDATE folders SET is_deleted = 0 WHERE id = ?', [sentFolder.id]);
    const restored = await syncSubmissionsForAccount({ transport: t, account, handlers });
    expect(restored.unresolvedSettled).toBe(true);
    expect(await pendingMutations(MUTATION_TYPE.MOVE_TO_FOLDERS)).toHaveLength(1);
  });

  it('clears the scheduling columns once Sent placement is confirmed', async () => {
    const seeded = await seedScheduledMessage('e-1', { undoStatus: 'final' });
    // Simulate the durable move having landed: the message sits in Sent,
    // not Scheduled, and the record has been reaped server-side.
    await engine.run(
      'DELETE FROM folder_messages WHERE message_id = ? AND folder_id = ?',
      [seeded.id, scheduledFolder.id],
    );
    await engine.run(
      `INSERT INTO folder_messages(folder_id, message_id, account_id, added_at)
       VALUES (?, ?, ?, ?)`,
      [sentFolder.id, seeded.id, account.id, NOW],
    );
    const t = submissionTransport([]);

    const result = await syncSubmissionsForAccount({ transport: t, account, handlers });

    const row = await messageRow('e-1');
    expect(row.scheduled_undo_status).toBeNull();
    expect(row.scheduled_submission_remote_id).toBeNull();
    expect(result.unresolvedSettled).toBe(false);
    expect(await pendingMutations(MUTATION_TYPE.MOVE_TO_FOLDERS)).toHaveLength(0);
  });

  it('adopts a cancellation from another client through the durable cancel', async () => {
    const seeded = await seedScheduledMessage('e-1');
    const t = submissionTransport([
      { id: 'sub-e-1', emailId: 'e-1', undoStatus: 'canceled', sendAt: FUTURE_AT },
    ]);

    await syncSubmissionsForAccount({ transport: t, account, handlers });

    const row = await messageRow('e-1');
    expect(row.scheduled_undo_status).toBe('canceled');
    const cancels = await pendingMutations(MUTATION_TYPE.CANCEL_SCHEDULED_SEND);
    expect(cancels).toHaveLength(1);
    expect(Number(cancels[0].target_message_id)).toBe(seeded.id);

    await syncSubmissionsForAccount({ transport: t, account, handlers });
    expect(await pendingMutations(MUTATION_TYPE.CANCEL_SCHEDULED_SEND)).toHaveLength(1);
  });

  it('never guesses a vanished record: unknown after the target, pending before', async () => {
    await seedScheduledMessage('e-future', { sentAt: FUTURE_AT });
    await seedScheduledMessage('e-past', { sentAt: PAST_AT });
    const t = submissionTransport([]);

    await syncSubmissionsForAccount({ transport: t, account, handlers });

    expect((await messageRow('e-future')).scheduled_undo_status).toBe('pending');
    expect((await messageRow('e-past')).scheduled_undo_status).toBe('unknown');
  });

  it('does not re-arm a one-second poll for a visible past-due pending record', async () => {
    await seedScheduledMessage('e-past', { sentAt: PAST_AT });
    const t = submissionTransport([
      { id: 'sub-e-past', emailId: 'e-past', undoStatus: 'pending', sendAt: PAST_AT },
    ]);

    const result = await syncSubmissionsForAccount({ transport: t, account, handlers });

    expect((await messageRow('e-past')).scheduled_undo_status).toBe('pending');
    expect(result.nearestPendingAt).toBeNull();
  });

  it('preserves the conservative release observation for a just-due pending record', async () => {
    const targetAt = new Date(Date.now() - 2_000).toISOString();
    await seedScheduledMessage('e-due', { sentAt: targetAt });
    const t = submissionTransport([
      { id: 'sub-e-due', emailId: 'e-due', undoStatus: 'pending', sendAt: targetAt },
    ]);

    const result = await syncSubmissionsForAccount({ transport: t, account, handlers });

    expect(result.nearestPendingAt).toBe(Date.parse(targetAt));
  });

  it('discovers an external future schedule and caches its message', async () => {
    const t = submissionTransport(
      [
        { id: 'sub-ext', emailId: 'e-ext', undoStatus: 'pending', sendAt: FUTURE_AT },
        { id: 'sub-old', emailId: 'e-old', undoStatus: 'pending', sendAt: PAST_AT },
      ],
      { 'e-ext': emailFixture('e-ext') },
    );

    const result = await syncSubmissionsForAccount({ transport: t, account, handlers });

    const adopted = await messageRow('e-ext');
    expect(adopted).toBeTruthy();
    expect(adopted.scheduled_undo_status).toBe('pending');
    expect(adopted.scheduled_submission_remote_id).toBe('sub-ext');
    expect(result.nearestPendingAt).toBe(Date.parse(FUTURE_AT));

    // A pending record whose target already passed is not a live
    // schedule; it must not be adopted as one.
    expect(await messageRow('e-old')).toBeFalsy();
  });

  it('retries external adoption after transient mailbox discovery failure', async () => {
    // No local role folder yet, so adoption has to discover it on the server.
    await engine.run('DELETE FROM folders WHERE id = ?', [scheduledFolder.id]);
    const t = submissionTransport(
      [{ id: 'sub-ext', emailId: 'e-ext', undoStatus: 'pending', sendAt: FUTURE_AT }],
      { 'e-ext': emailFixture('e-ext') },
    );
    t.handle('Mailbox/query', () => mailboxPage(['mb-sched']));
    t.handle('Mailbox/get', () => {
      throw new Error('offline');
    });

    await expect(syncSubmissionsForAccount({
      transport: t,
      account,
      handlers,
    })).rejects.toThrow('offline');
    expect(await messageRow('e-ext')).toBeFalsy();

    t.handle('Mailbox/get', (params) => ({
      list: (params.ids ?? []).map((id) => ({
        id,
        name: 'Scheduled',
        parentId: null,
        role: 'scheduled',
        isSubscribed: true,
      })),
      notFound: [],
      state: 'mg-recovered',
    }));
    await syncSubmissionsForAccount({ transport: t, account, handlers });
    expect(await messageRow('e-ext')).toMatchObject({
      scheduled_submission_remote_id: 'sub-ext',
      scheduled_undo_status: 'pending',
    });
    expect(await folderRow('mb-sched')).toMatchObject({ role: 'scheduled' });
  });

  it('chunks external Email reads to the advertised get limit', async () => {
    const records = Array.from({ length: 5 }, (_, index) => ({
      id: `sub-ext-${index}`,
      emailId: `e-ext-${index}`,
      undoStatus: 'pending',
      sendAt: FUTURE_AT,
    }));
    const emails = Object.fromEntries(records.map((record) => [
      record.emailId,
      emailFixture(record.emailId),
    ]));
    const t = submissionTransport(records, emails);
    t.session = {
      capabilities: {
        'urn:ietf:params:jmap:core': { maxObjectsInGet: 2 },
      },
    };

    await syncSubmissionsForAccount({ transport: t, account, handlers });

    const gets = t.requests
      .flatMap((request) => request.methodCalls)
      .filter(([name]) => name === 'Email/get');
    expect(gets.map(([, params]) => params.ids.length)).toEqual([2, 2, 1]);
    for (const record of records) {
      expect(await messageRow(record.emailId)).toMatchObject({
        scheduled_submission_remote_id: record.id,
      });
    }
  });

  it('leaves other accounts untouched', async () => {
    const other = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'O',
      primaryEmail: 'o@example.com',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'acct-2',
      isPrimary: false,
    })).row;
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: other.id,
      folders: [{ remoteId: 'mb-sched-2', name: 'Scheduled', role: 'scheduled' }],
    });
    const otherFolder = await engine.get(
      'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
      [other.id, 'mb-sched-2'],
    );
    const t2 = new MockTransport();
    t2.handle('Email/query', () => ({
      ids: ['e-o'], total: 1, queryState: 'qso', canCalculateChanges: true, position: 0,
    }));
    t2.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailFixture(id, { mailbox: 'mb-sched-2' })),
      state: 'eso',
    }));
    await syncFolderWindow({ transport: t2, account: other, folder: otherFolder, handlers });
    await handlers[DB_RPC.MESSAGE_SET_SCHEDULED]({
      accountId: other.id,
      emailRemoteId: 'e-o',
      submissionRemoteId: 'sub-o',
      undoStatus: 'pending',
    });

    await seedScheduledMessage('e-1');
    const t = submissionTransport([
      { id: 'sub-e-1', emailId: 'e-1', undoStatus: 'canceled', sendAt: FUTURE_AT },
    ]);
    await syncSubmissionsForAccount({ transport: t, account, handlers });

    const otherRow = await messageRow('e-o', other.id);
    expect(otherRow.scheduled_undo_status).toBe('pending');
    const otherMutations = await engine.all(
      'SELECT * FROM pending_mutations WHERE account_id = ?',
      [other.id],
    );
    expect(otherMutations).toHaveLength(0);
  });
});

describe('ensureScheduledMailbox', () => {
  /** Mailboxes the mock server holds, keyed by id; the query handlers filter them. */
  function serverMailboxes(mailboxes: any[]) {
    const t = new MockTransport();
    t.handle('Mailbox/query', ({ filter }) => mailboxPage(
      mailboxes
        .filter((mailbox) => (
          filter?.role != null ? mailbox.role === filter.role : mailbox.name === filter?.name
        ))
        .map((mailbox) => mailbox.id),
    ));
    t.handle('Mailbox/get', ({ ids }) => ({
      list: mailboxes.filter((mailbox) => ids.includes(mailbox.id)),
      notFound: [],
      state: 'mg',
    }));
    return t;
  }

  function mailboxSets(t: MockTransport) {
    return t.requests
      .flatMap((request) => request.methodCalls)
      .filter(([method]) => method === 'Mailbox/set')
      .map(([, params]) => params);
  }

  it('returns the local role folder without contacting the server', async () => {
    await engine.run(
      `UPDATE folders
          SET total_emails = 7, unread_emails = 3, sort_order = 9,
              rights_json = '{"mayReadItems":true}', raw_json = '{"id":"mb-sched"}'
        WHERE id = ?`,
      [scheduledFolder.id],
    );
    const t = new MockTransport();

    await expect(ensureScheduledMailbox({ transport: t, account, handlers }))
      .resolves.toBe('mb-sched');

    expect(t.requests).toEqual([]);
    expect(await engine.get('SELECT * FROM folders WHERE id = ?', [scheduledFolder.id]))
      .toMatchObject({
        total_emails: 7,
        unread_emails: 3,
        sort_order: 9,
        rights_json: '{"mayReadItems":true}',
        raw_json: '{"id":"mb-sched"}',
      });
  });

  it('adopts the server role folder and mirrors it locally', async () => {
    await engine.run('DELETE FROM folders WHERE id = ?', [scheduledFolder.id]);
    const t = serverMailboxes([
      { id: 'mb-role', name: 'Later', parentId: null, role: 'scheduled', isSubscribed: false },
    ]);

    await expect(ensureScheduledMailbox({ transport: t, account, handlers }))
      .resolves.toBe('mb-role');

    expect(mailboxSets(t)).toEqual([]);
    expect(await folderRow('mb-role')).toMatchObject({
      role: 'scheduled',
      parent_id: null,
      is_subscribed: 0,
      is_deleted: 0,
    });
  });

  it('creates the mailbox with the scheduled role when the account has none', async () => {
    await engine.run('DELETE FROM folders WHERE id = ?', [scheduledFolder.id]);
    const t = serverMailboxes([]);
    t.handle('Mailbox/set', () => ({
      created: { 'stormbox-scheduled': { id: 'mb-created' } },
      newState: 'ms-created',
    }));

    await expect(ensureScheduledMailbox({ transport: t, account, handlers }))
      .resolves.toBe('mb-created');

    expect(mailboxSets(t)).toEqual([{
      accountId: account.remote_account_id,
      create: {
        'stormbox-scheduled': {
          name: 'Scheduled',
          role: 'scheduled',
          parentId: null,
          isSubscribed: true,
        },
      },
    }]);
    expect(await folderRow('mb-created')).toMatchObject({
      name: 'Scheduled',
      role: 'scheduled',
      is_subscribed: 1,
    });
  });

  it('adopts a roleless top-level Scheduled mailbox by setting its role', async () => {
    await engine.run('DELETE FROM folders WHERE id = ?', [scheduledFolder.id]);
    const t = serverMailboxes([
      { id: 'mb-legacy', name: 'Scheduled', parentId: null, role: null, isSubscribed: true },
    ]);
    t.handle('Mailbox/set', ({ update }) => ({
      updated: Object.fromEntries(Object.keys(update ?? {}).map((id) => [id, null])),
      newState: 'ms-adopted',
    }));

    await expect(ensureScheduledMailbox({ transport: t, account, handlers }))
      .resolves.toBe('mb-legacy');

    expect(mailboxSets(t)).toEqual([{
      accountId: account.remote_account_id,
      update: { 'mb-legacy': { role: 'scheduled' } },
    }]);
    expect(await folderRow('mb-legacy')).toMatchObject({ role: 'scheduled', is_subscribed: 1 });
  });

  it('adopts the winner of a lost creation race', async () => {
    await engine.run('DELETE FROM folders WHERE id = ?', [scheduledFolder.id]);
    const mailboxes: any[] = [];
    const t = serverMailboxes(mailboxes);
    t.handle('Mailbox/set', () => {
      mailboxes.push({
        id: 'mb-raced', name: 'Scheduled', parentId: null, role: 'scheduled', isSubscribed: true,
      });
      return {
        notCreated: { 'stormbox-scheduled': { type: 'invalidProperties' } },
        newState: 'ms-raced',
      };
    });

    await expect(ensureScheduledMailbox({ transport: t, account, handlers }))
      .resolves.toBe('mb-raced');
    expect(await folderRow('mb-raced')).toMatchObject({ role: 'scheduled' });
  });

  it('reports a top-level Scheduled mailbox with another role as a terminal conflict', async () => {
    await engine.run('DELETE FROM folders WHERE id = ?', [scheduledFolder.id]);
    const t = serverMailboxes([
      { id: 'mb-other', name: 'Scheduled', parentId: null, role: 'archive', isSubscribed: true },
    ]);

    await expect(ensureScheduledMailbox({ transport: t, account, handlers }))
      .rejects.toMatchObject({ type: 'scheduledMailboxConflict', terminal: true });
    expect(mailboxSets(t)).toEqual([]);
    expect(await folderRow('mb-other')).toBeFalsy();
  });

  it('pages past nested name matches before adopting the roleless mailbox', async () => {
    await engine.run('DELETE FROM folders WHERE id = ?', [scheduledFolder.id]);
    const mailboxes = [
      {
        id: 'mb-nested',
        name: 'Scheduled',
        parentId: 'mb-parent',
        role: null,
        isSubscribed: true,
      },
      {
        id: 'mb-managed',
        name: 'Scheduled',
        parentId: null,
        role: null,
        isSubscribed: true,
      },
    ];
    const t = new MockTransport({
      capabilities: {
        'urn:ietf:params:jmap:core': {
          maxObjectsInGet: 1,
          maxObjectsInSet: 500,
        },
      },
    });
    t.handle('Mailbox/query', ({ filter, position }) => (
      filter?.role != null
        ? mailboxPage([])
        : {
            ids: mailboxes.slice(position, position + 1).map((mailbox) => mailbox.id),
            position,
            limit: 1,
            total: mailboxes.length,
            queryState: 'mailboxes-1',
          }
    ));
    t.handle('Mailbox/get', ({ ids }) => ({
      list: mailboxes.filter((mailbox) => ids.includes(mailbox.id)),
      notFound: [],
      state: 'mailboxes-state-1',
    }));
    t.handle('Mailbox/set', () => ({
      updated: { 'mb-managed': null },
      newState: 'ms-adopted',
    }));

    await expect(ensureScheduledMailbox({
      transport: t,
      account,
      handlers,
    })).resolves.toBe('mb-managed');

    const positions = t.requests
      .flatMap((request) => request.methodCalls)
      .filter(([method, params]) => method === 'Mailbox/query' && params.filter?.name)
      .map(([, params]) => params.position);
    expect(positions).toEqual([0, 1]);
  });
});
