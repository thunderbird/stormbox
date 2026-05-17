/**
 * Minimal WebSocket stand-in for unit tests. Exposes the
 * EventTarget surface that JmapTransport uses (open/message/close/error
 * via addEventListener) plus _open/_receive/_close test helpers.
 */

export class FakeWebSocket {
  static instances = [];
  static _waiters = [];

  static _reset() {
    FakeWebSocket.instances = [];
    FakeWebSocket._waiters.forEach((w) => w.reject(new Error('reset')));
    FakeWebSocket._waiters = [];
  }

  static _waitForInstance() {
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

  constructor(url, protocols) {
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

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) {
      this._listeners.set(type, new Set());
    }
    this._listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }

  _emit(type, event) {
    const fns = this._listeners.get(type);
    if (!fns) return;
    for (const fn of fns) {
      fn(event);
    }
  }

  send(payload) {
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

  _receive(payload) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this._emit('message', { data });
  }

  _close(code = 1000, reason = '') {
    this.close(code, reason);
  }

  _error(event = {}) {
    this._emit('error', event);
  }
}
