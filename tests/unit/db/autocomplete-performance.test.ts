import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTACT_ADDRESS_EXACT_SQL,
  CONTACT_ADDRESS_PREFIX_SQL,
  CONTACT_TOKEN_PREFIX_SQL,
} from '../../../src/db/autocomplete';
import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers, noopBroadcaster } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { addressKey, nameTokens } from '../../../src/utils/address-key';

/**
 * CS-3.14, at the numbers the requirement states: 50 ms at the 95th
 * percentile over 5,000 contacts and 20,000 learned recipients, measured
 * where the query runs rather than through the UI.
 *
 * A smaller fixture would leave the requirement untested rather than met,
 * which is why this one is as big as it is and why it is seeded with raw SQL
 * — going through the upsert handler for 25,000 rows would spend the test's
 * whole budget on setup.
 *
 * The prefixes are chosen to be hostile: short ones that match thousands of
 * rows, name words that only the token index can answer, and text that
 * matches nothing, which is the case that has to fall through every tier
 * including the substring scan.
 */

const CONTACT_COUNT = 5_000;
const HISTORY_COUNT = 20_000;
const BUDGET_MS = 50;
const SAMPLES = 200;

const ACCOUNT = 1;

let engine: any;
let h: any;

const FIRST = ['Jane', 'John', 'Jasmine', 'Robin', 'Dana', 'Alex', 'Sam', 'Chris', 'Pat', 'Lee'];
const LAST = ['Smith', 'Smithson', 'Jones', 'Brown', 'Baker', 'Miller', 'Clark', 'Walsh'];
const ORGS = ['Acme Widgets', 'Globex', 'Initech', 'Umbrella Foods', 'Stark Metals'];

