import { WORKER_RESTARTED } from './rpc-dispatch';

export const DATABASE_OWNER_LOCK = 'stormbox.database-owner';
const OWNER_MESSAGE = 'worker.database-owner';

export function needsFirefoxLockWorkaround(userAgent = globalThis.navigator?.userAgent ?? ''): boolean {
  return /Gecko\/\d/.test(userAgent) && /Firefox\/\d/.test(userAgent);
}

/** One lifetime lock serializes database initialization across worker versions. */
export function claimDatabaseOwnership({
  channel,
  locks = navigator.locks,
  url = globalThis.location.href,
  startedAt = performance.timeOrigin,
  id = crypto.randomUUID(),
  superseded,
}: {
  channel: BroadcastChannel;
  locks?: LockManager;
  url?: string;
  startedAt?: number;
  id?: string;
  superseded: (replacementUrl: string) => void;
}) {
  const controller = new AbortController();
  let retiring = false;
  let acquired = false;
  const announce = () => channel.postMessage({ type: OWNER_MESSAGE, url, startedAt, id });
  const onMessage = ({ data }: MessageEvent) => {
    if (data?.type !== OWNER_MESSAGE || data.url === url || retiring
      || typeof data.url !== 'string' || typeof data.startedAt !== 'number'
      || typeof data.id !== 'string') return;
    if (data.startedAt > startedAt || (data.startedAt === startedAt && data.id > id)) {
      retiring = true;
      controller.abort();
      clearInterval(timer);
      superseded(data.url);
    } else if (acquired) {
      announce();
    }
  };
  channel.addEventListener('message', onMessage);
  const ready = new Promise<void>((resolve, reject) => {
    void locks.request(DATABASE_OWNER_LOCK, { signal: controller.signal }, async () => {
      acquired = true;
      clearInterval(timer);
      announce();
      // Older releases do not understand the ownership protocol, but do reload.
      channel.postMessage({ type: WORKER_RESTARTED, replacementWorkerUrl: url });
      resolve();
      // Only worker termination releases ownership, including after failed cleanup.
      await new Promise<void>(() => {});
    }).catch(reject);
  });
  announce();
  const timer = setInterval(announce, 500);
  return {
    ready,
    stop() {
      retiring = true;
      clearInterval(timer);
      channel.removeEventListener('message', onMessage);
      controller.abort();
    },
  };
}
