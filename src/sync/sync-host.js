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
 *
 * `outboxNotifier`, if supplied, is a mutable dispatch carrier shared
 * with `makeHandlers`. We install a real `dispatch(accountId, mutationId)`
 * on it once we know which backends exist; the handlers-side
 * `onMutationInserted` hook calls back through it after every
 * PENDING_MUTATION_INSERT, so the OutboxRunner gets woken without
 * callers having to remember to kick `drainOutbox`. Pre-start inserts
 * land on the no-op default and are picked up by the runner's startup
 * sweep instead.
 */
export function makeSyncRpcHandlers({
  handlers, fetch, WebSocketImpl, outboxNotifier,
} = {}) {
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

  if (outboxNotifier) {
    outboxNotifier.dispatch = (accountId, _mutationId) => {
      const backend = backends.get(accountId);
      backend?.outboxRunner?.notify();
    };
  }

  return {
    [DB_RPC.SYNC_START_ACCOUNT]: async (input) => {
      wlog.info('sync-host', `startAccount ${input.serverOrigin} (auth=${input.auth?.kind}, wsProxy=${input.wsProxyUrl ?? 'none'})`);
      const transport = new JmapTransport({
        sessionUrl: input.sessionUrl,
        getAuthHeader: makeAuthHeader(input.auth),
        getWsCredential: makeWsCredential(input.auth),
        wsProxyUrl: input.wsProxyUrl ?? null,
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

    [DB_RPC.SYNC_ENSURE_MESSAGE_BODIES]: async ({ accountId, messageIds }) =>
      syncClient.ensureMessageBodies(accountId, messageIds ?? []),

    [DB_RPC.SYNC_MESSAGE_BODY_FOR_DISPLAY]: async ({ accountId, messageId }) => {
      let body = await handlers[DB_RPC.MESSAGE_BODY_READ]({ messageId });
      if (body) {
        return body;
      }
      await syncClient.ensureMessageBodyForDisplay(accountId, messageId);
      body = await handlers[DB_RPC.MESSAGE_BODY_READ]({ messageId });
      return body;
    },

    [DB_RPC.SYNC_ENSURE_IDENTITIES]: async ({ accountId }) =>
      syncClient.ensureIdentities(accountId),

    [DB_RPC.SYNC_ENSURE_ADDRESSBOOKS]: async ({ accountId }) =>
      syncClient.ensureAddressbooks(accountId),

    [DB_RPC.SYNC_ENSURE_CONTACTS]: async ({ accountId, addressbookId }) =>
      syncClient.ensureContacts(accountId, addressbookId),

    [DB_RPC.SYNC_ENSURE_FOLDER_INDEX]: async ({ accountId, folderId, options }) =>
      syncClient.ensureFolderIndex(accountId, folderId, options ?? {}),

    [DB_RPC.SYNC_DRAIN_OUTBOX]: async ({ accountId, limit = 25 }) => {
      const backend = backends.get(accountId);
      if (!backend) {
        return { attempted: 0, succeeded: 0, failed: 0 };
      }
      return backend.drainOutbox(limit);
    },

    [DB_RPC.SYNC_RUN_MUTATION]: async ({ accountId, mutationId }) => {
      const backend = backends.get(accountId);
      if (!backend) {
        return { attempted: 0, succeeded: 0, failed: 0 };
      }
      return backend.runMutation(mutationId);
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

/**
 * Producer for the credential placed on the WebSocket URL when a
 * ws-proxy is in front of Stalwart. The proxy turns this into a
 * proper Authorization header on the upstream upgrade request.
 */
function makeWsCredential(auth) {
  if (auth?.kind === 'bearer') {
    return async () => ({ kind: 'bearer', token: auth.token });
  }
  if (auth?.kind === 'basic') {
    const encoded = base64Utf8(`${auth.username}:${auth.password}`);
    return async () => ({ kind: 'basic', token: encoded });
  }
  return async () => null;
}

function base64Utf8(input) {
  if (typeof btoa === 'function') {
    return btoa(unescape(encodeURIComponent(input)));
  }
  return Buffer.from(input, 'utf8').toString('base64');
}
