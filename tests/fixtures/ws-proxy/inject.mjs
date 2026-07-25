/**
 * Method-level JMAP error injection for the e2e WebSocket proxy.
 *
 * There is no other interception point for this. The transport that
 * issues JMAP requests lives in a SharedWorker, whose network traffic
 * Playwright's page and context routing cannot reach, and the transport
 * prefers the WebSocket whenever one is open. Sitting in the middle of
 * that socket is what is left.
 *
 * A client Request frame containing INJECT_MARKER is answered from the
 * proxy instead of being forwarded, so the server genuinely never
 * performs the operation — which is what distinguishes an injected
 * method-level error from a rewritten response. The marker rides in test
 * data (a subject line), so only the spec that asks for it is affected.
 *
 * Kept separate from server.mjs so unit tests can exercise the matcher
 * without the module's side effect of binding a port.
 */

export const INJECT_MARKER = 'stormbox-inject-method-error';
export const INJECTED_ERROR_TYPE = 'invalidArguments';

/** Where the proxy reports the faults it has applied. */
export const FAULTS_PATH = '/__applied-faults';

/**
 * Where the proxy reports whether the app is talking to it at all.
 *
 * Only WebSocket frames pass through here, and the client falls back to
 * HTTP whenever its socket is not open — a reload or a stopped account
 * leaves exactly that state. An HTTP request bypasses the proxy entirely,
 * so a fault aimed at it silently does not apply and the operation simply
 * succeeds, which is indistinguishable from a bug in the case under test.
 */
export const STATUS_PATH = '/__status';

/**
 * Ways to break the submission leg of one send, for the specs that cover
 * an interrupted send (CS-1.8, CS-1.9, CS-5.5).
 *
 * These cannot be matched the way INJECT_MARKER is. The marker rides in
 * the subject, which reaches the proxy inside the send's `Email/set`
 * create; the `EmailSubmission/set` that follows it is a separate request
 * carrying nothing but an identity id and an Email id. So a marked create
 * arms the mode against the Email id the server reports creating, and the
 * submission that references that id is the one broken.
 *
 * The three modes differ in what the *server* ends up doing, which is the
 * whole point: the client's view is identically ambiguous in all three,
 * and only the server's state distinguishes a message that went out from
 * one that did not.
 */
export const SUBMISSION_FAULTS = {
  /** Forward the submission, never answer the client. Models a worker
   *  that dies with the round trip still open. */
  HOLD: 'stormbox-hold-submission',
  /** Forward the submission, then answer without its response slot.
   *  Models a lost response for a message that really was submitted. */
  LOSE: 'stormbox-lose-submission',
  /** Answer without the response slot and never forward. Models a
   *  genuinely ambiguous outcome: nothing was submitted. */
  DROP: 'stormbox-drop-submission',
};

/**
 * Build the Response frame for an intercepted Request: one method-level
 * error slot per call id, which is the shape RFC 8620 §3.6.1 specifies
 * for a method the server could not run.
 *
 * Returns null when the frame is not an interception target, so the
 * caller forwards it untouched.
 *
 * @param {string} raw  The text frame as received from the client.
 */
export function injectedResponseFor(raw) {
  if (typeof raw !== 'string' || !raw.includes(INJECT_MARKER)) return null;
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    return null;
  }
  if (frame?.['@type'] !== 'Request' || !Array.isArray(frame.methodCalls)) return null;
  return {
    '@type': 'Response',
    requestId: frame.id,
    methodResponses: frame.methodCalls.map(([, , callId]) => ([
      'error',
      {
        type: INJECTED_ERROR_TYPE,
        description: `injected by the e2e ws-proxy via ${INJECT_MARKER}`,
      },
      callId,
    ])),
  };
}

