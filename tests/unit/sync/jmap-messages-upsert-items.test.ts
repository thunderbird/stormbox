/**
 * Regression for the UNIQUE constraint failure that took down the
 * whole Inbox load after a delete-and-resync sequence.
 *
 * The original `upsertQueryViewItems` used two ON CONFLICT clauses to
 * handle either kind of unique constraint violation. That works when
 * only ONE of the constraints fires per insert, but breaks when both
 * fire transitively: an INSERT that lands on an occupied position is
 * upgraded to UPDATE the row's remote_id, and the new remote_id then
 * duplicates an existing row at another position -> SQLite throws
 *   "UNIQUE constraint failed: query_view_items.view_id,
 *    query_view_items.remote_id"
 * and rolls back the whole transaction. Every subsequent sync hits
 * the same error, the view never updates, and the user is stuck with
 * "ghost" rows.
 *
 * The scenario is reachable in production by any flow that re-sends
 * Email/query for a window we have already cached but in which the
 * server has changed positions: a deleted message shifts later ones
 * up by one, applyMoveLocally compacts positions locally, and the
 * next syncFolderWindow returns the new positions for the same ids.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { syncMailboxes } from '../../../src/sync/backends/jmap/mailboxes';
import { syncFolderWindow } from '../../../src/sync/backends/jmap/messages';
import { MockTransport } from './_mock-transport';

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

  const mt = new MockTransport();
  mt.handle('Mailbox/get', () => ({
    list: [{ id: 'mb-inbox', name: 'Inbox', role: 'inbox' }],
    state: 's0',
  }));
  await syncMailboxes({ transport: mt, account, handlers });

  inbox = await engine.get(
    'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
    [account.id, 'mb-inbox'],
  );
});

afterEach(async () => {
  await engine.close();
});

describe('syncFolderWindow re-sync after position shifts', () => {
  it('does not throw UNIQUE constraint when remote_ids reappear at different positions', async () => {
    // First sync: positions 0,1,2 -> e-1, e-2, e-3.
    const initialTransport = new MockTransport();
    initialTransport.handle('Email/query', () => ({
      ids: ['e-1', 'e-2', 'e-3'], total: 3, queryState: 'q-1',
      canCalculateChanges: true, position: 0,
    }));
    initialTransport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailFixture(id)),
      state: 'es',
    }));
    await syncFolderWindow({
      transport: initialTransport, account, folder: inbox, handlers,
    });

    expect(await engine.all(
      `SELECT position, remote_id FROM query_view_items
        WHERE view_id = (SELECT id FROM query_views WHERE folder_id = ?)
        ORDER BY position`,
      [inbox.id],
    )).toEqual([
      { position: 0, remote_id: 'e-1' },
      { position: 1, remote_id: 'e-2' },
      { position: 2, remote_id: 'e-3' },
    ]);

    // Second sync: server now reports e-1 was removed; the surviving
    // ids shifted up. Positions 0,1 -> e-2, e-3. This is the case
    // the broken upsert blew up on: inserting e-2 at position 0
    // collided with row at position 0 (e-1) AND duplicated the
    // existing (view, e-2) row at position 1.
    const resyncTransport = new MockTransport();
    resyncTransport.handle('Email/query', () => ({
      ids: ['e-2', 'e-3'], total: 2, queryState: 'q-2',
      canCalculateChanges: true, position: 0,
    }));
    resyncTransport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailFixture(id)),
      state: 'es',
    }));

    await expect(
      syncFolderWindow({
        transport: resyncTransport, account, folder: inbox, handlers,
      }),
    ).resolves.not.toThrow();

    expect(await engine.all(
      `SELECT position, remote_id FROM query_view_items
        WHERE view_id = (SELECT id FROM query_views WHERE folder_id = ?)
        ORDER BY position`,
      [inbox.id],
    )).toEqual([
      { position: 0, remote_id: 'e-2' },
      { position: 1, remote_id: 'e-3' },
    ]);

    const view = await engine.get(
      `SELECT total FROM query_views WHERE folder_id = ?`,
      [inbox.id],
    );
    expect(Number(view.total)).toBe(2);
  });

  it('handles a single id moving from position 5 to position 0 without UNIQUE failure', async () => {
    // Edge case the cross-constraint resolution must support: a
    // remote_id that already exists in the view shows up at a fresh
    // position in the new sync. Without the fix, the position 0
    // INSERT runs the ON CONFLICT(view_id, position) path, which
    // sets the row's remote_id to the migrated id - and that then
    // duplicates the existing (view, remote_id) row at position 5.
    const first = new MockTransport();
    first.handle('Email/query', () => ({
      ids: ['a', 'b', 'c', 'd', 'e', 'target'], total: 6,
      queryState: 'q-1', canCalculateChanges: true, position: 0,
    }));
    first.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailFixture(id)),
      state: 'es',
    }));
    await syncFolderWindow({
      transport: first, account, folder: inbox, handlers,
    });

    const second = new MockTransport();
    second.handle('Email/query', () => ({
      // 'target' has been promoted to the top; everything else shifted.
      ids: ['target', 'a', 'b', 'c', 'd', 'e'], total: 6,
      queryState: 'q-2', canCalculateChanges: true, position: 0,
    }));
    second.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailFixture(id)),
      state: 'es',
    }));
    await expect(
      syncFolderWindow({
        transport: second, account, folder: inbox, handlers,
      }),
    ).resolves.not.toThrow();

    expect(await engine.all(
      `SELECT position, remote_id FROM query_view_items
        WHERE view_id = (SELECT id FROM query_views WHERE folder_id = ?)
        ORDER BY position`,
      [inbox.id],
    )).toEqual([
      { position: 0, remote_id: 'target' },
      { position: 1, remote_id: 'a' },
      { position: 2, remote_id: 'b' },
      { position: 3, remote_id: 'c' },
      { position: 4, remote_id: 'd' },
      { position: 5, remote_id: 'e' },
    ]);
  });
});