beforeEach(async () => {
  engine = await bootTestEngine();
  h = makeHandlers(engine, noopBroadcaster());
  await engine.run(
    `INSERT INTO accounts(
       id, display_name, primary_email, server_origin, remote_account_id,
       created_at, updated_at
     ) VALUES (?, 'Me', 'me@example.com', 'https://mail.example.com', 'acct-1', 0, 0)`,
    [ACCOUNT],
  );
  await engine.run(
    `INSERT INTO addressbooks(id, account_id, service_kind, remote_id, name, updated_at)
     VALUES (10, ?, 'jmap_contacts', 'ab-10', 'Default', 0)`,
    [ACCOUNT],
  );

  await engine.transaction(async (tx: any) => {
    for (let i = 0; i < CONTACT_COUNT; i += 1) {
      const first = FIRST[i % FIRST.length];
      const last = LAST[i % LAST.length];
      const org = ORGS[i % ORGS.length];
      const display = `${last}, ${first} ${i}`;
      await tx.run(
        `INSERT INTO contacts(
           id, account_id, remote_id, display_name, full_name, given_name,
           family_name, organization, is_deleted, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
        [i + 1, ACCOUNT, `c-${i}`, display, `${first} ${last}`, first, last, org],
      );
      await tx.run(
        `INSERT INTO addressbook_contacts(addressbook_id, contact_id) VALUES (10, ?)`,
        [i + 1],
      );
      // Two addresses each, as a real address book has.
      // `email_key` is written here for the same reason the handler writes it:
      // the queries compare against it, so a fixture that left it null would
      // be measuring an address book the address tiers cannot see, and this
      // test would report a fast p95 for finding nothing.
      const primary = `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com`;
      const work = `${first.toLowerCase()}${i}@work.example`;
      await tx.run(
        `INSERT INTO contact_emails(contact_id, position, email, email_key, is_preferred)
         VALUES (?, 0, ?, ?, 1)`,
        [i + 1, primary, addressKey(primary)],
      );
      await tx.run(
        `INSERT INTO contact_emails(contact_id, position, email, email_key, is_preferred)
         VALUES (?, 1, ?, ?, 0)`,
        [i + 1, work, addressKey(work)],
      );
      for (const token of nameTokens(display, `${first} ${last}`, first, last, org)) {
        await tx.run(
          `INSERT OR IGNORE INTO contact_search_tokens(contact_id, account_id, token)
           VALUES (?, ?, ?)`,
          [i + 1, ACCOUNT, token],
        );
      }
    }
  });

  await engine.transaction(async (tx: any) => {
    for (let i = 0; i < HISTORY_COUNT; i += 1) {
      const first = FIRST[i % FIRST.length];
      const last = LAST[(i + 3) % LAST.length];
      const email = `${first.toLowerCase()}${i}@history.example`;
      const name = `${first} ${last}`;
      await tx.run(
        `INSERT INTO recipient_history(
           account_id, email, email_key, name, name_key,
           send_count, last_sent_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
        [ACCOUNT, email, email, name, name.toLowerCase(), (i % 30) + 1, i * 1000],
      );
    }
  });
}, 600_000);

afterEach(async () => {
  await engine.close();
});

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank, so the 95th of 200 samples is the 190th slowest and the
  // ten worst are allowed to exceed it.
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

describe('autocomplete performance (CS-3.14)', () => {
  it(
    `answers within ${BUDGET_MS}ms at p95 over ${CONTACT_COUNT} contacts `
    + `and ${HISTORY_COUNT} learned recipients`,
    async () => {
      const prefixes: string[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const first = FIRST[i % FIRST.length];
        const last = LAST[i % LAST.length];
        switch (i % 5) {
          // Two letters: the shortest the control will query on, and the
          // widest match there is.
          case 0: prefixes.push(first.slice(0, 2).toLowerCase()); break;
          // A name word no address begins with, so only the token index can
          // answer it.
          case 1: prefixes.push(last.toLowerCase()); break;
          // Two words, which is an INTERSECT of two token scans.
          case 2: prefixes.push(`${first.toLowerCase()} ${last.slice(0, 3).toLowerCase()}`); break;
          // A full address, which must be found by equality.
          case 3: prefixes.push(`${first.toLowerCase()}${i}@history.example`); break;
          // Matches nothing, so every tier runs and none of them stops
          // early — the substring scan included.
          default: prefixes.push(`zzq${i}`); break;
        }
      }

      const durations: number[] = [];
      let matched = 0;
      for (const prefix of prefixes) {
        const started = performance.now();
        const rows = await h[DB_RPC.CONTACT_AUTOCOMPLETE]({
          accountId: ACCOUNT, prefix, limit: 10,
        });
        durations.push(performance.now() - started);
        if (rows.length > 0) matched += 1;
      }

      // Timing a query that finds nothing proves nothing. One prefix in five
      // is deliberately unmatchable, so four in five must answer — and a
      // fixture that stopped matching, as it silently did when the address
      // column the queries read changed, fails here rather than reporting a
      // very fast p95 for an empty address book.
      expect(
        matched,
        `only ${matched} of ${prefixes.length} prefixes matched anything, so this `
        + 'measured an address book the queries cannot see',
      ).toBeGreaterThanOrEqual(prefixes.length * 0.75);

      const p95 = percentile(durations, 95);
      const worst = Math.max(...durations);
      expect(
        p95,
        `p95 was ${p95.toFixed(1)}ms (worst ${worst.toFixed(1)}ms) against `
        + `${CONTACT_COUNT} contacts and ${HISTORY_COUNT} history rows`,
      ).toBeLessThan(BUDGET_MS);
    },
    600_000,
  );

  it('answers an address prefix from the address index, not the address book', async () => {
    // CS-3.14 asks for indexed lookups, not merely a fast answer. Left to
    // choose, SQLite reads every contact in the account and looks up its
    // addresses one at a time — which is quick enough on a fixture and is a
    // full scan of the address book on every keystroke in real use.
    const plan = await engine.all(
      `EXPLAIN QUERY PLAN ${CONTACT_ADDRESS_PREFIX_SQL}`, [ACCOUNT, 'ja', 'jb', 40],
    );
    const detail = plan.map((row: any) => row.detail).join('\n');
    expect(detail, detail).toContain('contact_emails_key_lookup');
    expect(detail, detail).not.toMatch(/SCAN (ce|c|contact)/);
  });

  it('answers an exact address by the same index', async () => {
    const plan = await engine.all(
      `EXPLAIN QUERY PLAN ${CONTACT_ADDRESS_EXACT_SQL}`,
      [ACCOUNT, 'jane@example.com'],
    );
    const detail = plan.map((row: any) => row.detail).join('\n');
    expect(detail, detail).toContain('contact_emails_key_lookup');
    expect(detail, detail).not.toMatch(/SCAN (ce|c|contact)/);
  });

  it('answers a name word from a covering index', async () => {
    const plan = await engine.all(
      `EXPLAIN QUERY PLAN ${CONTACT_TOKEN_PREFIX_SQL}`, [ACCOUNT, 'smi', 'smj'],
    );
    const detail = plan.map((row: any) => row.detail).join('\n');
    expect(detail, detail).toContain('contact_search_tokens_prefix');
    expect(detail, detail).not.toContain('SCAN');
  });
});
