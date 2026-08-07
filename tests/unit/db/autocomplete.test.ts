import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SERVICE_KIND } from '../../../src/constants/states';
import { escapeLike } from '../../../src/db/autocomplete';
import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers, noopBroadcaster } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';

/**
 * Ranking and exclusion (CS-3.4, CS-3.6, CS-3.7).
 *
 * The point of these is order, not membership: which suggestion comes first
 * is the whole of what makes a typeahead usable, and the requirement is that
 * the order be derived from match quality rather than from whichever query
 * ran first.
 */

let engine: any;
let h: any;
let accountId: number;
let bookId: number;

const NOW = Date.UTC(2026, 0, 15);
const DAY = 86_400_000;

beforeEach(async () => {
  engine = await bootTestEngine();
  h = makeHandlers(engine, noopBroadcaster());
  await engine.run(
    `INSERT INTO accounts(
       id, display_name, primary_email, server_origin, remote_account_id,
       created_at, updated_at
     ) VALUES (1, 'Me', 'me@example.com', 'https://mail.example.com', 'acct-1', 0, 0)`,
  );
  accountId = 1;
  await h[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
    accountId,
    serviceKind: SERVICE_KIND.JMAP_CONTACTS,
    addressbooks: [{ remoteId: 'ab-default', isDefault: true, name: 'Default' }],
  });
  const ab = await engine.get('SELECT id FROM addressbooks WHERE remote_id = ?', ['ab-default']);
  bookId = ab.id;
});

afterEach(async () => {
  await engine.close();
});

async function contact(remoteId: string, displayName: string, emails: any[], extra: any = {}) {
  await h[DB_RPC.CONTACT_UPSERT_MANY]({
    accountId,
    contacts: [{ addressbookIds: [bookId], remoteId, displayName, emails, ...extra }],
  });
}

async function learned(email: string, name: string | null, times = 1, lastSentAt = NOW) {
  for (let i = 0; i < times; i += 1) {
    await h[DB_RPC.RECIPIENT_HISTORY_RECORD]({ accountId, recipients: [{ email, name }] });
  }
  await engine.run(
    `UPDATE recipient_history SET last_sent_at = ? WHERE account_id = ? AND email_key = ?`,
    [lastSentAt, accountId, email.toLowerCase()],
  );
}

function suggest(prefix: string, params: any = {}) {
  return h[DB_RPC.CONTACT_AUTOCOMPLETE]({
    accountId, prefix, limit: 10, nowMs: NOW, ...params,
  });
}

