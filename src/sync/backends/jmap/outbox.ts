/**
 * JMAP mutation dispatch. Translates a single pending_mutations row
 * into the appropriate Email/set or EmailSubmission/set request and
 * applies the local-cache reconciliation that follows a successful
 * response.
 *
 * Supported mutation_type values:
 *
 *   'setKeywords'      Email/set update with a keywords/$X patch
 *   'moveToFolders'    Email/set update with a mailboxIds/<id> patch
 *   'destroy'          Email/set destroy
 *   'send'             Email/set create + EmailSubmission/set with
 *                      onSuccessUpdateEmail moving the email out of
 *                      drafts/outbox into sent
 *
 * Two entry points:
 *
 *   processMutationRow({ transport, account, handlers, row, useWebSocket })
 *     -> { ok, error? }
 *
 *     The per-row dispatch used by the worker-side OutboxRunner
 *     (sync/backends/jmap/outbox-runner.js). The runner owns
 *     status/attempts/not_before bookkeeping; this helper just runs
 *     the JMAP call and reports success or a typed error.
 *
 *   drainOutbox({ transport, account, handlers, limit, mutationId, useWebSocket })
 *     -> { attempted, succeeded, failed }
 *
 *     Kept for direct unit tests in jmap-outbox.test.js (they assert
 *     the in-DB status transitions for each mutation type without
 *     spinning up the runner). Production code goes through the
 *     OutboxRunner instead.
 */

import { DB_RPC } from '../../../db/protocol.js';
import { JMAP_CAPS } from './transport.js';
import {
  applyMoveBatchLocally,
  applyDestroyBatchLocally,
  applySendLocally,
  reconcileMessageFromServer,
} from './outbox-apply.js';

export const MUTATION_TYPES = Object.freeze({
  SET_KEYWORDS: 'setKeywords',
  MOVE_TO_FOLDERS: 'moveToFolders',
  DESTROY: 'destroy',
  SEND: 'send',
});

/**
 * Drain pending mutations for the given account. When mutationId is
 * provided, run only that row so a user action is not blocked behind
 * unrelated older queued mutations.
 */
export async function drainOutbox({
  transport, account, handlers, limit = 25, mutationId = null, useWebSocket = false,
}) {
  const rows = mutationId == null
    ? await handlers[DB_RPC.PENDING_MUTATION_LIST_PENDING]({
      accountId: account.id,
      limit,
    })
    : await handlers[DB_RPC.QUERY]({
      sql: `SELECT * FROM pending_mutations
              WHERE account_id = ?
                AND id = ?
                AND local_status IN ('pending','retry')
              LIMIT 1`,
      params: [account.id, mutationId],
    });
  const summary = { attempted: rows.length, succeeded: 0, failed: 0 };
  for (const row of rows) {
    try {
      await markRow(handlers, row.id, 'in_flight');
      const result = await runOne({ transport, account, handlers, row, useWebSocket });
      if (result.ok) {
        await deleteRow(handlers, row.id);
        summary.succeeded += 1;
      } else {
        await markFailed(handlers, row.id, result.error);
        summary.failed += 1;
      }
    } catch (error) {
      await markFailed(handlers, row.id, { type: 'transport', message: error?.message ?? String(error) });
      summary.failed += 1;
    }
  }
  return summary;
}

/**
 * Per-row dispatch. Translates one pending_mutations row into the
 * matching JMAP call and returns a result discriminator the caller
 * (drainOutbox or OutboxRunner) uses for status bookkeeping.
 *
 * Throws are intentionally NOT caught here; both callers wrap this in
 * their own try/catch and translate a thrown error into a
 * `{ ok: false, error: { type: 'transport' } }` result, which matters
 * for the runner's retryable-vs-terminal classification.
 */
export async function processMutationRow({
  transport, account, handlers, row, useWebSocket = false,
}) {
  const request = JSON.parse(row.request_json);
  switch (row.mutation_type) {
    case MUTATION_TYPES.SET_KEYWORDS:
      return runSetKeywords({ transport, account, handlers, row, request, useWebSocket });
    case MUTATION_TYPES.MOVE_TO_FOLDERS:
      return runMoveToFolders({ transport, account, handlers, row, request, useWebSocket });
    case MUTATION_TYPES.DESTROY:
      return runDestroy({ transport, account, handlers, row, request, useWebSocket });
    case MUTATION_TYPES.SEND:
      return runSend({ transport, account, handlers, row, request, useWebSocket });
    default:
      return { ok: false, error: { type: 'unsupportedMutation', mutation_type: row.mutation_type } };
  }
}

