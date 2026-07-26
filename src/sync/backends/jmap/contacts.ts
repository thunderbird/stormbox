/**
 * JMAP-Contacts sync (read-only for MVP).
 *
 *   AddressBook/get        -> addressbooks rows
 *   AddressBook/changes    -> addressbooks delta
 *   ContactCard/query      -> ids of cards in a book
 *   ContactCard/get        -> contacts + contact_emails rows
 *   ContactCard/changes    -> per-account contact delta
 *
 * Reads everything via the same JMAP transport the mail backend uses;
 * the JMAP-Contacts capability is advertised on the same session, so
 * there is one transport per account regardless of how many JMAP data
 * services it hosts.
 */

import { DB_RPC } from '../../../db/protocol';
import { SERVICE_KIND } from '../../../constants/states';
import { JMAP_CAPS } from './transport';
import { callJmap, pickResponse } from './invoke';
import { maxObjectsInGet } from './limits';

const ADDRESSBOOK_PROPERTIES = [
  'id', 'name', 'description', 'sortOrder',
  'isDefault', 'isSubscribed', 'myRights',
];

// JSContact (RFC 9553) property names as Stalwart serves them. The
// older single-book `addressBookId` / flat `emails` array / `fullName`
// shape is still accepted by `normalizeCard` below for backwards
// compatibility, but we request the spec property names here.
const CONTACT_PROPERTIES = [
  'id', 'addressBookIds', 'uid',
  'name', 'emails', 'phones', 'organizations',
];

/**
 * How many times a full sync will start over when the card list moves
 * under its cursor before it settles for not sweeping.
 *
 * An account being edited from another client can in principle keep a
 * pass from ever completing, and looping forever on a shared address book
 * is worse than leaving a deletion unreflected until the next sync.
 */
const FULL_SYNC_MAX_ATTEMPTS = 3;

interface FullContactSync {
  fetched: number;
  total: number;
  state: string | null;
  /** Contacts the server no longer has, removed by this run. */
  swept: number;
  /** The catch-up could not be calculated; the caller should rebuild. */
  needsFullSync?: boolean;
  /** The card list kept moving, so nothing was removed. */
  unstable?: boolean;
}

/**
 * Pull every visible AddressBook for the account and persist them as a
 * snapshot: what the server did not list, the account no longer has.
 */
export async function syncAddressBooks({ transport, account, handlers, useWebSocket = false }) {
  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
    methodCalls: [[
      'AddressBook/get',
      { accountId: account.remote_account_id, properties: ADDRESSBOOK_PROPERTIES },
      'ab1',
    ]],
    useWebSocket,
  });
  const response = pickResponse(result, 'AddressBook/get');
  // No answer is not an empty account, and neither is an answer with no
  // list in it. Applying either as a snapshot would retire every book the
  // user has over one malformed response.
  if (!response || !Array.isArray(response.list)) {
    return { count: 0, state: null, retired: 0 };
  }
  const list = response.list;
  const { retired } = await handlers[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
    accountId: account.id,
    serviceKind: SERVICE_KIND.JMAP_CONTACTS,
    snapshot: true,
    addressbooks: list.map((ab) => ({
      remoteId: ab.id,
      name: ab.name ?? null,
      description: ab.description ?? null,
      isDefault: !!ab.isDefault,
      isSubscribed: ab.isSubscribed === false ? false : true,
      rawJson: JSON.stringify(ab),
      isDeleted: false,
    })),
  });
  if (response.state) {
    await handlers[DB_RPC.SYNC_STATE_SET]({
      accountId: account.id,
      objectType: 'AddressBook',
      state: response.state,
    });
  }
  return { count: list.length, state: response.state ?? null, retired };
}

/**
 * Pull every visible contact for the account, paging through
 * ContactCard/query and ContactCard/get until the server runs out of
 * cards. Suitable for the bootstrap scenario; for steady-state use
 * syncContactCardChanges instead.
 *
 * Each page is a single chained round trip (ContactCard/query +
 * ContactCard/get via an RFC 8620 §3.1.3 back-reference), so network
 * and SQLite batch shapes match. `pageSize` is clamped against the
 * server-advertised jmap-core maxObjectsInGet so the chained get never
 * asks for more objects than the server will return.
 */
export async function syncContacts({
  transport, account, handlers,
  pageSize = 500,
  useWebSocket = false,
  maxAttempts = FULL_SYNC_MAX_ATTEMPTS,
}): Promise<FullContactSync> {
  for (let attempt = 1; ; attempt += 1) {
    const pass = await pageAllContacts({
      transport, account, handlers, pageSize, useWebSocket,
    });
    if (!pass.restart) return pass.result;
    // The card set moved under the cursor. Nothing has been removed —
    // sweeping is the only destructive step and a restarting pass never
    // reaches it — so the cost of going again is a re-read, and the
    // alternative is deleting a contact the server still has.
    if (attempt >= maxAttempts) {
      // Reading the whole list is the only way to know what is missing, and
      // this run never managed it. Everything read so far is kept and the
      // catch-up still runs; the account simply keeps whatever it had.
      return { ...pass.result, swept: 0, unstable: true };
    }
  }
}

let lastGeneration = 0;

/**
 * The next sweep generation, which must be larger than the last one this
 * process used.
 *
 * A bare `Date.now()` is not, because two passes can fall inside one
 * millisecond — a restart after query-state drift most easily, since nothing
 * between the two attempts has to be slow. Both then stamp the same number,
 * and the sweep's `sync_generation < generation` spares a card the earlier
 * attempt stamped and the server has since lost. That errs on the safe side,
 * so it costs a stale row rather than a real one, but it also makes the
 * behaviour depend on the clock's resolution — which is no way to decide
 * whether the one irreversible step runs.
 */
