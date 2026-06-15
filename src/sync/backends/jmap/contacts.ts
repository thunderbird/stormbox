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
 * Pull every visible AddressBook for the account and persist them.
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
  const list = response?.list ?? [];
  await handlers[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
    accountId: account.id,
    serviceKind: SERVICE_KIND.JMAP_CONTACTS,
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
  if (response?.state) {
    await handlers[DB_RPC.SYNC_STATE_SET]({
      accountId: account.id,
      objectType: 'AddressBook',
      state: response.state,
    });
  }
  return { count: list.length, state: response?.state ?? null };
}

/**
 * Pull every visible contact for the account, paging through
 * ContactCard/query and ContactCard/get. Suitable for the bootstrap
 * scenario; for steady-state use syncContactCardChanges instead.
 *
 * Defaults to a single page of 500 ids; callers can raise pageSize.
 */
export async function syncContacts({
  transport, account, handlers,
  pageSize = 500,
  useWebSocket = false,
}) {
  const queryResult = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
    methodCalls: [[
      'ContactCard/query',
      {
        accountId: account.remote_account_id,
        position: 0,
        limit: pageSize,
        calculateTotal: true,
      },
      'cq1',
    ]],
    useWebSocket,
  });
  const query = pickResponse(queryResult, 'ContactCard/query');
  const ids = query?.ids ?? [];
  let fetched = 0;
  if (ids.length > 0) {
    fetched = await fetchAndPersistContactCards({
      transport, account, handlers, ids, useWebSocket,
    });
  }
  if (query?.state) {
    await handlers[DB_RPC.SYNC_STATE_SET]({
      accountId: account.id,
      objectType: 'ContactCard',
      state: query.state,
    });
  }
  return { fetched, total: query?.total ?? ids.length, state: query?.state ?? null };
}

/**
 * Apply ContactCard/changes since `sinceState`. Created/updated cards are
 * fetched via ContactCard/get; destroyed ids are soft-deleted locally.
 */
export async function syncContactCardChanges({
  transport, account, handlers,
  sinceState,
  maxChanges = 500,
  useWebSocket = false,
}) {
  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
    methodCalls: [[
      'ContactCard/changes',
      { accountId: account.remote_account_id, sinceState, maxChanges },
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
    await fetchAndPersistContactCards({ transport, account, handlers, ids, useWebSocket });
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
  return {
    needsFullSync: false,
    created: change.created ?? [],
    updated: change.updated ?? [],
    destroyed: change.destroyed ?? [],
    newState: change.newState,
  };
}

async function fetchAndPersistContactCards({ transport, account, handlers, ids, useWebSocket }) {
  const got = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
    methodCalls: [[
      'ContactCard/get',
      {
        accountId: account.remote_account_id,
        ids,
        properties: CONTACT_PROPERTIES,
      },
      'cg1',
    ]],
    useWebSocket,
  });
  const list = pickResponse(got, 'ContactCard/get')?.list ?? [];
  if (list.length === 0) {
    return 0;
  }
  await persistContactCards({ account, cards: list, handlers });
  return list.length;
}

