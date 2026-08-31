/**
 * Send Later trigger surface on the backend: submission-sync passes are
 * single-flight with a trailing re-run, the account-level wake timer is
 * armed from each pass's nearest pending sendAt (and torn down on
 * stop), opening the Scheduled mailbox triggers a pass while other
 * folders do not, and EmailSubmission or mailbox StateChanges dispatch
 * one when server state needed for a handoff changes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { JmapBackend } from '../../../src/sync/backends/jmap/backend';
import { syncFolderWindow } from '../../../src/sync/backends/jmap/messages';
import { MockTransport } from './_mock-transport';

let engine;
let handlers;
let account;
let backend;
let transport;
let queryGate: { resolve: () => void } | null;

function submissionQueryCount() {
  return transport.requests
    .flatMap((r) => r.methodCalls)
    .filter(([name]) => name === 'EmailSubmission/query')
    .length;
}

function makeBackend() {
  const b = new JmapBackend({
    transport,
    serverOrigin: 'https://mail.example.com',
    handlers,
    options: { useWebSocket: false },
  });
  b.account = account;
  b._started = true;
  return b;
}

async function seedTrackedSchedule(remoteId = 'e-tracked') {
  await handlers[DB_RPC.THREAD_UPSERT_MANY]({
    accountId: account.id,
    threads: [{ remoteId: `t-${remoteId}` }],
  });
  const [thread] = await handlers[DB_RPC.QUERY]({
    sql: 'SELECT id FROM threads WHERE account_id = ? AND remote_id = ?',
    params: [account.id, `t-${remoteId}`],
  });
  await handlers[DB_RPC.MESSAGE_UPSERT_MANY]({
    accountId: account.id,
    messages: [{
      remoteId,
      threadId: thread.id,
      remoteThreadId: `t-${remoteId}`,
      subject: 'scheduled',
      preview: '',
      receivedAt: Date.now(),
      sentAt: Date.now() + 60_000,
      hasAttachment: false,
      keywordsJson: '{}',
      keywords: [],
      isSeen: true,
      isFlagged: false,
      isAnswered: false,
      isDraft: false,
      isForwarded: false,
      isJunk: false,
      addresses: [],
    }],
  });
  await handlers[DB_RPC.MESSAGE_SET_SCHEDULED]({
    accountId: account.id,
    emailRemoteId: remoteId,
    submissionRemoteId: `sub-${remoteId}`,
    undoStatus: 'pending',
  });
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
      { remoteId: 'mb-inbox', name: 'Inbox', role: 'inbox' },
      { remoteId: 'mb-sched', name: 'Scheduled', role: null, isSubscribed: true },
    ],
  });
  await handlers[DB_RPC.SETTINGS_APPLY_PATCH]({
    accountId: account.id,
    patch: { scheduledMailboxRemoteId: 'mb-sched' },
  });

  queryGate = null;
  transport = new MockTransport();
  transport.handle('EmailSubmission/query', async () => {
    if (queryGate) {
      await new Promise<void>((resolve) => { queryGate = { resolve }; });
    }
    return {
      ids: [], position: 0, total: 0, canCalculateChanges: false, queryState: 'sq',
    };
  });
  transport.handle('EmailSubmission/get', () => ({ list: [], notFound: [], state: 'sg' }));

  backend = makeBackend();
});

afterEach(async () => {
  backend._started = false;
  if (backend._submissionWakeTimer) clearTimeout(backend._submissionWakeTimer);
  vi.useRealTimers();
  await engine.close();
});

describe('submission sync triggers', () => {
  it('collapses concurrent triggers into one pass plus one trailing re-run', async () => {
    // Hold the first pass open while two more triggers arrive.
    queryGate = { resolve: () => {} };
    const first = backend._syncSubmissions();
    const second = backend._syncSubmissions();
    const third = backend._syncSubmissions();
    expect(second).toBe(first);
    expect(third).toBe(first);

    await vi.waitFor(() => {
      if (!queryGate || typeof queryGate.resolve !== 'function') throw new Error('not yet');
    });
    const gate = queryGate;
    queryGate = null;
    gate.resolve();
    await first;

    // One initial pass, one trailing re-run for the queued triggers.
    expect(submissionQueryCount()).toBe(2);
  });

  it('arms the wake timer from the nearest pending sendAt and clears it on stop', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T12:00:00Z'));
    const sendAtMs = Date.now() + 60_000;
    const t = new MockTransport();
    t.handle('Email/query', () => ({
      ids: ['e-1'], total: 1, queryState: 'qs', canCalculateChanges: true, position: 0,
    }));
    t.handle('Email/get', (params) => ({
      list: params.ids.map((id) => ({
        id,
        blobId: `b-${id}`,
        threadId: `t-${id}`,
        mailboxIds: { 'mb-sched': true },
        keywords: { $seen: true },
        size: 1,
        receivedAt: new Date().toISOString(),
        sentAt: new Date(sendAtMs).toISOString(),
        messageId: [`<${id}@example.com>`],
        from: [{ email: 'me@example.com' }],
        subject: 's',
      })),
      state: 'es',
    }));
    const scheduledFolder = await engine.get(
      "SELECT * FROM folders WHERE account_id = ? AND remote_id = 'mb-sched'",
      [account.id],
    );
    await syncFolderWindow({ transport: t, account, folder: scheduledFolder, handlers });
    await handlers[DB_RPC.MESSAGE_SET_SCHEDULED]({
      accountId: account.id,
      emailRemoteId: 'e-1',
      submissionRemoteId: 'sub-1',
      undoStatus: 'pending',
    });
    // The pending record keeps the row pending and the wake armed.
    transport.handle('EmailSubmission/query', () => ({
      ids: ['sub-1'], position: 0, total: 1, canCalculateChanges: false, queryState: 'sq',
    }));
    transport.handle('EmailSubmission/get', () => ({
      list: [{
        id: 'sub-1',
        emailId: 'e-1',
        undoStatus: 'pending',
        sendAt: new Date(sendAtMs).toISOString(),
      }],
      notFound: [],
      state: 'sg',
    }));

    await backend._syncSubmissions();
    expect(backend._submissionWakeTimer).not.toBeNull();

    const before = submissionQueryCount();
    await vi.advanceTimersByTimeAsync(62_000);
    expect(submissionQueryCount()).toBe(before);
    await backend._syncSubmissions();
    const afterIntermediateSync = submissionQueryCount();
    await vi.advanceTimersByTimeAsync(32_000);
    expect(submissionQueryCount()).toBeGreaterThan(afterIntermediateSync);

    // stop() tears the timer down (mirrored here without the full
    // start()/stop() lifecycle, which this test never ran).
    backend._armSubmissionWake(Date.now() + 60_000);
    expect(backend._submissionWakeTimer).not.toBeNull();
    backend._started = false;
    backend._armSubmissionWake(Date.now() + 60_000);
    expect(backend._submissionWakeTimer).toBeNull();
  });

  it('re-arms a bounded retry when a wake-up sync fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T12:00:00Z'));
    let attempts = 0;
    transport.handle('EmailSubmission/query', () => {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
      return {
        ids: [],
        position: 0,
        total: 0,
        canCalculateChanges: false,
        queryState: 'sq-recovered',
      };
    });

    backend._armSubmissionWake(Date.now());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(attempts).toBe(1);
    expect(backend._submissionWakeTimer).not.toBeNull();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(attempts).toBe(2);
    expect(backend._submissionWakeTimer).toBeNull();
  });

  it('backs off repeated submission-sync failures', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T12:00:00Z'));
    let attempts = 0;
    transport.handle('EmailSubmission/query', () => {
      attempts += 1;
      throw new Error('offline');
    });

    backend._armSubmissionWake(Date.now());
    await vi.advanceTimersByTimeAsync(1_100);
    expect(attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(15_100);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(attempts).toBe(3);
  });

  it('uses the canonical ascending sentAt view for Scheduled indexing', async () => {
    const scheduledFolder = await engine.get(
      "SELECT * FROM folders WHERE account_id = ? AND remote_id = 'mb-sched'",
      [account.id],
    );
    const filterJson = JSON.stringify({ inMailbox: 'mb-sched' });
    const sortJson = JSON.stringify([{ property: 'sentAt', isAscending: true }]);
    const now = Date.now();
    await engine.run(
      `INSERT INTO query_views(
         account_id, view_type, folder_id, filter_json, sort_json,
         collapse_threads, total, created_at, updated_at, last_accessed_at
       ) VALUES (?, 'mailbox-window', ?, ?, ?, 0, 2, ?, ?, ?)`,
      [account.id, scheduledFolder.id, filterJson, sortJson, now, now, now],
    );

    await expect(backend._defaultSortFor(scheduledFolder)).resolves.toEqual({
      sortProp: 'sentAt',
      sortAscending: true,
    });
    await expect(backend._queryViewProgress(scheduledFolder)).resolves.toMatchObject({
      total: 2,
      covered: 0,
    });
  });

  it('opening the Scheduled mailbox triggers a pass; other folders do not', async () => {
    const scheduledFolder = await engine.get(
      "SELECT * FROM folders WHERE account_id = ? AND remote_id = 'mb-sched'",
      [account.id],
    );
    const inboxFolder = await engine.get(
      "SELECT * FROM folders WHERE account_id = ? AND remote_id = 'mb-inbox'",
      [account.id],
    );

    backend._maybeSyncSubmissionsForFolder(inboxFolder);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(submissionQueryCount()).toBe(0);

    backend._maybeSyncSubmissionsForFolder(scheduledFolder);
    await vi.waitFor(() => {
      expect(submissionQueryCount()).toBe(1);
    });
  });

  it('retries after a Scheduled-folder-open sync fails', async () => {
    const scheduledFolder = await engine.get(
      "SELECT * FROM folders WHERE account_id = ? AND remote_id = 'mb-sched'",
      [account.id],
    );
    transport.handle('EmailSubmission/query', () => {
      throw new Error('offline');
    });

    backend._maybeSyncSubmissionsForFolder(scheduledFolder);
    await vi.waitFor(() => {
      expect(backend._submissionWakeTimer).not.toBeNull();
    });
  });

  it('an EmailSubmission StateChange dispatches a pass', async () => {
    backend._accountsByRemoteId.set('acct-1', account);
    backend._onStateChange({
      changed: { 'acct-1': { EmailSubmission: 'state-1' } },
    });
    await vi.waitFor(() => {
      expect(submissionQueryCount()).toBeGreaterThan(0);
    });
  });

  it('a Mailbox StateChange retries settled handoffs after folders synchronize', async () => {
    await seedTrackedSchedule();
    transport.handle('Mailbox/get', () => ({
      list: [
        {
          id: 'mb-inbox',
          name: 'Inbox',
          role: 'inbox',
          parentId: null,
          isSubscribed: true,
        },
        {
          id: 'mb-sched',
          name: 'Scheduled',
          role: null,
          parentId: null,
          isSubscribed: true,
        },
        {
          id: 'mb-archive',
          name: 'Archive',
          role: 'archive',
          parentId: null,
          isSubscribed: true,
        },
      ],
      notFound: [],
      state: 'mailboxes-2',
    }));

    await expect(backend._syncAccountStateChange(account, {
      Mailbox: 'mailboxes-2',
    })).resolves.toEqual({});
    await vi.waitFor(() => {
      expect(submissionQueryCount()).toBe(1);
    });
  });

  it('does not read submissions for ordinary Mailbox changes without tracked schedules', async () => {
    transport.handle('Mailbox/get', () => ({
      list: [{
        id: 'mb-inbox',
        name: 'Inbox',
        role: 'inbox',
        parentId: null,
        isSubscribed: true,
      }],
      notFound: [],
      state: 'mailboxes-2',
    }));

    await backend._syncAccountStateChange(account, { Mailbox: 'mailboxes-2' });
    expect(submissionQueryCount()).toBe(0);
  });
});