function nextGeneration(): number {
  const reading = Date.now();
  lastGeneration = reading > lastGeneration ? reading : lastGeneration + 1;
  return lastGeneration;
}

/**
 * One pass over the whole card list, sweeping only if it saw all of it.
 *
 * Returns `{ restart: true }` when the query state moved between pages,
 * which the caller answers by starting over.
 */
async function pageAllContacts({
  transport, account, handlers, pageSize, useWebSocket,
}): Promise<{ restart: boolean; result: FullContactSync }> {
  const limit = clampToMaxObjectsInGet(transport, pageSize);
  // Every row this run sees is stamped with it, and afterwards the rows that
  // still carry an older stamp are the ones the server no longer has.
  const generation = nextGeneration();
  let position = 0;
  let fetched = 0;
  let total = null;
  let state = null;
  // `undefined` is "no page has answered yet"; `null` is "the server sent no
  // query state". Conflating them is what makes an absent field look like a
  // state that never changes.
  let queryState;
  let skipped = 0;
  // Cards the query named that the get did not return. Counted apart from
  // `skipped` because the cause differs, but treated the same way: both are
  // cards this pass knows of and does not have.
  let withheld = 0;
  let lastPosition = -1;
  // Set when this pass cannot prove it read one whole list. The sweep is the
  // only irreversible step, so it is what gets withheld.
  let unverified = false;
  for (;;) {
    const result = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
      methodCalls: [
        [
          'ContactCard/query',
          {
            accountId: account.remote_account_id,
            position,
            limit,
            calculateTotal: true,
          },
          'cq1',
        ],
        [
          'ContactCard/get',
          {
            accountId: account.remote_account_id,
            '#ids': {
              resultOf: 'cq1',
              name: 'ContactCard/query',
              path: '/ids',
            },
            properties: CONTACT_PROPERTIES,
          },
          'cg1',
        ],
      ],
      useWebSocket,
    });
    const query = pickResponse(result, 'ContactCard/query');
    // No answer is not an empty account. `pickResponse` returns null for a
    // method-level error too, and reading that as "the server has no cards"
    // would hand an empty result to the sweep, which would then delete the
    // entire address book over one failed round trip.
    if (!query || !Array.isArray(query.ids)) {
      throw new Error('ContactCard/query did not answer with a list of ids');
    }
    const ids = query.ids;
    if (Number.isFinite(query?.total)) total = query.total;

    // CS-4.2: paging by position alone lets a concurrent deletion shift an
    // unseen card past the cursor, and a later `changes` catch-up cannot
    // recover it because that card was never modified. The query state is
    // what makes the pages one list rather than several.
    const pageQueryState = query.queryState ?? null;
    if (queryState === undefined) {
      queryState = pageQueryState;
    } else if (pageQueryState !== queryState) {
      return { restart: true, result: { fetched, total: total ?? fetched, state, swept: 0 } };
    }

    const got = pickResponse(result, 'ContactCard/get');
    if (ids.length > 0 && (!got || !Array.isArray(got.list))) {
      throw new Error('ContactCard/get did not answer for a page that had ids');
    }
    // The checkpoint is the object state from `get`, taken on the first
    // page and kept: `changes` consumes that state (RFC 8620 §5.2), while
    // the `queryState` a query answers with is a different thing that
    // `changes` will reject. Reading the state the first page was drawn
    // from — rather than the last — means anything that happens while the
    // remaining pages are read is replayed by the catch-up instead of
    // falling into the gap between them.
    if (state === null && got?.state) state = got.state;

    const cards = got?.list ?? [];
    // A page is only as complete as the cards it returned, not as the ids it
    // asked for. `notFound` is the documented answer for an id a get did not
    // return (RFC 8620 §5.1), and it arrives without anything being broken: a
    // server capping objects in a get below the ids its own query listed, a
    // permission change between the two method calls, or a destroy landing
    // between them. Only the last makes a local deletion correct, and there is
    // no way to tell which happened, so the difference is counted and the
    // irreversible step withheld. Every other measure the loop keeps reads
    // clean here — the ids were all named, the cursor advanced by all of them,
    // and `total` is reached — which is what made this deletion silent.
    withheld += Math.max(0, ids.length - cards.length);
    if (cards.length > 0) {
      const persisted = await persistContactCards({ account, cards, handlers, generation });
      skipped += persisted.skipped;
      fetched += cards.length;
    }

    // The server may clamp/adjust the requested position (RFC 8620
    // §5.5); trust its echo when present so we advance from where the
    // page actually started.
    const pageStart = Number.isFinite(query?.position) ? Number(query.position) : position;
    position = pageStart + ids.length;

    // The same clause lets the server clamp `limit`, and requires it to
    // return the limit it enforced. Measuring a short page against what we
    // asked for rather than what it agreed to give is how a server whose
    // query cap sits below our page size gets read as an account that ran
    // out of contacts after one page — with the sweep behind it deleting
    // the rest. Stalwart caps queries at 5000 against our 500, so this
    // costs nothing there and everything on an instance configured tighter.
    // Clamping only ever reduces, so a limit above the one requested says
    // nothing about this page — a server reporting its configured ceiling
    // while serving the page asked for would otherwise make every page look
    // short, ending the pass after one and sweeping the rest.
    const echoed = Number.isFinite(query?.limit) ? Number(query.limit) : limit;
    const served = Math.min(limit, echoed);
    if (ids.length === 0) break;
    if (total != null && position >= total) break;
    if (ids.length < served) break;

    // The cursor has to move. A server that keeps echoing `position: 0` while
    // serving full pages would otherwise be read forever, since every page
    // looks like a full page and the query state never changes.
    if (position <= lastPosition) {
      unverified = true;
      break;
    }
    lastPosition = position;

    // Another page is needed, and from here on the pages have to be provably
    // one list. Without a query state they cannot be: a deletion between two
    // requests slides an unseen card past the cursor, and the `changes`
    // catch-up will never name it because nothing modified it. A single-page
    // account is not exposed to this — its query and get share one request —
    // which is why this is checked on continuing rather than up front.
    if (queryState === null) unverified = true;
  }

  // Exhausted the pages without reaching the count the server reported.
  // Something is inconsistent, and the sweep is the one step that cannot be
  // taken back, so it does not run on a partial reading.
  const shortOfTotal = total != null && position < total;
  // Only here, with every page applied, is the local copy known to be the
  // whole of what the server has — so only here may anything be removed. An
  // interruption above leaves this unreached and the contacts intact, which
  // is the point: a sync that stopped halfway knows nothing about the cards
  // it never asked for (CS-4.2).
  //
  // A card the server returned but this pass could not file is the same
  // problem in miniature: it went unstamped, so the sweep would read it as
  // absent and delete a card the server plainly still has. So is a card the
  // query named and the get withheld.
  let swept = 0;
  if (skipped === 0 && withheld === 0 && !shortOfTotal && !unverified) {
    ({ swept } = await handlers[DB_RPC.CONTACT_SWEEP_STALE]({
      accountId: account.id,
      generation,
    }));
  }

  // A card that could not be filed is missing locally and will stay missing:
  // a checkpoint here makes the next sync incremental, and `changes` never
  // names a card nothing modified. Leaving the checkpoint unwritten is what
  // makes the gap transient rather than permanent. A withheld card is missing
  // for a different reason and stays missing in exactly the same way.
  if (state && (skipped > 0 || withheld > 0)) {
    // Clearing beats declining to write. A full sync runs with a checkpoint
    // already on disk — after `changes` has asked for a rebuild, or through
    // the `SYNC_ENSURE_CONTACTS` RPC — and an older one left in place is read
    // by the next delta as a state this cache reached, which is exactly the
    // claim this pass cannot make.
    await handlers[DB_RPC.SYNC_STATE_SET]({
      accountId: account.id,
      objectType: 'ContactCard',
      state: null,
    });
    return {
      restart: false,
      result: { fetched, total: total ?? fetched, state: null, swept, needsFullSync: true },
    };
  }

  if (state) {
    await handlers[DB_RPC.SYNC_STATE_SET]({
      accountId: account.id,
      objectType: 'ContactCard',
      state,
    });
    // Anything that changed while the pages were being read happened after
    // the checkpoint, so it is replayed rather than lost in the gap between
    // pages — including a deletion the sweep could not have known about.
    const caught = await syncContactCardChanges({
      transport, account, handlers, sinceState: state, useWebSocket,
    });
    if (caught.needsFullSync) {
      // The catch-up is part of the algorithm, not an optional extra: the
      // baseline is the *first* page's state, so without it everything that
      // happened while the later pages were read is unaccounted for. Drop
      // the checkpoint rather than leave one that implies otherwise, and
      // tell the caller so it can rebuild.
      await handlers[DB_RPC.SYNC_STATE_SET]({
        accountId: account.id,
        objectType: 'ContactCard',
        state: null,
      });
      return {
        restart: false,
        result: { fetched, total: total ?? fetched, state: null, swept, needsFullSync: true },
      };
    }
    if (caught.newState) state = caught.newState;
  }
  return { restart: false, result: { fetched, total: total ?? fetched, state, swept } };
}

