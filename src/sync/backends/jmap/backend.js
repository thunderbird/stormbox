/**
 * JmapBackend ties the JMAP transport, the SQLite handlers, and every
 * per-method sync function into a single object that satisfies the
 * SyncClient backend contract. One instance per (account, transport).
 *
 * Lifecycle:
 *   start():
 *     - Fetch session (if not already cached on the transport)
 *     - Ingest into accounts / account_services / account_capabilities
 *     - Run a bootstrap sync for mailboxes + identities + addressbooks
 *       (when contacts service is present) using HTTP
 *     - Open the WebSocket; once open, all subsequent JMAP calls go
 *       over WS for lower per-request overhead
 *     - Subscribe to StateChange notifications and route them to the
 *       relevant /changes handler per JMAP type
 *
 *   stop():
 *     - Close the WebSocket and detach the StateChange listener
 *
 * Per-need helpers (called by the SyncClient facade):
 *   ensureFolderTree     ensureFolderWindow     ensureMessageBody
 *   ensureIdentities     ensureAddressbooks     ensureContacts
 *   runMutation
 */

import { DB_RPC } from '../../../db/protocol.js';
import { JMAP_TYPE, SERVICE_KIND, KEYWORD } from '../../../constants/states.js';
import { wlog } from '../../../db/worker-log.js';
import { ingestSession } from './session.js';
import { syncMailboxes, syncMailboxChanges } from './mailboxes.js';
import {
  syncFolderWindow,
  syncFolderWindowChanges,
  syncEmailChanges,
} from './messages.js';
import { fetchEmailBodies } from './bodies.js';
import { syncIdentities } from './identities.js';
import {
  syncAddressBooks,
  syncContacts,
  syncContactCardChanges,
} from './contacts.js';
import { drainOutbox } from './outbox.js';

const SUBSCRIBED_TYPES = [
  JMAP_TYPE.MAILBOX,
  JMAP_TYPE.EMAIL,
  JMAP_TYPE.THREAD,
  JMAP_TYPE.IDENTITY,
  JMAP_TYPE.EMAIL_DELIVERY,
  JMAP_TYPE.ADDRESSBOOK,
  JMAP_TYPE.CONTACT_CARD,
];

export class JmapBackend {
  /**
   * @param {object} args
   * @param {import('./transport.js').JmapTransport} args.transport
   * @param {string} args.serverOrigin
   * @param {Record<string, (params: any) => Promise<any>>} args.handlers
   * @param {{ useWebSocket?: boolean }} [args.options]
   */
  constructor({ transport, serverOrigin, handlers, options = {} }) {
    this.transport = transport;
    this.serverOrigin = serverOrigin;
    this.handlers = handlers;
    this.useWebSocket = options.useWebSocket ?? true;
    this.account = null;
    this.services = [];
    this._unsubStateChange = null;
    this._started = false;
  }

  /**
   * start() returns as soon as the local account row + the folder tree
   * are populated. Identities, contacts, and the WebSocket are kicked
   * off in the background after start() resolves so the UI can paint a
   * folder list within a single round trip of "login complete".
   */
  async start() {
    if (this._started) {
      return;
    }
    wlog.info('jmap-backend', 'fetchSession');
    const session = await this.transport.fetchSession();
    wlog.info('jmap-backend', `session ok, primaryMail=${session.primaryAccounts?.['urn:ietf:params:jmap:mail']}, caps=${Object.keys(session.capabilities ?? {}).length}`);
    const ingest = await ingestSession({
      session,
      serverOrigin: this.serverOrigin,
      handlers: this.handlers,
    });
    this.account = ingest.account;
    this.services = ingest.services;
    wlog.info('jmap-backend', `account ingested id=${this.account.id} remote=${this.account.remote_account_id} services=${this.services.map((s) => s.serviceKind).join(',')}`);

    const mbResult = await syncMailboxes({
      transport: this.transport,
      account: this.account,
      handlers: this.handlers,
    });
    wlog.info('jmap-backend', `syncMailboxes -> ${mbResult.count} folders, state=${mbResult.state}`);

    this._started = true;

    // Fire-and-forget background bootstrap: identities, contacts, then
    // open the WebSocket. The UI is already painting from the folder
    // table at this point; nothing here blocks the user. Tests can
    // await bootstrapped() to know when this chain is done.
    this._bootstrappedPromise = this._continueBootstrap().catch((err) => {
      wlog.error('jmap-backend', 'background bootstrap failed', err);
    });
  }

  /**
   * Promise that resolves once the background bootstrap chain
   * (identities, contacts, WebSocket open) finishes. Useful in tests
   * and for any caller that wants to wait for the post-folders sync.
   */
  bootstrapped() {
    return this._bootstrappedPromise ?? Promise.resolve();
  }

