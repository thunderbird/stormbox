/**
 * End-to-end integration test: mail-store.destroyMessage -> outboxRunner
 * -> processMutationRow -> applyMoveLocally -> MESSAGES broadcast ->
 * mail-store.onTablesTouched -> refreshLoadedPages -> messages.value
 * reflects the deletion.
 *
 * The mocked-store tests in tests/unit/stores/mail-store.test.js return
 * { succeeded: 1, failed: 0 } from runMutation without touching local
 * SQLite, so they cannot prove that the user-visible mail-store state
 * actually updates after a delete. The outbox tests prove the cache
 * is updated, but they don't drive the mail-store. This file wires
 * BOTH together against a real in-memory engine + a MockTransport so
 * the assertion is the one the user actually cares about: "after I
 * click Delete, the message is no longer in the Inbox row buffer".
 */

import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { BroadcastChannel as NodeBroadcastChannel } from 'node:worker_threads';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC, BROADCAST_CHANNEL } from '../../../src/db/protocol';
import { makeBroadcaster, TABLES_TOUCHED } from '../../../src/db/rpc-dispatch';
import { syncMailboxes } from '../../../src/sync/backends/jmap/mailboxes';
import { syncFolderWindow } from '../../../src/sync/backends/jmap/messages';
import { processMutationRow } from '../../../src/sync/backends/jmap/outbox';
import { OutboxRunner } from '../../../src/sync/backends/jmap/outbox-runner';
import { MockTransport } from '../sync/_mock-transport';
import { useMailStore } from '../../../src/stores/mail-store';
import { useAuthStore } from '../../../src/stores/auth-store';
import {
  __setRepositoryForTests,
  __resetRepositoryForTests,
} from '../../../src/composables/useRepository';

if (typeof globalThis.BroadcastChannel === 'undefined') {
  globalThis.BroadcastChannel = NodeBroadcastChannel;
}

const NOW = Date.parse('2026-05-01T12:00:00Z');

