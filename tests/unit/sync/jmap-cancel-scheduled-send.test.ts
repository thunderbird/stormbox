/**
 * Durable cancel-scheduled-send tests: the portable two-call revoke +
 * restore sequence, idempotency (duplicate cancels, already-canceled
 * records), the release-vs-cancel race, and the conservative handling
 * of submissions the server no longer shows.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { runCancelScheduledSend } from '../../../src/sync/backends/jmap/outbox/operations/cancel-scheduled-send';
import { syncFolderWindow } from '../../../src/sync/backends/jmap/messages';
import { MockTransport } from './_mock-transport';

const NOW = Date.now();
const FUTURE_AT = new Date(NOW + 60 * 60_000).toISOString();
const PAST_AT = new Date(NOW - 60 * 60_000).toISOString();

let engine;
let handlers;
let account;
let scheduledFolder;
let draftsFolder;
let sentFolder;
let message;

function emailFixture(id: string, {
  sentAt = FUTURE_AT,
  mailboxIds = { 'mb-sched': true } as Record<string, boolean>,
  keywords = { $seen: true } as Record<string, boolean>,
} = {}) {
  return {
    id,
    blobId: `b-${id}`,
    threadId: `t-${id}`,
    mailboxIds,
    keywords,
    size: 1,
    receivedAt: new Date(NOW).toISOString(),
    sentAt,
    messageId: [`<${id}@example.com>`],
    from: [{ email: 'me@example.com' }],
    to: [{ email: 'rcpt@example.com' }],
    subject: `s-${id}`,
    preview: 'p',
    hasAttachment: false,
  };
}

/**
 * Transport for a full happy-path cancel: submission reads, the revoke,
 * the restore, and the closing cache reconcile (an Email/get that shows
 * the message back in Drafts).
 */
function cancelTransport({
  records = [],
  submissionSet = () => ({ updated: { } }),
  emailSet = () => ({ updated: { } }),
  emailAfter = (id: string) => emailFixture(id, {
    mailboxIds: { 'mb-drafts': true },
    keywords: { $draft: true, $seen: true },
  }),
}: any = {}) {
  const t = new MockTransport();
  const calls: Record<string, any[]> = {
    submissionSet: [], emailSet: [], emailGet: [],
  };
  t.handle('EmailSubmission/query', () => ({
    ids: records.map((r) => r.id),
    position: 0,
    total: records.length,
    canCalculateChanges: false,
    queryState: 'subq-state',
  }));
  t.handle('EmailSubmission/get', (params) => ({
    list: records.filter((r) => (params.ids ?? []).includes(r.id)),
    notFound: [],
    state: 'subg-state',
  }));
  t.handle('EmailSubmission/set', (params) => {
    calls.submissionSet.push(params);
    return submissionSet(params);
  });
  t.handle('Email/set', (params) => {
    calls.emailSet.push(params);
    return emailSet(params);
  });
  t.handle('Email/get', (params) => {
    calls.emailGet.push(params);
    return {
      list: (params.ids ?? []).map((id) => emailAfter(id)).filter(Boolean),
      notFound: (params.ids ?? []).filter((id) => !emailAfter(id)),
      state: 'eg-state',
    };
  });
  return { transport: t, calls };
}

async function seedScheduledMessage({
  sentAt = FUTURE_AT,
  submissionId = 'sub-1',
  undoStatus = 'pending',
}: any = {}) {
  const t = new MockTransport();
  t.handle('Email/query', () => ({
    ids: ['e-1'], total: 1, queryState: 'qs', canCalculateChanges: true, position: 0,
  }));
  t.handle('Email/get', (params) => ({
    list: params.ids.map((id) => emailFixture(id, { sentAt })),
    state: 'es',
  }));
  await syncFolderWindow({ transport: t, account, folder: scheduledFolder, handlers });
  await handlers[DB_RPC.MESSAGE_SET_SCHEDULED]({
    accountId: account.id,
    emailRemoteId: 'e-1',
    submissionRemoteId: submissionId,
    undoStatus,
  });
  return engine.get(
    'SELECT * FROM messages WHERE account_id = ? AND remote_id = ?',
    [account.id, 'e-1'],
  );
}

async function runCancel(transport: any) {
  return runCancelScheduledSend({
    transport,
    account,
    handlers,
    row: { target_message_id: message.id },
    request: { messageId: message.id },
    useWebSocket: false,
  });
}

async function refreshedMessage() {
  return engine.get('SELECT * FROM messages WHERE id = ?', [message.id]);
}

