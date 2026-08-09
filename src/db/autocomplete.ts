/**
 * Recipient autocomplete (CS-3.1 to CS-3.7).
 *
 * ContactCards are the only source of suggestions. A rebuildable local usage
 * cache supplies frequency and recency boosts from the latest Sent window,
 * without becoming a second address book.
 *
 * ## Reading the tiers
 *
 * A candidate is scored on the *best* way it matches, not on every way. The
 * tiers are ordered, and the ordering is the guarantee CS-3.6 asks for: an
 * exact address match beats a weak contact substring match because
 * `EXACT` sorts before `SUBSTRING`, not because of any tuning.
 *
 * ## Why an exact match gets its own query
 *
 * Every other tier draws from a bounded pool, because an unbounded scan of
 * a large mailbox cannot meet CS-3.14's latency budget. A bound reintroduces
 * starvation — the exact match could sit outside the pool — so the exact
 * match is fetched by its own equality lookup, which is a single index seek
 * and cannot be crowded out.
 */
import { addressKey, nameTokens } from '../utils/address-key';

/**
 * How a candidate matched. Lower sorts first, and the numbers are the
 * ranking: nothing else may reorder across a tier boundary.
 */
export const MATCH_TIER = {
  EXACT: 0,
  ADDRESS_PREFIX: 1,
  NAME_PREFIX: 2,
  SUBSTRING: 3,
} as const;

const DEFAULT_LIMIT = 20;

/**
 * How many rows a bounded tier may contribute. Generous relative to the
 * limit, because merging collapses duplicates and exclusions remove rows,
 * both of which happen after the fetch: a pool the size of the limit would
 * hand back a short list. Capped so a large limit cannot turn into an
 * unbounded scan.
 */
function poolSize(limit: number): number {
  return Math.min(Math.max(limit * 4, 40), 200);
}

interface RawCandidate {
  email: string;
  name: string | null;
  source: 'contact';
  isPreferred: boolean;
  sendCount: number;
  lastSentAt: number | null;
}

interface Candidate extends RawCandidate {
  key: string;
  tier: number;
}

export interface AutocompleteParams {
  accountId: number;
  prefix: string;
  limit?: number;
  /** Addresses already in To, Cc or Bcc, which must not be offered again. */
  exclude?: string[];
  /** Injected so ranking by recency is testable rather than clock-dependent. */
  nowMs?: number;
}

export async function autocompleteRecipients(
  engine: any,
  { accountId, prefix, limit = DEFAULT_LIMIT, exclude = [], nowMs = Date.now() }: AutocompleteParams,
): Promise<{
  name: string | null;
  email: string;
  source: string;
  is_preferred: 0 | 1;
  send_count: number;
  last_sent_at: number | null;
}[]> {
  const typed = String(prefix ?? '').trim();
  if (!typed || !(limit > 0)) return [];

  // Contact email keys are written by `addressKey`, so exact and prefix
  // lookups use the same folded key as recipient de-duplication.
  const typedKey = addressKey(typed);
  const words = nameTokens(typed);
  const pool = poolSize(limit);

  // Worked out before anything is collected, because a row that cannot be
  // offered must not occupy a place in the list on the way past. Filtering at
  // the end instead left `merged.size` counting rows destined to be dropped,
  // so a field already holding `limit` matching addresses would skip the
  // substring tier as though the list were full (CS-3.7).
  const excluded = await excludedKeys(engine, accountId, exclude, typedKey);

  const merged = new Map<string, Candidate>();
  const collect = (rows: RawCandidate[], tier: number) => {
    for (const row of rows) {
      if (excluded.has(addressKey(row.email))) continue;
      mergeCandidate(merged, row, tier, typedKey);
    }
  };

  // An equality lookup, so the address the user typed in full is always a
  // candidate no matter how many others share its prefix.
  collect(await exactContactRows(engine, accountId, typedKey), MATCH_TIER.EXACT);

  collect(await contactAddressPrefixRows(engine, accountId, typedKey, pool), MATCH_TIER.ADDRESS_PREFIX);

  if (words.length > 0) {
    collect(await contactNamePrefixRows(engine, accountId, words, pool), MATCH_TIER.NAME_PREFIX);
  }

  // The expensive tier, so it only runs when the cheap ones left room. A
  // substring match is a last resort by definition; skipping it when the
  // list is already full changes nothing the user would see.
  if (words.length > 0 && merged.size < limit) {
    collect(await contactSubstringRows(engine, accountId, words, pool), MATCH_TIER.SUBSTRING);
  }

  const ranked = [...merged.values()].sort((a, b) => compareCandidates(a, b, nowMs));

  // send_count / last_sent_at are derived ranking evidence, never an
  // independent suggestion source.
  return ranked.slice(0, limit).map((c) => ({
    name: c.name,
    email: c.email,
    source: c.source,
    is_preferred: c.isPreferred ? 1 : 0,
    send_count: c.sendCount,
    last_sent_at: c.lastSentAt,
  }));
}

