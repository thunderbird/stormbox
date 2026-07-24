import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import {
  syncFolderWindow,
  syncFolderWindowChanges,
  syncEmailChanges,
} from '../../../src/sync/backends/jmap/messages';
import { syncMailboxes } from '../../../src/sync/backends/jmap/mailboxes';
import { MockTransport } from './_mock-transport';

let engine;
let handlers;
let account;
let inbox;

const NOW = Date.parse('2026-05-01T12:00:00Z');

function emailFixture(overrides: any = {}) {
  return {
    id: overrides.id,
    blobId: overrides.blobId ?? `blob-${overrides.id}`,
    threadId: overrides.threadId ?? `thr-${overrides.id}`,
    mailboxIds: overrides.mailboxIds ?? { 'mb-inbox': true },
    keywords: overrides.keywords ?? {},
    size: overrides.size ?? 1234,
    receivedAt: overrides.receivedAt ?? new Date(NOW).toISOString(),
    sentAt: overrides.sentAt ?? new Date(NOW - 1000).toISOString(),
    messageId: overrides.messageId ?? [`<${overrides.id}@example.com>`],
    inReplyTo: overrides.inReplyTo ?? null,
    references: overrides.references ?? null,
    sender: overrides.sender ?? [{ name: 'Sender', email: 'sender@example.com' }],
    from: overrides.from ?? [{ name: 'From', email: 'from@example.com' }],
    to: overrides.to ?? [{ name: 'To', email: 'to@example.com' }],
    cc: overrides.cc ?? null,
    bcc: overrides.bcc ?? null,
    replyTo: overrides.replyTo ?? null,
    subject: overrides.subject ?? `Subject ${overrides.id}`,
    preview: overrides.preview ?? `preview ${overrides.id}`,
    hasAttachment: overrides.hasAttachment ?? false,
    ...overrides.extra,
  };
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

  // Seed the inbox folder so message membership can resolve.
  const transport = new MockTransport();
  transport.handle('Mailbox/get', () => ({
    list: [{ id: 'mb-inbox', name: 'Inbox', role: 'inbox' }],
    state: 's0',
  }));
  await syncMailboxes({ transport, account, handlers });
  inbox = await engine.get(
    'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
    [account.id, 'mb-inbox'],
  );
});

afterEach(async () => {
  await engine.close();
});

