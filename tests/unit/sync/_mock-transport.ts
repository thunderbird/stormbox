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
  _session: any;
  _handlers: Map<string, (params: any, callId?: string) => any>;
  requests: Array<{ using: any; methodCalls: any }>;
  uploads: Array<{ accountId: string; type: string; body: any }>;
  _uploadHandler: ((args: { accountId: string; type: string; body: any }) => any) | null;

  constructor(session: any = null) {
    this._session = session ?? {
      capabilities: {
        'urn:ietf:params:jmap:core': {
          maxObjectsInGet: 500,
          maxObjectsInSet: 500,
        },
      },
    };
    this._handlers = new Map();
    this._handlers.set('Mailbox/get', (params) => ({
      list: (params.ids ?? []).map((id) => ({
        id,
        name: id,
        totalEmails: 0,
        unreadEmails: 0,
        totalThreads: 0,
        unreadThreads: 0,
      })),
      state: 'mock-mailbox-state',
    }));
    this.requests = [];
    this.uploads = [];
    this._uploadHandler = null;
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
  handle(methodName: string, fn: (params: any, callId?: string) => any) {
    this._handlers.set(methodName, fn);
  }

  /**
   * Override the blob upload behaviour. Without an override, upload()
   * records the call and returns a synthetic blobId. Throw to simulate
   * an upload failure.
   */
  handleUpload(fn: (args: { accountId: string; type: string; body: any }) => any) {
    this._uploadHandler = fn;
  }

  async upload({ accountId, type, body }: { accountId: string; type: string; body: any }) {
    this.uploads.push({ accountId, type, body });
    if (this._uploadHandler) {
      return this._uploadHandler({ accountId, type, body });
    }
    return {
      accountId,
      blobId: `blob-${this.uploads.length}`,
      type,
      size: body?.length ?? body?.byteLength ?? 0,
    };
  }

  async request(using: any, methodCalls: any) {
    return this._dispatch(using, methodCalls);
  }

  async wsRequest(using: any, methodCalls: any) {
    return this._dispatch(using, methodCalls);
  }

  async _dispatch(using: any, methodCalls: any[]): Promise<{ methodResponses: any[] }> {
    this.requests.push({ using, methodCalls });
    const responses: any[] = [];
    const byCallId = new Map<string, any[]>();
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
export function resolveResultRefs(value: any, byCallId: Map<string, any[]>): any {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => resolveResultRefs(v, byCallId));
  const out: Record<string, any> = {};
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

function isResultRef(v: any): v is { resultOf: string; name: string; path: string } {
  return !!v
    && typeof v === 'object'
    && typeof v.resultOf === 'string'
    && typeof v.name === 'string'
    && typeof v.path === 'string';
}

function resolveJsonPointer(root: any, pointer: string): any {
  if (pointer === '' || pointer === '/') return root;
  if (!pointer.startsWith('/')) {
    throw new Error(`Invalid JSON pointer: ${pointer}`);
  }
  const parts = pointer.slice(1).split('/').map((s) =>
    s.replace(/~1/g, '/').replace(/~0/g, '~'),
  );
  return walk(root, parts);
  function walk(value: any, remaining: string[]): any {
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