async function runOne(args) {
  return processMutationRow(args);
}

async function runSetKeywords({ transport, account, handlers, row, request, useWebSocket }) {
  const messageIds = collectMessageIds(row, request);
  if (messageIds.length === 0) {
    return { ok: false, error: { type: 'unknownMessage' } };
  }
  const resolved = await resolveRemoteMessageIds(handlers, account, messageIds);
  if (resolved.length === 0) {
    return { ok: false, error: { type: 'unknownMessage' } };
  }
  const update = {};
  for (const k of request.add ?? []) {
    update[`keywords/${k}`] = true;
  }
  for (const k of request.remove ?? []) {
    update[`keywords/${k}`] = null;
  }
  return submitEmailSet({
    transport,
    account,
    useWebSocket,
    update: Object.fromEntries(resolved.map(({ remoteId }) => [remoteId, update])),
  });
}

async function runMoveToFolders({ transport, account, handlers, row, request, useWebSocket }) {
  const messageIds = collectMessageIds(row, request);
  if (messageIds.length === 0) {
    return { ok: false, error: { type: 'unknownMessage' } };
  }
  const resolved = await resolveRemoteMessageIds(handlers, account, messageIds);
  if (resolved.length === 0) {
    return { ok: false, error: { type: 'unknownMessage' } };
  }
  const addLocalIds = (request.addFolderIds ?? []).map(Number).filter(Number.isFinite);
  const removeLocalIds = (request.removeFolderIds ?? []).map(Number).filter(Number.isFinite);
  const addRemote = await resolveRemoteFolderIds(handlers, addLocalIds);
  const removeRemote = await resolveRemoteFolderIds(handlers, removeLocalIds);
  const patch = {};
  for (const id of addRemote) patch[`mailboxIds/${id}`] = true;
  for (const id of removeRemote) patch[`mailboxIds/${id}`] = null;
  // One Email/set with N entries in `update` instead of N separate
  // mutations; whether the user clicked Delete on one row or
  // multi-selected fifty, the JMAP round trip count is always one.
  const update = Object.fromEntries(resolved.map(({ remoteId }) => [remoteId, patch]));
  const raw = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
    methodCalls: [['Email/set', { accountId: account.remote_account_id, update }, 's1']],
    useWebSocket,
  });
  const response = pickResponse(raw, 'Email/set');
  if (!response) {
    return { ok: false, error: extractMethodError(raw, { count: resolved.length }) };
  }
  const updatedRemoteIds = new Set(
    Object.keys(response.updated ?? {}),
  );
  const notUpdated = response.notUpdated ?? {};

  // Apply the local cache update once for the exact set of ids the
  // server confirmed in this Email/set chunk.
  await applyMoveBatchLocally(handlers, account, {
    messageIds: resolved
      .filter(({ remoteId }) => updatedRemoteIds.has(remoteId))
      .map(({ localId }) => localId),
    addFolderIds: addLocalIds,
    removeFolderIds: removeLocalIds,
  });

  // For each id the server refused, fall back to per-id reconcile so
  // a stale local cache (the message is already gone or already in
  // the destination) does not turn a no-op into a hard error.
  let unresolved = 0;
  for (const remoteId of Object.keys(notUpdated)) {
    const entry = resolved.find((r) => r.remoteId === remoteId);
    if (!entry) continue;
    const reconciled = await reconcileMessageFromServer({
      transport, account, handlers, useWebSocket,
      messageId: entry.localId, remoteId,
      removeRemoteFolderIds: removeRemote,
    });
    if (reconciled.gone) continue;
    if (reconciled.email && removeRemote.length > 0) {
      const stillInSource = removeRemote.some(
        (rid) => reconciled.email.mailboxIds?.[rid] === true,
      );
      if (!stillInSource) continue;
    }
    unresolved += 1;
  }
  if (unresolved > 0) {
    return { ok: false, error: { type: 'notUpdated', detail: notUpdated } };
  }
  return { ok: true, response: raw };
}

