import { describe, it, expect } from 'vitest';

import {
  formatAddress,
  formatAddressList,
  endsInsideAddress,
  parseAddressEntries,
  parseAddressList,
} from '../../../src/utils/address-parse';

/**
 * Conformance cases for the RFC 5322 §3.4 grammar subset, plus the
 * rejection channel CS-2.4 requires. Each case names the construct it
 * covers, because the point of a hand-written parser is that its coverage
 * is legible.
 */
describe('parseAddressList', () => {
  it('says nothing about nothing', () => {
    expect(parseAddressList('')).toEqual({ addresses: [], rejected: [] });
    expect(parseAddressList('   ')).toEqual({ addresses: [], rejected: [] });
    expect(parseAddressList(null)).toEqual({ addresses: [], rejected: [] });
    expect(parseAddressList(undefined)).toEqual({ addresses: [], rejected: [] });
  });

  it('parses a bare addr-spec', () => {
    expect(parseAddressList('alice@example.com').addresses)
      .toEqual([{ email: 'alice@example.com' }]);
  });

  it('parses a name-addr and decodes the quoted display name', () => {
    expect(parseAddressList('"Alice Example" <alice@example.com>').addresses)
      .toEqual([{ name: 'Alice Example', email: 'alice@example.com' }]);
    expect(parseAddressList('Alice <alice@example.com>').addresses)
      .toEqual([{ name: 'Alice', email: 'alice@example.com' }]);
  });

  it('keeps a comma inside a quoted display name out of the separator role', () => {
    // The case the old comma-split could not express at all: this is one
    // recipient, not two fragments.
    expect(parseAddressList('"Smith, Alice" <alice@example.com>').addresses)
      .toEqual([{ name: 'Smith, Alice', email: 'alice@example.com' }]);
    expect(
      parseAddressList('"Smith, Alice" <alice@example.com>, "Doe, Bob" <bob@example.com>')
        .addresses,
    ).toEqual([
      { name: 'Smith, Alice', email: 'alice@example.com' },
      { name: 'Doe, Bob', email: 'bob@example.com' },
    ]);
  });

  it('unescapes a quoted-pair inside a display name', () => {
    expect(parseAddressList('"Alice \\"Ally\\" Example" <alice@example.com>').addresses)
      .toEqual([{ name: 'Alice "Ally" Example', email: 'alice@example.com' }]);
    expect(parseAddressList('"Back\\\\slash" <alice@example.com>').addresses)
      .toEqual([{ name: 'Back\\slash', email: 'alice@example.com' }]);
  });

  it('keeps bare dots in an unquoted display name (obs-phrase)', () => {
    expect(parseAddressList('Alice B. Smith <alice@example.com>').addresses)
      .toEqual([{ name: 'Alice B. Smith', email: 'alice@example.com' }]);
  });

  it('discards comments, including nested ones', () => {
    expect(parseAddressList('(greeting) Alice <alice@example.com> (sender)').addresses)
      .toEqual([{ name: 'Alice', email: 'alice@example.com' }]);
    expect(parseAddressList('Alice <alice(inner (deeper) comment)@example.com>').addresses)
      .toEqual([{ name: 'Alice', email: 'alice@example.com' }]);
    expect(parseAddressList('alice@example.com (with, a, comma)').addresses)
      .toEqual([{ email: 'alice@example.com' }]);
  });

  it('parses a quoted local part and leaves it quoted', () => {
    // Decoding it would produce a string that is no longer a valid
    // address, because the quotes are what make the space legal.
    expect(parseAddressList('"alice smith"@example.com').addresses)
      .toEqual([{ email: '"alice smith"@example.com' }]);
    expect(parseAddressList('Alice <"a,b"@example.com>').addresses)
      .toEqual([{ name: 'Alice', email: '"a,b"@example.com' }]);
  });

  it('parses a domain literal', () => {
    expect(parseAddressList('alice@[192.0.2.1]').addresses)
      .toEqual([{ email: 'alice@[192.0.2.1]' }]);
    expect(parseAddressList('Alice <alice@[IPv6:2001:db8::1]>').addresses)
      .toEqual([{ name: 'Alice', email: 'alice@[IPv6:2001:db8::1]' }]);
  });

  it('flattens group syntax into its members', () => {
    expect(parseAddressList('Team: alice@example.com, Bob <bob@example.com>;').addresses)
      .toEqual([
        { email: 'alice@example.com' },
        { name: 'Bob', email: 'bob@example.com' },
      ]);
    expect(parseAddressList('Nobody:;').addresses).toEqual([]);
    expect(
      parseAddressList('Team: alice@example.com;, carol@example.com').addresses,
    ).toEqual([
      { email: 'alice@example.com' },
      { email: 'carol@example.com' },
    ]);
  });

  it('accepts internationalized local parts and domains (RFC 6532)', () => {
    expect(parseAddressList('जॉन@भारत.भारत').addresses)
      .toEqual([{ email: 'जॉन@भारत.भारत' }]);
    expect(parseAddressList('Ünal Öz <ünal@öz.example>').addresses)
      .toEqual([{ name: 'Ünal Öz', email: 'ünal@öz.example' }]);
    expect(parseAddressList('"Zoë, Née" <zoe@example.com>').addresses)
      .toEqual([{ name: 'Zoë, Née', email: 'zoe@example.com' }]);
  });

  it('reports a fragment that is not an address instead of inventing one', () => {
    expect(parseAddressList('not an address')).toEqual({
      addresses: [],
      rejected: ['not an address'],
    });
    expect(parseAddressList('alice')).toEqual({ addresses: [], rejected: ['alice'] });
    expect(parseAddressList('alice@')).toEqual({ addresses: [], rejected: ['alice@'] });
    expect(parseAddressList('@example.com')).toEqual({
      addresses: [],
      rejected: ['@example.com'],
    });
  });

  it('keeps the addresses either side of a rejected fragment', () => {
    expect(parseAddressList('alice@example.com, rubbish, bob@example.com')).toEqual({
      addresses: [{ email: 'alice@example.com' }, { email: 'bob@example.com' }],
      rejected: ['rubbish'],
    });
  });

  it('rejects an entry with trailing text rather than reading past it', () => {
    // Two addresses jammed together without a separator are not one
    // address plus rubbish, and picking the first would send to someone
    // the user did not finish naming.
    expect(parseAddressList('alice@example.com bob@example.com')).toEqual({
      addresses: [],
      rejected: ['alice@example.com bob@example.com'],
    });
    expect(parseAddressList('<alice@example.com> extra').rejected)
      .toEqual(['<alice@example.com> extra']);
  });

  it('confines an unterminated quote to its own fragment', () => {
    expect(parseAddressList('alice@example.com, "Bob <bob@example.com>')).toEqual({
      addresses: [{ email: 'alice@example.com' }],
      rejected: ['"Bob <bob@example.com>'],
    });
  });

  it('rejects an unclosed angle-addr', () => {
    expect(parseAddressList('Alice <alice@example.com').rejected)
      .toEqual(['Alice <alice@example.com']);
  });

  it('rejects a group whose members cannot all be read', () => {
    // Half-sending to a named group is worse than refusing it.
    expect(parseAddressList('Team: alice@example.com, rubbish;')).toEqual({
      addresses: [],
      rejected: ['Team: alice@example.com, rubbish;'],
    });
    expect(parseAddressList('Team: alice@example.com').rejected)
      .toEqual(['Team: alice@example.com']);
  });

  it('drops stray separators without reporting them', () => {
    expect(parseAddressList(', alice@example.com,, ,bob@example.com,')).toEqual({
      addresses: [{ email: 'alice@example.com' }, { email: 'bob@example.com' }],
      rejected: [],
    });
  });

  it('parses the list shape the compose field actually produces', () => {
    expect(
      parseAddressList('alice@example.com, "Bob B." <bob@example.com>, carol@example.com')
        .addresses,
    ).toEqual([
      { email: 'alice@example.com' },
      { name: 'Bob B.', email: 'bob@example.com' },
      { email: 'carol@example.com' },
    ]);
  });

  it('tolerates the whitespace a paste leaves behind', () => {
    expect(parseAddressList('  alice@example.com ,\n\tbob@example.com  ').addresses)
      .toEqual([{ email: 'alice@example.com' }, { email: 'bob@example.com' }]);
  });

  it('does not treat a nested group as a member', () => {
    // Not in the grammar, and accepting it would let input recurse. The
    // reported fragment ends at the first semicolon, which is where the
    // group it was reading ends; the second is a stray separator.
    expect(parseAddressList('Outer: Inner: alice@example.com;;')).toEqual({
      addresses: [],
      rejected: ['Outer: Inner: alice@example.com;'],
    });
  });

  it('reads back everything formatAddress writes', () => {
    // The recipient field shows formatted text and reparses what the user
    // leaves behind, so a name that survives the round trip is the whole
    // requirement. A comma inside one is the case that used to break it.
    const cases = [
      { email: 'alice@example.com' },
      { name: 'Alice', email: 'alice@example.com' },
      { name: 'Smith, Alice', email: 'alice@example.com' },
      { name: 'Alice "Ally" Example', email: 'alice@example.com' },
      { name: 'Back\\slash', email: 'alice@example.com' },
      { name: 'Alice B. Smith', email: 'alice@example.com' },
      { name: 'Ünal Öz', email: 'ünal@öz.example' },
      { name: 'Team: everyone', email: 'all@example.com' },
      { name: 'a@b', email: 'alice@example.com' },
      // Whitespace a phrase cannot carry: between two unquoted words it is
      // a separator, so only quoting brings it back.
      { name: 'multi  space', email: 'alice@example.com' },
      { name: 'tab\tname', email: 'alice@example.com' },
      { name: 'newline\nname', email: 'alice@example.com' },
      { email: '"alice smith"@example.com' },
      { email: 'alice@[192.0.2.1]' },
    ];
    for (const address of cases) {
      expect(parseAddressList(formatAddress(address)).addresses, formatAddress(address))
        .toEqual([address]);
    }
    expect(parseAddressList(formatAddressList(cases)).addresses).toEqual(cases);
  });

  it('does not let a colon in rejected text swallow the addresses after it', () => {
    // A pasted URL is the common case. Treating its colon as a group's
    // would run the fragment to the end of the input.
    expect(parseAddressList('https://example.com/x, alice@example.com')).toEqual({
      addresses: [{ email: 'alice@example.com' }],
      rejected: ['https://example.com/x'],
    });
    expect(parseAddressList('mailto:alice@example.com, bob@example.com')).toEqual({
      addresses: [{ email: 'bob@example.com' }],
      rejected: ['mailto:alice@example.com'],
    });
  });

  it('does not let a comment that never closes swallow a recipient', () => {
    // The comment syntax makes everything after `(` invisible, so treating
    // an unclosed one as ordinary whitespace ends the list early: this
    // parsed as Alice alone, with nothing rejected and nothing to stop the
    // send, and Bob was never mailed.
    expect(parseAddressList('alice@example.com (Bob <bob@example.com>')).toEqual({
      addresses: [],
      rejected: ['alice@example.com (Bob <bob@example.com>'],
    });
    expect(parseAddressList('alice@example.com (unfinished')).toEqual({
      addresses: [],
      rejected: ['alice@example.com (unfinished'],
    });
    // A comment that opens where an address should start is its own
    // fragment, and the addresses before it are still good.
    expect(parseAddressList('alice@example.com, (unfinished')).toEqual({
      addresses: [{ email: 'alice@example.com' }],
      rejected: ['(unfinished'],
    });
    // Closed comments are still just whitespace, wherever they sit.
    expect(parseAddressList('alice@example.com (Alice)').addresses)
      .toEqual([{ email: 'alice@example.com' }]);
    expect(parseAddressList('(one (two)) alice@example.com').addresses)
      .toEqual([{ email: 'alice@example.com' }]);
  });

  it('requires a comma between group members', () => {
    // A comma dropped while editing would otherwise join two entries into
    // one accepted pair, changing who is addressed without saying so. The
    // same text outside a group is already rejected.
    expect(parseAddressList('Team: alice@example.com bob@example.com;')).toEqual({
      addresses: [],
      rejected: ['Team: alice@example.com bob@example.com;'],
    });
    expect(parseAddressList('Team: alice@example.com, bob@example.com;').addresses)
      .toEqual([{ email: 'alice@example.com' }, { email: 'bob@example.com' }]);
  });

  it('always finishes, whatever it is handed', () => {
    // It runs on every keystroke in a recipient field, so a case that fails
    // to advance the cursor is a frozen composer rather than a wrong answer.
    // The awkward inputs are the unterminated ones: a quote, comment,
    // bracket, or group that never closes has no separator to stop at.
    const inputs = [
      '"', '"unclosed <a@b>', '(', '(nested (deeper', '[', '[unclosed@b', '<', '<a@b',
      ':', ';', ',', ',,,', ';;;', ': ;', 'a:', 'a:;', 'a:b', 'Group: a@b',
      '@', 'a@', '@b', 'a@@b', '.', '..', 'a..b@c', 'a@b..c',
      '\\', '"\\', 'a@b\\', '<>', '<<>>', 'a <b <c@d>>',
      'x'.repeat(5_000), `${'('.repeat(2_000)}a@b`, `${'<'.repeat(2_000)}a@b`,
      'a@b, '.repeat(500), '"a, b'.repeat(500),
    ];
    for (const input of inputs) {
      const started = Date.now();
      const result = parseAddressList(input);
      expect(Array.isArray(result.addresses), JSON.stringify(input.slice(0, 40))).toBe(true);
      expect(Date.now() - started, JSON.stringify(input.slice(0, 40))).toBeLessThan(1_000);
    }
  });

  it('reports what a list held in the order it was written', () => {
    // A control that shows one pill per recipient needs the fragment where
    // the user put it, which is between the two addresses here.
    expect(parseAddressEntries('alice@example.com, rubbish, bob@example.com')).toEqual([
      { address: { email: 'alice@example.com' } },
      { rejected: 'rubbish' },
      { address: { email: 'bob@example.com' } },
    ]);
    // A group is still flattened into its members, each its own entry.
    expect(parseAddressEntries('Team: alice@example.com, bob@example.com;')).toEqual([
      { address: { email: 'alice@example.com' } },
      { address: { email: 'bob@example.com' } },
    ]);
    expect(parseAddressEntries('')).toEqual([]);
    expect(parseAddressEntries(null)).toEqual([]);
  });

  it('keeps the addresses after a stray angle bracket that never closes', () => {
    // `<` opens an angle-addr only if a `>` closes it. With none in the
    // text there is no address here to find, and reading to the end anyway
    // charged the good address after the comma to the broken fragment.
    expect(parseAddressList('broken <a@x, bob@example.com')).toEqual({
      addresses: [{ email: 'bob@example.com' }],
      rejected: ['broken <a@x'],
    });
    expect(parseAddressList('Oops < typo, real@example.com')).toEqual({
      addresses: [{ email: 'real@example.com' }],
      rejected: ['Oops < typo'],
    });
    // A `>` that does exist still bounds the address it belongs to, and a
    // comma inside those brackets is still not a separator.
    expect(parseAddressList('Alice <alice@example.com>, bob@example.com').addresses)
      .toEqual([
        { name: 'Alice', email: 'alice@example.com' },
        { email: 'bob@example.com' },
      ]);
    expect(parseAddressList('broken <a, b>, bob@example.com')).toEqual({
      addresses: [{ email: 'bob@example.com' }],
      rejected: ['broken <a, b>'],
    });
  });

  it('does not read a domain literal that holds a space as an address', () => {
    expect(parseAddressList('a@[foo bar]')).toEqual({
      addresses: [],
      rejected: ['a@[foo bar]'],
    });
    expect(parseAddressList('a@[192.168.0.1]').addresses)
      .toEqual([{ email: 'a@[192.168.0.1]' }]);
    expect(parseAddressList('a@[IPv6:2001:db8::1]').addresses)
      .toEqual([{ email: 'a@[IPv6:2001:db8::1]' }]);
  });

  it('stays linear on a paste every element of which looks like a group', () => {
    // `mailto:` and `https:` are a phrase followed by a colon, which is a
    // group the grammar cannot tell from a real one, and a list of them has
    // no terminating `;` for any of them to end at. Hunting for that
    // terminator once per element is quadratic, and since the field
    // reparses on every keystroke, the cost lands as a freeze per key: at
    // 8,000 entries it measured 2.7s. The `;` inside the quoted string is
    // the case a textual search for a terminator gets wrong — the
    // character is present and means nothing.
    const shapes = [
      'mailto:user@example.com, '.repeat(4_000),
      'G:"a;b", user@example.com, '.repeat(4_000),
    ];
    const control = 'user@example.com, '.repeat(4_000);
    const timed = (input: string) => {
      const started = performance.now();
      parseAddressList(input);
      return performance.now() - started;
    };
    timed(control);
    const baseline = Math.max(timed(control), 1);
    for (const input of shapes) {
      // Generous against a slow machine, tight enough that the quadratic
      // shape cannot hide: it was ~100x the control at this size.
      expect(timed(input) / baseline, input.slice(0, 24)).toBeLessThan(25);
    }
  });

  it('invents nothing and loses nothing, over random input', () => {
    // A fixed sequence rather than a random one, so a failure is a case
    // anybody can rerun. Every address it claims must appear in the text it
    // read, and every fragment it rejects must be text that was there.
    let seed = 20260725;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const alphabet = [...'ab@.,;:<>"()[]\\ \t-_%\u00e9\u4e2d'];
    for (let n = 0; n < 3_000; n += 1) {
      const length = 1 + Math.floor(next() * 24);
      let input = '';
      for (let k = 0; k < length; k += 1) {
        input += alphabet[Math.floor(next() * alphabet.length)];
      }
      const { addresses, rejected } = parseAddressList(input);
      for (const address of addresses) {
        expect(address.email, input).toContain('@');
      }
      for (const fragment of rejected) {
        expect(input, input).toContain(fragment);
      }
    }
  });
});