/**
 * Clamp a requested page size against the jmap-core maxObjectsInGet
 * capability advertised on the transport's session (RFC 8620 §2), so a
 * chained query+get never trips a requestTooLarge error. Falls back to
 * the requested size when the session or capability is unavailable.
 */
function clampToMaxObjectsInGet(transport, pageSize: number): number {
  return Math.min(pageSize, maxObjectsInGet(transport));
}

/**
 * Apply ContactCard/changes since `sinceState`, following
 * `hasMoreChanges` pages until the server reports the delta is
 * complete. Created/updated cards are fetched via ContactCard/get;
 * destroyed ids are soft-deleted locally. Each page's changes are
 * applied and its `newState` persisted before the next page is
 * requested, so an interruption resumes from the last applied page
 * rather than replaying the whole delta.
 */
export async function syncContactCardChanges({
  transport, account, handlers,
  sinceState,
  maxChanges = 500,
  useWebSocket = false,
}) {
  let state = sinceState;
  const created = [];
  const updated = [];
  const destroyed = [];
  for (;;) {
    const result = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
      methodCalls: [[
        'ContactCard/changes',
        { accountId: account.remote_account_id, sinceState: state, maxChanges },
        'cc1',
      ]],
      useWebSocket,
    });
    const change = pickResponse(result, 'ContactCard/changes');
    if (!change || !change.newState) {
      return { needsFullSync: true };
    }
    const ids = [...(change.created ?? []), ...(change.updated ?? [])];
    if (ids.length > 0) {
      const { skipped } = await fetchAndPersistContactCards({
        transport, account, handlers, ids, useWebSocket,
      });
      // Stopping before the state is written is the whole of the fix: the
      // dropped card is missing locally, and this delta is the only time it
      // will ever be named. A rebuild is the one thing that can still find it.
      if (skipped > 0) return { needsFullSync: true };
    }
    if (change.destroyed?.length) {
      const placeholders = change.destroyed.map(() => '?').join(',');
      await handlers[DB_RPC.QUERY]({
        sql: `UPDATE contacts SET is_deleted = 1, updated_at = ?
                WHERE account_id = ? AND remote_id IN (${placeholders})`,
        params: [Date.now(), account.id, ...change.destroyed],
      });
    }
    await handlers[DB_RPC.SYNC_STATE_SET]({
      accountId: account.id,
      objectType: 'ContactCard',
      state: change.newState,
    });
    created.push(...(change.created ?? []));
    updated.push(...(change.updated ?? []));
    destroyed.push(...(change.destroyed ?? []));
    // A server that reports more changes without advancing its state
    // would loop forever; treat that as a broken delta and rebuild.
    if (change.hasMoreChanges && change.newState === state) {
      return { needsFullSync: true };
    }
    state = change.newState;
    if (!change.hasMoreChanges) break;
  }
  return {
    needsFullSync: false,
    created,
    updated,
    destroyed,
    newState: state,
  };
}

