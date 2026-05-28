/**
 * Worker-side logger that publishes structured log entries on the
 * "tables touched" BroadcastChannel so the main thread can mirror them
 * to its own console. SharedWorker console output is invisible to
 * Playwright and to most devtools workflows; relaying through the
 * BroadcastChannel makes the worker's behaviour observable from any
 * tab attached to it.
 *
 * Each entry is { type: 'worker.log', level, source, message, time }.
 */

import { WORKER_LOG } from './rpc-dispatch';

let channel = null;

export function attachWorkerLogger(broadcastChannel) {
  channel = broadcastChannel;
}

export function workerLog(level, source, ...args) {
  const message = args
    .map((a) => {
      if (a instanceof Error) {
        return `${a.name}: ${a.message}\n${a.stack ?? ''}`;
      }
      if (typeof a === 'object') {
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      }
      return String(a);
    })
    .join(' ');
  // Always also log inside the worker, so anyone with worker devtools
  // open sees it. The broadcast hop is for tabs.
  (console[level] ?? console.log)(`[${source}]`, message);
  if (channel) {
    try {
      channel.postMessage({ type: WORKER_LOG, level, source, message, time: Date.now() });
    } catch {
      // Channel closed mid-broadcast; not actionable.
    }
  }
}

export const wlog = {
  debug: (source, ...args) => workerLog('debug', source, ...args),
  info: (source, ...args) => workerLog('info', source, ...args),
  warn: (source, ...args) => workerLog('warn', source, ...args),
  error: (source, ...args) => workerLog('error', source, ...args),
};
