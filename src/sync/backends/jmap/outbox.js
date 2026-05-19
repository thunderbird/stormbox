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
  applyMoveLocally,
  applyDestroyLocally,
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
  const remoteId = await resolveRemoteMessageId(handlers, account, row.target_message_id ?? request.messageId);
  if (!remoteId) {
    return { ok: false, error: { type: 'unknownMessage' } };
  }
  const update = {};
  for (const k of request.add ?? []) {
    update[`keywords/${k}`] = true;
  }
  for (const k of request.remove ?? []) {
    update[`keywords/${k}`] = null;
  }
  return submitEmailSet({ transport, account, useWebSocket, update: { [remoteId]: update } });
}

async function runMoveToFolders({ transport, account, handlers, row, request, useWebSocket }) {
  const messageId = row.target_message_id ?? request.messageId;
  const remoteId = await resolveRemoteMessageId(handlers, account, messageId);
  if (!remoteId) {
    return { ok: false, error: { type: 'unknownMessage' } };
  }
  const addLocalIds = (request.addFolderIds ?? []).map(Number).filter(Number.isFinite);
  const removeLocalIds = (request.removeFolderIds ?? []).map(Number).filter(Number.isFinite);
  const addRemote = await resolveRemoteFolderIds(handlers, addLocalIds);
  const removeRemote = await resolveRemoteFolderIds(handlers, removeLocalIds);
  const update = {};
  for (const id of addRemote) {
    update[`mailboxIds/${id}`] = true;
  }
  for (const id of removeRemote) {
    update[`mailboxIds/${id}`] = null;
  }
  const result = await submitEmailSet({
    transport, account, useWebSocket, update: { [remoteId]: update },
  });
  if (result.ok) {
    await applyMoveLocally(handlers, account, {
      messageId,
      addFolderIds: addLocalIds,
      removeFolderIds: removeLocalIds,
    });
    return result;
  }
  // Email/set update was rejected. Reconcile against the server: if
  // the message is gone, treat the move as a successful destroy. If
  // the message still exists but is no longer in any of the removed
  // folders (e.g. someone else already moved it elsewhere), treat the
  // user's intent as satisfied and report success.
  return reconcileAndDecide({
    transport, account, handlers, useWebSocket,
    messageId, remoteId, removeRemote, originalResult: result,
  });
}

async function runDestroy({ transport, account, handlers, row, request, useWebSocket }) {
  const messageId = row.target_message_id ?? request.messageId;
  const remoteId = await resolveRemoteMessageId(handlers, account, messageId);
  if (!remoteId) {
    return { ok: false, error: { type: 'unknownMessage' } };
  }
  const result = await submitEmailSet({
    transport, account, useWebSocket, destroy: [remoteId],
  });
  if (result.ok) {
    await applyDestroyLocally(handlers, account, { messageId });
    return result;
  }
  // Email/set destroy was rejected. If the message is already gone on
  // the server (notFound), treat the destroy as satisfied. Otherwise
  // refresh local cache and propagate the failure.
  const reconciled = await reconcileMessageFromServer({
    transport, account, handlers, useWebSocket, messageId, remoteId,
    removeRemoteFolderIds: [],
  });
  if (reconciled.gone) {
    return { ok: true, response: result.response, reconciled: 'gone' };
  }
  return result;
}

async function reconcileAndDecide({
  transport, account, handlers, useWebSocket,
  messageId, remoteId, removeRemote, originalResult,
}) {
  const reconciled = await reconcileMessageFromServer({
    transport, account, handlers, useWebSocket, messageId, remoteId,
    removeRemoteFolderIds: removeRemote,
  });
  if (reconciled.gone) {
    return { ok: true, response: originalResult.response, reconciled: 'gone' };
  }
  if (reconciled.email && removeRemote.length > 0) {
    const stillInSource = removeRemote.some(
      (rid) => reconciled.email.mailboxIds?.[rid] === true,
    );
    if (!stillInSource) {
      return { ok: true, response: originalResult.response, reconciled: 'matched' };
    }
  }
  return originalResult;
}

/**
 * Send a composed message. Writes Email/set + EmailSubmission/set in
 * one round trip, with onSuccessUpdateEmail moving the message out of
 * the Outbox/Drafts folder and into Sent on success.
 *
 * request shape:
 *   {
 *     identityId: 'i1',
 *     from: { name?, email },
 *     to: [{ name?, email }, ...],
 *     cc, bcc, replyTo, subject,
 *     textBody?, htmlBody?,
 *     draftsRemoteId?, sentRemoteId?, outboxRemoteId?,
 *   }
 */
async function runSend({ transport, account, handlers, row, request, useWebSocket }) {
  const targetBox = request.outboxRemoteId
    ?? request.draftsRemoteId
    ?? null;
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
    ...(targetBox === request.draftsRemoteId ? { keywords: { $draft: true } } : {}),
    from: [{
      ...(request.from?.name ? { name: request.from.name } : {}),
      email: request.from.email,
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
    ...(request.sentRemoteId ? { [`mailboxIds/${request.sentRemoteId}`]: true } : {}),
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
              identityId: request.identityId,
              emailId: '#c1',
              envelope: {
                mailFrom: { email: request.from.email },
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
  return { ok: true, response: result };
}

async function submitEmailSet({ transport, account, useWebSocket, update, destroy }) {
  const params = { accountId: account.remote_account_id };
  if (update) params.update = update;
  if (destroy) params.destroy = destroy;
  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
    methodCalls: [['Email/set', params, 's1']],
    useWebSocket,
  });
  const response = pickResponse(result, 'Email/set');
  if (!response) {
    return { ok: false, error: { type: 'noResponse' } };
  }
  if (response.notUpdated && update && Object.values(response.notUpdated).length > 0) {
    return { ok: false, error: { type: 'notUpdated', detail: response.notUpdated } };
  }
  if (response.notDestroyed && destroy && Object.values(response.notDestroyed).length > 0) {
    return { ok: false, error: { type: 'notDestroyed', detail: response.notDestroyed } };
  }
  return { ok: true, response };
}

async function resolveRemoteMessageId(handlers, account, messageId) {
  if (messageId == null) return null;
  const rows = await handlers[DB_RPC.QUERY]({
    sql: 'SELECT remote_id FROM messages WHERE account_id = ? AND id = ?',
    params: [account.id, messageId],
  });
  return rows[0]?.remote_id ?? null;
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
