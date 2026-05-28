import { describe, it, expect } from 'vitest';

import { buildReplyAllRecipients, makeReplySubject } from '../../../src/utils/compose-quote';

describe('compose-quote', () => {
  it('makeReplySubject avoids duplicate Re: prefix', () => {
    expect(makeReplySubject('Hello')).toBe('Re: Hello');
    expect(makeReplySubject('Re: Hello')).toBe('Re: Hello');
  });

  it('buildReplyAllRecipients puts sender in To and other recipients in Cc', () => {
    const { to, cc } = buildReplyAllRecipients({
      fromText: 'Alice <alice@example.com>',
      toText: 'Bob <bob@example.com>, me@example.com',
      selfEmail: 'me@example.com',
    });
    expect(to).toBe('Alice <alice@example.com>');
    expect(cc).toBe('Bob <bob@example.com>');
  });
});
