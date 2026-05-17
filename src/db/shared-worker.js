/**
 * SharedWorker entry point. One instance per origin; every browser tab on
 * the same Stormbox install connects via a MessagePort. The worker holds
 * the only wa-sqlite connection and (later) the only JMAP WebSocket.
 *
 * Build target: this file is loaded as the SharedWorker entry. Vite's
 * worker bundling configuration (vite.config.js > worker.format = 'es')
 * keeps the ES module imports intact.
 */

import { bootProductionEngine } from './bootstrap-opfs.js';
import { makeHandlers } from './handlers.js';
import {
  dispatchRpc,
  makeBroadcaster,
  RPC_REQUEST,
  RPC_RESPONSE,
} from './rpc-dispatch.js';
import { BROADCAST_CHANNEL } from './protocol.js';
import { attachWorkerLogger, wlog } from './worker-log.js';
import { makeSyncRpcHandlers } from '../sync/sync-host.js';

const channel = new BroadcastChannel(BROADCAST_CHANNEL);
const broadcaster = makeBroadcaster(channel);
attachWorkerLogger(channel);

self.addEventListener('error', (event) => {
  wlog.error('shared-worker', 'uncaught error', event.message ?? event.error);
});
self.addEventListener('unhandledrejection', (event) => {
  wlog.error('shared-worker', 'unhandled rejection', event.reason);
});

let handlersPromise = null;

function getHandlers() {
  if (handlersPromise) {
    return handlersPromise;
  }
  handlersPromise = (async () => {
    wlog.info('shared-worker', 'booting OPFS engine');
    const engine = await bootProductionEngine();
    wlog.info('shared-worker', 'engine ready');
    const repoHandlers = makeHandlers(engine, broadcaster);
    const syncHandlers = makeSyncRpcHandlers({ handlers: repoHandlers });
    return { ...repoHandlers, ...syncHandlers };
  })();
  return handlersPromise;
}

/**
 * RPC dispatch. SQL serialisation lives inside Engine itself (it owns
 * the per-handle promise tail); this dispatcher just routes messages.
 * That allows non-RPC SQL paths (e.g. background sync writes started by
 * one RPC and continuing after it returned) to share the same lock.
 */
self.addEventListener('connect', (event) => {
  const port = event.ports[0];
  port.start();
  port.addEventListener('message', async (msg) => {
    const message = msg.data;
    if (!message || message.type !== RPC_REQUEST) {
      return;
    }
    let response;
    try {
      const handlers = await getHandlers();
      response = await dispatchRpc(message, handlers);
    } catch (error) {
      response = {
        type: RPC_RESPONSE,
        id: message.id,
        error: `Database failed to initialise: ${error?.message ?? error}`,
      };
    }
    port.postMessage(response);
  });
});
