import { classifyAuthenticationOrAuthorizationError } from '../transport';

const RETRYABLE_FOLDER_ERROR_TYPES = new Set([
  'transport',
  'serverUnavailable',
  'serverFail',
  'serverPartialFail',
  'noResponse',
  'stateMismatch',
]);
const SET_ERROR_WRAPPERS = new Set(['notCreated', 'notUpdated', 'notDestroyed']);
// Sending is the one mutation where a wrong retry decision can deliver a
// second copy of a message, so the classification is an allowlist rather
// than a denylist: only these rejections are retried, and every other
// one (including a type this client has never seen) is terminal.
//
// The list is this short on purpose. None of the SetError types RFC 8621
// §7.5 defines for EmailSubmission/set is transient — invalidEmail,
// noRecipients, tooManyRecipients, forbiddenFrom, forbiddenMailFrom and
// forbiddenToSend all describe a message or account that will be
// rejected again. `overQuota` needs the user to free space, not a
// 60-second backoff. That leaves rate limiting, where waiting is exactly
// the right response. Note serverFail / serverPartialFail /
// serverUnavailable are method-level errors under RFC 8620 §3.6.2 rather
// than SetError values, and RFC 8620 explicitly says a serverFail retry
// is expected to fail again while serverPartialFail requires
// resynchronisation, so neither belongs here.
const RETRYABLE_SUBMISSION_ERROR_TYPES = new Set(['rateLimit']);
// The same allowlist reasoning applied to method-level errors
// (RFC 8620 §3.6.2) on a send. Retrying the create phase is safe — the
// operation's Message-ID makes an already-created Email findable, so a
// replay cannot orphan a second draft — but it is not free: the runner
// spends up to eight attempts across roughly two minutes of backoff
// while compose-store waits for a terminal outcome to leave its sending
// state. Only a type where waiting is the right response earns that.
const RETRYABLE_METHOD_ERROR_TYPES = new Set(['serverUnavailable', 'rateLimit']);
const RETRYABLE_DRAFT_ERROR_TYPES = new Set([
  'noResponse',
  'rateLimit',
  'serverFail',
  'serverPartialFail',
  'serverUnavailable',
]);
const TERMINAL_MESSAGE_ERROR_TYPES = new Set([
  'unknownMessage',
  'unknownFolder',
  'unknownAccount',
  'invalidCopyDestination',
  'mixedDestinationAccounts',
  'sameAccountCopy',
  'crossAccountMove',
  'forbidden',
  'notFound',
  'invalidArguments',
  'invalidProperties',
  'overQuota',
  'tooManyObjectsInSet',
  'requestTooLarge',
  'copyReconcileFailed',
  'copyViewReconcileFailed',
  'copyCounterReconcileFailed',
]);
function transportFolderError(error: any) {
  return {
    type: 'transport',
    message: error?.message ?? String(error),
  };
}

function isTerminalPerObjectFolderError(error: any): boolean {
  if (!SET_ERROR_WRAPPERS.has(error?.type)) return false;
  const authentication = classifyAuthenticationOrAuthorizationError(error?.detail);
  if (authentication) return authentication.terminal;
  const detailType = error?.detail?.type;
  return !RETRYABLE_FOLDER_ERROR_TYPES.has(detailType);
}
function isRetryableMessageError(failure: any): boolean {
  const authentication = classifyAuthenticationOrAuthorizationError(failure);
  if (authentication) return authentication.retryable;
  const type = failure?.type;
  const detailType = failure?.detail?.type;
  if (
    RETRYABLE_FOLDER_ERROR_TYPES.has(type)
    || RETRYABLE_FOLDER_ERROR_TYPES.has(detailType)
  ) {
    return true;
  }
  if (SET_ERROR_WRAPPERS.has(type)) return false;
  if (TERMINAL_MESSAGE_ERROR_TYPES.has(type)) return false;
  // Unknown method/transport failures default to retryable. Only explicit
  // policy and per-object outcomes are safe to classify as terminal.
  return true;
}
function isRetryableSubmissionError(detail: any): boolean {
  const detailType = detail?.type;
  return typeof detailType === 'string'
    && RETRYABLE_SUBMISSION_ERROR_TYPES.has(detailType);
}
function isRetryableMethodError(error: any): boolean {
  const authentication = classifyAuthenticationOrAuthorizationError(error);
  if (authentication) return authentication.retryable;
  return error?.type === 'noResponse'
    || RETRYABLE_METHOD_ERROR_TYPES.has(error?.type);
}
function isRetryableDraftError(error: any): boolean {
  const authentication = classifyAuthenticationOrAuthorizationError(error);
  if (authentication) return authentication.retryable;
  return RETRYABLE_DRAFT_ERROR_TYPES.has(error?.type);
}
/**
 * Shape a send rejection for the outbox runner. Only the transient
 * server-side types are left retryable; anything else is flagged
 * terminal so the runner stops instead of re-running create-and-submit,
 * which would orphan one draft per attempt and risk a second delivery.
 */
function submissionError(type: string, detail: any) {
  const retryable = isRetryableSubmissionError(detail);
  return {
    type,
    detail,
    ...(retryable ? {} : { terminal: true as const }),
  };
}
/**
 * Build a typed error result for the case where Email/set did not
 * return its expected response slot. Most commonly this is a JMAP
 * method-level error (RFC 8620 §3.6.2) returned in the "error" slot
 * of methodResponses, e.g. requestTooLarge, limit, serverFail. We
 * surface the server-reported type so the user gets actionable text
 * ("Could not move message (requestTooLarge).") instead of the
 * useless local fallback "noResponse" we used to emit.
 *
 * `hint.count` is included on requestTooLarge / limit so the store
 * can suggest a smaller batch in the toast if it ever wants to.
 */
/**
 * Same as extractMethodError, but only accepts the error slot belonging
 * to one method call id. A send envelope carries two calls, so the
 * name-blind version can attribute Email/set's error to the submission
 * or the reverse, which sends the user a misleading reason.
 *
 * A reported type is classified for retryability here; an absent slot is
 * left retryable, because "no response for this call" says nothing about
 * the request and the create phase is safe to repeat.
 */
function extractMethodErrorById(raw: any, callId: string) {
  const responses = raw?.methodResponses ?? [];
  const errorSlot = responses.find((r: any) => r?.[0] === 'error' && r?.[2] === callId);
  if (!errorSlot) return { type: 'noResponse' };
  const detail = errorSlot[1] ?? {};
  const type = detail.type ?? 'methodError';
  return {
    type,
    description: detail.description,
    detail,
    ...(isRetryableMethodError({ type }) ? {} : { terminal: true as const }),
  };
}

function extractMethodError(raw: any, hint: { count?: number } = {}) {
  const responses = raw?.methodResponses ?? [];
  const errorSlot = responses.find((r: any) => r?.[0] === 'error');
  if (errorSlot) {
    const detail = errorSlot[1] ?? {};
    return {
      type: detail.type ?? 'methodError',
      description: detail.description,
      ...(hint.count != null ? { count: hint.count } : {}),
      detail,
    };
  }
  return {
    type: 'noResponse',
    ...(hint.count != null ? { count: hint.count } : {}),
  };
}

export {
  extractMethodError,
  extractMethodErrorById,
  isRetryableDraftError,
  isRetryableMethodError,
  isRetryableMessageError,
  isRetryableSubmissionError,
  isTerminalPerObjectFolderError,
  submissionError,
  transportFolderError,
};