/**
 * Fold a row into the list, keeping the best tier and the best name.
 *
 * "Best name" is decided rather than left to whichever duplicate card row
 * arrived first: a preferred address wins, then the alphabetically first
 * name. The final rule is arbitrary but deterministic.
 */
function mergeCandidate(
  merged: Map<string, Candidate>, row: RawCandidate, tier: number, typedKey: string,
) {
  const key = addressKey(row.email);
  if (!key) return;
  // Being the address the user typed is what makes a match exact, whichever
  // query happened to find it. Deciding it here rather than at each call
  // site means no query can be added later that ranks an exact match as
  // something less.
  const effective = key === typedKey ? MATCH_TIER.EXACT : tier;
  const existing = merged.get(key);
  if (!existing) {
    merged.set(key, { ...row, key, tier: effective });
    return;
  }
  existing.tier = Math.min(existing.tier, effective);
  existing.sendCount = Math.max(existing.sendCount, row.sendCount);
  existing.lastSentAt = maxOrNull(existing.lastSentAt, row.lastSentAt);
  if (namePreferenceRank(row) < namePreferenceRank(existing)
    || (namePreferenceRank(row) === namePreferenceRank(existing)
      && compareNames(row.name, existing.name) < 0)) {
    existing.name = row.name;
    existing.email = row.email;
    existing.isPreferred = row.isPreferred;
  } else if (row.isPreferred) {
    // The name loses but the flag is still true of the address, and it is a
    // ranking input.
    existing.isPreferred = true;
  }
}

function namePreferenceRank(row: RawCandidate): number {
  if (!row.name) return 4;
  return row.isPreferred ? 0 : 1;
}

function compareNames(a: string | null, b: string | null): number {
  const left = a ?? '';
  const right = b ?? '';
  const folded = left.toLowerCase().localeCompare(right.toLowerCase());
  if (folded !== 0) return folded;
  return left < right ? -1 : left > right ? 1 : 0;
}

