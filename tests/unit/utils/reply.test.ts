import { describe, it, expect } from 'vitest';

import { buildReplyAudience, buildThreadHeaders } from '../../../src/utils/reply';

/** Build `message_addresses` rows the way sync writes them. */
function rows(spec: Record<string, (string | [string, string])[]>) {
  const out = [];
  for (const [kind, list] of Object.entries(spec)) {
    list.forEach((entry, position) => {
      const [name, email] = Array.isArray(entry) ? entry : [null, entry];
      out.push({ kind, position, name, email });
    });
  }
  return out;
}

describe('buildReplyAudience', () => {
  it('replies to the author and nobody else', () => {
    const audience = buildReplyAudience({
      addresses: rows({
        from: [['Alice', 'alice@example.com']],
        to: ['me@example.com', 'bob@example.com'],
        cc: ['carol@example.com'],
      }),
      ownedEmails: ['me@example.com'],
    });

    expect(audience).toEqual({
      to: [{ name: 'Alice', email: 'alice@example.com' }],
      cc: [],
    });
  });

  it('carries the original To and Cc into a reply-all', () => {
    const audience = buildReplyAudience({
      addresses: rows({
        from: [['Alice', 'alice@example.com']],
        to: ['me@example.com', ['Bob', 'bob@example.com']],
        cc: [['Carol', 'carol@example.com']],
      }),
      ownedEmails: ['me@example.com'],
      all: true,
    });

    expect(audience.to).toEqual([{ name: 'Alice', email: 'alice@example.com' }]);
    expect(audience.cc, 'the original Cc is part of the audience (issue #71)').toEqual([
      { name: 'Bob', email: 'bob@example.com' },
      { name: 'Carol', email: 'carol@example.com' },
    ]);
  });

  it('prefers Reply-To over From', () => {
    const addresses = rows({
      from: [['Alice', 'alice@example.com']],
      replyTo: [['Alice at work', 'alice@work.example']],
      to: ['me@example.com'],
    });

    expect(buildReplyAudience({ addresses, ownedEmails: ['me@example.com'] }).to)
      .toEqual([{ name: 'Alice at work', email: 'alice@work.example' }]);
    expect(buildReplyAudience({ addresses, ownedEmails: ['me@example.com'], all: true }).to)
      .toEqual([{ name: 'Alice at work', email: 'alice@work.example' }]);
  });

  it('keeps the author out of Cc when they were also a recipient', () => {
    const audience = buildReplyAudience({
      addresses: rows({
        from: [['Alice', 'alice@example.com']],
        to: ['alice@example.com', 'bob@example.com', 'me@example.com'],
      }),
      ownedEmails: ['me@example.com'],
      all: true,
    });

    expect(audience.to).toEqual([{ name: 'Alice', email: 'alice@example.com' }]);
    expect(audience.cc).toEqual([{ email: 'bob@example.com' }]);
  });

  it('drops exact duplicates and matches addresses case-insensitively', () => {
    const audience = buildReplyAudience({
      addresses: rows({
        from: [['Alice', 'alice@example.com']],
        to: ['bob@example.com', 'BOB@Example.com', ['Bob again', 'bob@example.com']],
        cc: ['bob@EXAMPLE.com', 'carol@example.com'],
      }),
      all: true,
    });

    expect(audience.cc).toEqual([
      { email: 'bob@example.com' },
      { email: 'carol@example.com' },
    ]);
  });

  it('removes every address the user owns, not just the selected identity', () => {
    const audience = buildReplyAudience({
      addresses: rows({
        from: [['Alice', 'alice@example.com']],
        to: ['work@example.com', 'bob@example.com'],
        cc: ['ALIAS@example.com', 'primary@example.com'],
      }),
      ownedEmails: ['work@example.com', 'alias@example.com', 'primary@example.com'],
      all: true,
    });

    expect(audience.cc).toEqual([{ email: 'bob@example.com' }]);
  });

  it('never copies Bcc into a reply', () => {
    // Those recipients were hidden from everyone on the message; a reply
    // that names them discloses what the sender chose not to.
    const audience = buildReplyAudience({
      addresses: rows({
        from: [['Alice', 'alice@example.com']],
        to: ['me@example.com'],
        bcc: ['secret@example.com'],
      }),
      ownedEmails: ['me@example.com'],
      all: true,
    });

    expect(audience.to).toEqual([{ name: 'Alice', email: 'alice@example.com' }]);
    expect(audience.cc).toEqual([]);
  });

  it('replies to the recipients of the user own message rather than to the user', () => {
    // Reply All on something in Sent: the author is the user, and removing
    // owned addresses from the audience would leave the reply going
    // nowhere but back to themselves.
    const audience = buildReplyAudience({
      addresses: rows({
        from: [['Me', 'me@example.com']],
        to: [['Alice', 'alice@example.com']],
        cc: [['Bob', 'bob@example.com']],
      }),
      ownedEmails: ['me@example.com'],
      all: true,
    });

    expect(audience.to).toEqual([{ name: 'Alice', email: 'alice@example.com' }]);
    expect(audience.cc).toEqual([{ name: 'Bob', email: 'bob@example.com' }]);
  });

  it('replies to whom the user addressed, not to the user, on a plain reply too', () => {
    // Plain Reply on something in Sent. Replying to yourself achieves
    // nothing, so the narrow target is the person the message went to; what
    // Reply All adds is the Cc.
    const audience = buildReplyAudience({
      addresses: rows({
        from: [['Me', 'me@example.com']],
        to: [['Alice', 'alice@example.com']],
        cc: [['Bob', 'bob@example.com']],
      }),
      ownedEmails: ['me@example.com'],
    });

    expect(audience.to).toEqual([{ name: 'Alice', email: 'alice@example.com' }]);
    expect(audience.cc).toEqual([]);
  });

  it('does not read an owned Reply-To as the user having sent it', () => {
    // Alice wrote it and asked for replies here. Treating that as the
    // user's own message put her other recipient, Bob, into a plain reply
    // the user never addressed to him.
    const addresses = rows({
      from: [['Alice', 'alice@example.com']],
      replyTo: ['me@example.com'],
      to: ['me@example.com', ['Bob', 'bob@example.com']],
    });

    expect(buildReplyAudience({ addresses, ownedEmails: ['me@example.com'] }))
      .toEqual({ to: [{ name: 'Alice', email: 'alice@example.com' }], cc: [] });
    // Reply All still carries the rest of the audience, minus the user.
    expect(buildReplyAudience({ addresses, ownedEmails: ['me@example.com'], all: true }))
      .toEqual({
        to: [{ name: 'Alice', email: 'alice@example.com' }],
        cc: [{ name: 'Bob', email: 'bob@example.com' }],
      });
  });

  it('keeps the addresses of a Reply-To that only partly belongs to the user', () => {
    // The user's own address must come out of it either way; requiring the
    // whole header to be theirs before doing anything left it addressed.
    const audience = buildReplyAudience({
      addresses: rows({
        from: [['Alice', 'alice@example.com']],
        replyTo: ['me@example.com', ['Team', 'team@example.com']],
        to: ['me@example.com'],
      }),
      ownedEmails: ['me@example.com'],
    });

    expect(audience.to).toEqual([{ name: 'Team', email: 'team@example.com' }]);
  });

  it('does not mail the user a copy of a reply to their own message', () => {
    // Copying themselves on the original does not mean they want the reply
    // as well, and the rule that a reply never addresses the user holds here
    // too — as long as somebody else is left to send it to.
    const addresses = rows({
      from: [['Me', 'me@example.com']],
      to: ['me@example.com', ['Alice', 'alice@example.com']],
    });

    expect(buildReplyAudience({ addresses, ownedEmails: ['me@example.com'] }).to)
      .toEqual([{ name: 'Alice', email: 'alice@example.com' }]);
    expect(buildReplyAudience({ addresses, ownedEmails: ['me@example.com'], all: true }))
      .toEqual({ to: [{ name: 'Alice', email: 'alice@example.com' }], cc: [] });
  });

  it('recognises an owned address that arrives padded with whitespace', () => {
    // These come from an identity row and an account column, not from a
    // parser, so one stray space would leave the user in their own audience.
    const audience = buildReplyAudience({
      addresses: rows({ from: [['Alice', 'alice@example.com']], to: ['me@example.com', 'bob@example.com'] }),
      ownedEmails: [' Me@Example.com '],
      all: true,
    });

    expect(audience.cc).toEqual([{ email: 'bob@example.com' }]);
  });

  it('keeps a note-to-self addressed to the user', () => {
    const audience = buildReplyAudience({
      addresses: rows({ from: [['Me', 'me@example.com']], to: ['me@example.com'] }),
      ownedEmails: ['me@example.com'],
      all: true,
    });

    expect(audience.to).toEqual([{ email: 'me@example.com' }]);
    expect(audience.cc).toEqual([]);
  });

  it('replies to the Cc of the user\'s own message that had no To', () => {
    // Sent Cc-only, which is the audience the rule for one's own messages
    // means; replying to the user instead addresses nobody who was on it.
    const addresses = rows({
      from: [['Me', 'me@example.com']],
      cc: ['alice@example.com', 'bob@example.com'],
    });

    expect(buildReplyAudience({ addresses, ownedEmails: ['me@example.com'] }))
      .toEqual({
        to: [{ email: 'alice@example.com' }, { email: 'bob@example.com' }],
        cc: [],
      });
    // Reply All keeps the same audience: everyone on it is already in To,
    // and nobody belongs in Cc twice.
    expect(buildReplyAudience({ addresses, ownedEmails: ['me@example.com'], all: true }))
      .toEqual({
        to: [{ email: 'alice@example.com' }, { email: 'bob@example.com' }],
        cc: [],
      });
  });

  it('falls back to the author when their own message names no recipient', () => {
    // A message sent Bcc-only has no To to carry forward, and an empty
    // audience would leave the composer with nowhere to send.
    const audience = buildReplyAudience({
      addresses: rows({ from: [['Me', 'me@example.com']], bcc: ['secret@example.com'] }),
      ownedEmails: ['me@example.com'],
      all: true,
    });

    expect(audience.to).toEqual([{ name: 'Me', email: 'me@example.com' }]);
    expect(audience.cc).toEqual([]);
  });

  it('preserves header order and ignores rows with no address', () => {
    const audience = buildReplyAudience({
      addresses: [
        { kind: 'from', position: 0, name: 'Alice', email: 'alice@example.com' },
        { kind: 'to', position: 2, name: null, email: 'third@example.com' },
        { kind: 'to', position: 0, name: null, email: 'first@example.com' },
        { kind: 'to', position: 1, name: 'No address', email: null },
      ],
      all: true,
    });

    expect(audience.cc).toEqual([
      { email: 'first@example.com' },
      { email: 'third@example.com' },
    ]);
  });

  it('says nothing when the parent has no addresses at all', () => {
    expect(buildReplyAudience({ addresses: [] })).toEqual({ to: [], cc: [] });
    expect(buildReplyAudience({ addresses: [], all: true })).toEqual({ to: [], cc: [] });
  });

  it('recognizes an owned address across Unicode normalization forms (CS-3.5)', () => {
    // The identity row holds NFC; a server may return the same address NFD.
    const audience = buildReplyAudience({
      addresses: rows({
        from: [['Alice', 'alice@example.com']],
        to: ['jose\u0301@example.com', 'bob@example.com'],
      }),
      ownedEmails: ['jos\u00e9@example.com'],
      all: true,
    });

    expect(audience.to).toEqual([{ name: 'Alice', email: 'alice@example.com' }]);
    expect(
      audience.cc.map((a) => a.email),
      'the NFD spelling of the owned address must be suppressed',
    ).toEqual(['bob@example.com']);
  });

  it('recognizes an owned Unicode domain against its punycode spelling (CS-3.5)', () => {
    const audience = buildReplyAudience({
      addresses: rows({
        from: [['Alice', 'alice@example.com']],
        to: ['me@xn--mnchen-3ya.de', 'bob@example.com'],
      }),
      ownedEmails: ['me@m\u00fcnchen.de'],
      all: true,
    });

    expect(
      audience.cc.map((a) => a.email),
      'the punycode spelling of the owned domain must be suppressed',
    ).toEqual(['bob@example.com']);
  });
});

