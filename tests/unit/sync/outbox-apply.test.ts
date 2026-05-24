/**
 * Direct unit coverage for outbox-apply.ts. The existing
 * jmap-outbox-delete tests reach apply* only through drainOutbox; this
 * file pins the apply contract so a refactor of outbox.ts cannot
 * silently change the cache invariants the constitution relies on
 * (cache-first reads, no stale rows after a server-confirmed move).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory.js';
import { makeHandlers } from '../../../src/db/handlers.js';
import { DB_RPC } from '../../../src/db/protocol.js';
import {
  applyMoveLocally,
  applyDestroyLocally,
} from '../../../src/sync/backends/jmap/outbox-apply.js';
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

describe('applyMoveLocally', () => {
  it('moves folder membership, drops the source view entry, and marks the destination stale', async () => {
    // Seed an existing (empty) Trash view through the normal sync path
    // so the destination has a query_views row that applyMoveLocally
    // can mark stale.
    const trashTransport = new MockTransport();
    trashTransport.handle('Email/query', () => ({
      ids: [], total: 0, queryState: 'trash-qs', canCalculateChanges: true, position: 0,
    }));
    trashTransport.handle('Email/get', () => ({ list: [], state: 'es' }));
    await syncFolderWindow({
      transport: trashTransport, account, folder: trash, handlers,
    });

    await applyMoveLocally(handlers, account, {
      messageId,
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

  it('is a no-op when messageId is null (defensive guard against partial mutation rows)', async () => {
    await applyMoveLocally(handlers, account, {
      messageId: null,
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

describe('applyDestroyLocally', () => {
  it('removes the message row, folder membership, and every query_view_items reference', async () => {
    await applyDestroyLocally(handlers, account, { messageId });

    expect(await engine.get('SELECT id FROM messages WHERE id = ?', [messageId])).toBeNull();
    expect(await loadFolderMemberships(messageId)).toEqual([]);

    const inboxView = await loadInboxView();
    expect(Number(inboxView.total)).toBe(0);
    expect(await loadViewItems(inboxView.id)).toEqual([]);
  });

  it('is a no-op when messageId is null', async () => {
    await applyDestroyLocally(handlers, account, { messageId: null });

    expect(await engine.get('SELECT id FROM messages WHERE id = ?', [messageId])).not.toBeNull();
  });
});