function emailFixture(id: string, { mailboxIds = { 'mb-inbox': true } as Record<string, boolean> } = {}) {
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

/**
 * Drain Vue's microtask queue plus a bit of real-clock time so async
 * BroadcastChannel deliveries can hop through. The broadcast carrier
 * in tests is the Node BroadcastChannel polyfill, which posts via
 * setImmediate; pure microtask flushes can miss it.
 */
async function flush(count = 12) {
  for (let i = 0; i < count; i += 1) {
    await nextTick();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

let engine;
let handlers;
let broadcaster;
let broadcastChannel;
let mainThreadChannel;
let outboxRunner;
let account;
let inbox;
let trash;
let archive;
let messageId;
let transport;
let serverState;

beforeEach(async () => {
  engine = await bootTestEngine();
  broadcastChannel = new globalThis.BroadcastChannel(BROADCAST_CHANNEL);
  broadcaster = makeBroadcaster(broadcastChannel);
  // Hooks fill in the runner notify path so the production wiring
  // (PENDING_MUTATION_INSERT -> onMutationInserted -> runner.notify)
  // is exercised verbatim.
  handlers = makeHandlers(engine, broadcaster, {
    onMutationInserted: () => outboxRunner?.notify(),
  });
  account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
    displayName: 'T',
    primaryEmail: 't@example.com',
    serverOrigin: 'https://mail.example.com',
    remoteAccountId: 'acct-1',
    isPrimary: true,
  })).row;

  // Seed the folder tree.
  const mailboxTransport = new MockTransport();
  mailboxTransport.handle('Mailbox/get', () => ({
    list: [
      { id: 'mb-inbox', name: 'Inbox', role: 'inbox' },
      { id: 'mb-archive', name: 'Archive', role: 'archive' },
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
  archive = await engine.get(
    'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
    [account.id, 'mb-archive'],
  );

  // Seed one message at Inbox position 0 via the real syncFolderWindow.
  const messageTransport = new MockTransport();
  messageTransport.handle('Email/query', () => ({
    ids: ['e-1'], total: 1, queryState: 'qs', canCalculateChanges: true, position: 0,
  }));
  messageTransport.handle('Email/get', (params) => ({
    list: params.ids.map((id) => emailFixture(id)),
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

  // Real transport-shaped mock for the outbox to call. The user's
  // bug was specifically "server accepted the delete, local cache
  // never updated"; the transport here returns success so we
  // exercise that exact path.
  transport = new MockTransport();
  serverState = 'updated';
  transport.handle('Email/set', (params) => {
    if (params.update) {
      return { updated: Object.fromEntries(Object.keys(params.update).map((id) => [id, null])) };
    }
    if (params.destroy) {
      return { destroyed: params.destroy };
    }
    return {};
  });

  outboxRunner = new OutboxRunner({
    accountId: account.id,
    handlers,
    processRow: (rowToProcess) => processMutationRow({
      transport, account, handlers, row: rowToProcess, useWebSocket: false,
    }),
    options: {
      notifyDelayMs: 0, // make tests deterministic
    },
  });

  // Main-thread side of the BroadcastChannel, so the mail-store's
  // listener gets the same TABLES_TOUCHED events the production
  // worker would post.
  mainThreadChannel = new globalThis.BroadcastChannel(BROADCAST_CHANNEL);

  setActivePinia(createPinia());
  const authStore = useAuthStore();
  authStore.accountId = account.id;
  __setRepositoryForTests(makeRepo());
  const mailStore = useMailStore();
  await mailStore.attach();
  await flush();
  // Sanity-check the test fixture before any test runs: Inbox must
  // have rendered the one seeded message.
  mailStore.selectFolder(inbox.id);
  await flush();
  expect(mailStore.messages.map((m) => m?.remote_id)).toContain('e-1');
});

afterEach(async () => {
  await outboxRunner?.stop();
  broadcastChannel?.close();
  mainThreadChannel?.close();
  __resetRepositoryForTests();
  await engine.close();
  // Suppress the "node:worker_threads BroadcastChannel reference"
  // warning that vitest's environment cleanup otherwise prints.
  serverState = null;
});

function makeRepo() {
  // Thin facade: maps the calls mail-store makes onto the worker-side
  // handlers + OutboxRunner. The only async-cross-thread thing this
  // skips is the MessagePort hop; broadcasts go through a real
  // BroadcastChannel so onTablesTouched is exercised on the same code
  // path as production.
  const listeners = new Set<(tables: string[]) => void>();
  mainThreadChannel.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== TABLES_TOUCHED) return;
    for (const listener of listeners) {
      try { listener(data.tables); } catch { /* noop */ }
    }
  });
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async listAccounts() {
      return handlers[DB_RPC.ACCOUNT_LIST]();
    },
    async listFolders(accountId) {
      return handlers[DB_RPC.FOLDER_LIST]({ accountId });
    },
    async listMessagesForView(args) {
      return handlers[DB_RPC.MESSAGE_LIST_FOR_VIEW](args);
    },
    async queryViewProgress(args) {
      return handlers[DB_RPC.QUERY_VIEW_PROGRESS](args);
    },
    async ensureFolderTree() { return { count: 0 }; },
    async ensureFolderWindow() { return { total: 0, fetched: 0 }; },
    async ensureMessageBodies() { return { fetched: 0 }; },
    async insertPendingMutation(input) {
      return handlers[DB_RPC.PENDING_MUTATION_INSERT](input);
    },
    async runMutation(_accountId, mutationId) {
      return outboxRunner.runMutation(mutationId);
    },
    async drainOutbox() {
      return outboxRunner.drain();
    },
    async replaceMessageKeywords(messageIdArg, keywords, keywordsJson) {
      return handlers[DB_RPC.MESSAGE_REPLACE_KEYWORDS]({
        messageId: messageIdArg, keywords, keywordsJson,
      });
    },
    async resetViewForFolder(accountId, folderId) {
      return handlers[DB_RPC.QUERY_VIEW_RESET_FOR_FOLDER]({ accountId, folderId });
    },
    async filterExistingMessageIds(accountId, ids) {
      return handlers[DB_RPC.MESSAGE_FILTER_EXISTING_IDS]({ accountId, ids });
    },
    async getPendingMutationError(mutationId) {
      return handlers[DB_RPC.PENDING_MUTATION_GET_ERROR]({ mutationId });
    },
    async call(method, params) {
      return handlers[method](params);
    },
  };
}

describe('mail-store.destroyMessage end-to-end through OutboxRunner', () => {
  it('feeds the store-built cross-account copy through processMutationRow', async () => {
    const shared = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'Shared',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'acct-shared',
      isPrimary: false,
      isPersonal: false,
    })).row;
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: shared.id,
      folders: [{
        remoteId: 'shared-team',
        name: 'Shared Team',
        isSubscribed: true,
        rightsJson: JSON.stringify({ mayAddItems: true }),
      }],
    });
    const destination = await engine.get(
      `SELECT * FROM folders WHERE account_id = ? AND remote_id = 'shared-team'`,
      [shared.id],
    );
    let copyParams;
    transport.handle('Email/copy', (params) => {
      copyParams = params;
      return { created: { 'e-1': { id: 'shared-copy-1' } } };
    });
    transport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailFixture(id, {
        mailboxIds: { 'shared-team': true },
      })),
      state: 'shared-es1',
    }));

    const mailStore = useMailStore();
    await mailStore.refreshFolders();
    mailStore.selectFolder(inbox.id);
    await flush(20);
    const result = await mailStore.moveMessages([messageId], destination.id);

    expect(result).toEqual({ succeeded: 1, failed: 0, skipped: 0 });
    expect(copyParams).toMatchObject({
      fromAccountId: 'acct-1',
      accountId: 'acct-shared',
      onSuccessDestroyOriginal: false,
    });
    expect(copyParams.create['e-1']).toEqual({
      id: 'e-1',
      mailboxIds: { 'shared-team': true },
    });
    expect(await engine.get(
      `SELECT id FROM messages WHERE account_id = ? AND remote_id = 'e-1'`,
      [account.id],
    )).toBeTruthy();
    expect(await engine.get(
      `SELECT id FROM messages WHERE account_id = ? AND remote_id = 'shared-copy-1'`,
      [shared.id],
    )).toBeTruthy();
  });

  it('moves a message from Inbox to Archive through moveToFolders and updates the rendered Inbox', async () => {
    let setCallCount = 0;
    transport.handle('Email/set', (params) => {
      setCallCount += 1;
      return { updated: Object.fromEntries(Object.keys(params.update ?? {}).map((id) => [id, null])) };
    });

    const mailStore = useMailStore();
    expect(mailStore.currentFolderId).toBe(inbox.id);
    expect(mailStore.messages.map((m) => m?.remote_id)).toEqual(['e-1']);
    mailStore.selectedIds = new Set([messageId]);
    mailStore.selectedMessageId = messageId;

    const result = await mailStore.moveMessages([messageId], archive.id);
    await flush(30);

    expect(result).toEqual({ succeeded: 1, failed: 0, skipped: 0 });
    expect(setCallCount).toBe(1);

    const memberships = await engine.all(
      'SELECT folder_id FROM folder_messages WHERE message_id = ? ORDER BY folder_id',
      [messageId],
    );
    expect(memberships.map((row) => Number(row.folder_id))).toEqual([archive.id]);

    const inboxView = await engine.get(
      `SELECT id, total FROM query_views
        WHERE account_id = ? AND folder_id = ? AND view_type = 'mailbox-window'`,
      [account.id, inbox.id],
    );
    const inboxItems = await engine.all(
      'SELECT remote_id FROM query_view_items WHERE view_id = ?',
      [inboxView.id],
    );
    expect(inboxItems).toEqual([]);
    expect(Number(inboxView.total)).toBe(0);
    expect(mailStore.messages.filter((m) => m != null).map((m) => m.remote_id))
      .not.toContain('e-1');
    expect(mailStore.selectedIds.size).toBe(0);
    expect(mailStore.selectedMessageId).toBeNull();
  });

  it('removes the deleted message from messages.value when moving from Inbox to Trash', async () => {
    const mailStore = useMailStore();
    expect(mailStore.currentFolderId).toBe(inbox.id);
    expect(mailStore.messages.map((m) => m?.remote_id)).toEqual(['e-1']);

    await mailStore.destroyMessage(messageId);

    // Give the post-write broadcast a chance to propagate through the
    // real BroadcastChannel and the mail-store's onTablesTouched ->
    // refreshLoadedPages chain.
    await flush(30);

    // The cache itself should have moved the message to Trash and
    // dropped it from the Inbox view's items.
    const inboxView = await engine.get(
      `SELECT id, total FROM query_views
        WHERE account_id = ? AND folder_id = ? AND view_type = 'mailbox-window'`,
      [account.id, inbox.id],
    );
    const inboxItems = await engine.all(
      'SELECT remote_id FROM query_view_items WHERE view_id = ?',
      [inboxView.id],
    );
    expect(inboxItems).toEqual([]);
    expect(Number(inboxView.total)).toBe(0);

    // And the user-visible mail-store buffer must reflect that.
    // This is the assertion the user-reported symptom maps to:
    //   "When I delete a message, the local inbox is not updated at all".
    expect(mailStore.messages.filter((m) => m != null).map((m) => m.remote_id))
      .not.toContain('e-1');
  });

  it('multi-select bulk delete fires a single Email/set for all ids', async () => {
    // Seed a second Inbox message so the bulk path has something to
    // batch. The second sync replaces the cached query_view_items
    // with the new two-id list at positions 0..1.
    transport.handle('Email/query', () => ({
      ids: ['e-1', 'e-2'], total: 2, queryState: 'qs2',
      canCalculateChanges: true, position: 0,
    }));
    transport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailFixture(id)),
      state: 'es',
    }));
    await syncFolderWindow({ transport, account, folder: inbox, handlers });
    // Reset the Email/set handler and count its invocations - the
    // whole point of this test is "one request, not two".
    let setCallCount = 0;
    transport.handle('Email/set', (params) => {
      setCallCount += 1;
      if (params.update) {
        return { updated: Object.fromEntries(Object.keys(params.update).map((id) => [id, null])) };
      }
      if (params.destroy) return { destroyed: params.destroy };
      return {};
    });

    const mailStore = useMailStore();
    mailStore.selectFolder(inbox.id);
    await flush(20);
    expect([...mailStore.messages.filter((m) => m != null).map((m) => m.remote_id)].sort())
      .toEqual(['e-1', 'e-2']);

    const e2 = await engine.get(
      'SELECT id FROM messages WHERE account_id = ? AND remote_id = ?',
      [account.id, 'e-2'],
    );

    await mailStore.destroyMessages([messageId, e2.id]);
    await flush(30);

    // Exactly one Email/set round trip for the whole batch.
    expect(setCallCount).toBe(1);
    // And both ids are gone from the rendered list.
    expect(mailStore.messages.filter((m) => m != null).map((m) => m.remote_id))
      .not.toContain('e-1');
    expect(mailStore.messages.filter((m) => m != null).map((m) => m.remote_id))
      .not.toContain('e-2');
  });

  it('removes the deleted message when permanently destroying from Trash', async () => {
    const mailStore = useMailStore();

    // Move the seed to Trash so the destroy mutation has somewhere
    // realistic to fire from.
    await mailStore.destroyMessage(messageId);
    await flush(30);
    mailStore.selectFolder(trash.id);
    await flush(20);
    // The Trash view doesn't have the moved message in
    // query_view_items yet because applyMoveLocally only marks the
    // destination stale. Seed it via the sync helper so the rest of
    // this test mirrors a real "deleted from Trash" interaction.
    transport.handle('Email/query', () => ({
      ids: ['e-1'], total: 1, queryState: 'tqs', canCalculateChanges: true, position: 0,
    }));
    transport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailFixture(id, { mailboxIds: { 'mb-trash': true } })),
      state: 'es',
    }));
    await syncFolderWindow({
      transport, account, folder: trash, handlers,
    });
    // Reset the Email/set handler for the destroy round-trip.
    transport.handle('Email/set', (params) => ({ destroyed: params.destroy }));
    await flush(20);
    expect(mailStore.messages.map((m) => m?.remote_id)).toContain('e-1');

    await mailStore.destroyMessage(messageId);
    await flush(30);

    expect(await engine.get('SELECT id FROM messages WHERE id = ?', [messageId]))
      .toBeNull();
    expect(mailStore.messages.filter((m) => m != null).map((m) => m.remote_id))
      .not.toContain('e-1');
  });
});
