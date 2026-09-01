import { describe, expect, it } from 'vitest';

import {
  extractMethodErrorById,
  isRetryableMethodError,
  isRetryableSubmissionError,
  submissionError,
} from '../../../src/sync/backends/jmap/outbox/errors';
import {
  rejectedSendOutcome,
  toProcessResult,
} from '../../../src/sync/backends/jmap/outbox/send-outcome';
import type { SendOutcome } from '../../../src/sync/backends/jmap/outbox/send-outcome';

describe('send outcomes', () => {
  it('maps a confirmed send to the existing success result', () => {
    const response = { methodResponses: [['EmailSubmission/set', {}, 's1']] };
    const outcome: SendOutcome = {
      outcome: 'confirmed',
      createdRemoteId: 'email-1',
      submissionRemoteId: 'submission-1',
      filed: true,
      response,
    };

    expect(toProcessResult(outcome)).toStrictEqual({
      ok: true,
      response,
      result: {
        createdRemoteId: 'email-1',
        submissionRemoteId: 'submission-1',
        filed: true,
      },
    });
  });

  it('maps a retryable rejection without adding terminal', () => {
    const error = {
      type: 'serverUnavailable',
      description: 'Try again later.',
    };
    const outcome: SendOutcome = { outcome: 'rejectedRetryable', error };

    expect(toProcessResult(outcome)).toStrictEqual({ ok: false, error });
    expect(toProcessResult(outcome)).not.toHaveProperty('error.terminal');
  });

  it('maps a terminal rejection without removing terminal', () => {
    const error = {
      type: 'notSubmitted',
      terminal: true as const,
      detail: { type: 'forbiddenFrom' },
    };
    const outcome: SendOutcome = { outcome: 'rejectedTerminal', error };

    expect(toProcessResult(outcome)).toStrictEqual({ ok: false, error });
    expect(toProcessResult(outcome)).toHaveProperty('error.terminal', true);
  });

  it('maps a terminal rejection without adding terminal', () => {
    const error = { type: 'unknownIdentity' };
    const outcome: SendOutcome = { outcome: 'rejectedTerminal', error };

    expect(toProcessResult(outcome)).toStrictEqual({ ok: false, error });
    expect(toProcessResult(outcome)).not.toHaveProperty('error.terminal');
  });

  it('maps ambiguity to outcomeUnknown without classifying it as a terminal rejection', () => {
    const error = {
      type: 'outcomeUnknown',
      terminal: true as const,
      reason: 'noEvidence',
      description: 'The server provided no conclusive evidence.',
    };
    const outcome: SendOutcome = { outcome: 'ambiguous', error };

    expect(outcome.outcome).toBe('ambiguous');
    expect(toProcessResult(outcome)).toStrictEqual({ ok: false, error });
    expect(toProcessResult(outcome)).toHaveProperty('error', expect.objectContaining({
      type: 'outcomeUnknown',
      terminal: true,
    }));
  });

  it('uses the method-error predicate to classify server error types', () => {
    const outcomeFor = (type: string): SendOutcome => {
      const error = extractMethodErrorById({
        methodResponses: [['error', { type }, 's1']],
      }, 's1');
      return rejectedSendOutcome(error, isRetryableMethodError(error));
    };

    expect(outcomeFor('serverUnavailable').outcome).toBe('rejectedRetryable');
    expect(outcomeFor('forbidden').outcome).toBe('rejectedTerminal');

    const noResponse = extractMethodErrorById({ methodResponses: [] }, 's1');
    expect(
      rejectedSendOutcome(noResponse, isRetryableMethodError(noResponse)).outcome,
    ).toBe('rejectedRetryable');
  });

  it('uses the submission-error predicate to classify server error types', () => {
    const outcomeFor = (type: string): SendOutcome => {
      const detail = { type };
      const error = submissionError('notSubmitted', detail);
      return rejectedSendOutcome(error, isRetryableSubmissionError(detail));
    };

    expect(outcomeFor('rateLimit').outcome).toBe('rejectedRetryable');
    expect(outcomeFor('invalidEmail').outcome).toBe('rejectedTerminal');
  });

  it('treats an authenticationFailed submission rejection as terminal', () => {
    // Send is an allowlist: only rateLimit earns a retry, so a rejected
    // credential on EmailSubmission/set must not re-run create-and-submit.
    const detail = { type: 'authenticationFailed' };
    const error = submissionError('notSubmitted', detail);

    expect(isRetryableSubmissionError(detail)).toBe(false);
    expect(error).toHaveProperty('terminal', true);
    expect(rejectedSendOutcome(error, isRetryableSubmissionError(detail)).outcome)
      .toBe('rejectedTerminal');
  });
});
