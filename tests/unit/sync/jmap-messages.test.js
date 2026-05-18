import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory.js';
import { makeHandlers } from '../../../src/db/handlers.js';
import { DB_RPC } from '../../../src/db/protocol.js';
import {
  syncFolderWindow,
  syncFolderWindowChanges,
  syncEmailChanges,
} from '../../../src/sync/backends/jmap/messages.js';
import { syncMailboxes } from '../../../src/sync/backends/jmap/mailboxes.js';
import { MockTransport } from './_mock-transport.js';

let engine;
let handlers;
let account;
let inbox;

const NOW = Date.parse('2026-05-01T12:00:00Z');

function emailFixture(overrides = {}) {
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
    const remoteIds = items.map((i) => i.remote_id);
    expect(remoteIds).toContain('e-new');
    expect(remoteIds).not.toContain('e-c');

    const fresh = await engine.get(
      'SELECT subject FROM messages WHERE account_id = ? AND remote_id = ?',
      [account.id, 'e-new'],
    );
    expect(fresh.subject).toBe('fresh');
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
});