/**
 * Read the named cards and file them, reporting how many could not be filed.
 *
 * A caller that goes on to advance a sync checkpoint has to know: a card left
 * unfiled is missing locally, and `changes` will never name it again, so the
 * checkpoint is what turns a transient gap into a permanent one.
 */
async function fetchAndPersistContactCards({ transport, account, handlers, ids, useWebSocket }) {
  const cap = maxObjectsInGet(transport);
  let fetched = 0;
  let skipped = 0;
  for (let index = 0; index < ids.length; index += cap) {
    const got = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
      methodCalls: [[
        'ContactCard/get',
        {
          accountId: account.remote_account_id,
          ids: ids.slice(index, index + cap),
          properties: CONTACT_PROPERTIES,
        },
        'cg1',
      ]],
      useWebSocket,
    });
    const answer = pickResponse(got, 'ContactCard/get');
    // A method-level error leaves nothing to read, and reading that as "the
    // server holds no such cards" is what turns a failed read-back into a
    // reported success: nothing is persisted, the caller retires the write,
    // and the cache silently disagrees with the server (CS-4.4). For the
    // `changes` catch-up it is worse — the caller advances the sync state
    // next, so the updates in this page would never be asked for again.
    //
    // An answered but empty list is a different thing: those ids are
    // genuinely gone, which no amount of retrying will change.
    if (!answer || !Array.isArray(answer.list)) {
      throw new Error('ContactCard/get did not answer for the cards it was asked to read');
    }
    if (answer.list.length === 0) continue;
    const persisted = await persistContactCards({ account, cards: answer.list, handlers });
    skipped += persisted.skipped;
    fetched += answer.list.length;
  }
  return { fetched, skipped };
}

async function persistContactCards({ account, cards, handlers, generation = null }) {
  let skipped = 0;
  const normalized = cards.map(normalizeCard);
  // Resolve addressbook remote ids -> local ids. A JSContact card can
  // belong to several books (the addressBookIds map of RFC 9610), and the
  // local row is filed in every one of them that is already known from
  // syncAddressBooks — which book a card is in is information the user put
  // there, and keeping only the first would quietly discard it.
  const remoteAbIds = uniq(normalized.flatMap((c) => c.bookRemoteIds));
  const abMap = new Map();
  if (remoteAbIds.length > 0) {
    const placeholders = remoteAbIds.map(() => '?').join(',');
    const rows = await handlers[DB_RPC.QUERY]({
      sql: `SELECT id, remote_id FROM addressbooks
              WHERE account_id = ? AND service_kind = ? AND remote_id IN (${placeholders})`,
      params: [account.id, SERVICE_KIND.JMAP_CONTACTS, ...remoteAbIds],
    });
    for (const r of rows) {
      abMap.set(r.remote_id, r.id);
    }
  }
  const contacts = [];
  for (const card of normalized) {
    const localBooks = knownLocalBooks(card.bookRemoteIds, abMap);
    if (localBooks.length === 0) {
      // Filing needs a local book, and this card names none we know. The
      // count goes back to the caller because a full sync must not sweep
      // after this: the card is plainly on the server, so treating it as
      // absent would delete it. A `changes` catch-up cannot rescue it
      // either — it was never modified, so it will never be named.
      skipped += 1;
      continue;
    }
    contacts.push({
      addressbookIds: localBooks,
      remoteId: card.id,
      uid: card.uid ?? null,
      etag: null,
      fullName: card.fullName,
      displayName: card.displayName,
      givenName: card.givenName,
      familyName: card.familyName,
      organization: card.organization,
      vcardText: null,
      vcardVersion: null,
      rawJson: JSON.stringify(card.raw),
      isDeleted: false,
      emails: card.emails,
    });
  }
  if (contacts.length > 0) {
    await handlers[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: account.id,
      contacts,
      generation,
    });
  }
  return { skipped };
}

interface ContactWriteError {
  type: string;
  message?: string;
  detail?: unknown;
}

/** Result of a ContactCard create/update/destroy write. */
interface ContactWriteResult {
  ok: boolean;
  error?: ContactWriteError;
  id?: string;
  ids?: string[];
  created?: number;
  alreadyExists?: boolean;
  alreadyTrusted?: boolean;
}

interface NormalizedEmail {
  position: number;
  email: string;
  label: string | null;
  isPreferred: boolean;
}

