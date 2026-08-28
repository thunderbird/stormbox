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

export const DRAFT_FAULTS = {
  LOSE_CREATE: 'stormbox-lose-draft-create',
  LOSE_CLEANUP: 'stormbox-lose-draft-cleanup',
};

/**
 * Break the read-back after a contact write the server accepted, for the
 * spec that covers a stale cache (CS-4.4).
 *
 * Same shape as the submission faults and for the same reason: the failure
 * has to land on the second leg of a two-leg operation, and the second leg
 * carries nothing to match on. A marked `ContactCard/set` create arms the
 * card id the server reports, and the `ContactCard/get` that asks for that
 * id is answered with a method-level error — so the card genuinely exists
 * while the client genuinely cannot read it back, which is the only state
 * in which the behaviour under test is reachable.
 */
export const CONTACT_CACHE_FAULT = 'stormbox-break-contact-cache';

/**
 * How many read-backs of a marked card the proxy refuses before relenting.
 *
 * Bounded from above by `CONTACT_CACHE_MAX_ATTEMPTS` in
 * `src/sync/backends/jmap/outbox.ts`, which is 3: the repair has to be allowed
 * to succeed on an attempt the row still has. At 2 the parked state survives a
 * retry, which is what makes it observable, and attempt 3 repairs the cache.
 * Raising this to the cap turns the e2e into a test of the give-up path
 * instead, and the two constants live in different trees with nothing but this
 * note between them.
 */
export const CONTACT_CACHE_REFUSALS = 2;

/**
 * The fault modes this build of the injector can apply, reported over
 * STATUS_PATH.
 *
 * The proxy is a long-lived process the suite does not start, so it
 * routinely predates the code a new case needs: Node loads a module once,
 * and an older process forwards a marked frame untouched. That looks
 * exactly like a fault that stopped matching, and costs a poll timeout to
 * diagnose. Naming the modes lets a case say "restart the proxy" instead.
 */
export const KNOWN_FAULT_MODES = Object.freeze([
  'HOLD',
  'LOSE',
  'DROP',
  'CONTACT_CACHE',
  'DRAFT_CREATE',
  'DRAFT_CLEANUP',
]);

/**
 * Build the Response frame for an intercepted Request: one method-level
 * error slot per call id, which is the shape RFC 8620 §3.6.2 specifies
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
 * The `ContactCard/set` creations carrying the contact-cache marker, and
 * the ids a response reports for them. Separate from the Email pair below
 * only because the method name and response shape differ.
 */
function markedCardCreations(frame) {
  const found = [];
  for (const [name, params, callId] of frame.methodCalls ?? []) {
    if (name !== 'ContactCard/set') continue;
    for (const [creationKey, create] of Object.entries(params?.create ?? {})) {
      if (JSON.stringify(create ?? null).includes(CONTACT_CACHE_FAULT)) {
        found.push({ callId, creationKey });
      }
    }
  }
  return found;
}

function createdCardIdsFor(frame, creations) {
  const ids = [];
  for (const [name, payload, callId] of frame.methodResponses ?? []) {
    if (name !== 'ContactCard/set') continue;
    for (const { callId: wantedCall, creationKey } of creations) {
      if (callId !== wantedCall) continue;
      const id = payload?.created?.[creationKey]?.id;
      if (typeof id === 'string') ids.push(id);
    }
  }
  return ids;
}

