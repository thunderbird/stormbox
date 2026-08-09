export type SendError = {
  type: string;
  terminal?: true;
  [key: string]: unknown;
};

export type SendOutcome =
  /** The submission was accepted; the remote ids and local filing state are authoritative. */
  | {
    outcome: 'confirmed';
    createdRemoteId: string;
    submissionRemoteId: string;
    filed: boolean;
    response: unknown;
  }
  /** Processing is incomplete, and checkpoint state makes the remaining work safe to retry. */
  | { outcome: 'rejectedRetryable'; error: SendError }
  /** The send was not accepted, and this row must not be retried automatically. */
  | { outcome: 'rejectedTerminal'; error: SendError }
  /** The available evidence cannot establish whether the send was accepted. */
  | { outcome: 'ambiguous'; error: SendError };

export type SendProcessResult =
  | {
    ok: true;
    response: unknown;
    result: {
      createdRemoteId: string;
      submissionRemoteId: string;
      filed: boolean;
    };
  }
  | { ok: false; error: SendError };

export function rejectedSendOutcome(error: SendError, retryable: boolean): SendOutcome {
  return retryable
    ? { outcome: 'rejectedRetryable', error }
    : { outcome: 'rejectedTerminal', error };
}

export function toProcessResult(outcome: SendOutcome): SendProcessResult {
  switch (outcome.outcome) {
    case 'confirmed':
      return {
        ok: true,
        response: outcome.response,
        result: {
          createdRemoteId: outcome.createdRemoteId,
          submissionRemoteId: outcome.submissionRemoteId,
          filed: outcome.filed,
        },
      };
    case 'rejectedRetryable':
    case 'rejectedTerminal':
    case 'ambiguous':
      return { ok: false, error: outcome.error };
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}