interface NormalizedCard {
  id: string;
  uid: string | null;
  bookRemoteIds: string[];
  fullName: string | null;
  displayName: string;
  givenName: string | null;
  familyName: string | null;
  organization: string | null;
  emails: NormalizedEmail[];
  raw: unknown;
}

/**
 * Normalize a ContactCard into the flat shape our DB layer expects,
 * tolerating both the JSContact (RFC 9553) map shape Stalwart serves
 * (`addressBookIds`, `emails` as a keyed map, `name.full`,
 * `organizations`) and the older single-book / flat-array shape used by
 * some servers and the unit tests (`addressBookId`, `emails: [...]`,
 * `fullName`, `organization`).
 */
function normalizeCard(card: any): NormalizedCard {
  const bookRemoteIds = card.addressBookIds && typeof card.addressBookIds === 'object'
    ? Object.keys(card.addressBookIds).filter((id) => card.addressBookIds[id])
    : (card.addressBookId ? [card.addressBookId] : []);

  const emails = normalizeEmails(card.emails);
  const fullName = card.fullName
    ?? (typeof card.name === 'object' ? card.name?.full : null)
    ?? null;
  const givenName = card.name?.given ?? null;
  const familyName = card.name?.surname ?? card.name?.surnames ?? null;
  const display = fullName
    ?? combineNameComponents(card.name)
    ?? emails[0]?.email
    ?? '(no name)';

  return {
    id: card.id,
    uid: card.uid ?? null,
    bookRemoteIds,
    fullName,
    displayName: display,
    givenName,
    familyName,
    organization: normalizeOrganization(card),
    emails,
    raw: card,
  };
}

function normalizeEmails(emails: any): NormalizedEmail[] {
  if (!emails) return [];
  // JSContact map shape: { e1: { address, contexts, pref }, ... }
  const entries = Array.isArray(emails) ? emails : Object.values(emails);
  const out: NormalizedEmail[] = [];
  for (const e of entries) {
    if (typeof e === 'string') {
      if (!e) continue;
      out.push({ position: out.length, email: e, label: null, isPreferred: false });
      continue;
    }
    const email = e?.address ?? e?.email ?? null;
    if (!email) continue;
    const label = e.label
      ?? e.kind
      ?? (e.contexts ? Object.keys(e.contexts)[0] : null)
      ?? null;
    // `pref` (1 = most preferred) in JSContact, `isDefault` in the
    // older shape.
    const isPreferred = e.pref != null || !!e.isDefault;
    out.push({ position: out.length, email, label, isPreferred });
  }
  return out;
}

function normalizeOrganization(card: any): string | null {
  if (typeof card.organization === 'string') return card.organization;
  if (card.organization?.name) return card.organization.name;
  // JSContact `organizations` map: { o1: { name, units }, ... }
  if (card.organizations && typeof card.organizations === 'object') {
    const first = Object.values(card.organizations)[0] as { name?: string } | undefined;
    if (first?.name) return first.name;
  }
  return null;
}

/** Every book of the card's that this account already knows about. */
function knownLocalBooks(bookRemoteIds: string[], abMap: Map<string, number>): number[] {
  const found = [];
  for (const remoteId of bookRemoteIds) {
    const localId = abMap.get(remoteId);
    if (localId && !found.includes(localId)) found.push(localId);
  }
  return found;
}

const TRUSTED_SENDERS_BOOK_NAME = 'Trusted senders';

/**
 * Find (or lazily create) the dedicated "Trusted senders" address book
 * and return its remote id. Stalwart's contact trust (trustContacts /
 * card_is_ham) is account-wide over ContactCard.Email regardless of
 * which book a card lives in, so a dedicated book is purely
 * organizational; if creation fails we fall back to the default book so
 * the trust still takes effect.
 */
export async function ensureTrustedSendersBook({ transport, account, useWebSocket = false }): Promise<string | null> {
  const got = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
    methodCalls: [[
      'AddressBook/get',
      { accountId: account.remote_account_id, properties: ['id', 'name', 'isDefault'] },
      'ab',
    ]],
    useWebSocket,
  });
  const list = pickResponse(got, 'AddressBook/get')?.list ?? [];
  const existing = list.find(
    (book) => (book.name ?? '').toLowerCase() === TRUSTED_SENDERS_BOOK_NAME.toLowerCase(),
  );
  if (existing) return existing.id;

  const created = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
    methodCalls: [[
      'AddressBook/set',
      { accountId: account.remote_account_id, create: { tb: { name: TRUSTED_SENDERS_BOOK_NAME } } },
      'abset',
    ]],
    useWebSocket,
  });
  const createdId = pickResponse(created, 'AddressBook/set')?.created?.tb?.id;
  if (createdId) return createdId;

  const fallback = list.find((book) => book.isDefault) ?? list[0];
  return fallback?.id ?? null;
}

/**
 * Add a sender to the trusted-senders address book as a ContactCard so
 * Stalwart delivers future authenticated mail from that address to the
 * Inbox (trustContacts). Single-sender convenience wrapper over
 * createTrustedContactCards; idempotent (skips an address that already
 * has a card).
 */
export async function createTrustedContactCard({
  transport, account, email, name, useWebSocket = false,
}): Promise<ContactWriteResult> {
  return createTrustedContactCards({
    transport, account, senders: [{ email, name }], useWebSocket,
  });
}

/**
 * Trust one or more senders in a constant number of round trips rather
 * than one ContactCard/set per sender: a single existence query
 * (ContactCard/query OR over the addresses + one ContactCard/get), a
 * single trusted-senders book lookup, and a single multi-create
 * ContactCard/set. Idempotent — addresses that already have a card
 * anywhere in the account are skipped, so a retry after a partial failure
 * converges. Returns { ok, created, alreadyTrusted?, ids?, error? }.
 */
