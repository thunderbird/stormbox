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

const JMAP_CORE = 'urn:ietf:params:jmap:core';
const JMAP_MAIL = 'urn:ietf:params:jmap:mail';
const JMAP_SUBMISSION = 'urn:ietf:params:jmap:submission';
const JMAP_CONTACTS = 'urn:ietf:params:jmap:contacts';
const JMAP_WEBSOCKET_CAP = 'urn:ietf:params:jmap:websocket';

export const JMAP_CAPS = Object.freeze({
  CORE: JMAP_CORE,
  MAIL: JMAP_MAIL,
  SUBMISSION: JMAP_SUBMISSION,
  CONTACTS: JMAP_CONTACTS,
  WEBSOCKET: JMAP_WEBSOCKET_CAP,
});

/**
 * @typedef {object} TransportOptions
 * @property {string} sessionUrl       Absolute URL of the JMAP session
 *                                     document (https://host/.well-known/jmap).
 * @property {() => Promise<string>} getAuthHeader
 *                                     Async producer of the value for the
 *                                     Authorization header (Basic/Bearer).
 * @property {typeof fetch} [fetch]    Optional fetch impl. Defaults to globalThis.fetch.
 * @property {typeof WebSocket} [WebSocketImpl]
 *                                     Optional WebSocket constructor. Defaults
 *                                     to globalThis.WebSocket.
 */

export class JmapTransport {
  /** @param {TransportOptions} options */
  constructor(options) {
    this._sessionUrl = options.sessionUrl;
    this._getAuthHeader = options.getAuthHeader;
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
    this._nextWsId = 1;
    this._lastPushState = null;
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
  async request(using, methodCalls, opts = {}) {
    if (!this._session?.apiUrl) {
      await this.fetchSession();
    }
    const auth = await this._getAuthHeader();
    const response = await this._fetch(this._session.apiUrl, {
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
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`JMAP request failed: ${response.status} ${response.statusText}\n${detail}`);
    }
    return response.json();
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
      const ws = new this._WebSocket(wsCap.url, ['jmap']);
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
  wsRequest(using, methodCalls) {
    if (!this._ws || this._ws.readyState !== this._ws.OPEN) {
      return Promise.reject(new Error('WebSocket is not open'));
    }
    const requestId = `r${this._nextWsId}`;
    this._nextWsId += 1;
    return new Promise((resolve, reject) => {
      this._wsPending.set(requestId, { resolve, reject });
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
      return;
    }
    switch (payload['@type']) {
      case 'Response': {
        const pending = this._wsPending.get(payload.requestId);
        if (pending) {
          this._wsPending.delete(payload.requestId);
          pending.resolve(payload);
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

  _onWsClose() {
    for (const pending of this._wsPending.values()) {
      pending.reject(new Error('WebSocket closed mid-request'));
    }
    this._wsPending.clear();
    this._ws = null;
    this._wsReadyPromise = null;
  }

  _onWsError() {
    // Browser WebSocket events surface as opaque error events. The
    // subsequent 'close' event will tear pending requests down.
  }
}

function waitForOpen(ws) {
  if (ws.readyState === ws.OPEN) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      resolve();
    };
    const onError = (event) => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      reject(new Error(event?.message ?? 'WebSocket open failed'));
    };
    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError);
  });
}
