/**
 * JMAP transport over HTTP and WebSocket.
 *
 * - Session document fetch (RFC 8620 §2)
 * - Method-call requests over POST /jmap (HTTP fallback)
 * - WebSocket subprotocol per RFC 8887: @type='Request'/'Response',
 *   requestId correlation, WebSocketPushEnable for state changes,
 *   pushState resume on reconnect.
 *
 * The constructor takes injection points so unit tests can supply fakes
 * for fetch and WebSocket without monkey-patching globals.
 */

import { wlog } from '../../../db/worker-log';

const JMAP_CORE = 'urn:ietf:params:jmap:core';
const JMAP_MAIL = 'urn:ietf:params:jmap:mail';
const JMAP_SUBMISSION = 'urn:ietf:params:jmap:submission';
const JMAP_CONTACTS = 'urn:ietf:params:jmap:contacts';
const JMAP_QUOTA = 'urn:ietf:params:jmap:quota';
const JMAP_FILENODE = 'urn:ietf:params:jmap:filenode';
const JMAP_WEBSOCKET_CAP = 'urn:ietf:params:jmap:websocket';

export const JMAP_CAPS = Object.freeze({
  CORE: JMAP_CORE,
  MAIL: JMAP_MAIL,
  SUBMISSION: JMAP_SUBMISSION,
  CONTACTS: JMAP_CONTACTS,
  QUOTA: JMAP_QUOTA,
  FILENODE: JMAP_FILENODE,
  WEBSOCKET: JMAP_WEBSOCKET_CAP,
});

export interface ServerClockReference {
  capturedAtMs: number;
  lowerOffsetMs: number;
  uncertaintyMs: number;
}

const SERVER_CLOCK_MAX_ABS_OFFSET_MS = 24 * 60 * 60 * 1_000;
const SERVER_CLOCK_MAX_AGE_MS = 10 * 60 * 1_000;
export const SERVER_CLOCK_MAX_UNCERTAINTY_MS = 31_000;

function httpResponseError(
  label: string,
  response: { status: number; statusText: string },
  detail = '',
) {
  const error: any = new Error(
    `${label}: ${response.status} ${response.statusText}${detail ? `\n${detail}` : ''}`,
  );
  error.type = 'httpError';
  error.status = response.status;
  return error;
}

function downloadTooLargeError(maxBytes: number, actualBytes?: number) {
  const error: any = new Error(
    actualBytes == null
      ? `JMAP download exceeds the ${maxBytes} byte limit`
      : `JMAP download is ${actualBytes} bytes, exceeding the ${maxBytes} byte limit`,
  );
  error.type = 'tooLarge';
  error.status = 413;
  error.maxBytes = maxBytes;
  if (actualBytes != null) error.actualBytes = actualBytes;
  return error;
}

function boundedDownloadLimit(maxBytes: number | undefined): number | undefined {
  if (maxBytes == null) return undefined;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('JMAP download maxBytes must be a non-negative safe integer');
  }
  return maxBytes;
}

function reportTransferProgress(onProgress: any, progress: any) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress(progress);
  } catch {
    // Progress observers cannot affect the transfer.
  }
}

type DownloadBodyKind = 'blob' | 'bytes';
type DownloadChunk = Uint8Array<ArrayBuffer>;

interface DownloadOptions {
  accountId: string;
  blobId: string;
  type?: string;
  name?: string;
  maxBytes?: number;
  truncateAtMaxBytes?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: any) => void;
}