export async function createTrustedContactCards({
  transport, account, senders, useWebSocket = false,
}): Promise<ContactWriteResult> {
  // Dedupe by address (case-insensitive), keeping the first name seen.
  const byEmail = new Map<string, { email: string; name: string | null }>();
  for (const s of senders ?? []) {
    const email = String(s?.email ?? '').trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (!byEmail.has(key)) byEmail.set(key, { email, name: s?.name ?? null });
  }
  const unique = [...byEmail.values()];
  if (unique.length === 0) {
    return { ok: false, error: { type: 'invalidArguments', message: 'no sender email' } };
  }

  // 1) One existence query for every address; skip ones already carded.
  const existing = await existingCardEmails({
    transport, account, emails: unique.map((s) => s.email), useWebSocket,
  });
  const toCreate = unique.filter((s) => !existing.has(s.email.toLowerCase()));
  if (toCreate.length === 0) {
    return { ok: true, created: 0, alreadyTrusted: true };
  }

  // 2) Resolve the trusted-senders book once for the whole batch.
  const bookId = await ensureTrustedSendersBook({ transport, account, useWebSocket });

  // 3) Create every missing card in a single ContactCard/set.
  const create: Record<string, unknown> = {};
  toCreate.forEach((s, i) => {
    create[`c${i + 1}`] = buildContactCard({ name: s.name, emails: [s.email], bookId });
  });
  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
    methodCalls: [[
      'ContactCard/set',
      { accountId: account.remote_account_id, create },
      'cset',
    ]],
    useWebSocket,
  });
  const set = pickResponse(result, 'ContactCard/set');
  if (!set) return { ok: false, error: { type: 'serverFail' } };
  const notCreated = set.notCreated ? Object.values(set.notCreated) : [];
  if (notCreated.length > 0) {
    return { ok: false, error: { type: 'notCreated', detail: notCreated[0] } };
  }
  const ids = Object.values(set.created ?? {}).map((c: any) => c?.id).filter(Boolean);
  return { ok: true, created: ids.length, ids };
}

/**
 * Add a contact to the user's primary ("default") address book. Used by
 * the contacts UI's "Add contact" action. Idempotent on email: if a
 * card with this address already exists anywhere in the account we
 * report `alreadyExists` rather than creating a duplicate. Returns
 * { ok, alreadyExists?, id?, error? }.
 */
export async function createContactCard({
  transport, account, emails, name = null, bookId = null, useWebSocket = false,
}): Promise<ContactWriteResult> {
  const addresses = normalizeAddressList(emails);
  if (addresses.length === 0) {
    return { ok: false, error: { type: 'invalidArguments', message: 'no email' } };
  }
  if (await cardExistsForEmail({ transport, account, email: addresses[0], useWebSocket })) {
    return { ok: true, alreadyExists: true };
  }
  // Caller may pin a target book (the selected folder in the contacts
  // UI); otherwise fall back to the account's default book.
  const targetBook = bookId ?? await resolveDefaultBook({ transport, account, useWebSocket });
  return submitContactCardCreate({
    transport, account, emails: addresses, name, bookId: targetBook, useWebSocket,
  });
}

/**
 * Update a contact's name and email set by remote id.
 *
 * The editor only surfaces the display name and the list of email
 * addresses, so this must never silently erase anything else. JMAP's
 * `update` is a PatchObject, so any top-level property we omit (phones,
 * organizations, addressBookIds, …) is left untouched by the server. To
 * avoid clobbering data inside the two properties we do touch, we
 * re-fetch the authoritative card and *merge*:
 *
 *   - emails: each surviving address keeps its original entry (and thus
 *     its contexts / pref / @type); only addresses the user removed are
 *     dropped and only ones they added are created.
 *   - name: we change `full` only, preserving any structured name
 *     components, and we skip the name patch entirely when unchanged.
 *
 * Returns { ok, error? }.
 */
export async function updateContactCard({
  transport, account, remoteId, emails, name = null, useWebSocket = false,
}): Promise<ContactWriteResult> {
  const id = String(remoteId ?? '').trim();
  if (!id) {
    return { ok: false, error: { type: 'invalidArguments', message: 'no remote id' } };
  }
  const addresses = normalizeAddressList(emails);
  if (addresses.length === 0) {
    return { ok: false, error: { type: 'invalidArguments', message: 'at least one email is required' } };
  }

  const got = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
    methodCalls: [[
      'ContactCard/get',
      { accountId: account.remote_account_id, ids: [id] },
      'cget',
    ]],
    useWebSocket,
  });
  const answer = pickResponse(got, 'ContactCard/get');
  // A refused read is not a card that is gone, and the difference decides
  // the row's fate: `notFound` is terminal in the outbox runner, so reading
  // one as the other retires the user's edit as impossible over a round trip
  // that was worth retrying. Only a list the server actually answered with
  // can say the card is absent.
  if (!answer || !Array.isArray(answer.list)) {
    return {
      ok: false,
      error: { type: 'serverFail', message: 'ContactCard/get did not answer' },
    };
  }
  const current = answer.list[0];
  if (!current) {
    return { ok: false, error: { type: 'notFound' } };
  }

  const patch: Record<string, unknown> = { emails: mergeEmails(current.emails, addresses) };
  // Only touch the name when the visible full name actually changed, and
  // preserve any other name components the editor does not show.
  if (name != null && name !== (current.name?.full ?? null)) {
    patch.name = { ...(current.name ?? {}), full: name };
  }

  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
    methodCalls: [[
      'ContactCard/set',
      { accountId: account.remote_account_id, update: { [id]: patch } },
      'cupd',
    ]],
    useWebSocket,
  });
  const set = pickResponse(result, 'ContactCard/set');
  if (!set) return { ok: false, error: { type: 'serverFail' } };
  if (set.notUpdated?.[id]) return { ok: false, error: { type: 'notUpdated', detail: set.notUpdated[id] } };
  // Stalwart returns the id key in `updated` (value may be null).
  if (set.updated && id in set.updated) return { ok: true };
  return { ok: false, error: { type: 'noResponse' } };
}

