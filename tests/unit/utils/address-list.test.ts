import { describe, it, expect } from 'vitest';

import { parseAddressList } from '../../../src/utils/address-list.js';

describe('parseAddressList', () => {
  it('returns an empty array for empty input', () => {
    expect(parseAddressList('')).toEqual([]);
    expect(parseAddressList('   ')).toEqual([]);
  });

  it('parses a bare email', () => {
    expect(parseAddressList('alice@example.com')).toEqual([
      { email: 'alice@example.com' },
    ]);
  });

  it('parses a name <email> pair and strips quotes from the display name', () => {
    expect(parseAddressList('"Alice Example" <alice@example.com>')).toEqual([
      { name: 'Alice Example', email: 'alice@example.com' },
    ]);
    expect(parseAddressList('Alice <alice@example.com>')).toEqual([
      { name: 'Alice', email: 'alice@example.com' },
    ]);
  });

  it('splits a comma-separated mix of bare and name <email> entries', () => {
    expect(
      parseAddressList('alice@example.com, "Bob B." <bob@example.com>, carol@example.com'),
    ).toEqual([
      { email: 'alice@example.com' },
      { name: 'Bob B.', email: 'bob@example.com' },
      { email: 'carol@example.com' },
    ]);
  });

  it('drops empty segments left by stray commas', () => {
    expect(parseAddressList(', alice@example.com,, ,bob@example.com,')).toEqual([
      { email: 'alice@example.com' },
      { email: 'bob@example.com' },
    ]);
  });
});