describe('syncFolderWindow', () => {
  it('persists query view state, items, range, and full message metadata', async () => {
    const transport = new MockTransport();
    transport.handle('Email/query', () => ({
      ids: ['e-1', 'e-2', 'e-3'],
      total: 3,
      queryState: 'qs-1',
      canCalculateChanges: true,
      position: 0,
    }));
    transport.handle('Email/get', (params) => ({
      list: params.ids.map((id) =>
        emailFixture({ id, keywords: id === 'e-2' ? { $seen: true } : {} }),
      ),
      state: 'es-1',
    }));

    const result = await syncFolderWindow({
      transport, account, folder: inbox, handlers,
      sortProp: 'receivedAt', position: 0, limit: 50,
    });
    expect(result.fetched).toBe(3);
    expect(result.total).toBe(3);

    const view = await engine.get(
      'SELECT id, query_state, total FROM query_views WHERE account_id = ? AND folder_id = ?',
      [account.id, inbox.id],
    );
    expect(view.query_state).toBe('qs-1');
    expect(Number(view.total)).toBe(3);

    const items = await engine.all(
      'SELECT position, remote_id FROM query_view_items WHERE view_id = ? ORDER BY position',
      [view.id],
    );
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.remote_id)).toEqual(['e-1', 'e-2', 'e-3']);

    const range = await engine.get(
      'SELECT start_position, end_position FROM query_view_ranges WHERE view_id = ?',
      [view.id],
    );
    expect(Number(range.start_position)).toBe(0);
    expect(Number(range.end_position)).toBe(3);

    const messages = await handlers[DB_RPC.MESSAGE_LIST_FOR_FOLDER]({ folderId: inbox.id });
    expect(messages).toHaveLength(3);
    const seen = messages.find((m) => m.remote_id === 'e-2');
    expect(Number(seen.is_seen)).toBe(1);

    // Each message should have address rows for from/to/sender.
    const addresses = await engine.all(
      `SELECT kind, COUNT(*) AS n FROM message_addresses ma
        JOIN messages m ON m.id = ma.message_id
       WHERE m.account_id = ? GROUP BY kind ORDER BY kind`,
      [account.id],
    );
    expect(addresses.find((r) => r.kind === 'from')?.n).toBe(3);
    expect(addresses.find((r) => r.kind === 'to')?.n).toBe(3);
    expect(addresses.find((r) => r.kind === 'sender')?.n).toBe(3);
  });

  it('persists anchored query windows at the server-returned position', async () => {
    const transport = new MockTransport();
    transport.handle('Email/query', (params) => {
      expect(params.anchor).toBe('e-42');
      expect(params.anchorOffset).toBe(0);
      expect(params.position).toBeUndefined();
      return {
        ids: ['e-42'],
        total: 100,
        queryState: 'qs-anchor',
        canCalculateChanges: true,
        position: 41,
      };
    });
    transport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailFixture({ id })),
      state: 'es-anchor',
    }));

    const result = await syncFolderWindow({
      transport,
      account,
      folder: inbox,
      handlers,
      anchor: 'e-42',
      anchorOffset: 0,
      limit: 1,
    });

    expect(result.position).toBe(41);
    expect(result.ids).toEqual(['e-42']);

    const view = await engine.get(
      'SELECT id FROM query_views WHERE account_id = ? AND folder_id = ?',
      [account.id, inbox.id],
    );
    const item = await engine.get(
      'SELECT position, remote_id FROM query_view_items WHERE view_id = ?',
      [view.id],
    );
    expect(Number(item.position)).toBe(41);
    expect(item.remote_id).toBe('e-42');
  });

  it('issues a single chained method-call request via JMAP back reference', async () => {
    const transport = new MockTransport();
    transport.handle('Email/query', () => ({
      ids: ['e-1', 'e-2'],
      total: 2,
      queryState: 'qs',
      canCalculateChanges: true,
      position: 0,
    }));
    transport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailFixture({ id })),
      state: 'es',
    }));
    await syncFolderWindow({ transport, account, folder: inbox, handlers });
    expect(transport.requests).toHaveLength(1);
    const [{ methodCalls }] = transport.requests;
    expect(methodCalls).toHaveLength(2);
    expect(methodCalls[0][0]).toBe('Email/query');
    expect(methodCalls[1][0]).toBe('Email/get');
    expect(methodCalls[1][1]['#ids']).toEqual({
      resultOf: 'q1',
      name: 'Email/query',
      path: '/ids',
    });
  });

  it('persists idempotently when the same window is fetched twice', async () => {
    const transport = new MockTransport();
    transport.handle('Email/query', () => ({
      ids: ['e-1', 'e-2'],
      total: 2,
      queryState: 'qs',
      canCalculateChanges: true,
      position: 0,
    }));
    transport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailFixture({ id })),
      state: 'es',
    }));
    await syncFolderWindow({ transport, account, folder: inbox, handlers });
    await syncFolderWindow({ transport, account, folder: inbox, handlers });
    const messages = await handlers[DB_RPC.MESSAGE_LIST_FOR_FOLDER]({ folderId: inbox.id });
    expect(messages.map((m) => m.remote_id).sort()).toEqual(['e-1', 'e-2']);
  });

  it('handles overlapping query_view_items windows without remote-id uniqueness errors', async () => {
    const first = new MockTransport();
    first.handle('Email/query', () => ({
      ids: ['e-1', 'e-2', 'e-3'],
      total: 4,
      queryState: 'qs-1',
      canCalculateChanges: true,
      position: 0,
    }));
    first.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailFixture({ id })),
      state: 'es-1',
    }));
    await syncFolderWindow({
      transport: first, account, folder: inbox, handlers,
      position: 0, limit: 3,
    });

    const overlap = new MockTransport();
    overlap.handle('Email/query', () => ({
      ids: ['e-3', 'e-4'],
      total: 4,
      queryState: 'qs-2',
      canCalculateChanges: true,
      position: 2,
    }));
    overlap.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailFixture({ id })),
      state: 'es-2',
    }));
    await syncFolderWindow({
      transport: overlap, account, folder: inbox, handlers,
      position: 2, limit: 2,
    });

    const view = await engine.get(
      'SELECT id FROM query_views WHERE account_id = ? AND folder_id = ?',
      [account.id, inbox.id],
    );
    const items = await engine.all(
      'SELECT position, remote_id FROM query_view_items WHERE view_id = ? ORDER BY position',
      [view.id],
    );
    expect(items.map((i) => [Number(i.position), i.remote_id])).toEqual([
      [0, 'e-1'],
      [1, 'e-2'],
      [2, 'e-3'],
      [3, 'e-4'],
    ]);
  });

  it('builds folder_messages entries linking the message to the inbox', async () => {
    const transport = new MockTransport();
    transport.handle('Email/query', () => ({
      ids: ['e-1'],
      total: 1,
      queryState: 'qs',
      canCalculateChanges: true,
      position: 0,
    }));
    transport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailFixture({ id })),
      state: 'es',
    }));
    await syncFolderWindow({ transport, account, folder: inbox, handlers });
    const list = await handlers[DB_RPC.MESSAGE_LIST_FOR_FOLDER]({ folderId: inbox.id });
    expect(list).toHaveLength(1);
    expect(list[0].remote_id).toBe('e-1');
  });
});