describe('buildThreadHeaders', () => {
  it('points In-Reply-To at the parent and starts a References chain', () => {
    expect(buildThreadHeaders({ rfc822_message_id: 'parent@example.com' })).toEqual({
      inReplyTo: ['parent@example.com'],
      references: ['parent@example.com'],
    });
  });

  it('extends the parent References with the parent itself', () => {
    expect(buildThreadHeaders({
      rfc822_message_id: 'third@example.com',
      references_json: JSON.stringify(['first@example.com', 'second@example.com']),
    })).toEqual({
      inReplyTo: ['third@example.com'],
      references: ['first@example.com', 'second@example.com', 'third@example.com'],
    });
  });

  it('uses the parent In-Reply-To when it carried no References', () => {
    expect(buildThreadHeaders({
      rfc822_message_id: 'second@example.com',
      in_reply_to_json: JSON.stringify(['first@example.com']),
    })).toEqual({
      inReplyTo: ['second@example.com'],
      references: ['first@example.com', 'second@example.com'],
    });
  });

  it('does not substitute a multi-id In-Reply-To for missing References (RFC 5322 §3.6.4)', () => {
    // The substitution is permitted only when the parent's In-Reply-To
    // "contains a single message identifier"; otherwise References is the
    // parent's Message-ID alone.
    expect(buildThreadHeaders({
      rfc822_message_id: 'third@example.com',
      in_reply_to_json: JSON.stringify(['first@example.com', 'second@example.com']),
    })).toEqual({
      inReplyTo: ['third@example.com'],
      references: ['third@example.com'],
    });
  });

  it('prefers References when the parent carried both', () => {
    expect(buildThreadHeaders({
      rfc822_message_id: 'third@example.com',
      references_json: JSON.stringify(['first@example.com', 'second@example.com']),
      in_reply_to_json: JSON.stringify(['second@example.com']),
    }).references).toEqual([
      'first@example.com',
      'second@example.com',
      'third@example.com',
    ]);
  });

  it('strips angle brackets, because the cache and JMAP both hold bare ids', () => {
    expect(buildThreadHeaders({
      rfc822_message_id: '<second@example.com>',
      references_json: JSON.stringify(['<first@example.com>']),
    })).toEqual({
      inReplyTo: ['second@example.com'],
      references: ['first@example.com', 'second@example.com'],
    });
  });

  it('does not repeat the parent when it already appears in References', () => {
    expect(buildThreadHeaders({
      rfc822_message_id: 'second@example.com',
      references_json: JSON.stringify(['first@example.com', 'second@example.com']),
    }).references).toEqual(['first@example.com', 'second@example.com']);
  });

  it('threads nothing when the parent has no Message-ID', () => {
    // Nothing to point at, and an invented id would attach the reply to a
    // message that does not exist.
    expect(buildThreadHeaders({ rfc822_message_id: null })).toEqual({
      inReplyTo: [],
      references: [],
    });
    expect(buildThreadHeaders({
      rfc822_message_id: '   ',
      references_json: JSON.stringify(['first@example.com']),
    })).toEqual({ inReplyTo: [], references: [] });
  });

  it('survives unreadable cached JSON', () => {
    expect(buildThreadHeaders({
      rfc822_message_id: 'parent@example.com',
      references_json: 'not json',
    })).toEqual({
      inReplyTo: ['parent@example.com'],
      references: ['parent@example.com'],
    });
    expect(buildThreadHeaders({
      rfc822_message_id: 'parent@example.com',
      references_json: JSON.stringify({ not: 'an array' }),
    }).references).toEqual(['parent@example.com']);
  });
});
