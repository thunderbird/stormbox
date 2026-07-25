/**
 * The evidence helpers behind an interrupted send (CS-1.8).
 *
 * Every case here turns on one rule: a lookup that fails is not a lookup
 * that came back empty. Both helpers are called precisely when something
 * has already gone wrong on the network, so the failure they are most
 * likely to meet is their own, and reading that as "nothing happened" is
 * what delivers a message twice.
 */

import { describe, it, expect } from 'vitest';

import {
  findEmailByMessageId,
  findSubmissionEvidence,
} from '../../../src/sync/backends/jmap/send-reconcile';
import { MockTransport } from './_mock-transport';

const account = { remote_account_id: 'acc-1' };

describe('findSubmissionEvidence', () => {
  it('accepts a retained submission record as proof', async () => {
    const transport = new MockTransport();
    transport.handle('EmailSubmission/query', () => ({ ids: ['sub-9'] }));

    expect(await findSubmissionEvidence({
      transport, account, emailRemoteId: 'e-1', sentRemoteId: 'mb-sent',
    })).toEqual({ outcome: 'submitted', submissionRemoteId: 'sub-9' });
  });

  it('accepts the message sitting in Sent without its draft flag as proof', async () => {
    // The server's own onSuccessUpdateEmail put it there, and that runs
    // only once the submission is accepted. RFC 8621 §7 lets it destroy
    // the submission record immediately, which is why this second signal
    // exists at all.
    const transport = new MockTransport();
    transport.handle('EmailSubmission/query', () => ({ ids: [] }));
    transport.handle('Email/get', () => ({
      list: [{ id: 'e-1', mailboxIds: { 'mb-sent': true }, keywords: {} }],
      state: 'es',
    }));

    expect(await findSubmissionEvidence({
      transport, account, emailRemoteId: 'e-1', sentRemoteId: 'mb-sent',
    })).toEqual({ outcome: 'submitted', submissionRemoteId: null });
  });

  it('does not read a message still in Drafts as proof of anything', async () => {
    const transport = new MockTransport();
    transport.handle('EmailSubmission/query', () => ({ ids: [] }));
    transport.handle('Email/get', () => ({
      list: [{
        id: 'e-1',
        mailboxIds: { 'mb-drafts': true },
        keywords: { $draft: true },
      }],
      state: 'es',
    }));

    expect(await findSubmissionEvidence({
      transport, account, emailRemoteId: 'e-1', sentRemoteId: 'mb-sent',
    })).toEqual({ outcome: 'unknown' });
  });

  it('falls through to the mailbox signal when submissions cannot be queried', async () => {
    // Not every server supports filtering submissions by emailIds, and a
    // server that refuses the filter has told us nothing.
    const transport = new MockTransport();
    transport.handle('EmailSubmission/query', () => {
      throw Object.assign(new Error('unsupportedFilter'), { type: 'unsupportedFilter' });
    });
    transport.handle('Email/get', () => ({
      list: [{ id: 'e-1', mailboxIds: { 'mb-sent': true }, keywords: {} }],
      state: 'es',
    }));

    expect(await findSubmissionEvidence({
      transport, account, emailRemoteId: 'e-1', sentRemoteId: 'mb-sent',
    })).toEqual({ outcome: 'submitted', submissionRemoteId: null });
  });

  it('reports an unknown outcome rather than throwing when the network is gone', async () => {
    // The caller is already handling a failed request. A throw from here
    // would escape the send as an ordinary transport failure and tell the
    // user their message did not go out, which nobody knows.
    const transport = new MockTransport();
    transport.handle('EmailSubmission/query', () => {
      throw Object.assign(new Error('socket closed'), { type: 'wsClosed' });
    });
    transport.handle('Email/get', () => {
      throw Object.assign(new Error('socket closed'), { type: 'wsClosed' });
    });

    expect(await findSubmissionEvidence({
      transport, account, emailRemoteId: 'e-1', sentRemoteId: 'mb-sent',
    })).toEqual({ outcome: 'unknown' });
  });

  it('asks nothing when there is no Email id to ask about', async () => {
    const transport = new MockTransport();

    expect(await findSubmissionEvidence({
      transport, account, emailRemoteId: null, sentRemoteId: 'mb-sent',
    })).toEqual({ outcome: 'unknown' });
    expect(transport.requests).toHaveLength(0);
  });

  it('stops after the submission signal when there is no Sent folder to check', async () => {
    const transport = new MockTransport();
    transport.handle('EmailSubmission/query', () => ({ ids: [] }));

    expect(await findSubmissionEvidence({
      transport, account, emailRemoteId: 'e-1', sentRemoteId: null,
    })).toEqual({ outcome: 'unknown' });
    expect(transport.requests).toHaveLength(1);
  });
});

