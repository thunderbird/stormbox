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
import { makeSyncRpcHandlers } from '../sync/sync-host.js';

const channel = new BroadcastChannel(BROADCAST_CHANNEL);
const broadcaster = makeBroadcaster(channel);

let handlersPromise = null;

function getHandlers() {
  if (handlersPromise) {
    return handlersPromise;
  }
  handlersPromise = (async () => {
    const engine = await bootProductionEngine();
    const repoHandlers = makeHandlers(engine, broadcaster);
    const syncHandlers = makeSyncRpcHandlers({ handlers: repoHandlers });
    return { ...repoHandlers, ...syncHandlers };
  })();
  return handlersPromise;
}

self.addEventListener('connect', (event) => {
  const port = event.ports[0];
  port.start();
  port.addEventListener('message', async (msg) => {
    const message = msg.data;
    if (!message || message.type !== RPC_REQUEST) {
      return;
    }
    let handlers;
    try {
      handlers = await getHandlers();
    } catch (error) {
      port.postMessage({
        type: RPC_RESPONSE,
        id: message.id,
        error: `Database failed to initialise: ${error?.message ?? error}`,
      });
      return;
    }
    const response = await dispatchRpc(message, handlers);
    port.postMessage(response);
  });
});