describe('syncFolderWindowChanges', () => {
  async function bootstrap() {
    const transport = new MockTransport();
    transport.handle('Email/query', () => ({
      ids: ['e-a', 'e-b', 'e-c'],
      total: 3,
      queryState: 'qs-1',
      canCalculateChanges: true,
      position: 0,
    }));
    transport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailFixture({ id })),
      state: 'es',
    }));
    await syncFolderWindow({ transport, account, folder: inbox, handlers });
  }

  it('applies removed, added, and fetched metadata for new ids', async () => {
    await bootstrap();

    const transport = new MockTransport();
    transport.handle('Email/queryChanges', () => ({
      oldQueryState: 'qs-1',
      newQueryState: 'qs-2',
      total: 3,
      removed: ['e-c'],
      added: [{ id: 'e-new', index: 0 }],
    }));
    transport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailFixture({ id, subject: 'fresh' })),
      state: 'es-2',
    }));

    const result = await syncFolderWindowChanges({
      transport, account, folder: inbox, handlers,
      sinceQueryState: 'qs-1',
    });
    expect(result.needsFullSync).toBe(false);
    expect(result.queryState).toBe('qs-2');
    expect(result.fetched).toBe(1);

    const view = await engine.get(
      'SELECT id FROM query_views WHERE account_id = ? AND folder_id = ?',
      [account.id, inbox.id],
    );
    const items = await engine.all(
      'SELECT remote_id, position FROM query_view_items WHERE view_id = ? ORDER BY position',
      [view.id],
    );
    // e-c was at position 2 and got removed (no compaction needed
    // since nothing sat above it). e-new was inserted at index 0,
    // pushing e-a/e-b down to positions 1 and 2. Verifying the exact
    // ordering catches the prior bug where the addition would
    // overwrite the row at position 0.
    expect(items.map((i) => [Number(i.position), i.remote_id])).toEqual([
      [0, 'e-new'],
      [1, 'e-a'],
      [2, 'e-b'],
    ]);

    const fresh = await engine.get(
      'SELECT subject FROM messages WHERE account_id = ? AND remote_id = ?',
      [account.id, 'e-new'],
    );
    expect(fresh.subject).toBe('fresh');
  });

  it('compacts positions when items are removed from the middle of the view', async () => {
    await bootstrap();
    const transport = new MockTransport();
    transport.handle('Email/queryChanges', () => ({
      oldQueryState: 'qs-1',
      newQueryState: 'qs-2',
      total: 2,
      removed: ['e-b'],
      added: [],
    }));
    transport.handle('Email/get', () => ({ list: [], state: 'es-2' }));
    await syncFolderWindowChanges({
      transport, account, folder: inbox, handlers,
      sinceQueryState: 'qs-1',
    });
    const view = await engine.get(
      'SELECT id FROM query_views WHERE account_id = ? AND folder_id = ?',
      [account.id, inbox.id],
    );
    const items = await engine.all(
      'SELECT remote_id, position FROM query_view_items WHERE view_id = ? ORDER BY position',
      [view.id],
    );
    // e-c was at position 2; removing e-b in the middle must shift
    // e-c down to position 1 so the positional read for offset=0
    // limit=2 returns both surviving rows.
    expect(items.map((i) => [Number(i.position), i.remote_id])).toEqual([
      [0, 'e-a'],
      [1, 'e-c'],
    ]);
  });

  it('handles a message moving within the view (delete + reinsert)', async () => {
    await bootstrap();
    const transport = new MockTransport();
    transport.handle('Email/queryChanges', () => ({
      oldQueryState: 'qs-1',
      newQueryState: 'qs-2',
      total: 3,
      removed: [],
      // e-c moves from position 2 to position 0 (e.g. flagged and
      // re-sorted to the top).
      added: [{ id: 'e-c', index: 0 }],
    }));
    transport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailFixture({ id })),
      state: 'es-2',
    }));
    await syncFolderWindowChanges({
      transport, account, folder: inbox, handlers,
      sinceQueryState: 'qs-1',
    });
    const view = await engine.get(
      'SELECT id FROM query_views WHERE account_id = ? AND folder_id = ?',
      [account.id, inbox.id],
    );
    const items = await engine.all(
      'SELECT remote_id, position FROM query_view_items WHERE view_id = ? ORDER BY position',
      [view.id],
    );
    expect(items.map((i) => [Number(i.position), i.remote_id])).toEqual([
      [0, 'e-c'],
      [1, 'e-a'],
      [2, 'e-b'],
    ]);
  });

  it('reports needsFullSync when the server cannot calculate changes', async () => {
    await bootstrap();
    const transport = new MockTransport();
    transport.handle('Email/queryChanges', () => ({
      type: 'cannotCalculateChanges',
    }));
    // Chained Email/get still runs (back reference resolves to []
    // because the queryChanges response has no added array).
    transport.handle('Email/get', () => ({ list: [], state: 'es' }));
    const result = await syncFolderWindowChanges({
      transport, account, folder: inbox, handlers,
      sinceQueryState: 'qs-1',
    });
    expect(result.needsFullSync).toBe(true);
  });

  it('does not advance query state when added Email metadata is incomplete', async () => {
    await bootstrap();
    const transport = new MockTransport();
    transport.handle('Email/queryChanges', () => ({
      oldQueryState: 'qs-1',
      newQueryState: 'qs-2',
      total: 4,
      removed: [],
      added: [{ id: 'e-missing', index: 0 }],
    }));
    transport.handle('Email/get', () => ({
      list: [],
      notFound: ['e-missing'],
      state: 'es-2',
    }));

    const result = await syncFolderWindowChanges({
      transport,
      account,
      folder: inbox,
      handlers,
      sinceQueryState: 'qs-1',
    });

    expect(result.needsFullSync).toBe(true);
    const view = await engine.get(
      'SELECT id, query_state, total FROM query_views WHERE account_id = ? AND folder_id = ?',
      [account.id, inbox.id],
    );
    expect(view.query_state).toBe('qs-1');
    expect(Number(view.total)).toBe(3);
    expect(await engine.get(
      'SELECT position FROM query_view_items WHERE view_id = ? AND remote_id = ?',
      [view.id, 'e-missing'],
    )).toBeFalsy();
  });
});

