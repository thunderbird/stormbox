/**
 * Protocol-neutral sync client. Pinia stores ask SyncClient to make sure
 * a piece of local data is fresh; SyncClient routes the request to the
 * registered backend for that account/service-kind. Backends own the
 * transport and the SQL writes.
 *
 * Registering a backend:
 *   syncClient.registerBackend(accountId, SERVICE_KIND.JMAP_MAIL, jmapBackend);
 *
 * Backends must implement the methods on Backend (below). Today only the
 * JMAP backend is wired; CardDAV and IMAP slot in by registering against
 * the same interface and a different service_kind.
 */

import { SERVICE_KIND } from '../constants/states.js';

/**
 * Backend interface (duck-typed). Method names align with the spec's
 * "Sync strategy" section. Returning a promise is required.
 *
 * @typedef {object} Backend
 * @property {() => Promise<void>} start
 *   Open the transport (e.g. JMAP WebSocket), enable push, kick off any
 *   eager sync the backend wants on connect.
 * @property {() => Promise<void>} stop
 * @property {() => Promise<void>} ensureFolderTree
 * @property {(folderId: number, range: { offset?: number, limit?: number }) => Promise<void>} ensureFolderWindow
 * @property {(messageId: number) => Promise<void>} ensureMessageBody
 * @property {() => Promise<void>} ensureIdentities
 * @property {() => Promise<void>} ensureAddressbooks
 * @property {(addressbookId: number) => Promise<void>} ensureContacts
 * @property {(mutationId: number) => Promise<void>} runMutation
 */

export class SyncClient {
  constructor() {
    /** @type {Map<number, Map<string, Backend>>} */
    this._backends = new Map();
  }

  registerBackend(accountId, serviceKind, backend) {
    let perAccount = this._backends.get(accountId);
    if (!perAccount) {
      perAccount = new Map();
      this._backends.set(accountId, perAccount);
    }
    perAccount.set(serviceKind, backend);
  }

  unregisterAccount(accountId) {
    this._backends.delete(accountId);
  }

  getBackend(accountId, serviceKind) {
    const backend = this._backends.get(accountId)?.get(serviceKind);
    if (!backend) {
      throw new Error(`No ${serviceKind} backend registered for account ${accountId}`);
    }
    return backend;
  }

  async startAll() {
    await Promise.all(this._eachBackend((b) => b.start()));
  }

  async stopAll() {
    await Promise.all(this._eachBackend((b) => b.stop()));
  }

  ensureFolderTree(accountId) {
    return this.getBackend(accountId, SERVICE_KIND.JMAP_MAIL).ensureFolderTree();
  }

  ensureFolderWindow(accountId, folderId, range = {}) {
    return this.getBackend(accountId, SERVICE_KIND.JMAP_MAIL).ensureFolderWindow(folderId, range);
  }

  ensureMessageBody(accountId, messageId) {
    return this.getBackend(accountId, SERVICE_KIND.JMAP_MAIL).ensureMessageBody(messageId);
  }

  ensureIdentities(accountId) {
    return this.getBackend(accountId, SERVICE_KIND.JMAP_MAIL).ensureIdentities();
  }

  ensureAddressbooks(accountId) {
    return this.getBackend(accountId, SERVICE_KIND.JMAP_CONTACTS).ensureAddressbooks();
  }

  ensureContacts(accountId, addressbookId) {
    return this.getBackend(accountId, SERVICE_KIND.JMAP_CONTACTS).ensureContacts(addressbookId);
  }

  runMutation(accountId, serviceKind, mutationId) {
    return this.getBackend(accountId, serviceKind).runMutation(mutationId);
  }

  _eachBackend(fn) {
    const out = [];
    for (const perAccount of this._backends.values()) {
      for (const backend of perAccount.values()) {
        out.push(fn(backend));
      }
    }
    return out;
  }
}