beforeEach(async () => {
  engine = await bootTestEngine();
  handlers = makeHandlers(engine);
  account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
    displayName: 'T',
    primaryEmail: 't@example.com',
    serverOrigin: 'https://mail.example.com',
    remoteAccountId: 'acct-1',
    isPrimary: true,
  })).row;
  await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
    accountId: account.id,
    folders: [
      { remoteId: 'mb-drafts', name: 'Drafts', role: 'drafts', sortOrder: 1 },
      { remoteId: 'mb-sent', name: 'Sent', role: 'sent', sortOrder: 2 },
      { remoteId: 'mb-sched', name: 'Scheduled', role: null, sortOrder: 3, isSubscribed: true },
    ],
  });
  await handlers[DB_RPC.SETTINGS_APPLY_PATCH]({
    accountId: account.id,
    patch: { scheduledMailboxRemoteId: 'mb-sched' },
  });
  scheduledFolder = await engine.get(
    'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
    [account.id, 'mb-sched'],
  );
  draftsFolder = await engine.get(
    'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
    [account.id, 'mb-drafts'],
  );
  sentFolder = await engine.get(
    'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
    [account.id, 'mb-sent'],
  );
  message = await seedScheduledMessage();
});

afterEach(async () => {
  await engine.close();
});

describe('runCancelScheduledSend', () => {
  it('revokes the pending submission and restores the draft', async () => {
    const { transport, calls } = cancelTransport({
      records: [{ id: 'sub-1', emailId: 'e-1', undoStatus: 'pending', sendAt: FUTURE_AT }],
    });

    const result = await runCancel(transport);

    expect(result.ok).toBe(true);
    expect(calls.submissionSet).toHaveLength(1);
    expect(calls.submissionSet[0].update['sub-1']).toEqual({ undoStatus: 'canceled' });

    expect(calls.emailSet).toHaveLength(1);
    const patch = calls.emailSet[0].update['e-1'];
    expect(patch['mailboxIds/mb-drafts']).toBe(true);
    expect(patch['mailboxIds/mb-sched']).toBeNull();
    expect(patch['keywords/$draft']).toBe(true);

    const row = await refreshedMessage();
    expect(row.scheduled_undo_status).toBeNull();
    expect(row.scheduled_submission_remote_id).toBeNull();
    const placements = await engine.all(
      'SELECT folder_id FROM folder_messages WHERE message_id = ?',
      [message.id],
    );
    expect(placements.map((p) => Number(p.folder_id))).toEqual([draftsFolder.id]);
  });

  it('skips the revoke but still restores when another client already canceled', async () => {
    const { transport, calls } = cancelTransport({
      records: [{ id: 'sub-1', emailId: 'e-1', undoStatus: 'canceled', sendAt: FUTURE_AT }],
    });

    const result = await runCancel(transport);

    expect(result.ok).toBe(true);
    expect(calls.submissionSet).toHaveLength(0);
    expect(calls.emailSet).toHaveLength(1);
    expect((await refreshedMessage()).scheduled_undo_status).toBeNull();
  });

  it('revokes a known submission whose undo status is unreadable', async () => {
    const { transport, calls } = cancelTransport({
      records: [{ id: 'sub-1', emailId: 'e-1', undoStatus: 'held', sendAt: FUTURE_AT }],
    });

    const result = await runCancel(transport);

    expect(result.ok).toBe(true);
    expect(calls.submissionSet).toHaveLength(1);
    expect(calls.submissionSet[0].update['sub-1']).toEqual({ undoStatus: 'canceled' });
    expect(calls.emailSet).toHaveLength(1);
    expect((await refreshedMessage()).scheduled_undo_status).toBeNull();
  });

  it('is a no-op when cleared columns are confirmed by Drafts placement', async () => {
    await engine.run(
      'DELETE FROM folder_messages WHERE message_id = ?',
      [message.id],
    );
    await engine.run(
      `INSERT INTO folder_messages(folder_id, message_id, account_id, added_at)
       VALUES (?, ?, ?, ?)`,
      [draftsFolder.id, message.id, account.id, NOW],
    );
    await handlers[DB_RPC.MESSAGE_SET_SCHEDULED]({
      accountId: account.id,
      emailRemoteId: 'e-1',
      submissionRemoteId: null,
      undoStatus: null,
    });
    const { transport, calls } = cancelTransport({});

    const result = await runCancel(transport);

    expect(result.ok).toBe(true);
    expect(calls.submissionSet).toHaveLength(0);
    expect(calls.emailSet).toHaveLength(0);
  });

  it('does not report cancellation after cleared columns resolve to Sent', async () => {
    await engine.run(
      'DELETE FROM folder_messages WHERE message_id = ?',
      [message.id],
    );
    await engine.run(
      `INSERT INTO folder_messages(folder_id, message_id, account_id, added_at)
       VALUES (?, ?, ?, ?)`,
      [sentFolder.id, message.id, account.id, NOW],
    );
    await handlers[DB_RPC.MESSAGE_SET_SCHEDULED]({
      accountId: account.id,
      emailRemoteId: 'e-1',
      submissionRemoteId: null,
      undoStatus: null,
    });
    const { transport, calls } = cancelTransport({});

    const result = await runCancel(transport);

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      type: 'scheduleAlreadySent',
      terminal: true,
    });
    expect(calls.submissionSet).toHaveLength(0);
    expect(calls.emailSet).toHaveLength(0);
  });

  it('reports a released schedule as terminally too late', async () => {
    const { transport, calls } = cancelTransport({
      records: [{ id: 'sub-1', emailId: 'e-1', undoStatus: 'final', sendAt: FUTURE_AT }],
    });

    const result = await runCancel(transport);

    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('scheduleAlreadySent');
    expect(result.error.terminal).toBe(true);
    expect(calls.submissionSet).toHaveLength(0);
    expect(calls.emailSet).toHaveLength(0);
    // The submission sync files the released message from this status.
    expect((await refreshedMessage()).scheduled_undo_status).toBe('final');
  });

  it('retries when a release races the revoke (notUpdated)', async () => {
    const { transport } = cancelTransport({
      records: [{ id: 'sub-1', emailId: 'e-1', undoStatus: 'pending', sendAt: FUTURE_AT }],
      submissionSet: () => ({
        notUpdated: { 'sub-1': { type: 'cannotUnsend', description: 'already sent' } },
      }),
    });

    const result = await runCancel(transport);

    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('cancelRejected');
    expect(result.error.terminal).toBeUndefined();
    // Nothing resolved: the row still awaits the definitive re-read.
    expect((await refreshedMessage()).scheduled_undo_status).toBe('pending');
  });

  it('retries a vanished record while the target is still in the future', async () => {
    const { transport, calls } = cancelTransport({ records: [] });

    const result = await runCancel(transport);

    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('submissionMissing');
    expect(result.error.terminal).toBeUndefined();
    expect(calls.emailSet).toHaveLength(0);
    expect((await refreshedMessage()).scheduled_undo_status).toBe('pending');
  });

  it('does not revoke a replacement submission for the same Email', async () => {
    const { transport, calls } = cancelTransport({
      records: [{
        id: 'sub-replacement',
        emailId: 'e-1',
        undoStatus: 'pending',
        sendAt: FUTURE_AT,
      }],
    });

    const result = await runCancel(transport);

    expect(result).toMatchObject({
      ok: false,
      error: { type: 'submissionMissing' },
    });
    expect(calls.submissionSet).toHaveLength(0);
    expect(calls.emailSet).toHaveLength(0);
  });

  it('resolves a vanished record after the target as unknown, never a guess', async () => {
    await engine.close();
    engine = await bootTestEngine();
    handlers = makeHandlers(engine);
    account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'T',
      primaryEmail: 't@example.com',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'acct-1',
      isPrimary: true,
    })).row;
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [
        { remoteId: 'mb-drafts', name: 'Drafts', role: 'drafts' },
        { remoteId: 'mb-sched', name: 'Scheduled', role: null, isSubscribed: true },
      ],
    });
    await handlers[DB_RPC.SETTINGS_APPLY_PATCH]({
      accountId: account.id,
      patch: { scheduledMailboxRemoteId: 'mb-sched' },
    });
    scheduledFolder = await engine.get(
      'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
      [account.id, 'mb-sched'],
    );
    message = await seedScheduledMessage({ sentAt: PAST_AT });

    const { transport, calls } = cancelTransport({ records: [] });
    const result = await runCancel(transport);

    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('scheduleStateUnknown');
    expect(result.error.terminal).toBe(true);
    expect(calls.emailSet).toHaveLength(0);
    expect((await refreshedMessage()).scheduled_undo_status).toBe('unknown');
  });

  it('treats success as cancel done even when the Email is gone from the server', async () => {
    const { transport } = cancelTransport({
      records: [{ id: 'sub-1', emailId: 'e-1', undoStatus: 'pending', sendAt: FUTURE_AT }],
      emailSet: () => ({ notUpdated: { 'e-1': { type: 'notFound' } } }),
      emailAfter: () => null,
    });

    const result = await runCancel(transport);

    expect(result.ok).toBe(true);
    // Reconciliation applied the destroy locally.
    expect(await refreshedMessage()).toBeFalsy();
  });

  it('holds success back until the cache reconcile succeeds', async () => {
    const { transport } = cancelTransport({
      records: [{ id: 'sub-1', emailId: 'e-1', undoStatus: 'pending', sendAt: FUTURE_AT }],
    });
    transport.handle('Email/get', () => {
      throw new Error('boom');
    });

    const result = await runCancel(transport);

    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('cacheReconcileFailed');
    // Not cleared: the retry must repeat the idempotent resolution.
    expect((await refreshedMessage()).scheduled_undo_status).toBe('pending');
  });
});