/**
 * Build the JSContact `emails` map for an updated card by merging the
 * user's address list against the card's current entries. Surviving
 * addresses reuse their original entry (preserving metadata and key);
 * removed addresses drop out; added addresses get a fresh entry. The
 * user's typed address wins (so a case-only edit is honoured) while the
 * rest of the entry is preserved.
 */
function mergeEmails(currentEmails: any, addresses: string[]): Record<string, unknown> {
  const pool = new Map<string, Array<{ key: string; entry: any }>>();
  const originalKeys = new Set<string>();
  const entries = (currentEmails && typeof currentEmails === 'object')
    ? Object.entries(currentEmails as Record<string, any>)
    : [];
  for (const [key, entry] of entries) {
    originalKeys.add(key);
    const addr = String(entry?.address ?? '').trim().toLowerCase();
    if (!addr) continue;
    if (!pool.has(addr)) pool.set(addr, []);
    pool.get(addr).push({ key, entry });
  }
  // Pass 1: claim a matching original entry for each address, in order.
  const assignments = addresses.map((address) => {
    const queue = pool.get(address.toLowerCase());
    if (queue && queue.length > 0) {
      const { key, entry } = queue.shift();
      return { key, entry: { ...entry, address } };
    }
    return { key: null, entry: { '@type': 'EmailAddress', address } };
  });
  // Pass 2: reused entries keep their key; new entries get one that
  // collides with neither a reused nor an already-assigned key.
  const reusedKeys = new Set(assignments.filter((a) => a.key).map((a) => a.key));
  const map: Record<string, unknown> = {};
  let counter = 1;
  for (const { key, entry } of assignments) {
    let resolvedKey = key;
    if (!resolvedKey) {
      do { resolvedKey = `e${counter}`; counter += 1; }
      while (reusedKeys.has(resolvedKey) || resolvedKey in map);
    }
    map[resolvedKey] = entry;
  }
  return map;
}

/**
 * Trim, drop empties, and de-duplicate (case-insensitively, keeping the
 * first spelling) an email list, accepting either an array or a single
 * string.
 */
function normalizeAddressList(emails: any): string[] {
  const list = Array.isArray(emails) ? emails : (emails == null ? [] : [emails]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const addr = String(raw ?? '').trim();
    if (!addr) continue;
    const lower = addr.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(addr);
  }
  return out;
}

/**
 * Destroy a ContactCard by its remote id. Returns { ok, error? }. A
 * card that no longer exists server-side is treated as success so a
 * retry after a partial failure converges.
 */
export async function deleteContactCard({
  transport, account, remoteId, useWebSocket = false,
}): Promise<ContactWriteResult> {
  const id = String(remoteId ?? '').trim();
  if (!id) {
    return { ok: false, error: { type: 'invalidArguments', message: 'no remote id' } };
  }
  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
    methodCalls: [[
      'ContactCard/set',
      { accountId: account.remote_account_id, destroy: [id] },
      'cdel',
    ]],
    useWebSocket,
  });
  const set = pickResponse(result, 'ContactCard/set');
  if (!set) return { ok: false, error: { type: 'serverFail' } };
  if ((set.destroyed ?? []).includes(id)) return { ok: true };
  const reason = set.notDestroyed?.[id];
  // notFound means it is already gone — converge to success.
  if (reason && reason.type === 'notFound') return { ok: true };
  if (reason) return { ok: false, error: { type: 'notDestroyed', detail: reason } };
  return { ok: false, error: { type: 'noResponse' } };
}

/**
 * Reconcile the local cache for a small, known set of cards after a
 * single-contact mutation (whitelist, add, edit), instead of re-pulling the
 * entire address book. Cost is O(books) + O(ids) rather than
 * O(all contacts), so a whitelist stays fast no matter how many contacts the
 * account has.
 *
 * Address books are synced first (they are few) so a card filed in a
 * book that was created in the same operation — e.g. "Trusted senders" —
 * resolves locally; then only the named card ids are fetched + upserted.
 */
export async function reconcileContactCards({
  transport, account, handlers, ids, useWebSocket = false,
}) {
  await syncAddressBooks({ transport, account, handlers, useWebSocket });
  const list = (ids ?? []).filter(Boolean);
  if (list.length === 0) return { fetched: 0 };
  const { fetched, skipped } = await fetchAndPersistContactCards({
    transport, account, handlers, ids: list, useWebSocket,
  });
  // The caller reports a contact write as cached on the strength of this
  // returning. A card that was read back and then not filed leaves the list
  // contradicting the write, which is the failure CS-4.4 names — so say so,
  // and let the row park and retry rather than claim a repair that did not
  // happen. `syncAddressBooks` ran above, so an unresolved book here is not
  // merely a book this pass had not heard of yet.
  if (skipped > 0) {
    throw new Error(`${skipped} card(s) read back but not filed`);
  }
  return { fetched };
}

