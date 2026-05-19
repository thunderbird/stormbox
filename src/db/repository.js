/**
 * Main-thread repository client. Pinia stores call this; it speaks
 * MessagePort RPC to the SharedWorker. Stores never import wa-sqlite or
 * the JMAP transport directly.
 *
 * The single instance is connected once on app boot via createRepository()
 * and shared across all stores.
 */

import { assertSupportedBrowser } from './availability.js';
import { BROADCAST_CHANNEL, DB_RPC } from './protocol.js';
import { RPC_REQUEST, RPC_RESPONSE, TABLES_TOUCHED, WORKER_LOG } from './rpc-dispatch.js';

/**
 * @typedef {import('./protocol.js').DB_RPC} DBRpcMethods
 */

/**
 * Create a Repository connected to the SharedWorker at workerUrl.
 *
 * @param {object} options
 * @param {string|URL} options.workerUrl  resolved URL of shared-worker.js
 *   (typically built via `new URL('./shared-worker.js', import.meta.url)`
 *   so Vite captures it as a worker entry).
 * @returns {Repository}
 */
export function createRepository({ workerUrl }) {
  assertSupportedBrowser();
  const worker = new SharedWorker(workerUrl, { type: 'module', name: 'stormbox-db' });
  const channel = new BroadcastChannel(BROADCAST_CHANNEL);
  const repo = new Repository(worker.port, channel);
  worker.port.start();
  return repo;
}

