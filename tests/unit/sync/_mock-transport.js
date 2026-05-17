/**
 * Minimal JmapTransport stand-in for sync engine tests. The sync code
 * only calls .request() and .wsRequest() on the transport, so we route
 * both through a single dispatch table the test sets up:
 *
 *   const t = new MockTransport();
 *   t.handle('Mailbox/get', (params) => ({ list: [...], state: 'a' }));
 *   await syncMailboxes({ transport: t, ... });
 */

export class MockTransport {
  constructor(session = null) {
    this._session = session;
    this._handlers = new Map();
    this.requests = [];
  }

  set session(s) {
    this._session = s;
  }

  get session() {
    return this._session;
  }

  /**
   * Register a handler for a JMAP method name. Receives the params object
   * from the method call and returns the response payload (the second
   * tuple element). Throw to surface an error to the caller.
   */
  handle(methodName, fn) {
    this._handlers.set(methodName, fn);
  }

  async request(using, methodCalls) {
    return this._dispatch(using, methodCalls);
  }

  async wsRequest(using, methodCalls) {
    return this._dispatch(using, methodCalls);
  }

  async _dispatch(using, methodCalls) {
    this.requests.push({ using, methodCalls });
    const responses = [];
    for (const [methodName, params, callId] of methodCalls) {
      const handler = this._handlers.get(methodName);
      if (!handler) {
        throw new Error(`MockTransport has no handler for ${methodName}`);
      }
      const payload = await handler(params, callId);
      responses.push([methodName, payload, callId]);
    }
    return { methodResponses: responses };
  }
}
