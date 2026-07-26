import { describe, expect, it } from 'vitest';

import { addressKey, nameTokens } from '../../../src/utils/address-key';

describe('addressKey (CS-3.5)', () => {
  it('folds the parts of an address that the receiving server ignores', () => {
    // The domain is case-insensitive; folding it is not a trade-off.
    expect(addressKey('jane@Example.COM')).toBe(addressKey('jane@example.com'));
    expect(addressKey('  jane@example.com  ')).toBe('jane@example.com');
  });

  it('folds local-part case, which is a trade-off and not a rule', () => {
    // RFC 5321 §2.3.11 makes this case-sensitive to the receiving server, so
    // this is a deliberate UI decision: two addresses differing only by
    // local-part case are effectively never two people.
    expect(addressKey('Jane@example.com')).toBe(addressKey('jane@example.com'));
  });

  it('agrees between a Unicode domain and its punycode spelling', () => {
    expect(addressKey('jane@bücher.example')).toBe(addressKey('jane@xn--bcher-kva.example'));
  });

  it('applies NFC and not NFKC', () => {
    // Composed and decomposed é are the same character, so they must agree.
    expect(addressKey('josé@example.com')).toBe(addressKey('jose\u0301@example.com'));
    // ﬁ (U+FB01) is a different character that NFKC would fold to "fi".
    // Folding it would merge two addresses belonging to two people.
    expect(addressKey('o\uFB01ce@example.com')).not.toBe(addressKey('office@example.com'));
  });

  it('applies no provider-specific canonicalization', () => {
    // These reach one inbox at Google's discretion, not by the rules of
    // email, and a plus tag is how people filter their own mail.
    expect(addressKey('a.b@gmail.com')).not.toBe(addressKey('ab@gmail.com'));
    expect(addressKey('jane+lists@example.com')).not.toBe(addressKey('jane@example.com'));
  });

  it('gives an unparseable entry a key of its own rather than an empty one', () => {
    // An empty key would make every malformed entry compare equal to every
    // other, collapsing them into one suggestion.
    expect(addressKey('not an address')).toBe('not an address');
    expect(addressKey('jane@')).toBe('jane@');
    expect(addressKey('@example.com')).toBe('@example.com');
    expect(addressKey('')).toBe('');
    expect(addressKey(null)).toBe('');
  });

  it('keeps an address literal rather than refusing it', () => {
    expect(addressKey('jane@[192.0.2.1]')).toBe('jane@[192.0.2.1]');
  });
});

describe('nameTokens (CS-3.2)', () => {
  it('splits on punctuation so a stored comma cannot hide a word', () => {
    expect(nameTokens('Smith, Jane').sort()).toEqual(['jane', 'smith']);
    expect(nameTokens('Jane Q. Smith').sort()).toEqual(['jane', 'q', 'smith']);
  });

  it('keeps a hyphen or apostrophe inside a word', () => {
    // "Anne-Marie" is one word; offering "marie" alone is not how the name
    // is typed.
    expect(nameTokens('Anne-Marie O\'Neill').sort()).toEqual(['anne-marie', "o'neill"]);
  });

  it('strips a leading or trailing hyphen rather than keeping it in a token', () => {
    expect(nameTokens('- Jane -')).toEqual(['jane']);
  });

  it('folds case and merges repeats across fields', () => {
    expect(nameTokens('Jane Smith', 'jane', 'SMITH').sort()).toEqual(['jane', 'smith']);
  });

  it('ignores absent fields', () => {
    expect(nameTokens(null, undefined, '')).toEqual([]);
  });

  it('keeps words in other scripts', () => {
    expect(nameTokens('Ямал Иванов').sort()).toEqual(['иванов', 'ямал']);
  });
});
