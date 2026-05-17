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
    const byCallId = new Map();
    for (const [methodName, rawParams, callId] of methodCalls) {
      const handler = this._handlers.get(methodName);
      if (!handler) {
        throw new Error(`MockTransport has no handler for ${methodName}`);
      }
      const params = resolveResultRefs(rawParams, byCallId);
      const payload = await handler(params, callId);
      const tuple = [methodName, payload, callId];
      responses.push(tuple);
      byCallId.set(callId, tuple);
    }
    return { methodResponses: responses };
  }
}

/**
 * RFC 8620 §3.1.3 result references. Method-call args may contain
 * "#name": { resultOf, name, path } objects; the server resolves them
 * before dispatching the call. We replicate that here so unit tests can
 * exercise chained Email/query -> Email/get sequences without needing a
 * real Stalwart.
 */
export function resolveResultRefs(value, byCallId) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => resolveResultRefs(v, byCallId));
  const out = {};
  for (const key of Object.keys(value)) {
    if (key.startsWith('#') && isResultRef(value[key])) {
      const resolvedKey = key.slice(1);
      const ref = value[key];
      const tuple = byCallId.get(ref.resultOf);
      if (!tuple) {
        throw new Error(`MockTransport: unknown resultOf '${ref.resultOf}'`);
      }
      if (tuple[0] !== ref.name) {
        throw new Error(`MockTransport: resultOf method mismatch (expected ${ref.name}, got ${tuple[0]})`);
      }
      out[resolvedKey] = resolveJsonPointer(tuple[1], ref.path);
    } else {
      out[key] = resolveResultRefs(value[key], byCallId);
    }
  }
  return out;
}

function isResultRef(v) {
  return !!v
    && typeof v === 'object'
    && typeof v.resultOf === 'string'
    && typeof v.name === 'string'
    && typeof v.path === 'string';
}

function resolveJsonPointer(root, pointer) {
  if (pointer === '' || pointer === '/') return root;
  if (!pointer.startsWith('/')) {
    throw new Error(`Invalid JSON pointer: ${pointer}`);
  }
  const parts = pointer.slice(1).split('/').map((s) =>
    s.replace(/~1/g, '/').replace(/~0/g, '~'),
  );
  return walk(root, parts);
  function walk(value, remaining) {
    if (remaining.length === 0) return value;
    if (value == null) return [];
    const [head, ...rest] = remaining;
    if (head === '*') {
      if (!Array.isArray(value)) return [];
      return value.map((el) => walk(el, rest));
    }
    if (Array.isArray(value)) {
      return walk(value[Number(head)], rest);
    }
    return walk(value?.[head], rest);
  }
}
