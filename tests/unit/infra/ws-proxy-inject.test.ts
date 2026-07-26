/**
 * The e2e WebSocket proxy's method-level error injection.
 *
 * This is test infrastructure, but a matcher that quietly stops matching
 * would make the spec that depends on it (a method-level error must fail
 * the send, keep the mutation row, and leave Sent untouched) pass
 * vacuously: the send would simply succeed and every assertion about the
 * failure path would be checking a send that never failed.
 */

import { describe, it, expect } from 'vitest';

import {
  createInjector,
  injectedResponseFor,
  INJECT_MARKER,
  INJECTED_ERROR_TYPE,
  SUBMISSION_FAULTS,
  CONTACT_CACHE_FAULT,
} from '../../fixtures/ws-proxy/inject.mjs';

function requestFrame(methodCalls: any[], id = 'r7') {
  return JSON.stringify({
    '@type': 'Request',
    id,
    using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
    methodCalls,
  });
}

function responseFrame(methodResponses: any[], requestId = 'r7') {
  return JSON.stringify({ '@type': 'Response', requestId, methodResponses });
}

/** The send sequence: a marked create, then its submission. */
function armedInjector(mode: string, emailId = 'em-1') {
  const injector = createInjector();
  const create = requestFrame([[
    'Email/set',
    { create: { c1: { subject: `probe ${SUBMISSION_FAULTS[mode]}` } } },
    'c1',
  ]], 'r1');
  expect(injector.onClientFrame(create).action).toBe('forward');
  const created = responseFrame(
    [['Email/set', { created: { c1: { id: emailId } } }, 'c1']],
    'r1',
  );
  expect(injector.onServerFrame(created).action).toBe('forward');
  return injector;
}

function submissionFrame(emailId = 'em-1', id = 'r2') {
  return requestFrame([[
    'EmailSubmission/set',
    { create: { s1: { identityId: 'i1', emailId } } },
    's1',
  ]], id);
}

describe('ws-proxy error injection', () => {
  it('answers a marked Request with one error slot per call id', () => {
    const frame = requestFrame([
      ['Email/set', { create: { c1: { subject: `probe ${INJECT_MARKER}` } } }, 'c1'],
    ]);

    const injected = injectedResponseFor(frame);

    expect(injected).toEqual({
      '@type': 'Response',
      requestId: 'r7',
      methodResponses: [
        ['error', {
          type: INJECTED_ERROR_TYPE,
          description: expect.stringContaining(INJECT_MARKER),
        }, 'c1'],
      ],
    });
  });

  it('covers every call in a multi-call request', () => {
    const frame = requestFrame([
      ['Email/set', { create: { c1: { subject: INJECT_MARKER } } }, 'c1'],
      ['EmailSubmission/set', { create: { s1: {} } }, 's1'],
    ]);

    const injected = injectedResponseFor(frame);

    expect(injected.methodResponses.map((r: any[]) => r[2])).toEqual(['c1', 's1']);
    expect(injected.methodResponses.every((r: any[]) => r[0] === 'error')).toBe(true);
  });

  it('forwards an unmarked Request untouched', () => {
    const frame = requestFrame([['Email/set', { create: { c1: { subject: 'ordinary' } } }, 'c1']]);
    expect(injectedResponseFor(frame)).toBeNull();
  });

  it('forwards frames that are not Requests, even when marked', () => {
    // WebSocketPushEnable and StateChange share the socket. Answering
    // one of those with a method-error Response would break push for
    // the whole run.
    const enable = JSON.stringify({
      '@type': 'WebSocketPushEnable',
      dataTypes: ['Email'],
      pushState: INJECT_MARKER,
    });
    expect(injectedResponseFor(enable)).toBeNull();
  });

  it('forwards a marked frame that is not valid JSON', () => {
    expect(injectedResponseFor(`{"@type":"Request" ${INJECT_MARKER}`)).toBeNull();
  });

  it('forwards non-string payloads', () => {
    // Binary frames arrive as Buffers; only text frames are inspected.
    expect(injectedResponseFor(undefined as any)).toBeNull();
  });
});

