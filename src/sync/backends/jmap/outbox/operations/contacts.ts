import { SEND_PHASE } from '../../../../../constants/states';
import { DB_RPC } from '../../../../../db/protocol';
import { wlog } from '../../../../../db/worker-log';
import { addressKey } from '../../../../../utils/address-key';
import {
  createContactCard,
  createTrustedContactCards,
  deleteContactCard,
  reconcileContactCards,
  updateContactCard,
} from '../../contacts';
import { readPhase } from '../../send-checkpoint';

/**
 * Whitelist one or more senders: add each From address to the trusted-
 * senders address book so Stalwart delivers future authenticated mail
 * from those addresses to the Inbox (trustContacts / card_is_ham). The
 * visible rescue of the messages (remove $junk / add $notjunk and move
 * Junk → Inbox) is queued separately by the store as setKeywords +
 * moveToFolders rows, so this row only owns the contact writes. request
 * shape: { email, name? } for one sender, or { senders: [{ email, name? },
 * ...] } for a bulk whitelist. createTrustedContactCards batches the
 * trust writes (one existence query, one book lookup, one multi-create)
 * and is idempotent per address, so a retry after a partial failure
 * converges.
 */
async function runWhitelistSender({ transport, account, handlers, row, request, useWebSocket }) {
  const applied = contactWriteApplied(row);
  let ids = applied?.ids;
  if (!applied) {
    const senders = Array.isArray(request?.senders)
      ? request.senders
      : [{ email: request?.email, name: request?.name }];
    const keys = [...new Set(senders.map((sender) => addressKey(sender?.email)).filter(Boolean))];
    const deletedRows = keys.length === 0
      ? []
      : await handlers[DB_RPC.QUERY]({
        sql: `SELECT ce.email_key, MAX(c.updated_at) AS deleted_at
                FROM contact_emails ce
                JOIN contacts c ON c.id = ce.contact_id
               WHERE c.account_id = ?
                 AND c.is_deleted = 1
                 AND ce.email_key IN (${keys.map(() => '?').join(',')})
               GROUP BY ce.email_key`,
        params: [account.id, ...keys],
      });
    const deletedAt = new Map<string, number>(
      deletedRows.map((record) => [
        String(record.email_key),
        Number(record.deleted_at),
      ]),
    );
    const eligible = senders.filter((sender) => {
      const sourceSentAt = Number(sender?.sourceSentAt);
      if (!Number.isFinite(sourceSentAt)) return true;
      return sourceSentAt > (deletedAt.get(addressKey(sender?.email)) ?? 0);
    });
    if (eligible.length > 0) {
      const result = await createTrustedContactCards({
        transport, account, senders: eligible, useWebSocket,
      });
      if (!result.ok) {
        return { ok: false, error: result.error ?? { type: 'serverFail' } };
      }
      ids = result.ids;
    } else {
      ids = [];
    }
  }
  // Pull only the newly-trusted card(s) into the local cache so they show
  // up in the contacts view without waiting for a StateChange push.
  // Targeted (not a full address-book resync) so a whitelist stays fast
  // regardless of contact count.
  const reconciled = await reconcileOrReport({
    transport, account, handlers, row, ids, useWebSocket, attempts: applied?.attempts ?? 0,
  });
  if (reconciled.ok) {
    try {
      await handlers[DB_RPC.RECIPIENT_USAGE_REBUILD]({ accountId: account.id });
    } catch (err: any) {
      wlog.warn('jmap-outbox', `recipient usage not rebuilt: ${err?.message ?? err}`);
    }
  }
  return reconciled;
}

/**
 * Add a contact to an address book (contacts UI). When the request
 * carries a `bookRemoteId` the card is filed in that book (the selected
 * folder); otherwise it lands in the account's default book. The
 * handler owns the cache reconcile so the new row appears once the
 * mutation resolves, matching the constitution's "cache matches server
 * before the mutation returns" rule. request shape:
 * { emails: string[], name?, bookRemoteId? }.
 */
async function runCreateContact({ transport, account, handlers, row, request, useWebSocket }) {
  const applied = contactWriteApplied(row);
  let ids = applied?.ids;
  if (!applied) {
    const result = await createContactCard({
      transport,
      account,
      emails: request?.emails,
      name: request?.name,
      bookId: request?.bookRemoteId ?? null,
      useWebSocket,
    });
    if (!result.ok) {
      return { ok: false, error: result.error ?? { type: 'serverFail' } };
    }
    ids = result.id ? [result.id] : [];
  }
  return reconcileOrReport({
    transport, account, handlers, row, ids, useWebSocket, attempts: applied?.attempts ?? 0,
  });
}

/**
 * Edit a contact's name/emails (contacts UI). The handler reconciles the
 * cache so the edited row reflects the server once the mutation
 * resolves. request shape: { remoteId, emails: string[], name? }.
 */
async function runUpdateContact({ transport, account, handlers, row, request, useWebSocket }) {
  const applied = contactWriteApplied(row);
  if (!applied) {
    const result = await updateContactCard({
      transport,
      account,
      remoteId: request?.remoteId,
      emails: request?.emails,
      name: request?.name,
      useWebSocket,
    });
    if (!result.ok) {
      return { ok: false, error: result.error ?? { type: 'serverFail' } };
    }
  }
  return reconcileOrReport({
    transport,
    account,
    handlers,
    row,
    ids: request?.remoteId ? [request.remoteId] : [],
    useWebSocket,
    attempts: applied?.attempts ?? 0,
  });
}

/**
 * Remove a contact by its remote id (contacts UI). On success the card
 * is soft-deleted locally so the row disappears immediately; a full
 * reconcile would not remove it because the destroyed card is simply
 * absent from the server list. request shape: { remoteId }.
 */