/** The call ids of `ContactCard/get`s in this frame asking for a given id. */
function cardGetCallsFor(frame, cardIds) {
  const calls = [];
  for (const [name, params, callId] of frame.methodCalls ?? []) {
    if (name !== 'ContactCard/get') continue;
    const asked = Array.isArray(params?.ids) ? params.ids : [];
    const match = asked.find((id) => cardIds.has(id));
    if (match) calls.push({ callId, cardId: match });
  }
  return calls;
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
  /** requestId of a marked card create -> creations awaiting their ids. */
  const pendingCards = new Map();
  const pendingDraftCreates = new Map();
  const brokenDraftCleanup = new Map();
  let cleanupArmed = false;
  /** Card ids whose next read-back is to fail. */
  // cardId -> refusals still to serve. More than one because a single
  // refusal makes the state under test unobservable in practice: the client
  // repairs the cache within milliseconds, so a spec polling for the parked
  // row is racing the repair rather than checking it. Refusing the first
  // retry too holds the row parked across a whole retry interval, and the
  // count still runs out so the repair can be seen to happen.
  const armedCards = new Map();
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

    if (raw.includes(CONTACT_CACHE_FAULT)) {
      const cardCreations = markedCardCreations(frame);
      if (cardCreations.length > 0) {
        pendingCards.set(frame.id, cardCreations);
        return { action: 'forward' };
      }
    }

    if (armedCards.size > 0) {
      const gets = cardGetCallsFor(frame, armedCards);
      if (gets.length > 0) {
        for (const { cardId } of gets) {
          const left = (armedCards.get(cardId) ?? 1) - 1;
          if (left > 0) armedCards.set(cardId, left);
          else armedCards.delete(cardId);
        }
        record('CONTACT_CACHE', gets[0].cardId, 'readBackRefused');
        return {
          action: 'answer',
          kind: 'CONTACT_CACHE',
          response: {
            '@type': 'Response',
            requestId: frame.id,
            methodResponses: frame.methodCalls.map(([, , callId]) => ([
              'error',
              { type: INJECTED_ERROR_TYPE, description: 'contact cache read refused by the e2e proxy' },
              callId,
            ])),
          },
        };
      }
    }

    for (const [mode, marker] of Object.entries(DRAFT_FAULTS)) {
      if (!raw.includes(marker)) continue;
      const creations = markedCreations(frame, marker)
        .filter(({ callId, creationKey }) => {
          const call = frame.methodCalls.find(([, , id]) => id === callId);
          return call?.[1]?.create?.[creationKey]?.keywords?.$draft === true;
        });
      if (creations.length > 0) {
        pendingDraftCreates.set(frame.id, { mode, creations });
        return { action: 'forward', kind: mode };
      }
    }

    if (cleanupArmed) {
      const destroysDraft = frame.methodCalls.some(
        ([name, params]) => name === 'Email/set' && Array.isArray(params?.destroy),
      );
      if (destroysDraft) {
        cleanupArmed = false;
        brokenDraftCleanup.set(frame.id, true);
        return { action: 'forward', kind: 'DRAFT_CLEANUP' };
      }
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

    const cardCreations = pendingCards.get(frame.requestId);
    if (cardCreations != null) {
      pendingCards.delete(frame.requestId);
      for (const id of createdCardIdsFor(frame, cardCreations)) {
        armedCards.set(id, CONTACT_CACHE_REFUSALS);
      }
      return { action: 'forward' };
    }

    const pendingDraft = pendingDraftCreates.get(frame.requestId);
    if (pendingDraft != null) {
      pendingDraftCreates.delete(frame.requestId);
      const [emailId] = createdIdsFor(frame, pendingDraft.creations);
      if (pendingDraft.mode === 'LOSE_CLEANUP' && emailId) {
        cleanupArmed = true;
        return { action: 'forward' };
      }
      if (pendingDraft.mode === 'LOSE_CREATE' && emailId) {
        record('DRAFT_CREATE', emailId, 'responseBlanked');
        return {
          action: 'replace',
          kind: 'DRAFT_CREATE',
          response: { '@type': 'Response', requestId: frame.requestId, methodResponses: [] },
        };
      }
      return { action: 'forward' };
    }

    if (brokenDraftCleanup.has(frame.requestId)) {
      brokenDraftCleanup.delete(frame.requestId);
      record('DRAFT_CLEANUP', 'predecessor', 'responseBlanked');
      return {
        action: 'replace',
        kind: 'DRAFT_CLEANUP',
        response: { '@type': 'Response', requestId: frame.requestId, methodResponses: [] },
      };
    }

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