async function persistContactCards({ account, cards, handlers }) {
  const normalized = cards.map(normalizeCard);
  // Resolve addressbook remote ids -> local ids. A JSContact card can
  // belong to several books (addressBookIds map); we file the local row
  // under the first one we already know about from syncAddressBooks.
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
    const localAb = firstKnownLocalBook(card.bookRemoteIds, abMap);
    if (!localAb) {
      // Skip cards for unknown addressbooks rather than failing the
      // batch; the next addressbook sync will catch up and a follow-up
      // ContactCard/changes will resync them.
      continue;
    }
    contacts.push({
      addressbookId: localAb,
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
    await handlers[DB_RPC.CONTACT_UPSERT_MANY]({ accountId: account.id, contacts });
  }
}

/**
 * Normalize a ContactCard into the flat shape our DB layer expects,
 * tolerating both the JSContact (RFC 9553) map shape Stalwart serves
 * (`addressBookIds`, `emails` as a keyed map, `name.full`,
 * `organizations`) and the older single-book / flat-array shape used by
 * some servers and the unit tests (`addressBookId`, `emails: [...]`,
 * `fullName`, `organization`).
 */
function normalizeCard(card) {
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

function normalizeEmails(emails) {
  if (!emails) return [];
  // JSContact map shape: { e1: { address, contexts, pref }, ... }
  const entries = Array.isArray(emails) ? emails : Object.values(emails);
  return entries
    .map((e, i) => {
      if (typeof e === 'string') {
        return { position: i, email: e, label: null, isPreferred: false };
      }
      const email = e.address ?? e.email ?? null;
      if (!email) return null;
      const label = e.label
        ?? e.kind
        ?? (e.contexts ? Object.keys(e.contexts)[0] : null)
        ?? null;
      // `pref` (1 = most preferred) in JSContact, `isDefault` in the
      // older shape.
      const isPreferred = e.pref != null || !!e.isDefault;
      return { position: i, email, label, isPreferred };
    })
    .filter(Boolean)
    .map((e, i) => ({ ...e, position: i }));
}

function normalizeOrganization(card) {
  if (typeof card.organization === 'string') return card.organization;
  if (card.organization?.name) return card.organization.name;
  // JSContact `organizations` map: { o1: { name, units }, ... }
  if (card.organizations && typeof card.organizations === 'object') {
    const first = Object.values(card.organizations)[0] as { name?: string } | undefined;
    if (first?.name) return first.name;
  }
  return null;
}

function firstKnownLocalBook(bookRemoteIds, abMap) {
  for (const remoteId of bookRemoteIds) {
    const localId = abMap.get(remoteId);
    if (localId) return localId;
  }
  return null;
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
export async function ensureTrustedSendersBook({ transport, account, useWebSocket = false }) {
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
 * Inbox (trustContacts). Idempotent: skips the create when a card
 * already exists for the address. Returns { ok, alreadyTrusted?, id?,
 * error? }.
 */
export async function createTrustedContactCard({
  transport, account, email, name, useWebSocket = false,
}) {
  const address = String(email ?? '').trim();
  if (!address) {
    return { ok: false, error: { type: 'invalidArguments', message: 'no sender email' } };
  }
  if (await cardExistsForEmail({ transport, account, email: address, useWebSocket })) {
    return { ok: true, alreadyTrusted: true };
  }
  const bookId = await ensureTrustedSendersBook({ transport, account, useWebSocket });
  return submitContactCardCreate({ transport, account, emails: [address], name, bookId, useWebSocket });
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
}) {
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
}) {
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
  const current = pickResponse(got, 'ContactCard/get')?.list?.[0];
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
function mergeEmails(currentEmails, addresses) {
  const pool = new Map();
  const originalKeys = new Set();
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
  const map = {};
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
function normalizeAddressList(emails) {
  const list = Array.isArray(emails) ? emails : (emails == null ? [] : [emails]);
  const seen = new Set();
  const out = [];
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
}) {
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
 * Re-pull address books then contacts from the server so the local
 * cache reflects a contact mutation that was just applied. A full
 * `syncContacts` (rather than a delta) is used so a card filed in a
 * book that was created in the same operation — e.g. "Trusted senders"
 * — is not dropped by the unknown-book skip in `persistContactCards`.
 */
export async function reconcileContacts({ transport, account, handlers, useWebSocket = false }) {
  await syncAddressBooks({ transport, account, handlers, useWebSocket });
  return syncContacts({ transport, account, handlers, useWebSocket });
}

/**
 * Resolve the remote id of the account's primary address book for new
 * contacts: the one flagged `isDefault`, else the first book that is
 * not the dedicated "Trusted senders" book, else the first book, else
 * lazily create a "Contacts" book.
 */
async function resolveDefaultBook({ transport, account, useWebSocket = false }) {
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
async function cardExistsForEmail({ transport, account, email, useWebSocket }) {
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
 * Low-level ContactCard/set create shared by the whitelist and contacts
 * UI paths. Builds the JSContact map shape Stalwart accepts. `emails` is
 * an ordered, already-normalized list of addresses (at least one).
 */
async function submitContactCardCreate({
  transport, account, emails, name, bookId, useWebSocket,
}) {
  const emailsMap = {};
  emails.forEach((address, i) => {
    emailsMap[`e${i + 1}`] = { '@type': 'EmailAddress', address };
  });
  const card = {
    '@type': 'Card',
    version: '1.0',
    kind: 'individual',
    name: { full: name || emails[0] },
    emails: emailsMap,
    ...(bookId ? { addressBookIds: { [bookId]: true } } : {}),
  };
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