async function runDeleteContact({ transport, account, handlers, row, request, useWebSocket }) {
  const applied = contactWriteApplied(row);
  if (!applied) {
    const result = await deleteContactCard({
      transport,
      account,
      remoteId: request?.remoteId,
      useWebSocket,
    });
    if (!result.ok) {
      return { ok: false, error: result.error ?? { type: 'serverFail' } };
    }
  }
  // A destroyed card is absent from the server list rather than marked
  // gone in it, so the row is removed here; a reconcile could not do it.
  return reconcileOrReport({
    transport,
    account,
    handlers,
    row,
    ids: [],
    useWebSocket,
    attempts: applied?.attempts ?? 0,
    repair: () => handlers[DB_RPC.CONTACT_DELETE_LOCAL]({
      accountId: account.id,
      remoteId: request?.remoteId,
    }),
  });
}

/**
 * How many times the cache repair is retried before the row retires. The
 * server write is done by then and the next full sync will reconcile the
 * account anyway, so this only bounds how long a row sits in the outbox.
 */
const CONTACT_CACHE_MAX_ATTEMPTS = 3;

/**
 * Was this row's server write already made on an earlier attempt?
 *
 * A contact row parked at `cache_pending` has a card on the server and a
 * local cache that does not show it. Repeating the write would be wrong
 * rather than merely wasteful: a destroy replayed against a card that is
 * already gone answers `notFound`, which the runner reads as a permanent
 * failure — a delete that worked, reported as one that cannot.
 */
function contactWriteApplied(row: any): { ids: string[]; attempts: number } | null {
  if (readPhase(row) !== SEND_PHASE.CACHE_PENDING) return null;
  let parsed;
  try {
    parsed = JSON.parse(row?.server_response_json ?? 'null');
  } catch {
    return null;
  }
  if (!Array.isArray(parsed?.reconcileIds)) return null;
  return {
    ids: parsed.reconcileIds.filter((id: unknown) => typeof id === 'string'),
    attempts: Number.isInteger(parsed.attempts) ? parsed.attempts : 0,
  };
}

/**
 * Park a row at "the server write is done, the cache is not", carrying the
 * ids a repair needs and how many repairs have been tried.
 */
function checkpointContactWrite({ handlers, row, ids, attempts }: any) {
  return handlers[DB_RPC.QUERY]({
    sql: `UPDATE pending_mutations
             SET phase = ?, server_response_json = ?, updated_at = ?
           WHERE id = ?`,
    params: [
      SEND_PHASE.CACHE_PENDING,
      JSON.stringify({ reconcileIds: ids ?? [], attempts }),
      Date.now(),
      row.id,
    ],
  });
}

/**
 * Repair the cache after a contact write the server has accepted, and say
 * plainly when that fails.
 *
 * Reporting success on a failed repair (CS-4.4) tells the user their edit
 * is done and shows them a list that contradicts it, with nothing in the
 * system that remembers the discrepancy. Instead the row stays, parked at
 * the phase that skips the write, until the cache matches or the attempts
 * run out.
 */
async function reconcileOrReport({
  transport, account, handlers, row, ids, useWebSocket, attempts = 0, repair,
}: any) {
  // Record that the server write happened *before* touching the cache.
  //
  // Only `send` is held back from replay after a crash (`recoverStranded`
  // returns everything else to pending), so a contact row that died between
  // a successful `ContactCard/set` and any durable note of it comes back
  // indistinguishable from one that never ran — and creates a second card.
  // The phase is what `contactWriteApplied` reads to skip the write, so
  // writing it here is what closes that window. If this write itself fails
  // the repair below still runs: a repair that succeeds leaves server and
  // cache agreeing, which is the outcome that matters.
  //
  // The attempt is counted here rather than after the repair fails, because
  // the case that needs bounding is the one that never reaches a catch block.
  // A crash mid-repair returns the row to pending; if the count only rose on
  // a thrown error, such a row would resume at the same number forever.
  const attempting = attempts + 1;
  if (row?.id != null) {
    await checkpointContactWrite({ handlers, row, ids, attempts: attempting })
      .catch((err) => {
        wlog.warn(
          'jmap-outbox',
          `contact write not checkpointed before reconcile: ${err?.message ?? err}`,
        );
      });
  }
  try {
    await (repair
      ? repair()
      : reconcileContactCards({ transport, account, handlers, ids, useWebSocket }));
    return { ok: true };
  } catch (err: any) {
    const attempted = attempting;
    wlog.warn(
      'jmap-outbox',
      `contact write applied but the cache did not follow: ${err?.message ?? err}`,
    );
    if (row?.id == null || attempted >= CONTACT_CACHE_MAX_ATTEMPTS) {
      // Out of attempts. The card is right on the server, so the account's
      // own copy is what is wrong: drop the contact checkpoint and the next
      // sync rebuilds from scratch rather than trusting a delta from a
      // state the cache never actually reached.
      await handlers[DB_RPC.SYNC_STATE_SET]({
        accountId: account.id,
        objectType: 'ContactCard',
        state: null,
      }).catch(() => {});
      return {
        ok: false,
        error: {
          type: 'cacheReconcileFailed',
          message: err?.message ?? String(err),
          terminal: true,
          result: { applied: true, cached: false },
        },
      };
    }
    await checkpointContactWrite({ handlers, row, ids, attempts: attempted });
    return {
      ok: false,
      error: {
        type: 'cacheReconcileFailed',
        message: err?.message ?? String(err),
        result: { applied: true, cached: false },
      },
    };
  }
}

export {
  runCreateContact,
  runDeleteContact,
  runUpdateContact,
  runWhitelistSender,
};