describe('autocomplete ranking (CS-3.6)', () => {
  it('puts an exact learned address above a contact matched only by substring', async () => {
    // For this to be about *ordering*, the contact has to actually be a
    // candidate. Typing a whole address yields one word per address part —
    // here `lex`, `example`, `com` — and the substring tier requires a
    // contact to match every one of them. So the contact needs `lex` inside a
    // name word and the domain's words somewhere too, which its organization
    // supplies. Without that it never enters the list, and the assertion below
    // holds however the tiers are ranked.
    await contact('c-weak', 'Alexander Notthisperson', [{ email: 'alex@other.example' }], {
      organization: 'Example.com Ltd',
    });
    // ...against an address the user has typed in full before.
    await learned('lex@example.com', 'Lex');

    const matches = await suggest('lex@example.com');

    expect(
      matches.map((m: any) => m.email),
      'the contact is in the running, and second to the address typed in full',
    ).toEqual(['lex@example.com', 'alex@other.example']);
    expect(matches[0].source).toBe('history');
  });

  it('orders address prefix above name match, and name above substring', async () => {
    await contact('c-addr', 'Zoe Zebra', [{ email: 'jam@example.com' }]);
    await contact('c-name', 'Jam Baker', [{ email: 'baker@example.com' }]);
    await contact('c-sub', 'Pyjamas Person', [{ email: 'pj@example.com' }]);

    const matches = await suggest('jam');
    expect(matches.map((m: any) => m.email)).toEqual([
      'jam@example.com',
      'baker@example.com',
      'pj@example.com',
    ]);
  });

  it('prefers the preferred address of a contact within a tier', async () => {
    await contact('c-two', 'Robin Banks', [
      { email: 'robin.secondary@example.com' },
      { email: 'robin.main@example.com', isPreferred: true },
    ]);

    const matches = await suggest('robin');
    expect(matches[0].email).toBe('robin.main@example.com');
  });

  it('prefers the recent and the frequent among equal matches', async () => {
    await learned('stale@example.com', 'Stale', 1, NOW - 400 * DAY);
    await learned('recent@example.com', 'Recent', 1, NOW - 2 * DAY);
    await learned('frequent@example.com', 'Frequent', 25, NOW - 20 * DAY);

    const matches = await suggest('e', { limit: 10 });
    const order = matches.map((m: any) => m.email);
    // Recent (3) + once (0) = 3; frequent (2) + often (3) = 5; stale = 0.
    expect(order.indexOf('frequent@example.com')).toBeLessThan(order.indexOf('recent@example.com'));
    expect(order.indexOf('recent@example.com')).toBeLessThan(order.indexOf('stale@example.com'));
  });

  it('does not reorder as the clock moves within a bucket', async () => {
    await learned('a@example.com', 'A', 1, NOW - 2 * DAY);
    await learned('b@example.com', 'B', 1, NOW - 5 * DAY);

    const early = await suggest('example', { nowMs: NOW });
    const later = await suggest('example', { nowMs: NOW + DAY });
    expect(later.map((m: any) => m.email)).toEqual(early.map((m: any) => m.email));
  });

  it('takes the most recent matches when more match than the query reads', async () => {
    // The `ORDER BY` on the history query is what decides *which* rows survive
    // the intermediate limit, and two things are needed to see it work.
    //
    // There must be more matching rows than the pool: `poolSize(5)` is 40, so
    // 30 rows — which is what this case used to seed — are all read whatever
    // the order, and the assertion held with the `ORDER BY` deleted.
    //
    // And the newest rows must not also be the first ones stored, or an
    // unordered scan would sweep them up by accident. Inserted oldest first,
    // the 40 rows an unordered read reaches are the 40 *oldest*, and the five
    // it would then offer are five nobody asked for.
    // Recency is scored in buckets, not as a curve, so rows days apart tie and
    // the answer would turn on the name tiebreak instead. These are a year
    // apart: five sent this week, forty-five sent long enough ago to score
    // nothing, and the five stored last.
    for (let i = 0; i < 45; i += 1) {
      await learned(`bulk-${i}@example.com`, `Bulk ${i}`, 1, NOW - 400 * DAY);
    }
    for (let i = 45; i < 50; i += 1) {
      await learned(`bulk-${i}@example.com`, `Bulk ${i}`, 1, NOW - DAY);
    }

    const first = await suggest('bulk', { limit: 5 });
    const second = await suggest('bulk', { limit: 5 });

    // An unordered read would keep the forty it reached first — the old ones —
    // and offer five of those, which is the defect CS-3.6 names.
    expect(first.map((m: any) => m.email)).toEqual([
      'bulk-45@example.com',
      'bulk-46@example.com',
      'bulk-47@example.com',
      'bulk-48@example.com',
      'bulk-49@example.com',
    ]);
    expect(second, 'and the same query twice is the same answer').toEqual(first);
  });

  it('takes the contact name over the learned one even when the learned row is found first', async () => {
    // The queries run cheapest-tier-first, so a learned row can arrive
    // before the contact that shares its address. Here "lex" starts the
    // learned name but only sits inside the contact's, so the learned row
    // is found a whole tier earlier.
    await contact('c-alex', 'Alexander', [{ email: 'x@example.com' }]);
    await learned('x@example.com', 'Lex Formal');

    const matches = await suggest('lex');
    expect(matches).toHaveLength(1);
    // Arrival order must not decide this: contact metadata wins (CS-3.4).
    expect(matches[0].name).toBe('Alexander');
    expect(matches[0].source).toBe('contact');
  });

  it('offers an exact match that ranks outside the candidate pool', async () => {
    // Enough learned addresses share the typed text to fill the pool, and
    // the exact one is the least recently used, so it sorts last of all.
    await learned('team@example.com', 'The Team', 1, NOW - 900 * DAY);
    for (let i = 0; i < 60; i += 1) {
      await learned(`team@example.com.dept${i}`, `Dept ${i}`, 1, NOW - i * 1000);
    }

    const matches = await suggest('team@example.com', { limit: 5 });
    // Only a lookup by equality can find it: any bounded pass over the
    // prefix, however it is ordered, can leave a matching row out.
    expect(matches[0].email).toBe('team@example.com');
  });

  it('applies the limit after merging, not to each pool', async () => {
    // Five contacts and five learned addresses all match, and every learned
    // address is also a contact. Merging must leave five rows, not ten, and
    // a limit of five must therefore be full rather than half duplicates.
    for (let i = 0; i < 5; i += 1) {
      await contact(`c-${i}`, `Pair ${i}`, [{ email: `pair-${i}@example.com` }]);
      await learned(`pair-${i}@example.com`, `Pair ${i} learned`);
    }
    const matches = await suggest('pair', { limit: 5 });
    expect(matches).toHaveLength(5);
    expect(new Set(matches.map((m: any) => m.email)).size).toBe(5);
  });
});

