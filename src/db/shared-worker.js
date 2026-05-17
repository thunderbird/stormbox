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
 * SQL operations on the wa-sqlite engine are not safe to run
 * concurrently on the same db handle - statements interleave at the
 * step level and deadlock. We serialise every inbound RPC through a
 * single tail-of-promise queue. This matches the pattern in
 * thunderbird/thunderbolt's wa-sqlite worker.
 */
let serial = Promise.resolve();
function enqueue(fn) {
  const next = serial.then(fn, fn);
  // Don't propagate failures into the chain; each task gets its own
  // tail. Catch silently here to keep the serial chain alive.
  serial = next.catch(() => {});
  return next;
}

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
      response = await enqueue(() => dispatchRpc(message, handlers));
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
