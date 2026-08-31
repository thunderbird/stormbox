/**
 * Main-thread repository client. Pinia stores call this; it speaks
 * MessagePort RPC to the SharedWorker. Stores never import wa-sqlite or
 * the JMAP transport directly.
 *
 * The single instance is connected once on app boot via createRepository()
 * and shared across all stores.
 */

import type {
  AddressBookInventory,
  ContactDetail,
  ContactListRow,
  ContactTrashDetail,
  ContactTrashListRow,
  ContactTrashLookup,
  IdentityRow,
  IdentityUpsertInput,
} from '../types/db';
import { assertSupportedBrowser } from './availability';
import { BROADCAST_CHANNEL, DB_RPC, SHARED_WORKER_NAME } from './protocol';
import {
  RPC_CANCEL,
  RPC_PROGRESS,
  RPC_REQUEST,
  RPC_RESPONSE,
  TABLES_TOUCHED,
  WORKER_LOG,
} from './rpc-dispatch';

export interface BlobTransferProgress {
  direction: 'upload' | 'download';
  phase: 'transferring' | 'processing' | 'complete';
  loaded: number;
  total: number | null;
}

export interface AttachmentLimits {
  maxSizeUpload: number;
  maxSizeAttachmentsPerEmail: number;
  maxConcurrentUpload: number;
}

export interface JmapUploadMetadata {
  accountId: string;
  blobId: string;
  type: string;
  size: number;
}

export interface TransferCallOptions {
  signal?: AbortSignal;
  onProgress?: (progress: BlobTransferProgress) => void;
}

/**
 * @typedef {import('./protocol').DB_RPC} DBRpcMethods
 */

/**
 * Create a Repository connected to the SharedWorker.
 *
 * @param {object} options
 * @param {SharedWorker} [options.worker]  preconstructed worker, typically
 *   from Vite's `?sharedworker` import so production emits a real worker chunk.
 * @param {string|URL} [options.workerUrl]  resolved URL fallback for tests or
 *   non-Vite callers.
 * @returns {Repository}
 */
export function createRepository(
  { worker, workerUrl }: { worker?: SharedWorker; workerUrl?: string | URL },
) {
  assertSupportedBrowser();
  if (!worker && workerUrl == null) {
    throw new Error('createRepository requires a SharedWorker or workerUrl.');
  }
  worker ??= new SharedWorker(workerUrl!, { type: 'module', name: SHARED_WORKER_NAME });
  const channel = new BroadcastChannel(BROADCAST_CHANNEL);
  const repo = new Repository(worker.port, channel);
  worker.port.start();
  return repo;
}

export class Repository {
  _port: MessagePort;
  _channel: BroadcastChannel;
  _nextId: number;
  _pending: Map<number, {
    resolve: (v: any) => void;
    reject: (e: any) => void;
    onProgress?: (progress: BlobTransferProgress) => void;
    removeAbort?: () => void;
  }>;
  _listeners: Set<(tables: string[]) => void>;