describe('autocomplete exclusions (CS-3.7)', () => {
  it('still reaches the substring tier when the excluded rows would fill the list', async () => {
    // The cheap tiers are allowed to skip the substring scan once the list is
    // full, and "full" has to mean rows the user can actually be offered. All
    // three prefix matches here are already in the message, so counting them
    // hid the one match that was left to find.
    const entered = ['sam-1@example.com', 'sam-2@example.com', 'sam-3@example.com'];
    for (const [i, email] of entered.entries()) {
      await contact(`c-pre-${i}`, `Sam Prefix ${i}`, [{ email }]);
    }
    // Reachable only by the substring tier: "sam" sits inside "balsamic"
    // rather than starting it, and appears nowhere in the address, so no
    // prefix query can find this one.
    await contact('c-sub', 'Wilhelmina Balsamic', [{ email: 'w@example.com' }]);

    const rows = await suggest('sam', { limit: 3, exclude: entered });

    expect(rows.map((r: any) => r.email)).toEqual(['w@example.com']);
  });

  it('does not offer an address already entered, in any field', async () => {
    await contact('c-1', 'Jane Doe', [{ email: 'jane@example.com' }]);
    await contact('c-2', 'Janet Roe', [{ email: 'janet@example.com' }]);

    const matches = await suggest('jan', { exclude: ['jane@example.com'] });
    expect(matches.map((m: any) => m.email)).toEqual(['janet@example.com']);
  });

  it('matches an already-entered address by its normalized form', async () => {
    await contact('c-1', 'Jane Doe', [{ email: 'Jane@Example.com' }]);
    // The pill holds what the user typed, which need not be the spelling
    // the contact is stored under. Comparing verbatim would offer a
    // duplicate of a recipient already in the field.
    const matches = await suggest('jane', { exclude: ['  jane@EXAMPLE.com '] });
    expect(matches).toEqual([]);
  });

  it('suppresses the user\'s own addresses until one is typed in full', async () => {
    await engine.run(
      `INSERT INTO identities(account_id, remote_id, name, email, updated_at)
       VALUES (?, 'i-1', 'Me', 'alias@example.com', 0)`,
      [accountId],
    );
    await learned('alias@example.com', 'Me');
    await learned('alistair@example.com', 'Alistair');

    const onPrefix = await suggest('ali');
    expect(onPrefix.map((m: any) => m.email)).toEqual(['alistair@example.com']);

    // Mailing yourself is deliberate when you do it and noise when you
    // don't; typing the whole address is what separates the two.
    const typedInFull = await suggest('alias@example.com');
    expect(typedInFull.map((m: any) => m.email)).toEqual(['alias@example.com']);
  });

  it('suppresses the account address as well as its identities', async () => {
    await learned('me@example.com', 'Me');
    // A partial address is not "typed one exactly", so it stays suppressed
    // right up to the last character.
    expect(await suggest('me@')).toEqual([]);
    expect((await suggest('m')).map((m: any) => m.email)).not.toContain('me@example.com');
    expect((await suggest('me@example.com')).map((m: any) => m.email))
      .toEqual(['me@example.com']);
  });
});