function maxOrNull(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

/**
 * The total order suggestions are shown in: tier first, then the boosts
 * CS-3.6 names, then the address, which is unique and so makes the
 * comparison total. Without a final unique key, two equally-ranked rows
 * could come back in either order between identical queries.
 */
function compareCandidates(a: Candidate, b: Candidate, nowMs: number): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  const boost = boostOf(b, nowMs) - boostOf(a, nowMs);
  if (boost !== 0) return boost;
  const byName = compareNames(a.name, b.name);
  if (byName !== 0) return byName;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

const DAY_MS = 86_400_000;

/**
 * The boosts of CS-3.6, as buckets rather than a curve.
 *
 * Buckets, because a continuous function of `lastSentAt` would reorder the
 * list as the clock moved, which makes both the behaviour and its tests
 * depend on when they run. A bucket edge is crossed once.
 */
function boostOf(c: Candidate, nowMs: number): number {
  let score = c.isPreferred ? 4 : 0;
  if (c.lastSentAt != null) {
    const age = nowMs - c.lastSentAt;
    if (age <= 7 * DAY_MS) score += 3;
    else if (age <= 30 * DAY_MS) score += 2;
    else if (age <= 365 * DAY_MS) score += 1;
  }
  if (c.sendCount >= 20) score += 3;
  else if (c.sendCount >= 5) score += 2;
  else if (c.sendCount >= 2) score += 1;
  return score;
}

/**
 * Half-open upper bound for a prefix range scan. For 'pers' returns 'pert';
 * for 'foo\uffff' returns the next code point. Empty input and strings with
 * no representable next code point return null; callers answer null with no
 * rows, since a scan they cannot bound is a scan they must not run.
 */
export function nextPrefix(prefix: string): string | null {
  if (!prefix) {
    return null;
  }
  const codePoints = Array.from(prefix);
  for (let i = codePoints.length - 1; i >= 0; i -= 1) {
    const cp = codePoints[i].codePointAt(0)!;
    if (cp < 0x10ffff) {
      codePoints[i] = String.fromCodePoint(cp + 1);
      return codePoints.slice(0, i + 1).join('');
    }
  }
  return null;
}

const CONTACT_COLUMNS = `c.display_name AS display_name, c.full_name AS full_name,
       ce.email AS email, ce.is_preferred AS is_preferred,
       COALESCE(ru.send_count, 0) AS send_count,
       ru.last_sent_at AS last_sent_at`;
const CONTACT_USAGE_JOIN = `LEFT JOIN recipient_usage ru
         ON ru.account_id = c.account_id AND ru.email_key = ce.email_key`;

/**
 * `CROSS JOIN`, to fix the join order.
 *
 * `CROSS JOIN` is SQLite's documented way to fix the outer loop. Driving
 * from `contact_emails` makes `(account_id, email_key)` one bounded index
 * range, then joins only the matching contacts rather than reading the
 * address book one contact at a time (CS-3.14).
 *
 * The queries are exported so their plans can be asserted against the query
 * actually issued, rather than against a copy in a test that can drift from
 * it.
 */
export const CONTACT_ADDRESS_PREFIX_SQL = `SELECT ${CONTACT_COLUMNS}
       FROM contact_emails ce
       CROSS JOIN contacts c ON c.id = ce.contact_id
       ${CONTACT_USAGE_JOIN}
      WHERE ce.account_id = ?
        AND c.account_id = ce.account_id
        AND c.is_deleted = 0
        AND ce.email_key >= ?
        AND ce.email_key < ?
      ORDER BY ce.is_preferred DESC, c.display_name COLLATE NOCASE, ce.email
      LIMIT ?`;

export const CONTACT_ADDRESS_EXACT_SQL = `SELECT ${CONTACT_COLUMNS}
       FROM contact_emails ce
       CROSS JOIN contacts c ON c.id = ce.contact_id
       ${CONTACT_USAGE_JOIN}
      WHERE ce.account_id = ?
        AND c.account_id = ce.account_id
        AND c.is_deleted = 0
        AND ce.email_key = ?`;

/** One word of a name, as a prefix range over the token index. */
export const CONTACT_TOKEN_PREFIX_SQL = `SELECT contact_id FROM contact_search_tokens
        WHERE account_id = ? AND token >= ? AND token < ?`;

function contactRow(row: any): RawCandidate {
  return {
    email: row.email,
    name: row.display_name || row.full_name || null,
    source: 'contact',
    isPreferred: row.is_preferred === 1,
    sendCount: Number(row.send_count ?? 0),
    lastSentAt: row.last_sent_at == null ? null : Number(row.last_sent_at),
  };
}

/** `contact_emails.email_key` is written by `addressKey`. */
async function exactContactRows(engine: any, accountId: number, key: string) {
  const rows = await engine.all(CONTACT_ADDRESS_EXACT_SQL, [accountId, key]);
  return rows.map(contactRow);
}

async function contactAddressPrefixRows(
  engine: any, accountId: number, key: string, pool: number,
) {
  const upper = nextPrefix(key);
  if (upper == null) return [];
  // A half-open range over the `email_key` column, because a bound
  // parameter in LIKE is not rewritten into a range scan against a
  // BINARY-collated column, and this is.
  const rows = await engine.all(CONTACT_ADDRESS_PREFIX_SQL, [accountId, key, upper, pool]);
  return rows.map(contactRow);
}

/**
 * Contacts every typed word prefix-matches, in any order (CS-3.2).
 *
 * One INTERSECT per word: "jane smi" asks for the contacts with a word
 * starting "jane" *and* a word starting "smi", which is what makes it find
 * "Smith, Jane". Requiring all words rather than any is what stops a second
 * word from widening the list instead of narrowing it.
 */
async function contactNamePrefixRows(
  engine: any, accountId: number, words: string[], pool: number,
) {
  const clauses: string[] = [];
  const params: any[] = [];
  for (const word of words) {
    const upper = nextPrefix(word);
    if (upper == null) return [];
    clauses.push(CONTACT_TOKEN_PREFIX_SQL);
    params.push(accountId, word, upper);
  }
  const rows = await engine.all(
    `SELECT ${CONTACT_COLUMNS}
       FROM contact_emails ce
       JOIN contacts c ON c.id = ce.contact_id
       ${CONTACT_USAGE_JOIN}
      WHERE c.account_id = ?
        AND c.is_deleted = 0
        AND c.id IN (${clauses.join(' INTERSECT ')})
      ORDER BY ce.is_preferred DESC, c.display_name COLLATE NOCASE, ce.email
      LIMIT ?`,
    [accountId, ...params, pool],
  );
  return rows.map(contactRow);
}

async function contactSubstringRows(
  engine: any, accountId: number, words: string[], pool: number,
) {
  const clauses: string[] = [];
  const params: any[] = [];
  for (const word of words) {
    clauses.push(`SELECT contact_id FROM contact_search_tokens
        WHERE account_id = ? AND token LIKE ? ESCAPE '\\'`);
    params.push(accountId, `%${escapeLike(word)}%`);
  }
  const rows = await engine.all(
    `SELECT ${CONTACT_COLUMNS}
       FROM contact_emails ce
       JOIN contacts c ON c.id = ce.contact_id
       ${CONTACT_USAGE_JOIN}
      WHERE c.account_id = ?
        AND c.is_deleted = 0
        AND c.id IN (${clauses.join(' INTERSECT ')})
      ORDER BY ce.is_preferred DESC, c.display_name COLLATE NOCASE, ce.email
      LIMIT ?`,
    [accountId, ...params, pool],
  );
  return rows.map(contactRow);
}

/**
 * A typed word is data, so its wildcards must not act as wildcards.
 *
 * Inert as things stand, and deliberately kept: every value reaching here
 * has been through `nameTokens`, whose character class admits only letters,
 * numbers, apostrophes and hyphens, so no `%` or `_` can survive to be
 * escaped. Widening that class is what turns this on, and a widening that
 * silently made typed text into a pattern would be hard to notice — every
 * query would simply start matching more than it should.
 *
 * Exported for that reason: no integration test can reach it while the
 * tokenizer holds it shut, so the guard is tested directly or not at all.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * The keys that must not appear in the list (CS-3.7): everything already
 * entered in To, Cc or Bcc, and the user's own addresses.
 *
 * An owned address is suppressed only until the user types it exactly.
 * Mailing yourself is deliberate when you do it and noise when you don't,
 * and typing the whole address is the signal that separates the two.
 */
async function excludedKeys(
  engine: any, accountId: number, exclude: string[], typedKey: string,
): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const address of exclude ?? []) {
    const key = addressKey(address);
    if (key) keys.add(key);
  }
  for (const key of await ownedAddressKeys(engine, accountId)) {
    if (key !== typedKey) keys.add(key);
  }
  return keys;
}

/**
 * The comparison keys of every address the user sends as: their identities
 * and the account's own address.
 *
 * Shared with the Sent-folder backfill, which needs the same set to tell the
 * user's own sent mail from someone else's sitting in the same folder.
 */
export async function ownedAddressKeys(engine: any, accountId: number): Promise<Set<string>> {
  const rows = await engine.all(
    `SELECT email FROM identities WHERE account_id = ?
      UNION
     SELECT primary_email AS email FROM accounts WHERE id = ? AND primary_email IS NOT NULL`,
    [accountId, accountId],
  );
  const keys = new Set<string>();
  for (const row of rows) {
    const key = addressKey(row.email);
    if (key) keys.add(key);
  }
  return keys;
}