describe('ws-proxy submission fault injection', () => {
  it('holds back the answer to a submission it still forwards', () => {
    // The server submits and delivers; the client is left waiting, which
    // is the state a worker dies in mid-send.
    const injector = armedInjector('HOLD');

    expect(injector.onClientFrame(submissionFrame())).toMatchObject({
      action: 'forward',
      kind: 'HOLD',
    });
    expect(injector.onServerFrame(responseFrame(
      [['EmailSubmission/set', { created: { s1: { id: 'sub-1' } } }, 's1']],
      'r2',
    ))).toMatchObject({ action: 'drop' });
  });

  it('answers a forwarded submission without its response slot', () => {
    const injector = armedInjector('LOSE');

    expect(injector.onClientFrame(submissionFrame())).toMatchObject({
      action: 'forward',
      kind: 'LOSE',
    });
    const decision = injector.onServerFrame(responseFrame(
      [['EmailSubmission/set', { created: { s1: { id: 'sub-1' } } }, 's1']],
      'r2',
    ));
    expect(decision.action).toBe('replace');
    expect(decision.response).toEqual({
      '@type': 'Response',
      requestId: 'r2',
      methodResponses: [],
    });
  });

  it('never forwards a dropped submission', () => {
    const injector = armedInjector('DROP');

    const decision = injector.onClientFrame(submissionFrame());
    expect(decision.action).toBe('answer');
    expect(decision.response).toEqual({
      '@type': 'Response',
      requestId: 'r2',
      methodResponses: [],
    });
  });

  it('breaks one submission only, so a retry reaches the server', () => {
    // Without this the spec could not tell "recovery declined to retry"
    // from "recovery retried and was broken again".
    const injector = armedInjector('DROP');
    expect(injector.onClientFrame(submissionFrame('em-1', 'r2')).action).toBe('answer');
    expect(injector.onClientFrame(submissionFrame('em-1', 'r3')).action).toBe('forward');
  });

  it('leaves submissions for other messages alone', () => {
    const injector = armedInjector('HOLD', 'em-1');
    expect(injector.onClientFrame(submissionFrame('em-other', 'r2')))
      .toEqual({ action: 'forward' });
  });

  it('arms nothing from an unmarked send', () => {
    const injector = createInjector();
    injector.onClientFrame(requestFrame([[
      'Email/set', { create: { c1: { subject: 'ordinary' } } }, 'c1',
    ]], 'r1'));
    injector.onServerFrame(responseFrame(
      [['Email/set', { created: { c1: { id: 'em-1' } } }, 'c1']],
      'r1',
    ));
    expect(injector.onClientFrame(submissionFrame())).toEqual({ action: 'forward' });
  });

  it('passes StateChange frames through untouched', () => {
    const injector = armedInjector('HOLD');
    const stateChange = JSON.stringify({
      '@type': 'StateChange',
      changed: { 'acct-1': { Email: 'st-2' } },
    });
    expect(injector.onServerFrame(stateChange)).toEqual({ action: 'forward' });
  });

  it('arms only the creation that carries the marker', () => {
    // One request, two creates, one of them marked. Arming the other
    // would break a send no spec asked about — and in a shared-session
    // run that send belongs to a different test.
    const injector = createInjector();
    injector.onClientFrame(requestFrame([[
      'Email/set',
      {
        create: {
          c1: { subject: 'unrelated draft' },
          c2: { subject: `probe ${SUBMISSION_FAULTS.HOLD}` },
        },
      },
      'c1',
    ]], 'r1'));
    injector.onServerFrame(responseFrame(
      [['Email/set', { created: { c1: { id: 'em-innocent' }, c2: { id: 'em-target' } } }, 'c1']],
      'r1',
    ));

    expect(injector.onClientFrame(submissionFrame('em-innocent', 'r2')))
      .toEqual({ action: 'forward' });
    expect(injector.onClientFrame(submissionFrame('em-target', 'r3')))
      .toMatchObject({ action: 'forward', kind: 'HOLD' });
  });

  it('arms nothing when the marked create was rejected', () => {
    const injector = createInjector();
    injector.onClientFrame(requestFrame([[
      'Email/set',
      { create: { c1: { subject: `probe ${SUBMISSION_FAULTS.DROP}` } } },
      'c1',
    ]], 'r1'));
    injector.onServerFrame(responseFrame(
      [['Email/set', { notCreated: { c1: { type: 'tooLarge' } } }, 'c1']],
      'r1',
    ));

    expect(injector.onClientFrame(submissionFrame('em-1', 'r2')))
      .toEqual({ action: 'forward' });
  });

  it('records each fault it applies, and records nothing otherwise', () => {
    // The specs assert on this to prove the interruption they describe
    // actually happened, so it has to be written exactly when the frame
    // was interfered with.
    const applied: any[] = [];
    const injector = createInjector({ applied });
    const unmarked = createInjector({ applied });

    unmarked.onClientFrame(requestFrame([[
      'Email/set', { create: { c1: { subject: 'ordinary' } } }, 'c1',
    ]], 'r1'));
    unmarked.onClientFrame(submissionFrame('em-plain', 'r2'));
    expect(applied).toEqual([]);

    const create = requestFrame([[
      'Email/set',
      { create: { c1: { subject: `probe ${SUBMISSION_FAULTS.LOSE}` } } },
      'c1',
    ]], 'r1');
    injector.onClientFrame(create);
    injector.onServerFrame(responseFrame(
      [['Email/set', { created: { c1: { id: 'em-9' } } }, 'c1']],
      'r1',
    ));
    injector.onClientFrame(submissionFrame('em-9', 'r2'));
    expect(applied, 'forwarding is not yet interference').toEqual([]);

    injector.onServerFrame(responseFrame(
      [['EmailSubmission/set', { created: { s1: { id: 'sub-9' } } }, 's1']],
      'r2',
    ));
    expect(applied).toEqual([
      { mode: 'LOSE', emailId: 'em-9', effect: 'responseBlanked', at: expect.any(Number) },
    ]);
  });
});