  constructor(port: MessagePort, channel: BroadcastChannel) {
    this._port = port;
    this._channel = channel;
    this._nextId = 1;
    this._pending = new Map();
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
   * Low-level RPC. Most callers use one of the named helper methods
   * below. Values cross through structured clone, including Blob/File for
   * transfer RPCs. Consumers narrow loosely typed results at the call site
   * or use a named helper with an annotated return type.
   */
  call<T = any>(method: string, params: any = {}): Promise<T> {
    return this._call<T>(method, params);
  }

  _call<T = any>(
    method: string,
    params: any = {},
    options: TransferCallOptions = {},
  ): Promise<T> {
    const id = this._nextId;
    this._nextId += 1;
    return new Promise<T>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(cancelledRpcError());
        return;
      }
      const onAbort = () => {
        this._port.postMessage({ type: RPC_CANCEL, id });
      };
      if (options.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
      this._pending.set(id, {
        resolve,
        reject,
        onProgress: options.onProgress,
        removeAbort: options.signal
          ? () => options.signal?.removeEventListener('abort', onAbort)
          : undefined,
      });
      try {
        this._port.postMessage({ type: RPC_REQUEST, id, method, params });
      } catch (error) {
        this._pending.delete(id);
        options.signal?.removeEventListener('abort', onAbort);
        reject(error);
      }
    });
  }

  // Account ------------------------------------------------------------

  listAccounts() {
    return this.call(DB_RPC.ACCOUNT_LIST);
  }

  getAccount(accountId) {
    return this.call(DB_RPC.ACCOUNT_GET, { accountId });
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

  getAccountCapabilities(accountId, serviceKind) {
    return this.call(DB_RPC.ACCOUNT_CAPABILITIES_GET, {
      accountId,
      serviceKind,
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

  setFolderStarred(folderId, isStarred) {
    return this.setFoldersStarred([folderId], isStarred);
  }

  setFoldersStarred(folderIds, isStarred) {
    return this.call(DB_RPC.FOLDER_SET_STARRED_MANY, { folderIds, isStarred });
  }

  // Identities ---------------------------------------------------------

  listIdentities(accountId): Promise<IdentityRow[]> {
    return this.call<IdentityRow[]>(DB_RPC.IDENTITY_LIST, { accountId });
  }

  getIdentityByRemote(accountId, remoteId): Promise<IdentityRow | null> {
    return this.call<IdentityRow | null>(DB_RPC.IDENTITY_GET_BY_REMOTE, {
      accountId,
      remoteId,
    });
  }

  upsertIdentities(accountId, identities: IdentityUpsertInput[]) {
    return this.call(DB_RPC.IDENTITY_UPSERT_MANY, { accountId, identities });
  }

  deleteLocalIdentity(accountId, remoteId) {
    return this.call(DB_RPC.IDENTITY_DELETE_LOCAL, { accountId, remoteId });
  }

  ensureIdentityMutation(input) {
    return this.call(DB_RPC.IDENTITY_MUTATION_ENSURE, input);
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
   * Diagnostic snapshot used by the mail-store to detect drift between
   * the canonical mailbox-window query view and folder_messages
   * membership. Returns query-view totals AND membership counts so the
   * store can decide whether to mark the view stale and rebuild from
   * JMAP. Not a UI list path.
   */
  checkFolderViewConsistency({ accountId, folderId, sort = 'received' }) {
    return this.call(DB_RPC.FOLDER_VIEW_CONSISTENCY, { accountId, folderId, sort });
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

  /**
   * The message's addresses as `{kind, position, name, email}` rows, where
   * `kind` is one of from, to, cc, bcc, replyTo, sender. Compose reads
   * these to address a reply, since Cc and Reply-To exist nowhere else in
   * the cache.
   */
  listMessageAddresses(messageId) {
    return this.call(DB_RPC.MESSAGE_LIST_ADDRESSES, { messageId });
  }

  /**
   * Return the subset of `ids` that still resolve to a live row in
   * `messages` for `accountId`. Used by the mail-store to drop stale
   * UI ids before enqueuing a mutation.
   */
  filterExistingMessageIds(accountId, ids) {
    return this.call(DB_RPC.MESSAGE_FILTER_EXISTING_IDS, { accountId, ids });
  }

  replaceMessageKeywords(messageId, keywords, keywordsJson) {
    return this.call(DB_RPC.MESSAGE_REPLACE_KEYWORDS, {
      messageId,
      keywords,
      keywordsJson,
    });
  }

  replaceMessageKeywordsMany(items) {
    return this.call(DB_RPC.MESSAGE_REPLACE_KEYWORDS_MANY, { items });
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

  ensureAddressbookMutation(input) {
    return this.call(DB_RPC.ADDRESSBOOK_MUTATION_ENSURE, input);
  }

  upsertContacts(accountId, contacts) {
    return this.call(DB_RPC.CONTACT_UPSERT_MANY, { accountId, contacts });
  }

  /**
   * List contacts (with their preferred email) for the contact-book
   * view. Components must go through this rather than speaking SQL
   * to the worker.
   */
  listContacts(
    accountId: number,
    options: { limit?: number } = {},
  ): Promise<ContactListRow[]> {
    return this.call<ContactListRow[]>(DB_RPC.CONTACT_LIST, { accountId, ...options });
  }

  getContact(accountId: number, contactId: number): Promise<ContactDetail | null> {
    return this.call<ContactDetail | null>(DB_RPC.CONTACT_GET, { accountId, contactId });
  }

  listContactTrash(accountId: number): Promise<ContactTrashListRow[]> {
    return this.call<ContactTrashListRow[]>(DB_RPC.CONTACT_TRASH_LIST, { accountId });
  }

  getContactTrash(
    accountId: number,
    trashId: number,
  ): Promise<ContactTrashDetail | null> {
    return this.call<ContactTrashDetail | null>(
      DB_RPC.CONTACT_TRASH_GET,
      { accountId, trashId },
    );
  }

  getContactTrashMany(
    accountId: number,
    trashIds: number[],
  ): Promise<ContactTrashLookup[]> {
    return this.call<ContactTrashLookup[]>(
      DB_RPC.CONTACT_TRASH_GET_MANY,
      { accountId, trashIds },
    );
  }

  autocompleteContacts(accountId, prefix, limit = 20, exclude = []) {
    return this.call(DB_RPC.CONTACT_AUTOCOMPLETE, { accountId, prefix, limit, exclude });
  }

  // Settings -----------------------------------------------------------

  getSettings(accountId) {
    return this.call(DB_RPC.SETTINGS_GET, { accountId });
  }

  applySettingsPatch(accountId, patch) {
    return this.call(DB_RPC.SETTINGS_APPLY_PATCH, { accountId, patch });
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

  insertPendingMutations(accountId, mutations) {
    return this.call(DB_RPC.PENDING_MUTATION_INSERT_MANY, { accountId, mutations });
  }

  listPendingMutations(accountId, limit = 50) {
    return this.call(DB_RPC.PENDING_MUTATION_LIST_PENDING, { accountId, limit });
  }

  /**
   * Read the error fields a failed mutation row left behind, so the
   * mail-store can format a user-facing message after a failed
   * runMutation / drainOutbox.
   */
  getPendingMutationError(mutationId) {
    return this.call(DB_RPC.PENDING_MUTATION_GET_ERROR, { mutationId });
  }

  retryPendingDraftMutation(accountId, mutationId) {
    return this.call(DB_RPC.PENDING_MUTATION_RETRY, { accountId, mutationId });
  }

  abandonPendingDraftMutation(accountId, mutationId, options = {}) {
    return this.call(DB_RPC.PENDING_MUTATION_ABANDON_DRAFT, {
      accountId,
      mutationId,
      ...options,
    });
  }

  async isEmailClaimedBySend(accountId, remoteId) {
    const rows = await this.call<any[]>(DB_RPC.QUERY, {
      sql: `SELECT local_status, phase, request_json, server_response_json
              FROM pending_mutations
             WHERE account_id = ?
               AND mutation_type = 'send'
               AND local_status IN ('pending','retry','in_flight','conflicted')
               AND (server_response_json IS NOT NULL OR request_json IS NOT NULL)`,
      params: [accountId],
    });
    return rows.some((row) => {
      try {
        const checkpoint = row.server_response_json
          ? JSON.parse(row.server_response_json)
          : null;
        if (checkpoint?.emailRemoteId === remoteId) return true;
        const request = row.request_json ? JSON.parse(row.request_json) : null;
        const cleanupIds = Array.isArray(request?.draftEmailIds)
          ? request.draftEmailIds
          : [];
        const cleanupCanStillRun = row.local_status !== 'conflicted'
          || row.phase === 'submitted'
          || row.phase === 'cache_pending';
        return cleanupCanStillRun && cleanupIds.includes(remoteId);
      } catch {
        return false;
      }
    });
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

  updateSyncAccountAuth(accountId, { token, issuedAt, expiresAt }) {
    return this.call(DB_RPC.SYNC_UPDATE_ACCOUNT_AUTH, {
      accountId,
      token,
      issuedAt,
      expiresAt,
    });
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

  /**
   * Fetch storage quota from JMAP (if supported), persist locally, and
   * return the snapshot. Null limits mean unlimited / not configured.
   */
  getStorageQuota(accountId) {
    return this.call(DB_RPC.SYNC_GET_STORAGE_QUOTA, { accountId });
  }

  ensureAddressbooks(accountId) {
    return this.call(DB_RPC.SYNC_ENSURE_ADDRESSBOOKS, { accountId });
  }

  inventoryAddressbook(
    accountId: number,
    addressbookId: number,
  ): Promise<AddressBookInventory> {
    return this.call<AddressBookInventory>(
      DB_RPC.SYNC_INVENTORY_ADDRESSBOOK,
      { accountId, addressbookId },
    );
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

  getAttachmentLimits(accountId: number): Promise<AttachmentLimits> {
    return this.call<AttachmentLimits>(DB_RPC.SYNC_GET_ATTACHMENT_LIMITS, {
      accountId,
    });
  }

  uploadComposeAttachment(
    accountId: number,
    blob: Blob,
    {
      type = blob.type || 'application/octet-stream',
      totalAttachmentBytes = blob.size,
      signal,
      onProgress,
    }: {
      type?: string;
      totalAttachmentBytes?: number;
    } & TransferCallOptions = {},
  ): Promise<JmapUploadMetadata> {
    return this._call<JmapUploadMetadata>(
      DB_RPC.SYNC_UPLOAD_COMPOSE_ATTACHMENT,
      { accountId, blob, type, totalAttachmentBytes },
      { signal, onProgress },
    );
  }

  downloadAttachment(
    accountId: number,
    {
      blobId,
      type = 'application/octet-stream',
      name = 'attachment',
      maxBytes,
      truncateAtMaxBytes = false,
      signal,
      onProgress,
    }: {
      blobId: string;
      type?: string | null;
      name?: string | null;
      maxBytes?: number;
      truncateAtMaxBytes?: boolean;
    } & TransferCallOptions,
  ): Promise<Blob> {
    return this._call<Blob>(
      DB_RPC.SYNC_DOWNLOAD_ATTACHMENT,
      {
        accountId,
        blobId,
        type,
        name,
        maxBytes,
        truncateAtMaxBytes,
      },
      { signal, onProgress },
    );
  }

  /**
   * Download a blob (e.g. an inline cid: image part) through the worker,
   * which has the authenticated transport. Returns { base64, type } or
   * null. Used by the message viewer to resolve inline images.
   */
  downloadBlob(accountId, { blobId, type = null, name = null }) {
    return this.call(DB_RPC.SYNC_DOWNLOAD_BLOB, {
      accountId, blobId, type, name,
    });
  }

  // Internals ----------------------------------------------------------

  _onMessage(msg) {
    const data = msg.data;
    if (!data) {
      return;
    }
    if (data.type === RPC_PROGRESS) {
      const pending = this._pending.get(data.id);
      if (!pending?.onProgress) return;
      try {
        pending.onProgress(data.progress);
      } catch (error) {
        console.error('Repository progress listener threw', error);
      }
      return;
    }
    if (data.type !== RPC_RESPONSE) return;
    const pending = this._pending.get(data.id);
    if (!pending) {
      return;
    }
    this._pending.delete(data.id);
    pending.removeAbort?.();
    if (data.error) {
      pending.reject(deserializeRpcError(data.error));
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

function cancelledRpcError() {
  const error: any = new Error('RPC request was cancelled');
  error.name = 'AbortError';
  error.type = 'cancelled';
  return error;
}

function deserializeRpcError(serialized: any) {
  if (typeof serialized === 'string') return new Error(serialized);
  const error: any = new Error(serialized?.message ?? 'Worker RPC failed');
  error.name = serialized?.name ?? 'Error';
  for (const [key, value] of Object.entries(serialized ?? {})) {
    if (key !== 'name' && key !== 'message') error[key] = value;
  }
  return error;
}
