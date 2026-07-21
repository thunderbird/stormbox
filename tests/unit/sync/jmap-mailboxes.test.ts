import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { syncMailboxes, syncMailboxChanges } from '../../../src/sync/backends/jmap/mailboxes';
import { MockTransport } from './_mock-transport';

let engine;
let handlers;
let account;

beforeEach(async () => {
  engine = await bootTestEngine();
  handlers = makeHandlers(engine);
  const upserted = await handlers[DB_RPC.ACCOUNT_UPSERT]({
    displayName: 'T',
    primaryEmail: 't@example.com',
    serverOrigin: 'https://mail.example.com',
    remoteAccountId: 'acct-1',
    isPrimary: true,
  });
  account = upserted.row;
});

afterEach(async () => {
  await engine.close();
});

describe('syncMailboxes (full sync)', () => {
  it('upserts every mailbox and stores the state token', async () => {
    const transport = new MockTransport();
    transport.handle('Mailbox/get', () => ({
      list: [
        { id: 'mb-inbox', name: 'Inbox', role: 'inbox', sortOrder: 0,
          totalEmails: 3, unreadEmails: 1, totalThreads: 3, unreadThreads: 1 },
        { id: 'mb-sent', name: 'Sent', role: 'sent', sortOrder: 10 },
        { id: 'mb-archives', name: 'Archives', role: 'archive', sortOrder: 20 },
      ],
      state: 'mb-state-1',
    }));
    const result = await syncMailboxes({ transport, account, handlers });
    expect(result.count).toBe(3);
    expect(result.state).toBe('mb-state-1');

    const folders = await handlers[DB_RPC.FOLDER_LIST]({ accountId: account.id });
    expect(folders.map((f) => f.role)).toEqual(['inbox', 'sent', 'archive']);

    const inbox = folders.find((f) => f.role === 'inbox');
    expect(Number(inbox.total_emails)).toBe(3);
    expect(Number(inbox.unread_emails)).toBe(1);

    const stateRow = await handlers[DB_RPC.SYNC_STATE_GET]({
      accountId: account.id,
      objectType: 'Mailbox',
    });
    expect(stateRow.state).toBe('mb-state-1');
  });

  it('does not repair when an archive role mailbox already exists', async () => {
    const transport = new MockTransport();
    transport.handle('Mailbox/get', () => ({
      list: [
        { id: 'mb-inbox', name: 'Inbox', role: 'inbox' },
        { id: 'mb-archives', name: 'Archives', role: 'archive' },
      ],
      state: 'mb-state-archive',
    }));
    let setCalls = 0;
    transport.handle('Mailbox/set', () => {
      setCalls += 1;
      throw new Error('Mailbox/set should not be called');
    });

    await syncMailboxes({ transport, account, handlers });

    expect(setCalls).toBe(0);
  });

  it('sets the archive role on Archives when it exists without a role', async () => {
    const transport = new MockTransport();
    transport.handle('Mailbox/get', (params) => {
      if (params.ids?.includes('mb-archives')) {
        return {
          list: [{ id: 'mb-archives', name: 'Archives', role: 'archive' }],
          state: 'mb-state-repaired',
        };
      }
      return {
        list: [
          { id: 'mb-inbox', name: 'Inbox', role: 'inbox' },
          { id: 'mb-archive', name: 'Archive', role: null },
          { id: 'mb-archives', name: 'Archives', role: null },
        ],
        state: 'mb-state-before',
      };
    });
    transport.handle('Mailbox/set', (params) => {
      expect(params.update).toEqual({
        'mb-archives': { role: 'archive', isSubscribed: true },
      });
      return { updated: { 'mb-archives': null }, newState: 'mb-state-set' };
    });

    const result = await syncMailboxes({ transport, account, handlers });

    expect(result.state).toBe('mb-state-repaired');
    const archive = await engine.get(
      'SELECT role FROM folders WHERE account_id = ? AND remote_id = ?',
      [account.id, 'mb-archives'],
    );
    expect(archive.role).toBe('archive');
  });

  it('falls back to Archive when Archives does not exist', async () => {
    const transport = new MockTransport();
    transport.handle('Mailbox/get', (params) => {
      if (params.ids?.includes('mb-archive')) {
        return {
          list: [{ id: 'mb-archive', name: 'Archive', role: 'archive' }],
          state: 'mb-state-repaired',
        };
      }
      return {
        list: [
          { id: 'mb-inbox', name: 'Inbox', role: 'inbox' },
          { id: 'mb-archive', name: 'Archive', role: null },
        ],
        state: 'mb-state-before',
      };
    });
    transport.handle('Mailbox/set', (params) => {
      expect(params.update).toEqual({
        'mb-archive': { role: 'archive', isSubscribed: true },
      });
      return { updated: { 'mb-archive': null }, newState: 'mb-state-set' };
    });

    await syncMailboxes({ transport, account, handlers });

    const archive = await engine.get(
      'SELECT role FROM folders WHERE account_id = ? AND remote_id = ?',
      [account.id, 'mb-archive'],
    );
    expect(archive.role).toBe('archive');
  });

  it('creates an Archives mailbox with archive role when no candidate exists', async () => {
    const transport = new MockTransport();
    transport.handle('Mailbox/get', (params) => {
      if (params.ids?.includes('mb-new-archives')) {
        return {
          list: [{ id: 'mb-new-archives', name: 'Archives', role: 'archive' }],
          state: 'mb-state-repaired',
        };
      }
      return {
        list: [
          { id: 'mb-inbox', name: 'Inbox', role: 'inbox' },
          { id: 'mb-sent', name: 'Sent', role: 'sent' },
        ],
        state: 'mb-state-before',
      };
    });
    transport.handle('Mailbox/set', (params) => {
      expect(params.create).toEqual({
        archive: { name: 'Archives', role: 'archive', isSubscribed: true },
      });
      return { created: { archive: { id: 'mb-new-archives' } }, newState: 'mb-state-set' };
    });

    const result = await syncMailboxes({ transport, account, handlers });

    expect(result.count).toBe(3);
    const archive = await engine.get(
      'SELECT name, role FROM folders WHERE account_id = ? AND remote_id = ?',
      [account.id, 'mb-new-archives'],
    );
    expect(archive).toMatchObject({ name: 'Archives', role: 'archive' });
  });

  it('resolves remote parentId references to local parent_id integers', async () => {
    const transport = new MockTransport();
    transport.handle('Mailbox/get', () => ({
      list: [
        { id: 'mb-archive', name: 'Archive', role: 'archive' },
        { id: 'mb-2024', name: '2024', parentId: 'mb-archive' },
        { id: 'mb-2023', name: '2023', parentId: 'mb-archive' },
      ],
      state: 'mb-state-2',
    }));
    await syncMailboxes({ transport, account, handlers });

    const archive = await engine.get(
      'SELECT id FROM folders WHERE account_id = ? AND remote_id = ?',
      [account.id, 'mb-archive'],
    );
    const children = await engine.all(
      'SELECT remote_id FROM folders WHERE account_id = ? AND parent_id = ? ORDER BY name',
      [account.id, archive.id],
    );
    expect(children.map((c) => c.remote_id).sort()).toEqual(['mb-2023', 'mb-2024']);
  });

  it('persists isSubscribed and preserves it when a later sync omits the property', async () => {
    const transport = new MockTransport();
    transport.handle('Mailbox/get', () => ({
      list: [
        { id: 'mb-inbox', name: 'Inbox', role: 'inbox', isSubscribed: true },
        { id: 'mb-archives', name: 'Archives', role: 'archive', isSubscribed: true },
        { id: 'mb-shared', name: 'Shared', isSubscribed: false },
      ],
      state: 'mb-sub-1',
    }));
    await syncMailboxes({ transport, account, handlers });

    let rows = await engine.all(
      'SELECT remote_id, is_subscribed FROM folders WHERE account_id = ? ORDER BY remote_id',
      [account.id],
    );
    expect(rows).toEqual([
      { remote_id: 'mb-archives', is_subscribed: 1 },
      { remote_id: 'mb-inbox', is_subscribed: 1 },
      { remote_id: 'mb-shared', is_subscribed: 0 },
    ]);

    // A payload without isSubscribed (e.g. from a server that omits the
    // property) must not clobber the stored flag: the upsert COALESCEs
    // NULL onto the existing value.
    transport.handle('Mailbox/get', () => ({
      list: [
        { id: 'mb-inbox', name: 'Inbox', role: 'inbox' },
        { id: 'mb-archives', name: 'Archives', role: 'archive' },
        { id: 'mb-shared', name: 'Shared' },
      ],
      state: 'mb-sub-2',
    }));
    await syncMailboxes({ transport, account, handlers });

    rows = await engine.all(
      'SELECT remote_id, is_subscribed FROM folders WHERE account_id = ? ORDER BY remote_id',
      [account.id],
    );
    expect(rows).toEqual([
      { remote_id: 'mb-archives', is_subscribed: 1 },
      { remote_id: 'mb-inbox', is_subscribed: 1 },
      { remote_id: 'mb-shared', is_subscribed: 0 },
    ]);
  });

  it('pages past the server get cap when the first response fills it', async () => {
    const all = [
      { id: 'mb-inbox', name: 'Inbox', role: 'inbox' },
      { id: 'mb-archives', name: 'Archives', role: 'archive' },
      { id: 'mb-a', name: 'Alpha' },
      { id: 'mb-b', name: 'Beta' },
      { id: 'mb-c', name: 'Gamma' },
    ];
    const transport = new MockTransport({
      capabilities: {
        'urn:ietf:params:jmap:core': { maxObjectsInGet: 2 },
      },
    });
    transport.handle('Mailbox/get', (params) => {
      // Server truncates an unpaged get at the cap, like Stalwart does.
      const list = params.ids == null
        ? all.slice(0, 2)
        : all.filter((m) => params.ids.includes(m.id));
      return { list, state: 'mb-paged-1' };
    });
    transport.handle('Mailbox/query', (params) => ({
      ids: all.slice(params.position, params.position + params.limit).map((m) => m.id),
      total: all.length,
      position: params.position,
    }));

    const result = await syncMailboxes({ transport, account, handlers });

    expect(result.count).toBe(5);
    const rows = await engine.all(
      'SELECT remote_id FROM folders WHERE account_id = ? AND is_deleted = 0 ORDER BY remote_id',
      [account.id],
    );
    expect(rows.map((r) => r.remote_id)).toEqual(
      ['mb-a', 'mb-archives', 'mb-b', 'mb-c', 'mb-inbox'],
    );
  });

  it('tombstones local folders missing from an authoritative full sync', async () => {
    const transport = new MockTransport();
    transport.handle('Mailbox/get', () => ({
      list: [
        { id: 'mb-inbox', name: 'Inbox', role: 'inbox' },
        { id: 'mb-archives', name: 'Archives', role: 'archive' },
      ],
      state: 'mb-ts-1',
    }));
    // Simulate a folder destroyed while we were offline.
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [{ remoteId: 'mb-gone', name: 'Gone' }],
    });

    await syncMailboxes({ transport, account, handlers });

    const gone = await engine.get(
      'SELECT is_deleted FROM folders WHERE account_id = ? AND remote_id = ?',
      [account.id, 'mb-gone'],
    );
    expect(Number(gone.is_deleted)).toBe(1);
    const inbox = await engine.get(
      'SELECT is_deleted FROM folders WHERE account_id = ? AND remote_id = ?',
      [account.id, 'mb-inbox'],
    );
    expect(Number(inbox.is_deleted)).toBe(0);
  });

  it('skips archive repair when repairArchive is false (shared accounts)', async () => {
    const transport = new MockTransport();
    transport.handle('Mailbox/get', () => ({
      list: [
        { id: 'mb-inbox', name: 'Inbox', role: 'inbox' },
        { id: 'mb-docs', name: 'Documents' },
      ],
      state: 'mb-noarch',
    }));
    let setCalls = 0;
    transport.handle('Mailbox/set', () => {
      setCalls += 1;
      throw new Error('Mailbox/set must not run for shared accounts');
    });

    const result = await syncMailboxes({
      transport, account, handlers, repairArchive: false,
    });

    expect(setCalls).toBe(0);
    expect(result.count).toBe(2);
    expect(result.state).toBe('mb-noarch');
  });
});

