/**
 * Minimal JmapTransport stand-in for sync engine tests. The sync code
 * only calls .request() and .wsRequest() on the transport, so we route
 * both through a single dispatch table the test sets up:
 *
 *   const t = new MockTransport();
 *   t.handle('Mailbox/get', (params) => ({ list: [...], state: 'a' }));
 *   await syncMailboxes({ transport: t, ... });
 */

import { JMAP_CAPS } from '../../../src/sync/backends/jmap/transport';

/** Core limits every mock session advertises unless a test narrows them. */
export const MOCK_CORE_CAPABILITIES = Object.freeze({
  maxObjectsInGet: 500,
  maxObjectsInSet: 500,
  maxSizeUpload: 50_000_000,
});

export interface MockSessionOptions {
  /** Merged over MOCK_CORE_CAPABILITIES. */
  core?: Record<string, unknown>;
  /** Extra server capabilities keyed by URN; jmap:core is always present. */
  capabilities?: Record<string, unknown>;
  /** Per-account capabilities keyed by remote account id. */
  accounts?: Record<string, { accountCapabilities: Record<string, unknown> }>;
}

/** JMAP Session object with the default core limits plus the given extras. */
export function mockSession({
  core = {},
  capabilities = {},
  accounts,
}: MockSessionOptions = {}) {
  return {
    capabilities: {
      [JMAP_CAPS.CORE]: { ...MOCK_CORE_CAPABILITIES, ...core },
      ...capabilities,
    },
    ...(accounts ? { accounts } : {}),
  };
}

export class MockTransport {
  _session: any;
  _handlers: Map<string, (params: any, callId?: string) => any>;
  _errors: Map<string, any>;
  requests: Array<{ using: any; methodCalls: any }>;
  uploads: Array<{ accountId: string; type: string; body: any }>;
  _uploadHandler: ((args: { accountId: string; type: string; body: any }) => any) | null;

  constructor(session: any = null) {
    this._session = session ?? mockSession();
    this._handlers = new Map();
    this._errors = new Map();
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
   * Answer a method with a JMAP `["error", args, id]` tuple (RFC 8620
   * §3.1.2) instead of its own response tuple — what a server sends
   * when it rejects the call but the request itself succeeded. Pass the
   * error args, or a function of the call params returning args (null
   * to answer that call normally). A later call whose back reference
   * points at a rejected call answers invalidResultReference, as a
   * server does.
   */
  handleError(methodName: string, error: any) {
    this._errors.set(methodName, error);
  }

  clearError(methodName: string) {
    this._errors.delete(methodName);
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

  /** Teardown surface JmapBackend.stop() calls. Nothing here holds a
   *  socket or an in-flight fetch, so both are no-ops. */
  abort() {}

  closeWebSocket() {}

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
      const tuple = await this._respond(methodName, rawParams, callId, byCallId);
      responses.push(tuple);
      byCallId.set(callId, tuple);
    }
    return { methodResponses: responses };
  }

  async _respond(methodName: string, rawParams: any, callId: string, byCallId: Map<string, any[]>) {
    let params;
    try {
      params = resolveResultRefs(rawParams, byCallId);
    } catch (err) {
      // A back reference into a rejected call cannot resolve, so the
      // server rejects this call too (RFC 8620 §3.1.3). Scaffolding
      // mistakes still throw.
      if (!(err instanceof ResultReferenceError)) throw err;
      return ['error', { type: 'invalidResultReference' }, callId];
    }
    const error = this._errors.get(methodName);
    const errorArgs = typeof error === 'function' ? error(params) : error;
    if (errorArgs) {
      return ['error', errorArgs, callId];
    }
    const handler = this._handlers.get(methodName);
    if (!handler) {
      throw new Error(`MockTransport has no handler for ${methodName}`);
    }
    const payload = await handler(params, callId);
    assertAnswerable(methodName, payload);
    return [methodName, payload, callId];
  }
}

/** A result reference that cannot resolve because its target was rejected. */
export class ResultReferenceError extends Error {}

/**
 * Refuse to answer in a way no server would.
 *
 * A query answers with `queryState` and a get with `state`, and RFC 8620
 * §5.2 and §5.5 are explicit that these are different tokens: only the
 * object state can be handed to `changes`. A stand-in that returns `state`
 * from a query lets code read a field the real server never sends, and the
 * test then proves the opposite of the truth — that is exactly how contact
 * delta sync came to be dead in production while its tests passed.
 */
function assertAnswerable(methodName: string, payload: any): void {
  if (payload === null || typeof payload !== 'object') return;
  const [, verb] = methodName.split('/');
  if (verb === 'query' && 'state' in payload) {
    throw new Error(
      `MockTransport: ${methodName} answered with 'state'. A query answers with `
      + "'queryState' (RFC 8620 §5.5); only a get answers with 'state'.",
    );
  }
  if ((verb === 'get' || verb === 'changes') && 'queryState' in payload) {
    throw new Error(
      `MockTransport: ${methodName} answered with 'queryState'. That token belongs `
      + "to a query; a get answers with 'state' (RFC 8620 §5.2).",
    );
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
      if (tuple[0] === 'error') {
        throw new ResultReferenceError(
          `MockTransport: '${ref.resultOf}' answered an error tuple`,
        );
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