async function runDestroy({ transport, account, handlers, row, request, useWebSocket }) {
  const messageIds = collectMessageIds(row, request);
  if (messageIds.length === 0) {
    return { ok: false, error: { type: 'unknownMessage' } };
  }
  const resolved = await resolveRemoteMessageIds(handlers, account, messageIds);
  if (resolved.length === 0) {
    return { ok: false, error: { type: 'unknownMessage' } };
  }
  // Single Email/set destroy with the full id array. Stalwart and
  // every other RFC-8621 server accepts a batch here.
  const raw = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
    methodCalls: [['Email/set', {
      accountId: account.remote_account_id,
      destroy: resolved.map((r) => r.remoteId),
    }, 's1']],
    useWebSocket,
  });
  const response = pickResponse(raw, 'Email/set');
  if (!response) {
    return { ok: false, error: extractMethodError(raw, { count: resolved.length }) };
  }
  const destroyedRemoteIds = new Set(
    Array.isArray(response.destroyed) ? response.destroyed : [],
  );
  const notDestroyed = response.notDestroyed ?? {};

  await applyDestroyBatchLocally(handlers, account, {
    messageIds: resolved
      .filter(({ remoteId }) => destroyedRemoteIds.has(remoteId))
      .map(({ localId }) => localId),
  });

  let unresolved = 0;
  for (const remoteId of Object.keys(notDestroyed)) {
    const entry = resolved.find((r) => r.remoteId === remoteId);
    if (!entry) continue;
    const reconciled = await reconcileMessageFromServer({
      transport, account, handlers, useWebSocket,
      messageId: entry.localId, remoteId,
      removeRemoteFolderIds: [],
    });
    if (reconciled.gone) continue;
    unresolved += 1;
  }
  if (unresolved > 0) {
    return { ok: false, error: { type: 'notDestroyed', detail: notDestroyed } };
  }
  return { ok: true, response: raw };
}

/**
 * Pull the list of local message ids out of a pending_mutations row.
 *
 *   request.messageIds: number[]   - preferred shape, set by the store
 *                                    for both single and bulk callers.
 *   request.messageId:  number     - legacy single shape; kept so any
 *                                    pre-existing pending rows still drain.
 *   row.target_message_id          - legacy single FK pointer, also kept
 *                                    for back-compat with older rows.
 *
 * Returns a deduped array of finite numbers. May be empty.
 */
function collectMessageIds(row, request) {
  const out = new Set();
  if (Array.isArray(request?.messageIds)) {
    for (const id of request.messageIds) {
      const n = Number(id);
      if (Number.isFinite(n)) out.add(n);
    }
  }
  if (out.size === 0 && request?.messageId != null) {
    const n = Number(request.messageId);
    if (Number.isFinite(n)) out.add(n);
  }
  if (out.size === 0 && row?.target_message_id != null) {
    const n = Number(row.target_message_id);
    if (Number.isFinite(n)) out.add(n);
  }
  return [...out];
}

/**
 * Send a composed message. Writes Email/set + EmailSubmission/set in
 * one round trip, with onSuccessUpdateEmail moving the message out of
 * the Outbox/Drafts folder and into Sent on success.
 *
 * request shape (all ids are local row ids, resolved here):
 *   {
 *     identityId: <local identity row id>,
 *     to: [{ name?, email }, ...],
 *     cc, bcc, replyTo, subject,
 *     textBody?, htmlBody?,
 *     draftsFolderId?, sentFolderId?, outboxFolderId?,
 *   }
 */