describe('endsInsideAddress', () => {
  it('says no where an address has just been finished', () => {
    expect(endsInsideAddress('')).toBe(false);
    expect(endsInsideAddress('alice@example.com')).toBe(false);
    expect(endsInsideAddress('"Smith, Alice" <alice@example.com>')).toBe(false);
    expect(endsInsideAddress('(a comment) alice@example.com')).toBe(false);
    expect(endsInsideAddress('Alice <alice@[192.168.0.1]>')).toBe(false);
    expect(endsInsideAddress('alice@example.com, bo')).toBe(false);
  });

  it('says yes while a display name is still open', () => {
    // The next comma typed here belongs to the name, not to the list.
    expect(endsInsideAddress('"Smith')).toBe(true);
    expect(endsInsideAddress('alice@example.com, "Smith')).toBe(true);
  });

  it('says yes while a comment, angle-addr or domain literal is open', () => {
    expect(endsInsideAddress('Alice (the one from')).toBe(true);
    expect(endsInsideAddress('Alice <alice')).toBe(true);
    expect(endsInsideAddress('Alice <alice@[192.168')).toBe(true);
  });

  it('does not mistake an escaped quote for the end of a name', () => {
    expect(endsInsideAddress('"Alice \\" the')).toBe(true);
    expect(endsInsideAddress('"Alice \\"" <alice@example.com>')).toBe(false);
  });

  it('treats a bracket that is not a domain literal as a character', () => {
    // Otherwise a bracket anywhere in a display name suppresses every comma
    // after it, and the field silently stops committing.
    expect(endsInsideAddress('Alice [Work Group]')).toBe(false);
    expect(endsInsideAddress('Alice [Work Group] <alice@example.com>')).toBe(false);
    expect(endsInsideAddress('a@b.com [x y]')).toBe(false);
  });

  it('still says yes to a bracket that never closes', () => {
    expect(endsInsideAddress('Alice [')).toBe(true);
    expect(endsInsideAddress('alice@[192.168')).toBe(true);
  });

  it('finds the angle bracket that closes the address, not one inside it', () => {
    // A quoted local part may hold the character: `<"a>b"@x.com>` is one
    // finished address, and stopping at its first `>` reads the rest as
    // unfinished.
    expect(endsInsideAddress('<"a>b"@example.com>')).toBe(false);
    expect(endsInsideAddress('<"a>b"@example.com')).toBe(true);
  });
});
