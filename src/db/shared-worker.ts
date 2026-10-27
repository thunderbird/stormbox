/**
 * SharedWorker entry point. One instance per origin; every browser tab on
 * the same Stormbox install connects via a MessagePort. The worker holds
 * the only wa-sqlite connection and (later) the only JMAP WebSocket.
 *
 * Build target: this file is loaded as the SharedWorker entry. Vite's
 * worker bundling configuration (vite.config.js > worker.format = 'es')
 * keeps the ES module imports intact.
 */

import { bootProductionEngine } from './bootstrap-idb';
import { makeHandlers } from './handlers';
import {
  makeBroadcaster,
  serveRpcPort,
  WORKER_RESTARTED,
} from './rpc-dispatch';
import { BROADCAST_CHANNEL } from './protocol';
import { attachWorkerLogger, wlog } from './worker-log';
import { createWorkerLifecycle } from './worker-lifecycle';
import { claimDatabaseOwnership, needsFirefoxLockWorkaround } from './worker-ownership';
import { makeSyncRpcHandlers } from '../sync/sync-host';

const channel = new BroadcastChannel(BROADCAST_CHANNEL);
const broadcaster = makeBroadcaster(channel);
attachWorkerLogger(channel);

let handlersPromise = null;
let ownership: ReturnType<typeof claimDatabaseOwnership> | undefined;
let replacementWorkerUrl: string | undefined;
const lifecycle = createWorkerLifecycle({
  beforeRestart: () => ownership?.stop(),
  ready: async () => { await handlersPromise; },
  restart: () => {
    try {
      channel.postMessage({ type: WORKER_RESTARTED, workerUrl: self.location.href, replacementWorkerUrl });
    } finally {
      self.close();
    }
  },
});

self.addEventListener('error', (event) => {
  wlog.error('shared-worker', 'uncaught error', event.message ?? event.error);
});
self.addEventListener('unhandledrejection', (event) => {
  wlog.error('shared-worker', 'unhandled rejection', event.reason);
});

function getHandlers() {
  if (handlersPromise) {
    return handlersPromise;
  }
  handlersPromise = (async () => {
    if (needsFirefoxLockWorkaround()) {
      ownership = claimDatabaseOwnership({
        channel,
        superseded: (url) => {
          replacementWorkerUrl = url;
          void lifecycle.requestRestart();
        },
      });
      await ownership.ready;
    }
    wlog.info('shared-worker', 'booting OPFS engine');
    const engine = await bootProductionEngine();
    wlog.info('shared-worker', 'engine ready');
    // Shared dispatch carrier: makeSyncRpcHandlers installs a real
    // dispatch function once it has the backends map; until then
    // (and for any account that never started a backend) the no-op
    // default just drops the notification. The outbox runner's
    // startup sweep + state-change notify path catches those rows
    // on the next backend.start, so dropping a pre-start notify is
    // safe.
    const outboxNotifier: { dispatch: (accountId?: number, mutationId?: number) => void } = { dispatch: () => {} };
    const repoHandlers = lifecycle.storageHandlers(makeHandlers(engine, broadcaster, {
      onMutationInserted: ({ accountId, mutationId }) =>
        outboxNotifier.dispatch(accountId, mutationId),
    }));
    let stopSync: () => Promise<void> = async () => {};
    const syncHandlers = makeSyncRpcHandlers({
      handlers: repoHandlers,
      outboxNotifier,
      registerShutdown: (stop) => { stopSync = stop; },
    });
    return lifecycle.requestHandlers({ ...repoHandlers, ...syncHandlers }, {
      stopSync: () => stopSync(),
      closeStorage: () => engine.close(),
    });
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
  serveRpcPort(port, getHandlers);
});