async function runSend({ transport, account, handlers, row: _row, request, useWebSocket }) {
  const identity = await resolveIdentity(handlers, account, request.identityId);
  if (!identity) {
    return { ok: false, error: { type: 'unknownIdentity' } };
  }
  const folderRemoteIds = await resolveFolderRemoteIds(handlers, [
    request.draftsFolderId,
    request.sentFolderId,
    request.outboxFolderId,
  ]);
  const draftsRemoteId = folderRemoteIds[0];
  const sentRemoteId = folderRemoteIds[1];
  const outboxRemoteId = folderRemoteIds[2];

  const targetBox = outboxRemoteId ?? draftsRemoteId ?? null;
  const hasHtml = !!(request.htmlBody && /\S/.test(request.htmlBody));
  const [bodyStructure, bodyValues] = hasHtml
    ? [
      {
        type: 'multipart/alternative',
        subParts: [
          { type: 'text/plain', partId: 'p1' },
          { type: 'text/html', partId: 'h1' },
        ],
      },
      { p1: { value: request.textBody ?? '' }, h1: { value: request.htmlBody } },
    ]
    : [
      { type: 'text/plain', partId: 'p1' },
      { p1: { value: request.textBody ?? '' } },
    ];

  const emailCreate = {
    ...(targetBox ? { mailboxIds: { [targetBox]: true } } : {}),
    ...(targetBox === draftsRemoteId ? { keywords: { $draft: true } } : {}),
    from: [{
      ...(identity.name ? { name: identity.name } : {}),
      email: identity.email,
    }],
    to: request.to ?? [],
    ...(request.cc?.length ? { cc: request.cc } : {}),
    ...(request.bcc?.length ? { bcc: request.bcc } : {}),
    ...(request.replyTo?.length ? { replyTo: request.replyTo } : {}),
    subject: request.subject ?? '',
    bodyStructure,
    bodyValues,
  };

  const onSuccessUpdate = {
    ...(sentRemoteId ? { [`mailboxIds/${sentRemoteId}`]: true } : {}),
    ...(targetBox ? { [`mailboxIds/${targetBox}`]: null } : {}),
    'keywords/$draft': null,
  };

  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL, JMAP_CAPS.SUBMISSION],
    methodCalls: [
      ['Email/set', { accountId: account.remote_account_id, create: { c1: emailCreate } }, 'c1'],
      [
        'EmailSubmission/set',
        {
          accountId: account.remote_account_id,
          create: {
            s1: {
              identityId: identity.remote_id,
              emailId: '#c1',
              envelope: {
                mailFrom: { email: identity.email },
                rcptTo: (request.to ?? []).map((a) => ({ email: a.email })),
              },
            },
          },
          onSuccessUpdateEmail: { '#s1': onSuccessUpdate },
        },
        's1',
      ],
    ],
    useWebSocket,
  });

  const submission = pickResponse(result, 'EmailSubmission/set');
  if (submission?.notCreated && Object.values(submission.notCreated).length > 0) {
    return { ok: false, error: { type: 'notSubmitted', detail: submission.notCreated } };
  }

  // Mirror the server-side onSuccessUpdateEmail in the local cache
  // before resolving so listMessagesForView reads of Sent see the new
  // row immediately. Skipping this would leave the row visible only
  // after the JMAP push channel delivers the StateChange and
  // syncEmailChanges runs, which the constitution forbids.
  const emailSet = pickResponse(result, 'Email/set');
  const createdRemoteId = emailSet?.created?.c1?.id ?? null;
  await applySendLocally({
    transport,
    account,
    handlers,
    useWebSocket,
    createdRemoteId,
    sentRemoteId,
  });

  return { ok: true, response: result };
}

async function submitEmailSet({ transport, account, useWebSocket, update, destroy }: {
  transport: any;
  account: any;
  useWebSocket?: boolean;
  update?: any;
  destroy?: any;
}) {
  const params: any = { accountId: account.remote_account_id };
  if (update) params.update = update;
  if (destroy) params.destroy = destroy;
  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
    methodCalls: [['Email/set', params, 's1']],
    useWebSocket,
  });
  const response = pickResponse(result, 'Email/set');
  if (!response) {
    return { ok: false, error: extractMethodError(result) };
  }
  if (response.notUpdated && update && Object.values(response.notUpdated).length > 0) {
    return { ok: false, error: { type: 'notUpdated', detail: response.notUpdated } };
  }
  if (response.notDestroyed && destroy && Object.values(response.notDestroyed).length > 0) {
    return { ok: false, error: { type: 'notDestroyed', detail: response.notDestroyed } };
  }
  return { ok: true, response };
}

/**
 * Looks up remote ids for an array of local message ids in one query,
 * dropping any that no longer exist locally (e.g. a peer already
 * destroyed the row before the outbox got to it). Returns
 * [{ localId, remoteId }, ...] in no guaranteed order.
 */
