/**
 * In-worker glue between the SyncClient interface and the SharedWorker
 * RPC dispatcher. Builds and holds the per-(account, transport) backends,
 * exposes the SYNC_* RPC methods, and forwards them to the SyncClient
 * facade.
 *
 * The SharedWorker entry calls makeSyncRpcHandlers() once and merges the
 * returned map into the repository handler map. From then on the main
 * thread can call repository.startSyncAccount(...), the message reaches
 * the worker, and a JmapBackend gets started.
 */

import { DB_RPC } from '../db/protocol.js';
import { SERVICE_KIND } from '../constants/states.js';
import { wlog } from '../db/worker-log.js';
import { SyncClient } from './sync-client.js';
import { JmapTransport } from './backends/jmap/transport.js';
import { JmapBackend } from './backends/jmap/backend.js';

/**
 * @typedef {object} StartAccountInput
 * @property {string} sessionUrl    Absolute URL of the JMAP session document
 *                                  (e.g. https://mail.example.com/.well-known/jmap).
 * @property {string} serverOrigin  Origin of the JMAP server.
 * @property {{ kind: 'basic', username: string, password: string }
 *           | { kind: 'bearer', token: string }} auth
 *                                  Auth handed to the transport's getAuthHeader.
 *                                  bearer tokens are the OIDC happy path; basic
 *                                  tokens cover self-host setups.
 * @property {boolean} [useWebSocket=true]
 */

/**
 * Build the RPC handler map. Caller (SharedWorker) merges this into the
 * full handler map keyed by DB_RPC method names.
 */
export function makeSyncRpcHandlers({ handlers, fetch, WebSocketImpl } = {}) {
  if (!handlers) {
    throw new Error('makeSyncRpcHandlers requires the repository handler map');
  }
  // Firefox enforces that fetch and WebSocket be invoked with their
  // global as the receiver. An unbound reference like `const f =
  // globalThis.fetch; f(url)` throws "called on an object that does
  // not implement interface WorkerGlobalScope" inside a SharedWorker.
  // Bind explicitly so JmapTransport (and any test fake) can call
  // them without caring.
  const boundFetch = fetch ?? globalThis.fetch.bind(globalThis);
  const wsCtor = WebSocketImpl ?? globalThis.WebSocket;
  const syncClient = new SyncClient();
  /** @type {Map<number, JmapBackend>} */
  const backends = new Map();

  return {
    [DB_RPC.SYNC_START_ACCOUNT]: async (input) => {
      wlog.info('sync-host', `startAccount ${input.serverOrigin} (auth=${input.auth?.kind})`);
      const transport = new JmapTransport({
        sessionUrl: input.sessionUrl,
        getAuthHeader: makeAuthHeader(input.auth),
        fetch: boundFetch,
        WebSocketImpl: wsCtor,
      });
      const backend = new JmapBackend({
        transport,
        serverOrigin: input.serverOrigin,
        handlers,
        options: { useWebSocket: input.useWebSocket ?? true },
      });
      try {
        await backend.start();
      } catch (err) {
        wlog.error('sync-host', 'backend.start() threw', err);
        throw err;
      }
      backends.set(backend.account.id, backend);
      syncClient.registerBackend(backend.account.id, SERVICE_KIND.JMAP_MAIL, backend);
      if (backend.services.some((s) => s.serviceKind === SERVICE_KIND.JMAP_CONTACTS)) {
        syncClient.registerBackend(backend.account.id, SERVICE_KIND.JMAP_CONTACTS, backend);
      }
      wlog.info('sync-host', `startAccount complete; accountId=${backend.account.id}, services=${backend.services.map((s) => s.serviceKind).join(',')}`);
      return { accountId: backend.account.id };
    },

    [DB_RPC.SYNC_STOP_ACCOUNT]: async ({ accountId }) => {
      const backend = backends.get(accountId);
      if (!backend) return;
      await backend.stop();
      backends.delete(accountId);
      syncClient.unregisterAccount(accountId);
    },

    [DB_RPC.SYNC_ENSURE_FOLDER_TREE]: async ({ accountId }) =>
      syncClient.ensureFolderTree(accountId),

    [DB_RPC.SYNC_ENSURE_FOLDER_WINDOW]: async ({ accountId, folderId, range }) =>
      syncClient.ensureFolderWindow(accountId, folderId, range ?? {}),

    [DB_RPC.SYNC_ENSURE_MESSAGE_BODY]: async ({ accountId, messageId }) =>
      syncClient.ensureMessageBody(accountId, messageId),

    [DB_RPC.SYNC_ENSURE_IDENTITIES]: async ({ accountId }) =>
      syncClient.ensureIdentities(accountId),

    [DB_RPC.SYNC_ENSURE_ADDRESSBOOKS]: async ({ accountId }) =>
      syncClient.ensureAddressbooks(accountId),

    [DB_RPC.SYNC_ENSURE_CONTACTS]: async ({ accountId, addressbookId }) =>
      syncClient.ensureContacts(accountId, addressbookId),

    [DB_RPC.SYNC_DRAIN_OUTBOX]: async ({ accountId, limit = 25 }) => {
      const backend = backends.get(accountId);
      if (!backend) {
        return { attempted: 0, succeeded: 0, failed: 0 };
      }
      return backend.drainOutbox(limit);
    },
  };
}

function makeAuthHeader(auth) {
  if (auth?.kind === 'bearer') {
    return async () => `Bearer ${auth.token}`;
  }
  if (auth?.kind === 'basic') {
    const encoded = base64Utf8(`${auth.username}:${auth.password}`);
    return async () => `Basic ${encoded}`;
  }
  throw new Error(`Unsupported auth kind: ${auth?.kind}`);
}

function base64Utf8(input) {
  if (typeof btoa === 'function') {
    return btoa(unescape(encodeURIComponent(input)));
  }
  return Buffer.from(input, 'utf8').toString('base64');
}
