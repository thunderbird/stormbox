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
import { ADDRESSBOOK_ERROR } from '../../../constants/addressbook-errors';
import { SERVICE_KIND } from '../../../constants/states';
import type {
  AddressBookInventory,
  AddressBookInventoryContact,
  ContactBatchFailure,
  ContactBatchMutationResult,
  ContactAnniversaryDate,
  ContactAnniversaryKind,
  ContactContext,
  ContactDetailAnniversary,
  ContactDetailLink,
  ContactDetailNote,
  ContactDetailOrganization,
  ContactDetailPhone,
  ContactDetailTitle,
  ContactMutationFields,
  ContactPhoneFeature,
  ContactPhoto,
  ContactTitleKind,
} from '../../../types/db';
import { addressKey } from '../../../utils/address-key';
import {
  contactFieldsAreEmpty,
  emptyContactFields,
  isContactMapKey as isMapKey,
  isUtcDateTime,
  isValidContactDate,
  legacyCreateContactFields,
  legacyUpdatedContactFields,
  validateContactFields as validateProtocolContactFields,
  withContactDetailKeys,
} from '../../../utils/contact-fields';
import type { ContactFieldValidationIssue } from '../../../utils/contact-fields';
import { createContactMapKey, createContactUid, isContactUid } from '../../../utils/contact-uid';
import {
  isTrustedSendersBook,
  TRUSTED_SENDERS_BOOK_NAME,
} from '../../../utils/address-book-policy';
import { JMAP_CAPS } from './transport';
import { callJmap, pickResponse } from './invoke';
import { maxObjectsInGet, maxObjectsInSet } from './limits';
import {
  pageCompleteQuery,
  type CompleteQueryFailureReason,
} from './query-paging';