describe('learned recipients (CS-3.3, CS-3.13)', () => {
  it('counts a repeat send rather than adding a second row', async () => {
    await learned('repeat@example.com', 'Repeat', 3);
    const row = await engine.get(
      `SELECT send_count, name FROM recipient_history WHERE account_id = ? AND email_key = ?`,
      [accountId, 'repeat@example.com'],
    );
    expect(row.send_count).toBe(3);
  });

  it('keeps a name it has been taught when a later send carries none', async () => {
    await h[DB_RPC.RECIPIENT_HISTORY_RECORD]({
      accountId, recipients: [{ email: 'named@example.com', name: 'Real Name' }],
    });
    await h[DB_RPC.RECIPIENT_HISTORY_RECORD]({
      accountId, recipients: [{ email: 'named@example.com', name: null }],
    });
    const matches = await suggest('named@example.com');
    expect(matches[0].name).toBe('Real Name');
  });

  it('learns one recipient, counted once, from two spellings in one send', async () => {
    // One message addressed to one person, whether the address was written
    // twice in different case or put in both To and Cc. Send frequency is a
    // ranking input (CS-3.6), so counting it twice promotes the address for
    // something the user did not do.
    await h[DB_RPC.RECIPIENT_HISTORY_RECORD]({
      accountId,
      recipients: [
        { email: 'Twice@Example.com', name: 'Twice' },
        { email: 'twice@example.com', name: 'Twice' },
      ],
    });
    const rows = await engine.all(
      `SELECT send_count FROM recipient_history WHERE account_id = ?`, [accountId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].send_count, 'one send, one count').toBe(1);
  });

  it('takes a name from whichever field of one send carried it', async () => {
    // The same address in two fields, named in only one of them.
    await h[DB_RPC.RECIPIENT_HISTORY_RECORD]({
      accountId,
      recipients: [
        { email: 'both@example.com', name: null },
        { email: 'both@example.com', name: 'Named Once' },
      ],
    });
    const rows = await engine.all(
      `SELECT name, send_count FROM recipient_history WHERE account_id = ?`, [accountId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Named Once');
    expect(rows[0].send_count).toBe(1);
  });

  it('does not offer to forget an address the address book also holds', async () => {
    // Only a learned address can be forgotten (CS-3.13), and the control
    // decides that from `source`. A contact with no name at all ranks below a
    // history row that has one, so the history row wins the *name* — and used
    // to take the source with it. The result was a suggestion that offered its
    // own removal, reported success, and came back on the next keystroke,
    // because the address book still supplied the address.
    await contact('c-1', null, [{ email: 'bob@example.com' }]);
    await learned('bob@example.com', 'Bob Learned');

    const [row] = await suggest('bob');
    expect(row.name, 'the learned name is still the better one to show').toBe('Bob Learned');
    expect(row.source, 'but the address is in the address book, so it is not forgettable')
      .toBe('contact');

    // And the substance of it: suppressing the history row cannot make this
    // address go away, which is why it must not be offered.
    await h[DB_RPC.RECIPIENT_HISTORY_SUPPRESS]({ accountId, email: 'bob@example.com' });
    expect((await suggest('bob')).length, 'the contact still supplies it').toBe(1);
  });

  it('stops offering a suggestion the user removed, and keeps it removed', async () => {
    await learned('unwanted@example.com', 'Unwanted');
    expect((await suggest('unwanted')).length).toBe(1);

    await h[DB_RPC.RECIPIENT_HISTORY_SUPPRESS]({ accountId, email: 'Unwanted@Example.com' });
    expect(await suggest('unwanted')).toEqual([]);

    // Sending again must not undo the removal, or the control would look
    // like it had never worked.
    await learned('unwanted@example.com', 'Unwanted');
    expect(await suggest('unwanted')).toEqual([]);
  });

  it('forgets every learned recipient when the history is cleared', async () => {
    await learned('one@example.com', 'One');
    await learned('two@example.com', 'Two');
    await contact('c-keep', 'Kept Contact', [{ email: 'kept@example.com' }]);

    const { cleared } = await h[DB_RPC.RECIPIENT_HISTORY_CLEAR]({ accountId });
    expect(cleared).toBe(2);
    expect(await suggest('one')).toEqual([]);
    // Clearing learned addresses must not touch the address book.
    expect((await suggest('kept')).map((m: any) => m.email)).toEqual(['kept@example.com']);
  });

  it('keeps a removal the user asked for through a clear, and a later send', async () => {
    // Two different statements: "forget what you have collected" and "never
    // suggest this one". A clear must not undo the second, or an address the
    // user deliberately removed returns the next time they write to it.
    await learned('banished@example.com', 'Banished');
    await h[DB_RPC.RECIPIENT_HISTORY_SUPPRESS]({ accountId, email: 'banished@example.com' });
    await learned('ordinary@example.com', 'Ordinary');

    const { cleared } = await h[DB_RPC.RECIPIENT_HISTORY_CLEAR]({ accountId });
    expect(cleared, 'only the row that was still being suggested is counted').toBe(1);

    // Through the handler, not the helper: the helper sets `last_sent_at` with
    // raw SQL, which would prove nothing about what a send does.
    await h[DB_RPC.RECIPIENT_HISTORY_RECORD]({
      accountId, recipients: [{ email: 'banished@example.com', name: 'Banished' }],
    });
    expect(await suggest('banished'), 'still refused after a clear and a send').toEqual([]);
    // And what the tombstone keeps is the refusal, not the history behind it.
    const row = await engine.get(
      `SELECT name, send_count, last_sent_at FROM recipient_history
        WHERE account_id = ? AND email_key = ?`,
      [accountId, 'banished@example.com'],
    );
    expect(row.name).toBeNull();
    expect(row.last_sent_at).toBeNull();
  });

  it('ignores a recipient with no usable address', async () => {
    const { learned: count } = await h[DB_RPC.RECIPIENT_HISTORY_RECORD]({
      accountId,
      recipients: [{ email: '', name: 'Nobody' }, { email: null, name: 'Nobody' }],
    });
    expect(count).toBe(0);
  });
});

describe('autocomplete input handling', () => {
  it('offers nothing for empty input', async () => {
    await contact('c-1', 'Jane Doe', [{ email: 'jane@example.com' }]);
    expect(await suggest('')).toEqual([]);
    expect(await suggest('   ')).toEqual([]);
  });

  it('offers nothing for a typed wildcard rather than everything', async () => {
    await contact('c-1', 'Percent Person', [{ email: 'pc@example.com' }]);
    // A wildcard is not a word, so it yields no search terms at all and no
    // LIKE query is issued. That is the reason `escapeLike` cannot be reached
    // from here, and why it is tested on its own below.
    expect(await suggest('%')).toEqual([]);
    expect(await suggest('_')).toEqual([]);
  });

  it('leaves out a contact the server deleted', async () => {
    await contact('c-gone', 'Ghost Person', [{ email: 'ghost@example.com' }]);
    await h[DB_RPC.CONTACT_DELETE_LOCAL]({ accountId, remoteId: 'c-gone' });
    expect(await suggest('ghost')).toEqual([]);
  });
});

/**
 * The LIKE guard, tested where it can be.
 *
 * `nameTokens` admits only letters, numbers, apostrophes and hyphens, so no
 * wildcard survives to reach this — which means no query can exercise it, and
 * a test that went through the autocomplete would pass with the escaping
 * removed. It is kept because widening that character class is a small,
 * plausible edit whose effect here would be silent: typed text would quietly
 * become a pattern and every query would match more than it should.
 */
describe('escaping a LIKE pattern', () => {
  it('makes wildcards ordinary characters', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('%_%')).toBe('\\%\\_\\%');
  });

  it('escapes the escape character itself, so it cannot be smuggled in', () => {
    // Without this, `\%` would arrive at SQLite as an escaped wildcard the
    // caller did not write.
    expect(escapeLike('a\\b')).toBe('a\\\\b');
    expect(escapeLike('\\%')).toBe('\\\\\\%');
  });

  it('leaves an ordinary word exactly as it was', () => {
    expect(escapeLike("o'brien-smith")).toBe("o'brien-smith");
    expect(escapeLike('josé')).toBe('josé');
  });
});