describe('syncEmailChanges', () => {
  it('updates cached metadata and removes destroyed messages', async () => {
    // Bootstrap with two messages.
    const bootstrap = new MockTransport();
    bootstrap.handle('Email/query', () => ({
      ids: ['x', 'y'],
      total: 2,
      queryState: 'qs',
      canCalculateChanges: true,
      position: 0,
    }));
    bootstrap.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailFixture({ id, keywords: {} })),
      state: 'es-0',
    }));
    await syncFolderWindow({ transport: bootstrap, account, folder: inbox, handlers });

    const transport = new MockTransport();
    transport.handle('Email/changes', () => ({
      oldState: 'es-0',
      newState: 'es-1',
      hasMoreChanges: false,
      created: [],
      updated: ['x'],
      destroyed: ['y'],
    }));
    transport.handle('Email/get', (params) => ({
      list: params.ids.map((id) =>
        emailFixture({ id, keywords: { $seen: true, $flagged: true } }),
      ),
      state: 'es-1',
    }));

    const result = await syncEmailChanges({
      transport, account, handlers, sinceState: 'es-0',
    });
    expect(result.newState).toBe('es-1');

    const x = await engine.get(
      'SELECT is_seen, is_flagged FROM messages WHERE account_id = ? AND remote_id = ?',
      [account.id, 'x'],
    );
    expect(Number(x.is_seen)).toBe(1);
    expect(Number(x.is_flagged)).toBe(1);

    const y = await engine.get(
      'SELECT id FROM messages WHERE account_id = ? AND remote_id = ?',
      [account.id, 'y'],
    );
    expect(y).toBeNull();

    const stateRow = await handlers[DB_RPC.SYNC_STATE_GET]({
      accountId: account.id,
      objectType: 'Email',
    });
    expect(stateRow.state).toBe('es-1');
  });

  it('removes query_view_items + decrements query_views.total for destroyed messages so no ghost skeletons remain', async () => {
    // Bootstrap an Inbox view with two messages. Both are present in
    // query_view_items at positions 0 and 1, and query_views.total
    // is 2. This mirrors the state the user's browser is in right
    // after the E2E test creates a disposable inbox message and
    // syncs it.
    const bootstrap = new MockTransport();
    bootstrap.handle('Email/query', () => ({
      ids: ['e-keep', 'e-doomed'],
      total: 2,
      queryState: 'qs',
      canCalculateChanges: true,
      position: 0,
    }));
    bootstrap.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailFixture({ id, keywords: {} })),
      state: 'es-0',
    }));
    await syncFolderWindow({ transport: bootstrap, account, folder: inbox, handlers });

    const viewBefore = await engine.get(
      `SELECT id, total FROM query_views WHERE folder_id = ?`,
      [inbox.id],
    );
    expect(Number(viewBefore.total)).toBe(2);
    expect(await engine.all(
      `SELECT position, remote_id FROM query_view_items
        WHERE view_id = ? ORDER BY position`,
      [viewBefore.id],
    )).toEqual([
      { position: 0, remote_id: 'e-keep' },
      { position: 1, remote_id: 'e-doomed' },
    ]);

    // Now the server tells us e-doomed was destroyed (cleanup by an
    // E2E test or another client). syncEmailChanges should drop it
    // from messages AND from the Inbox view, with position
    // compaction, so no skeleton placeholder remains.
    const transport = new MockTransport();
    transport.handle('Email/changes', () => ({
      oldState: 'es-0',
      newState: 'es-1',
      hasMoreChanges: false,
      created: [],
      updated: [],
      destroyed: ['e-doomed'],
    }));
    // Email/get should not be called for an empty created+updated list,
    // but if syncEmailChanges decides to call it the MockTransport must
    // still respond - leave the handler unregistered to detect that.

    await syncEmailChanges({
      transport, account, handlers, sinceState: 'es-0',
    });

    // messages row gone.
    expect(await engine.get(
      'SELECT id FROM messages WHERE account_id = ? AND remote_id = ?',
      [account.id, 'e-doomed'],
    )).toBeNull();

    // query_view_items for Inbox compacted: e-keep moves to position 0.
    expect(await engine.all(
      `SELECT position, remote_id FROM query_view_items
        WHERE view_id = ? ORDER BY position`,
      [viewBefore.id],
    )).toEqual([
      { position: 0, remote_id: 'e-keep' },
    ]);

    // query_views.total decremented.
    const viewAfter = await engine.get(
      `SELECT total FROM query_views WHERE id = ?`,
      [viewBefore.id],
    );
    expect(Number(viewAfter.total)).toBe(1);
  });

  it('cleans up ghosts in inactive views too (the multi-folder case)', async () => {
    // Same as above but the destroyed message is in TWO folders'
    // views: Inbox (active) and a side folder (Trash) that the user
    // has not visited recently, so _refreshActiveQueryViews would
    // not run queryChanges for it. syncEmailChanges must still
    // clean both.
    const trash = await engine.get(
      'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
      [account.id, 'mb-inbox'],
    );
    // Reuse the Inbox folder as our second-view target: insert a
    // second mailbox-window query_view + items for it manually.
    const filterJson = JSON.stringify({ inMailbox: 'mb-some-other' });
    const sortJson = JSON.stringify([{ property: 'receivedAt', isAscending: false }]);
    const ts = Date.now();
    await handlers[DB_RPC.QUERY]({
      sql: `INSERT INTO query_views(
              account_id, view_type, folder_id, filter_json, sort_json,
              collapse_threads, query_state, can_calculate_changes, total,
              created_at, updated_at, last_accessed_at
            ) VALUES (?, 'mailbox-window', ?, ?, ?, 0, 'qs2', 1, 1, ?, ?, ?)`,
      params: [account.id, trash.id, filterJson, sortJson, ts, ts, ts],
    });
    const sideView = await engine.get(
      `SELECT id FROM query_views WHERE folder_id = ? AND filter_json = ?`,
      [trash.id, filterJson],
    );

    // Seed the canonical Inbox view too.
    const bootstrap = new MockTransport();
    bootstrap.handle('Email/query', () => ({
      ids: ['e-shared'], total: 1, queryState: 'qs', canCalculateChanges: true, position: 0,
    }));
    bootstrap.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailFixture({ id, keywords: {} })),
      state: 'es-0',
    }));
    await syncFolderWindow({ transport: bootstrap, account, folder: inbox, handlers });

    // And put e-shared in the side view too.
    await handlers[DB_RPC.QUERY]({
      sql: `INSERT INTO query_view_items(view_id, position, message_id, remote_id)
            VALUES (?, 0, NULL, ?)`,
      params: [sideView.id, 'e-shared'],
    });

    const transport = new MockTransport();
    transport.handle('Email/changes', () => ({
      oldState: 'es-0',
      newState: 'es-1',
      hasMoreChanges: false,
      created: [],
      updated: [],
      destroyed: ['e-shared'],
    }));

    await syncEmailChanges({
      transport, account, handlers, sinceState: 'es-0',
    });

    // Both views are clean.
    const remaining = await engine.all(
      `SELECT view_id, remote_id FROM query_view_items WHERE remote_id = ?`,
      ['e-shared'],
    );
    expect(remaining).toEqual([]);

    const sideViewAfter = await engine.get(
      `SELECT total FROM query_views WHERE id = ?`,
      [sideView.id],
    );
    expect(Number(sideViewAfter.total)).toBe(0);
  });
});
