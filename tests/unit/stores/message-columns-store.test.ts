// @vitest-environment happy-dom

/**
 * Column configuration store: the extra message list columns, their
 * folders (stored by JMAP mailbox id so a cache reset keeps them) and
 * every column's width, persisted per account.
 */

import {
  describe, it, expect, beforeEach, vi,
} from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import { useAuthStore } from '../../../src/stores/auth-store';
import { useMailStore } from '../../../src/stores/mail-store';
import {
  MAX_MESSAGE_COLUMNS,
  MESSAGE_COLUMN_DEFAULT_WIDTH,
  MESSAGE_COLUMN_MAX_WIDTH,
  MESSAGE_COLUMN_MIN_WIDTH,
  PRIMARY_COLUMN_ID,
  useMessageColumnsStore,
} from '../../../src/stores/message-columns-store';

function makeAccount(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    display_name: `Account ${id}`,
    primary_email: `user${id}@example.org`,
    server_origin: 'https://mail.example.org',
    remote_account_id: `acct-${id}`,
    is_primary: id === 1 ? 1 : 0,
    ...overrides,
  } as any;
}

function makeFolder(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    account_id: 1,
    remote_id: `mb-${id}`,
    name: `Folder ${id}`,
    role: id === 1 ? 'inbox' : null,
    parent_id: null,
    is_deleted: 0,
    is_subscribed: 1,
    ...overrides,
  } as any;
}

function seedSession() {
  useAuthStore().accountId = 1;
  const mailStore = useMailStore();
  mailStore.accounts = [makeAccount(1), makeAccount(2)];
  mailStore.folders = [
    makeFolder(1, { name: 'Inbox' }),
    makeFolder(2, { name: 'Archive', role: 'archive' }),
    makeFolder(3, { name: 'Projects' }),
    makeFolder(30, { account_id: 2, name: 'Shared Team' }),
  ];
  mailStore.currentFolderId = 1;
  return mailStore;
}

beforeEach(() => {
  window.localStorage?.clear();
  setActivePinia(createPinia());
});

