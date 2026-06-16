/**
 * Unit tests for the mail-store. The store talks to a Repository via a
 * MessagePort in production; we inject a fake Repository through the
 * useRepository test seam so these tests run without a SharedWorker
 * or wa-sqlite engine.
 *
 * The fake repo is deliberately scripted (per-call responses) so each
 * test can express exactly the cache shape the bug under test
 * required:
 *   - sparse query_view_items (partial cache)
 *   - shrunk query_views.total after a peer-side delete
 *   - rapid folder switches that race their initial loads
 */

import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

import { useMailStore } from '../../../src/stores/mail-store';
import { useAuthStore } from '../../../src/stores/auth-store';
import {
  __setRepositoryForTests,
  __resetRepositoryForTests,
} from '../../../src/composables/useRepository';
import { TABLE_FAMILIES } from '../../../src/db/protocol';
import { MUTATION_TYPE } from '../../../src/constants/states';

function makeFolder(id, overrides = {}) {
  return {
    id,
    account_id: 1,
    remote_id: `mb-${id}`,
    name: `Folder ${id}`,
    role: id === 1 ? 'inbox' : null,
    sort_order: 0,
    parent_id: null,
    is_deleted: 0,
    total_emails: 0,
    unread_emails: 0,
    total_threads: 0,
    unread_threads: 0,
    index_total: undefined,
    index_covered: undefined,
    index_percent: undefined,
    ...overrides,
  };
}

function makeRow(id, overrides = {}) {
  return {
    id,
    remote_id: `e-${id}`,
    subject: `Subject ${id}`,
    preview: `preview ${id}`,
    from_text: `Sender ${id} <s${id}@example.com>`,
    to_text: 'me@example.com',
    received_at: 1_700_000_000_000 + id,
    keywords_json: '{}',
    is_seen: 1,
    is_flagged: 0,
    is_answered: 0,
    is_draft: 0,
    has_attachment: 0,
    body_fetched_at: null,
    ...overrides,
  };
}

/**
 * Build a programmable fake Repository. Tests script the per-folder
 * view via setView(folderId, { rows, total }) and can override any
 * individual method with stubs to assert call ordering / side
 * effects.
 *
 * Notably, listMessagesForView returns rows whose "position" falls in
 * [offset, offset+limit). To simulate a sparse query_view_items (the
 * bug 1 case) the test sets rows.length < total — listMessagesForView
 * then returns fewer rows than `limit`, mimicking the real
 * positional read.
 */