function parseFrame(raw) {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function findFault(raw) {
  for (const mode of Object.keys(SUBMISSION_FAULTS)) {
    if (raw.includes(SUBMISSION_FAULTS[mode])) return mode;
  }
  return null;
}

/** Every Email id the submission calls in this frame reference. */
function submittedEmailIds(frame) {
  const ids = [];
  for (const [name, params] of frame.methodCalls ?? []) {
    if (name !== 'EmailSubmission/set') continue;
    for (const create of Object.values(params?.create ?? {})) {
      if (typeof create?.emailId === 'string') ids.push(create.emailId);
    }
  }
  return ids;
}

/**
 * The `Email/set` creations in this request that actually carry the
 * marker, as { callId, creationKey } pairs.
 *
 * Matching the whole frame would be enough to know a fault was asked for,
 * but not which message it belongs to: a frame can carry more than one
 * create, and arming an unmarked one would break a send no spec asked
 * about. So the marker has to be found inside a specific create.
 */
function markedCreations(frame, marker) {
  const found = [];
  for (const [name, params, callId] of frame.methodCalls ?? []) {
    if (name !== 'Email/set') continue;
    for (const [creationKey, create] of Object.entries(params?.create ?? {})) {
      if (JSON.stringify(create ?? null).includes(marker)) {
        found.push({ callId, creationKey });
      }
    }
  }
  return found;
}

/** The Email ids a response reports creating for the given creations. */
function createdIdsFor(frame, creations) {
  const ids = [];
  for (const [name, payload, callId] of frame.methodResponses ?? []) {
    if (name !== 'Email/set') continue;
    for (const { callId: wantedCall, creationKey } of creations) {
      if (callId !== wantedCall) continue;
      const id = payload?.created?.[creationKey]?.id;
      if (typeof id === 'string') ids.push(id);
    }
  }
  return ids;
}

/**
 * Per-connection state machine for the submission faults above.
 *
 * Both directions of one client socket run through it: `onClientFrame`
 * decides what to do with a frame heading upstream, `onServerFrame` what
 * to do with the answer coming back. Each returns an action:
 *
 *   { action: 'forward' }             pass the frame along unchanged
 *   { action: 'answer', response }    reply to the client, do not forward
 *   { action: 'drop' }                swallow the frame entirely
 *   { action: 'replace', response }   pass this instead
 *
 * State is per connection because the arming is: a send's create and its
 * submission always travel the same socket.
 */
export function createInjector({ applied = [] } = {}) {
  /** requestId of a marked create -> { mode, creations } awaiting ids. */
  const pendingCreates = new Map();
  /** Email id -> fault mode, armed until its submission is seen. */
  const armed = new Map();
  /** requestId of a broken submission -> { mode, emailId } for its answer. */
  const broken = new Map();
  // `applied` records what was actually done to whom, in order. A spec
  // asserting on the server's state cannot otherwise tell an injected
  // fault from a send that simply worked: every assertion in a fault test
  // would hold just as well if the injection had silently stopped
  // matching. The caller can pass one array shared across connections.

  function record(mode, emailId, effect) {
    applied.push({ mode, emailId, effect, at: Date.now() });
  }

  function onClientFrame(raw) {
    const injected = injectedResponseFor(raw);
    if (injected) return { action: 'answer', response: injected, kind: INJECTED_ERROR_TYPE };
    const frame = parseFrame(raw);
    if (frame?.['@type'] !== 'Request' || !Array.isArray(frame.methodCalls)) {
      return { action: 'forward' };
    }

    const mode = findFault(raw);
    if (mode) {
      const creations = markedCreations(frame, SUBMISSION_FAULTS[mode]);
      if (creations.length > 0) {
        pendingCreates.set(frame.id, { mode, creations });
        return { action: 'forward' };
      }
    }

    for (const emailId of submittedEmailIds(frame)) {
      const armedMode = armed.get(emailId);
      if (!armedMode) continue;
      // One-shot: a retry of this send must reach the server normally, or
      // the spec could not observe what recovery does next.
      armed.delete(emailId);
      if (armedMode === 'DROP') {
        record(armedMode, emailId, 'notForwarded');
        return {
          action: 'answer',
          kind: armedMode,
          response: { '@type': 'Response', requestId: frame.id, methodResponses: [] },
        };
      }
      broken.set(frame.id, { mode: armedMode, emailId });
      return { action: 'forward', kind: armedMode };
    }
    return { action: 'forward' };
  }

  function onServerFrame(raw) {
    const frame = parseFrame(raw);
    if (frame?.['@type'] !== 'Response') return { action: 'forward' };

    const pending = pendingCreates.get(frame.requestId);
    if (pending != null) {
      // Answered, so the correlation is spent either way: a response that
      // reports no created id (a method-level error, a rejected create)
      // leaves nothing to arm.
      pendingCreates.delete(frame.requestId);
      for (const id of createdIdsFor(frame, pending.creations)) {
        armed.set(id, pending.mode);
      }
      return { action: 'forward' };
    }

    const brokenSubmission = broken.get(frame.requestId);
    if (brokenSubmission == null) return { action: 'forward' };
    const { mode, emailId } = brokenSubmission;
    broken.delete(frame.requestId);
    if (mode === 'HOLD') {
      record(mode, emailId, 'responseWithheld');
      return { action: 'drop', kind: mode };
    }
    record(mode, emailId, 'responseBlanked');
    return {
      action: 'replace',
      kind: mode,
      response: { '@type': 'Response', requestId: frame.requestId, methodResponses: [] },
    };
  }

  return { onClientFrame, onServerFrame, applied };
}