describe('ws-proxy contact cache fault', () => {
  /** A marked card create, answered with the id the server assigned. */
  function armedForCard(cardId = 'card-1') {
    const injector = createInjector({ applied: [] });
    const create = requestFrame([[
      'ContactCard/set',
      { create: { c1: { name: { full: `Probe ${CONTACT_CACHE_FAULT}` } } } },
      'c1',
    ]], 'r1');
    expect(injector.onClientFrame(create).action).toBe('forward');
    injector.onServerFrame(responseFrame(
      [['ContactCard/set', { created: { c1: { id: cardId } } }, 'c1']],
      'r1',
    ));
    return injector;
  }

  function cardGet(ids: string[], id = 'r2') {
    return requestFrame([['ContactCard/get', { ids }, 'g1']], id);
  }

  it('lets the write through and refuses only the read-back', () => {
    const injector = armedForCard();

    const answer = injector.onClientFrame(cardGet(['card-1']));

    expect(answer.action, 'the server must really hold the card').toBe('answer');
    expect(answer.response.methodResponses[0][0]).toBe('error');
    expect(answer.response.methodResponses[0][1].type).toBe(INJECTED_ERROR_TYPE);
  });

  it('refuses the read-back once, so the retry can succeed', () => {
    const injector = armedForCard();
    injector.onClientFrame(cardGet(['card-1']));

    const retry = injector.onClientFrame(cardGet(['card-1'], 'r3'));

    expect(retry.action).toBe('forward');
  });

  it('leaves a read of some other card alone', () => {
    const injector = armedForCard();

    expect(injector.onClientFrame(cardGet(['card-other'])).action).toBe('forward');
  });

  it('does nothing at all without the marker', () => {
    const injector = createInjector({ applied: [] });
    const create = requestFrame([[
      'ContactCard/set',
      { create: { c1: { name: { full: 'Ordinary' } } } },
      'c1',
    ]], 'r1');
    injector.onClientFrame(create);
    injector.onServerFrame(responseFrame(
      [['ContactCard/set', { created: { c1: { id: 'card-2' } } }, 'c1']],
      'r1',
    ));

    expect(injector.onClientFrame(cardGet(['card-2'])).action).toBe('forward');
  });

  it('records what it refused, so a spec can prove the fault fired', () => {
    const applied: any[] = [];
    const injector = createInjector({ applied });
    injector.onClientFrame(requestFrame([[
      'ContactCard/set',
      { create: { c1: { name: { full: `Probe ${CONTACT_CACHE_FAULT}` } } } },
      'c1',
    ]], 'r1'));
    injector.onServerFrame(responseFrame(
      [['ContactCard/set', { created: { c1: { id: 'card-5' } } }, 'c1']],
      'r1',
    ));

    injector.onClientFrame(cardGet(['card-5']));

    expect(applied).toEqual([
      { mode: 'CONTACT_CACHE', emailId: 'card-5', effect: 'readBackRefused', at: expect.any(Number) },
    ]);
  });
});
