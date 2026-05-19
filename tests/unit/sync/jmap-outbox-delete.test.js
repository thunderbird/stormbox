/**
 * End-to-end coverage for delete + move-to-Trash through the outbox,
 * proving the cache invariant: after a successful Email/set, the local
 * SQLite state matches what the server now reports, without waiting
 * for a StateChange push.
 *
 * Why this file exists: the mocked-store tests in
 * tests/unit/stores/mail-store.test.js could only prove that the store
 * called drainOutbox; they had no visibility into folder_messages,
 * query_view_items, or query_views.total. The bug we are fixing was
 * exactly the gap between "outbox completed" and "cache reflects the
 * new server state", so the regression coverage must live at the
 * outbox + handlers + engine layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory.js';
import { makeHandlers } from '../../../src/db/handlers.js';
import { DB_RPC } from '../../../src/db/protocol.js';
import { drainOutbox, MUTATION_TYPES } from '../../../src/sync/backends/jmap/outbox.js';
import { syncMailboxes } from '../../../src/sync/backends/jmap/mailboxes.js';
import { syncFolderWindow } from '../../../src/sync/backends/jmap/messages.js';
import { MockTransport } from './_mock-transport.js';

const NOW = Date.parse('2026-05-01T12:00:00Z');

function emailFixture(id, { mailboxIds = { 'mb-inbox': true } } = {}) {
  return {
    id,
    blobId: `b-${id}`,
    threadId: `t-${id}`,
    mailboxIds,
    keywords: {},
    size: 1,
    receivedAt: new Date(NOW).toISOString(),
    sentAt: new Date(NOW).toISOString(),
    messageId: [`<${id}@example.com>`],
    from: [{ email: 'from@example.com' }],
    to: [{ email: 'to@example.com' }],
    sender: [{ email: 'sender@example.com' }],
    subject: `subject ${id}`,
    preview: 'p',
    hasAttachment: false,
  };
}

let engine;
let handlers;
let account;
let inbox;
let trash;
let messageId;

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

  // Seed Inbox and Trash via the regular sync path so the test's
  // starting state matches what production looks like after a fresh
  // login: folders, a query_views row for Inbox with one query_view_item
  // at position 0, and a messages row with a folder_messages link.
  const mailboxTransport = new MockTransport();
  mailboxTransport.handle('Mailbox/get', () => ({
    list: [
      { id: 'mb-inbox', name: 'Inbox', role: 'inbox' },
      { id: 'mb-trash', name: 'Trash', role: 'trash' },
    ],
    state: 's0',
  }));
  await syncMailboxes({ transport: mailboxTransport, account, handlers });

  inbox = await engine.get(
    'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
    [account.id, 'mb-inbox'],
  );
  trash = await engine.get(
    'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
    [account.id, 'mb-trash'],
  );

  const messageTransport = new MockTransport();
  messageTransport.handle('Email/query', () => ({
    ids: ['e-1'],
    total: 1,
    queryState: 'qs',
    canCalculateChanges: true,
    position: 0,
  }));
  messageTransport.handle('Email/get', (params) => ({
    list: params.ids.map((id) => emailFixture(id)),
    state: 'es',
  }));
  await syncFolderWindow({
    transport: messageTransport,
    account,
    folder: inbox,
    handlers,
  });

  const row = await engine.get(
    'SELECT id FROM messages WHERE account_id = ? AND remote_id = ?',
    [account.id, 'e-1'],
  );
  messageId = row.id;
});

afterEach(async () => {
  await engine.close();
});

async function loadInboxView() {
  return engine.get(
    `SELECT id, total, stale FROM query_views
      WHERE account_id = ? AND folder_id = ? AND view_type = 'mailbox-window'`,
    [account.id, inbox.id],
  );
}

async function loadTrashView() {
  return engine.get(
    `SELECT id, total, stale FROM query_views
      WHERE account_id = ? AND folder_id = ? AND view_type = 'mailbox-window'`,
    [account.id, trash.id],
  );
}

async function loadViewItems(viewId) {
  return engine.all(
    `SELECT position, remote_id FROM query_view_items
      WHERE view_id = ? ORDER BY position`,
    [viewId],
  );
}

async function loadFolderMemberships(msgId) {
  return engine.all(
    `SELECT folder_id FROM folder_messages WHERE message_id = ? ORDER BY folder_id`,
    [msgId],
  );
}

describe('outbox moveToFolders (Inbox -> Trash)', () => {
  it('moves folder_messages, drops the Inbox view entry, decrements Inbox total, and marks Trash stale', async () => {
    // Sanity: the seed put the message in Inbox at view position 0.
    const inboxViewBefore = await loadInboxView();
    expect(Number(inboxViewBefore.total)).toBe(1);
    expect(await loadViewItems(inboxViewBefore.id)).toEqual([
      { position: 0, remote_id: 'e-1' },
    ]);
    expect(await loadFolderMemberships(messageId)).toEqual([
      { folder_id: inbox.id },
    ]);

    const mutation = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.MOVE_TO_FOLDERS,
      targetMessageId: messageId,
      requestJson: JSON.stringify({
        addFolderIds: [trash.id],
        removeFolderIds: [inbox.id],
      }),
    });

    const transport = new MockTransport();
    transport.handle('Email/set', () => ({ updated: { 'e-1': null } }));

    const summary = await drainOutbox({
      transport,
      account,
      handlers,
      mutationId: mutation.id,
    });
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });

    // folder_messages now reflects Trash only (Inbox dropped).
    expect(await loadFolderMemberships(messageId)).toEqual([
      { folder_id: trash.id },
    ]);

    // The message row itself still exists - move does not delete.
    const message = await engine.get(
      'SELECT id, remote_id FROM messages WHERE id = ?',
      [messageId],
    );
    expect(message.remote_id).toBe('e-1');

    // The Inbox view has the row removed and total decremented.
    const inboxViewAfter = await loadInboxView();
    expect(Number(inboxViewAfter.total)).toBe(0);
    expect(await loadViewItems(inboxViewAfter.id)).toEqual([]);

    // No pending_mutations row left.
    const remaining = await handlers[DB_RPC.PENDING_MUTATION_LIST_PENDING]({
      accountId: account.id,
    });
    expect(remaining).toHaveLength(0);

    // There is no Trash query view yet (the user never opened Trash),
    // so there is nothing to mark stale. The test for staleness lives
    // in the Trash-was-open case below.
    expect(await loadTrashView()).toBeNull();
  });

  it('marks an existing destination view stale and clears its painted ranges', async () => {
    // Pre-seed a Trash query_view (simulating the user having visited
    // Trash earlier in the session).
    const trashTransport = new MockTransport();
    trashTransport.handle('Email/query', () => ({
      ids: [], total: 0, queryState: 'trash-qs', canCalculateChanges: true, position: 0,
    }));
    trashTransport.handle('Email/get', () => ({ list: [], state: 'es' }));
    await syncFolderWindow({
      transport: trashTransport,
      account,
      folder: trash,
      handlers,
    });

    const trashViewBefore = await loadTrashView();
    expect(trashViewBefore).not.toBeNull();
    expect(Number(trashViewBefore.stale)).toBe(0);

    // The empty initial sync writes a query_view_ranges row covering
    // the requested [0, 0) (or [0, fetched]) window; make sure there
    // is at least one to assert the wipe.
    await handlers[DB_RPC.QUERY]({
      sql: `INSERT INTO query_view_ranges(view_id, start_position, end_position, fetched_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT DO NOTHING`,
      params: [trashViewBefore.id, 0, 25, Date.now()],
    });
    const rangesBefore = await engine.all(
      'SELECT view_id FROM query_view_ranges WHERE view_id = ?',
      [trashViewBefore.id],
    );
    expect(rangesBefore.length).toBeGreaterThan(0);

    const mutation = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.MOVE_TO_FOLDERS,
      targetMessageId: messageId,
      requestJson: JSON.stringify({
        addFolderIds: [trash.id],
        removeFolderIds: [inbox.id],
      }),
    });

    const transport = new MockTransport();
    transport.handle('Email/set', () => ({ updated: { 'e-1': null } }));

    const summary = await drainOutbox({
      transport,
      account,
      handlers,
      mutationId: mutation.id,
    });
    expect(summary.succeeded).toBe(1);

    const trashViewAfter = await loadTrashView();
    expect(Number(trashViewAfter.stale)).toBe(1);
    const rangesAfter = await engine.all(
      'SELECT view_id FROM query_view_ranges WHERE view_id = ?',
      [trashViewAfter.id],
    );
    expect(rangesAfter).toEqual([]);
  });
});

describe('outbox destroy (delete from Trash)', () => {
  it('deletes the message everywhere: messages row, folder memberships, query_view_items', async () => {
    // Move the message to Trash first so the destroy mutation is the
    // realistic "user clicks Delete while inside Trash" case.
    const move = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.MOVE_TO_FOLDERS,
      targetMessageId: messageId,
      requestJson: JSON.stringify({
        addFolderIds: [trash.id],
        removeFolderIds: [inbox.id],
      }),
    });
    const moveTransport = new MockTransport();
    moveTransport.handle('Email/set', () => ({ updated: { 'e-1': null } }));
    await drainOutbox({
      transport: moveTransport, account, handlers, mutationId: move.id,
    });

    // Open Trash so there is a query_view row for it with this message
    // in query_view_items at position 0.
    const trashTransport = new MockTransport();
    trashTransport.handle('Email/query', () => ({
      ids: ['e-1'], total: 1, queryState: 'trash-qs', canCalculateChanges: true, position: 0,
    }));
    trashTransport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailFixture(id, { mailboxIds: { 'mb-trash': true } })),
      state: 'es',
    }));
    await syncFolderWindow({
      transport: trashTransport, account, folder: trash, handlers,
    });

    const trashViewBefore = await loadTrashView();
    expect(await loadViewItems(trashViewBefore.id)).toEqual([
      { position: 0, remote_id: 'e-1' },
    ]);

    const destroy = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.DESTROY,
      targetMessageId: messageId,
      requestJson: JSON.stringify({}),
    });
    const transport = new MockTransport();
    transport.handle('Email/set', () => ({ destroyed: ['e-1'] }));
    const summary = await drainOutbox({
      transport, account, handlers, mutationId: destroy.id,
    });
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });

    // The message itself is gone.
    const message = await engine.get(
      'SELECT id FROM messages WHERE id = ?',
      [messageId],
    );
    expect(message).toBeNull();

    // The FK cascade dropped folder_messages.
    const memberships = await engine.all(
      'SELECT folder_id FROM folder_messages WHERE message_id = ?',
      [messageId],
    );
    expect(memberships).toEqual([]);

    // The Trash view has the row removed and total decremented to 0.
    const trashViewAfter = await loadTrashView();
    expect(Number(trashViewAfter.total)).toBe(0);
    expect(await loadViewItems(trashViewAfter.id)).toEqual([]);

    // Belt and braces: no view anywhere still references this remote_id.
    const orphans = await engine.all(
      `SELECT view_id, position FROM query_view_items WHERE remote_id = ?`,
      ['e-1'],
    );
    expect(orphans).toEqual([]);
  });

  it('compacts positions of higher items when the deleted message was in the middle', async () => {
    // Seed two more messages so we delete e-2 out of three at positions 0,1,2.
    const trashTransport = new MockTransport();
    trashTransport.handle('Email/query', () => ({
      ids: ['e-3', 'e-2', 'e-1'], total: 3, queryState: 'trash-qs',
      canCalculateChanges: true, position: 0,
    }));
    trashTransport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailFixture(id, { mailboxIds: { 'mb-trash': true } })),
      state: 'es',
    }));
    await syncFolderWindow({
      transport: trashTransport, account, folder: trash, handlers,
    });

    const e2 = await engine.get(
      'SELECT id FROM messages WHERE account_id = ? AND remote_id = ?',
      [account.id, 'e-2'],
    );

    const trashViewBefore = await loadTrashView();
    expect(await loadViewItems(trashViewBefore.id)).toEqual([
      { position: 0, remote_id: 'e-3' },
      { position: 1, remote_id: 'e-2' },
      { position: 2, remote_id: 'e-1' },
    ]);

    const destroy = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.DESTROY,
      targetMessageId: e2.id,
      requestJson: JSON.stringify({}),
    });
    const transport = new MockTransport();
    transport.handle('Email/set', () => ({ destroyed: ['e-2'] }));
    await drainOutbox({
      transport, account, handlers, mutationId: destroy.id,
    });

    const trashViewAfter = await loadTrashView();
    expect(Number(trashViewAfter.total)).toBe(2);
    expect(await loadViewItems(trashViewAfter.id)).toEqual([
      { position: 0, remote_id: 'e-3' },
      { position: 1, remote_id: 'e-1' },
    ]);
  });
});

describe('outbox failure handling', () => {
  it('does not touch the cache when Email/set update reports notUpdated', async () => {
    const mutation = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.MOVE_TO_FOLDERS,
      targetMessageId: messageId,
      requestJson: JSON.stringify({
        addFolderIds: [trash.id],
        removeFolderIds: [inbox.id],
      }),
    });
    const transport = new MockTransport();
    transport.handle('Email/set', () => ({
      notUpdated: { 'e-1': { type: 'forbidden', description: 'denied' } },
    }));

    const summary = await drainOutbox({
      transport, account, handlers, mutationId: mutation.id,
    });
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1 });

    // Cache state must be identical to the seeded starting state.
    expect(await loadFolderMemberships(messageId)).toEqual([
      { folder_id: inbox.id },
    ]);
    const inboxView = await loadInboxView();
    expect(Number(inboxView.total)).toBe(1);
    expect(await loadViewItems(inboxView.id)).toEqual([
      { position: 0, remote_id: 'e-1' },
    ]);

    // pending_mutations row is conflicted, not deleted.
    const remaining = await engine.all(
      'SELECT local_status, error_json FROM pending_mutations WHERE id = ?',
      [mutation.id],
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0].local_status).toBe('conflicted');
    expect(remaining[0].error_json).toMatch(/notUpdated/);
  });

  it('does not touch the cache when Email/set destroy reports notDestroyed', async () => {
    const mutation = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.DESTROY,
      targetMessageId: messageId,
      requestJson: JSON.stringify({}),
    });
    const transport = new MockTransport();
    transport.handle('Email/set', () => ({
      notDestroyed: { 'e-1': { type: 'forbidden', description: 'in use' } },
    }));

    const summary = await drainOutbox({
      transport, account, handlers, mutationId: mutation.id,
    });
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1 });

    // Message still present, view unchanged.
    const message = await engine.get('SELECT id FROM messages WHERE id = ?', [messageId]);
    expect(message).not.toBeNull();
    expect(await loadFolderMemberships(messageId)).toEqual([
      { folder_id: inbox.id },
    ]);
    const inboxView = await loadInboxView();
    expect(Number(inboxView.total)).toBe(1);
    expect(await loadViewItems(inboxView.id)).toEqual([
      { position: 0, remote_id: 'e-1' },
    ]);
  });

  it('reconciles a stale move: server says message is already gone -> treat as successful destroy', async () => {
    // The user's local cache says e-1 is in Inbox, but on the server
    // it has already been destroyed (e.g. by another client or by a
    // half-finished previous attempt). Click Delete:
    //   Email/set update -> notUpdated
    //   reconcile via Email/get -> notFound
    //   applyDestroyLocally -> messages row + view entries cleaned
    //   outbox reports success so the UI does not flash an error.
    const mutation = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.MOVE_TO_FOLDERS,
      targetMessageId: messageId,
      requestJson: JSON.stringify({
        addFolderIds: [trash.id],
        removeFolderIds: [inbox.id],
      }),
    });
    const transport = new MockTransport();
    transport.handle('Email/set', () => ({
      notUpdated: { 'e-1': { type: 'notFound' } },
    }));
    transport.handle('Email/get', (params) => ({
      list: [],
      notFound: params.ids,
      state: 'es',
    }));

    const summary = await drainOutbox({
      transport, account, handlers, mutationId: mutation.id,
    });
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });

    // Local cache reflects "the message is gone".
    expect(await engine.get('SELECT id FROM messages WHERE id = ?', [messageId])).toBeNull();
    expect(await loadFolderMemberships(messageId)).toEqual([]);
    const inboxView = await loadInboxView();
    expect(await loadViewItems(inboxView.id)).toEqual([]);

    // pending_mutations row was cleared (success path).
    expect(await handlers[DB_RPC.PENDING_MUTATION_LIST_PENDING]({
      accountId: account.id,
    })).toHaveLength(0);
  });

  it('reconciles a stale move: server says message already in Trash -> treat as successful move', async () => {
    // Local cache says Inbox, server says Trash. The user clicks
    // Delete from Inbox. The patch returns notUpdated because the
    // requested change is a no-op (already there). Reconcile via
    // Email/get, update folder_messages + query_view_items to match
    // server, and report success.
    const mutation = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.MOVE_TO_FOLDERS,
      targetMessageId: messageId,
      requestJson: JSON.stringify({
        addFolderIds: [trash.id],
        removeFolderIds: [inbox.id],
      }),
    });
    const transport = new MockTransport();
    transport.handle('Email/set', () => ({
      notUpdated: { 'e-1': { type: 'invalidProperties' } },
    }));
    transport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailFixture(id, { mailboxIds: { 'mb-trash': true } })),
      state: 'es',
    }));

    const summary = await drainOutbox({
      transport, account, handlers, mutationId: mutation.id,
    });
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });

    // folder_messages now reflects Trash, not Inbox.
    expect(await loadFolderMemberships(messageId)).toEqual([
      { folder_id: trash.id },
    ]);

    // Inbox view no longer references the message.
    const inboxView = await loadInboxView();
    expect(await loadViewItems(inboxView.id)).toEqual([]);
  });

  it('reconciles a stale destroy: server says message already gone -> treat as success', async () => {
    const mutation = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.DESTROY,
      targetMessageId: messageId,
      requestJson: JSON.stringify({}),
    });
    const transport = new MockTransport();
    transport.handle('Email/set', () => ({
      notDestroyed: { 'e-1': { type: 'notFound' } },
    }));
    transport.handle('Email/get', (params) => ({
      list: [],
      notFound: params.ids,
      state: 'es',
    }));

    const summary = await drainOutbox({
      transport, account, handlers, mutationId: mutation.id,
    });
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(await engine.get('SELECT id FROM messages WHERE id = ?', [messageId])).toBeNull();
  });

  it('keeps a real "forbidden" move failure as a failure even after reconcile', async () => {
    // Server explicitly refuses the move (e.g. read-only mailbox).
    // Email/get returns the message still in Inbox -> the user's
    // intent is not satisfied -> outbox keeps the row conflicted.
    const mutation = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.MOVE_TO_FOLDERS,
      targetMessageId: messageId,
      requestJson: JSON.stringify({
        addFolderIds: [trash.id],
        removeFolderIds: [inbox.id],
      }),
    });
    const transport = new MockTransport();
    transport.handle('Email/set', () => ({
      notUpdated: { 'e-1': { type: 'forbidden', description: 'denied' } },
    }));
    transport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailFixture(id, { mailboxIds: { 'mb-inbox': true } })),
      state: 'es',
    }));

    const summary = await drainOutbox({
      transport, account, handlers, mutationId: mutation.id,
    });
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1 });

    // Local cache stays as-is: message still in Inbox.
    expect(await loadFolderMemberships(messageId)).toEqual([
      { folder_id: inbox.id },
    ]);
    const inboxView = await loadInboxView();
    expect(await loadViewItems(inboxView.id)).toEqual([
      { position: 0, remote_id: 'e-1' },
    ]);

    const remaining = await engine.all(
      'SELECT local_status, error_json FROM pending_mutations WHERE id = ?',
      [mutation.id],
    );
    expect(remaining[0].local_status).toBe('conflicted');
    expect(remaining[0].error_json).toMatch(/notUpdated/);
  });

  it('does not touch the cache when the transport throws', async () => {
    const mutation = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.MOVE_TO_FOLDERS,
      targetMessageId: messageId,
      requestJson: JSON.stringify({
        addFolderIds: [trash.id],
        removeFolderIds: [inbox.id],
      }),
    });
    const transport = new MockTransport();
    transport.handle('Email/set', () => { throw new Error('network down'); });

    const summary = await drainOutbox({
      transport, account, handlers, mutationId: mutation.id,
    });
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1 });

    expect(await loadFolderMemberships(messageId)).toEqual([
      { folder_id: inbox.id },
    ]);
    const inboxView = await loadInboxView();
    expect(Number(inboxView.total)).toBe(1);
    expect(await loadViewItems(inboxView.id)).toEqual([
      { position: 0, remote_id: 'e-1' },
    ]);
  });
});
