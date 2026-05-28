/**
 * Minimal WebSocket stand-in for unit tests. Exposes the
 * EventTarget surface that JmapTransport uses (open/message/close/error
 * via addEventListener) plus _open/_receive/_close test helpers.
 */

type Waiter = { resolve: (ws: FakeWebSocket) => void; reject: (err: any) => void };

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static _waiters: Waiter[] = [];

  static _reset() {
    FakeWebSocket.instances = [];
    // Drop pending waiters silently. Rejecting them would surface as
    // unhandled rejections in the next test even though nothing is
    // actually wrong: the previous test simply opted out of the WS path.
    FakeWebSocket._waiters = [];
  }

  static _waitForInstance(): Promise<FakeWebSocket> {
    const existing = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      FakeWebSocket._waiters.push({ resolve, reject });
    });
  }

  // Static constants per the WebSocket interface.
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  CONNECTING = 0;
  OPEN = 1;
  CLOSING = 2;
  CLOSED = 3;

  url: string;
  protocols: string[];
  readyState: number;
  sent: string[];
  _listeners: Map<string, Set<(event: any) => void>>;

  constructor(url: string, protocols: string | string[]) {
    this.url = url;
    this.protocols = Array.isArray(protocols) ? protocols : [protocols];
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this._listeners = new Map();
    FakeWebSocket.instances.push(this);
    const w = FakeWebSocket._waiters.shift();
    if (w) {
      w.resolve(this);
    }
  }

  addEventListener(type: string, fn: (event: any) => void) {
    if (!this._listeners.has(type)) {
      this._listeners.set(type, new Set());
    }
    this._listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: (event: any) => void) {
    this._listeners.get(type)?.delete(fn);
  }

  _emit(type: string, event: any) {
    const fns = this._listeners.get(type);
    if (!fns) return;
    for (const fn of fns) {
      fn(event);
    }
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close(code = 1000, reason = '') {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this._emit('close', { code, reason });
  }

  // Test helpers -------------------------------------------------------

  _open() {
    this.readyState = FakeWebSocket.OPEN;
    this._emit('open', {});
  }

  _receive(payload: any) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this._emit('message', { data });
  }

  _close(code = 1000, reason = '') {
    this.close(code, reason);
  }

  _error(event: any = {}) {
    this._emit('error', event);
  }
}
