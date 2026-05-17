/**
 * Outbox runner for JMAP mutations. Reads pending_mutations rows,
 * translates each into an Email/set or EmailSubmission/set request,
 * and applies the response.
 *
 * Supported mutation_type values for MVP:
 *
 *   'setKeywords'      Email/set update with a keywords/$X patch
 *   'moveToFolders'    Email/set update with a mailboxIds/<id> patch
 *   'destroy'          Email/set destroy
 *
 * Send (compose) is intentionally not handled here yet; it lives in a
 * separate path that goes via Email/set create + EmailSubmission/set.
 *
 * Failure handling: on a method-level error from the server we mark the
 * row 'conflicted' and surface error_json. The UI / sync engine is
 * responsible for either rolling back the optimistic_patch_json or
 * reconciling against the next /changes pass.
 */

import { DB_RPC } from '../../../db/protocol.js';
import { JMAP_CAPS } from './transport.js';

export const MUTATION_TYPES = Object.freeze({
  SET_KEYWORDS: 'setKeywords',
  MOVE_TO_FOLDERS: 'moveToFolders',
  DESTROY: 'destroy',
  SEND: 'send',
});

/**
 * Drain a batch of pending mutations for the given account. Returns a
 * summary of what was attempted and how each one ended.
 */
export async function drainOutbox({ transport, account, handlers, limit = 25, useWebSocket = false }) {
  const rows = await handlers[DB_RPC.PENDING_MUTATION_LIST_PENDING]({
    accountId: account.id,
    limit,
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

async function runOne({ transport, account, handlers, row, useWebSocket }) {
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
  const remoteId = await resolveRemoteMessageId(handlers, account, row.target_message_id ?? request.messageId);
  if (!remoteId) {
    return { ok: false, error: { type: 'unknownMessage' } };
  }
  const addRemote = await resolveRemoteFolderIds(handlers, request.addFolderIds ?? []);
  const removeRemote = await resolveRemoteFolderIds(handlers, request.removeFolderIds ?? []);
  const update = {};
  for (const id of addRemote) {
    update[`mailboxIds/${id}`] = true;
  }
  for (const id of removeRemote) {
    update[`mailboxIds/${id}`] = null;
  }
  return submitEmailSet({ transport, account, useWebSocket, update: { [remoteId]: update } });
}

async function runDestroy({ transport, account, handlers, row, request, useWebSocket }) {
  const remoteId = await resolveRemoteMessageId(handlers, account, row.target_message_id ?? request.messageId);
  if (!remoteId) {
    return { ok: false, error: { type: 'unknownMessage' } };
  }
  return submitEmailSet({ transport, account, useWebSocket, destroy: [remoteId] });
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
