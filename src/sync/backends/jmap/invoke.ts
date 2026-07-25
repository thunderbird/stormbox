/**
 * Shared JMAP invocation helpers. The per-feature sync modules
 * (mailboxes, messages, bodies, identities, contacts, quota, outbox)
 * all need the same two operations:
 *
 *   callJmap()      Dispatch a method-call envelope over the WebSocket
 *                   if it is open, or fall back to HTTP. This is the
 *                   single place that decides which transport leg to
 *                   use, so a future change (e.g. retries, timeouts,
 *                   capability checks) lands in one file.
 *
 *   pickResponse()  Pull the response payload for a given method name
 *                   out of a JMAP { methodResponses } envelope. The
 *                   server returns method responses as positional
 *                   `[name, args, id]` tuples; almost every caller
 *                   wants the args of the first tuple matching a
 *                   method name.
 *
 *   requireResponse() The same lookup for a call whose payload the
 *                   caller cannot proceed without. A rejected call
 *                   answers with an `["error", args, id]` tuple
 *                   (RFC 8620 §3.1.2) instead of the method's own
 *                   tuple, so defaulting the absent payload away makes
 *                   a rejection indistinguishable from a successful
 *                   empty result. Throwing keeps a rejected call from
 *                   being read as "the server has no data".
 *
 *   pickResponseById()  Same, but keyed on the method call id as well.
 *                   Needed whenever one envelope can contain two
 *                   responses for the same method name. Send is the
 *                   case that matters: RFC 8621 §7.5 has
 *                   onSuccessUpdateEmail generate a second, implicit
 *                   Email/set response tagged with the
 *                   EmailSubmission/set call id, so pickResponse()
 *                   would always return the explicit create and never
 *                   the implicit update.
 */

export async function callJmap(transport, { using, methodCalls, useWebSocket }) {
  if (useWebSocket) {
    return transport.wsRequest(using, methodCalls);
  }
  return transport.request(using, methodCalls);
}

/**
 * An envelope that is not shaped like one has no response to pick, which
 * is the same answer callers already handle for a method the server did
 * not report. Throwing instead would surface a malformed frame as a
 * failure of whatever operation happened to be reading it.
 */
function methodResponsesOf(result) {
  const responses = result?.methodResponses;
  return Array.isArray(responses) ? responses : [];
}

export function pickResponse(result, methodName) {
  const found = methodResponsesOf(result).find((r) => r?.[0] === methodName);
  return found?.[1] ?? null;
}

export function requireResponse(result, methodName) {
  const payload = pickResponse(result, methodName);
  if (payload != null) return payload;
  const failure = pickResponse(result, 'error');
  const detail = failure?.type
    ? `${failure.type}${failure.description ? `: ${failure.description}` : ''}`
    : 'noResponse';
  throw new Error(`JMAP ${methodName} returned no payload (${detail})`);
}

export function pickResponseById(result, methodName, callId) {
  const found = methodResponsesOf(result)
    .find((r) => r?.[0] === methodName && r?.[2] === callId);
  return found?.[1] ?? null;
}