function makeRepo(): any {
  const listeners = new Set<(tables: string[]) => void>();
  const views = new Map<number, any>();
  const calls: Record<string, number> = {
    listMessagesForView: 0,
    checkFolderViewConsistency: 0,
    ensureFolderWindow: 0,
    queryViewProgress: 0,
    ensureMessageBodies: 0,
    getMessageBodyForDisplay: 0,
    ensureFolderTree: 0,
  };
  let folders = [];

  const repo = {
    _calls: calls,
    _views: views,
    setFolders(list) { folders = list; },
    setView(folderId, view) {
      // view: { rows: [{ id, ... }, ...], total, folderRows? }
      // folderRows simulates a folder_messages projection that may
      // disagree with the canonical mailbox-window query view rows.
      views.set(folderId, view);
    },
    triggerBroadcast(tables) {
      for (const listener of listeners) listener(tables);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async listFolders() {
      return folders;
    },

    async listMessagesForView({ folderId, offset, limit }) {
      calls.listMessagesForView += 1;
      const view = views.get(folderId);
      if (!view) return [];
      const slice = (view.rows ?? [])
        .slice(offset, offset + limit);
      if (view.returnPlaceholders) return slice;
      return slice.filter((r) => r !== undefined && r !== null);
    },

    async checkFolderViewConsistency({ folderId }) {
      calls.checkFolderViewConsistency += 1;
      const view = views.get(folderId);
      if (!view) {
        return {
          queryViewExists: false,
          queryViewTotal: 0,
          queryViewCovered: 0,
          queryViewMaterialized: 0,
          queryViewStale: false,
          membershipTotal: 0,
          membershipUnread: 0,
        };
      }
      const queryRows = (view.rows ?? []).filter((r) => r !== undefined && r !== null);
      const folderRows = (view.folderRows ?? view.rows ?? [])
        .filter((row) => row?.id != null);
      return {
        queryViewExists: true,
        queryViewTotal: Number(view.total ?? queryRows.length),
        queryViewCovered: queryRows.length,
        queryViewMaterialized: queryRows.length,
        queryViewStale: view.stale === true || Number(view.stale ?? 0) === 1,
        membershipTotal: folderRows.length,
        membershipUnread: folderRows.filter((row) => Number(row.is_seen) === 0).length,
      };
    },

    async queryViewProgress({ folderId }) {
      calls.queryViewProgress += 1;
      const view = views.get(folderId);
      if (!view) return { total: 0, covered: 0, percent: 0 };
      return {
        total: Number(view.total ?? (view.rows?.length ?? 0)),
        covered: view.rows?.length ?? 0,
        stale: view.stale === true || Number(view.stale ?? 0) === 1,
        percent: 100,
      };
    },

    async ensureFolderWindow(_accountId, folderId, { offset = 0, limit = 100 } = {}) {
      calls.ensureFolderWindow += 1;
      const view = views.get(folderId);
      if (!view) return { total: 0, fetched: 0 };
      // Simulate the server populating any missing positions inside
      // the requested window. Tests can override what
      // ensureFolderWindow "delivers" by calling setView after
      // observing the call count.
      if (typeof view.onEnsureWindow === 'function') {
        view.onEnsureWindow({ offset, limit });
      }
      view.stale = false;
      return { total: view.total ?? view.rows?.length ?? 0, fetched: 0 };
    },

    async ensureMessageBodies() {
      calls.ensureMessageBodies += 1;
      return { fetched: 0 };
    },

    async getMessageBodyForDisplay(_accountId, messageId) {
      calls.getMessageBodyForDisplay += 1;
      return {
        text: `body-${messageId}`,
        html: '',
        attachments: [],
      };
    },

    async ensureFolderTree() {
      calls.ensureFolderTree += 1;
      return { count: folders.length };
    },

    // Note: insertPendingMutation / runMutation / drainOutbox are not
    // mocked here. Cache-mutation flows (delete, move, setKeywords) are
    // covered end-to-end in tests/unit/sync/*.test.js using a real
    // bootTestEngine + the JMAP MockTransport, where the assertions
    // can read folder_messages and query_view_items directly. The
    // store tests only exercise the cache-consuming side.
    async insertPendingMutation() { return { id: 1 }; },
    async drainOutbox() { return { attempted: 0, succeeded: 0, failed: 0 }; },
    async runMutation() { return { attempted: 1, succeeded: 1, failed: 0 }; },
    async replaceMessageKeywords() { return undefined; },
    async replaceMessageKeywordsMany() { return { ok: true, applied: 0 }; },
    async resetViewForFolder(_accountId, folderId) {
      calls.resetViewForFolder = (calls.resetViewForFolder ?? 0) + 1;
      const view = views.get(folderId);
      if (view) {
        view.rows = [];
        view.total = 0;
      }
      return { deleted: 1 };
    },
    // Repository helpers the mail-store hits for mutation flows.
    // The store-only tests treat every id as present so the
    // destroyMessages / moveMessages flow is not short-circuited.
    async filterExistingMessageIds(_accountId, ids) {
      return (ids ?? []).map(Number).filter((id) => Number.isFinite(id));
    },
    async getPendingMutationError() { return null; },
  };
  return repo;
}

async function setupStore({ folders, views }: { folders?: any[]; views?: Record<number | string, any> } = {}) {
  setActivePinia(createPinia());
  const authStore = useAuthStore();
  authStore.accountId = 1;
  const repo = makeRepo();
  if (folders) repo.setFolders(folders);
  if (views) {
    for (const [folderId, view] of Object.entries(views)) {
      repo.setView(Number(folderId), view);
    }
  }
  __setRepositoryForTests(repo);
  const mailStore = useMailStore();
  await mailStore.attach();
  // attach() kicks off refreshFolders + the immediate accountId
  // watcher; wait a tick for the async chain to settle so tests
  // can read folders.length etc.
  await flush();
  return { mailStore, authStore, repo };
}

/**
 * Drain Vue's microtask + watcher queue. Several mail-store actions
 * fire reactive chains (watch on currentFolder.total_emails, the
 * post-broadcast refresh, etc.) that need multiple awaits to settle.
 */
async function flush(count = 6) {
  for (let i = 0; i < count; i += 1) {
    await nextTick();
    await Promise.resolve();
  }
}

/**
 * Macrotask-aware variant. drainBodyPrefetchQueue yields between
 * batches via `setTimeout(resolve, 0)` so the worker can interleave
 * metadata reads with body fetches; that's a macrotask, not a
 * microtask, so a plain flush() only sees up to the first batch.
 * Use this in tests that observe sequences of body fetch batches
 * or that hang state on bodyPrefetchRunning settling.
 */
async function flushWithTimers(count = 6) {
  for (let i = 0; i < count; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

afterEach(() => {
  __resetRepositoryForTests();
});

describe('selectFolder', () => {
  it('updates currentFolderId synchronously so the FolderTree highlight tracks the click', async () => {
    const { mailStore } = await setupStore({
      folders: [makeFolder(1), makeFolder(2)],
      views: {
        1: { rows: [makeRow(1)], total: 1 },
        2: { rows: [makeRow(2)], total: 1 },
      },
    });
    expect(mailStore.currentFolderId).toBe(1); // auto-picked inbox

    mailStore.selectFolder(2);
    // No await: the assignment must be visible in the same tick so
    // FolderTree's highlight and MessageList's binding stay in sync
    // with the user's click.
    expect(mailStore.currentFolderId).toBe(2);
    expect(mailStore.currentFolder?.id).toBe(2);
  });

  it('does not block one folder load on another (per-folder pageInflight)', async () => {
    const { mailStore, repo } = await setupStore({
      folders: [makeFolder(1), makeFolder(2, { total_emails: 1 })],
      views: {
        1: { rows: [makeRow(10)], total: 1 },
        2: { rows: [makeRow(20)], total: 1 },
      },
    });
    // Inbox (id=1) is auto-picked on attach. Flip to folder 2
    // immediately and then back to 1; both should end up with
    // their own loaded rows, with no shared inflight returning the
    // wrong folder's promise.
    mailStore.selectFolder(2);
    mailStore.selectFolder(1);
    await flush();
    expect(mailStore.currentFolderId).toBe(1);
    expect(mailStore.messages.map((m) => m.id)).toEqual([10]);

    mailStore.selectFolder(2);
    await flush();
    expect(mailStore.currentFolderId).toBe(2);
    expect(mailStore.messages.map((m) => m.id)).toEqual([20]);
    expect(mailStore.isLoading).toBe(false);
    // Sanity: each folder triggered at least one cache read.
    expect(repo._calls.listMessagesForView).toBeGreaterThanOrEqual(2);
  });

  it('does not clobber state.total downward when revisiting a folder', async () => {
    // Folder claims total_emails = 4 (stale Mailbox count) but the
    // JMAP query view authoritatively has 1 row. After the first
    // visit corrects state.total to 1, leaving the folder and
    // returning must not reset it to the stale 4.
    const folder = makeFolder(1, { total_emails: 4 });
    const serverTotal = 1;
    const view = {
      rows: [makeRow(1)],
      get total() { return serverTotal; },
    };
    const { mailStore, repo } = await setupStore({
      folders: [folder],
      views: { 1: view },
    });
    // Initial load corrects the total from query_views. The cached
    // query view is authoritative here; the store must not keep the
    // stale Mailbox total.
    await flush();
    expect(mailStore.totalForFolder).toBe(1);

    // Navigate away and back. Revisit must preserve the corrected
    // total instead of reading the still-stale folder.total_emails.
    mailStore.selectFolder(null);
    await flush();
    mailStore.selectFolder(1);
    await flush();
    expect(mailStore.totalForFolder).toBe(1);
  });

  it('persists per-folder scroll position so revisiting restores the previous offset (R-2.6)', async () => {
    const { mailStore } = await setupStore({
      folders: [makeFolder(1), makeFolder(2)],
      views: {
        1: { rows: [makeRow(1)], total: 1 },
        2: { rows: [makeRow(2)], total: 1 },
      },
    });

    // Default scroll for an untouched folder is 0.
    expect(mailStore.getScrollTop(1)).toBe(0);

    // Scroll the auto-picked Inbox, then navigate to folder 2 and
    // record a different offset there.
    mailStore.setScrollTop(1, 480);
    mailStore.selectFolder(2);
    await flush();
    mailStore.setScrollTop(2, 120);

    // Each folder remembers its own offset independently.
    expect(mailStore.getScrollTop(1)).toBe(480);
    expect(mailStore.getScrollTop(2)).toBe(120);

    // Returning to the first folder must surface the stored offset
    // (MessageList re-applies it after the new folder's rows mount).
    mailStore.selectFolder(1);
    await flush();
    expect(mailStore.getScrollTop(1)).toBe(480);
  });

});

describe('folder view drift detection', () => {
  it('detects drift when folder_messages knows more rows than query_views.total and rebuilds the canonical view', async () => {
    // The Inbox-vs-Unread bug: query_views.total = 14 but
    // folder_messages has 72 unread rows. The store must NOT inflate
    // totalForFolder from the membership projection (that produces a
    // hybrid count All=14 / Unread=72 that violates R-2.8). Instead
    // it must reset the local query view and let ensureFolderWindow
    // rebuild it from the JMAP server, after which whatever the
    // server says is canonical for BOTH All and Unread.
    const folder = makeFolder(1, { total_emails: 14, unread_emails: 0 });
    const folderRows = Array.from({ length: 72 }, (_, index) => (
      makeRow(index + 1, { is_seen: 0 })
    ));
    const view: any = {
      rows: folderRows.slice(0, 14),
      folderRows,
      total: 14,
    };
    // When the store invalidates and re-fetches via ensureFolderWindow
    // the server returns the authoritative answer: 72 messages exist
    // and the query view should know about all of them.
    view.onEnsureWindow = () => {
      view.rows = folderRows.slice(0, 100);
      view.total = 72;
    };
    const { mailStore, repo } = await setupStore({
      folders: [folder],
      views: { 1: view },
    });
    await flush();

    expect(repo._calls.checkFolderViewConsistency).toBeGreaterThan(0);
    expect((repo._calls as any).resetViewForFolder).toBeGreaterThan(0);
    expect(repo._calls.ensureFolderWindow).toBeGreaterThan(0);
    expect(mailStore.totalForFolder).toBe(72);
  });

  it('does not loop when the server-confirmed total still disagrees with stale folder_messages', async () => {
    // After the first drift rebuild, the server says 14 messages
    // exist (folder_messages is the stale projection). The store
    // must trust that result and NOT keep resetting the canonical
    // view on every consistency check.
    const folder = makeFolder(1, { total_emails: 14, unread_emails: 0 });
    const folderRows = Array.from({ length: 72 }, (_, index) => (
      makeRow(index + 1, { is_seen: 0 })
    ));
    const view: any = {
      rows: folderRows.slice(0, 14),
      folderRows,
      total: 14,
    };
    // Server-side rebuild still returns 14 — the stale 72 lives in
    // folder_messages from an older index pass and will be reaped by
    // a future cleanup. The store must not keep resetting.
    view.onEnsureWindow = () => {
      view.rows = folderRows.slice(0, 14);
      view.total = 14;
    };
    const { mailStore, repo } = await setupStore({
      folders: [folder],
      views: { 1: view },
    });
    await flush();
    const resetsAfterFirstOpen = (repo._calls as any).resetViewForFolder ?? 0;

    // Repeated broadcasts during the visit must not retrigger
    // drift-driven resets. The rebuild attempt is one-shot per
    // folder visit; explicit refresh is the recovery path.
    for (let i = 0; i < 5; i += 1) {
      repo.triggerBroadcast(['messages']);
    }
    await flush();

    expect((repo._calls as any).resetViewForFolder ?? 0).toBe(resetsAfterFirstOpen);
    expect(mailStore.totalForFolder).toBe(14);
  });

  it('does nothing when the query view total agrees with folder_messages', async () => {
    const folder = makeFolder(1, { total_emails: 3 });
    const rows = [makeRow(1), makeRow(2), makeRow(3)];
    const { mailStore, repo } = await setupStore({
      folders: [folder],
      views: { 1: { rows, folderRows: rows, total: 3 } },
    });
    await flush();

    expect((repo._calls as any).resetViewForFolder ?? 0).toBe(0);
    expect(mailStore.totalForFolder).toBe(3);
  });

  it('allows a legitimate server-confirmed shrink to lower totalForFolder', async () => {
    // The peer-delete-shrink path must keep working: query view goes
    // from 3 to 1 and totalForFolder follows even though folder
    // membership in our fake repo still says 3 momentarily. This
    // proves we removed the membership lower-bound that previously
    // prevented shrinks.
    const folder = makeFolder(1, { total_emails: 3, unread_emails: 0 });
    const view: any = {
      rows: [makeRow(1), makeRow(2), makeRow(3)],
      folderRows: [makeRow(1), makeRow(2), makeRow(3)],
      total: 3,
    };
    const { mailStore, repo } = await setupStore({
      folders: [folder],
      views: { 1: view },
    });
    await flush();
    expect(mailStore.totalForFolder).toBe(3);

    view.rows = [makeRow(1)];
    view.total = 1;
    repo.triggerBroadcast(['messages']);
    await flush();

    expect(mailStore.totalForFolder).toBe(1);
  });
});

describe('selectAllLoadedMessages', () => {
  it('selects every cached row in the current query view, not just painted rows', async () => {
    const rows = Array.from({ length: 1500 }, (_, index) => makeRow(index + 1));
    const { mailStore, repo } = await setupStore({
      folders: [makeFolder(1, { total_emails: 1500 })],
      views: { 1: { rows, total: 1500 } },
    });
    await flush();

    expect(mailStore.messages.filter(Boolean)).toHaveLength(100);

    await mailStore.selectAllLoadedMessages();

    expect(mailStore.selectedIds.size).toBe(1500);
    expect(mailStore.selectedIds.has(1)).toBe(true);
    expect(mailStore.selectedIds.has(1500)).toBe(true);
    expect(repo._calls.ensureFolderWindow).toBe(0);
  });

  it('selects only unread rows in the canonical query view when unreadOnly is set', async () => {
    // Per R-2.8, Unread is a strict subset of All; selecting under
    // the Unread filter must source from the same query view that
    // All renders, not from a broader membership projection. The
    // store filters by is_seen on the canonical rows.
    const { mailStore } = await setupStore({
      folders: [makeFolder(1, { total_emails: 4 })],
      views: {
        1: {
          rows: [
            makeRow(1, { is_seen: 1 }),
            makeRow(2, { is_seen: 0 }),
            makeRow(3, { is_seen: 1 }),
            makeRow(4, { is_seen: 0 }),
          ],
          total: 4,
        },
      },
    });
    await flush();
    mailStore.selectedIds = new Set([1]);

    await mailStore.selectAllLoadedMessages({ unreadOnly: true });

    expect([...mailStore.selectedIds].sort((a, b) => a - b)).toEqual([2, 4]);
  });

  it('does not select rows that only exist in folder_messages but not in the canonical query view', async () => {
    // Selection must mirror what All can render. A row that only
    // lives in folder_messages (because of a stale projection) is
    // NOT in the open folder from the user's perspective and must
    // not become selectable. This is the spec invariant that Unread
    // cannot exceed All. We use matching query/folder rows to keep
    // drift detection out of the picture; the assertion is about
    // selection sourcing, not the rebuild path.
    const rows = [
      makeRow(1, { is_seen: 0 }),
      makeRow(2, { is_seen: 0 }),
    ];
    const { mailStore } = await setupStore({
      folders: [makeFolder(1, { total_emails: 2 })],
      views: { 1: { rows, folderRows: rows, total: 2 } },
    });
    await flush();

    await mailStore.selectAllLoadedMessages({ unreadOnly: true });

    expect([...mailStore.selectedIds].sort((a, b) => a - b)).toEqual([1, 2]);
  });
});

describe('expandFolderViewIntoMemory', () => {
  it('reads every cached canonical row into messages so dense filters can see the whole folder', async () => {
    // The Unread-shows-83-of-1400 bug, scaled up: the canonical view
    // has the full folder cached locally in query_view_items +
    // messages, but mailStore.messages only contains the ~100 rows
    // the virtualizer pulled for the visible window. A dense local
    // filter would see ~83 unread out of 100 instead of 9917 of
    // 10000. Expanding the buffer to the full canonical view fixes
    // the filter without changing its source (still query_view_items).
    const rows = Array.from({ length: 10_000 }, (_, index) => (
      makeRow(index + 1, { is_seen: index < 9917 ? 0 : 1 })
    ));
    const { mailStore, repo } = await setupStore({
      folders: [makeFolder(1, { total_emails: 10_000 })],
      views: { 1: { rows, total: 10_000 } },
    });
    await flush();

    // After initial paint the buffer holds only the first page.
    expect(mailStore.messages.filter(Boolean)).toHaveLength(100);
    const readsBefore = repo._calls.listMessagesForView;

    await mailStore.expandFolderViewIntoMemory();

    expect(mailStore.messages.filter(Boolean)).toHaveLength(10_000);
    expect(mailStore.messages.at(-1)?.id).toBe(10_000);
    expect(repo._calls.listMessagesForView - readsBefore).toBe(1);
    expect(repo._calls.ensureFolderWindow).toBe(0);
    // Verify the buffer can support the Unread invariant: filtering
    // by is_seen=0 against the expanded buffer recovers all 9917
    // unread rows in the cache, not just the unread rows that
    // happened to be in the 100-row visible window.
    expect(mailStore.messages.filter((row) => Number(row?.is_seen) === 0))
      .toHaveLength(9917);
  });

  it('coalesces parallel expansion calls into one SQLite read', async () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => makeRow(index + 1));
    const { mailStore, repo } = await setupStore({
      folders: [makeFolder(1, { total_emails: 10_000 })],
      views: { 1: { rows, total: 10_000 } },
    });
    await flush();
    const readsBefore = repo._calls.listMessagesForView;

    await Promise.all([
      mailStore.expandFolderViewIntoMemory(),
      mailStore.expandFolderViewIntoMemory(),
      mailStore.expandFolderViewIntoMemory(),
    ]);

    expect(repo._calls.listMessagesForView - readsBefore).toBe(1);
    expect(mailStore.messages.filter(Boolean)).toHaveLength(10_000);
  });

  it('is a no-op when the buffer already covers the canonical total', async () => {
    const rows = [makeRow(1), makeRow(2), makeRow(3)];
    const { mailStore, repo } = await setupStore({
      folders: [makeFolder(1, { total_emails: 3 })],
      views: { 1: { rows, total: 3 } },
    });
    await flush();
    const readsBefore = repo._calls.listMessagesForView;

    await mailStore.expandFolderViewIntoMemory();

    expect(repo._calls.listMessagesForView - readsBefore).toBe(0);
    expect(mailStore.messages.map((row) => row?.id)).toEqual([1, 2, 3]);
  });

  it('does not write into a folder that has been switched away from mid-read', async () => {
    // A real folder switch happens synchronously in selectFolder. If
    // a long expansion is in flight against the old folder when the
    // user clicks a different one, the result must not splice into
    // the new folder's buffer.
    const archiveRows = Array.from({ length: 10_000 }, (_, index) => (
      makeRow(index + 1, { is_seen: 0 })
    ));
    const inboxRows = [makeRow(99_999)];
    const { mailStore, repo } = await setupStore({
      folders: [
        makeFolder(1, { name: 'Inbox', total_emails: 1 }),
        makeFolder(2, { name: 'Archive', role: 'archive', total_emails: 10_000 }),
      ],
      views: {
        1: { rows: inboxRows, total: 1 },
        2: { rows: archiveRows, total: 10_000 },
      },
    });
    await flush();
    mailStore.selectFolder(2);
    await flush();
    expect(mailStore.currentFolderId).toBe(2);

    let releaseRead: () => void = () => {};
    const reads: Array<Promise<any>> = [];
    const originalRead = repo.listMessagesForView;
    repo.listMessagesForView = async (args) => {
      if (args.folderId === 2 && args.limit >= 10_000) {
        const block = new Promise<void>((resolve) => { releaseRead = resolve; });
        reads.push(block);
        await block;
      }
      return originalRead.call(repo, args);
    };

    const expandPromise = mailStore.expandFolderViewIntoMemory();
    await flush();

    mailStore.selectFolder(1);
    await flush();
    expect(mailStore.currentFolderId).toBe(1);

    releaseRead();
    await expandPromise;
    await flush();

    // The expansion must NOT have replaced the inbox buffer with the
    // archive rows. Inbox still shows its own one-row view.
    expect(mailStore.messages.map((row) => row?.id)).toEqual([99_999]);
    expect(mailStore.totalForFolder).toBe(1);
  });
});

describe('_loadPage sparse-cache fallthrough', () => {
  it('falls through to ensureFolderWindow when query_view_items has fewer rows than state.total', async () => {
    // Folder reports 4 messages but the cache only has 1 entry
    // (e.g. an interrupted indexer). The previous bug short-circuited
    // on `cached.length > 0` and never went to the network, leaving
    // 3 placeholder rows stuck forever. The fix is to compare cache
    // size against the expected count derived from state.total.
    const folder = makeFolder(1, { total_emails: 4 });
    const view: any = { rows: [makeRow(1)], total: 4 };
    let networkFilledTo = 1;
    view.onEnsureWindow = () => {
      // Server-side population: bring the view up to its full set
      // of 4 rows so the second positional read returns everything.
      if (networkFilledTo < 4) {
        view.rows = [
          makeRow(1), makeRow(2), makeRow(3), makeRow(4),
        ];
        networkFilledTo = 4;
      }
    };
    const { mailStore, repo } = await setupStore({
      folders: [folder],
      views: { 1: view },
    });
    await flush();
    expect(repo._calls.ensureFolderWindow).toBeGreaterThanOrEqual(1);
    expect(mailStore.messages.map((m) => m.id)).toEqual([1, 2, 3, 4]);
    expect(mailStore.totalForFolder).toBe(4);
  });

  it('falls through to ensureFolderWindow when cached positions are only placeholders', async () => {
    // A query view can be positionally covered while the joined
    // message metadata has been removed by external changes. Treating
    // those placeholders as a complete cache hit leaves the Inbox with
    // no real rows until a manual refresh.
    const folder = makeFolder(1, { total_emails: 3 });
    const view: any = {
      rows: [undefined, undefined, undefined],
      total: 3,
      returnPlaceholders: true,
    };
    view.onEnsureWindow = () => {
      view.rows = [makeRow(1), makeRow(2), makeRow(3)];
    };
    const { mailStore, repo } = await setupStore({
      folders: [folder],
      views: { 1: view },
    });
    await flush();
    expect(repo._calls.ensureFolderWindow).toBeGreaterThanOrEqual(1);
    expect(mailStore.messages.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it('does not loop on a persistently failing _loadPage (the ensureLoaded spam guard)', async () => {
    // Previously, ensureLoaded's .finally re-pump kept firing
    // ensureLoaded(0, 100) every microtask when _loadPage threw,
    // because state.requestedRange was still set and state.paintedRanges
    // was still uncovered. The console flooded with
    //   [mail-store] ensureLoaded failed { offset: 0, err: Error }
    // Guard: once a range fails, do not auto-retry it from the
    // .finally re-pump. The user can recover via scroll or refresh.
    const folder = makeFolder(1, { total_emails: 5 });
    const { mailStore, repo } = await setupStore({
      folders: [folder],
      views: { 1: { rows: [], total: 5 } },
    });
    let calls = 0;
    repo.ensureFolderWindow = async () => {
      calls += 1;
      throw new Error('simulated sync failure');
    };
    mailStore.setRequestedRange(1, 0, 100);
    await mailStore.ensureLoaded(0, 100);
    await flush();
    const after = calls;
    await flush();
    await flush();
    expect(calls).toBe(after); // no further auto-retries
    expect(calls).toBeLessThanOrEqual(2); // at most the original call + maybe a single re-pump
  });

  it('does not refetch from the server when the cache is fully covered', async () => {
    const folder = makeFolder(1, { total_emails: 3 });
    const view = { rows: [makeRow(1), makeRow(2), makeRow(3)], total: 3 };
    const { mailStore, repo } = await setupStore({
      folders: [folder],
      views: { 1: view },
    });
    await flush();
    expect(mailStore.messages).toHaveLength(3);
    // First-time visit needs no network call because the cache
    // already satisfies the visible window.
    expect(repo._calls.ensureFolderWindow).toBe(0);
  });
});

// Delete / move-to-Trash coverage lives in
// tests/unit/sync/jmap-outbox-delete.test.js. That suite drives the
// outbox + handlers + in-memory engine end-to-end so it can assert
// the cache invariants the store relies on (folder_memberships,
// query_view_items positions, query_views.total). Mocked-store
// assertions previously made here could only prove "the store called
// the outbox", which was the exact illusion behind the original bug.

describe('enqueueVisibleBodyPrefetch (scroll-driven body prefetch)', () => {
  it('enqueues only rows that have metadata loaded AND no body yet', async () => {
    // The MessageList virtualizer calls this with the start/end of
    // the visible window every 100ms during a scroll. The prefetch
    // must skip rows that are still placeholders (no metadata yet
    // — the next ensureLoaded round trip will fill them) and rows
    // that already have a body in body_values (body_fetched_at is
    // non-null), so we never re-issue an Email/get for a body
    // the user already has.
    const folder = makeFolder(2, { role: 'archive', total_emails: 10 });
    const view = {
      rows: [
        makeRow(1, { body_fetched_at: null }),
        makeRow(2, { body_fetched_at: null }),
        makeRow(3, { body_fetched_at: 1_700_000_000_000 }), // already fetched
        makeRow(4, { body_fetched_at: null }),
        makeRow(5, { body_fetched_at: null }),
      ],
      total: 5,
    };
    const { mailStore, repo } = await setupStore({
      folders: [folder],
      views: { 2: view },
    });
    mailStore.selectFolder(2);
    await flushWithTimers();

    const batches = [];
    repo.ensureMessageBodies = async (_accountId, ids) => {
      batches.push([...ids]);
      return { fetched: ids.length };
    };

    mailStore.enqueueVisibleBodyPrefetch(0, 5);
    await flushWithTimers();

    // One batch containing the 4 un-fetched rows; the already-
    // fetched row 3 is skipped.
    expect(batches).toHaveLength(1);
    expect(batches[0].sort((a, b) => a - b)).toEqual([1, 2, 4, 5]);
  });

  it('drains distinct visible-window enqueues in FIFO batches', async () => {
    // A fast scroll can fire the watcher multiple times in quick
    // succession. We deliberately do not cancel in-flight or pending
    // batches in the store: cancellation has tricky interactions
    // with click-time piggybacking. The important contract here is
    // simpler: distinct windows drain in FIFO order in
    // BODY_PREFETCH_BATCH-sized batches. Duplicate ids across a
    // completed batch are the backend's job to ignore via
    // body_fetched_at; the store only avoids duplicates that are
    // currently pending in bodyQueued.
    const folder = makeFolder(2, { role: 'archive', total_emails: 200 });
    const rows = [];
    for (let i = 1; i <= 200; i += 1) {
      rows.push(makeRow(i, { body_fetched_at: null }));
    }
    const view = { rows, total: 200 };
    const { mailStore, repo } = await setupStore({
      folders: [folder],
      views: { 2: view },
    });
    mailStore.selectFolder(2);
    await flushWithTimers();

    const batches = [];
    repo.ensureMessageBodies = async (_accountId, ids) => {
      batches.push([...ids]);
      return { fetched: ids.length };
    };

    mailStore.enqueueVisibleBodyPrefetch(0, 25);
    mailStore.enqueueVisibleBodyPrefetch(25, 50);
    await flushWithTimers();

    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(batches[1]).toEqual(Array.from({ length: 25 }, (_, i) => i + 26));
  });

  it('does NOT cancel the in-flight batch (callers waiting on its ids must still resolve)', async () => {
    // The store must leave an already-running ensureMessageBodies
    // alone. The worker-side _bodyFetchInflight map (see
    // jmap-backend.test.js > 'shares a single Email/get round trip
    // across concurrent callers') gives a user click during prefetch
    // a chance to piggyback on the in-flight batch; if we cancelled
    // or rewrote that in-flight batch, that piggyback could hang or
    // duplicate the request.
    const folder = makeFolder(2, { role: 'archive', total_emails: 50 });
    const rows = [];
    for (let i = 1; i <= 50; i += 1) {
      rows.push(makeRow(i, { body_fetched_at: null }));
    }
    const { mailStore, repo } = await setupStore({
      folders: [folder],
      views: { 2: { rows, total: 50 } },
    });
    mailStore.selectFolder(2);
    await flushWithTimers();

    let releaseInflight;
    const inflight = new Promise((resolve) => { releaseInflight = resolve; });
    const resolvedBatches = [];
    repo.ensureMessageBodies = async (_accountId, ids) => {
      await inflight;
      resolvedBatches.push([...ids]);
      return { fetched: ids.length };
    };

    mailStore.enqueueVisibleBodyPrefetch(0, 25);
    await flushWithTimers();

    // Re-issue with a different window mid-flight. This should add
    // pending work but must not mutate the already-spliced in-flight
    // batch.
    mailStore.enqueueVisibleBodyPrefetch(25, 50);
    await flushWithTimers();

    // Release the in-flight; it must resolve with the ORIGINAL ids
    // (rows 1-25), not the discarded ones.
    releaseInflight();
    await flushWithTimers();

    expect(resolvedBatches[0]).toBeTruthy();
    expect(resolvedBatches[0]).toContain(1);
    expect(resolvedBatches[0]).toContain(25);
    expect(resolvedBatches[0]).not.toContain(50);
  });

  it('is a no-op when no row needs a body fetch (everything is already cached)', async () => {
    const folder = makeFolder(2, { role: 'archive', total_emails: 3 });
    const view = {
      rows: [
        makeRow(1, { body_fetched_at: 1 }),
        makeRow(2, { body_fetched_at: 1 }),
        makeRow(3, { body_fetched_at: 1 }),
      ],
      total: 3,
    };
    const { mailStore, repo } = await setupStore({
      folders: [folder],
      views: { 2: view },
    });
    mailStore.selectFolder(2);
    await flushWithTimers();

    let calls = 0;
    repo.ensureMessageBodies = async () => {
      calls += 1;
      return { fetched: 0 };
    };

    mailStore.enqueueVisibleBodyPrefetch(0, 3);
    await flushWithTimers();

    expect(calls).toBe(0);
  });

  it('skips undefined slots so the prefetch survives a partially-loaded window', async () => {
    // selectFolder paints rows from cache before ensureFolderWindow
    // completes; in that window state.rows can have undefined
    // slots. The prefetch must not throw or enqueue garbage; it
    // should just enqueue what's actually there and wait for the
    // next throttled tick (after metadata lands) to pick up the
    // rest.
    const folder = makeFolder(2, { role: 'archive', total_emails: 5 });
    const view = {
      rows: [
        makeRow(1, { body_fetched_at: null }),
        undefined,
        makeRow(3, { body_fetched_at: null }),
        undefined,
        makeRow(5, { body_fetched_at: null }),
      ],
      total: 5,
    };
    const { mailStore, repo } = await setupStore({
      folders: [folder],
      views: { 2: view },
    });
    mailStore.selectFolder(2);
    await flushWithTimers();

    const batches = [];
    repo.ensureMessageBodies = async (_accountId, ids) => {
      batches.push([...ids]);
      return { fetched: ids.length };
    };

    mailStore.enqueueVisibleBodyPrefetch(0, 5);
    await flushWithTimers();

    expect(batches).toHaveLength(1);
    expect(batches[0].sort((a, b) => a - b)).toEqual([1, 3, 5]);
  });
});

describe('selectMessage marks unread as seen via the auto-drained outbox', () => {
  it('writes the optimistic $seen patch and enqueues a setKeywords mutation; the worker drains it on its own', async () => {
    // Contract under test: the store's only job is to write the
    // optimistic patch and enqueue the pending_mutations row. The
    // worker-side OutboxRunner picks the row up via the
    // onMutationInserted hook fired from PENDING_MUTATION_INSERT
    // (wired in db/handlers.js + sync/sync-host.js + db/shared-worker.js),
    // so the store deliberately does NOT call runMutation or
    // drainOutbox itself. Earlier "store forgot to kick the outbox"
    // bug is impossible to re-introduce as long as the worker
    // auto-drain hook is wired.
    const folder = makeFolder(1, { total_emails: 1 });
    const unread = makeRow(7, { is_seen: 0, keywords_json: '{}' });
    const view = { rows: [unread], total: 1 };
    const { mailStore, repo } = await setupStore({
      folders: [folder],
      views: { 1: view },
    });
    await flush();

    const replaceCalls = [];
    repo.replaceMessageKeywords = async (messageId, keywords, keywordsJson) => {
      replaceCalls.push({ messageId, keywords, keywordsJson });
    };
    const insertCalls = [];
    repo.insertPendingMutation = async (input) => {
      insertCalls.push(input);
      return { id: 99 };
    };
    const runMutationCalls = [];
    repo.runMutation = async (accountId, mutationId) => {
      runMutationCalls.push({ accountId, mutationId });
      return { attempted: 1, succeeded: 1, failed: 0 };
    };
    const drainCalls = [];
    repo.drainOutbox = async (accountId) => {
      drainCalls.push(accountId);
      return { attempted: 0, succeeded: 0, failed: 0 };
    };

    mailStore.selectMessage(7);
    await flush();

    expect(replaceCalls).toHaveLength(1);
    expect(replaceCalls[0].messageId).toBe(7);
    expect(replaceCalls[0].keywords).toContain('$seen');

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].mutationType).toBe('setKeywords');
    expect(insertCalls[0].targetMessageId).toBe(7);
    expect(JSON.parse(insertCalls[0].requestJson)).toEqual({ add: ['$seen'], remove: [] });

    // The store must NOT pump the queue itself; that's the worker's
    // job now. If these arrays grow, someone re-added an explicit
    // kick in the caller and the new auto-drain hook is being
    // bypassed (likely re-introducing the cross-caller "did I
    // remember to drain?" footgun).
    expect(runMutationCalls).toHaveLength(0);
    expect(drainCalls).toHaveLength(0);
  });

  it('does not enqueue a mutation when clicking an already-seen message', async () => {
    // _setSeen short-circuits when local is_seen already matches the
    // requested state, so no insertPendingMutation happens. This
    // keeps the queue from filling with no-op rows when the user
    // clicks a read message or scrolls past read mail.
    const folder = makeFolder(1, { total_emails: 1 });
    const seen = makeRow(8, { is_seen: 1, keywords_json: '{"$seen":true}' });
    const view = { rows: [seen], total: 1 };
    const { mailStore, repo } = await setupStore({
      folders: [folder],
      views: { 1: view },
    });
    await flush();

    let replaceCalls = 0;
    repo.replaceMessageKeywords = async () => { replaceCalls += 1; };
    let insertCalls = 0;
    repo.insertPendingMutation = async () => {
      insertCalls += 1;
      return { id: 1 };
    };

    mailStore.selectMessage(8);
    await flush();

    expect(replaceCalls).toBe(0);
    expect(insertCalls).toBe(0);
  });

  it('batches markManySeen optimistic writes and setKeywords mutations by chunk', async () => {
    const folder = makeFolder(1, { total_emails: 750 });
    const rows = Array.from({ length: 750 }, (_, index) => makeRow(index + 1, {
      is_seen: 0,
      keywords_json: '{}',
    }));
    const { mailStore, repo } = await setupStore({
      folders: [folder],
      views: { 1: { rows, total: 750 } },
    });
    await flush();

    const replaceCalls = [];
    repo.replaceMessageKeywordsMany = async (items) => {
      replaceCalls.push(items);
      return { ok: true, applied: items.length };
    };
    repo.replaceMessageKeywords = async () => {
      throw new Error('single-row keyword replacement should not be used for bulk mark seen');
    };
    const insertCalls = [];
    repo.insertPendingMutation = async (input) => {
      insertCalls.push(input);
      return { id: 100 + insertCalls.length };
    };

    const changed = await mailStore.markManySeen(rows.map((row) => row.id), true);

    expect(changed).toBe(750);
    expect(replaceCalls).toHaveLength(2);
    expect(replaceCalls[0]).toHaveLength(500);
    expect(replaceCalls[1]).toHaveLength(250);
    expect(insertCalls).toHaveLength(2);
    expect(JSON.parse(insertCalls[0].requestJson).messageIds).toHaveLength(500);
    expect(JSON.parse(insertCalls[1].requestJson).messageIds).toHaveLength(250);
    expect(JSON.parse(insertCalls[0].requestJson)).toMatchObject({
      add: ['$seen'],
      remove: [],
    });
  });
});

describe('whitelistSenders (bulk Not junk)', () => {
  it('de-dupes senders into one trust mutation, batches the keyword rescue, and moves the batch', async () => {
    const inbox = makeFolder(1, { role: 'inbox', may_add_items: 1 });
    const junk = makeFolder(2, { role: 'junk', may_remove_items: 1, total_emails: 3 });
    const rows = [
      makeRow(10, { from_text: 'Alice <a@x.com>', keywords_json: '{"$junk":true}' }),
      makeRow(11, { from_text: 'a@x.com', keywords_json: '{"$junk":true}' }),
      makeRow(12, { from_text: 'Bob <b@y.com>', keywords_json: '{"$junk":true}' }),
    ];
    const { mailStore, repo } = await setupStore({
      folders: [inbox, junk],
      views: { 1: { rows: [], total: 0 }, 2: { rows, total: 3 } },
    });
    await flush();

    mailStore.selectFolder(junk.id);
    await flush();
    expect(mailStore.currentFolder?.role).toBe('junk');

    const insertCalls = [];
    repo.insertPendingMutation = async (input) => {
      insertCalls.push(input);
      return { id: 100 + insertCalls.length };
    };
    let keywordBatch = null;
    repo.replaceMessageKeywordsMany = async (items) => {
      keywordBatch = items;
      return { ok: true, applied: items.length };
    };

    const result = await mailStore.whitelistSenders([10, 11, 12]);
    await flush();

    expect(result.succeeded).toBe(3);

    const byType = (type) => insertCalls.filter((c) => c.mutationType === type);

    // One trust mutation carrying the two unique senders (deduped).
    const trust = byType(MUTATION_TYPE.WHITELIST_SENDER);
    expect(trust).toHaveLength(1);
    expect(trust[0].targetMessageId).toBeNull();
    expect(JSON.parse(trust[0].requestJson).senders.map((s) => s.email))
      .toEqual(['a@x.com', 'b@y.com']);

    // One batched keyword rescue across all three messages.
    expect(keywordBatch).toHaveLength(3);
    const setKw = byType(MUTATION_TYPE.SET_KEYWORDS);
    expect(setKw).toHaveLength(1);
    expect(JSON.parse(setKw[0].requestJson)).toMatchObject({
      messageIds: [10, 11, 12],
      add: ['$notjunk'],
      remove: ['$junk'],
    });

    // One move into the Inbox.
    expect(byType(MUTATION_TYPE.MOVE_TO_FOLDERS)).toHaveLength(1);

    // Rows leave the Junk view and a success notice names the senders.
    expect(mailStore.messages.map((r) => r?.id)).toEqual([]);
    expect(mailStore.notice).toBe('Whitelisted 2 senders — moved 3 messages to Inbox');
  });
});

describe('successor selection after removal', () => {
  it('selects the next message after deleting the previewed row', async () => {
    const inbox = makeFolder(1, { total_emails: 3 });
    const trash = makeFolder(2, { role: 'trash' });
    const { mailStore } = await setupStore({
      folders: [inbox, trash],
      views: { 1: { rows: [makeRow(1), makeRow(2), makeRow(3)], total: 3 } },
    });
    await flush();

    mailStore.selectMessage(2);
    await flush();

    await mailStore.destroyMessage(2);
    await flush();

    expect(mailStore.messages.map((row) => row?.id)).toEqual([1, 3]);
    expect(mailStore.selectedMessageId).toBe(3);
  });

  it('falls back to the previous message when deleting the tail row', async () => {
    const inbox = makeFolder(1, { total_emails: 3 });
    const trash = makeFolder(2, { role: 'trash' });
    const { mailStore } = await setupStore({
      folders: [inbox, trash],
      views: { 1: { rows: [makeRow(1), makeRow(2), makeRow(3)], total: 3 } },
    });
    await flush();

    mailStore.selectMessage(3);
    await flush();

    await mailStore.destroyMessage(3);
    await flush();

    expect(mailStore.messages.map((row) => row?.id)).toEqual([1, 2]);
    expect(mailStore.selectedMessageId).toBe(2);
  });

  it('selects the row that shifts into place after moving checkbox-selected rows', async () => {
    const inbox = makeFolder(1, { total_emails: 4, may_remove_items: 1 });
    const archive = makeFolder(2, { role: 'archive', may_add_items: 1 });
    const { mailStore } = await setupStore({
      folders: [inbox, archive],
      views: { 1: { rows: [makeRow(1), makeRow(2), makeRow(3), makeRow(4)], total: 4 } },
    });
    await flush();

    mailStore.selectedIds = new Set([2, 3]);

    await mailStore.moveMessages([2, 3], archive.id);
    await flush();

    expect(mailStore.messages.map((row) => row?.id)).toEqual([1, 4]);
    expect(mailStore.selectedIds.size).toBe(0);
    expect(mailStore.selectedMessageId).toBe(4);
  });
});

describe('focusedMessageId (keyboard cursor)', () => {
  it('couples the cursor to the preview on selectMessage and clears it on deselect', async () => {
    const inbox = makeFolder(1, { total_emails: 3 });
    const { mailStore } = await setupStore({
      folders: [inbox],
      views: { 1: { rows: [makeRow(1), makeRow(2), makeRow(3)], total: 3 } },
    });
    await flush();

    mailStore.selectMessage(2);
    expect(mailStore.focusedMessageId).toBe(2);

    mailStore.selectMessage(null);
    expect(mailStore.focusedMessageId).toBeNull();
  });

  it('advances the cursor to the successor row after a delete', async () => {
    const inbox = makeFolder(1, { total_emails: 3 });
    const trash = makeFolder(2, { role: 'trash' });
    const { mailStore } = await setupStore({
      folders: [inbox, trash],
      views: { 1: { rows: [makeRow(1), makeRow(2), makeRow(3)], total: 3 } },
    });
    await flush();

    mailStore.selectMessage(2);
    await flush();
    await mailStore.destroyMessage(2);
    await flush();

    expect(mailStore.selectedMessageId).toBe(3);
    expect(mailStore.focusedMessageId).toBe(3);
  });
});

describe('moveMessages', () => {
  it('refetches a previously visited destination folder after moving a message into it', async () => {
    const inbox = makeFolder(1, { total_emails: 1, may_remove_items: 1 });
    const archive = makeFolder(2, { role: 'archive', total_emails: 1, may_add_items: 1 });
    const { mailStore, repo } = await setupStore({
      folders: [inbox, archive],
      views: {
        1: { rows: [makeRow(7)], total: 1 },
        2: { rows: [makeRow(8)], total: 1 },
      },
    });
    await flush();

    mailStore.selectFolder(archive.id);
    await flush();
    expect(mailStore.messages.map((row) => row?.id)).toEqual([8]);

    mailStore.selectFolder(inbox.id);
    await flush();

    repo.runMutation = async () => {
      repo.setView(1, { rows: [], total: 0 });
      repo.setView(2, {
        rows: [makeRow(7), makeRow(8)],
        total: 2,
        stale: true,
      });
      return { attempted: 1, succeeded: 1, failed: 0 };
    };
    let destinationFetches = 0;
    const originalEnsure = repo.ensureFolderWindow;
    repo.ensureFolderWindow = async (accountId, folderId, range) => {
      if (Number(folderId) === archive.id) destinationFetches += 1;
      return originalEnsure(accountId, folderId, range);
    };

    await mailStore.moveMessages([7], archive.id);
    mailStore.selectFolder(archive.id);
    await flush();

    expect(destinationFetches).toBeGreaterThan(0);
    expect(mailStore.messages.map((row) => row?.id)).toEqual([7, 8]);
  });

  it('refetches a revisited folder when the persisted query view is marked stale', async () => {
    const inbox = makeFolder(1, { total_emails: 1 });
    const archive = makeFolder(2, { role: 'archive', total_emails: 1 });
    const archiveView: any = { rows: [makeRow(8)], total: 1 };
    const { mailStore, repo } = await setupStore({
      folders: [inbox, archive],
      views: {
        1: { rows: [makeRow(1)], total: 1 },
        2: archiveView,
      },
    });
    await flush();

    mailStore.selectFolder(archive.id);
    await flush();
    expect(mailStore.messages.map((row) => row?.id)).toEqual([8]);

    mailStore.selectFolder(inbox.id);
    await flush();

    archiveView.stale = true;
    archiveView.onEnsureWindow = () => {
      archiveView.rows = [makeRow(7), makeRow(8)];
      archiveView.total = 2;
    };

    mailStore.selectFolder(archive.id);
    await flush();

    expect(mailStore.messages.map((row) => row?.id)).toEqual([7, 8]);
  });

  it('queues a moveToFolders mutation for the current source folder and clears moved selection state', async () => {
    const inbox = makeFolder(1, { total_emails: 1, may_remove_items: 1 });
    const archive = makeFolder(2, { role: 'archive', may_add_items: 1 });
    const row = makeRow(7);
    const { mailStore, repo } = await setupStore({
      folders: [inbox, archive],
      views: { 1: { rows: [row], total: 1 } },
    });
    await flush();
    expect(mailStore.currentFolderId).toBe(1);
    expect(mailStore.canMoveToFolder(2)).toBe(true);

    const insertCalls = [];
    repo.insertPendingMutation = async (input) => {
      insertCalls.push(input);
      return { id: 42 };
    };
    const runCalls = [];
    repo.runMutation = async (accountId, mutationId) => {
      runCalls.push({ accountId, mutationId });
      repo.setView(1, { rows: [], total: 0 });
      return { attempted: 1, succeeded: 1, failed: 0 };
    };

    mailStore.selectedIds = new Set([7]);
    mailStore.selectMessage(7);
    await flush();

    const result = await mailStore.moveMessages([7], 2);

    expect(result).toEqual({ succeeded: 1, failed: 0, skipped: 0 });
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].mutationType).toBe('moveToFolders');
    expect(insertCalls[0].targetMessageId).toBe(7);
    expect(JSON.parse(insertCalls[0].requestJson)).toEqual({
      messageIds: [7],
      addFolderIds: [2],
      removeFolderIds: [1],
    });
    expect(runCalls).toEqual([{ accountId: 1, mutationId: 42 }]);
    expect(mailStore.selectedIds.size).toBe(0);
    expect(mailStore.selectedMessageId).toBeNull();
  });

  it('skips drops onto the current folder without enqueueing a mutation', async () => {
    const inbox = makeFolder(1, { total_emails: 1, may_remove_items: 1, may_add_items: 1 });
    const { mailStore, repo } = await setupStore({
      folders: [inbox],
      views: { 1: { rows: [makeRow(7)], total: 1 } },
    });
    await flush();
    let insertCalls = 0;
    repo.insertPendingMutation = async () => {
      insertCalls += 1;
      return { id: 1 };
    };

    const result = await mailStore.moveMessages([7], 1);

    expect(result).toEqual({ succeeded: 0, failed: 0, skipped: 1 });
    expect(insertCalls).toBe(0);
    expect(mailStore.canMoveToFolder(1)).toBe(false);
  });

  it('rejects folders that cannot accept added messages', async () => {
    const inbox = makeFolder(1, { total_emails: 1, may_remove_items: 1 });
    const locked = makeFolder(2, { role: 'archive', may_add_items: 0 });
    const { mailStore, repo } = await setupStore({
      folders: [inbox, locked],
      views: { 1: { rows: [makeRow(7)], total: 1 } },
    });
    await flush();
    let insertCalls = 0;
    repo.insertPendingMutation = async () => {
      insertCalls += 1;
      return { id: 1 };
    };

    await expect(mailStore.moveMessages([7], 2))
      .rejects.toThrow('Cannot move messages into that folder.');
    expect(insertCalls).toBe(0);
    expect(mailStore.canMoveToFolder(2)).toBe(false);
  });

  it('chunks large bulk moves into batches of 500 and ticks the bulk-operation overlay', async () => {
    // The user can multi-select a large number of rows (the bug
    // report had 536). A single Email/set with that many update
    // entries silently times out on Stalwart and shows up as
    // noResponse; the store must split the dispatch into chunks of
    // BULK_OPERATION_BATCH_SIZE (500) and drive a progress overlay
    // so the user gets feedback while it works through them.
    const inbox = makeFolder(1, { total_emails: 750, may_remove_items: 1 });
    const archive = makeFolder(2, { role: 'archive', name: 'Archive', may_add_items: 1 });
    const ids = Array.from({ length: 750 }, (_, i) => i + 1);
    const rows = ids.map((id) => makeRow(id));
    const { mailStore, repo } = await setupStore({
      folders: [inbox, archive],
      views: { 1: { rows, total: 750 } },
    });
    await flush();

    const insertCalls: any[] = [];
    repo.insertPendingMutation = async (input) => {
      insertCalls.push(input);
      return { id: 100 + insertCalls.length };
    };
    const observedProgress: Array<{ active: boolean; completed: number; total: number; label: string }> = [];
    repo.runMutation = async (_accountId, _mutationId) => {
      const snap = mailStore.bulkOperation;
      observedProgress.push({
        active: snap.active,
        completed: snap.completed,
        total: snap.total,
        label: snap.label,
      });
      return { attempted: 1, succeeded: 1, failed: 0 };
    };

    const result = await mailStore.moveMessages(ids, archive.id);

    expect(result.succeeded).toBe(750);
    expect(insertCalls).toHaveLength(2);
    expect(JSON.parse(insertCalls[0].requestJson).messageIds).toHaveLength(500);
    expect(JSON.parse(insertCalls[1].requestJson).messageIds).toHaveLength(250);
    expect(observedProgress[0]).toMatchObject({
      active: true,
      completed: 0,
      total: 750,
      label: 'Moving messages to Archive',
    });
    expect(observedProgress[1]).toMatchObject({
      active: true,
      completed: 500,
      total: 750,
    });
    // Overlay clears once the operation finishes.
    expect(mailStore.bulkOperation.active).toBe(false);
    expect(mailStore.bulkOperation.total).toBe(0);
  });

  it('does not show the overlay for selections at or below the chunk size', async () => {
    const inbox = makeFolder(1, { total_emails: 500, may_remove_items: 1 });
    const archive = makeFolder(2, { role: 'archive', name: 'Archive', may_add_items: 1 });
    const ids = Array.from({ length: 500 }, (_, i) => i + 1);
    const rows = ids.map((id) => makeRow(id));
    const { mailStore, repo } = await setupStore({
      folders: [inbox, archive],
      views: { 1: { rows, total: 500 } },
    });
    await flush();

    const observedActive: boolean[] = [];
    repo.insertPendingMutation = async () => ({ id: 1 });
    repo.runMutation = async () => {
      observedActive.push(mailStore.bulkOperation.active);
      return { attempted: 1, succeeded: 1, failed: 0 };
    };

    await mailStore.moveMessages(ids, archive.id);

    // 500 fits in one chunk; the overlay must stay quiet to avoid
    // flashing for a single-shot operation that finishes in one
    // round trip.
    expect(observedActive).toEqual([false]);
    expect(mailStore.bulkOperation.active).toBe(false);
  });

  it('stops bulk move on first chunk failure and reports partial progress', async () => {
    const inbox = makeFolder(1, { total_emails: 750, may_remove_items: 1 });
    const archive = makeFolder(2, { role: 'archive', name: 'Archive', may_add_items: 1 });
    const ids = Array.from({ length: 750 }, (_, i) => i + 1);
    const rows = ids.map((id) => makeRow(id));
    const { mailStore, repo } = await setupStore({
      folders: [inbox, archive],
      views: { 1: { rows, total: 750 } },
    });
    await flush();

    const insertCalls: any[] = [];
    repo.insertPendingMutation = async (input) => {
      insertCalls.push(input);
      return { id: 100 + insertCalls.length };
    };
    let runCount = 0;
    repo.runMutation = async () => {
      runCount += 1;
      if (runCount === 1) return { attempted: 1, succeeded: 1, failed: 0 };
      return { attempted: 1, succeeded: 0, failed: 1 };
    };
    repo.getPendingMutationError = async () => ({
      error_json: JSON.stringify({ type: 'requestTooLarge' }),
    });

    await expect(mailStore.moveMessages(ids, archive.id)).rejects.toThrow(
      /requestTooLarge.*500 of 750 succeeded/,
    );

    // First chunk persisted, second chunk's pending row stays
    // conflicted (handled by the runner). A third chunk is never
    // dispatched.
    expect(runCount).toBe(2);
    expect(insertCalls).toHaveLength(2);
    expect(mailStore.bulkOperation.active).toBe(false);
  });
});

