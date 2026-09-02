// @vitest-environment happy-dom

import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

const mailStoreMock = vi.hoisted(() => {
  const folders = { value: [] as any[] };
  const store = {
    get primaryFolders() { return folders.value; },
    createFolder: vi.fn(),
    refreshFolders: vi.fn(async () => {}),
  };
  return { store, folders, createFolder: store.createFolder, refreshFolders: store.refreshFolders };
});

vi.mock('../../../../src/stores/mail-store', () => ({
  useMailStore: () => mailStoreMock.store,
}));

import {
  __resetRepositoryForTests,
  __setRepositoryForTests,
} from '../../../../src/composables/useRepository';
import { MUTATION_TYPE } from '../../../../src/constants/states';
import { useAuthStore } from '../../../../src/stores/auth-store';
import { useKanbanStore } from '../../../../src/features/kanban/kanban-store';
import { buildSeedEmails, seedKanbanFolders } from '../../../../src/features/kanban/kanban-seed';
import {
  BLOCKED_MAILS,
  NEEDS_REPLY_MAILS,
} from '../../../../src/features/kanban/kanban-seed-data';

const ACCOUNT_ID = 3;

function folder(id: number, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    account_id: ACCOUNT_ID,
    remote_id: `mb-${id}`,
    name,
    role: null,
    parent_id: null,
    is_deleted: 0,
    total_emails: 0,
    ...extra,
  };
}

function makeRepo() {
  let nextId = 100;
  const mutations: any[] = [];
  const repo = {
    mutations,
    runOutcome: { succeeded: 1, failed: 0, result: { succeededIds: [] as string[] } } as any,
    subscribe() { return () => {}; },
    insertPendingMutation: vi.fn(async (row) => {
      const stored = { id: nextId++, ...row };
      mutations.push(stored);
      return stored;
    }),
    runMutation: vi.fn(async () => repo.runOutcome),
    getPendingMutationError: vi.fn(async () => ({ error_json: JSON.stringify({ type: 'overQuota' }) })),
    ensureFolderTree: undefined as undefined | ReturnType<typeof vi.fn>,
  };
  return repo;
}

let repo: ReturnType<typeof makeRepo>;

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  __resetRepositoryForTests();
  repo = makeRepo();
  __setRepositoryForTests(repo);
  mailStoreMock.folders.value = [
    folder(1, 'Inbox', { role: 'inbox', total_emails: 40 }),
  ];
  mailStoreMock.createFolder.mockReset();
  mailStoreMock.refreshFolders.mockClear();
  const authStore = useAuthStore();
  authStore.accountId = ACCOUNT_ID;
  authStore.email = 'boss@thunderbird.net';
});

describe('buildSeedEmails', () => {
  it('turns static mail into CREATE_EMAILS specs addressed to the signed-in user', () => {
    const now = Date.parse('2026-09-01T12:00:00Z');
    const specs = buildSeedEmails(NEEDS_REPLY_MAILS, { email: 'boss@thunderbird.net' }, now);
    expect(specs).toHaveLength(15);
    expect(specs[0].clientId).toBe('seed1');
    expect(specs[14].clientId).toBe('seed15');
    for (const [i, s] of specs.entries()) {
      expect(s.to).toEqual([{ email: 'boss@thunderbird.net' }]);
      expect(s.receivedAt).toBe(now - NEEDS_REPLY_MAILS[i].ageHours * 3_600_000);
      expect(s.keywords).toEqual(NEEDS_REPLY_MAILS[i].seen ? { $seen: true } : {});
      expect(s.textBody.length).toBeGreaterThan(20);
      expect(s.subject.length).toBeGreaterThan(3);
    }
  });

  it('ships exactly 15 Needs Reply and 23 Blocked mails with distinct subjects', () => {
    expect(NEEDS_REPLY_MAILS).toHaveLength(15);
    expect(BLOCKED_MAILS).toHaveLength(23);
    const subjects = [...NEEDS_REPLY_MAILS, ...BLOCKED_MAILS].map((m) => m.subject);
    expect(new Set(subjects).size).toBe(subjects.length);
  });
});