describe('syncMailboxChanges (delta sync)', () => {
  it('creates and updates folders, marks destroyed folders deleted', async () => {
    const transport = new MockTransport();
    transport.handle('Mailbox/get', () => ({
      list: [
        { id: 'mb-inbox', name: 'Inbox', role: 'inbox' },
        { id: 'mb-existing-archive', name: 'Archives', role: 'archive' },
      ],
      state: 's0',
    }));
    await syncMailboxes({ transport, account, handlers });

    transport.handle('Mailbox/changes', () => ({
      oldState: 's0',
      newState: 's1',
      hasMoreChanges: false,
      created: ['mb-archive'],
      updated: ['mb-inbox'],
      destroyed: ['mb-old'],
    }));
    transport.handle('Mailbox/get', (params) => {
      const list = [];
      if (params.ids.includes('mb-inbox')) {
        list.push({ id: 'mb-inbox', name: 'Inbox', role: 'inbox', unreadEmails: 5 });
      }
      if (params.ids.includes('mb-archive')) {
        list.push({ id: 'mb-archive', name: 'Archive', role: 'archive' });
      }
      return { list, state: 's1' };
    });

    // Pre-seed a folder we will then destroy.
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [{ remoteId: 'mb-old', name: 'Old' }],
    });

    const result = await syncMailboxChanges({
      transport, account, handlers, sinceState: 's0',
    });
    expect(result.needsFullSync).toBe(false);
    expect(result.newState).toBe('s1');

    const inbox = await engine.get(
      'SELECT unread_emails FROM folders WHERE account_id = ? AND remote_id = ?',
      [account.id, 'mb-inbox'],
    );
    expect(Number(inbox.unread_emails)).toBe(5);

    const archive = await engine.get(
      'SELECT role FROM folders WHERE account_id = ? AND remote_id = ?',
      [account.id, 'mb-archive'],
    );
    expect(archive.role).toBe('archive');

    const old = await engine.get(
      'SELECT is_deleted FROM folders WHERE account_id = ? AND remote_id = ?',
      [account.id, 'mb-old'],
    );
    expect(Number(old.is_deleted)).toBe(1);

    const stateRow = await handlers[DB_RPC.SYNC_STATE_GET]({
      accountId: account.id,
      objectType: 'Mailbox',
    });
    expect(stateRow.state).toBe('s1');
  });

  it('follows hasMoreChanges across multiple Mailbox/changes pages', async () => {
    const transport = new MockTransport();
    transport.handle('Mailbox/changes', (params) => (
      params.sinceState === 's0'
        ? { oldState: 's0', newState: 's1', hasMoreChanges: true, created: ['mb-p1'], updated: [], destroyed: [] }
        : { oldState: 's1', newState: 's2', hasMoreChanges: false, created: ['mb-p2'], updated: [], destroyed: [] }
    ));
    transport.handle('Mailbox/get', (params) => ({
      list: params.ids.map((id) => ({ id, name: id })),
      state: 's2',
    }));

    const result = await syncMailboxChanges({
      transport, account, handlers, sinceState: 's0',
    });

    expect(result.needsFullSync).toBe(false);
    expect(result.created).toEqual(['mb-p1', 'mb-p2']);
    expect(result.newState).toBe('s2');
    const rows = await engine.all(
      'SELECT remote_id FROM folders WHERE account_id = ? ORDER BY remote_id',
      [account.id],
    );
    expect(rows.map((r) => r.remote_id)).toEqual(['mb-p1', 'mb-p2']);
  });
});