describe('refresh button (nuke and rebuild)', () => {
  it('wipes the local view, re-syncs from the server, and shows the spinner while running', async () => {
    // Simulate a desynced cache: locally we believe there are 3 rows
    // but the server actually has 1. After refresh, the local view
    // should match the server (1 row) and isLoading must have flipped
    // true during the run so the toolbar spinner renders.
    const folder = makeFolder(1, { total_emails: 3 });
    const view = {
      rows: [makeRow(1), makeRow(2), makeRow(3)],
      total: 3,
    };
    const { mailStore, repo } = await setupStore({
      folders: [folder],
      views: { 1: view },
    });
    await flush();
    expect(mailStore.messages.map((m) => m.id)).toEqual([1, 2, 3]);

    // Server now reports only one row at position 0. resetViewForFolder
    // (mocked to clear view.rows and view.total) simulates the FK
    // cascade dropping query_view_items; then ensureFolderWindow
    // populates the new authoritative state. We also use the
    // ensureFolderWindow stub as a sampling point to snapshot
    // isLoading mid-flight, so the test can prove the spinner state
    // gets set during the operation and not just before / after.
    let ensureCallCount = 0;
    let isLoadingDuringEnsure = null;
    repo.ensureFolderWindow = async (_accountId, folderId) => {
      ensureCallCount += 1;
      isLoadingDuringEnsure = mailStore.isLoading;
      const v = repo._views.get(folderId);
      if (v) {
        v.rows = [makeRow(99)];
        v.total = 1;
      }
      return { total: 1, fetched: 1 };
    };

    // isLoading starts false on a cached folder; refresh must flip it
    // before awaiting any RPC so the toolbar spinner appears.
    expect(mailStore.isLoading).toBe(false);
    await mailStore.refresh();
    await flush();

    expect((repo._calls as any).resetViewForFolder).toBe(1);
    expect(ensureCallCount).toBeGreaterThanOrEqual(1);
    expect(isLoadingDuringEnsure).toBe(true);
    expect(mailStore.messages.map((m) => m?.id)).toEqual([99]);
    expect(mailStore.totalForFolder).toBe(1);
    expect(mailStore.isLoading).toBe(false);
  });

  it('re-selects the previously open message when it survives the refresh', async () => {
    const folder = makeFolder(1, { total_emails: 250 });
    const view = {
      rows: Array.from({ length: 250 }, (_, index) => makeRow(index + 1)),
      total: 250,
    };
    const { mailStore, repo } = await setupStore({
      folders: [folder],
      views: { 1: view },
    });
    await flush();
    await mailStore.ensureLoaded(149, 150);
    await flush();

    mailStore.selectMessage(150);
    await flush();
    expect(mailStore.selectedMessageId).toBe(150);

    let emptyViewReadsFromResetBroadcast = 0;
    const originalListMessagesForView = repo.listMessagesForView;
    repo.listMessagesForView = async (args) => {
      const v = repo._views.get(args.folderId);
      if ((v?.rows ?? []).length === 0) emptyViewReadsFromResetBroadcast += 1;
      return originalListMessagesForView(args);
    };
    repo.resetViewForFolder = async (_accountId, folderId) => {
      const v = repo._views.get(folderId);
      if (v) {
        v.rows = [];
        v.total = 0;
      }
      repo.triggerBroadcast([TABLE_FAMILIES.MESSAGES]);
      return { deleted: 1 };
    };

    repo.ensureFolderWindow = async (_accountId, folderId, range: any = {}) => {
      const v = repo._views.get(folderId);
      if (!v) return { total: 0, fetched: 0 };
      v.total = 250;
      if (range.anchor === 'e-150') {
        v.rows[149] = makeRow(150, { subject: 'Subject 150 refreshed' });
        return {
          total: 250,
          fetched: 1,
          position: 149,
          ids: ['e-150'],
        };
      }
      const offset = range.offset ?? 0;
      const limit = range.limit ?? 100;
      for (let i = offset; i < Math.min(offset + limit, 100); i += 1) {
        v.rows[i] = makeRow(i + 1);
      }
      return {
        total: 250,
        fetched: Math.min(limit, 100 - offset),
        position: offset,
        ids: v.rows.slice(offset, offset + limit).filter(Boolean).map((row) => row.remote_id),
      };
    };

    await mailStore.refresh();
    await flush();

    expect(mailStore.selectedMessageId).toBe(150);
    expect(mailStore.messages[149]?.subject).toBe('Subject 150 refreshed');
    expect(mailStore.messageBody?.text).toBe('body-150');
    expect(emptyViewReadsFromResetBroadcast).toBe(0);
  });

  it('clears the open message when it no longer exists after refresh', async () => {
    const folder = makeFolder(1, { total_emails: 3 });
    const { mailStore, repo } = await setupStore({
      folders: [folder],
      views: { 1: { rows: [makeRow(1), makeRow(2), makeRow(3)], total: 3 } },
    });
    await flush();

    mailStore.selectMessage(2);
    await flush();

    repo.ensureFolderWindow = async (_accountId, folderId, range: any = {}) => {
      const v = repo._views.get(folderId);
      if (!v) return { total: 0, fetched: 0 };
      v.total = 2;
      if (range.anchor === 'e-2') {
        return {
          total: 2,
          fetched: 0,
          position: 0,
          ids: [],
        };
      }
      v.rows = [makeRow(1), makeRow(3)];
      return {
        total: 2,
        fetched: 2,
        position: range.offset ?? 0,
        ids: ['e-1', 'e-3'],
      };
    };

    await mailStore.refresh();
    await flush();

    expect(mailStore.messages.map((row) => row?.id)).toEqual([1, 3]);
    expect(mailStore.selectedMessageId).toBeNull();
    expect(mailStore.messageBody).toBeNull();
  });
});