describe('seedKanbanFolders', () => {
  it('creates both folders, files the mail through the outbox and sets the default columns', async () => {
    let created = 0;
    mailStoreMock.createFolder.mockImplementation(async ({ name }) => {
      created += 1;
      mailStoreMock.folders.value = [...mailStoreMock.folders.value, folder(10 + created, name)];
      return { ok: true };
    });

    const result = await seedKanbanFolders({ now: () => 1_000_000, sleep: async () => {} });

    expect(mailStoreMock.createFolder.mock.calls.map((c) => c[0])).toEqual([
      { name: 'Needs Reply' }, { name: 'Blocked' },
    ]);
    expect(repo.insertPendingMutation).toHaveBeenCalledTimes(2);
    const [first, second] = repo.mutations;
    expect(first.mutationType).toBe(MUTATION_TYPE.CREATE_EMAILS);
    expect(first.accountId).toBe(ACCOUNT_ID);
    expect(first.targetMessageId).toBeNull();
    const firstReq = JSON.parse(first.requestJson);
    expect(firstReq.folderId).toBe(11);
    expect(firstReq.emails).toHaveLength(15);
    expect(firstReq.emails[0].to).toEqual([{ email: 'boss@thunderbird.net' }]);
    const secondReq = JSON.parse(second.requestJson);
    expect(secondReq.folderId).toBe(12);
    expect(secondReq.emails).toHaveLength(23);

    expect(repo.runMutation.mock.calls).toEqual([[ACCOUNT_ID, 100], [ACCOUNT_ID, 101]]);
    expect(result).toEqual({ needsReplyFolderId: 11, blockedFolderId: 12, created: 38 });

    const kanban = useKanbanStore();
    expect(kanban.columnFolderRemoteIds).toEqual(['mb-11', 'mb-12']);
  });

  it('reuses existing folders (case-insensitively) and skips ones that already hold mail', async () => {
    mailStoreMock.folders.value = [
      folder(1, 'Inbox', { role: 'inbox' }),
      folder(21, 'needs reply', { total_emails: 15 }),
      folder(22, 'Blocked', { total_emails: 0 }),
      folder(23, 'Blocked', { parent_id: 21 }),
    ];

    const result = await seedKanbanFolders({ now: () => 0, sleep: async () => {} });

    expect(mailStoreMock.createFolder).not.toHaveBeenCalled();
    expect(repo.insertPendingMutation).toHaveBeenCalledTimes(1);
    expect(JSON.parse(repo.mutations[0].requestJson).folderId).toBe(22);
    expect(result).toEqual({ needsReplyFolderId: 21, blockedFolderId: 22, created: 23 });
  });

  it('trusts the server, not the cache, when deciding whether a folder already holds mail', async () => {
    // The cached counter says empty; the authoritative Mailbox/get
    // refresh (repo.ensureFolderTree) reveals the seed already landed.
    mailStoreMock.folders.value = [
      folder(1, 'Inbox', { role: 'inbox' }),
      folder(21, 'Needs Reply', { total_emails: 0 }),
      folder(22, 'Blocked', { total_emails: 0 }),
    ];
    repo.ensureFolderTree = vi.fn(async () => {
      mailStoreMock.folders.value = [
        folder(1, 'Inbox', { role: 'inbox' }),
        folder(21, 'Needs Reply', { total_emails: 15 }),
        folder(22, 'Blocked', { total_emails: 23 }),
      ];
    });

    const result = await seedKanbanFolders({ now: () => 0, sleep: async () => {} });

    expect(repo.ensureFolderTree).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(repo.insertPendingMutation).not.toHaveBeenCalled();
    expect(result.created).toBe(0);
  });

  it('does nothing twice: a second run after a full seed creates no mail', async () => {
    mailStoreMock.folders.value = [
      folder(1, 'Inbox', { role: 'inbox' }),
      folder(21, 'Needs Reply', { total_emails: 15 }),
      folder(22, 'Blocked', { total_emails: 23 }),
    ];
    const result = await seedKanbanFolders({ now: () => 0, sleep: async () => {} });
    expect(repo.insertPendingMutation).not.toHaveBeenCalled();
    expect(result.created).toBe(0);
  });

  it('keeps a column the user already picked', async () => {
    const kanban = useKanbanStore();
    kanban.unlock();
    kanban.setColumnFolder(1, 'mb-user');
    mailStoreMock.folders.value = [
      folder(1, 'Inbox', { role: 'inbox' }),
      folder(21, 'Needs Reply', { total_emails: 1 }),
      folder(22, 'Blocked', { total_emails: 1 }),
    ];
    await seedKanbanFolders({ now: () => 0, sleep: async () => {} });
    expect(kanban.columnFolderRemoteIds).toEqual(['mb-user', 'mb-22']);
  });

  it('waits for a created folder to appear and fails after the deadline', async () => {
    mailStoreMock.createFolder.mockResolvedValue({ ok: true });
    let clock = 0;
    await expect(seedKanbanFolders({
      now: () => clock,
      sleep: async () => { clock += 5000; },
    })).rejects.toThrow(/did not appear/);
    expect(mailStoreMock.refreshFolders).toHaveBeenCalled();
  });

  it('surfaces a createFolder failure other than duplicateName', async () => {
    mailStoreMock.createFolder.mockResolvedValue({ ok: false, reason: 'serverFail' });
    await expect(seedKanbanFolders({ now: () => 0, sleep: async () => {} }))
      .rejects.toThrow(/Could not create folder "Needs Reply" \(serverFail\)/);
    expect(repo.insertPendingMutation).not.toHaveBeenCalled();
  });

  it('reports the outbox error type when the create mutation fails', async () => {
    mailStoreMock.folders.value = [
      folder(1, 'Inbox', { role: 'inbox' }),
      folder(21, 'Needs Reply'),
      folder(22, 'Blocked'),
    ];
    repo.runOutcome = { succeeded: 0, failed: 1, result: { succeededIds: ['seed1'] } };
    await expect(seedKanbanFolders({ now: () => 0, sleep: async () => {} }))
      .rejects.toThrow(/Seeding "Needs Reply" failed \(overQuota\); 1 of 15 created/);
  });

  it('refuses to run without a signed-in account', async () => {
    useAuthStore().accountId = null;
    await expect(seedKanbanFolders()).rejects.toThrow(/Not signed in/);
  });

  it('refuses to address the mail when the session has no email claim', async () => {
    // A bare basic-auth username is not an address; it must never land in
    // a JMAP `to` field.
    useAuthStore().email = null;
    useAuthStore().username = 'boss';
    await expect(seedKanbanFolders({ now: () => 0, sleep: async () => {} }))
      .rejects.toThrow(/email/i);
    expect(repo.insertPendingMutation).not.toHaveBeenCalled();
  });
});