/**
 * The ways a person types a name they half remember (CS-3.2, CS-5.3).
 *
 * Each of these is a distinct source or shape rather than a variation on
 * one: a different stored field, a different word order, a different case,
 * a different script. They are listed one by one in the requirement because
 * an implementation can easily satisfy some and not others.
 */
describe('finding a contact by the name the user remembers (CS-3.2)', () => {
  const emails = [{ email: 'rk@example.com' }];

  it('finds them by given name and by family name alike', async () => {
    await contact('c-1', 'Smith, Rosalind', emails, {
      givenName: 'Rosalind',
      familyName: 'Smith',
    });
    expect((await suggest('rosalind')).map((r: any) => r.email)).toEqual(['rk@example.com']);
    expect((await suggest('smith')).map((r: any) => r.email)).toEqual(['rk@example.com']);
  });

  it('finds them by their organization', async () => {
    await contact('c-1', 'Rosalind Franklin', emails, { organization: 'Birkbeck College' });
    expect((await suggest('birkbeck')).map((r: any) => r.email)).toEqual(['rk@example.com']);
  });

  it('finds them with the name words in either order', async () => {
    await contact('c-1', 'Smith, Rosalind', emails, {
      givenName: 'Rosalind',
      familyName: 'Smith',
    });
    // The stored order is "Smith, Rosalind"; this is the other one, typed as
    // two partial words.
    expect((await suggest('rosa smi')).map((r: any) => r.email)).toEqual(['rk@example.com']);
  });

  it('ignores the case of what was typed and of what was stored', async () => {
    await contact('c-1', 'ROSALIND Smith', [{ email: 'RK@Example.COM' }]);
    expect((await suggest('rosalind')).length, 'stored upper, typed lower').toBe(1);
    expect((await suggest('ROSA')).length, 'typed upper, stored upper').toBe(1);
    expect((await suggest('rk@example.com')).length, 'and the address either way').toBe(1);
  });

  it('finds an accented name by the accented word', async () => {
    await contact('c-1', 'Émile Zöllner', [{ email: 'emile@example.com' }]);
    expect((await suggest('émile')).map((r: any) => r.email)).toEqual(['emile@example.com']);
    expect((await suggest('zöll')).map((r: any) => r.email)).toEqual(['emile@example.com']);
  });

  it('finds an address written in capitals outside ASCII', async () => {
    // SQLite's `lower()` folds A-Z and leaves every other letter alone, so a
    // key derived in SQL disagreed with the one the query builds in
    // JavaScript, and this contact was unreachable by address in every tier —
    // including by the address exactly as stored. CS-3.1 asks for both ways in.
    await contact('c-1', 'José Uppercase', [{ email: 'JOSÉ@example.com' }]);

    expect(
      (await suggest('josé')).map((r: any) => r.email),
      'by the folded prefix',
    ).toEqual(['JOSÉ@example.com']);
    expect(
      (await suggest('josé@example.com')).map((r: any) => r.email),
      'by the whole address, folded',
    ).toEqual(['JOSÉ@example.com']);
    expect(
      (await suggest('JOSÉ@example.com')).map((r: any) => r.email),
      'and by the address exactly as it is stored',
    ).toEqual(['JOSÉ@example.com']);
  });

  it('finds a contact by a nickname (CS-3.2)', async () => {
    await contact('c-nick', 'Robert Paulson', [{ email: 'robert@example.com' }], {
      nicknames: ['Bob'],
    });

    expect((await suggest('bob')).map((r: any) => r.email))
      .toEqual(['robert@example.com']);
  });

  it('prefix-matches a Unicode domain against the punycode key the store holds', async () => {
    // `contact_emails.email_key` holds `jane@xn--mnchen-3ya.dev`. The typed
    // text folds to the same punycode spelling (a whole label encodes to a
    // prefix of the stored label run), so the address-prefix range must be
    // driven by the folded key, the same one the history pool scans with —
    // the raw typed Unicode can never prefix-match the stored form. The name
    // tier cannot rescue this contact: `münchen` is not among its name words.
    await contact('c-idn', 'Jane Weber', [{ email: 'jane@münchen.dev' }]);

    expect(
      (await suggest('jane@münchen.de')).map((r: any) => r.email),
      'a typed Unicode domain reaches the punycode-keyed row',
    ).toEqual(['jane@münchen.dev']);
  });
});