  async _continueBootstrap() {
    const idResult = await syncIdentities({
      transport: this.transport,
      account: this.account,
      handlers: this.handlers,
    });
    wlog.info('jmap-backend', `syncIdentities -> ${idResult.count} identities`);

    if (this._hasContactsService()) {
      const abResult = await syncAddressBooks({
        transport: this.transport,
        account: this.account,
        handlers: this.handlers,
      });
      wlog.info('jmap-backend', `syncAddressBooks -> ${abResult.count}`);
      const cResult = await syncContacts({
        transport: this.transport,
        account: this.account,
        handlers: this.handlers,
      });
      wlog.info('jmap-backend', `syncContacts -> ${cResult.fetched} fetched of ${cResult.total}`);
    }

    if (this.useWebSocket) {
      const pushState = await this._loadPushState();
      try {
        await this.transport.openWebSocket(SUBSCRIBED_TYPES, pushState);
        wlog.info('jmap-backend', 'WebSocket open, push enabled');
      } catch (err) {
        wlog.warn('jmap-backend', 'WebSocket unavailable; staying on HTTP', err);
      }
    }
    this._unsubStateChange = this.transport.onStateChange(
      (change) => this._onStateChange(change).catch((err) => {
        wlog.error('jmap-backend', 'StateChange dispatch failed', err);
      }),
    );
  }

  async stop() {
    if (!this._started) return;
    this._unsubStateChange?.();
    this._unsubStateChange = null;
    this.transport.closeWebSocket();
    this._started = false;
  }

  // ----- SyncClient.Backend surface -----------------------------------

  async ensureFolderTree() {
    return syncMailboxes({
      transport: this.transport,
      account: this.account,
      handlers: this.handlers,
      useWebSocket: this._wsReady(),
    });
  }

  async ensureFolderWindow(folderId, range = {}) {
    wlog.info('jmap-backend', `ensureFolderWindow folderId=${folderId} offset=${range.offset ?? 0} limit=${range.limit ?? 100}`);
    const folder = await this._loadFolder(folderId);
    const r = await syncFolderWindow({
      transport: this.transport,
      account: this.account,
      folder,
      handlers: this.handlers,
      sortProp: range.sortProp ?? this._defaultSortPropFor(folder),
      position: range.offset ?? 0,
      limit: range.limit ?? 100,
      collapseThreads: range.collapseThreads ?? false,
      useWebSocket: this._wsReady(),
    });
    wlog.info('jmap-backend', `ensureFolderWindow done offset=${range.offset} fetched=${r?.fetched} total=${r?.total}`);
    return r;
  }

  async ensureMessageBody(messageId) {
    const row = await this.handlers[DB_RPC.QUERY]({
      sql: 'SELECT remote_id FROM messages WHERE id = ?',
      params: [messageId],
    });
    const remoteId = row[0]?.remote_id;
    if (!remoteId) {
      throw new Error(`Unknown message ${messageId}`);
    }
    return fetchEmailBodies({
      transport: this.transport,
      account: this.account,
      handlers: this.handlers,
      remoteIds: [remoteId],
      useWebSocket: this._wsReady(),
    });
  }

  async ensureIdentities() {
    return syncIdentities({
      transport: this.transport,
      account: this.account,
      handlers: this.handlers,
      useWebSocket: this._wsReady(),
    });
  }

  async ensureAddressbooks() {
    if (!this._hasContactsService()) {
      return { count: 0, state: null };
    }
    return syncAddressBooks({
      transport: this.transport,
      account: this.account,
      handlers: this.handlers,
      useWebSocket: this._wsReady(),
    });
  }

  async ensureContacts(_addressbookId) {
    if (!this._hasContactsService()) {
      return { fetched: 0 };
    }
    // For MVP we sync the whole account at once. addressbookId is
    // accepted by the SyncClient interface but not used for filtering;
    // ContactCard/query without a filter returns the account-wide set.
    return syncContacts({
      transport: this.transport,
      account: this.account,
      handlers: this.handlers,
      useWebSocket: this._wsReady(),
    });
  }

  async drainOutbox(limit = 25) {
    return drainOutbox({
      transport: this.transport,
      account: this.account,
      handlers: this.handlers,
      limit,
      useWebSocket: this._wsReady(),
    });
  }

  async runMutation(_mutationId) {
    // Per-row mutation runs are not wired today; the SharedWorker
    // calls drainOutbox(limit) which iterates the queue. Keep this
    // for future per-mutation retry hooks.
    return this.drainOutbox(1);
  }

  // ----- StateChange dispatch -----------------------------------------

