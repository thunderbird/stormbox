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
const JMAP_WEBSOCKET_CAP = 'urn:ietf:params:jmap:websocket';

export const JMAP_CAPS = Object.freeze({
  CORE: JMAP_CORE,
  MAIL: JMAP_MAIL,
  SUBMISSION: JMAP_SUBMISSION,
  CONTACTS: JMAP_CONTACTS,
  QUOTA: JMAP_QUOTA,
  WEBSOCKET: JMAP_WEBSOCKET_CAP,
});

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
 */

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
    // Per-wsRequest timeout. Without this a server that holds the
    // TCP connection open but never sends a Response leaves the
    // pending entry — and the awaiting caller — hung indefinitely
    // (browser TCP keepalives can take minutes). 30s is a generous
    // upper bound: typical Email/get + Email/query round trips
    // finish in well under a second, and the slow paths (large
    // folder indexer chunks against a contended Stalwart) finish
    // in a few seconds.
    this._wsRequestTimeoutMs = options.wsRequestTimeoutMs ?? 30_000;
  }

  /**
   * Fetch and cache the session document. Subsequent calls return the
   * cached value unless force=true.
   */
  async fetchSession({ force = false } = {}) {
    if (this._session && !force) {
      return this._session;
    }
    const auth = await this._getAuthHeader();
    const response = await this._fetch(this._sessionUrl, {
      headers: {
        Authorization: auth,
        Accept: 'application/json',
      },
      mode: 'cors',
      credentials: 'omit',
    });
    if (!response.ok) {
      throw new Error(`JMAP session fetch failed: ${response.status} ${response.statusText}`);
    }
    this._session = await response.json();
    return this._session;
  }

  get session() {
    return this._session;
  }

  /**
   * Issue a JMAP method-call request over HTTP. Returns the
   * { methodResponses } object the server returned.
   *
   * @param {string[]} using
   * @param {Array<[string, object, string]>} methodCalls
   * @param {{ signal?: AbortSignal }} [opts]
   */
  async request(using: string[], methodCalls: any[], opts: { signal?: AbortSignal } = {}) {
    if (!this._session?.apiUrl) {
      await this.fetchSession();
    }
    const auth = await this._getAuthHeader();
    const summary = methodCalls.map(([name, params]) =>
      `${name}(${params?.position != null ? `pos=${params.position}` : ''}${params?.limit != null ? ` lim=${params.limit}` : ''})`,
    ).join(' + ');
    wlog.info('jmap-transport', `httpRequest ${summary}`);
    let response;
    try {
      response = await this._fetch(this._session.apiUrl, {
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
      });
    } catch (err) {
      wlog.warn('jmap-transport', `httpRequest fetch threw: ${err?.message}`);
      throw err;
    }
    wlog.info('jmap-transport', `httpResponse ${summary} status=${response.status}`);
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`JMAP request failed: ${response.status} ${response.statusText}\n${detail}`);
    }
    return response.json();
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
  async upload({ accountId, type, body }: { accountId: string; type: string; body: any }) {
    if (!this._session?.uploadUrl) {
      await this.fetchSession();
    }
    const template = this._session?.uploadUrl;
    if (!template) {
      throw new Error('JMAP session does not advertise an uploadUrl');
    }
    const url = template.replace('{accountId}', encodeURIComponent(accountId));
    const auth = await this._getAuthHeader();
    wlog.info('jmap-transport', `upload ${type} -> ${accountId}`);
    const response = await this._fetch(url, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': type || 'application/octet-stream',
        Accept: 'application/json',
      },
      mode: 'cors',
      credentials: 'omit',
      body,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`JMAP upload failed: ${response.status} ${response.statusText}\n${detail}`);
    }
    return response.json();
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
   * @returns {Promise<Uint8Array>}
   */
  async download({ accountId, blobId, type = 'application/octet-stream', name = 'blob' }:
  { accountId: string; blobId: string; type?: string; name?: string }) {
    if (!this._session?.downloadUrl) {
      await this.fetchSession();
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
    const response = await this._fetch(url, {
      headers: { Authorization: auth },
      mode: 'cors',
      credentials: 'omit',
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`JMAP download failed: ${response.status} ${response.statusText}\n${detail}`);
    }
    return new Uint8Array(await response.arrayBuffer());
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
      wlog.info('jmap-transport', `openWebSocket via ${wsUrl.host}${wsUrl.pathname}`);
      const ws = new this._WebSocket(wsUrl.toString(), ['jmap']);
      this._ws = ws;
      await waitForOpen(ws);
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
            const err: any = new Error(
              `JMAP WebSocket request ${requestId} timed out after ${elapsedMs}ms`,
            );
            err.type = 'wsRequestTimeout';
            err.requestId = requestId;
            err.elapsedMs = elapsedMs;
            reject(err);
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
          pending.reject(new Error(payload.detail || payload.type || 'JMAP RequestError'));
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

function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === ws.OPEN) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      resolve();
    };
    const onError = (event: any) => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      reject(new Error(event?.message ?? 'WebSocket open failed'));
    };
    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError);
  });
}