describe('findEmailByMessageId', () => {
  const messageId = '<abc@stormbox.test>';

  function scan(list) {
    const transport = new MockTransport();
    transport.handle('Email/query', () => ({
      ids: list.map((e) => e.id),
      queryState: 'qs',
    }));
    transport.handle('Email/get', () => ({ list, state: 'es' }));
    return transport;
  }

  it('finds the message it stamped, ignoring the angle brackets', async () => {
    // Servers are inconsistent about whether messageId values carry them.
    const transport = scan([
      { id: 'e-other', messageId: ['zzz@stormbox.test'] },
      { id: 'e-mine', messageId: ['abc@stormbox.test'] },
    ]);

    expect(await findEmailByMessageId({
      transport, account, mailboxId: 'mb-drafts', messageId,
    })).toEqual({ outcome: 'found', emailRemoteId: 'e-mine' });
  });

  it('reports absence when the scan ran and found nothing', async () => {
    const transport = scan([{ id: 'e-other', messageId: ['zzz@stormbox.test'] }]);

    expect(await findEmailByMessageId({
      transport, account, mailboxId: 'mb-drafts', messageId,
    })).toEqual({ outcome: 'absent' });
  });

  it('keeps a failed scan apart from an empty one', async () => {
    const transport = new MockTransport();
    transport.handle('Email/query', () => {
      throw Object.assign(new Error('deadline'), { type: 'wsRequestTimeout' });
    });

    const probe = await findEmailByMessageId({
      transport, account, mailboxId: 'mb-drafts', messageId,
    });
    expect(probe).toMatchObject({
      outcome: 'inconclusive',
      reason: 'wsRequestTimeout',
    });
  });

  it('treats a rejected method call as a scan that did not happen', async () => {
    // A method-level error replaces the response slot (RFC 8620 §3.6.1),
    // so the chained get never runs and an empty list would be an
    // artefact of the rejection.
    const transport = new MockTransport();
    transport.handle('Email/query', () => {
      throw Object.assign(new Error('unsupportedFilter'), { type: 'unsupportedFilter' });
    });

    const probe = await findEmailByMessageId({
      transport, account, mailboxId: 'mb-drafts', messageId,
    });
    expect(probe.outcome).toBe('inconclusive');
  });

  it('does not read a malformed list as an empty mailbox', async () => {
    // The response resolved, so the transport catch never runs. Reading
    // an unusable payload as `absent` is what licenses creating a second
    // copy of a message that may already be there.
    const transport = new MockTransport();
    transport.handle('Email/query', () => ({ ids: ['e-1'], queryState: 'qs' }));
    transport.handle('Email/get', () => ({ list: { 0: { id: 'e-1' } }, state: 'es' }));

    expect(await findEmailByMessageId({
      transport, account, mailboxId: 'mb-drafts', messageId,
    })).toMatchObject({ outcome: 'inconclusive', reason: 'malformedResponse' });
  });

  it('does not read an unreadable Message-ID as a different message', async () => {
    const transport = scan([{ id: 'e-1', messageId: { 0: 'abc@stormbox.test' } }]);

    expect(await findEmailByMessageId({
      transport, account, mailboxId: 'mb-drafts', messageId,
    })).toMatchObject({ outcome: 'inconclusive', reason: 'malformedResponse' });
  });

  it('accepts a server that sends a bare Message-ID string', async () => {
    const transport = scan([{ id: 'e-1', messageId: 'abc@stormbox.test' }]);

    expect(await findEmailByMessageId({
      transport, account, mailboxId: 'mb-drafts', messageId,
    })).toEqual({ outcome: 'found', emailRemoteId: 'e-1' });
  });

  it('reports absence for a message with no Message-ID at all', async () => {
    const transport = scan([{ id: 'e-1' }]);

    expect(await findEmailByMessageId({
      transport, account, mailboxId: 'mb-drafts', messageId,
    })).toEqual({ outcome: 'absent' });
  });

  it('survives an envelope that is not shaped like one', async () => {
    const transport = new MockTransport();
    const malformed = async () => ({ methodResponses: {} as any });
    transport.request = malformed;
    transport.wsRequest = malformed;

    expect(await findEmailByMessageId({
      transport, account, mailboxId: 'mb-drafts', messageId,
    })).toMatchObject({ outcome: 'inconclusive', reason: 'scanRejected' });
  });

  it('does not call a scan absent when there was nothing to scan', async () => {
    // No candidate mailbox means no earlier attempt could have filed
    // anything where this one would look, so this is a real negative.
    const transport = new MockTransport();

    expect(await findEmailByMessageId({
      transport, account, mailboxId: null, messageId,
    })).toEqual({ outcome: 'absent' });
    expect(transport.requests).toHaveLength(0);
  });
});
