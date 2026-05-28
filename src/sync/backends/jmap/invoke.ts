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
 */

export async function callJmap(transport, { using, methodCalls, useWebSocket }) {
  if (useWebSocket) {
    return transport.wsRequest(using, methodCalls);
  }
  return transport.request(using, methodCalls);
}

export function pickResponse(result, methodName) {
  const responses = result?.methodResponses ?? [];
  const found = responses.find((r) => r[0] === methodName);
  return found?.[1] ?? null;
}