export class Repository {
  /**
   * @param {MessagePort} port
   * @param {BroadcastChannel} channel
   */
  constructor(port, channel) {
    this._port = port;
    this._channel = channel;
    this._nextId = 1;
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: any) => void }>} */
    this._pending = new Map();
    /** @type {Set<(tables: string[]) => void>} */
    this._listeners = new Set();

    port.addEventListener('message', (msg) => this._onMessage(msg));
    channel.addEventListener('message', (msg) => this._onBroadcast(msg));
  }

  /**
   * Register a callback invoked with the touched table-family names every
   * time the SharedWorker writes a transaction. Returns an unsubscribe
   * function. Stores typically use this to invalidate vue-query cache
   * keys or re-run their queries.
   */
  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /**
   * Low-level RPC. Most callers use one of the named helper methods below.
   */
  call(method, params = {}) {
    const id = this._nextId;
    this._nextId += 1;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._port.postMessage({ type: RPC_REQUEST, id, method, params });
    });
  }

  // Account ------------------------------------------------------------

  listAccounts() {
    return this.call(DB_RPC.ACCOUNT_LIST);
  }

  upsertAccount(account) {
    return this.call(DB_RPC.ACCOUNT_UPSERT, account);
  }

  getAccountByRemote(serverOrigin, remoteAccountId) {
    return this.call(DB_RPC.ACCOUNT_GET_BY_REMOTE, { serverOrigin, remoteAccountId });
  }

  upsertAccountService(input) {
    return this.call(DB_RPC.ACCOUNT_SERVICE_UPSERT, input);
  }

  replaceAccountCapabilities(accountId, serviceKind, capabilities) {
    return this.call(DB_RPC.ACCOUNT_CAPABILITIES_REPLACE, {
      accountId,
      serviceKind,
      capabilities,
    });
  }

  // Folders ------------------------------------------------------------

  listFolders(accountId, options = {}) {
    return this.call(DB_RPC.FOLDER_LIST, { accountId, ...options });
  }

  upsertFolders(accountId, folders) {
    return this.call(DB_RPC.FOLDER_UPSERT_MANY, { accountId, folders });
  }

  folderByRole(accountId, role) {
    return this.call(DB_RPC.FOLDER_BY_ROLE, { accountId, role });
  }

  // Identities ---------------------------------------------------------

  listIdentities(accountId) {
    return this.call(DB_RPC.IDENTITY_LIST, { accountId });
  }

  upsertIdentities(accountId, identities) {
    return this.call(DB_RPC.IDENTITY_UPSERT_MANY, { accountId, identities });
  }

  // Threads ------------------------------------------------------------

  upsertThreads(accountId, threads) {
    return this.call(DB_RPC.THREAD_UPSERT_MANY, { accountId, threads });
  }

  // Messages -----------------------------------------------------------

  upsertMessages(accountId, messages) {
    return this.call(DB_RPC.MESSAGE_UPSERT_MANY, { accountId, messages });
  }

  listMessagesForFolder(folderId, options = {}) {
    return this.call(DB_RPC.MESSAGE_LIST_FOR_FOLDER, { folderId, ...options });
  }

  /**
   * Positional read of a folder's mailbox-window view. Unlike
   * listMessagesForFolder (SQL OFFSET over folder_messages), this
   * returns rows by their JMAP `position` so it works correctly at
   * deep offsets in a sparsely-cached folder.
   *
   * @param {object} args
   * @param {number} args.accountId
   * @param {number} args.folderId
   * @param {'received'|'sent'} [args.sort='received']
   * @param {number} [args.offset=0]
   * @param {number} [args.limit=100]
   */
  listMessagesForView({ accountId, folderId, sort = 'received', offset = 0, limit = 100 }) {
    return this.call(DB_RPC.MESSAGE_LIST_FOR_VIEW, { accountId, folderId, sort, offset, limit });
  }

  queryViewProgress({ accountId, folderId, sort = 'received' }) {
    return this.call(DB_RPC.QUERY_VIEW_PROGRESS, { accountId, folderId, sort });
  }

  /**
   * Drop the local mailbox-window view for a folder along with every
   * query_view_items / query_view_ranges row tied to it (FK cascade).
   * The next sync of this folder will rebuild the view from scratch
   * against the server's authoritative list. Use this for the user-
   * facing "Refresh" recovery path when local cache is suspected of
   * being out of sync with the server (ghost rows, FK violations,
   * etc.). The handler broadcasts MESSAGES so other tabs re-paint.
   */
  resetViewForFolder(accountId, folderId) {
    return this.call(DB_RPC.QUERY_VIEW_RESET_FOR_FOLDER, { accountId, folderId });
  }

  getMessageByRemote(accountId, remoteId) {
    return this.call(DB_RPC.MESSAGE_GET_BY_REMOTE, { accountId, remoteId });
  }

  listMessagesForThread(threadId) {
    return this.call(DB_RPC.MESSAGE_LIST_FOR_THREAD, { threadId });
  }

  findMessageByRfc822MessageId(accountId, rfc822MessageId) {
    return this.call(DB_RPC.MESSAGE_FIND_BY_RFC822_MESSAGE_ID, {
      accountId,
      rfc822MessageId,
    });
  }

  replaceMessageKeywords(messageId, keywords, keywordsJson) {
    return this.call(DB_RPC.MESSAGE_REPLACE_KEYWORDS, {
      messageId,
      keywords,
      keywordsJson,
    });
  }

  replaceFolderMembership(accountId, messageId, memberships) {
    return this.call(DB_RPC.FOLDER_MEMBERSHIP_REPLACE, {
      accountId,
      messageId,
      memberships,
    });
  }

  replaceFolderMemberships(accountId, replacements) {
    return this.call(DB_RPC.FOLDER_MEMBERSHIP_REPLACE_MANY, {
      accountId,
      replacements,
    });
  }

  // Contacts -----------------------------------------------------------

  listAddressbooks(accountId) {
    return this.call(DB_RPC.ADDRESSBOOK_LIST, { accountId });
  }

  upsertAddressbooks(accountId, serviceKind, addressbooks) {
    return this.call(DB_RPC.ADDRESSBOOK_UPSERT_MANY, {
      accountId,
      serviceKind,
      addressbooks,
    });
  }

  upsertContacts(accountId, contacts) {
    return this.call(DB_RPC.CONTACT_UPSERT_MANY, { accountId, contacts });
  }

  autocompleteContacts(accountId, prefix, limit = 20) {
    return this.call(DB_RPC.CONTACT_AUTOCOMPLETE, { accountId, prefix, limit });
  }

  // Sync infrastructure ------------------------------------------------

  getSyncState(accountId, objectType, scope = '') {
    return this.call(DB_RPC.SYNC_STATE_GET, { accountId, objectType, scope });
  }

  setSyncState(accountId, objectType, scope, state) {
    return this.call(DB_RPC.SYNC_STATE_SET, { accountId, objectType, scope, state });
  }

  insertPendingMutation(input) {
    return this.call(DB_RPC.PENDING_MUTATION_INSERT, input);
  }

  listPendingMutations(accountId, limit = 50) {
    return this.call(DB_RPC.PENDING_MUTATION_LIST_PENDING, { accountId, limit });
  }

  insertSyncJob(input) {
    return this.call(DB_RPC.SYNC_JOB_INSERT, input);
  }

  nextSyncJobBatch(options = {}) {
    return this.call(DB_RPC.SYNC_JOB_NEXT_BATCH, options);
  }

  // Sync control plane ------------------------------------------------

  startSyncAccount(input) {
    return this.call(DB_RPC.SYNC_START_ACCOUNT, input);
  }

  stopSyncAccount(accountId) {
    return this.call(DB_RPC.SYNC_STOP_ACCOUNT, { accountId });
  }

  ensureFolderTree(accountId) {
    return this.call(DB_RPC.SYNC_ENSURE_FOLDER_TREE, { accountId });
  }

  ensureFolderWindow(accountId, folderId, range = {}) {
    return this.call(DB_RPC.SYNC_ENSURE_FOLDER_WINDOW, { accountId, folderId, range });
  }

  ensureMessageBody(accountId, messageId) {
    return this.call(DB_RPC.SYNC_ENSURE_MESSAGE_BODY, { accountId, messageId });
  }

  ensureMessageBodies(accountId, messageIds) {
    return this.call(DB_RPC.SYNC_ENSURE_MESSAGE_BODIES, { accountId, messageIds });
  }

  /**
   * Load body content for the reading pane: SQLite first, then a
   * priority single-message fetch on cache miss (not blocked by an
   * in-flight scroll prefetch batch).
   *
   * @returns {Promise<{ text: string, html: string, attachments: object[] } | null>}
   */
  getMessageBodyForDisplay(accountId, messageId) {
    return this.call(DB_RPC.SYNC_MESSAGE_BODY_FOR_DISPLAY, { accountId, messageId });
  }

  ensureIdentities(accountId) {
    return this.call(DB_RPC.SYNC_ENSURE_IDENTITIES, { accountId });
  }

  ensureAddressbooks(accountId) {
    return this.call(DB_RPC.SYNC_ENSURE_ADDRESSBOOKS, { accountId });
  }

  ensureContacts(accountId, addressbookId) {
    return this.call(DB_RPC.SYNC_ENSURE_CONTACTS, { accountId, addressbookId });
  }

  ensureFolderIndex(accountId, folderId, options = {}) {
    return this.call(DB_RPC.SYNC_ENSURE_FOLDER_INDEX, { accountId, folderId, options });
  }

  drainOutbox(accountId, limit = 25) {
    return this.call(DB_RPC.SYNC_DRAIN_OUTBOX, { accountId, limit });
  }

  runMutation(accountId, mutationId) {
    return this.call(DB_RPC.SYNC_RUN_MUTATION, { accountId, mutationId });
  }

  // Internals ----------------------------------------------------------

  _onMessage(msg) {
    const data = msg.data;
    if (!data || data.type !== RPC_RESPONSE) {
      return;
    }
    const pending = this._pending.get(data.id);
    if (!pending) {
      return;
    }
    this._pending.delete(data.id);
    if (data.error) {
      pending.reject(new Error(data.error));
      return;
    }
    pending.resolve(data.result);
  }

  _onBroadcast(msg) {
    const data = msg.data;
    if (!data) return;

    if (data.type === WORKER_LOG) {
      // Mirror SharedWorker logs onto the main-thread console so they
      // are visible in devtools and to Playwright's page.on('console').
      const fn = console[data.level] ?? console.log;
      fn(`[worker:${data.source}] ${data.message}`);
      return;
    }

    if (data.type === TABLES_TOUCHED && Array.isArray(data.tables)) {
      for (const listener of this._listeners) {
        try {
          listener(data.tables);
        } catch (err) {
          console.error('Repository subscriber threw', err);
        }
      }
    }
  }
}
