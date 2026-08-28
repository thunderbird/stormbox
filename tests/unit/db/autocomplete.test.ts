import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SERVICE_KIND } from '../../../src/constants/states';
import { escapeLike, nextPrefix } from '../../../src/db/autocomplete';
import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers, noopBroadcaster } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { addressKey } from '../../../src/utils/address-key';

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
  const book = await engine.get('SELECT id FROM addressbooks WHERE remote_id = ?', ['ab-default']);
  bookId = book.id;
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

async function usage(email: string, sendCount: number, lastSentAt = NOW) {
  await engine.run(
    `INSERT INTO recipient_usage(account_id, email_key, send_count, last_sent_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, email_key) DO UPDATE SET
       send_count = excluded.send_count,
       last_sent_at = excluded.last_sent_at`,
    [accountId, addressKey(email), sendCount, lastSentAt],
  );
}

function suggest(prefix: string, params: any = {}) {
  return h[DB_RPC.CONTACT_AUTOCOMPLETE]({
    accountId, prefix, limit: 10, nowMs: NOW, ...params,
  });
}

describe('contact-only autocomplete ranking', () => {
  it('orders match tiers before usage boosts', async () => {
    await contact('exact', 'Exact', [{ email: 'alex@example.com' }]);
    await contact('prefix', 'Prefix', [{ email: 'alexander@example.com' }]);
    await contact('name', 'Alex Person', [{ email: 'person@example.net' }]);
    await contact('substring', 'Palex Token', [{ email: 'other@example.net' }]);
    await usage('other@example.net', 100, NOW);

    expect((await suggest('alex')).map((row) => row.email)).toEqual([
      'alex@example.com',
      'alexander@example.com',
      'person@example.net',
      'other@example.net',
    ]);
  });

  it('uses preferred, recent, and frequent boosts within one tier', async () => {
    await contact('plain', 'Same Plain', [{ email: 'same-plain@example.com' }]);
    await contact('preferred', 'Same Preferred', [
      { email: 'same-preferred@example.com', isPreferred: true },
    ]);
    await contact('frequent', 'Same Frequent', [{ email: 'same-frequent@example.com' }]);
    await usage('same-frequent@example.com', 20, NOW - 2 * DAY);

    expect((await suggest('same')).map((row) => row.email)).toEqual([
      'same-frequent@example.com',
      'same-preferred@example.com',
      'same-plain@example.com',
    ]);
    const frequent = (await suggest('same')).find((row) => row.email === 'same-frequent@example.com');
    expect(frequent).toMatchObject({ source: 'contact', send_count: 20, last_sent_at: NOW - 2 * DAY });
  });

  it('never offers usage without a live ContactCard', async () => {
    await usage('orphan@example.com', 50, NOW);
    expect(await suggest('orphan')).toEqual([]);
  });

  it('merges duplicate card rows by canonical address', async () => {
    await contact('one', 'Zulu', [{ email: 'User@bücher.example' }]);
    await contact('two', 'Alpha', [{ email: 'user@xn--bcher-kva.example', isPreferred: true }]);
    await usage('user@xn--bcher-kva.example', 5);

    const rows = await suggest('user@');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'Alpha',
      source: 'contact',
      send_count: 5,
    });
  });

  it('matches unordered name tokens, organization, and substring fallback', async () => {
    await contact('jane', 'Smith, Jane', [{ email: 'jsmith@example.com' }], {
      fullName: 'Jane Smith',
      givenName: 'Jane',
      familyName: 'Smith',
      organization: 'Acme Widgets',
    });

    expect((await suggest('jane smi')).map((row) => row.email)).toEqual(['jsmith@example.com']);
    expect(await suggest('acme')).toEqual([
      expect.objectContaining({
        email: 'jsmith@example.com',
        organization: 'Acme Widgets',
      }),
    ]);
    expect((await suggest('mith')).map((row) => row.email)).toEqual(['jsmith@example.com']);
  });

  it('excludes committed and owned addresses unless the owned address is exact', async () => {
    await contact('me', 'Me', [{ email: 'me@example.com' }]);
    await contact('alice', 'Alice', [{ email: 'alice@example.com' }]);

    expect(await suggest('ali', { exclude: ['ALICE@example.com'] })).toEqual([]);
    expect(await suggest('me')).toEqual([]);
    expect((await suggest('me@example.com')).map((row) => row.email)).toEqual(['me@example.com']);
  });

  it('uses stable alphabetical and address tie-breakers', async () => {
    await contact('z', 'Same', [{ email: 'z@example.com' }]);
    await contact('a', 'Same', [{ email: 'a@example.com' }]);
    expect((await suggest('same')).map((row) => row.email)).toEqual([
      'a@example.com',
      'z@example.com',
    ]);
  });
});

describe('autocomplete query helpers', () => {
  it('escapes SQL wildcard characters', () => {
    expect(escapeLike(String.raw`a%b_c\d`)).toBe(String.raw`a\%b\_c\\d`);
  });

  it('returns no range bound for an empty or maximal prefix', () => {
    expect(nextPrefix('')).toBeNull();
    expect(nextPrefix('\u{10ffff}')).toBeNull();
    expect(nextPrefix('pers')).toBe('pert');
  });
});