describe('message columns store', () => {
  it('starts with the primary column following the folder list selection', () => {
    const mailStore = seedSession();
    const store = useMessageColumnsStore();

    expect(store.columns).toEqual([{
      id: PRIMARY_COLUMN_ID,
      primary: true,
      folderId: 1,
      width: MESSAGE_COLUMN_DEFAULT_WIDTH,
    }]);

    mailStore.currentFolderId = 2;
    expect(store.columns[0].folderId).toBe(2);
  });

  it('adds columns without a folder up to the limit and removes them by id', () => {
    seedSession();
    const store = useMessageColumnsStore();

    const added: string[] = [];
    for (let i = 1; i < MAX_MESSAGE_COLUMNS; i += 1) {
      expect(store.canAddColumn).toBe(true);
      const id = store.addColumn();
      expect(id).not.toBeNull();
      added.push(id!);
    }
    expect(store.columns).toHaveLength(MAX_MESSAGE_COLUMNS);
    expect(new Set(added).size).toBe(MAX_MESSAGE_COLUMNS - 1);
    expect(store.columns.slice(1).every((column) => column.folderId === null)).toBe(true);

    expect(store.canAddColumn).toBe(false);
    expect(store.addColumn()).toBeNull();
    expect(store.columns).toHaveLength(MAX_MESSAGE_COLUMNS);

    store.removeColumn(added[2]);
    expect(store.columns.map((column) => column.id)).not.toContain(added[2]);
    expect(store.columns).toHaveLength(MAX_MESSAGE_COLUMNS - 1);
    expect(store.canAddColumn).toBe(true);

    // The primary column cannot be removed.
    store.removeColumn(PRIMARY_COLUMN_ID);
    expect(store.columns[0].id).toBe(PRIMARY_COLUMN_ID);
  });

  it('stores a column folder by mailbox and account remote id and resolves it back to the local row', () => {
    const mailStore = seedSession();
    const store = useMessageColumnsStore();
    const id = store.addColumn()!;

    store.setColumnFolder(id, 30);
    expect(store.extraColumns[0].folder).toEqual({
      accountRemoteId: 'acct-2',
      mailboxRemoteId: 'mb-30',
    });
    expect(store.columns[1].folderId).toBe(30);

    // A cache reset gives the folder a new local id; the column follows it.
    mailStore.folders = [
      ...mailStore.folders.filter((folder) => folder.id !== 30),
      makeFolder(77, { account_id: 2, remote_id: 'mb-30', name: 'Shared Team' }),
    ];
    expect(store.columns[1].folderId).toBe(77);

    // A deleted folder leaves the column in its choose-a-folder state.
    mailStore.folders = mailStore.folders.map((folder) => (
      folder.id === 77 ? { ...folder, is_deleted: 1 } : folder
    ));
    expect(store.columns[1].folderId).toBeNull();
  });

  it('clamps column widths to the allowed range for every column', () => {
    seedSession();
    const store = useMessageColumnsStore();
    const id = store.addColumn()!;

    store.setColumnWidth(PRIMARY_COLUMN_ID, 100);
    store.setColumnWidth(id, 5000);
    expect(store.columnWidth(PRIMARY_COLUMN_ID)).toBe(MESSAGE_COLUMN_MIN_WIDTH);
    expect(store.columnWidth(id)).toBe(MESSAGE_COLUMN_MAX_WIDTH);

    store.setColumnWidth(id, 412.6);
    expect(store.columnWidth(id)).toBe(413);
    expect(store.columns[1].width).toBe(413);
  });

  it('persists the layout per account and restores it in a fresh store', async () => {
    seedSession();
    const store = useMessageColumnsStore();
    const id = store.addColumn()!;
    store.setColumnFolder(id, 2);
    store.setColumnWidth(id, 400);
    store.setColumnWidth(PRIMARY_COLUMN_ID, 300);
    await nextTick();

    const key = store.accountKey!;
    expect(key).toBe('stormbox.messageColumns.v1:https://mail.example.org|acct-1');
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual({
      primaryWidth: 300,
      columns: [{ id, folder: { accountRemoteId: 'acct-1', mailboxRemoteId: 'mb-2' }, width: 400 }],
    });

    // A reload: new Pinia, the account row arrives after the store exists.
    setActivePinia(createPinia());
    useAuthStore().accountId = 1;
    const restored = useMessageColumnsStore();
    expect(restored.columns).toHaveLength(1);
    const mailStore = seedSession();
    await nextTick();
    expect(restored.columns).toHaveLength(2);
    expect(restored.columns[0].width).toBe(300);
    expect(restored.columns[1]).toMatchObject({ id, folderId: 2, width: 400 });

    // Another account on the same origin has its own layout.
    mailStore.accounts = [makeAccount(1, { remote_account_id: 'acct-other' })];
    await nextTick();
    expect(restored.columns).toHaveLength(1);
  });

  it('shows a restored column whose folder no longer exists in its choose-a-folder state', async () => {
    seedSession();
    const store = useMessageColumnsStore();
    const id = store.addColumn()!;
    store.setColumnFolder(id, 3);
    await nextTick();

    setActivePinia(createPinia());
    useAuthStore().accountId = 1;
    const mailStore = useMailStore();
    mailStore.accounts = [makeAccount(1)];
    mailStore.folders = [makeFolder(1, { name: 'Inbox' })];
    const restored = useMessageColumnsStore();
    await nextTick();

    expect(restored.columns).toHaveLength(2);
    expect(restored.columns[1].folderId).toBeNull();
    expect(restored.extraColumns[0].folder).toEqual({
      accountRemoteId: 'acct-1',
      mailboxRemoteId: 'mb-3',
    });
  });

  it('starts an account without a layout at the width the single list had before columns existed', async () => {
    window.localStorage.setItem('stormbox.mailColumnWidths.v1', JSON.stringify({ folderList: 240, messageList: 480 }));
    seedSession();
    const store = useMessageColumnsStore();
    expect(store.columns[0].width).toBe(480);
    await nextTick();
    // The seed is persisted as the account's own layout from then on.
    expect(JSON.parse(window.localStorage.getItem(store.accountKey!)!).primaryWidth).toBe(480);

    // A stored layout wins over the legacy width; an out-of-range legacy width is clamped.
    window.localStorage.setItem(store.accountKey!, JSON.stringify({ primaryWidth: 300, columns: [] }));
    setActivePinia(createPinia());
    seedSession();
    expect(useMessageColumnsStore().columns[0].width).toBe(300);

    window.localStorage.clear();
    window.localStorage.setItem('stormbox.mailColumnWidths.v1', JSON.stringify({ messageList: 5000 }));
    setActivePinia(createPinia());
    seedSession();
    expect(useMessageColumnsStore().columns[0].width).toBe(MESSAGE_COLUMN_MAX_WIDTH);

    window.localStorage.clear();
    window.localStorage.setItem('stormbox.mailColumnWidths.v1', '{"messageList":"wide"}');
    setActivePinia(createPinia());
    seedSession();
    expect(useMessageColumnsStore().columns[0].width).toBe(MESSAGE_COLUMN_DEFAULT_WIDTH);
  });

  it('ignores malformed stored layouts', () => {
    window.localStorage.setItem(
      'stormbox.messageColumns.v1:https://mail.example.org|acct-1',
      '{"primaryWidth":"wide","columns":[{"width":"x"},null,{"id":"c9","folder":{"mailboxRemoteId":"mb-2"}}]}',
    );
    seedSession();
    const store = useMessageColumnsStore();

    expect(store.columns[0].width).toBe(MESSAGE_COLUMN_DEFAULT_WIDTH);
    expect(store.columns).toHaveLength(3);
    expect(store.columns[1]).toMatchObject({ folderId: null, width: MESSAGE_COLUMN_DEFAULT_WIDTH });
    expect(store.columns[2]).toMatchObject({ id: 'c9', folderId: null });
  });
});
