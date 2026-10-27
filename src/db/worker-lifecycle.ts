import { DB_RPC, type WorkerStatus } from './protocol';
import { wlog } from './worker-log';

type Handler = (...args: any[]) => any;
type Handlers = Record<string, Handler>;

/** Allow brief cleanup, then close even if work is still pending. */
export function createWorkerLifecycle({
  restart,
  instanceId = crypto.randomUUID(),
  now = () => performance.now(),
  beforeRestart = () => {},
  ready = async () => {},
}: {
  restart: () => void;
  instanceId?: string;
  now?: () => number;
  beforeRestart?: () => void;
  ready?: () => Promise<unknown>;
}) {
  const requests = new Set<Promise<unknown>>();
  const starting = new Set<Promise<unknown>>();
  const storage = new Set<Promise<unknown>>();
  let restarting = false;
  let storageClosing = false;
  let restartPromise: Promise<void> | null = null;
  let shutdown = { stopSync: async () => {}, closeStorage: async () => {} };

  function requestRestart(): Promise<void> {
    if (restartPromise) return restartPromise;
    restarting = true;
    beforeRestart();
    restartPromise = (async () => {
      const cleanup = async () => {
        await ready();
        await Promise.allSettled([...starting]);
        try {
          await shutdown.stopSync();
        } finally {
          await Promise.allSettled([...requests]);
          storageClosing = true;
          await Promise.allSettled([...storage]);
          await shutdown.closeStorage();
        }
      };
      let deadline: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Worker cleanup exceeded five seconds.')), 5000);
      });
      try {
        await Promise.race([cleanup(), timeout]);
      } catch (error) {
        wlog.warn('shared-worker', 'Closing worker after cleanup failed or timed out', error);
      } finally {
        clearTimeout(deadline!);
        storageClosing = true;
        // Let serveRpcPort post the result before closing its event loop.
        setTimeout(restart, 0);
      }
    })();
    return restartPromise;
  }

  function track(handlers: Handlers, pending: Set<Promise<unknown>>, closed: () => boolean): Handlers {
    return Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [
      name,
      (...args: any[]) => {
        if (closed()) return Promise.reject(new Error('The shared worker is restarting.'));
        const task = Promise.resolve().then(() => handler(...args));
        pending.add(task);
        if (pending === requests && name === DB_RPC.SYNC_START_ACCOUNT) starting.add(task);
        const remove = () => {
          pending.delete(task);
          starting.delete(task);
        };
        void task.then(remove, remove);
        return task;
      },
    ]));
  }

  return {
    requestRestart,
    storageHandlers(handlers: Handlers): Handlers {
      return track(handlers, storage, () => storageClosing);
    },

    requestHandlers(handlers: Handlers, {
      stopSync,
      closeStorage,
    }: {
      stopSync: () => Promise<void>;
      closeStorage: () => Promise<void>;
    }): Handlers {
      shutdown = { stopSync, closeStorage };
      return {
        ...track(handlers, requests, () => restarting),
        [DB_RPC.WORKER_STATUS]: (): WorkerStatus => ({
          instanceId,
          uptimeMs: now(),
        }),
        [DB_RPC.WORKER_RESTART]: requestRestart,
      };
    },
  };
}
