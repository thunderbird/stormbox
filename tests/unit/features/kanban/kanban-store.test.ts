// @vitest-environment happy-dom

import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

vi.mock('../../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import { useAuthStore } from '../../../../src/stores/auth-store';
import {
  isUnlockCode,
  kanbanStorageKey,
  useKanbanStore,
} from '../../../../src/features/kanban/kanban-store';

function signIn(accountId: number, email = 'boss@thunderbird.net') {
  const authStore = useAuthStore();
  authStore.accountId = accountId;
  authStore.email = email;
  return authStore;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

describe('isUnlockCode', () => {
  it('accepts the code case-insensitively with surrounding whitespace', () => {
    expect(isUnlockCode('kanban')).toBe(true);
    expect(isUnlockCode('  KanBan ')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isUnlockCode('kanbanx')).toBe(false);
    expect(isUnlockCode('')).toBe(false);
    expect(isUnlockCode(null)).toBe(false);
    expect(isUnlockCode(undefined)).toBe(false);
  });
});

describe('kanban-store', () => {
  it('starts locked and disabled so nothing changes for a fresh account', () => {
    signIn(7);
    const kanban = useKanbanStore();
    expect(kanban.unlocked).toBe(false);
    expect(kanban.enabled).toBe(false);
    expect(kanban.columnFolderRemoteIds).toEqual([null, null]);
  });

  it('unlock() enables the board, reports the first unlock once, and persists', () => {
    signIn(7);
    const kanban = useKanbanStore();

    expect(kanban.unlock()).toBe(true);
    expect(kanban.unlocked).toBe(true);
    expect(kanban.enabled).toBe(true);
    expect(kanban.unlock()).toBe(false);

    const raw = JSON.parse(localStorage.getItem(kanbanStorageKey(7)) ?? 'null');
    expect(raw).toEqual({ unlocked: true, enabled: true, columns: [null, null] });
  });

  it('setEnabled() is a no-op while locked and toggles after unlocking', () => {
    signIn(7);
    const kanban = useKanbanStore();
    kanban.setEnabled(true);
    expect(kanban.enabled).toBe(false);

    kanban.unlock();
    kanban.setEnabled(false);
    expect(kanban.unlocked).toBe(true);
    expect(kanban.enabled).toBe(false);
    kanban.setEnabled(true);
    expect(kanban.enabled).toBe(true);
  });

  it('restores persisted state for the signed-in account only', async () => {
    localStorage.setItem(kanbanStorageKey(7), JSON.stringify({
      unlocked: true, enabled: true, columns: ['mb-a', null],
    }));
    const authStore = signIn(7);
    const kanban = useKanbanStore();
    expect(kanban.enabled).toBe(true);
    expect(kanban.columnFolderRemoteIds).toEqual(['mb-a', null]);

    authStore.accountId = 8;
    await nextTick();
    expect(kanban.unlocked).toBe(false);
    expect(kanban.enabled).toBe(false);
    expect(kanban.columnFolderRemoteIds).toEqual([null, null]);
  });

  it('is never enabled without a signed-in account', () => {
    localStorage.setItem(kanbanStorageKey(7), JSON.stringify({ unlocked: true, enabled: true, columns: [] }));
    const kanban = useKanbanStore();
    expect(kanban.enabled).toBe(false);
  });

  it('is never enabled for a non-staff session, even with a persisted unlock', async () => {
    // The same local account can be reached through staff OIDC and later
    // through a non-staff login; the persisted flag alone must not
    // surface the board.
    localStorage.setItem(kanbanStorageKey(7), JSON.stringify({ unlocked: true, enabled: true, columns: [] }));
    const authStore = signIn(7, 'someone@customer.example');
    const kanban = useKanbanStore();
    expect(kanban.unlocked).toBe(true);
    expect(kanban.enabled).toBe(false);

    authStore.email = 'boss@thunderbird.net';
    await nextTick();
    expect(kanban.enabled).toBe(true);
  });

  it('ignores malformed persisted data', () => {
    localStorage.setItem(kanbanStorageKey(7), '{not json');
    signIn(7);
    const kanban = useKanbanStore();
    expect(kanban.unlocked).toBe(false);
    expect(kanban.columnFolderRemoteIds).toEqual([null, null]);

    localStorage.setItem(kanbanStorageKey(7), JSON.stringify({ unlocked: 'yes', columns: [42, 'ok'] }));
    kanban.$reset();
    expect(kanban.unlocked).toBe(false);
    expect(kanban.columnFolderRemoteIds).toEqual([null, 'ok']);
  });

  it('setColumnFolder() stores per slot and setDefaultColumns() only fills empty slots', () => {
    signIn(7);
    const kanban = useKanbanStore();
    kanban.setColumnFolder(2, 'mb-user-pick');
    expect(kanban.columnFolderRemoteIds).toEqual([null, 'mb-user-pick']);

    kanban.setDefaultColumns(['mb-needs-reply', 'mb-blocked']);
    expect(kanban.columnFolderRemoteIds).toEqual(['mb-needs-reply', 'mb-user-pick']);

    kanban.setColumnFolder(1, null);
    expect(kanban.columnFolderRemoteIds).toEqual([null, 'mb-user-pick']);
    expect(JSON.parse(localStorage.getItem(kanbanStorageKey(7)) ?? 'null').columns)
      .toEqual([null, 'mb-user-pick']);
  });

  it('tracks seed progress in memory only', () => {
    signIn(7);
    const kanban = useKanbanStore();
    kanban.setSeedState('running');
    expect(kanban.seedState).toBe('running');
    kanban.setSeedState('failed', 'boom');
    expect(kanban.seedError).toBe('boom');
    expect(localStorage.getItem(kanbanStorageKey(7))).toBeNull();
  });

  it('holds one selection, keyed by folder, in memory only', async () => {
    const authStore = signIn(7);
    const kanban = useKanbanStore();
    expect(kanban.hasSelection).toBe(false);

    kanban.setSelection(3, new Set([1, 2]));
    expect(kanban.selectionFolderId).toBe(3);
    expect([...kanban.selectedIds]).toEqual([1, 2]);
    expect(kanban.hasSelection).toBe(true);

    // Another folder taking the selection replaces it outright.
    kanban.setSelection(4, new Set([9]));
    expect(kanban.selectionFolderId).toBe(4);
    expect([...kanban.selectedIds]).toEqual([9]);

    // Clearing for a folder that does not hold it is a no-op.
    kanban.clearSelection(3);
    expect(kanban.hasSelection).toBe(true);
    kanban.clearSelection(4);
    expect(kanban.hasSelection).toBe(false);
    expect(kanban.selectionFolderId).toBeNull();

    // An empty set is a clear.
    kanban.setSelection(4, new Set([9]));
    kanban.setSelection(4, new Set());
    expect(kanban.hasSelection).toBe(false);

    kanban.setSelection(4, new Set([9]));
    expect(localStorage.getItem(kanbanStorageKey(7))).toBeNull();
    authStore.accountId = 8;
    await nextTick();
    expect(kanban.hasSelection).toBe(false);
  });
});
