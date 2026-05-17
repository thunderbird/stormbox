/**
 * Pure RPC dispatcher used by the SharedWorker. Extracted from the worker
 * entry so it can be exercised in unit tests against a fake port + handler
 * map without spinning up a real SharedWorker process.
 *
 * Wire format (request, port -> worker):
 *   { type: 'rpc.request', id: number, method: string, params: any }
 *
 * Wire format (response, worker -> port):
 *   { type: 'rpc.response', id: number, result?: any, error?: string }
 *
 * Cross-tab invalidations (worker -> all tabs via BroadcastChannel):
 *   { type: 'tables.touched', tables: string[] }
 */

export const RPC_REQUEST = 'rpc.request';
export const RPC_RESPONSE = 'rpc.response';
export const TABLES_TOUCHED = 'tables.touched';

/**
 * Dispatch a single inbound RPC message. Returns the response object the
 * caller should post back; throws on malformed messages so callers can
 * decide whether to log and continue or close the port.
 */
export async function dispatchRpc(message, handlers) {
  if (!message || message.type !== RPC_REQUEST) {
    throw new Error(`Unexpected message type: ${message?.type}`);
  }
  const { id, method, params } = message;
  if (typeof id !== 'number' || typeof method !== 'string') {
    throw new Error('Malformed RPC request');
  }
  const handler = handlers[method];
  if (!handler) {
    return {
      type: RPC_RESPONSE,
      id,
      error: `Unknown RPC method: ${method}`,
    };
  }
  try {
    const result = await handler(params ?? {});
    return { type: RPC_RESPONSE, id, result: result ?? null };
  } catch (error) {
    return {
      type: RPC_RESPONSE,
      id,
      error: error?.message ?? String(error),
    };
  }
}

/**
 * Build a broadcaster that batches touched table-family names and flushes
 * them on the broadcast channel after the next event-loop turn. Used by
 * handlers via the noopBroadcaster contract: touch(family) and flush().
 */
export function makeBroadcaster(channel) {
  let queued = null;
  const touched = new Set();

  return {
    touch(family) {
      touched.add(family);
      if (queued) {
        return;
      }
      queued = Promise.resolve().then(() => {
        const tables = Array.from(touched);
        touched.clear();
        queued = null;
        if (tables.length > 0) {
          channel.postMessage({ type: TABLES_TOUCHED, tables });
        }
      });
    },
    flush() {
      const out = Array.from(touched);
      touched.clear();
      return out;
    },
  };
}
