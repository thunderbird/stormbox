/**
 * Direct unit coverage for the post-mutation cache effects:
 *
 *   - DB_RPC.OUTBOX_APPLY_MOVE_BATCH and OUTBOX_APPLY_DESTROY_BATCH
 *     (the protocol-neutral cache mutation handlers in db/handlers.ts
 *     that outbox.ts calls after a server-confirmed Email/set).
 *   - applySendLocally (the JMAP-specific helper in outbox.ts that
 *     re-fetches the canonical row after a successful send and
 *     prepends it into open Sent views).
 *
 * The existing jmap-outbox-delete tests reach the same code paths
 * through drainOutbox; this file pins the cache contract so a
 * refactor of either layer cannot silently change the cache
 * invariants the constitution relies on (cache-first reads, no stale
 * rows after a server-confirmed move).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory.js';
import { makeHandlers } from '../../../src/db/handlers.js';
import { DB_RPC } from '../../../src/db/protocol.js';
import { applySendLocally } from '../../../src/sync/backends/jmap/outbox.js';
import { syncMailboxes } from '../../../src/sync/backends/jmap/mailboxes.js';
import { syncFolderWindow } from '../../../src/sync/backends/jmap/messages.js';
import { MockTransport } from './_mock-transport.js';

const NOW = Date.parse('2026-05-01T12:00:00Z');

function emailFixture(id) {
  return {
    id,
    blobId: `b-${id}`,
    threadId: `t-${id}`,
    mailboxIds: { 'mb-inbox': true },
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

let engine: any;
let handlers: any;
let account: any;
let inbox: any;
let trash: any;
let messageId: number;

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
  messageTransport.handle('Email/get', (params: any) => ({
    list: params.ids.map((id: string) => emailFixture(id)),
    state: 'es',
  }));
  await syncFolderWindow({
    transport: messageTransport, account, folder: inbox, handlers,
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

async function loadFolderMemberships(msgId: number) {
  return engine.all(
    `SELECT folder_id FROM folder_messages WHERE message_id = ? ORDER BY folder_id`,
    [msgId],
  );
}

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

async function loadViewItems(viewId: number) {
  return engine.all(
    `SELECT position, remote_id FROM query_view_items
      WHERE view_id = ? ORDER BY position`,
    [viewId],
  );
}

describe('OUTBOX_APPLY_MOVE_BATCH', () => {
  it('moves folder membership, drops the source view entry, and marks the destination stale', async () => {
    // Seed an existing (empty) Trash view through the normal sync path
    // so the destination has a query_views row that the move handler
    // can mark stale.
    const trashTransport = new MockTransport();
    trashTransport.handle('Email/query', () => ({
      ids: [], total: 0, queryState: 'trash-qs', canCalculateChanges: true, position: 0,
    }));
    trashTransport.handle('Email/get', () => ({ list: [], state: 'es' }));
    await syncFolderWindow({
      transport: trashTransport, account, folder: trash, handlers,
    });

    await handlers[DB_RPC.OUTBOX_APPLY_MOVE_BATCH]({
      accountId: account.id,
      messageIds: [messageId],
      addFolderIds: [trash.id],
      removeFolderIds: [inbox.id],
    });

    expect(await loadFolderMemberships(messageId)).toEqual([
      { folder_id: trash.id },
    ]);

    const inboxView = await loadInboxView();
    expect(Number(inboxView.total)).toBe(0);
    expect(await loadViewItems(inboxView.id)).toEqual([]);

    const trashView = await loadTrashView();
    expect(Number(trashView.stale)).toBe(1);
  });

  it('is a no-op when messageIds is empty (defensive guard against partial mutation rows)', async () => {
    await handlers[DB_RPC.OUTBOX_APPLY_MOVE_BATCH]({
      accountId: account.id,
      messageIds: [],
      addFolderIds: [trash.id],
      removeFolderIds: [inbox.id],
    });

    expect(await loadFolderMemberships(messageId)).toEqual([
      { folder_id: inbox.id },
    ]);
    const inboxView = await loadInboxView();
    expect(Number(inboxView.total)).toBe(1);
  });
});

describe('OUTBOX_APPLY_DESTROY_BATCH', () => {
  it('removes the message row, folder membership, and every query_view_items reference', async () => {
    await handlers[DB_RPC.OUTBOX_APPLY_DESTROY_BATCH]({
      accountId: account.id,
      messageIds: [messageId],
    });

    expect(await engine.get('SELECT id FROM messages WHERE id = ?', [messageId])).toBeNull();
    expect(await loadFolderMemberships(messageId)).toEqual([]);

    const inboxView = await loadInboxView();
    expect(Number(inboxView.total)).toBe(0);
    expect(await loadViewItems(inboxView.id)).toEqual([]);
  });

  it('is a no-op when messageIds is empty', async () => {
    await handlers[DB_RPC.OUTBOX_APPLY_DESTROY_BATCH]({
      accountId: account.id,
      messageIds: [],
    });

    expect(await engine.get('SELECT id FROM messages WHERE id = ?', [messageId])).not.toBeNull();
  });
});

describe('applySendLocally', () => {
  let sent: any;

  beforeEach(async () => {
    // Replace the inbox+trash-only mailbox set with one that includes
    // Sent so we can exercise the query_view prepend path.
    const mailboxTransport = new MockTransport();
    mailboxTransport.handle('Mailbox/get', () => ({
      list: [
        { id: 'mb-inbox', name: 'Inbox', role: 'inbox' },
        { id: 'mb-trash', name: 'Trash', role: 'trash' },
        { id: 'mb-sent', name: 'Sent', role: 'sent' },
      ],
      state: 's1',
    }));
    await syncMailboxes({ transport: mailboxTransport, account, handlers });
    sent = await engine.get(
      'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
      [account.id, 'mb-sent'],
    );

    // Seed an empty Sent mailbox-window query_view so the prepend
    // path has something to operate on. Without a query_view the
    // helper persists the message but skips the prepend, which is
    // covered separately below.
    const sentTransport = new MockTransport();
    sentTransport.handle('Email/query', () => ({
      ids: [], total: 0, queryState: 'sent-qs', canCalculateChanges: true, position: 0,
    }));
    sentTransport.handle('Email/get', () => ({ list: [], state: 'es' }));
    await syncFolderWindow({
      transport: sentTransport, account, folder: sent, handlers,
    });
  });

  function sentEmailFixture(id: string) {
    return {
      ...emailFixture(id),
      mailboxIds: { 'mb-sent': true },
      keywords: {},
      subject: 'Hello world',
    };
  }

  async function loadSentView() {
    return engine.get(
      `SELECT id, total, stale FROM query_views
        WHERE account_id = ? AND folder_id = ? AND view_type = 'mailbox-window'`,
      [account.id, sent.id],
    );
  }

  it('persists the new email and prepends it at position 0 of the open Sent view', async () => {
    const transport = new MockTransport();
    transport.handle('Email/get', (params: any) => ({
      list: params.ids.map((id: string) => sentEmailFixture(id)),
      state: 'es',
    }));

    await applySendLocally({
      transport, account, handlers,
      createdRemoteId: 'em-new',
      sentRemoteId: 'mb-sent',
    });

    const newRow = await engine.get(
      'SELECT id FROM messages WHERE account_id = ? AND remote_id = ?',
      [account.id, 'em-new'],
    );
    expect(newRow).not.toBeNull();
    expect(await loadFolderMemberships(Number(newRow.id))).toEqual([
      { folder_id: sent.id },
    ]);

    const sentView = await loadSentView();
    expect(Number(sentView.total)).toBe(1);
    expect(await loadViewItems(sentView.id)).toEqual([
      { position: 0, remote_id: 'em-new' },
    ]);
  });

  it('shifts existing rows down when a Sent view already has entries', async () => {
    // Seed an existing Sent message at position 0 so the prepend has
    // to compact-up before insert.
    const refillTransport = new MockTransport();
    refillTransport.handle('Email/query', () => ({
      ids: ['em-old'], total: 1, queryState: 'sent-qs2',
      canCalculateChanges: true, position: 0,
    }));
    refillTransport.handle('Email/get', (params: any) => ({
      list: params.ids.map((id: string) => sentEmailFixture(id)),
      state: 'es',
    }));
    await syncFolderWindow({
      transport: refillTransport, account, folder: sent, handlers,
    });

    const sendTransport = new MockTransport();
    sendTransport.handle('Email/get', (params: any) => ({
      list: params.ids.map((id: string) => sentEmailFixture(id)),
      state: 'es',
    }));

    await applySendLocally({
      transport: sendTransport, account, handlers,
      createdRemoteId: 'em-new',
      sentRemoteId: 'mb-sent',
    });

    const sentView = await loadSentView();
    expect(Number(sentView.total)).toBe(2);
    expect(await loadViewItems(sentView.id)).toEqual([
      { position: 0, remote_id: 'em-new' },
      { position: 1, remote_id: 'em-old' },
    ]);
  });

  it('persists without touching query_views when the Sent folder is unknown locally', async () => {
    const transport = new MockTransport();
    transport.handle('Email/get', (params: any) => ({
      list: params.ids.map((id: string) => sentEmailFixture(id)),
      state: 'es',
    }));

    await applySendLocally({
      transport, account, handlers,
      createdRemoteId: 'em-new',
      sentRemoteId: 'mb-unknown',
    });

    const newRow = await engine.get(
      'SELECT id FROM messages WHERE account_id = ? AND remote_id = ?',
      [account.id, 'em-new'],
    );
    expect(newRow).not.toBeNull();

    const sentView = await loadSentView();
    expect(Number(sentView.total)).toBe(0);
    expect(await loadViewItems(sentView.id)).toEqual([]);
  });

  it('is a no-op when createdRemoteId is missing', async () => {
    const transport = new MockTransport();
    let getCalls = 0;
    transport.handle('Email/get', () => {
      getCalls += 1;
      return { list: [], state: 'es' };
    });

    await applySendLocally({
      transport, account, handlers,
      createdRemoteId: null,
      sentRemoteId: 'mb-sent',
    });

    expect(getCalls).toBe(0);
    const sentView = await loadSentView();
    expect(Number(sentView.total)).toBe(0);
  });
});
