import { describe, it, expect } from 'vitest';

import { parseAddressList, parseOneAddress } from '../../../src/utils/address-list';

/**
 * The grammar itself is covered in address-parse.test.ts. What matters
 * here is the narrower contract this module offers its callers: addresses
 * only, and a single address from a header string.
 */
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

  it('parses a list of bare and name <email> entries', () => {
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

  it('drops what it could not parse, because this view has nowhere to put it', () => {
    expect(parseAddressList('alice@example.com, rubbish')).toEqual([
      { email: 'alice@example.com' },
    ]);
  });
});

describe('parseOneAddress', () => {
  it('reads the address out of a header display string', () => {
    expect(parseOneAddress('Alice <alice@example.com>')).toEqual({
      name: 'Alice',
      email: 'alice@example.com',
    });
    expect(parseOneAddress('alice@example.com')).toEqual({ email: 'alice@example.com' });
  });

  it('returns null when the string names no address', () => {
    expect(parseOneAddress('')).toBeNull();
    expect(parseOneAddress('   ')).toBeNull();
    expect(parseOneAddress('(no sender)')).toBeNull();
  });
});
