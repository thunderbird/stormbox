/**
 * Response-selection helpers. pickResponse() is name-only and returns
 * the first match, which is correct for the single-call envelopes most
 * sync modules issue. Send is the exception: RFC 8621 §7.5 has
 * onSuccessUpdateEmail generate a second, implicit Email/set response
 * tagged with the EmailSubmission/set call id, so validating the send
 * needs the call id too.
 */

import { describe, it, expect } from 'vitest';

import { pickResponse, pickResponseById } from '../../../src/sync/backends/jmap/invoke';

// The envelope Stalwart returns for a chained create + submit, including
// the implicit update.
const sendEnvelope = {
  methodResponses: [
    ['Email/set', { created: { c1: { id: 'em-1' } } }, 'c1'],
    ['EmailSubmission/set', { created: { s1: { id: 'sub-1' } } }, 's1'],
    ['Email/set', { updated: { 'em-1': null } }, 's1'],
  ],
};

describe('pickResponse', () => {
  it('returns the first tuple matching the method name', () => {
    expect(pickResponse(sendEnvelope, 'Email/set')).toEqual({
      created: { c1: { id: 'em-1' } },
    });
  });

  it('returns null for a missing method and a missing envelope', () => {
    expect(pickResponse(sendEnvelope, 'Mailbox/set')).toBeNull();
    expect(pickResponse(null, 'Email/set')).toBeNull();
    expect(pickResponse({}, 'Email/set')).toBeNull();
  });
});

describe('pickResponseById', () => {
  it('distinguishes the explicit create from the implicit update', () => {
    expect(pickResponseById(sendEnvelope, 'Email/set', 'c1')).toEqual({
      created: { c1: { id: 'em-1' } },
    });
    expect(pickResponseById(sendEnvelope, 'Email/set', 's1')).toEqual({
      updated: { 'em-1': null },
    });
  });

  it('returns null when the call id is absent', () => {
    expect(pickResponseById(sendEnvelope, 'Email/set', 'nope')).toBeNull();
  });

  it('does not match an error tuple as the requested method', () => {
    // RFC 8620 §3.6.1: a method that cannot run has its slot replaced by
    // ["error", {...}, callId]. Treating that as a response is how a
    // failed send used to pass as a success.
    const failed = {
      methodResponses: [
        ['Email/set', { created: { c1: { id: 'em-1' } } }, 'c1'],
        ['error', { type: 'serverFail' }, 's1'],
      ],
    };
    expect(pickResponseById(failed, 'EmailSubmission/set', 's1')).toBeNull();
    expect(pickResponseById(failed, 'error', 's1')).toEqual({ type: 'serverFail' });
  });
});