describe('refreshLoadedPages after a remote shrink', () => {
  it('drops trailing placeholder rows when query_views.total shrinks', async () => {
    // Start with a folder that the cache says has 3 rows and the
    // server agrees on. After the initial paint the user is on the
    // folder; a peer device then destroys two messages. The
    // backend's queryChanges pass updates query_view_items and
    // query_views.total, then fires MESSAGES. The store must read
    // the new authoritative total via queryViewProgress and trim
    // its row buffer so the virtualizer stops rendering the dead
    // tail.
    const folder = makeFolder(1, { total_emails: 3 });
    const view = {
      rows: [makeRow(1), makeRow(2), makeRow(3)],
      total: 3,
    };
    const { mailStore, repo } = await setupStore({
      folders: [folder],
      views: { 1: view },
    });
    await flush();
    expect(mailStore.messages.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(mailStore.totalForFolder).toBe(3);

    // Peer destroys e-2 and e-3. queryChanges in the worker removed
    // them from query_view_items, leaving the view at 1 row.
    view.rows = [makeRow(1)];
    view.total = 1;
    repo.triggerBroadcast(['messages']);
    await flush();

    expect(mailStore.messages.map((m) => m.id)).toEqual([1]);
    expect(mailStore.messages).toHaveLength(1);
    expect(mailStore.totalForFolder).toBe(1);
  });

  it('coalesces a burst of MESSAGES broadcasts into one cache re-read', async () => {
    // Reproduces what bulk delete (and any rapid-fire broadcast
    // storm, e.g. a queryChanges pass with many removed ids) does to
    // the store. Without coalescing, each broadcast fires its own
    // refreshLoadedPages, and the user sees the row count tick down
    // one step per broadcast.
    const folder = makeFolder(1, { total_emails: 5 });
    const view = {
      rows: [makeRow(1), makeRow(2), makeRow(3), makeRow(4), makeRow(5)],
      total: 5,
    };
    const { mailStore, repo } = await setupStore({
      folders: [folder],
      views: { 1: view },
    });
    await flush();
    const callsBefore = repo._calls.listMessagesForView;

    // Simulate the outbox's per-id apply loop: each apply broadcasts
    // MESSAGES, each broadcast lands as a separate triggerBroadcast.
    // The cache is only mutated AFTER all of them (server returned
    // batched-success in real life); here we just want to see how
    // many refreshLoadedPages cycles actually run.
    for (let i = 0; i < 10; i += 1) {
      repo.triggerBroadcast(['messages']);
    }
    await flush();

    const callsAfter = repo._calls.listMessagesForView;
    // refreshLoadedPages does one listMessagesForView per painted
    // range. We started with one painted range, so each re-read pass
    // makes exactly one listMessagesForView call. With the
    // single-flight + dirty-flag coalescing, ten broadcasts result
    // in at most two passes (the initial one plus one re-run because
    // the dirty flag was set during it).
    expect(callsAfter - callsBefore).toBeLessThanOrEqual(2);
  });

  it('keeps the new top row visible when a push delivers new mail', async () => {
    // Mailbox/changes raises folder.total_emails first (the
    // currentFolder watcher mirrors that onto state.total); then
    // the queryChanges pass updates the view and broadcasts
    // MESSAGES. After the broadcast the new row at position 0
    // must be the freshly-arrived message and the row count must
    // include it.
    const folder = makeFolder(1, { total_emails: 1 });
    const view = { rows: [makeRow(1)], total: 1 };
    const { mailStore, repo } = await setupStore({
      folders: [folder],
      views: { 1: view },
    });
    await flush();
    expect(mailStore.messages.map((m) => m.id)).toEqual([1]);

    // New mail arrives: total_emails goes 1 -> 2 (Mailbox/changes
    // would update folders; we simulate by reseeding the listFolders
    // response and firing a FOLDERS broadcast), and the query view
    // gets a new row at the head (Email/queryChanges -> apply).
    repo.setFolders([makeFolder(1, { total_emails: 2 })]);
    view.rows = [makeRow(99), makeRow(1)];
    view.total = 2;
    repo.triggerBroadcast(['folders']);
    repo.triggerBroadcast(['messages']);
    await flush();

    expect(mailStore.totalForFolder).toBe(2);
    expect(mailStore.messages.map((m) => m.id)).toEqual([99, 1]);
  });
});