/**
 * Resolve the remote id of the account's primary address book for new
 * contacts: the one flagged `isDefault`, else the first book that is
 * not the dedicated "Trusted senders" book, else the first book, else
 * lazily create a "Contacts" book.
 */
async function resolveDefaultBook({ transport, account, useWebSocket = false }): Promise<string | null> {
  const got = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
    methodCalls: [[
      'AddressBook/get',
      { accountId: account.remote_account_id, properties: ['id', 'name', 'isDefault'] },
      'ab',
    ]],
    useWebSocket,
  });
  const list = pickResponse(got, 'AddressBook/get')?.list ?? [];
  const isTrusted = (book) =>
    (book.name ?? '').toLowerCase() === TRUSTED_SENDERS_BOOK_NAME.toLowerCase();
  const chosen = list.find((book) => book.isDefault)
    ?? list.find((book) => !isTrusted(book))
    ?? list[0];
  if (chosen) return chosen.id;

  const created = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
    methodCalls: [[
      'AddressBook/set',
      { accountId: account.remote_account_id, create: { tb: { name: 'Contacts' } } },
      'abset',
    ]],
    useWebSocket,
  });
  return pickResponse(created, 'AddressBook/set')?.created?.tb?.id ?? null;
}

/**
 * True if any ContactCard in the account already carries this email.
 * A filter the server does not support yields an empty id list, so the
 * caller falls through to create rather than failing.
 */
async function cardExistsForEmail({ transport, account, email, useWebSocket }): Promise<boolean> {
  const found = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
    methodCalls: [[
      'ContactCard/query',
      { accountId: account.remote_account_id, filter: { email } },
      'cq',
    ]],
    useWebSocket,
  });
  return (pickResponse(found, 'ContactCard/query')?.ids ?? []).length > 0;
}

/**
 * Of the given addresses, return the set (lowercased) that already have a
 * ContactCard anywhere in the account. Query pages and follow-up gets
 * are bounded to the live JMAP Session's object limit.
 * A filter the server does not support yields no ids, so callers fall
 * through to create rather than failing.
 */
async function existingCardEmails({ transport, account, emails, useWebSocket }): Promise<Set<string>> {
  const present = new Set<string>();
  if (!emails || emails.length === 0) return present;
  const wanted = new Set(emails.map((e) => e.toLowerCase()));
  const filter = emails.length === 1
    ? { email: emails[0] }
    : { operator: 'OR', conditions: emails.map((email) => ({ email })) };
  const cap = maxObjectsInGet(transport);
  for (let position = 0; ;) {
    const found = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
      methodCalls: [[
        'ContactCard/query',
        {
          accountId: account.remote_account_id,
          filter,
          position,
          limit: cap,
          calculateTotal: true,
        },
        'cq',
      ]],
      useWebSocket,
    });
    const query = pickResponse(found, 'ContactCard/query');
    const ids = query?.ids ?? [];
    for (let index = 0; index < ids.length; index += cap) {
      const got = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
        methodCalls: [[
          'ContactCard/get',
          {
            accountId: account.remote_account_id,
            ids: ids.slice(index, index + cap),
            properties: ['emails'],
          },
          'cg',
        ]],
        useWebSocket,
      });
      for (const card of pickResponse(got, 'ContactCard/get')?.list ?? []) {
        const map = card?.emails;
        if (!map || typeof map !== 'object') continue;
        for (const entry of Object.values(map) as any[]) {
          const addr = String(entry?.address ?? '').trim().toLowerCase();
          if (addr && wanted.has(addr)) present.add(addr);
        }
      }
    }
    position += ids.length;
    const total = Number(query?.total);
    if (ids.length === 0 || ids.length < cap
      || (Number.isFinite(total) && position >= total)) break;
  }
  return present;
}

/**
 * Build the JSContact `Card` shape Stalwart accepts for a create, shared
 * by the single-add and batched create paths. `emails` is an ordered,
 * already-normalized list of addresses (at least one).
 */
function buildContactCard({
  name, emails, bookId,
}: { name?: string | null; emails: string[]; bookId?: string | null }): Record<string, unknown> {
  const emailsMap: Record<string, unknown> = {};
  emails.forEach((address, i) => {
    emailsMap[`e${i + 1}`] = { '@type': 'EmailAddress', address };
  });
  return {
    '@type': 'Card',
    version: '1.0',
    kind: 'individual',
    name: { full: name || emails[0] },
    emails: emailsMap,
    ...(bookId ? { addressBookIds: { [bookId]: true } } : {}),
  };
}

/**
 * Low-level ContactCard/set create shared by the whitelist and contacts
 * UI paths. Builds the JSContact map shape Stalwart accepts. `emails` is
 * an ordered, already-normalized list of addresses (at least one).
 */
async function submitContactCardCreate({
  transport, account, emails, name, bookId, useWebSocket,
}): Promise<ContactWriteResult> {
  const card = buildContactCard({ name, emails, bookId });
  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
    methodCalls: [[
      'ContactCard/set',
      { accountId: account.remote_account_id, create: { c1: card } },
      'cset',
    ]],
    useWebSocket,
  });
  const set = pickResponse(result, 'ContactCard/set');
  if (!set) return { ok: false, error: { type: 'serverFail' } };
  if (set.notCreated?.c1) return { ok: false, error: { type: 'notCreated', detail: set.notCreated.c1 } };
  const id = set.created?.c1?.id;
  if (id) return { ok: true, id };
  return { ok: false, error: { type: 'noResponse' } };
}

function combineNameComponents(name) {
  if (!name) return null;
  const parts = [name.given, name.surname].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