async function resolveRemoteMessageIds(handlers, account, messageIds) {
  if (!Array.isArray(messageIds) || messageIds.length === 0) return [];
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT id, remote_id FROM messages
            WHERE account_id = ? AND id IN (${placeholders})`,
    params: [account.id, ...messageIds],
  });
  return rows
    .filter((r) => r.remote_id != null)
    .map((r) => ({ localId: Number(r.id), remoteId: r.remote_id }));
}

async function resolveRemoteFolderIds(handlers, localIds) {
  if (localIds.length === 0) return [];
  const placeholders = localIds.map(() => '?').join(',');
  const rows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT remote_id FROM folders WHERE id IN (${placeholders})`,
    params: localIds,
  });
  return rows.map((r) => r.remote_id);
}

/**
 * Position-preserving variant of resolveRemoteFolderIds. Returns the
 * remote_id at the same array index as the input local id, or null if
 * the id is missing or no folders row matches. Used by send to
 * translate (draftsFolderId, sentFolderId, outboxFolderId) into the
 * matching JMAP mailbox ids without losing the slot ordering.
 */
async function resolveFolderRemoteIds(handlers, localIds) {
  const result = new Array(localIds.length).fill(null);
  const numericById = new Map();
  for (let i = 0; i < localIds.length; i += 1) {
    const id = Number(localIds[i]);
    if (!Number.isFinite(id)) continue;
    if (!numericById.has(id)) numericById.set(id, []);
    numericById.get(id).push(i);
  }
  if (numericById.size === 0) return result;
  const ids = [...numericById.keys()];
  const placeholders = ids.map(() => '?').join(',');
  const rows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT id, remote_id FROM folders WHERE id IN (${placeholders})`,
    params: ids,
  });
  for (const row of rows) {
    const slots = numericById.get(Number(row.id));
    if (!slots) continue;
    for (const slot of slots) result[slot] = row.remote_id ?? null;
  }
  return result;
}

async function resolveIdentity(handlers, account, localIdentityId) {
  const id = Number(localIdentityId);
  if (!Number.isFinite(id)) return null;
  const rows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT id, remote_id, name, email
            FROM identities
           WHERE account_id = ? AND id = ?`,
    params: [account.id, id],
  });
  return rows[0] ?? null;
}

async function markRow(handlers, id, status) {
  await handlers[DB_RPC.QUERY]({
    sql: 'UPDATE pending_mutations SET local_status = ?, updated_at = ? WHERE id = ?',
    params: [status, Date.now(), id],
  });
}

async function markFailed(handlers, id, error) {
  await handlers[DB_RPC.QUERY]({
    sql: `UPDATE pending_mutations
              SET local_status = 'conflicted',
                  error_json = ?,
                  updated_at = ?
            WHERE id = ?`,
    params: [JSON.stringify(error ?? {}), Date.now(), id],
  });
}

async function deleteRow(handlers, id) {
  await handlers[DB_RPC.QUERY]({
    sql: 'DELETE FROM pending_mutations WHERE id = ?',
    params: [id],
  });
}

async function callJmap(transport, { using, methodCalls, useWebSocket }) {
  if (useWebSocket) {
    return transport.wsRequest(using, methodCalls);
  }
  return transport.request(using, methodCalls);
}

function pickResponse(result, methodName) {
  const responses = result?.methodResponses ?? [];
  const found = responses.find((r) => r[0] === methodName);
  return found?.[1] ?? null;
}

/**
 * Build a typed error result for the case where Email/set did not
 * return its expected response slot. Most commonly this is a JMAP
 * method-level error (RFC 8620 §3.6.1) returned in the "error" slot
 * of methodResponses, e.g. requestTooLarge, limit, serverFail. We
 * surface the server-reported type so the user gets actionable text
 * ("Could not move message (requestTooLarge).") instead of the
 * useless local fallback "noResponse" we used to emit.
 *
 * `hint.count` is included on requestTooLarge / limit so the store
 * can suggest a smaller batch in the toast if it ever wants to.
 */
function extractMethodError(raw: any, hint: { count?: number } = {}) {
  const responses = raw?.methodResponses ?? [];
  const errorSlot = responses.find((r: any) => r?.[0] === 'error');
  if (errorSlot) {
    const detail = errorSlot[1] ?? {};
    return {
      type: detail.type ?? 'methodError',
      description: detail.description,
      ...(hint.count != null ? { count: hint.count } : {}),
      detail,
    };
  }
  return {
    type: 'noResponse',
    ...(hint.count != null ? { count: hint.count } : {}),
  };
}