  async _onStateChange({ changed, pushState }) {
    if (!this.account) return;
    if (pushState) {
      await this._persistPushState(pushState);
    }
    const types = changed?.[this.account.remote_account_id];
    if (!types) return;

    for (const [type, _state] of Object.entries(types)) {
      switch (type) {
        case JMAP_TYPE.MAILBOX: {
          const sync = await this._loadSyncState('Mailbox');
          if (!sync?.state) {
            await this.ensureFolderTree();
            break;
          }
          const result = await syncMailboxChanges({
            transport: this.transport,
            account: this.account,
            handlers: this.handlers,
            sinceState: sync.state,
            useWebSocket: this._wsReady(),
          });
          if (result.needsFullSync) {
            await this.ensureFolderTree();
          }
          break;
        }
        case JMAP_TYPE.EMAIL:
        case JMAP_TYPE.EMAIL_DELIVERY: {
          const sync = await this._loadSyncState('Email');
          if (!sync?.state) {
            // Without a baseline state we cannot run /changes; the next
            // visible window sync will populate one.
            break;
          }
          const result = await syncEmailChanges({
            transport: this.transport,
            account: this.account,
            handlers: this.handlers,
            sinceState: sync.state,
            useWebSocket: this._wsReady(),
          });
          if (result.needsFullSync) {
            // Fall back to refreshing the visible folder windows; their
            // queryChanges will reseed the per-account Email state.
            await this._refreshActiveQueryViews();
          }
          break;
        }
        case JMAP_TYPE.IDENTITY: {
          await this.ensureIdentities();
          break;
        }
        case JMAP_TYPE.ADDRESSBOOK: {
          await this.ensureAddressbooks();
          break;
        }
        case JMAP_TYPE.CONTACT_CARD: {
          const sync = await this._loadSyncState('ContactCard');
          if (!sync?.state) {
            await this.ensureContacts();
            break;
          }
          const result = await syncContactCardChanges({
            transport: this.transport,
            account: this.account,
            handlers: this.handlers,
            sinceState: sync.state,
            useWebSocket: this._wsReady(),
          });
          if (result.needsFullSync) {
            await this.ensureContacts();
          }
          break;
        }
        default:
          // Unknown JMAP type: ignore. We only care about the types we
          // explicitly subscribed to via WebSocketPushEnable.
          break;
      }
    }
  }

  async _refreshActiveQueryViews() {
    const views = await this.handlers[DB_RPC.QUERY]({
      sql: `SELECT * FROM query_views
             WHERE account_id = ? AND view_type = 'mailbox-window'
             ORDER BY last_accessed_at DESC LIMIT 5`,
      params: [this.account.id],
    });
    for (const view of views) {
      const folder = await this._loadFolder(view.folder_id);
      if (!folder) continue;
      const sortJson = JSON.parse(view.sort_json);
      const sortProp = sortJson?.[0]?.property ?? 'receivedAt';
      const result = await syncFolderWindowChanges({
        transport: this.transport,
        account: this.account,
        folder,
        handlers: this.handlers,
        sinceQueryState: view.query_state,
        sortProp,
        collapseThreads: !!view.collapse_threads,
        useWebSocket: this._wsReady(),
      });
      if (result.needsFullSync) {
        await syncFolderWindow({
          transport: this.transport,
          account: this.account,
          folder,
          handlers: this.handlers,
          sortProp,
          collapseThreads: !!view.collapse_threads,
          useWebSocket: this._wsReady(),
        });
      }
    }
  }

  // ----- helpers ------------------------------------------------------

  _hasContactsService() {
    return this.services.some((s) => s.serviceKind === SERVICE_KIND.JMAP_CONTACTS);
  }

  _wsReady() {
    return this.useWebSocket && !!this.transport._ws && this.transport._ws.readyState === 1;
  }

  _defaultSortPropFor(folder) {
    if (folder?.role === 'sent' || folder?.role === 'drafts') {
      return 'sentAt';
    }
    return 'receivedAt';
  }

  async _loadFolder(folderId) {
    const rows = await this.handlers[DB_RPC.QUERY]({
      sql: 'SELECT * FROM folders WHERE id = ?',
      params: [folderId],
    });
    if (rows.length === 0) {
      throw new Error(`Folder ${folderId} not found`);
    }
    return rows[0];
  }

  async _loadSyncState(objectType, scope = '') {
    return this.handlers[DB_RPC.SYNC_STATE_GET]({
      accountId: this.account.id,
      objectType,
      scope,
    });
  }

  async _loadPushState() {
    const rows = await this.handlers[DB_RPC.QUERY]({
      sql: `SELECT push_state FROM account_services
              WHERE account_id = ? AND service_kind = ?`,
      params: [this.account.id, SERVICE_KIND.JMAP_MAIL],
    });
    return rows[0]?.push_state ?? null;
  }

  async _persistPushState(pushState) {
    if (!this.account) return;
    await this.handlers[DB_RPC.QUERY]({
      sql: `UPDATE account_services
              SET push_state = ?, updated_at = ?
            WHERE account_id = ? AND service_kind = ?`,
      params: [pushState, Date.now(), this.account.id, SERVICE_KIND.JMAP_MAIL],
    });
  }
}
