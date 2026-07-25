import { describe, it, expect } from 'vitest';

import { makeForwardSubject, makeReplySubject } from '../../../src/utils/compose-quote';

describe('compose-quote', () => {
  it('makeReplySubject avoids duplicate Re: prefix', () => {
    expect(makeReplySubject('Hello')).toBe('Re: Hello');
    expect(makeReplySubject('Re: Hello')).toBe('Re: Hello');
  });

  it('makeForwardSubject avoids duplicate Fwd: prefix', () => {
    expect(makeForwardSubject('Hello')).toBe('Fwd: Hello');
    expect(makeForwardSubject('Fwd: Hello')).toBe('Fwd: Hello');
  });
});