function buildDownloadBody(
  chunks: DownloadChunk[],
  totalBytes: number,
  kind: DownloadBodyKind,
  type: string,
): Blob | Uint8Array {
  if (kind === 'blob') {
    return new Blob(chunks, { type });
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readDownloadBody(response: any, {
  maxBytes,
  truncateAtMaxBytes,
  onProgress,
  onActivity,
  kind,
  type,
}: {
  maxBytes?: number;
  truncateAtMaxBytes?: boolean;
  onProgress?: (progress: any) => void;
  onActivity: () => void;
  kind: DownloadBodyKind;
  type: string;
}): Promise<Blob | Uint8Array> {
  const contentLength = response.headers?.get?.('content-length');
  let total: number | null = null;
  if (typeof contentLength === 'string' && /^\d+$/.test(contentLength.trim())) {
    const declaredBytes = BigInt(contentLength.trim());
    if (
      maxBytes != null
      && declaredBytes > BigInt(maxBytes)
      && !truncateAtMaxBytes
    ) {
      const error = downloadTooLargeError(maxBytes);
      await response.body?.cancel?.(error).catch(() => {});
      throw error;
    }
    if (declaredBytes <= BigInt(Number.MAX_SAFE_INTEGER)) {
      total = Number(declaredBytes);
    }
  }

  reportTransferProgress(onProgress, {
    direction: 'download',
    phase: 'transferring',
    loaded: 0,
    total,
  });
  const reader = response.body?.getReader?.();
  if (reader) {
    const chunks: DownloadChunk[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk: DownloadChunk = value instanceof Uint8Array
          ? value as DownloadChunk
          : new Uint8Array(value);
        if (maxBytes != null && chunk.byteLength > maxBytes - totalBytes) {
          if (truncateAtMaxBytes) {
            const remaining = maxBytes - totalBytes;
            if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
            totalBytes += Math.max(0, remaining);
            onActivity();
            reportTransferProgress(onProgress, {
              direction: 'download',
              phase: 'transferring',
              loaded: totalBytes,
              total,
            });
            await reader.cancel().catch(() => {});
            break;
          }
          const error = downloadTooLargeError(maxBytes, totalBytes + chunk.byteLength);
          await reader.cancel(error).catch(() => {});
          throw error;
        }
        chunks.push(chunk);
        totalBytes += chunk.byteLength;
        onActivity();
        reportTransferProgress(onProgress, {
          direction: 'download',
          phase: 'transferring',
          loaded: totalBytes,
          total,
        });
        if (
          truncateAtMaxBytes
          && maxBytes != null
          && totalBytes === maxBytes
          && (total == null || total > totalBytes)
        ) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
    } finally {
      reader.releaseLock?.();
    }
    reportTransferProgress(onProgress, {
      direction: 'download',
      phase: 'complete',
      loaded: totalBytes,
      total: total ?? totalBytes,
    });
    return buildDownloadBody(chunks, totalBytes, kind, type);
  }

  if (truncateAtMaxBytes && maxBytes != null) {
    const error: any = new Error(
      'Bounded truncating download requires a readable response stream',
    );
    error.type = 'streamingUnavailable';
    await response.body?.cancel?.(error).catch(() => {});
    throw error;
  }

  const downloaded = kind === 'blob'
    ? (typeof response.blob === 'function'
        ? await response.blob()
        : new Blob([await response.arrayBuffer()], { type }))
    : new Uint8Array(await response.arrayBuffer());
  onActivity();
  const downloadedSize = downloaded instanceof Blob
    ? downloaded.size
    : downloaded.byteLength;
  if (maxBytes != null && downloadedSize > maxBytes && !truncateAtMaxBytes) {
    throw downloadTooLargeError(maxBytes, downloadedSize);
  }
  reportTransferProgress(onProgress, {
    direction: 'download',
    phase: 'complete',
    loaded: downloadedSize,
    total: total ?? downloadedSize,
  });
  return downloaded;
}

export function isAuthenticationError(error: any): boolean {
  return error?.status === 401 || error?.status === 403;
}

/**
 * @typedef {object} WsCredential
 * @property {'bearer'|'basic'} kind  How to encode the credential in
 *                                    the WebSocket URL.
 * @property {string} token           Bearer JWT or base64(user:pass).
 */

/**
 * @typedef {object} TransportOptions
 * @property {string} sessionUrl       Absolute URL of the JMAP session
 *                                     document (https://host/.well-known/jmap).
 * @property {() => Promise<string>} getAuthHeader
 *                                     Async producer of the value for the
 *                                     Authorization header (Basic/Bearer).
 * @property {() => Promise<WsCredential>} [getWsCredential]
 *                                     Async producer of the credential
 *                                     attached to the WebSocket upgrade
 *                                     URL. Required if WebSocket is used.
 * @property {string} [wsProxyUrl]     If set, this URL is used as the
 *                                     base of the WebSocket connection
 *                                     instead of the URL Stalwart
 *                                     advertises in the session
 *                                     document. The proxy is expected
 *                                     to read the credential off the
 *                                     query string and convert it to
 *                                     the Authorization header upstream.
 * @property {typeof fetch} [fetch]    Optional fetch impl. Defaults to globalThis.fetch.
 * @property {typeof WebSocket} [WebSocketImpl]
 *                                     Optional WebSocket constructor. Defaults
 *                                     to globalThis.WebSocket.
 * @property {typeof XMLHttpRequest} [XMLHttpRequestImpl]
 *                                     Optional XMLHttpRequest constructor for
 *                                     observable upload-body progress.
 * @property {number} [wsRequestTimeoutMs]
 *                                     Upper bound for both the opening
 *                                     handshake and each WebSocket request.
 */

/**
 * The rejection for a request the transport refused or cancelled
 * because teardown aborted it. Typed so a caller can tell an
 * intentional teardown from a stalled server, and so neither is
 * mistaken for a server-side rejection.
 */
function abortedError(label: string, elapsedMs: number) {
  const err: any = new Error(`JMAP request ${label} was aborted`);
  err.type = 'transportAborted';
  err.elapsedMs = elapsedMs;
  return err;
}

function cancelledError(label: string, elapsedMs: number) {
  const err: any = new Error(`JMAP transfer ${label} was cancelled`);
  err.name = 'AbortError';
  err.type = 'cancelled';
  err.elapsedMs = elapsedMs;
  return err;
}

function wsRequestTimeoutError(requestId: string, elapsedMs: number) {
  const err: any = new Error(
    `JMAP WebSocket request ${requestId} timed out after ${elapsedMs}ms`,
  );
  err.type = 'wsRequestTimeout';
  err.requestId = requestId;
  err.elapsedMs = elapsedMs;
  return err;
}

export class JmapTransport {
  _sessionUrl: string;
  _getAuthHeader: () => Promise<string>;
  _getWsCredential: any;
  _wsProxyUrl: string | null;
  _fetch: typeof fetch;
  _WebSocket: typeof WebSocket;
  _session: any;
  _ws: WebSocket | null;
  _wsReadyPromise: Promise<void> | null;
  _wsPending: Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>;
  _stateListeners: Set<(state: any) => void>;
  _closeListeners: Set<(event: any) => void>;
  _nextWsId: number;
  _lastPushState: any;
  _wsRequestTimeoutMs: number;
  _httpRequestTimeoutMs: number;
  _httpBlobIdleTimeoutMs: number;
  _httpUploadIdleTimeoutMs: number;
  _XMLHttpRequest: typeof XMLHttpRequest | null;
  _inFlightHttp: Set<{ abort: () => void }>;
  _aborted: boolean;
  _serverClockReference: ServerClockReference | null;

  constructor(options: any) {
    this._sessionUrl = options.sessionUrl;
    this._getAuthHeader = options.getAuthHeader;
    this._getWsCredential = options.getWsCredential ?? null;
    this._wsProxyUrl = options.wsProxyUrl ?? null;
    this._fetch = options.fetch ?? globalThis.fetch;
    this._WebSocket = options.WebSocketImpl ?? globalThis.WebSocket;
    this._session = null;

    // WebSocket state
    /** @type {WebSocket|null} */
    this._ws = null;
    this._wsReadyPromise = null;
    /** @type {Map<string, { resolve: (v: any) => void, reject: (e: any) => void }>} */
    this._wsPending = new Map();
    /** @type {Set<(state: any) => void>} */
    this._stateListeners = new Set();
    /** @type {Set<(event: any) => void>} */
    this._closeListeners = new Set();
    this._nextWsId = 1;
    this._lastPushState = null;
    // Opening the socket and every wsRequest share one deadline. A server
    // can stall either the HTTP upgrade or an established connection
    // without producing an event or Response, and browser TCP keepalives
    // can take minutes to notice. 30s is a generous upper bound: typical
    // Email/get + Email/query round trips finish in well under a second,
    // and the slow paths (large folder indexer chunks against a contended
    // Stalwart) finish in a few seconds.
    this._wsRequestTimeoutMs = options.wsRequestTimeoutMs ?? 30_000;
    // The HTTP leg needs the same protection for a different reason.
    // fetch() has no timeout of its own, so a server that accepts the
    // connection and then stalls leaves the awaiting caller hung until
    // the OS gives up on the socket. For a send that is worse than a
    // slow send: compose-store keeps status SENDING, which is what
    // Close and Discard are gated on, so the dialog becomes
    // unclosable. Matching the WebSocket bound keeps the two legs
    // behaving the same way.
    this._httpRequestTimeoutMs = options.httpRequestTimeoutMs ?? 30_000;
    // Downloads reset their idle timer for every streamed chunk.
    this._httpBlobIdleTimeoutMs = options.httpBlobIdleTimeoutMs
      ?? options.httpBlobTimeoutMs
      ?? 120_000;
    // Uploads use request-body progress and have no total-duration limit.
    this._httpUploadIdleTimeoutMs = options.httpUploadIdleTimeoutMs ?? 15_000;
    this._XMLHttpRequest = options.XMLHttpRequestImpl
      ?? globalThis.XMLHttpRequest
      ?? null;
    /** Abort controllers for HTTP requests that have not settled yet,
     *  so abort() can cancel them during teardown. */
    this._inFlightHttp = new Set();
    this._aborted = false;
    this._serverClockReference = null;
  }

  isWebSocketOpen(): boolean {
    return this._ws != null && this._ws.readyState === this._ws.OPEN;
  }

  /**
   * Cancel every HTTP request that has not settled and reject every
   * pending WebSocket request, without closing the socket.
   *
   * Teardown calls this before awaiting the outbox runner: the runner
   * cannot quiesce while a mutation is parked on a network call, and
   * the caller of backend.stop() should not have to wait out a request
   * deadline to find that out.
   *
   * The abort latches, and requests issued afterwards are refused
   * rather than sent. Cancelling only what is in flight would not be
   * enough: a mutation part-way through a multi-call operation (a send
   * runs create, submit, then reconcile) reacts to its cancelled call
   * by moving on, and the call it issues next would have missed the
   * abort and hold teardown open for its own deadline. Latching is safe
   * because sync-host builds one transport per started backend and
   * discards it after stop(), so nothing ever needs this one again.
   */
  abort() {
    this._aborted = true;
    for (const controller of [...this._inFlightHttp]) {
      try {
        controller.abort();
      } catch {
        // A controller that already aborted throws nothing useful.
      }
    }
    this._inFlightHttp.clear();
    for (const [requestId, pending] of [...this._wsPending]) {
      pending.reject(abortedError(requestId, 0));
    }
    this._wsPending.clear();
  }

  /**
   * Run one fetch under a fixed deadline or progress-based idle timeout
   * and keep the timer armed while `consume` reads the response body.
   *
   * The body read has to happen inside the window: fetch() resolves as
   * soon as the response headers arrive, so a server that sends headers
   * and then stalls the body would hang in response.json() with the
   * timer already cleared.
   *
   * Aborts are reported as typed errors so a caller can tell a stalled
   * server from an intentional teardown, and neither is mistaken for a
   * server-side rejection.
   */
  async _fetchWithDeadline<T>(url: string, init: any, {
    timeoutMs,
    label,
    consume,
    timeoutKind = 'deadline',
    bindActivity,
  }: {
    timeoutMs: number;
    label: string;
    consume: (response: any, onActivity: () => void) => Promise<T>;
    timeoutKind?: 'deadline' | 'idle';
    bindActivity?: (onActivity: () => void) => void;
  }): Promise<T> {
    if (this._aborted) throw abortedError(label, 0);
    const controller = new AbortController();
    const external: AbortSignal | undefined = init.signal;
    if (external?.aborted) throw cancelledError(label, 0);
    let forwardAbort: (() => void) | null = null;
    if (external) {
      forwardAbort = () => controller.abort();
      external.addEventListener('abort', forwardAbort, { once: true });
    }
    this._inFlightHttp.add(controller);
    const started = Date.now();
    let timedOut = false;
    let timer: any = null;
    const armTimeout = () => {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timedOut) return;
      if (timer != null) {
        if (timeoutKind === 'deadline') return;
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    };
    const onActivity = () => {
      if (timeoutKind === 'idle') armTimeout();
    };
    bindActivity?.(onActivity);
    armTimeout();
    try {
      const response = await this._fetch(url, { ...init, signal: controller.signal });
      this._captureServerClock(response, started, Date.now());
      onActivity();
      return await consume(response, onActivity);
    } catch (err: any) {
      const elapsedMs = Date.now() - started;
      if (timedOut) {
        const idle = timeoutKind === 'idle';
        wlog.warn(
          'jmap-transport',
          `${label} ${idle ? 'idle ' : ''}timeout after ${elapsedMs}ms`,
        );
        const timeoutErr: any = new Error(
          idle
            ? `JMAP HTTP transfer ${label} made no progress for ${timeoutMs}ms`
            : `JMAP HTTP request ${label} timed out after ${elapsedMs}ms`,
        );
        timeoutErr.type = idle ? 'httpIdleTimeout' : 'httpRequestTimeout';
        timeoutErr.elapsedMs = elapsedMs;
        throw timeoutErr;
      }
      if (external?.aborted) {
        throw cancelledError(label, elapsedMs);
      }
      if (controller.signal.aborted) {
        throw abortedError(label, elapsedMs);
      }
      throw err;
    } finally {
      if (timer != null) clearTimeout(timer);
      this._inFlightHttp.delete(controller);
      if (forwardAbort && external) {
        external.removeEventListener('abort', forwardAbort);
      }
    }
  }

  _uploadWithFetchIdleTimeout(url: string, {
    auth,
    type,
    body,
    bodySize,
    signal,
    onProgress,
    label,
  }: {
    auth: string;
    type: string;
    body: any;
    bodySize: number | null;
    signal?: AbortSignal;
    onProgress?: (progress: any) => void;
    label: string;
  }): Promise<any> {
    const source = body instanceof Blob ? body : new Blob([body], { type });
    const total = bodySize ?? source.size;
    const reader = source.stream().getReader();
    let uploadedBytes = 0;
    let onActivity = () => {};
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull: async (controller) => {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        uploadedBytes += value.byteLength;
        onActivity();
        reportTransferProgress(onProgress, {
          direction: 'upload',
          phase: 'transferring',
          loaded: uploadedBytes,
          total,
        });
        controller.enqueue(value as Uint8Array<ArrayBuffer>);
      },
      cancel: (reason) => reader.cancel(reason),
    });

    return this._fetchWithDeadline(url, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': type,
        Accept: 'application/json',
      },
      mode: 'cors',
      credentials: 'omit',
      body: stream,
      duplex: 'half',
      signal,
    }, {
      timeoutMs: this._httpUploadIdleTimeoutMs,
      label,
      timeoutKind: 'idle',
      bindActivity: (notifyActivity) => {
        onActivity = notifyActivity;
      },
      consume: async (response) => {
        reportTransferProgress(onProgress, {
          direction: 'upload',
          phase: 'processing',
          loaded: total,
          total,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw httpResponseError('JMAP upload failed', response, detail);
        }
        const result = await response.json();
        reportTransferProgress(onProgress, {
          direction: 'upload',
          phase: 'complete',
          loaded: total,
          total,
        });
        return result;
      },
    });
  }

  _uploadWithIdleTimeout(url: string, {
    auth,
    type,
    body,
    bodySize,
    signal,
    onProgress,
    label,
  }: {
    auth: string;
    type: string;
    body: any;
    bodySize: number | null;
    signal?: AbortSignal;
    onProgress?: (progress: any) => void;
    label: string;
  }): Promise<any> {
    if (this._aborted) return Promise.reject(abortedError(label, 0));
    if (signal?.aborted) return Promise.reject(cancelledError(label, 0));
    if (!this._XMLHttpRequest) {
      return this._uploadWithFetchIdleTimeout(url, {
        auth,
        type,
        body,
        bodySize,
        signal,
        onProgress,
        label,
      });
    }

    const request = new this._XMLHttpRequest();
    const started = Date.now();
    let uploadedBytes = 0;
    let uploadFinished = false;
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        if (timer != null) {
          clearTimeout(timer);
          timer = null;
        }
        request.removeEventListener('load', onLoad);
        request.removeEventListener('error', onError);
        request.removeEventListener('abort', onAbort);
        request.upload.removeEventListener('progress', onUploadProgress);
        request.upload.removeEventListener('load', onUploadLoad);
        signal?.removeEventListener('abort', onSignalAbort);
        this._inFlightHttp.delete(request);
      };
      const rejectOnce = (error: any) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const resolveOnce = (result: any) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const timeoutError = () => {
        const elapsedMs = Date.now() - started;
        wlog.warn('jmap-transport', `${label} idle timeout after ${elapsedMs}ms`);
        const error: any = new Error(
          `JMAP HTTP transfer ${label} made no progress for ${this._httpUploadIdleTimeoutMs}ms`,
        );
        error.type = 'httpIdleTimeout';
        error.elapsedMs = elapsedMs;
        return error;
      };
      const armTimeout = () => {
        if (
          !Number.isFinite(this._httpUploadIdleTimeoutMs)
          || this._httpUploadIdleTimeoutMs <= 0
          || timedOut
          || settled
        ) {
          return;
        }
        if (timer != null) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          timedOut = true;
          request.abort();
        }, this._httpUploadIdleTimeoutMs);
      };
      const reportUploadedBytes = (loaded: number) => {
        if (!Number.isFinite(loaded)) return;
        const acceptedBytes = bodySize == null ? loaded : Math.min(bodySize, loaded);
        if (acceptedBytes <= uploadedBytes) return;
        uploadedBytes = acceptedBytes;
        armTimeout();
        reportTransferProgress(onProgress, {
          direction: 'upload',
          phase: 'transferring',
          loaded: uploadedBytes,
          total: bodySize,
        });
      };
      const markUploadFinished = () => {
        if (uploadFinished) return;
        uploadFinished = true;
        if (bodySize != null) reportUploadedBytes(bodySize);
        reportTransferProgress(onProgress, {
          direction: 'upload',
          phase: 'processing',
          loaded: bodySize ?? uploadedBytes,
          total: bodySize,
        });
      };
      const onUploadProgress = (event: ProgressEvent) => {
        reportUploadedBytes(Number(event.loaded));
      };
      const onUploadLoad = () => {
        markUploadFinished();
      };
      const onSignalAbort = () => {
        request.abort();
      };
      const onAbort = () => {
        const elapsedMs = Date.now() - started;
        if (timedOut) {
          rejectOnce(timeoutError());
        } else if (signal?.aborted) {
          rejectOnce(cancelledError(label, elapsedMs));
        } else {
          rejectOnce(abortedError(label, elapsedMs));
        }
      };
      const onError = () => {
        rejectOnce(new Error(`JMAP upload failed: ${request.statusText || 'network error'}`));
      };
      const onLoad = () => {
        markUploadFinished();
        if (request.status < 200 || request.status >= 300) {
          rejectOnce(httpResponseError(
            'JMAP upload failed',
            request,
            request.responseText || '',
          ));
          return;
        }
        try {
          const result = JSON.parse(request.responseText);
          const completedBytes = bodySize ?? Number(result?.size ?? uploadedBytes);
          reportTransferProgress(onProgress, {
            direction: 'upload',
            phase: 'complete',
            loaded: completedBytes,
            total: bodySize ?? completedBytes,
          });
          resolveOnce(result);
        } catch (error) {
          rejectOnce(error);
        }
      };

      request.addEventListener('load', onLoad);
      request.addEventListener('error', onError);
      request.addEventListener('abort', onAbort);
      request.upload.addEventListener('progress', onUploadProgress);
      request.upload.addEventListener('load', onUploadLoad);
      signal?.addEventListener('abort', onSignalAbort, { once: true });
      this._inFlightHttp.add(request);
      try {
        request.open('POST', url, true);
        request.setRequestHeader('Authorization', auth);
        request.setRequestHeader('Content-Type', type || 'application/octet-stream');
        request.setRequestHeader('Accept', 'application/json');
        armTimeout();
        request.send(body);
      } catch (error) {
        rejectOnce(error);
      }
    });
  }

  /**
   * Fetch and cache the session document. Subsequent calls return the
   * cached value unless force=true.
   */
  async fetchSession({ force = false, signal }: {
    force?: boolean;
    signal?: AbortSignal;
  } = {}) {
    if (this._session && !force) {
      return this._session;
    }
    const auth = await this._getAuthHeader();
    this._session = await this._fetchWithDeadline(this._sessionUrl, {
      headers: {
        Authorization: auth,
        Accept: 'application/json',
      },
      mode: 'cors',
      credentials: 'omit',
      signal,
    }, {
      timeoutMs: this._httpRequestTimeoutMs,
      label: 'session',
      consume: async (response) => {
        if (!response.ok) {
          throw httpResponseError('JMAP session fetch failed', response);
        }
        return response.json();
      },
    });
    return this._session;
  }

  get session() {
    return this._session;
  }

  /**
   * A recent bounded estimate derived from an HTTP Date response header.
   * `lowerOffsetMs` treats the whole advertised second as not yet elapsed;
   * `uncertaintyMs` covers its sub-second precision and the request RTT.
   */
  get serverClockReference(): ServerClockReference | null {
    const reference = this._serverClockReference;
    if (!reference || Date.now() - reference.capturedAtMs > SERVER_CLOCK_MAX_AGE_MS) {
      return null;
    }
    return { ...reference };
  }

  _captureServerClock(response: any, startedAtMs: number, receivedAtMs: number): void {
    const raw = response?.headers?.get?.('date');
    if (typeof raw !== 'string' || raw.trim().length === 0) return;
    const serverDateMs = Date.parse(raw);
    if (!Number.isFinite(serverDateMs)) return;
    const roundTripMs = Math.max(0, receivedAtMs - startedAtMs);
    const uncertaintyMs = 999 + roundTripMs;
    const lowerOffsetMs = serverDateMs - receivedAtMs;
    if (
      uncertaintyMs > SERVER_CLOCK_MAX_UNCERTAINTY_MS
      || Math.abs(lowerOffsetMs) > SERVER_CLOCK_MAX_ABS_OFFSET_MS
      || Math.abs(lowerOffsetMs + uncertaintyMs) > SERVER_CLOCK_MAX_ABS_OFFSET_MS
    ) {
      return;
    }
    this._serverClockReference = {
      capturedAtMs: receivedAtMs,
      lowerOffsetMs,
      uncertaintyMs,
    };
  }

  /**
   * Issue a JMAP method-call request over HTTP. Returns the
   * { methodResponses } object the server returned.
   *
   * @param {string[]} using
   * @param {Array<[string, object, string]>} methodCalls
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
   */
  async request(
    using: string[],
    methodCalls: any[],
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ) {
    if (!this._session?.apiUrl) {
      await this.fetchSession();
    }
    const auth = await this._getAuthHeader();
    const summary = methodCalls.map(([name, params]) =>
      `${name}(${params?.position != null ? `pos=${params.position}` : ''}${params?.limit != null ? ` lim=${params.limit}` : ''})`,
    ).join(' + ');
    wlog.info('jmap-transport', `httpRequest ${summary}`);
    try {
      return await this._fetchWithDeadline(this._session.apiUrl, {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        mode: 'cors',
        credentials: 'omit',
        body: JSON.stringify({ using, methodCalls }),
        signal: opts.signal,
      }, {
        timeoutMs: opts.timeoutMs ?? this._httpRequestTimeoutMs,
        label: summary,
        consume: async (response) => {
          wlog.info('jmap-transport', `httpResponse ${summary} status=${response.status}`);
          if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw httpResponseError('JMAP request failed', response, detail);
          }
          return response.json();
        },
      });
    } catch (err: any) {
      wlog.warn('jmap-transport', `httpRequest failed: ${err?.message}`);
      throw err;
    }
  }

  /**
   * Upload a binary blob to the account's JMAP upload endpoint
   * (RFC 8620 §6.1). Returns the server's upload response, most
   * importantly { blobId, type, size }, so the caller can reference the
   * blob from an Email/set create (e.g. inline pasted images).
   *
   * @param {object} args
   * @param {string} args.accountId  JMAP account id (remote_account_id)
   *                                  substituted into the uploadUrl template.
   * @param {string} args.type       MIME type sent as the Content-Type.
   * @param {BodyInit} args.body     The blob bytes (Uint8Array/Blob/ArrayBuffer).
   * @returns {Promise<{ accountId: string, blobId: string, type: string, size: number }>}
   */
  async upload({
    accountId,
    type,
    body,
    signal,
    onProgress,
  }: {
    accountId: string;
    type: string;
    body: any;
    signal?: AbortSignal;
    onProgress?: (progress: any) => void;
  }) {
    if (!this._session?.uploadUrl) {
      await this.fetchSession({ signal });
    }
    const template = this._session?.uploadUrl;
    if (!template) {
      throw new Error('JMAP session does not advertise an uploadUrl');
    }
    const url = template.replace('{accountId}', encodeURIComponent(accountId));
    const auth = await this._getAuthHeader();
    if (signal?.aborted) throw cancelledError(`upload ${type}`, 0);
    const bodySize = Number.isSafeInteger(body?.size)
      ? Number(body.size)
      : (Number.isSafeInteger(body?.byteLength) ? Number(body.byteLength) : null);
    const contentType = type || 'application/octet-stream';
    const label = `upload ${contentType}`;
    wlog.info('jmap-transport', `upload ${type} -> ${accountId}`);
    reportTransferProgress(onProgress, {
      direction: 'upload',
      phase: 'transferring',
      loaded: 0,
      total: bodySize,
    });
    return this._uploadWithIdleTimeout(url, {
      auth,
      type: contentType,
      body,
      signal,
      bodySize,
      onProgress,
      label,
    });
  }

  /**
   * Download a blob from the account's JMAP download endpoint
   * (RFC 8620 §6.2). The endpoint requires the Authorization header, so
   * a raw <img src> cannot fetch it directly; callers fetch the bytes
   * here and turn them into a data:/blob: URL for rendering (e.g. inline
   * cid: images in the message viewer). Returns the raw bytes.
   *
   * @param {object} args
   * @param {string} args.accountId  JMAP account id (remote_account_id).
   * @param {string} args.blobId     Server blob id.
   * @param {string} [args.type]     MIME type, substituted into the
   *                                  template's {type} and sent as Accept.
   * @param {string} [args.name]     File name for the template's {name}.
   * @param {number} [args.maxBytes] Maximum accepted response body size.
   * @param {boolean} [args.truncateAtMaxBytes] Return a streamed prefix at
   *                                             maxBytes instead of failing.
   * @returns {Promise<Uint8Array>}
   */
  download(options: DownloadOptions): Promise<Uint8Array> {
    return this._download(options, 'bytes') as Promise<Uint8Array>;
  }

  /**
   * Attachment-only download path that builds the Blob directly from
   * response stream chunks. Byte/base64 compatibility callers continue
   * to use download().
   */
  downloadBlob(options: DownloadOptions): Promise<Blob> {
    return this._download(options, 'blob') as Promise<Blob>;
  }

  async _download({
    accountId,
    blobId,
    type = 'application/octet-stream',
    name = 'blob',
    maxBytes,
    truncateAtMaxBytes = false,
    signal,
    onProgress,
  }: DownloadOptions, kind: DownloadBodyKind): Promise<Blob | Uint8Array> {
    const byteLimit = boundedDownloadLimit(maxBytes);
    if (!this._session?.downloadUrl) {
      await this.fetchSession({ signal });
    }
    const template = this._session?.downloadUrl;
    if (!template) {
      throw new Error('JMAP session does not advertise a downloadUrl');
    }
    const url = template
      .replace('{accountId}', encodeURIComponent(accountId))
      .replace('{blobId}', encodeURIComponent(blobId))
      .replace('{name}', encodeURIComponent(name || 'blob'))
      .replace('{type}', encodeURIComponent(type || 'application/octet-stream'));
    const auth = await this._getAuthHeader();
    wlog.info('jmap-transport', `download ${blobId} (${type})`);
    return this._fetchWithDeadline(url, {
      headers: { Authorization: auth },
      mode: 'cors',
      credentials: 'omit',
      signal,
    }, {
      timeoutMs: this._httpBlobIdleTimeoutMs,
      label: `download ${blobId}`,
      timeoutKind: 'idle',
      consume: async (response, onActivity) => {
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw httpResponseError('JMAP download failed', response, detail);
        }
        return readDownloadBody(response, {
          maxBytes: byteLimit,
          truncateAtMaxBytes,
          onProgress,
          onActivity,
          kind,
          type,
        });
      },
    });
  }

  /**
   * Open the JMAP WebSocket and complete the @type:WebSocketPushEnable
   * handshake. Idempotent; concurrent callers share the same connect
   * promise.
   *
   * @param {string[]} dataTypes  JMAP type names to subscribe to (e.g.
   *   ['Mailbox','Email','Thread','EmailDelivery','Identity']).
   * @param {string|null} [pushState]  Last-known pushState; the server
   *   will replay missed StateChanges.
   */
  async openWebSocket(dataTypes, pushState = null) {
    if (this._aborted) {
      return Promise.reject(abortedError('openWebSocket', 0));
    }
    if (this._wsReadyPromise) {
      return this._wsReadyPromise;
    }
    this._wsReadyPromise = (async () => {
      if (!this._session) {
        await this.fetchSession();
      }
      const wsCap = this._session.capabilities?.[JMAP_WEBSOCKET_CAP];
      if (!wsCap?.url) {
        throw new Error('Server does not advertise urn:ietf:params:jmap:websocket');
      }
      // If a proxy URL is configured, the credential rides on the
      // query string and the proxy converts it to an Authorization
      // header before forwarding to Stalwart. Otherwise we use the
      // URL Stalwart advertises directly (which only works for
      // non-browser clients that can set Authorization headers).
      const baseUrl = this._wsProxyUrl ?? wsCap.url;
      const wsUrl = new URL(baseUrl);
      if (this._wsProxyUrl && this._getWsCredential) {
        const cred = await this._getWsCredential();
        if (cred?.kind === 'bearer') wsUrl.searchParams.set('access_token', cred.token);
        else if (cred?.kind === 'basic') wsUrl.searchParams.set('basic', cred.token);
      }
      // Re-check on the far side of the session fetch and the
      // credential await: teardown can land in either gap, and opening
      // an authenticated socket after it would leave one live for a
      // signed-out account.
      if (this._aborted) throw abortedError('openWebSocket', 0);
      wlog.info('jmap-transport', `openWebSocket via ${wsUrl.host}${wsUrl.pathname}`);
      const ws = new this._WebSocket(wsUrl.toString(), ['jmap']);
      this._ws = ws;
      await waitForOpen(ws, this._wsRequestTimeoutMs);
      if (this._aborted) {
        try {
          ws.close(1000, 'transport aborted');
        } catch {
          // Nothing useful to do with a close that fails during teardown.
        }
        this._ws = null;
        throw abortedError('openWebSocket', 0);
      }
      ws.addEventListener('message', (event) => this._onWsMessage(event));
      ws.addEventListener('close', (event) => this._onWsClose(event));
      ws.addEventListener('error', (event) => this._onWsError(event));
      this._lastPushState = pushState ?? this._lastPushState;
      ws.send(JSON.stringify({
        '@type': 'WebSocketPushEnable',
        dataTypes,
        pushState: this._lastPushState ?? undefined,
      }));
    })().catch((err) => {
      this._wsReadyPromise = null;
      this._ws = null;
      throw err;
    });
    return this._wsReadyPromise;
  }

  /**
   * Issue a JMAP method-call request over the open WebSocket. Returns
   * the methodResponses array. Callers must have called openWebSocket()
   * first.
   *
   * @param {string[]} using
   * @param {Array<[string, object, string]>} methodCalls
   */
  wsRequest(using, methodCalls, opts: { timeoutMs?: number } = {}) {
    if (this._aborted) {
      return Promise.reject(abortedError('wsRequest', 0));
    }
    if (!this._ws || this._ws.readyState !== this._ws.OPEN) {
      return Promise.reject(new Error('WebSocket is not open'));
    }
    const requestId = `r${this._nextWsId}`;
    this._nextWsId += 1;
    const summary = methodCalls.map(([name, params]) =>
      `${name}(${params?.position != null ? `pos=${params.position}` : ''}${params?.limit != null ? ` lim=${params.limit}` : ''})`,
    ).join(' + ');
    wlog.info('jmap-transport', `wsRequest ${requestId}: ${summary}`);
    const timeoutMs = opts.timeoutMs ?? this._wsRequestTimeoutMs;
    return new Promise((resolve, reject) => {
      let timeoutHandle: any = null;
      const cleanup = () => {
        if (timeoutHandle != null) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
      };
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        const started = Date.now();
        timeoutHandle = setTimeout(() => {
          timeoutHandle = null;
          // Only honour the timeout if the pending entry is still
          // ours. A late Response can race with the timer; whoever
          // removes the entry first wins, and the other becomes a
          // no-op.
          if (this._wsPending.get(requestId)) {
            this._wsPending.delete(requestId);
            const elapsedMs = Date.now() - started;
            wlog.warn('jmap-transport', `wsResponse ${requestId} timeout after ${elapsedMs}ms`);
            reject(wsRequestTimeoutError(requestId, elapsedMs));
          }
        }, timeoutMs);
      }
      this._wsPending.set(requestId, {
        resolve: (v) => {
          cleanup();
          wlog.info('jmap-transport', `wsResponse ${requestId} ok`);
          resolve(v);
        },
        reject: (e) => {
          cleanup();
          wlog.warn('jmap-transport', `wsResponse ${requestId} err: ${e?.message}`);
          reject(e);
        },
      });
      this._ws.send(JSON.stringify({
        '@type': 'Request',
        id: requestId,
        using,
        methodCalls,
      }));
    });
  }

  /**
   * Subscribe to push notifications. Listener receives the changed
   * TypeState map and pushState. Returns an unsubscribe function.
   *
   * @param {(change: { changed: object, pushState: string|null }) => void} listener
   */
  onStateChange(listener) {
    this._stateListeners.add(listener);
    return () => this._stateListeners.delete(listener);
  }

  /**
   * Subscribe to WebSocket close events. Listener fires whenever the
   * underlying socket transitions to closed, regardless of cause
   * (server hangup, network drop, client-initiated closeWebSocket).
   * Used by the backend's reconnect supervisor; the listener is
   * responsible for deciding whether to reopen.
   *
   * @param {(event: any) => void} listener
   */
  onClose(listener) {
    this._closeListeners.add(listener);
    return () => this._closeListeners.delete(listener);
  }

  /**
   * Most recent pushState the server pushed (or null). The sync engine
   * persists this in account_services.push_state for resume on
   * reconnect.
   */
  get lastPushState() {
    return this._lastPushState;
  }

  closeWebSocket() {
    if (this._ws) {
      try {
        this._ws.close(1000, 'client closing');
      } catch {
        // Ignore close errors during teardown.
      }
    }
    this._ws = null;
    this._wsReadyPromise = null;
    for (const pending of this._wsPending.values()) {
      pending.reject(new Error('WebSocket closed'));
    }
    this._wsPending.clear();
  }

  // ----- internals -------------------------------------------------------

  _onWsMessage(event) {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      wlog.warn('jmap-transport', 'ws frame parse fail');
      return;
    }
    wlog.info('jmap-transport', `ws frame: @type=${payload['@type']} id=${payload.requestId ?? payload.pushState ?? '-'}`);
    switch (payload['@type']) {
      case 'Response': {
        const pending = this._wsPending.get(payload.requestId);
        if (pending) {
          this._wsPending.delete(payload.requestId);
          pending.resolve(payload);
        } else {
          wlog.warn('jmap-transport', `ws Response for unknown requestId=${payload.requestId}`);
        }
        return;
      }
      case 'RequestError': {
        const pending = this._wsPending.get(payload.requestId);
        if (pending) {
          this._wsPending.delete(payload.requestId);
          const error: any = new Error(
            payload.detail || payload.type || 'JMAP RequestError',
          );
          error.type = payload.type ?? 'jmapRequestError';
          if (Number.isFinite(payload.status)) {
            error.status = Number(payload.status);
          }
          pending.reject(error);
        }
        return;
      }
      case 'StateChange': {
        if (payload.pushState) {
          this._lastPushState = payload.pushState;
        }
        for (const listener of this._stateListeners) {
          try {
            listener({ changed: payload.changed ?? {}, pushState: payload.pushState ?? null });
          } catch (err) {
            // A misbehaving listener should not break delivery to others.
            console.error('JMAP state-change listener threw', err);
          }
        }
        return;
      }
      default:
        // Unknown frame type. RFC 8887 §4.3.1 says we may ignore.
        break;
    }
  }

  _onWsClose(event?: any) {
    for (const pending of this._wsPending.values()) {
      pending.reject(new Error('WebSocket closed mid-request'));
    }
    this._wsPending.clear();
    this._ws = null;
    this._wsReadyPromise = null;
    // Fan out to close listeners after pending requests have been
    // rejected, so a listener that decides to reopen sees a clean
    // _ws/_wsPending state.
    for (const listener of this._closeListeners) {
      try {
        listener(event ?? {});
      } catch (err) {
        console.error('JMAP close listener threw', err);
      }
    }
  }

  _onWsError(_event?: any) {
    // Browser WebSocket events surface as opaque error events. The
    // subsequent 'close' event will tear pending requests down.
  }
}

function waitForOpen(ws: WebSocket, timeoutMs: number): Promise<void> {
  if (ws.readyState === ws.OPEN) {
    return Promise.resolve();
  }
  if (ws.readyState === ws.CLOSING || ws.readyState === ws.CLOSED) {
    return Promise.reject(new Error('WebSocket closed before open'));
  }
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    let timeoutHandle: any = null;
    const cleanup = () => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
      if (timeoutHandle != null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (event: any) => {
      cleanup();
      reject(new Error(event?.message ?? 'WebSocket open failed'));
    };
    const onClose = (event: any) => {
      cleanup();
      const suffix = event?.reason ? `: ${event.reason}` : '';
      reject(new Error(`WebSocket closed before open${suffix}`));
    };
    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timeoutHandle = null;
        cleanup();
        const elapsedMs = Date.now() - started;
        wlog.warn('jmap-transport', `openWebSocket timeout after ${elapsedMs}ms`);
        try {
          ws.close(1000, 'open timeout');
        } catch {
          // The browser may already be tearing down the failed handshake.
        }
        reject(wsRequestTimeoutError('openWebSocket', elapsedMs));
      }, timeoutMs);
    }
  });
}
