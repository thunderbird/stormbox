import {
  CONTACT_PHASE,
  CONTACT_TRASH_PHASE,
  SEND_PHASE,
  SERVICE_KIND,
} from '../../../../../constants/states';
import { DB_RPC } from '../../../../../db/protocol';
import { wlog } from '../../../../../db/worker-log';
import type {
  ContactBatchFailure,
  ContactBatchMutationRequest,
  ContactBatchMutationResult,
  ContactMutationFields,
  ContactTrashMutationRequest,
} from '../../../../../types/db';
import { addressKey } from '../../../../../utils/address-key';
import {
  createContactMapKey,
  createContactUid,
  isContactUid,
} from '../../../../../utils/contact-uid';
import {
  createContactCard,
  createTrustedContactCards,
  mutateContactCardsBatch,
  reconcileContactCardBatch,
  reconcileContactCards,
  updateContactCard,
} from '../../contacts';
import {
  deleteContactCardsWithTrash,
  deleteContactTrashForever,
  pushContactsTrash,
  restoreContactTrash,
} from '../../contacts-trash';
import {
  CACHE_REPAIR_MAX_ATTEMPTS,
  readMutationCheckpoint,
  saveMutationCheckpoint,
} from '../../mutation-checkpoint';
import { readPhase } from '../../send-checkpoint';
import { classifyAuthenticationOrAuthorizationError } from '../../transport';

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
  const recoverCreate = row?.phase === CONTACT_PHASE.CREATE_PENDING;
  let ids = applied?.ids;
  if (!applied) {
    const requestedSenders = Array.isArray(request?.senders)
      ? request.senders
      : [{ email: request?.email, name: request?.name }];
    const senders = await ensureTrustedSenderUids({
      handlers,
      row,
      request,
      senders: requestedSenders,
    });
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
    const trashedRows = keys.length === 0
      ? []
      : await handlers[DB_RPC.QUERY]({
        sql: `SELECT DISTINCT te.email_key
                FROM contacts_trash_emails te
                JOIN contacts_trash t ON t.id = te.trash_id
               WHERE t.account_id = ?
                 AND t.status = 'trashed'
                 AND te.email_key IN (${keys.map(() => '?').join(',')})`,
        params: [account.id, ...keys],
      });
    const trashedKeys = new Set<string>(
      trashedRows.map((record) => String(record.email_key)),
    );
    const eligible = senders.filter((sender) => {
      const key = addressKey(sender?.email);
      if (trashedKeys.has(key)) return false;
      const sourceSentAt = Number(sender?.sourceSentAt);
      if (!Number.isFinite(sourceSentAt)) return true;
      return sourceSentAt > (deletedAt.get(key) ?? 0);
    });
    if (eligible.length > 0) {
      const result = await createTrustedContactCards({
        transport,
        account,
        senders: eligible,
        recoverCreate,
        beforeCreate: () => checkpointContactCreate({
          handlers,
          row,
          uids: eligible.map((sender) => sender.uid),
        }),
        useWebSocket,
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
  const recoverCreate = row?.phase === CONTACT_PHASE.CREATE_PENDING;
  let ids = applied?.ids;
  if (!applied) {
    const durableRequest = await ensureCreateContactUid({ handlers, row, request });
    const contact = contactFieldsFromRequest(durableRequest);
    const addressBookIds = await resolveAddressBookRemoteIds({
      handlers,
      accountId: account.id,
      localIds: durableRequest.addressbookIds,
    });
    const result = await createContactCard({
      transport,
      account,
      uid: durableRequest.uid,
      contact,
      addressBookIds,
      allowDuplicate: durableRequest.allowDuplicate === true,
      bookId: durableRequest.bookRemoteId ?? null,
      recoverCreate,
      beforeCreate: () => checkpointContactCreate({
        handlers,
        row,
        uids: [durableRequest.uid],
      }),
      useWebSocket,
    });
    if (!result.ok) {
      return { ok: false, error: result.error ?? { type: 'serverFail' } };
    }
    ids = result.id ? [result.id] : [];
  }
  return reconcileOrReport({
    transport,
    account,
    handlers,
    row,
    ids,
    useWebSocket,
    attempts: applied?.attempts ?? 0,
    successResult: { ids },
  });
}

/**
 * Edit a contact's name/emails (contacts UI). The handler reconciles the
 * cache so the edited row reflects the server once the mutation
 * resolves. request shape: { remoteId, emails: string[], name? }.
 */
async function runUpdateContact({ transport, account, handlers, row, request, useWebSocket }) {
  const applied = contactWriteApplied(row);
  const remoteId = request?.contactId == null
    ? request?.remoteId
    : (await handlers[DB_RPC.QUERY]({
        sql: `SELECT remote_id
                FROM contacts
               WHERE id = ? AND account_id = ? AND is_deleted = 0`,
        params: [request.contactId, account.id],
      }))[0]?.remote_id;
  if (!applied) {
    const result = await updateContactCard({
      transport,
      account,
      remoteId,
      baseline: request?.baseline,
      contact: request?.contact,
      emails: request?.emails,
      name: request?.name,
      useWebSocket,
    });
    if (!result.ok) {
      if (result.error?.type === 'contactNeedsSync' && remoteId) {
        try {
          await reconcileContactCards({
            transport,
            account,
            handlers,
            ids: [remoteId],
            useWebSocket,
          });
        } catch (err: any) {
          wlog.warn('jmap-outbox', `contact key refresh failed: ${err?.message ?? err}`);
        }
      }
      return { ok: false, error: result.error ?? { type: 'serverFail' } };
    }
  }
  return reconcileOrReport({
    transport,
    account,
    handlers,
    row,
    ids: remoteId ? [remoteId] : [],
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
    const local = await handlers[DB_RPC.QUERY]({
      sql: `SELECT id FROM contacts
              WHERE account_id = ? AND remote_id = ?
              LIMIT 1`,
      params: [account.id, request?.remoteId],
    });
    const result = await deleteContactCardsWithTrash({
      transport,
      account,
      handlers,
      targets: [{
        contactId: Number(local[0]?.id ?? 0),
        remoteId: request?.remoteId,
      }],
      sourceAddressBookRemoteId: null,
      useWebSocket,
      onPhase: async (phase, detail) => {
        const durablePhase = phase === 'snapshot-saved'
          ? CONTACT_TRASH_PHASE.SNAPSHOT_SAVED
          : (phase === 'document-confirmed'
            ? CONTACT_TRASH_PHASE.DOCUMENT_CONFIRMED
            : CONTACT_TRASH_PHASE.SERVER_WRITE_PENDING);
        await checkpointContactTrashPhase({
          handlers,
          row,
          checkpoint: emptyContactBatchCheckpoint(),
          phase: durablePhase,
          detail,
        });
      },
    });
    if (!result.complete || result.result.failures.length > 0) {
      return {
        ok: false,
        error: result.error ?? {
          type: result.result.failures[0]?.errorType ?? 'serverFail',
        },
      };
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

interface DurableContactBatchCheckpoint extends ContactBatchMutationResult {
  destroyedRemoteIds: string[];
  updatedRemoteIds: string[];
  version: 1;
}

const RETRYABLE_CONTACT_BATCH_ERRORS = new Set([
  'cacheReconcileFailed',
  'noResponse',
  'rateLimit',
  'serverFail',
  'serverPartialFail',
  'serverUnavailable',
  'stateMismatch',
  'transport',
]);

function isRetryableContactBatchError(errorType: string, error?: any): boolean {
  const authentication = classifyAuthenticationOrAuthorizationError(
    error ?? { type: errorType },
  );
  if (authentication) return authentication.retryable;
  return RETRYABLE_CONTACT_BATCH_ERRORS.has(errorType);
}

function emptyContactBatchCheckpoint(): DurableContactBatchCheckpoint {
  return {
    version: 1,
    succeededContactIds: [],
    updatedContactIds: [],
    destroyedContactIds: [],
    failures: [],
    updatedRemoteIds: [],
    destroyedRemoteIds: [],
  };
}

function numericContactIds(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter(
    (id): id is number =>
      typeof id === 'number' && Number.isSafeInteger(id) && id > 0,
  ))];
}

function normalizeContactBatchRequest(request: any): ContactBatchMutationRequest | null {
  const contactIds = numericContactIds(request?.contactIds);
  if (contactIds.length === 0) return null;
  if (request?.operation === 'move') {
    const sourceAddressbookId = Number(request.sourceAddressbookId);
    const targetAddressbookId = Number(request.targetAddressbookId);
    if (
      !Number.isSafeInteger(sourceAddressbookId)
      || sourceAddressbookId <= 0
      || !Number.isSafeInteger(targetAddressbookId)
      || targetAddressbookId <= 0
      || sourceAddressbookId === targetAddressbookId
    ) {
      return null;
    }
    return {
      operation: 'move',
      contactIds,
      sourceAddressbookId,
      targetAddressbookId,
    };
  }
  if (request?.operation !== 'scoped-delete') return null;
  const sourceAddressbookId = request.sourceAddressbookId == null
    ? null
    : Number(request.sourceAddressbookId);
  if (
    sourceAddressbookId != null
    && (!Number.isSafeInteger(sourceAddressbookId) || sourceAddressbookId <= 0)
  ) {
    return null;
  }
  return {
    operation: 'scoped-delete',
    contactIds,
    sourceAddressbookId,
  };
}

function readContactBatchCheckpoint(row: any): DurableContactBatchCheckpoint {
  const phase = readPhase(row);
  if (
    phase !== SEND_PHASE.CACHE_PENDING
    && !Object.values(CONTACT_TRASH_PHASE).includes(phase as any)
  ) {
    return emptyContactBatchCheckpoint();
  }
  const result = readMutationCheckpoint(row, (value: any) =>
    value?.contactBatch?.version === 1 ? value.contactBatch : null);
  if (result.status !== 'valid') return emptyContactBatchCheckpoint();
  const parsed = result.checkpoint;
  return {
    version: 1,
    succeededContactIds: numericContactIds(parsed.succeededContactIds),
    updatedContactIds: numericContactIds(parsed.updatedContactIds),
    destroyedContactIds: numericContactIds(parsed.destroyedContactIds),
    failures: Array.isArray(parsed.failures)
      ? parsed.failures.filter((failure) =>
          Number.isSafeInteger(failure?.contactId)
          && typeof failure?.errorType === 'string')
      : [],
    updatedRemoteIds: Array.isArray(parsed.updatedRemoteIds)
      ? [...new Set<string>((parsed.updatedRemoteIds as unknown[]).filter(
          (id: unknown): id is string => typeof id === 'string' && id.length > 0,
        ))]
      : [],
    destroyedRemoteIds: Array.isArray(parsed.destroyedRemoteIds)
      ? [...new Set<string>((parsed.destroyedRemoteIds as unknown[]).filter(
          (id: unknown): id is string => typeof id === 'string' && id.length > 0,
        ))]
      : [],
  };
}

function mergeContactBatchCheckpoint(
  checkpoint: DurableContactBatchCheckpoint,
  result: ContactBatchMutationResult & {
    updatedRemoteIds?: string[];
    destroyedRemoteIds?: string[];
  },
): void {
  const successful = new Set([
    ...checkpoint.succeededContactIds,
    ...numericContactIds(result.succeededContactIds),
  ]);
  checkpoint.succeededContactIds = [...successful];
  checkpoint.updatedContactIds = [...new Set([
    ...checkpoint.updatedContactIds,
    ...numericContactIds(result.updatedContactIds),
  ])];
  checkpoint.destroyedContactIds = [...new Set([
    ...checkpoint.destroyedContactIds,
    ...numericContactIds(result.destroyedContactIds),
  ])];
  const failures = new Map<number, ContactBatchFailure>(
    checkpoint.failures.map((failure) => [failure.contactId, failure]),
  );
  for (const failure of result.failures ?? []) {
    if (
      Number.isSafeInteger(failure?.contactId)
      && typeof failure?.errorType === 'string'
    ) {
      failures.set(failure.contactId, failure);
    }
  }
  for (const contactId of successful) failures.delete(contactId);
  checkpoint.failures = [...failures.values()];
  checkpoint.updatedRemoteIds = [...new Set([
    ...checkpoint.updatedRemoteIds,
    ...(result.updatedRemoteIds ?? []),
  ])];
  checkpoint.destroyedRemoteIds = [...new Set([
    ...checkpoint.destroyedRemoteIds,
    ...(result.destroyedRemoteIds ?? []),
  ])];
}

function contactBatchPublicResult(
  checkpoint: DurableContactBatchCheckpoint,
): ContactBatchMutationResult {
  return {
    succeededContactIds: checkpoint.succeededContactIds,
    updatedContactIds: checkpoint.updatedContactIds,
    destroyedContactIds: checkpoint.destroyedContactIds,
    failures: checkpoint.failures,
  };
}

function settledContactIds(checkpoint: DurableContactBatchCheckpoint): Set<number> {
  return new Set([
    ...checkpoint.succeededContactIds,
    ...checkpoint.failures.map((failure) => failure.contactId),
  ]);
}

function failUnsettledContacts(
  checkpoint: DurableContactBatchCheckpoint,
  contactIds: number[],
  errorType: string,
  message?: string,
): void {
  const settled = settledContactIds(checkpoint);
  mergeContactBatchCheckpoint(checkpoint, {
    succeededContactIds: [],
    updatedContactIds: [],
    destroyedContactIds: [],
    failures: contactIds
      .filter((contactId) => !settled.has(contactId))
      .map((contactId) => ({
        contactId,
        errorType,
        ...(message ? { message } : {}),
      })),
  });
}

function checkpointContactBatch({
  handlers,
  row,
  checkpoint,
}: {
  handlers: any;
  row: any;
  checkpoint: DurableContactBatchCheckpoint;
}): Promise<unknown> {
  return saveMutationCheckpoint({
    handlers,
    rowId: row.id,
    phase: SEND_PHASE.CACHE_PENDING,
    checkpoint: { contactBatch: checkpoint },
  });
}

function checkpointContactTrashPhase({
  handlers,
  row,
  checkpoint,
  phase,
  detail,
}: {
  handlers: any;
  row: any;
  checkpoint: DurableContactBatchCheckpoint;
  phase: string;
  detail?: unknown;
}): Promise<unknown> {
  return saveMutationCheckpoint({
    handlers,
    rowId: row.id,
    phase,
    checkpoint: {
      contactBatch: checkpoint,
      contactTrash: { phase, detail: detail ?? null },
    },
  });
}

async function resolveContactBatchBook({
  handlers,
  accountId,
  localId,
}: {
  handlers: any;
  accountId: number;
  localId: number;
}): Promise<{ remoteId: string; writable: boolean } | null> {
  const rows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT remote_id, may_write
            FROM addressbooks
           WHERE id = ?
             AND account_id = ?
             AND service_kind = ?
             AND is_deleted = 0
           LIMIT 1`,
    params: [localId, accountId, SERVICE_KIND.JMAP_CONTACTS],
  });
  const row = rows[0];
  return typeof row?.remote_id === 'string' && row.remote_id
    ? {
        remoteId: row.remote_id,
        writable: Number(row.may_write) === 1,
      }
    : null;
}

async function runContactBatch({
  transport,
  account,
  handlers,
  row,
  request: rawRequest,
  useWebSocket,
}: any) {
  const request = normalizeContactBatchRequest(rawRequest);
  if (!request) {
    return {
      ok: false,
      error: {
        type: 'invalidArguments',
        terminal: true,
      },
    };
  }
  const checkpoint = readContactBatchCheckpoint(row);
  const settled = settledContactIds(checkpoint);
  let unsettled = request.contactIds.filter(
    (contactId) => !settled.has(contactId),
  );

  let wireOperation;
  if (request.operation === 'move') {
    const [source, target] = await Promise.all([
      resolveContactBatchBook({
        handlers,
        accountId: account.id,
        localId: request.sourceAddressbookId,
      }),
      resolveContactBatchBook({
        handlers,
        accountId: account.id,
        localId: request.targetAddressbookId,
      }),
    ]);
    if (!source?.writable || !target?.writable) {
      failUnsettledContacts(checkpoint, unsettled, 'forbidden');
      await checkpointContactBatch({ handlers, row, checkpoint });
      unsettled = [];
    }
    wireOperation = source && target
      ? {
          operation: 'move' as const,
          sourceAddressbookRemoteId: source.remoteId,
          targetAddressbookRemoteId: target.remoteId,
        }
      : null;
  } else if (request.sourceAddressbookId == null) {
    wireOperation = {
      operation: 'scoped-delete' as const,
      sourceAddressbookRemoteId: null,
    };
  } else {
    const source = await resolveContactBatchBook({
      handlers,
      accountId: account.id,
      localId: request.sourceAddressbookId,
    });
    if (!source?.writable) {
      failUnsettledContacts(checkpoint, unsettled, 'forbidden');
      await checkpointContactBatch({ handlers, row, checkpoint });
      unsettled = [];
    }
    wireOperation = source
      ? {
          operation: 'scoped-delete' as const,
          sourceAddressbookRemoteId: source.remoteId,
        }
      : null;
  }

  if (unsettled.length > 0 && wireOperation) {
    const placeholders = unsettled.map(() => '?').join(',');
    const rows = await handlers[DB_RPC.QUERY]({
      sql: `SELECT id, remote_id
              FROM contacts
             WHERE account_id = ?
               AND id IN (${placeholders})`,
      params: [account.id, ...unsettled],
    });
    const byId = new Map(
      rows.map((contact) => [Number(contact.id), contact.remote_id]),
    );
    const unknown = unsettled.filter((contactId) =>
      typeof byId.get(contactId) !== 'string' || !byId.get(contactId));
    if (unknown.length > 0) {
      failUnsettledContacts(checkpoint, unknown, 'unknownContact');
      await checkpointContactBatch({ handlers, row, checkpoint });
      const unknownIds = new Set(unknown);
      unsettled = unsettled.filter((contactId) => !unknownIds.has(contactId));
    }
    if (unsettled.length > 0) {
      const protocol = request.operation === 'move'
        ? await mutateContactCardsBatch({
          transport,
          account,
          targets: unsettled.map((contactId) => ({
            contactId,
            remoteId: String(byId.get(contactId)),
          })),
          operation: wireOperation,
          useWebSocket,
          onChunk: async (result) => {
            mergeContactBatchCheckpoint(checkpoint, result);
            await checkpointContactBatch({ handlers, row, checkpoint });
          },
        })
        : await deleteContactCardsWithTrash({
          transport,
          account,
          handlers,
          targets: unsettled.map((contactId) => ({
            contactId,
            remoteId: String(byId.get(contactId)),
          })),
          sourceAddressBookRemoteId: wireOperation.sourceAddressbookRemoteId,
          useWebSocket,
          onPhase: async (phase, detail) => {
            const durablePhase = phase === 'snapshot-saved'
              ? CONTACT_TRASH_PHASE.SNAPSHOT_SAVED
              : (phase === 'document-confirmed'
                ? CONTACT_TRASH_PHASE.DOCUMENT_CONFIRMED
                : CONTACT_TRASH_PHASE.SERVER_WRITE_PENDING);
            await checkpointContactTrashPhase({
              handlers,
              row,
              checkpoint,
              phase: durablePhase,
              detail,
            });
          },
          onChunk: async (result) => {
            mergeContactBatchCheckpoint(checkpoint, result);
            await checkpointContactBatch({ handlers, row, checkpoint });
          },
        });
      if (!protocol.complete) {
        const errorType = protocol.error?.type ?? 'serverFail';
        if (isRetryableContactBatchError(errorType, protocol.error)) {
          return {
            ok: false,
            error: {
              ...protocol.error,
              type: errorType,
              result: contactBatchPublicResult(checkpoint),
            },
          };
        }
        failUnsettledContacts(checkpoint, request.contactIds, errorType);
        await checkpointContactBatch({ handlers, row, checkpoint });
      }
    }
  }

  if (checkpoint.succeededContactIds.length > 0) {
    try {
      await reconcileContactCardBatch({
        transport,
        account,
        handlers,
        updatedIds: checkpoint.updatedRemoteIds,
        destroyedIds: checkpoint.destroyedRemoteIds,
        useWebSocket,
      });
    } catch (error: any) {
      return {
        ok: false,
        error: {
          type: 'cacheReconcileFailed',
          message: error?.message ?? String(error),
          result: contactBatchPublicResult(checkpoint),
        },
      };
    }
  }
  return {
    ok: true,
    result: contactBatchPublicResult(checkpoint),
  };
}

function normalizeContactTrashRequest(request: any): ContactTrashMutationRequest | null {
  const trashIds = numericContactIds(request?.trashIds);
  if (trashIds.length === 0) return null;
  if (request?.operation === 'delete-forever') {
    return { operation: 'delete-forever', trashIds };
  }
  if (request?.operation !== 'restore') return null;
  const destinationAddressbookId = request.destinationAddressbookId == null
    ? null
    : Number(request.destinationAddressbookId);
  if (
    destinationAddressbookId != null
    && (
      !Number.isSafeInteger(destinationAddressbookId)
      || destinationAddressbookId <= 0
    )
  ) {
    return null;
  }
  return { operation: 'restore', trashIds, destinationAddressbookId };
}

async function runContactTrash({
  transport,
  account,
  handlers,
  row,
  request: rawRequest,
  useWebSocket,
}: any) {
  const request = normalizeContactTrashRequest(rawRequest);
  if (!request) {
    return { ok: false, error: { type: 'invalidArguments', terminal: true } };
  }
  if (request.operation === 'delete-forever') {
    await checkpointContactTrashPhase({
      handlers,
      row,
      checkpoint: emptyContactBatchCheckpoint(),
      phase: CONTACT_TRASH_PHASE.TOMBSTONE_PENDING,
    });
    const result = await deleteContactTrashForever({
      transport,
      account,
      handlers,
      trashIds: request.trashIds,
      useWebSocket,
    });
    return { ok: true, result };
  }

  let destinationAddressBookRemoteId: string | null = null;
  if (request.destinationAddressbookId != null) {
    const destination = await resolveContactBatchBook({
      handlers,
      accountId: account.id,
      localId: request.destinationAddressbookId,
    });
    if (!destination?.writable) {
      return { ok: false, error: { type: 'forbidden', terminal: true } };
    }
    destinationAddressBookRemoteId = destination.remoteId;
  }
  await checkpointContactTrashPhase({
    handlers,
    row,
    checkpoint: emptyContactBatchCheckpoint(),
    phase: CONTACT_TRASH_PHASE.RESTORE_PENDING,
  });
  const result = await restoreContactTrash({
    transport,
    account,
    handlers,
    trashIds: request.trashIds,
    destinationAddressBookRemoteId,
    useWebSocket,
  });
  if (result.restoredRemoteIds.length > 0) {
    await reconcileContactCards({
      transport,
      account,
      handlers,
      ids: result.restoredRemoteIds,
      useWebSocket,
    });
  }
  if (result.succeededTrashIds.length > 0) {
    const changed = await handlers[DB_RPC.CONTACT_TRASH_SET_STATUS]({
      accountId: account.id,
      trashIds: result.succeededTrashIds,
      status: 'restored',
      ensurePush: true,
    });
    const pushed = await pushContactsTrash({
      transport,
      account,
      handlers,
      shardNames: changed.touchedShards,
      useWebSocket,
    });
    if (pushed.ok === false) return pushed;
  }
  return { ok: true, result };
}

async function ensureCreateContactUid({ handlers, row, request }: any): Promise<any> {
  const usesDetailModel = Boolean(
    request
      && typeof request === 'object'
      && (
        'fullName' in request
        || 'photo' in request
        || 'phones' in request
        || 'links' in request
        || (Array.isArray(request.emails)
          && request.emails.some((email) => email && typeof email === 'object'))
      ),
  );
  const next = usesDetailModel
    ? {
        ...request,
        uid: isContactUid(request?.uid)
          ? request.uid
          : createContactUid(),
      }
    : {
        ...request,
        uid: isContactUid(request?.uid)
          ? request.uid
          : createContactUid(),
        addressbookIds: Array.isArray(request?.addressbookIds) ? request.addressbookIds : [],
        fullName: typeof request?.name === 'string' && request.name.trim()
          ? request.name.trim()
          : null,
        emails: (Array.isArray(request?.emails) ? request.emails : [])
          .filter((email) => typeof email === 'string' && email.trim())
          .map((email, position) => ({
            mapKey: createContactMapKey('email'),
            position,
            value: email.trim(),
            label: null,
            contexts: [],
            pref: null,
            isPreferred: position === 0,
          })),
        phones: [],
        links: [],
        anniversaries: [],
        notes: [],
        organizations: [],
        titles: [],
        photo: null,
      };
  if (JSON.stringify(next) !== JSON.stringify(request)) {
    await persistMutationRequest(handlers, row, next);
  }
  return next;
}

async function ensureTrustedSenderUids({
  handlers,
  row,
  request,
  senders,
}: any): Promise<any[]> {
  let changed = false;
  const next = senders.map((sender) => {
    if (isContactUid(sender?.uid)) return sender;
    changed = true;
    return { ...sender, uid: createContactUid() };
  });
  if (changed) {
    await persistMutationRequest(handlers, row, { ...request, senders: next });
  }
  return next;
}

async function persistMutationRequest(handlers: any, row: any, request: any): Promise<void> {
  if (row?.id == null) return;
  await handlers[DB_RPC.QUERY]({
    sql: `UPDATE pending_mutations
             SET request_json = ?, updated_at = ?
           WHERE id = ?`,
    params: [JSON.stringify(request), Date.now(), row.id],
  });
}

function checkpointContactCreate({ handlers, row, uids }: any): Promise<unknown> {
  return saveMutationCheckpoint({
    handlers,
    rowId: row.id,
    phase: CONTACT_PHASE.CREATE_PENDING,
    checkpoint: { contactCreateUids: uids },
  });
}

function contactFieldsFromRequest(request: any): ContactMutationFields {
  return {
    fullName: typeof request?.fullName === 'string' ? request.fullName : null,
    emails: Array.isArray(request?.emails) ? request.emails : [],
    phones: Array.isArray(request?.phones) ? request.phones : [],
    links: Array.isArray(request?.links) ? request.links : [],
    anniversaries: Array.isArray(request?.anniversaries) ? request.anniversaries : [],
    notes: Array.isArray(request?.notes) ? request.notes : [],
    organizations: Array.isArray(request?.organizations) ? request.organizations : [],
    titles: Array.isArray(request?.titles) ? request.titles : [],
    photo: request?.photo && typeof request.photo === 'object' ? request.photo : null,
  };
}

async function resolveAddressBookRemoteIds({
  handlers,
  accountId,
  localIds,
}: any): Promise<string[]> {
  if (!Array.isArray(localIds) || localIds.length === 0) return [];
  const ids = [...new Set(
    localIds.filter((id) => Number.isSafeInteger(id) && Number(id) > 0),
  )];
  if (ids.length === 0) return [];
  const rows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT id, remote_id
            FROM addressbooks
           WHERE account_id = ?
             AND service_kind = ?
             AND is_deleted = 0
             AND id IN (${ids.map(() => '?').join(',')})`,
    params: [accountId, SERVICE_KIND.JMAP_CONTACTS, ...ids],
  });
  const byId = new Map(rows.map((book) => [Number(book.id), book.remote_id]));
  return ids.map((id) => byId.get(Number(id))).filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
}

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
  const result = readMutationCheckpoint(row, (parsed: any) => {
    if (!Array.isArray(parsed?.reconcileIds)) return null;
    return {
      ids: parsed.reconcileIds.filter((id: unknown) => typeof id === 'string'),
      attempts: Number.isInteger(parsed.attempts) ? parsed.attempts : 0,
    };
  });
  return result.status === 'valid' ? result.checkpoint : null;
}

/**
 * Park a row at "the server write is done, the cache is not", carrying the
 * ids a repair needs and how many repairs have been tried.
 */
function checkpointContactWrite({ handlers, row, ids, attempts }: any) {
  return saveMutationCheckpoint({
    handlers,
    rowId: row.id,
    phase: SEND_PHASE.CACHE_PENDING,
    checkpoint: { reconcileIds: ids ?? [], attempts },
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
  transport,
  account,
  handlers,
  row,
  ids,
  useWebSocket,
  attempts = 0,
  repair,
  successResult,
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
    return {
      ok: true,
      ...(successResult == null ? {} : { result: successResult }),
    };
  } catch (err: any) {
    const attempted = attempting;
    wlog.warn(
      'jmap-outbox',
      `contact write applied but the cache did not follow: ${err?.message ?? err}`,
    );
    if (row?.id == null || attempted >= CACHE_REPAIR_MAX_ATTEMPTS) {
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
  runContactBatch,
  runContactTrash,
  runCreateContact,
  runDeleteContact,
  runUpdateContact,
  runWhitelistSender,
};