export const ADDRESSBOOK_PROPERTIES = [
  'id', 'name', 'description', 'sortOrder',
  'isDefault', 'isSubscribed', 'myRights',
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
export async function syncAddressBooks({
  transport,
  account,
  handlers,
  useWebSocket = false,
  broadcast = true,
}) {
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
    return {
      complete: false,
      count: 0,
      state: null,
      retired: 0,
    };
  }
  const list = response.list;
  const { retired } = await handlers[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
    accountId: account.id,
    serviceKind: SERVICE_KIND.JMAP_CONTACTS,
    snapshot: true,
    broadcast,
    addressbooks: list.map((ab) => ({
      remoteId: ab.id,
      name: ab.name ?? null,
      description: ab.description ?? null,
      sortOrder: Number.isSafeInteger(ab.sortOrder) && ab.sortOrder >= 0
        ? ab.sortOrder
        : 0,
      isDefault: !!ab.isDefault,
      isSubscribed: ab.isSubscribed === false ? false : true,
      mayWrite: typeof ab.myRights?.mayWrite === 'boolean'
        ? ab.myRights.mayWrite
        : null,
      mayDelete: typeof ab.myRights?.mayDelete === 'boolean'
        ? ab.myRights.mayDelete
        : null,
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
  return {
    complete: true,
    count: list.length,
    state: response.state ?? null,
    retired,
  };
}

function addressBookInventoryError(
  type: string,
  message: string,
  detail?: unknown,
): Error {
  const error: any = new Error(message);
  error.type = type;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function inventoryAddressBookIds(card: any): string[] | null {
  if (!card?.addressBookIds || typeof card.addressBookIds !== 'object'
      || Array.isArray(card.addressBookIds)) {
    return null;
  }
  const entries = Object.entries(card.addressBookIds);
  if (entries.some(([id, present]) => !isMapKey(id) || present !== true)) {
    return null;
  }
  return entries.map(([id]) => id);
}

function contactCardHasMedia(card: any): boolean {
  if (Array.isArray(card?.media)) return card.media.length > 0;
  if (!card?.media || typeof card.media !== 'object') return false;
  return Object.values(card.media).some(
    (item) => item !== null && typeof item === 'object',
  );
}

/**
 * Read one complete, stable ContactCard inventory for a selected book.
 * The returned per-card classifications are retained by delete
 * confirmations so a later inventory can detect destructive escalation.
 */
export async function inventoryAddressBook({
  transport,
  account,
  handlers,
  addressbookId = null,
  remoteId = null,
  useWebSocket = false,
}: any): Promise<AddressBookInventory> {
  let localId = Number.isSafeInteger(addressbookId) && addressbookId > 0
    ? Number(addressbookId)
    : null;
  let addressBookRemoteId = typeof remoteId === 'string' && remoteId
    ? remoteId
    : null;
  if (!addressBookRemoteId && localId != null) {
    const rows = await handlers[DB_RPC.QUERY]({
      sql: `SELECT remote_id
              FROM addressbooks
             WHERE id = ?
               AND account_id = ?
               AND service_kind = ?
               AND is_deleted = 0
             LIMIT 1`,
      params: [localId, account.id, SERVICE_KIND.JMAP_CONTACTS],
    });
    addressBookRemoteId = rows[0]?.remote_id ?? null;
  }
  if (!addressBookRemoteId) {
    throw addressBookInventoryError(
      ADDRESSBOOK_ERROR.MISSING,
      'Address book is not available',
    );
  }
  if (localId == null) {
    const rows = await handlers[DB_RPC.QUERY]({
      sql: `SELECT id
              FROM addressbooks
             WHERE account_id = ?
               AND service_kind = ?
               AND remote_id = ?
               AND is_deleted = 0
             LIMIT 1`,
      params: [account.id, SERVICE_KIND.JMAP_CONTACTS, addressBookRemoteId],
    });
    localId = rows[0] ? Number(rows[0].id) : null;
  }

  const cap = maxObjectsInGet(transport);
  const contacts: AddressBookInventoryContact[] = [];
  const seen = new Set<string>();
  const paging = await pageCompleteQuery({
    pageSize: cap,
    readPage: async ({ position, limit }) => {
      let result;
      try {
        result = await callJmap(transport, {
          using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
          methodCalls: [
            [
              'ContactCard/query',
              {
                accountId: account.remote_account_id,
                filter: { inAddressBook: addressBookRemoteId },
                position,
                limit,
                calculateTotal: true,
              },
              'abiq',
            ],
            [
              'ContactCard/get',
              {
                accountId: account.remote_account_id,
                '#ids': {
                  resultOf: 'abiq',
                  name: 'ContactCard/query',
                  path: '/ids',
                },
              },
              'abig',
            ],
          ],
          useWebSocket,
        });
      } catch (error: any) {
        throw addressBookInventoryError(
          ADDRESSBOOK_ERROR.SERVER_UNAVAILABLE,
          error?.message ?? String(error),
        );
      }
      const query = pickResponse(result, 'ContactCard/query');
      const methodError = pickResponse(result, 'error');
      if (!query || !Array.isArray(query.ids)) {
        throw addressBookInventoryError(
          methodError?.type === 'stateMismatch'
            ? ADDRESSBOOK_ERROR.STATE_MISMATCH
            : ADDRESSBOOK_ERROR.SERVER_UNAVAILABLE,
          'ContactCard/query did not return a complete inventory page',
          methodError ?? undefined,
        );
      }
      if (typeof query.queryState !== 'string' || !query.queryState) {
        throw addressBookInventoryError(
          ADDRESSBOOK_ERROR.STATE_MISMATCH,
          'ContactCard/query did not provide stable paging state',
        );
      }
      const pageTotal = Number(query.total);
      if (!Number.isSafeInteger(pageTotal) || pageTotal < 0) {
        throw addressBookInventoryError(
          ADDRESSBOOK_ERROR.STATE_MISMATCH,
          'Address book inventory total changed while paging',
        );
      }
      const ids = query.ids as unknown[];
      if (
        !Number.isSafeInteger(query.position)
        || Number(query.position) !== position
        || ids.length > limit
      ) {
        throw addressBookInventoryError(
          ADDRESSBOOK_ERROR.STATE_MISMATCH,
          'Address book inventory page did not match its requested window',
        );
      }
      const pageIds = new Set<string>();
      if (ids.some((id) => {
        if (typeof id !== 'string' || !id || seen.has(id) || pageIds.has(id)) {
          return true;
        }
        pageIds.add(id);
        return false;
      })) {
        throw addressBookInventoryError(
          ADDRESSBOOK_ERROR.STATE_MISMATCH,
          'Address book inventory returned invalid or duplicate ids',
        );
      }
      const got = pickResponse(result, 'ContactCard/get');
      if (!got || !Array.isArray(got.list)) {
        throw addressBookInventoryError(
          ADDRESSBOOK_ERROR.SERVER_UNAVAILABLE,
          'ContactCard/get did not return an inventory page',
          methodError ?? undefined,
        );
      }
      return {
        ids,
        queryState: query.queryState,
        total: pageTotal,
        position: query.position,
        limit: query.limit,
        value: got.list,
      };
    },
    visitPage: ({ ids, value: list }) => {
      const cards = new Map<string, any>();
      for (const card of list) {
        if (typeof card?.id !== 'string' || cards.has(card.id)) {
          throw addressBookInventoryError(
            ADDRESSBOOK_ERROR.STATE_MISMATCH,
            'ContactCard/get returned invalid or duplicate cards',
          );
        }
        cards.set(card.id, card);
      }
      for (const id of ids as string[]) {
        const card = cards.get(id);
        const addressBookIds = inventoryAddressBookIds(card);
        if (!card || !addressBookIds?.includes(addressBookRemoteId)) {
          throw addressBookInventoryError(
            ADDRESSBOOK_ERROR.STATE_MISMATCH,
            'Address book contents changed during inventory read',
          );
        }
        seen.add(id);
        contacts.push({
          remoteId: id,
          addressBookIds: [...addressBookIds].sort(),
          classification: addressBookIds.length === 1 ? 'exclusive' : 'shared',
          hasMedia: contactCardHasMedia(card),
        });
      }
    },
  });
  if (paging.complete === false) {
    throw addressBookInventoryError(
      ADDRESSBOOK_ERROR.STATE_MISMATCH,
      'Address book contents changed while inventory was being read',
      { reason: paging.reason },
    );
  }
  const { queryState, total } = paging;
  let verificationResult;
  try {
    verificationResult = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
      methodCalls: [[
        'ContactCard/query',
        {
          accountId: account.remote_account_id,
          filter: { inAddressBook: addressBookRemoteId },
          position: 0,
          limit: 1,
          calculateTotal: true,
        },
        'abiv',
      ]],
      useWebSocket,
    });
  } catch (error: any) {
    throw addressBookInventoryError(
      ADDRESSBOOK_ERROR.SERVER_UNAVAILABLE,
      error?.message ?? String(error),
    );
  }
  const verification = pickResponse(verificationResult, 'ContactCard/query');
  if (
    !verification
    || verification.queryState !== queryState
    || !Number.isSafeInteger(verification.position)
    || Number(verification.position) !== 0
    || !Number.isSafeInteger(verification.total)
    || Number(verification.total) !== contacts.length
  ) {
    throw addressBookInventoryError(
      ADDRESSBOOK_ERROR.STATE_MISMATCH,
      'Address book contents changed while inventory was being read',
    );
  }
  if (total != null && contacts.length !== total) {
    throw addressBookInventoryError(
      ADDRESSBOOK_ERROR.STATE_MISMATCH,
      'Address book inventory was incomplete',
    );
  }

  contacts.sort((left, right) => left.remoteId.localeCompare(right.remoteId));
  return {
    version: 1,
    addressbookId: localId,
    addressBookRemoteId,
    queryState,
    total: contacts.length,
    exclusiveCount: contacts.filter(
      (contact) => contact.classification === 'exclusive',
    ).length,
    sharedCount: contacts.filter(
      (contact) => contact.classification === 'shared',
    ).length,
    mediaBearingCount: contacts.filter((contact) => contact.hasMedia).length,
    contacts,
  };
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
  let fetched = 0;
  let state = null;
  let skipped = 0;
  // Cards the query named that the get did not return. Counted apart from
  // `skipped` because the cause differs, but treated the same way: both are
  // cards this pass knows of and does not have.
  let withheld = 0;
  const paging = await pageCompleteQuery({
    pageSize: limit,
    allowMissingQueryState: true,
    readPage: async ({ position, limit: pageLimit }) => {
      const result = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
        methodCalls: [
          [
            'ContactCard/query',
            {
              accountId: account.remote_account_id,
              position,
              limit: pageLimit,
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
      const got = pickResponse(result, 'ContactCard/get');
      if (query.ids.length > 0 && (!got || !Array.isArray(got.list))) {
        throw new Error('ContactCard/get did not answer for a page that had ids');
      }
      const pageTotal = Number(query.total);
      return {
        ids: query.ids,
        queryState: typeof query.queryState === 'string' ? query.queryState : null,
        total:
          query.total != null && Number.isFinite(pageTotal)
            ? pageTotal
            : null,
        position: Number.isFinite(query.position) ? Number(query.position) : null,
        limit: Number.isFinite(query.limit) ? Number(query.limit) : null,
        value: got,
      };
    },
    visitPage: async ({ ids, value: got }) => {
      // The first object state closes the paging window with a changes pass.
      if (state === null && got?.state) state = got.state;
      const cards = got?.list ?? [];
      withheld += Math.max(0, ids.length - cards.length);
      if (cards.length > 0) {
        const persisted = await persistContactCards({ account, cards, handlers, generation });
        skipped += persisted.skipped;
        fetched += cards.length;
      }
    },
  });
  if (paging.complete === false && paging.reason === 'queryStateChanged') {
    return {
      restart: true,
      result: { fetched, total: paging.total ?? fetched, state, swept: 0 },
    };
  }
  const { position, total } = paging;
  const unverified = paging.complete === false || !paging.stableQueryState;

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
      // Through the typed handler, which also drops the cards' search
      // tokens and broadcasts the contacts family — raw SQL here left
      // stale tokens behind and open views unaware (CS-3.2).
      await handlers[DB_RPC.CONTACT_DELETE_LOCAL]({
        accountId: account.id,
        remoteIds: change.destroyed,
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
    const requested = ids.slice(index, index + cap);
    const returned = new Set(answer.list.map((card) => card.id));
    if (requested.some((id) => !returned.has(id))) {
      throw new Error('ContactCard/get omitted a card it was asked to read');
    }
    if (answer.list.length === 0) continue;
    const persisted = await persistContactCards({ account, cards: answer.list, handlers });
    skipped += persisted.skipped;
    fetched += answer.list.length;
  }
  return { fetched, skipped };
}

async function contactCardsForPersistence({ account, cards, handlers }) {
  let skipped = 0;
  const normalized: NormalizedCard[] = [];
  for (const raw of cards) {
    const card = normalizeCard(raw);
    if (card) normalized.push(card);
    else skipped += 1;
  }
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
              WHERE account_id = ? AND service_kind = ? AND is_deleted = 0
                AND remote_id IN (${placeholders})`,
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
      nicknames: card.nicknames,
      vcardText: null,
      vcardVersion: null,
      rawJson: JSON.stringify(card.raw),
      isDeleted: false,
      emails: card.emails,
      phones: card.phones,
      links: card.links,
      anniversaries: card.anniversaries,
      notes: card.notes,
      organizations: card.organizations,
      titles: card.titles,
      media: card.media,
    });
  }
  return { contacts, skipped };
}

async function persistContactCards({
  account,
  cards,
  handlers,
  generation = null,
  broadcast = true,
}) {
  const { contacts, skipped } = await contactCardsForPersistence({
    account,
    cards,
    handlers,
  });
  if (contacts.length > 0) {
    await handlers[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: account.id,
      contacts,
      generation,
      broadcast,
    });
  }
  return { skipped };
}

interface ContactWriteError {
  type: string;
  message?: string;
  detail?: unknown;
  terminal?: boolean;
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
  mapKey: string | null;
  position: number;
  email: string;
  label: string | null;
  contexts: ContactContext[];
  pref: number | null;
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
  nicknames: string[];
  emails: NormalizedEmail[];
  phones: ContactDetailPhone[];
  links: ContactDetailLink[];
  anniversaries: ContactDetailAnniversary[];
  notes: ContactDetailNote[];
  organizations: ContactDetailOrganization[];
  titles: ContactDetailTitle[];
  media: NormalizedMedia[];
  raw: unknown;
}

interface NormalizedMedia extends ContactPhoto {
  kind: string;
  position: number;
}

/**
 * Normalize a ContactCard into the flat shape our DB layer expects,
 * tolerating both the JSContact (RFC 9553) map shape Stalwart serves
 * (`addressBookIds`, `emails` as a keyed map, `name.full`,
 * `organizations`) and the older single-book / flat-array shape used by
 * some servers and the unit tests (`addressBookId`, `emails: [...]`,
 * `fullName`, `organization`).
 */
function normalizeCard(card: any): NormalizedCard | null {
  if (!isPlainObject(card) || typeof card.id !== 'string' || !card.id) return null;
  const bookRemoteIds = isPlainObject(card.addressBookIds)
    ? Object.keys(card.addressBookIds).filter(
        (id) => isMapKey(id) && card.addressBookIds[id] === true,
      )
    : (
        typeof card.addressBookId === 'string' && card.addressBookId
          ? [card.addressBookId]
          : []
      );

  const emails = normalizeEmails(card.emails);
  const phones = normalizePhones(card.phones);
  const links = normalizeLinks(card.links);
  const anniversaries = normalizeAnniversaries(card.anniversaries);
  const notes = normalizeNotes(card.notes);
  const organizations = normalizeOrganizations(card);
  const titles = normalizeTitles(card.titles, organizations);
  const media = normalizeMedia(card.media);
  const fullName = stringOrNull(card.fullName)
    ?? (isPlainObject(card.name) ? stringOrNull(card.name.full) : null);
  // RFC 9553 §2.2.1 carries given/family names as NameComponent entries,
  // keyed by `kind`; the flat name.given/name.surname reads stay as a
  // tolerance for the older non-RFC shape.
  const givenName = joinComponentValues(card.name, ['given'])
    ?? (isPlainObject(card.name) ? stringOrNull(card.name.given) : null);
  const familyName = joinComponentValues(card.name, ['surname', 'surname2'])
    ?? (
      isPlainObject(card.name)
        ? stringOrNull(card.name.surname) ?? stringOrNull(card.name.surnames)
        : null
    );
  const display = fullName
    ?? combineNameComponents(card.name)
    ?? emails[0]?.email
    ?? organizations.find((organization) => organization.name)?.name
    ?? phones[0]?.value
    ?? '(no name)';

  return {
    id: card.id,
    uid: stringOrNull(card.uid),
    bookRemoteIds,
    fullName,
    displayName: display,
    givenName,
    familyName,
    organization: organizations.find((organization) => organization.name)?.name ?? null,
    nicknames: normalizeNicknames(card.nicknames),
    emails,
    phones,
    links,
    anniversaries,
    notes,
    organizations,
    titles,
    media,
    raw: card,
  };
}

/**
 * The names a card's `nicknames` map carries (RFC 9553 §2.2.2), for the
 * search tokens CS-3.2 asks for. Tolerates a flat array of strings the
 * way the other normalizers tolerate the pre-RFC shape.
 */
function normalizeNicknames(nicknames: any): string[] {
  if (!nicknames) return [];
  const entries = Array.isArray(nicknames) ? nicknames : Object.values(nicknames);
  const out: string[] = [];
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (typeof name === 'string' && name.trim()) out.push(name.trim());
  }
  return out;
}

function normalizeEmails(emails: any): NormalizedEmail[] {
  if (!emails) return [];
  const out: NormalizedEmail[] = [];
  for (const [mapKey, e] of normalizedMapEntries(emails)) {
    if (typeof e === 'string') {
      if (!e) continue;
      out.push({
        mapKey,
        position: out.length,
        email: e,
        label: null,
        contexts: [],
        pref: null,
        isPreferred: false,
      });
      continue;
    }
    if (!isTypedObject(e, 'EmailAddress')) continue;
    const email = typeof e.address === 'string'
      ? e.address
      : (typeof e.email === 'string' ? e.email : null);
    if (!email) continue;
    out.push({
      mapKey,
      position: out.length,
      email,
      label: stringOrNull(e.label),
      contexts: standardContexts(e.contexts),
      pref: preference(e.pref),
      isPreferred: e.isDefault === true,
    });
  }
  // RFC 9553 §1.5.3: pref is a 1-100 ordering, lower is more preferred, and
  // an address without one is least preferred. Exactly the most-preferred
  // address is marked (ties go to the first listed).
  const best = out.reduce<number | null>(
    (min, email) => (
      email.pref != null && (min == null || email.pref < min) ? email.pref : min
    ),
    null,
  );
  if (best != null) {
    const winner = out.findIndex((email) => email.pref === best);
    out.forEach((e, i) => { e.isPreferred = i === winner; });
  }
  return out;
}

function normalizeMedia(value: unknown): NormalizedMedia[] {
  const media: NormalizedMedia[] = [];
  for (const [mapKey, item] of normalizedMapEntries(value)) {
    if (!isMapKey(mapKey) || !isTypedObject(item, 'Media')) continue;
    const kind = typeof item.kind === 'string' ? item.kind.trim() : '';
    const uri = stringOrNull(item.uri);
    const blobId = stringOrNull(item.blobId);
    if (!kind || (!uri && !blobId)) continue;
    media.push({
      mapKey,
      position: media.length,
      kind,
      uri,
      blobId,
      mediaType: stringOrNull(item.mediaType),
      pref: preference(item.pref),
    });
  }
  return media;
}

function preferredPhoto(media: NormalizedMedia[]): ContactPhoto | null {
  const photos = media.filter((item) => item.kind === 'photo');
  photos.sort((left, right) => {
    if (left.pref == null && right.pref != null) return 1;
    if (left.pref != null && right.pref == null) return -1;
    if (left.pref != null && right.pref != null && left.pref !== right.pref) {
      return left.pref - right.pref;
    }
    return left.position - right.position;
  });
  const photo = photos[0];
  if (!photo) return null;
  return {
    mapKey: photo.mapKey,
    uri: photo.uri,
    blobId: photo.blobId,
    mediaType: photo.mediaType,
    pref: photo.pref,
  };
}

function normalizePhones(phones: any): ContactDetailPhone[] {
  const out: ContactDetailPhone[] = [];
  for (const [mapKey, phone] of normalizedMapEntries(phones)) {
    if (typeof phone === 'string') {
      if (phone) {
        out.push({
          mapKey,
          position: out.length,
          value: phone,
          label: null,
          contexts: [],
          features: [],
          pref: null,
        });
      }
      continue;
    }
    if (!isTypedObject(phone, 'Phone') || typeof phone.number !== 'string' || !phone.number) {
      continue;
    }
    out.push({
      mapKey,
      position: out.length,
      value: phone.number,
      label: stringOrNull(phone.label),
      contexts: standardContexts(phone.contexts),
      features: standardPhoneFeatures(phone.features),
      pref: preference(phone.pref),
    });
  }
  return out;
}

function normalizeLinks(links: any): ContactDetailLink[] {
  const out: ContactDetailLink[] = [];
  for (const [mapKey, link] of normalizedMapEntries(links)) {
    if (typeof link === 'string') {
      if (link) {
        out.push({
          mapKey,
          position: out.length,
          value: link,
          label: null,
          contexts: [],
          pref: null,
        });
      }
      continue;
    }
    if (!isTypedObject(link, 'Link')) continue;
    const uri = typeof link.uri === 'string'
      ? link.uri
      : (typeof link.url === 'string' ? link.url : null);
    if (!uri) continue;
    out.push({
      mapKey,
      position: out.length,
      value: uri,
      label: stringOrNull(link.label),
      contexts: standardContexts(link.contexts),
      pref: preference(link.pref),
    });
  }
  return out;
}

function normalizeAnniversaries(anniversaries: any): ContactDetailAnniversary[] {
  const out: ContactDetailAnniversary[] = [];
  for (const [mapKey, anniversary] of normalizedMapEntries(anniversaries)) {
    if (!isTypedObject(anniversary, 'Anniversary')) continue;
    if (!isAnniversaryKind(anniversary.kind)) continue;
    const date = normalizeAnniversaryDate(anniversary.date);
    if (!date) continue;
    out.push({
      mapKey,
      position: out.length,
      kind: anniversary.kind,
      date,
    });
  }
  return out;
}

function normalizeNotes(notes: any): ContactDetailNote[] {
  const out: ContactDetailNote[] = [];
  for (const [mapKey, note] of normalizedMapEntries(notes)) {
    if (typeof note === 'string') {
      if (note) out.push({ mapKey, position: out.length, value: note });
      continue;
    }
    if (!isTypedObject(note, 'Note') || typeof note.note !== 'string') continue;
    out.push({ mapKey, position: out.length, value: note.note });
  }
  return out;
}

function normalizeOrganizations(card: any): ContactDetailOrganization[] {
  const source = card.organizations ?? (
    card.organization == null ? null : [card.organization]
  );
  const referencedOrganizationKeys = new Set(
    normalizedMapEntries(card.titles)
      .map(([, title]) => (
        isTypedObject(title, 'Title') && typeof title.organizationId === 'string'
          ? title.organizationId
          : null
      ))
      .filter((value): value is string => value != null),
  );
  const out: ContactDetailOrganization[] = [];
  for (const [mapKey, organization] of normalizedMapEntries(source)) {
    if (typeof organization === 'string') {
      if (organization) {
        out.push({
          mapKey,
          position: out.length,
          name: organization,
          contexts: [],
          units: [],
        });
      }
      continue;
    }
    if (!isTypedObject(organization, 'Organization')) continue;
    const name = stringOrNull(organization.name);
    const units = normalizeOrganizationUnits(organization.units);
    if (
      name == null
      && units.length === 0
      && (mapKey == null || !referencedOrganizationKeys.has(mapKey))
    ) continue;
    out.push({
      mapKey,
      position: out.length,
      name,
      contexts: standardContexts(organization.contexts),
      units,
    });
  }
  return out;
}

function normalizeOrganizationUnits(units: any): ContactDetailOrganization['units'] {
  if (!Array.isArray(units)) return [];
  const out: ContactDetailOrganization['units'] = [];
  for (const unit of units) {
    const value = typeof unit === 'string'
      ? unit
      : (
          isTypedObject(unit, 'OrgUnit') && typeof unit.name === 'string'
            ? unit.name
            : null
        );
    if (value) out.push({ position: out.length, value });
  }
  return out;
}

function normalizeTitles(
  titles: any,
  organizations: ContactDetailOrganization[] = [],
): ContactDetailTitle[] {
  const exposedOrganizationKeys = new Set(
    organizations
      .map((organization) => organization.mapKey)
      .filter((mapKey): mapKey is string => isMapKey(mapKey)),
  );
  const out: ContactDetailTitle[] = [];
  for (const [mapKey, title] of normalizedMapEntries(titles)) {
    if (!isTypedObject(title, 'Title') || typeof title.name !== 'string' || !title.name) {
      continue;
    }
    const kind = title.kind == null ? 'title' : title.kind;
    if (!isTitleKind(kind)) continue;
    out.push({
      mapKey,
      position: out.length,
      value: title.name,
      kind,
      organizationMapKey: typeof title.organizationId === 'string'
        && exposedOrganizationKeys.has(title.organizationId)
          ? title.organizationId
          : null,
    });
  }
  return out;
}

function normalizedMapEntries(value: any): Array<[string | null, any]> {
  if (Array.isArray(value)) return value.map((entry) => [null, entry]);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value)
    .filter(([key]) => isMapKey(key))
    .map(([key, entry]) => [key, entry]);
}

function isTypedObject(value: any, expectedType: string): value is Record<string, any> {
  return Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && (value['@type'] == null || value['@type'] === expectedType),
  );
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function preference(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 100
    ? Number(value)
    : null;
}

function standardContexts(value: any): ContactContext[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return (['private', 'work'] as const).filter((context) => value[context] === true);
}

function standardPhoneFeatures(value: any): ContactPhoneFeature[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return ([
    'fax',
    'main-number',
    'mobile',
    'pager',
    'text',
    'textphone',
    'video',
    'voice',
  ] as const).filter((feature) => value[feature] === true);
}

function isAnniversaryKind(value: unknown): value is ContactAnniversaryKind {
  return value === 'birth' || value === 'death' || value === 'wedding';
}

function isTitleKind(value: unknown): value is ContactTitleKind {
  return value === 'role' || value === 'title';
}

function normalizeAnniversaryDate(value: any): ContactAnniversaryDate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value['@type'] === 'Timestamp') {
    return isUtcDateTime(value.utc) ? { kind: 'timestamp', utc: value.utc } : null;
  }
  if (value['@type'] != null && value['@type'] !== 'PartialDate') return null;
  const year = optionalUnsignedInteger(value, 'year');
  const month = optionalUnsignedInteger(value, 'month');
  const day = optionalUnsignedInteger(value, 'day');
  if (year === undefined || month === undefined || day === undefined) return null;
  if (month != null && (month < 1 || month > 12)) return null;
  const normalized: ContactAnniversaryDate = { kind: 'partial', year, month, day };
  return isValidContactDate(normalized) ? normalized : null;
}

function optionalUnsignedInteger(
  value: Record<string, unknown>,
  property: string,
): number | null | undefined {
  if (!(property in value)) return null;
  const candidate = value[property];
  return Number.isSafeInteger(candidate) && Number(candidate) >= 0
    ? Number(candidate)
    : undefined;
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
  const existing = list.find(isTrustedSendersBook);
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
  transport, account, email, name, uid = createContactUid(), useWebSocket = false,
}): Promise<ContactWriteResult> {
  return createTrustedContactCards({
    transport, account, senders: [{ email, name, uid }], useWebSocket,
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
  transport,
  account,
  senders,
  recoverCreate = false,
  beforeCreate = null,
  useWebSocket = false,
}): Promise<ContactWriteResult> {
  // Dedupe with the same NFC/IDNA key autocomplete and contact storage use.
  const byEmail = new Map<
    string,
    { email: string; name: string | null; uid: string }
  >();
  for (const s of senders ?? []) {
    const email = String(s?.email ?? '').trim();
    const key = addressKey(email);
    if (!email || !key) continue;
    if (!byEmail.has(key)) {
      byEmail.set(key, {
        email,
        name: s?.name ?? null,
        uid: isContactUid(s?.uid) ? s.uid : createContactUid(),
      });
    }
  }
  const unique = [...byEmail.values()];
  if (unique.length === 0) {
    return { ok: false, error: { type: 'invalidArguments', message: 'no sender email' } };
  }

  const recoveredIds = new Set<string>();
  const recoveredEmails = new Set<string>();
  if (recoverCreate) {
    for (const sender of unique) {
      const recovered = await findContactCardIdByUid({
        transport,
        account,
        uid: sender.uid,
        useWebSocket,
      });
      if (recovered.error) return { ok: false, error: recovered.error };
      if (recovered.id) {
        recoveredIds.add(recovered.id);
        recoveredEmails.add(addressKey(sender.email));
      }
    }
  }

  // 1) One existence query for every address; skip ones already carded.
  let existing;
  const unresolved = unique.filter((sender) => !recoveredEmails.has(addressKey(sender.email)));
  try {
    existing = await existingCardEmails({
      transport, account, emails: unresolved.map((s) => s.email), useWebSocket,
    });
  } catch (error: any) {
    return {
      ok: false,
      error: { type: 'serverFail', message: error?.message ?? String(error) },
    };
  }
  const toCreate = unresolved.filter((s) => !existing.keys.has(addressKey(s.email)));
  if (toCreate.length === 0) {
    return {
      ok: true,
      created: 0,
      alreadyTrusted: true,
      ids: [...recoveredIds, ...existing.cardIds],
    };
  }

  // 2) Resolve the trusted-senders book once for the whole batch.
  const bookId = await ensureTrustedSendersBook({ transport, account, useWebSocket });

  // 3) Create every missing card in server-sized batches.
  const ids = new Set<string>([...recoveredIds, ...existing.cardIds]);
  let createdCount = 0;
  const cap = maxObjectsInSet(transport);
  for (let offset = 0; offset < toCreate.length; offset += cap) {
    const create: Record<string, unknown> = {};
    toCreate.slice(offset, offset + cap).forEach((s, i) => {
      create[`c${offset + i + 1}`] = buildContactCard({
        uid: s.uid,
        name: s.name,
        emails: [s.email],
        bookId,
      });
    });
    if (typeof beforeCreate === 'function') await beforeCreate();
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
    const createdKeys = Object.keys(set.created ?? {});
    if (Object.keys(create).some((key) => !createdKeys.includes(key))) {
      return { ok: false, error: { type: 'noResponse' } };
    }
    for (const card of Object.values(set.created ?? {})) {
      const id = (card as any)?.id;
      if (typeof id === 'string' && id) ids.add(id);
    }
    createdCount += createdKeys.length;
  }
  return {
    ok: true,
    created: createdCount,
    ids: [...ids],
  };
}

/**
 * Add a contact to the requested address book. When any supplied address is
 * already on exactly one card, enrich and re-file that card rather than
 * creating a duplicate.
 */
export async function createContactCard({
  transport,
  account,
  uid = null,
  contact = null,
  addressBookIds = null,
  emails = null,
  name = null,
  bookId = null,
  allowDuplicate = false,
  recoverCreate = false,
  beforeCreate = null,
  useWebSocket = false,
}): Promise<ContactWriteResult> {
  const durableUid = uid == null ? createContactUid() : uid;
  if (!isContactUid(durableUid)) {
    return { ok: false, error: { type: 'invalidArguments', message: 'invalid contact uid' } };
  }
  const fields = withContactDetailKeys(
    contact ?? legacyCreateContactFields(name, emails),
    null,
  );
  const validationIssue = validateProtocolContactFields(fields, {
    rejectEmpty: true,
    requireMapKeys: true,
  });
  if (validationIssue) {
    return {
      ok: false,
      error: { type: 'invalidArguments', message: contactValidationError(validationIssue) },
    };
  }

  if (recoverCreate) {
    const recovered = await findContactCardIdByUid({
      transport,
      account,
      uid: durableUid,
      useWebSocket,
    });
    if (recovered.error) return { ok: false, error: recovered.error };
    if (recovered.id) return { ok: true, id: recovered.id, alreadyExists: true };
  }

  let targetBooks = Array.isArray(addressBookIds)
    ? [...new Set(addressBookIds.filter((id) => typeof id === 'string' && id))]
    : (bookId ? [bookId] : []);
  if (targetBooks.length === 0) {
    const defaultBook = await resolveDefaultBook({ transport, account, useWebSocket });
    if (defaultBook) targetBooks = [defaultBook];
  }

  const addresses = fields.emails.map((email) => email.value);
  let existing = [];
  if (!allowDuplicate && addresses.length > 0) try {
    existing = await findContactCardsForEmails({
      transport, account, emails: addresses, useWebSocket,
    });
  } catch (error: any) {
    return {
      ok: false,
      error: { type: 'serverFail', message: error?.message ?? String(error) },
    };
  }
  if (existing.length > 1) {
    return {
      ok: false,
      error: {
        type: 'duplicateContacts',
        message: 'The supplied addresses belong to more than one existing contact.',
      },
    };
  }
  if (existing.length === 1) {
    const id = String(existing[0].id);
    const fresh = await fetchContactCard({ transport, account, id, useWebSocket });
    if (fresh.error) return { ok: false, error: fresh.error };
    if (!fresh.card || !fresh.state) return { ok: false, error: { type: 'notFound' } };
    const promotionFields = withoutExistingEmails(fields, fresh.card.emails);
    const built = buildSparseContactPatch(fresh.card, emptyContactFields(), promotionFields);
    if (built.error) return { ok: false, error: built.error };
    const patch = built.patch;
    addAddressBookPatches(patch, fresh.card.addressBookIds, targetBooks);
    if (fresh.card.uid == null) patch.uid = durableUid;
    if (Object.keys(patch).length === 0) {
      return { ok: true, id, alreadyExists: true };
    }
    const result = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
      methodCalls: [[
        'ContactCard/set',
        {
          accountId: account.remote_account_id,
          ifInState: fresh.state,
          update: { [id]: patch },
        },
        'cpromote',
      ]],
      useWebSocket,
    });
    const set = pickResponse(result, 'ContactCard/set');
    if (!set) return { ok: false, error: { type: 'serverFail' } };
    if (set.notUpdated?.[id]) {
      return contactSetError('notUpdated', set.notUpdated[id]);
    }
    if (set.updated && id in set.updated) {
      return { ok: true, id, alreadyExists: true };
    }
    return { ok: false, error: { type: 'noResponse' } };
  }
  if (typeof beforeCreate === 'function') await beforeCreate();
  return submitContactCardCreate({
    transport,
    account,
    uid: durableUid,
    contact: fields,
    addressBookIds: targetBooks,
    useWebSocket,
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
  transport,
  account,
  remoteId,
  baseline = null,
  contact = null,
  emails = null,
  name = null,
  useWebSocket = false,
}): Promise<ContactWriteResult> {
  const id = String(remoteId ?? '').trim();
  if (!id) {
    return { ok: false, error: { type: 'invalidArguments', message: 'no remote id' } };
  }
  if (contact && contactFieldsAreEmpty(contact)) {
    return {
      ok: false,
      error: { type: 'invalidArguments', message: 'contact card is empty' },
    };
  }
  const fresh = await fetchContactCard({ transport, account, id, useWebSocket });
  if (fresh.error) return { ok: false, error: fresh.error };
  if (!fresh.card) return { ok: false, error: { type: 'notFound' } };
  if (!fresh.state) {
    return {
      ok: false,
      error: { type: 'serverFail', message: 'ContactCard/get returned no state' },
    };
  }
  const normalizedCurrent = contactFieldsFromCard(fresh.card);
  const before = baseline ?? normalizedCurrent;
  const after = withContactDetailKeys(
    contact ?? legacyUpdatedContactFields(normalizedCurrent, name, emails),
    before,
  );
  const validationIssue = validateProtocolContactFields(after, {
    baseline: before,
    rejectEmpty: true,
  });
  if (validationIssue) {
    return {
      ok: false,
      error: { type: 'invalidArguments', message: contactValidationError(validationIssue) },
    };
  }
  const built = buildSparseContactPatch(fresh.card, before, after);
  if (built.error) return { ok: false, error: built.error };
  const patch = built.patch;
  if (Object.keys(patch).length === 0) return { ok: true };

  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
    methodCalls: [[
      'ContactCard/set',
      {
        accountId: account.remote_account_id,
        ifInState: fresh.state,
        update: { [id]: patch },
      },
      'cupd',
    ]],
    useWebSocket,
  });
  const set = pickResponse(result, 'ContactCard/set');
  if (!set) return { ok: false, error: { type: 'serverFail' } };
  if (set.notUpdated?.[id]) return contactSetError('notUpdated', set.notUpdated[id]);
  // Stalwart returns the id key in `updated` (value may be null).
  if (set.updated && id in set.updated) return { ok: true };
  return { ok: false, error: { type: 'noResponse' } };
}

function contactFieldsFromCard(card: any): ContactMutationFields {
  const normalized = normalizeCard(card);
  if (!normalized) return emptyContactFields();
  return {
    fullName: normalized.fullName,
    emails: normalized.emails.map((email) => ({
      mapKey: email.mapKey,
      position: email.position,
      value: email.email,
      label: email.label,
      contexts: [...email.contexts],
      pref: email.pref,
      isPreferred: email.isPreferred,
    })),
    phones: normalized.phones,
    links: normalized.links,
    anniversaries: normalized.anniversaries,
    notes: normalized.notes,
    organizations: normalized.organizations,
    titles: normalized.titles,
    photo: preferredPhoto(normalized.media),
  };
}

function contactValidationError(issue: ContactFieldValidationIssue): string {
  switch (issue) {
    case 'duplicate-map-key':
      return 'duplicate contact detail map key';
    case 'empty-contact':
      return 'contact card is empty';
    case 'empty-email':
      return 'email address is empty';
    case 'empty-organization':
      return 'organization is empty';
    case 'empty-phone':
      return 'phone number is empty';
    case 'empty-website':
      return 'website is empty';
    case 'invalid-anniversary':
      return 'invalid anniversary';
    case 'invalid-collection':
      return 'invalid contact detail collection';
    case 'invalid-email':
      return 'invalid email address';
    case 'invalid-fields':
      return 'invalid contact fields';
    case 'invalid-map-key':
      return 'invalid contact detail map key';
    case 'invalid-note':
      return 'invalid note';
    case 'invalid-organization-reference':
      return 'invalid title organization reference';
    case 'invalid-photo':
      return 'invalid contact photo';
    case 'invalid-title':
      return 'invalid title';
    case 'invalid-website':
      return 'website must be an absolute HTTP or HTTPS URL';
    default: {
      const exhaustive: never = issue;
      return exhaustive;
    }
  }
}

async function findContactCardIdByUid({
  transport,
  account,
  uid,
  useWebSocket,
}: any): Promise<{ id: string | null; error?: ContactWriteError }> {
  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
    methodCalls: [[
      'ContactCard/query',
      {
        accountId: account.remote_account_id,
        filter: { uid },
        limit: 2,
      },
      'cuid',
    ]],
    useWebSocket,
  });
  const response = pickResponse(result, 'ContactCard/query');
  if (!response || !Array.isArray(response.ids)) {
    const methodError = pickResponse(result, 'error');
    return {
      id: null,
      error: {
        type: 'uidProbeInconclusive',
        message: methodError?.type
          ? `uid probe failed: ${methodError.type}`
          : 'ContactCard/query did not answer the uid probe',
        detail: methodError ?? undefined,
      },
    };
  }
  if (response.ids.length === 0) return { id: null };
  const ids = response.ids.filter((id) => typeof id === 'string');
  if (ids.length !== response.ids.length) {
    return {
      id: null,
      error: { type: 'uidProbeInconclusive', message: 'uid probe returned invalid ids' },
    };
  }
  const got = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
    methodCalls: [[
      'ContactCard/get',
      {
        accountId: account.remote_account_id,
        ids,
        properties: ['id', 'uid'],
      },
      'cuidget',
    ]],
    useWebSocket,
  });
  const answer = pickResponse(got, 'ContactCard/get');
  if (!answer || !Array.isArray(answer.list)) {
    return {
      id: null,
      error: { type: 'uidProbeInconclusive', message: 'uid probe cards could not be verified' },
    };
  }
  const exact = answer.list.filter((card) => card?.uid === uid && ids.includes(card?.id));
  if (exact.length === 1) return { id: exact[0].id };
  return {
    id: null,
    error: {
      type: 'uidProbeInconclusive',
      message: exact.length > 1
        ? 'more than one card has the requested uid'
        : 'the server ignored the uid filter',
    },
  };
}

async function fetchContactCard({
  transport,
  account,
  id,
  useWebSocket,
}: any): Promise<{
  card: any | null;
  state: string | null;
  error?: ContactWriteError;
}> {
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
  if (!answer || !Array.isArray(answer.list)) {
    return {
      card: null,
      state: null,
      error: { type: 'serverFail', message: 'ContactCard/get did not answer' },
    };
  }
  return {
    card: answer.list[0] ?? null,
    state: typeof answer.state === 'string' ? answer.state : null,
  };
}

function withoutExistingEmails(
  fields: ContactMutationFields,
  currentEmails: unknown,
): ContactMutationFields {
  const present = new Set(
    normalizeEmails(currentEmails).map((email) => addressKey(email.email)),
  );
  return {
    ...fields,
    emails: fields.emails.filter((email) => !present.has(addressKey(email.value))),
  };
}

function jmapPatchSegment(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function addAddressBookPatches(
  patch: Record<string, unknown>,
  currentValue: unknown,
  addressBookIds: string[],
): void {
  const additions = addressBookIds.filter(
    (id) => !isPlainObject(currentValue)
      || !hasOwn(currentValue, id)
      || currentValue[id] !== true,
  );
  if (additions.length === 0) return;
  if (!isPlainObject(currentValue)) {
    patch.addressBookIds = Object.fromEntries(additions.map((id) => [id, true]));
    return;
  }
  for (const id of additions) {
    patch[`addressBookIds/${jmapPatchSegment(id)}`] = true;
  }
}

function contactSetError(wrapper: string, detail: any): ContactWriteResult {
  return {
    ok: false,
    error: detail?.type === 'stateMismatch'
      ? { type: 'stateMismatch', detail }
      : { type: wrapper, detail },
  };
}

interface KeyedContactDetail {
  mapKey: string | null;
  position: number;
}

interface SparseMapConfig<T extends KeyedContactDetail> {
  property: string;
  keyPrefix: string;
  currentValue: unknown;
  baseline: T[];
  desired: T[];
  same: (left: T, right: T) => boolean;
  matches: (raw: unknown, detail: T) => boolean;
  sameIdentity: (left: T, right: T) => boolean;
  matchesIdentity: (raw: unknown, detail: T) => boolean;
  build: (detail: T) => Record<string, unknown>;
  merge: (raw: unknown, baseline: T, desired: T) => Record<string, unknown>;
}

function buildSparseContactPatch(
  current: any,
  baseline: ContactMutationFields,
  desired: ContactMutationFields,
): { patch: Record<string, unknown>; error?: ContactWriteError } {
  const patch: Record<string, unknown> = {};
  const currentFullName = isPlainObject(current?.name) && typeof current.name.full === 'string'
    ? current.name.full
    : null;
  if (baseline.fullName !== desired.fullName && currentFullName !== desired.fullName) {
    applyFullNamePatch(patch, current?.name, desired.fullName);
  }
  const maps: SparseMapConfig<any>[] = [
    {
      property: 'emails',
      keyPrefix: 'email',
      currentValue: current?.emails,
      baseline: baseline.emails,
      desired: desired.emails,
      same: sameEmail,
      matches: rawMatchesEmail,
      sameIdentity: sameEmailIdentity,
      matchesIdentity: rawMatchesEmailIdentity,
      build: buildEmail,
      merge: mergeEmail,
    },
    {
      property: 'phones',
      keyPrefix: 'phone',
      currentValue: current?.phones,
      baseline: baseline.phones,
      desired: desired.phones,
      same: samePhone,
      matches: rawMatchesPhone,
      sameIdentity: sameDetailValue,
      matchesIdentity: rawMatchesPhoneIdentity,
      build: buildPhone,
      merge: mergePhone,
    },
    {
      property: 'links',
      keyPrefix: 'link',
      currentValue: current?.links,
      baseline: baseline.links,
      desired: desired.links,
      same: sameResource,
      matches: rawMatchesLink,
      sameIdentity: sameDetailValue,
      matchesIdentity: rawMatchesLinkIdentity,
      build: buildLink,
      merge: mergeLink,
    },
    {
      property: 'anniversaries',
      keyPrefix: 'date',
      currentValue: current?.anniversaries,
      baseline: baseline.anniversaries,
      desired: desired.anniversaries,
      same: sameAnniversary,
      matches: rawMatchesAnniversary,
      sameIdentity: sameAnniversary,
      matchesIdentity: rawMatchesAnniversary,
      build: buildAnniversary,
      merge: mergeAnniversary,
    },
    {
      property: 'notes',
      keyPrefix: 'note',
      currentValue: current?.notes,
      baseline: baseline.notes,
      desired: desired.notes,
      same: sameNote,
      matches: rawMatchesNote,
      sameIdentity: sameDetailValue,
      matchesIdentity: rawMatchesNoteIdentity,
      build: buildNote,
      merge: mergeNote,
    },
    {
      property: 'organizations',
      keyPrefix: 'organization',
      currentValue: current?.organizations,
      baseline: baseline.organizations,
      desired: desired.organizations,
      same: sameOrganization,
      matches: rawMatchesOrganization,
      sameIdentity: sameOrganization,
      matchesIdentity: rawMatchesOrganization,
      build: buildOrganization,
      merge: mergeOrganization,
    },
    {
      property: 'titles',
      keyPrefix: 'title',
      currentValue: current?.titles,
      baseline: baseline.titles,
      desired: desired.titles,
      same: sameTitle,
      matches: rawMatchesTitle,
      sameIdentity: sameTitle,
      matchesIdentity: rawMatchesTitle,
      build: buildTitle,
      merge: mergeTitle,
    },
  ];
  for (const config of maps) {
    const error = applySparseMapPatch(patch, config);
    if (error) return { patch: {}, error };
  }
  const photoError = applySparsePhotoPatch(
    patch,
    current?.media,
    baseline.photo ?? null,
    desired.photo ?? null,
  );
  if (photoError) return { patch: {}, error: photoError };
  return { patch };
}

function samePhoto(left: ContactPhoto, right: ContactPhoto): boolean {
  return left.mapKey === right.mapKey
    && left.uri === right.uri
    && left.blobId === right.blobId
    && left.mediaType === right.mediaType
    && left.pref === right.pref;
}

function rawMatchesPhoto(raw: unknown, photo: ContactPhoto): boolean {
  return isTypedObject(raw, 'Media')
    && raw.kind === 'photo'
    && stringOrNull(raw.uri) === photo.uri
    && stringOrNull(raw.blobId) === photo.blobId
    && stringOrNull(raw.mediaType) === photo.mediaType
    && preference(raw.pref) === photo.pref;
}

function buildPhoto(photo: ContactPhoto): Record<string, unknown> {
  return compactObject({
    '@type': 'Media',
    kind: 'photo',
    uri: photo.uri,
    blobId: photo.blobId,
    mediaType: photo.mediaType,
    pref: photo.pref,
  });
}

function mergePhoto(raw: unknown, photo: ContactPhoto): Record<string, unknown> {
  const next = isPlainObject(raw) ? { ...raw } : {};
  next['@type'] = 'Media';
  next.kind = 'photo';
  if (photo.uri == null) delete next.uri;
  else next.uri = photo.uri;
  if (photo.blobId == null) delete next.blobId;
  else next.blobId = photo.blobId;
  if (photo.mediaType == null) delete next.mediaType;
  else next.mediaType = photo.mediaType;
  if (photo.pref == null) delete next.pref;
  else next.pref = photo.pref;
  return next;
}

function applySparsePhotoPatch(
  patch: Record<string, unknown>,
  currentValue: unknown,
  baseline: ContactPhoto | null,
  desired: ContactPhoto | null,
): ContactWriteError | null {
  if (baseline && desired && samePhoto(baseline, desired)) return null;
  if (!baseline && !desired) return null;
  if (currentValue != null && !isPlainObject(currentValue)) {
    return { type: 'invalidProperties', message: 'media is not a keyed map' };
  }
  const current = isPlainObject(currentValue) ? currentValue : {};
  if (!baseline && desired) {
    if (hasOwn(current, desired.mapKey)) {
      return rawMatchesPhoto(current[desired.mapKey], desired)
        ? null
        : { type: 'stateMismatch', message: 'media map key is already in use' };
    }
    if (currentValue == null) {
      patch.media = { [desired.mapKey]: buildPhoto(desired) };
    } else {
      patch[`media/${jmapPatchSegment(desired.mapKey)}`] = buildPhoto(desired);
    }
    return null;
  }
  if (!baseline) return null;
  const currentPhoto = current[baseline.mapKey];
  if (currentPhoto == null) {
    return desired == null
      ? null
      : { type: 'stateMismatch', message: 'contact photo changed on the server' };
  }
  if (!rawMatchesPhoto(currentPhoto, baseline)) {
    return desired && rawMatchesPhoto(currentPhoto, desired)
      ? null
      : { type: 'stateMismatch', message: 'contact photo changed on the server' };
  }
  if (!desired) {
    patch[`media/${jmapPatchSegment(baseline.mapKey)}`] = null;
    return null;
  }
  if (desired.mapKey !== baseline.mapKey) {
    if (hasOwn(current, desired.mapKey)) {
      return { type: 'stateMismatch', message: 'media map key is already in use' };
    }
    patch[`media/${jmapPatchSegment(baseline.mapKey)}`] = null;
    patch[`media/${jmapPatchSegment(desired.mapKey)}`] = buildPhoto(desired);
    return null;
  }
  patch[`media/${jmapPatchSegment(desired.mapKey)}`] = mergePhoto(currentPhoto, desired);
  return null;
}

function applyFullNamePatch(
  patch: Record<string, unknown>,
  currentName: unknown,
  fullName: string | null,
): void {
  if (!isPlainObject(currentName)) {
    if (fullName != null) patch.name = { full: fullName };
    return;
  }
  if (fullName != null) {
    patch['name/full'] = fullName;
    return;
  }
  const remaining = Object.keys(currentName).filter(
    (property) => property !== 'full' && property !== '@type',
  );
  if (remaining.length === 0) patch.name = null;
  else patch['name/full'] = null;
}

function applySparseMapPatch<T extends KeyedContactDetail>(
  patch: Record<string, unknown>,
  config: SparseMapConfig<T>,
): ContactWriteError | null {
  const parentPresent = config.currentValue != null;
  if (parentPresent && !isPlainObject(config.currentValue)) {
    return {
      type: 'invalidProperties',
      message: `${config.property} is not a keyed map`,
    };
  }
  const current = isPlainObject(config.currentValue) ? config.currentValue : {};
  const claimedCurrentKeys = new Set<string>();
  const resolvedBaseline = resolveLegacyKeys(
    config.baseline,
    current,
    config.matchesIdentity,
    claimedCurrentKeys,
  );
  if (!resolvedBaseline.ok) {
    return {
      type: 'contactNeedsSync',
      message: `${config.property} legacy keys could not be resolved uniquely`,
      terminal: true,
    };
  }
  const resolvedDesired = resolveDesiredLegacyKeys(
    config.desired,
    resolvedBaseline.details,
    config.sameIdentity,
    config.keyPrefix,
  );
  if (!resolvedDesired.ok) {
    return {
      type: 'contactNeedsSync',
      message: `${config.property} legacy edit could not be resolved uniquely`,
      terminal: true,
    };
  }
  const baseline = resolvedBaseline.details;
  const desired = resolvedDesired.details;
  const beforeByKey = new Map(
    baseline
      .filter((detail): detail is T & { mapKey: string } => isMapKey(detail.mapKey))
      .map((detail) => [detail.mapKey, detail]),
  );
  const afterByKey = new Map(
    desired
      .filter((detail): detail is T & { mapKey: string } => isMapKey(detail.mapKey))
      .map((detail) => [detail.mapKey, detail]),
  );
  const additions = new Map<string, unknown>();
  for (const [key, before] of beforeByKey) {
    const after = afterByKey.get(key);
    if (!after) {
      if (hasOwn(current, key)) patch[`${config.property}/${key}`] = null;
      continue;
    }
    if (config.same(before, after)) continue;
    additions.set(
      key,
      hasOwn(current, key)
        ? config.merge(current[key], before, after)
        : config.build(after),
    );
  }
  for (const [key, after] of afterByKey) {
    if (beforeByKey.has(key)) continue;
    if (hasOwn(current, key)) {
      if (!config.matches(current[key], after)) {
        return {
          type: 'stateMismatch',
          message: `${config.property} map key is already in use`,
        };
      }
      continue;
    }
    additions.set(key, config.build(after));
  }
  if (!parentPresent) {
    if (additions.size > 0) patch[config.property] = Object.fromEntries(additions);
  } else {
    for (const [key, entry] of additions) {
      patch[`${config.property}/${key}`] = entry;
    }
  }
  return null;
}

function resolveLegacyKeys<T extends KeyedContactDetail>(
  details: T[],
  current: Record<string, any>,
  matches: (raw: unknown, detail: T) => boolean,
  claimed: Set<string>,
): { ok: true; details: T[] } | { ok: false } {
  const entries = Object.entries(current).filter(([key]) => isMapKey(key));
  const resolved = [...details];
  const pending: number[] = [];
  details.forEach((detail, index) => {
    if (isMapKey(detail.mapKey)) {
      claimed.add(detail.mapKey);
      return;
    }
    const matched = entries.filter(
      ([key, raw]) => !claimed.has(key) && isMapKey(key) && matches(raw, detail),
    );
    if (matched.length > 1) {
      pending.push(-1);
      return;
    }
    if (matched.length === 1) {
      claimed.add(matched[0][0]);
      resolved[index] = { ...detail, mapKey: matched[0][0] };
      return;
    }
    pending.push(index);
  });
  if (pending.includes(-1)) return { ok: false };
  for (const index of pending) {
    const detail = details[index];
    const fallback = entries[detail.position];
    if (!fallback || claimed.has(fallback[0])) return { ok: false };
    claimed.add(fallback[0]);
    resolved[index] = { ...detail, mapKey: fallback[0] };
  }
  return { ok: true, details: resolved };
}

function resolveDesiredLegacyKeys<T extends KeyedContactDetail>(
  desired: T[],
  baseline: T[],
  sameIdentity: (left: T, right: T) => boolean,
  keyPrefix: string,
): { ok: true; details: T[] } | { ok: false } {
  const claimedBaseline = new Set<number>();
  const resolved = [...desired];
  const pending: number[] = [];
  desired.forEach((detail, desiredIndex) => {
    if (isMapKey(detail.mapKey)) {
      const baselineIndex = baseline.findIndex(
        (candidate) => candidate.mapKey === detail.mapKey,
      );
      if (baselineIndex >= 0) claimedBaseline.add(baselineIndex);
      return;
    }
    const matches = baseline
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate, index }) => isMapKey(candidate.mapKey)
        && !claimedBaseline.has(index)
        && sameIdentity(candidate, detail),
      );
    if (matches.length > 1) {
      pending.push(-1);
      return;
    }
    if (matches.length === 1 && isMapKey(matches[0].candidate.mapKey)) {
      claimedBaseline.add(matches[0].index);
      resolved[desiredIndex] = { ...detail, mapKey: matches[0].candidate.mapKey };
      return;
    }
    pending.push(desiredIndex);
  });
  if (pending.includes(-1)) return { ok: false };

  const remainingBaselineBeforeFallback = baseline.filter(
    (_, index) => !claimedBaseline.has(index),
  ).length;
  for (const desiredIndex of pending) {
    const detail = desired[desiredIndex];
    const matches = baseline
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate, index }) => !claimedBaseline.has(index)
        && candidate.position === detail.position);
    if (
      matches.length === 1
      && remainingBaselineBeforeFallback <= pending.length
      && isMapKey(matches[0].candidate.mapKey)
    ) {
      claimedBaseline.add(matches[0].index);
      resolved[desiredIndex] = { ...detail, mapKey: matches[0].candidate.mapKey };
    }
  }

  const unresolved = pending.filter((index) => !isMapKey(resolved[index].mapKey));
  if (unresolved.length > 0 && baseline.some((_, index) => !claimedBaseline.has(index))) {
    return { ok: false };
  }
  for (const index of unresolved) {
    resolved[index] = { ...resolved[index], mapKey: createContactMapKey(keyPrefix) };
  }
  return { ok: true, details: resolved };
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasOwn(value: object, property: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function sameResource(left: ContactDetailLink, right: ContactDetailLink): boolean {
  return left.value === right.value
    && left.label === right.label
    && left.pref === right.pref
    && sameStringSet(left.contexts, right.contexts);
}

function sameDetailValue(
  left: { value: string },
  right: { value: string },
): boolean {
  return left.value === right.value;
}

function sameEmailIdentity(
  left: ContactMutationFields['emails'][number],
  right: ContactMutationFields['emails'][number],
): boolean {
  return addressKey(left.value) === addressKey(right.value);
}

function sameEmail(
  left: ContactMutationFields['emails'][number],
  right: ContactMutationFields['emails'][number],
): boolean {
  return sameResource(left, right);
}

function samePhone(left: ContactDetailPhone, right: ContactDetailPhone): boolean {
  return sameResource(left, right)
    && sameStringSet(left.features, right.features);
}

function sameAnniversary(
  left: ContactDetailAnniversary,
  right: ContactDetailAnniversary,
): boolean {
  return left.kind === right.kind && sameContactDate(left.date, right.date);
}

function sameContactDate(left: ContactAnniversaryDate, right: ContactAnniversaryDate): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'timestamp' && right.kind === 'timestamp') return left.utc === right.utc;
  return left.kind === 'partial' && right.kind === 'partial'
    && left.year === right.year
    && left.month === right.month
    && left.day === right.day;
}

function sameNote(left: ContactDetailNote, right: ContactDetailNote): boolean {
  return left.value === right.value;
}

function sameOrganization(
  left: ContactDetailOrganization,
  right: ContactDetailOrganization,
): boolean {
  return left.name === right.name
    && sameStringSet(left.contexts, right.contexts)
    && left.units.length === right.units.length
    && left.units.every((unit, index) => unit.value === right.units[index]?.value);
}

function sameTitle(left: ContactDetailTitle, right: ContactDetailTitle): boolean {
  return left.value === right.value
    && left.kind === right.kind
    && left.organizationMapKey === right.organizationMapKey;
}

function buildEmail(detail: ContactMutationFields['emails'][number]): Record<string, unknown> {
  return compactObject({
    '@type': 'EmailAddress',
    address: detail.value,
    contexts: booleanSet(detail.contexts),
    pref: detail.pref,
    label: detail.label,
  });
}

function mergeEmail(
  raw: unknown,
  baseline: ContactMutationFields['emails'][number],
  desired: ContactMutationFields['emails'][number],
): Record<string, unknown> {
  const next = isPlainObject(raw) ? { ...raw } : buildEmail(desired);
  if (baseline.value !== desired.value) next.address = desired.value;
  mergeResourceMetadata(next, baseline, desired);
  return next;
}

function buildPhone(detail: ContactDetailPhone): Record<string, unknown> {
  return compactObject({
    '@type': 'Phone',
    number: detail.value,
    contexts: booleanSet(detail.contexts),
    features: booleanSet(detail.features),
    pref: detail.pref,
    label: detail.label,
  });
}

function mergePhone(
  raw: unknown,
  baseline: ContactDetailPhone,
  desired: ContactDetailPhone,
): Record<string, unknown> {
  const next = isPlainObject(raw) ? { ...raw } : buildPhone(desired);
  if (baseline.value !== desired.value) next.number = desired.value;
  mergeResourceMetadata(next, baseline, desired);
  if (!sameStringSet(baseline.features, desired.features)) {
    assignOptional(
      next,
      'features',
      mergeKnownBooleanSet(next.features, standardPhoneFeatureNames, desired.features),
    );
  }
  return next;
}

function buildLink(detail: ContactDetailLink): Record<string, unknown> {
  return compactObject({
    '@type': 'Link',
    uri: detail.value,
    contexts: booleanSet(detail.contexts),
    pref: detail.pref,
    label: detail.label,
  });
}

function mergeLink(
  raw: unknown,
  baseline: ContactDetailLink,
  desired: ContactDetailLink,
): Record<string, unknown> {
  const next = isPlainObject(raw) ? { ...raw } : buildLink(desired);
  if (baseline.value !== desired.value) next.uri = desired.value;
  mergeResourceMetadata(next, baseline, desired);
  return next;
}

function mergeResourceMetadata(
  next: Record<string, any>,
  baseline: ContactDetailLink,
  desired: ContactDetailLink,
): void {
  if (baseline.label !== desired.label) assignOptional(next, 'label', desired.label);
  if (baseline.pref !== desired.pref) assignOptional(next, 'pref', desired.pref);
  if (!sameStringSet(baseline.contexts, desired.contexts)) {
    assignOptional(
      next,
      'contexts',
      mergeKnownBooleanSet(next.contexts, standardContextNames, desired.contexts),
    );
  }
}

function buildAnniversary(detail: ContactDetailAnniversary): Record<string, unknown> {
  return {
    '@type': 'Anniversary',
    kind: detail.kind,
    date: buildContactDate(detail.date),
  };
}

function mergeAnniversary(
  raw: unknown,
  baseline: ContactDetailAnniversary,
  desired: ContactDetailAnniversary,
): Record<string, unknown> {
  const next = isPlainObject(raw) ? { ...raw } : buildAnniversary(desired);
  if (baseline.kind !== desired.kind) next.kind = desired.kind;
  if (!sameContactDate(baseline.date, desired.date)) {
    next.date = mergeContactDate(next.date, baseline.date, desired.date);
  }
  return next;
}

function buildContactDate(date: ContactAnniversaryDate): Record<string, unknown> {
  if (date.kind === 'timestamp') return { '@type': 'Timestamp', utc: date.utc };
  return compactObject({
    '@type': 'PartialDate',
    year: date.year,
    month: date.month,
    day: date.day,
  });
}

function mergeContactDate(
  raw: unknown,
  baseline: ContactAnniversaryDate,
  desired: ContactAnniversaryDate,
): Record<string, unknown> {
  if (baseline.kind !== desired.kind || !isPlainObject(raw)) return buildContactDate(desired);
  const next = { ...raw };
  if (desired.kind === 'timestamp') {
    next['@type'] = 'Timestamp';
    next.utc = desired.utc;
    return next;
  }
  next['@type'] = 'PartialDate';
  assignOptional(next, 'year', desired.year);
  assignOptional(next, 'month', desired.month);
  assignOptional(next, 'day', desired.day);
  return next;
}

function buildNote(detail: ContactDetailNote): Record<string, unknown> {
  return { '@type': 'Note', note: detail.value };
}

function mergeNote(
  raw: unknown,
  baseline: ContactDetailNote,
  desired: ContactDetailNote,
): Record<string, unknown> {
  const next = isPlainObject(raw) ? { ...raw } : buildNote(desired);
  if (baseline.value !== desired.value) next.note = desired.value;
  return next;
}

function buildOrganization(detail: ContactDetailOrganization): Record<string, unknown> {
  return compactObject({
    '@type': 'Organization',
    name: detail.name,
    contexts: booleanSet(detail.contexts),
    units: detail.units.length > 0
      ? detail.units.map((unit) => ({ '@type': 'OrgUnit', name: unit.value }))
      : null,
  });
}

function mergeOrganization(
  raw: unknown,
  baseline: ContactDetailOrganization,
  desired: ContactDetailOrganization,
): Record<string, unknown> {
  const next = isPlainObject(raw) ? { ...raw } : buildOrganization(desired);
  if (baseline.name !== desired.name) assignOptional(next, 'name', desired.name);
  if (!sameStringSet(baseline.contexts, desired.contexts)) {
    assignOptional(
      next,
      'contexts',
      mergeKnownBooleanSet(next.contexts, standardContextNames, desired.contexts),
    );
  }
  if (
    baseline.units.length !== desired.units.length
    || baseline.units.some((unit, index) => unit.value !== desired.units[index]?.value)
  ) {
    const currentUnits = Array.isArray(next.units) ? next.units : [];
    assignOptional(
      next,
      'units',
      mergeOrganizationUnits(currentUnits, baseline.units, desired.units),
    );
  }
  return next;
}

function mergeOrganizationUnits(
  current: unknown[],
  baseline: ContactDetailOrganization['units'],
  desired: ContactDetailOrganization['units'],
): Record<string, unknown>[] {
  const baselineToCurrent = new Map<number, number>();
  const claimedCurrent = new Set<number>();
  baseline.forEach((unit, baselineIndex) => {
    const uniqueBaselineValue = baseline.filter(
      (candidate) => candidate.value === unit.value,
    ).length === 1;
    const matches = current
      .map((candidate, currentIndex) => ({ candidate, currentIndex }))
      .filter(({ candidate, currentIndex }) => !claimedCurrent.has(currentIndex)
        && isPlainObject(candidate)
        && candidate.name === unit.value);
    if (uniqueBaselineValue && matches.length === 1) {
      baselineToCurrent.set(baselineIndex, matches[0].currentIndex);
      claimedCurrent.add(matches[0].currentIndex);
    }
  });
  baseline.forEach((_, baselineIndex) => {
    if (baselineToCurrent.has(baselineIndex)) return;
    if (baselineIndex < current.length && !claimedCurrent.has(baselineIndex)) {
      baselineToCurrent.set(baselineIndex, baselineIndex);
      claimedCurrent.add(baselineIndex);
    }
  });

  const desiredToBaseline = new Map<number, number>();
  const claimedBaseline = new Set<number>();
  desired.forEach((unit, desiredIndex) => {
    const matches = baseline
      .map((candidate, baselineIndex) => ({ candidate, baselineIndex }))
      .filter(({ candidate, baselineIndex }) => !claimedBaseline.has(baselineIndex)
        && candidate.value === unit.value);
    if (matches.length === 1) {
      desiredToBaseline.set(desiredIndex, matches[0].baselineIndex);
      claimedBaseline.add(matches[0].baselineIndex);
    }
  });
  if (desiredToBaseline.size === 0 && desired.length === baseline.length) {
    desired.forEach((_, desiredIndex) => {
      if (!claimedBaseline.has(desiredIndex)) {
        desiredToBaseline.set(desiredIndex, desiredIndex);
        claimedBaseline.add(desiredIndex);
      }
    });
  }

  const edited = desired.map((unit, desiredIndex) => {
    const baselineIndex = desiredToBaseline.get(desiredIndex);
    const currentIndex = baselineIndex == null
      ? null
      : baselineToCurrent.get(baselineIndex);
    return currentIndex != null && isPlainObject(current[currentIndex])
      ? { ...current[currentIndex], name: unit.value }
      : { '@type': 'OrgUnit', name: unit.value };
  });
  const concurrent = current
    .filter((candidate, currentIndex) => (
      !claimedCurrent.has(currentIndex) && isPlainObject(candidate)
    ))
    .map((candidate) => ({ ...(candidate as Record<string, unknown>) }));
  return [...edited, ...concurrent];
}

function buildTitle(detail: ContactDetailTitle): Record<string, unknown> {
  return compactObject({
    '@type': 'Title',
    name: detail.value,
    kind: detail.kind,
    organizationId: detail.organizationMapKey,
  });
}

function mergeTitle(
  raw: unknown,
  baseline: ContactDetailTitle,
  desired: ContactDetailTitle,
): Record<string, unknown> {
  const next = isPlainObject(raw) ? { ...raw } : buildTitle(desired);
  if (baseline.value !== desired.value) next.name = desired.value;
  if (baseline.kind !== desired.kind) next.kind = desired.kind;
  if (baseline.organizationMapKey !== desired.organizationMapKey) {
    assignOptional(next, 'organizationId', desired.organizationMapKey);
  }
  return next;
}

const standardContextNames = ['private', 'work'] as const;
const standardPhoneFeatureNames = [
  'fax',
  'main-number',
  'mobile',
  'pager',
  'text',
  'textphone',
  'video',
  'voice',
] as const;

function booleanSet(values: readonly string[]): Record<string, true> | null {
  return values.length > 0
    ? Object.fromEntries(values.map((value) => [value, true]))
    : null;
}

function mergeKnownBooleanSet(
  current: unknown,
  known: readonly string[],
  desired: readonly string[],
): Record<string, unknown> | null {
  const next = isPlainObject(current) ? { ...current } : {};
  for (const key of known) delete next[key];
  for (const key of desired) next[key] = true;
  return Object.keys(next).length > 0 ? next : null;
}

function assignOptional(
  target: Record<string, any>,
  property: string,
  value: unknown,
): void {
  if (value == null || (Array.isArray(value) && value.length === 0)) delete target[property];
  else target[property] = value;
}

function compactObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item != null),
  );
}

function rawMatchesEmail(
  raw: unknown,
  detail: ContactMutationFields['emails'][number],
): boolean {
  const normalized = normalizeEmails({ match: raw })[0];
  return Boolean(normalized && sameEmail(
    {
      mapKey: detail.mapKey,
      position: detail.position,
      value: normalized.email,
      label: normalized.label,
      contexts: normalized.contexts,
      pref: normalized.pref,
      isPreferred: normalized.isPreferred,
    },
    detail,
  ));
}

function rawMatchesEmailIdentity(
  raw: unknown,
  detail: ContactMutationFields['emails'][number],
): boolean {
  const normalized = normalizeEmails({ match: raw })[0];
  return Boolean(normalized && addressKey(normalized.email) === addressKey(detail.value));
}

function rawMatchesPhone(raw: unknown, detail: ContactDetailPhone): boolean {
  const normalized = normalizePhones({ match: raw })[0];
  return Boolean(normalized && samePhone(normalized, detail));
}

function rawMatchesPhoneIdentity(raw: unknown, detail: ContactDetailPhone): boolean {
  const normalized = normalizePhones({ match: raw })[0];
  return Boolean(normalized && normalized.value === detail.value);
}

function rawMatchesLink(raw: unknown, detail: ContactDetailLink): boolean {
  const normalized = normalizeLinks({ match: raw })[0];
  return Boolean(normalized && sameResource(normalized, detail));
}

function rawMatchesLinkIdentity(raw: unknown, detail: ContactDetailLink): boolean {
  const normalized = normalizeLinks({ match: raw })[0];
  return Boolean(normalized && normalized.value === detail.value);
}

function rawMatchesAnniversary(raw: unknown, detail: ContactDetailAnniversary): boolean {
  const normalized = normalizeAnniversaries({ match: raw })[0];
  return Boolean(normalized && sameAnniversary(normalized, detail));
}

function rawMatchesNote(raw: unknown, detail: ContactDetailNote): boolean {
  const normalized = normalizeNotes({ match: raw })[0];
  return Boolean(normalized && sameNote(normalized, detail));
}

function rawMatchesNoteIdentity(raw: unknown, detail: ContactDetailNote): boolean {
  const normalized = normalizeNotes({ match: raw })[0];
  return Boolean(normalized && normalized.value === detail.value);
}

function rawMatchesOrganization(raw: unknown, detail: ContactDetailOrganization): boolean {
  const normalized = normalizeOrganizations({ organizations: { match: raw } })[0];
  return Boolean(normalized && sameOrganization(normalized, detail));
}

function rawMatchesTitle(raw: unknown, detail: ContactDetailTitle): boolean {
  const normalized = normalizeTitles({ match: raw })[0];
  return Boolean(normalized && sameTitle(normalized, detail));
}

export interface ContactBatchWireTarget {
  contactId: number;
  remoteId: string;
}

export interface ContactBatchWireOperation {
  operation: 'move';
  sourceAddressbookRemoteId: string;
  targetAddressbookRemoteId: string;
}

interface ContactBatchChunkResult extends ContactBatchMutationResult {
  destroyedRemoteIds: string[];
  updatedRemoteIds: string[];
}

export interface ContactBatchProtocolResult {
  complete: boolean;
  error?: ContactWriteError;
  result: ContactBatchChunkResult;
}

const CONTACT_BATCH_REBASE_ATTEMPTS = 3;
const RETRYABLE_CONTACT_BATCH_ERRORS = new Set([
  'noResponse',
  'rateLimit',
  'serverFail',
  'serverPartialFail',
  'serverUnavailable',
  'stateMismatch',
]);

function emptyContactBatchChunkResult(): ContactBatchChunkResult {
  return {
    succeededContactIds: [],
    updatedContactIds: [],
    destroyedContactIds: [],
    failures: [],
    updatedRemoteIds: [],
    destroyedRemoteIds: [],
  };
}

function mergeContactBatchChunkResult(
  target: ContactBatchChunkResult,
  source: ContactBatchChunkResult,
): void {
  target.succeededContactIds.push(...source.succeededContactIds);
  target.updatedContactIds.push(...source.updatedContactIds);
  target.destroyedContactIds.push(...source.destroyedContactIds);
  target.failures.push(...source.failures);
  target.updatedRemoteIds.push(...source.updatedRemoteIds);
  target.destroyedRemoteIds.push(...source.destroyedRemoteIds);
}

function cardAddressbookRemoteIds(card: any): string[] | null {
  if (isPlainObject(card?.addressBookIds)) {
    const entries = Object.entries(card.addressBookIds);
    if (entries.some(([id, present]) => !isMapKey(id) || present !== true)) return null;
    return entries.map(([id]) => id);
  }
  if (typeof card?.addressBookId === 'string' && card.addressBookId) {
    return [card.addressBookId];
  }
  return null;
}

async function fetchContactBatchRights({
  transport,
  account,
  useWebSocket,
}: any): Promise<
  | { ok: true; rights: Map<string, boolean> }
  | { ok: false; error: ContactWriteError }
> {
  const response = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
    methodCalls: [[
      'AddressBook/get',
      {
        accountId: account.remote_account_id,
        properties: ['id', 'myRights'],
      },
      'abbatch',
    ]],
    useWebSocket,
  });
  const answer = pickResponse(response, 'AddressBook/get');
  if (!answer || !Array.isArray(answer.list)) {
    const detail = pickResponse(response, 'error');
    return {
      ok: false,
      error: {
        type: detail?.type ?? 'serverFail',
        detail,
      },
    };
  }
  const rights = new Map<string, boolean>();
  for (const book of answer.list) {
    if (typeof book?.id !== 'string' || !book.id) continue;
    rights.set(book.id, book.myRights?.mayWrite === true);
  }
  return { ok: true, rights };
}

function contactBatchFailure(
  contactId: number,
  errorType: string,
  detail?: any,
): ContactBatchFailure {
  const description = typeof detail?.description === 'string'
    ? detail.description
    : (typeof detail?.message === 'string' ? detail.message : undefined);
  return {
    contactId,
    errorType,
    ...(description ? { message: description } : {}),
  };
}

function contactBatchSetErrorType(reason: any, fallback: string): string {
  return typeof reason?.type === 'string' && reason.type
    ? reason.type
    : fallback;
}

function prepareContactBatchChunk(
  targets: ContactBatchWireTarget[],
  cardsById: Map<string, any>,
  rights: Map<string, boolean>,
  operation: ContactBatchWireOperation,
): {
  result: ContactBatchChunkResult;
  update: Record<string, Record<string, unknown>>;
  writeTargets: Map<string, ContactBatchWireTarget>;
} {
  const result = emptyContactBatchChunkResult();
  const update: Record<string, Record<string, unknown>> = {};
  const writeTargets = new Map<string, ContactBatchWireTarget>();

  for (const target of targets) {
    const card = cardsById.get(target.remoteId);
    if (!card) {
      result.succeededContactIds.push(target.contactId);
      result.destroyedContactIds.push(target.contactId);
      result.destroyedRemoteIds.push(target.remoteId);
      continue;
    }
    const memberships = cardAddressbookRemoteIds(card);
    if (!memberships || memberships.length === 0) {
      result.failures.push(contactBatchFailure(
        target.contactId,
        'invalidContactMembership',
      ));
      continue;
    }

    const source = operation.sourceAddressbookRemoteId;
    const destination = operation.targetAddressbookRemoteId;
    if (rights.get(source) !== true || rights.get(destination) !== true) {
      result.failures.push(contactBatchFailure(target.contactId, 'forbidden'));
      continue;
    }
    const inSource = memberships.includes(source);
    const inDestination = memberships.includes(destination);
    if (!inSource) {
      if (inDestination) {
        result.succeededContactIds.push(target.contactId);
        result.updatedContactIds.push(target.contactId);
        result.updatedRemoteIds.push(target.remoteId);
      } else {
        result.failures.push(contactBatchFailure(
          target.contactId,
          'sourceMembershipMissing',
        ));
      }
      continue;
    }
    const patch: Record<string, unknown> = {
      [`addressBookIds/${jmapPatchSegment(source)}`]: null,
    };
    if (!inDestination) {
      patch[`addressBookIds/${jmapPatchSegment(destination)}`] = true;
    }
    update[target.remoteId] = patch;
    writeTargets.set(target.remoteId, target);
  }
  return {
    result,
    update,
    writeTargets,
  };
}

function applyContactBatchSetResponse(
  prepared: ReturnType<typeof prepareContactBatchChunk>,
  response: any,
): { result: ContactBatchChunkResult; retryableError: ContactWriteError | null } {
  const result = prepared.result;
  let retryableError: ContactWriteError | null = null;
  for (const [remoteId, target] of prepared.writeTargets) {
    if (response.updated && remoteId in response.updated) {
      result.succeededContactIds.push(target.contactId);
      result.updatedContactIds.push(target.contactId);
      result.updatedRemoteIds.push(remoteId);
      continue;
    }
    const reason = response.notUpdated?.[remoteId];
    const errorType = contactBatchSetErrorType(reason, 'noResponse');
    if (RETRYABLE_CONTACT_BATCH_ERRORS.has(errorType)) {
      retryableError ??= { type: errorType, detail: reason };
    } else {
      result.failures.push(contactBatchFailure(target.contactId, errorType, reason));
    }
  }
  return { result, retryableError };
}

async function runContactBatchChunk({
  transport,
  account,
  targets,
  rights,
  operation,
  useWebSocket,
}: any): Promise<{
  result: ContactBatchChunkResult;
  retryableError: ContactWriteError | null;
}> {
  for (let attempt = 1; attempt <= CONTACT_BATCH_REBASE_ATTEMPTS; attempt += 1) {
    const fetched = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
      methodCalls: [[
        'ContactCard/get',
        {
          accountId: account.remote_account_id,
          ids: targets.map((target) => target.remoteId),
        },
        'cbget',
      ]],
      useWebSocket,
    });
    const answer = pickResponse(fetched, 'ContactCard/get');
    if (!answer || !Array.isArray(answer.list) || typeof answer.state !== 'string') {
      const detail = pickResponse(fetched, 'error');
      return {
        result: emptyContactBatchChunkResult(),
        retryableError: { type: detail?.type ?? 'serverFail', detail },
      };
    }
    const cardsById = new Map<string, any>(
      answer.list
        .filter((card) => typeof card?.id === 'string')
        .map((card) => [card.id, card]),
    );
    const prepared = prepareContactBatchChunk(
      targets,
      cardsById,
      rights,
      operation,
    );
    if (Object.keys(prepared.update).length === 0) {
      return { result: prepared.result, retryableError: null };
    }

    const written = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
      methodCalls: [[
        'ContactCard/set',
        {
          accountId: account.remote_account_id,
          ifInState: answer.state,
          update: prepared.update,
        },
        'cbset',
      ]],
      useWebSocket,
    });
    const set = pickResponse(written, 'ContactCard/set');
    if (!set) {
      const detail = pickResponse(written, 'error');
      if (
        detail?.type === 'stateMismatch'
        && attempt < CONTACT_BATCH_REBASE_ATTEMPTS
      ) {
        continue;
      }
      return {
        result: prepared.result,
        retryableError: {
          type: detail?.type ?? 'noResponse',
          detail,
        },
      };
    }
    return applyContactBatchSetResponse(prepared, set);
  }
  return {
    result: emptyContactBatchChunkResult(),
    retryableError: { type: 'stateMismatch' },
  };
}

export async function mutateContactCardsBatch({
  transport,
  account,
  targets,
  operation,
  onChunk,
  useWebSocket = false,
}: {
  transport: any;
  account: any;
  targets: ContactBatchWireTarget[];
  operation: ContactBatchWireOperation;
  onChunk?: (result: ContactBatchChunkResult) => Promise<void>;
  useWebSocket?: boolean;
}): Promise<ContactBatchProtocolResult> {
  const rights = await fetchContactBatchRights({
    transport,
    account,
    useWebSocket,
  });
  if (rights.ok === false) {
    return {
      complete: false,
      error: rights.error,
      result: emptyContactBatchChunkResult(),
    };
  }

  const result = emptyContactBatchChunkResult();
  const cap = Math.min(maxObjectsInGet(transport), maxObjectsInSet(transport));
  for (let offset = 0; offset < targets.length; offset += cap) {
    const chunk = await runContactBatchChunk({
      transport,
      account,
      targets: targets.slice(offset, offset + cap),
      rights: rights.rights,
      operation,
      useWebSocket,
    });
    mergeContactBatchChunkResult(result, chunk.result);
    if (
      chunk.result.succeededContactIds.length > 0
      || chunk.result.failures.length > 0
    ) {
      await onChunk?.(chunk.result);
    }
    if (chunk.retryableError) {
      return {
        complete: false,
        error: chunk.retryableError,
        result,
      };
    }
  }
  return { complete: true, result };
}

async function fetchRawContactCards({
  transport,
  account,
  ids,
  useWebSocket,
}: any): Promise<{ cards: any[]; missingIds: string[] }> {
  const requested: string[] = [...new Set<string>(
    (ids ?? []).filter(
      (id: unknown): id is string => typeof id === 'string' && id.length > 0,
    ),
  )];
  const cards: any[] = [];
  const missingIds: string[] = [];
  const cap = maxObjectsInGet(transport);
  for (let offset = 0; offset < requested.length; offset += cap) {
    const chunk = requested.slice(offset, offset + cap);
    const result = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
      methodCalls: [[
        'ContactCard/get',
        {
          accountId: account.remote_account_id,
          ids: chunk,
        },
        'cbrepair',
      ]],
      useWebSocket,
    });
    const answer = pickResponse(result, 'ContactCard/get');
    if (!answer || !Array.isArray(answer.list)) {
      throw new Error('ContactCard/get did not answer batch cache repair');
    }
    cards.push(...answer.list);
    const returned = new Set<string>(
      answer.list
        .map((card) => card?.id)
        .filter((id): id is string => typeof id === 'string'),
    );
    missingIds.push(...chunk.filter((id) => !returned.has(id)));
  }
  return { cards, missingIds };
}

export async function reconcileContactCardBatch({
  transport,
  account,
  handlers,
  updatedIds,
  destroyedIds,
  useWebSocket = false,
}: any): Promise<{ destroyed: number; updated: number }> {
  const updated: string[] = [...new Set<string>(
    (updatedIds ?? []).filter(
      (id: unknown): id is string => typeof id === 'string' && id.length > 0,
    ),
  )];
  const destroyed = new Set<string>(
    (destroyedIds ?? []).filter(
      (id: unknown): id is string => typeof id === 'string' && id.length > 0,
    ),
  );
  const books = await syncAddressBooks({
    transport,
    account,
    handlers,
    useWebSocket,
    broadcast: false,
  });
  if (!books.complete) {
    throw new Error('AddressBook/get did not answer batch cache repair');
  }

  let contacts: any[] = [];
  if (updated.length > 0) {
    const fetched = await fetchRawContactCards({
      transport,
      account,
      ids: updated,
      useWebSocket,
    });
    for (const id of fetched.missingIds) destroyed.add(id);
    const prepared = await contactCardsForPersistence({
      account,
      cards: fetched.cards,
      handlers,
    });
    if (prepared.skipped > 0) {
      throw new Error(`${prepared.skipped} card(s) read back but not filed`);
    }
    contacts = prepared.contacts;
  }

  if (contacts.length > 0) {
    await handlers[DB_RPC.CONTACT_UPSERT_MANY]({
      accountId: account.id,
      contacts,
      broadcast: false,
    });
  }
  const deletion = await handlers[DB_RPC.CONTACT_DELETE_LOCAL]({
    accountId: account.id,
    remoteIds: [...destroyed],
    broadcast: true,
  });
  return {
    updated: contacts.length,
    destroyed: Number(deletion?.deleted ?? 0),
  };
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
  const chosen = list.find((book) => book.isDefault)
    ?? list.find((book) => !isTrustedSendersBook(book))
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

function duplicateCheckPagingError(reason: CompleteQueryFailureReason): Error {
  switch (reason) {
    case 'queryStateChanged':
    case 'queryTotalChanged':
      return new Error('ContactCard/query changed during the duplicate check');
    case 'queryStateMissing':
      return new Error('ContactCard/query did not provide stable paging state');
    case 'cursorStalled':
    case 'positionPastTotal':
    case 'truncated':
    case 'pageLimitReached':
      return new Error('ContactCard/query did not complete the duplicate check');
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

async function visitContactCardsForEmails({
  transport,
  account,
  emails,
  properties,
  useWebSocket,
  visitCard,
}: {
  transport: any;
  account: any;
  emails: string[];
  properties?: string[];
  useWebSocket?: boolean;
  visitCard: (card: any) => void;
}): Promise<void> {
  const queryEmails = [...new Set(emails.flatMap((email) => {
    const key = addressKey(email);
    return key && key !== email ? [email, key] : [email];
  }))];
  const filter = queryEmails.length === 1
    ? { email: queryEmails[0] }
    : { operator: 'OR', conditions: queryEmails.map((email) => ({ email })) };
  const cap = maxObjectsInGet(transport);
  const paging = await pageCompleteQuery({
    pageSize: cap,
    readPage: async ({ position, limit }) => {
      const found = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
        methodCalls: [[
          'ContactCard/query',
          {
            accountId: account.remote_account_id,
            filter,
            position,
            limit,
            calculateTotal: true,
          },
          'cq',
        ]],
        useWebSocket,
      });
      const query = pickResponse(found, 'ContactCard/query');
      if (!query || !Array.isArray(query.ids)) {
        throw new Error('ContactCard/query did not answer the duplicate check');
      }
      const total = Number(query.total);
      return {
        ids: query.ids,
        queryState: typeof query.queryState === 'string' ? query.queryState : null,
        total: Number.isFinite(total) ? total : null,
        limit: query.limit,
        value: null,
      };
    },
    visitPage: async ({ ids }) => {
      for (let index = 0; index < ids.length; index += cap) {
        const requested = ids.slice(index, index + cap);
        const got = await callJmap(transport, {
          using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
          methodCalls: [[
            'ContactCard/get',
            {
              accountId: account.remote_account_id,
              ids: requested,
              ...(properties ? { properties } : {}),
            },
            'cg',
          ]],
          useWebSocket,
        });
        const answer = pickResponse(got, 'ContactCard/get');
        if (!answer || !Array.isArray(answer.list)) {
          throw new Error('ContactCard/get did not answer the duplicate check');
        }
        const returned = new Set(answer.list.map((card) => card.id));
        if (requested.some((id) => !returned.has(id))) {
          throw new Error('ContactCard/get omitted a duplicate-check card');
        }
        for (const card of answer.list) visitCard(card);
      }
    },
  });
  if (paging.complete === false) {
    throw duplicateCheckPagingError(paging.reason);
  }
}

async function findContactCardsForEmails({
  transport, account, emails, useWebSocket,
}): Promise<any[]> {
  const wanted = new Set(emails.map(addressKey).filter(Boolean));
  if (wanted.size === 0) return [];
  const matched = new Map<string, any>();
  await visitContactCardsForEmails({
    transport,
    account,
    emails,
    useWebSocket,
    visitCard: (card) => {
      if (normalizeEmails(card.emails).some((email) => wanted.has(addressKey(email.email)))) {
        matched.set(card.id, card);
      }
    },
  });
  return [...matched.values()];
}

/**
 * Of the given addresses, return the canonical keys that already have a
 * ContactCard anywhere in the account. Query pages and follow-up gets
 * are bounded to the live JMAP Session's object limit.
 * A refused duplicate check fails closed rather than creating a card whose
 * uniqueness was never established.
 */
async function existingCardEmails({
  transport, account, emails, useWebSocket,
}): Promise<{ keys: Set<string>; cardIds: Set<string> }> {
  const present = new Set<string>();
  const cardIds = new Set<string>();
  if (!emails || emails.length === 0) return { keys: present, cardIds };
  const wanted = new Set(emails.map(addressKey).filter(Boolean));
  await visitContactCardsForEmails({
    transport,
    account,
    emails,
    properties: ['emails'],
    useWebSocket,
    visitCard: (card) => {
      const map = card?.emails;
      if (!map || typeof map !== 'object') return;
      let matched = false;
      for (const entry of Object.values(map) as any[]) {
        const key = addressKey(entry?.address);
        if (key && wanted.has(key)) {
          present.add(key);
          matched = true;
        }
      }
      if (matched && typeof card.id === 'string') cardIds.add(card.id);
    },
  });
  return { keys: present, cardIds };
}

function buildContactCard({
  uid,
  contact,
  addressBookIds,
  name,
  emails,
  bookId,
}: {
  uid?: string;
  contact?: ContactMutationFields;
  addressBookIds?: string[];
  name?: string | null;
  emails?: string[];
  bookId?: string | null;
}): Record<string, unknown> {
  const fields = contact ?? legacyCreateContactFields(name, emails);
  const books = addressBookIds ?? (bookId ? [bookId] : []);
  return compactObject({
    '@type': 'Card',
    version: '1.0',
    uid: uid ?? createContactUid(),
    kind: 'individual',
    addressBookIds: books.length > 0 ? booleanSet(books) : null,
    name: fields.fullName ? { full: fields.fullName } : null,
    emails: contactDetailMap(fields.emails, buildEmail),
    phones: contactDetailMap(fields.phones, buildPhone),
    links: contactDetailMap(fields.links, buildLink),
    anniversaries: contactDetailMap(fields.anniversaries, buildAnniversary),
    notes: contactDetailMap(fields.notes, buildNote),
    organizations: contactDetailMap(fields.organizations, buildOrganization),
    titles: contactDetailMap(fields.titles, buildTitle),
    media: fields.photo
      ? { [fields.photo.mapKey]: buildPhoto(fields.photo) }
      : null,
  });
}

function contactDetailMap<T extends KeyedContactDetail>(
  details: T[],
  build: (detail: T) => Record<string, unknown>,
): Record<string, unknown> | null {
  if (details.length === 0) return null;
  return Object.fromEntries(
    details
      .filter((detail): detail is T & { mapKey: string } => isMapKey(detail.mapKey))
      .map((detail) => [detail.mapKey, build(detail)]),
  );
}

/**
 * Low-level ContactCard/set create shared by contact mutation paths.
 */
async function submitContactCardCreate({
  transport,
  account,
  uid,
  contact,
  addressBookIds,
  useWebSocket,
}): Promise<ContactWriteResult> {
  const card = buildContactCard({ uid, contact, addressBookIds });
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

/** The values of the RFC 9553 §2.2.1.2 name components of the given kinds. */
function componentValues(name: any, kinds: readonly string[]): string[] {
  if (!Array.isArray(name?.components)) return [];
  return name.components
    .filter((c: any) => kinds.includes(c?.kind) && typeof c?.value === 'string' && c.value)
    .map((c: any) => c.value as string);
}

function joinComponentValues(name: any, kinds: readonly string[]): string | null {
  const values = componentValues(name, kinds);
  return values.length > 0 ? values.join(' ') : null;
}

/**
 * A display name assembled from a structured Name. RFC 9553 §2.2.1.1 makes
 * `full` optional once `components` is set, so a components-only card must
 * still get a readable name: its component values in listed order, joined
 * by `defaultSeparator` when the card names one. The flat given/surname
 * reads remain as a tolerance for the older non-RFC shape.
 */
function combineNameComponents(name) {
  if (!name) return null;
  if (Array.isArray(name.components)) {
    const parts = name.components
      .filter((c: any) => c?.kind !== 'separator' && typeof c?.value === 'string' && c.value)
      .map((c: any) => c.value as string);
    if (parts.length > 0) {
      const separator = typeof name.defaultSeparator === 'string' && name.defaultSeparator
        ? name.defaultSeparator
        : ' ';
      return parts.join(separator);
    }
  }
  const parts = [name.given, name.surname].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

