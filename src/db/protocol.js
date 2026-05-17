/**
 * RPC contract between Pinia stores (main thread) and the database
 * SharedWorker. The main thread imports DB_RPC and the BroadcastChannel
 * name; the worker imports the same constants when wiring its handlers.
 *
 * Methods are namespaced by table family. Cross-tab invalidations after a
 * write are published on the broadcast channel as { tables: string[] }.
 */

export const BROADCAST_CHANNEL = 'stormbox.tables-touched';

export const DB_RPC = Object.freeze({
  HEALTHCHECK: 'db.healthcheck',
  EXEC: 'db.exec',
  QUERY: 'db.query',
  TRANSACTION: 'db.transaction',

  ACCOUNT_LIST: 'account.list',
  ACCOUNT_UPSERT: 'account.upsert',
  ACCOUNT_GET_BY_REMOTE: 'account.getByRemote',
  ACCOUNT_SERVICE_UPSERT: 'accountService.upsert',
  ACCOUNT_CAPABILITIES_REPLACE: 'accountCapabilities.replace',

  FOLDER_LIST: 'folder.list',
  FOLDER_UPSERT_MANY: 'folder.upsertMany',
  FOLDER_BY_ROLE: 'folder.byRole',

  IDENTITY_LIST: 'identity.list',
  IDENTITY_UPSERT_MANY: 'identity.upsertMany',

  THREAD_UPSERT_MANY: 'thread.upsertMany',

  MESSAGE_UPSERT_MANY: 'message.upsertMany',
  MESSAGE_LIST_FOR_FOLDER: 'message.listForFolder',
  MESSAGE_GET_BY_REMOTE: 'message.getByRemote',
  MESSAGE_LIST_FOR_THREAD: 'message.listForThread',
  MESSAGE_FIND_BY_RFC822_MESSAGE_ID: 'message.findByRfc822MessageId',
  MESSAGE_REPLACE_KEYWORDS: 'message.replaceKeywords',

  FOLDER_MEMBERSHIP_REPLACE: 'folderMembership.replace',

  ADDRESSBOOK_LIST: 'addressbook.list',
  ADDRESSBOOK_UPSERT_MANY: 'addressbook.upsertMany',
  CONTACT_UPSERT_MANY: 'contact.upsertMany',
  CONTACT_AUTOCOMPLETE: 'contact.autocomplete',

  SYNC_STATE_GET: 'syncState.get',
  SYNC_STATE_SET: 'syncState.set',
  PENDING_MUTATION_INSERT: 'pendingMutation.insert',
  PENDING_MUTATION_LIST_PENDING: 'pendingMutation.listPending',
  SYNC_JOB_INSERT: 'syncJob.insert',
  SYNC_JOB_NEXT_BATCH: 'syncJob.nextBatch',
});

/**
 * Logical "table families" published on the broadcast channel after a
 * write. Stores subscribe to the families they care about and re-run their
 * queries when a relevant family fires.
 */
export const TABLE_FAMILIES = Object.freeze({
  ACCOUNTS: 'accounts',
  FOLDERS: 'folders',
  MESSAGES: 'messages',
  THREADS: 'threads',
  IDENTITIES: 'identities',
  CONTACTS: 'contacts',
  SYNC: 'sync',
  MUTATIONS: 'mutations',
});
