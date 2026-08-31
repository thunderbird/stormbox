/**
 * Pure RPC dispatcher used by the SharedWorker. Extracted from the worker
 * entry so it can be exercised in unit tests against a fake port + handler
 * map without spinning up a real SharedWorker process.
 *
 * Wire format (request, port -> worker):
 *   { type: 'rpc.request', id: number, method: string, params: any }
 *
 * Wire format (response, worker -> port):
 *   { type: 'rpc.response', id: number, result?: any, error?: object }
 *
 * Long-running calls may also use:
 *   { type: 'rpc.cancel', id: number }                  port -> worker
 *   { type: 'rpc.progress', id: number, progress: any } worker -> port
 *
 * Cross-tab invalidations (worker -> all tabs via BroadcastChannel):
 *   { type: 'tables.touched', tables: string[] }
 */

export const RPC_REQUEST = 'rpc.request';
export const RPC_RESPONSE = 'rpc.response';
export const RPC_CANCEL = 'rpc.cancel';
export const RPC_PROGRESS = 'rpc.progress';
export const TABLES_TOUCHED = 'tables.touched';
export const WORKER_LOG = 'worker.log';

export const RPC_PROGRESS_INTERVAL_MS = 250;

export interface RpcHandlerContext {
  signal?: AbortSignal;
  reportProgress?: (progress: any) => void;
}

export interface SerializedRpcError {
  name: string;
  message: string;
  [key: string]: unknown;
}

const RPC_ERROR_FIELDS = [
  'type',
  'status',
  'code',
  'terminal',
  'maxBytes',
  'actualBytes',
  'elapsedMs',
  'requestId',
  'capability',
] as const;

function transferPercent(progress: any): number | null {
  const loaded = Number(progress?.loaded);
  const total = Number(progress?.total);
  if (!Number.isFinite(loaded) || !Number.isFinite(total) || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((loaded / total) * 100)));
}

function isBlobTransferProgress(progress: any): boolean {
  return (
    (progress?.direction === 'upload' || progress?.direction === 'download')
    && (
      progress?.phase === 'transferring'
      || progress?.phase === 'processing'
      || progress?.phase === 'complete'
    )
    && Number.isFinite(Number(progress?.loaded))
  );
}

export function makeRpcProgressReporter(
  postProgress: (progress: any) => void,
  {
    now = Date.now,
    intervalMs = RPC_PROGRESS_INTERVAL_MS,
  }: {
    now?: () => number;
    intervalMs?: number;
  } = {},
): (progress: any) => void {
  let started = false;
  let lastEmittedAt = Number.NEGATIVE_INFINITY;
  let lastPercent: number | null = null;
  let lastPhase: string | null = null;

  return (progress: any) => {
    if (!isBlobTransferProgress(progress)) {
      postProgress(progress);
      return;
    }

    const emittedAt = now();
    const percent = transferPercent(progress);
    const phaseChanged = started && progress.phase !== lastPhase;
    const shouldEmit = !started
      || progress.phase === 'complete'
      || phaseChanged
      || (percent == null
        ? emittedAt - lastEmittedAt >= intervalMs
        : percent !== lastPercent);
    if (!shouldEmit) return;

    started = true;
    lastEmittedAt = emittedAt;
    lastPercent = percent;
    lastPhase = progress.phase;
    postProgress(progress);
  };
}

export function serializeRpcError(error: any): SerializedRpcError {
  const serialized: SerializedRpcError = {
    name: typeof error?.name === 'string' && error.name ? error.name : 'Error',
    message: error?.message ?? String(error),
  };
  for (const field of RPC_ERROR_FIELDS) {
    const value = error?.[field];
    if (
      value == null
      || typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
    ) {
      if (value != null) serialized[field] = value;
    }
  }
  return serialized;
}

/**
 * Dispatch a single inbound RPC message. Returns the response object the
 * caller should post back; throws on malformed messages so callers can
 * decide whether to log and continue or close the port.
 */
export async function dispatchRpc(
  message,
  handlers,
  context: RpcHandlerContext = {},
) {
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
      error: serializeRpcError(new Error(`Unknown RPC method: ${method}`)),
    };
  }
  try {
    const result = await handler(params ?? {}, context);
    return { type: RPC_RESPONSE, id, result: result ?? null };
  } catch (error) {
    return {
      type: RPC_RESPONSE,
      id,
      error: serializeRpcError(error),
    };
  }
}

/**
 * Serve one MessagePort and isolate cancellation to the request id on that
 * port. The transport's global abort latch remains reserved for account
 * teardown.
 */
export function serveRpcPort(
  port: MessagePort,
  getHandlers: () => Promise<Record<string, any>>,
) {
  const inFlight = new Map<number, AbortController>();
  const onMessage = (event: MessageEvent) => {
    const message = event.data;
    if (message?.type === RPC_CANCEL) {
      if (typeof message.id === 'number') {
        inFlight.get(message.id)?.abort();
      }
      return;
    }
    if (!message || message.type !== RPC_REQUEST) return;

    const controller = new AbortController();
    inFlight.set(message.id, controller);
    void (async () => {
      let response;
      try {
        const handlers = await getHandlers();
        const reportProgress = makeRpcProgressReporter((progress) => {
          if (!controller.signal.aborted) {
            port.postMessage({
              type: RPC_PROGRESS,
              id: message.id,
              progress,
            });
          }
        });
        response = await dispatchRpc(message, handlers, {
          signal: controller.signal,
          reportProgress,
        });
      } catch (error) {
        response = {
          type: RPC_RESPONSE,
          id: message.id,
          error: serializeRpcError(new Error(
            `Database failed to initialise: ${error?.message ?? error}`,
          )),
        };
      } finally {
        if (inFlight.get(message.id) === controller) {
          inFlight.delete(message.id);
        }
      }
      port.postMessage(response);
    })();
  };
  port.addEventListener('message', onMessage);
  return () => {
    port.removeEventListener('message', onMessage);
    for (const controller of inFlight.values()) controller.abort();
    inFlight.clear();
  };
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
