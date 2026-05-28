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
      ],
      state: 'mb-state-1',
    }));
    const result = await syncMailboxes({ transport, account, handlers });
    expect(result.count).toBe(2);
    expect(result.state).toBe('mb-state-1');

    const folders = await handlers[DB_RPC.FOLDER_LIST]({ accountId: account.id });
    expect(folders.map((f) => f.role)).toEqual(['inbox', 'sent']);

    const inbox = folders.find((f) => f.role === 'inbox');
    expect(Number(inbox.total_emails)).toBe(3);
    expect(Number(inbox.unread_emails)).toBe(1);

    const stateRow = await handlers[DB_RPC.SYNC_STATE_GET]({
      accountId: account.id,
      objectType: 'Mailbox',
    });
    expect(stateRow.state).toBe('mb-state-1');
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
});

describe('syncMailboxChanges (delta sync)', () => {
  it('creates and updates folders, marks destroyed folders deleted', async () => {
    const transport = new MockTransport();
    transport.handle('Mailbox/get', () => ({
      list: [{ id: 'mb-inbox', name: 'Inbox', role: 'inbox' }],
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
});
