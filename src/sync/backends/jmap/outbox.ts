/**
 * JMAP mutation dispatch + post-success cache reconciliation.
 *
 * Translates a single pending_mutations row into the appropriate
 * Email/set or EmailSubmission/set request, then mirrors the
 * server-confirmed result in the local SQLite cache before resolving.
 * The constitution requires the cache to match the server before the
 * mutation RPC returns, so we never wait for an async StateChange push
 * to apply the local effect.
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
 * Move and destroy delegate the cache effect to the protocol-neutral
 * OUTBOX_APPLY_MOVE_BATCH / OUTBOX_APPLY_DESTROY_BATCH DB handlers,
 * which do the work inside a single engine transaction. Send and the
 * notUpdated/notDestroyed fallback are JMAP-specific (they issue an
 * Email/get to reconcile) and live in `applySendLocally` /
 * `reconcileMessageFromServer` below.
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

import { DB_RPC } from '../../../db/protocol';
import { JMAP_CAPS } from './transport';
import { callJmap, pickResponse } from './invoke';
import { persistEmails, EMAIL_LIST_PROPERTIES } from './messages';
import { base64ToBytes, extractDataUriImages } from '../../../utils/inline-images';

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
  // server confirmed in this Email/set chunk. The DB handler does the
  // folder_messages swap, view compaction, and stale-marking inside a
  // single engine transaction; combining the steps is what keeps
  // delete snappy under indexer contention (see docs/architecture/
  // performance.md > Batched persistence).
  await handlers[DB_RPC.OUTBOX_APPLY_MOVE_BATCH]({
    accountId: account.id,
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

  // Mirror the server-confirmed destroy id set in one transaction:
  // DELETE FROM messages cascades to folder_messages, and each
  // affected query_view is compacted and its total decremented
  // before the handler returns.
  await handlers[DB_RPC.OUTBOX_APPLY_DESTROY_BATCH]({
    accountId: account.id,
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

  // Inline pasted images arrive as base64 data: URLs embedded in the
  // HTML. JMAP cannot carry binary in the Email/set body, so upload each
  // one as a blob and rewrite the HTML to reference it via cid:.
  const extracted = hasHtml
    ? extractDataUriImages(request.htmlBody)
    : { html: request.htmlBody ?? '', images: [] };
  let inlineAttachments;
  try {
    inlineAttachments = await uploadInlineImages({ transport, account, images: extracted.images });
  } catch (err: any) {
    return { ok: false, error: { type: 'uploadFailed', message: err?.message ?? String(err) } };
  }

  let bodyFields;
  if (hasHtml && inlineAttachments.length > 0) {
    // Convenience-property form: the server assembles multipart/related
    // (html + inline images) within a multipart/alternative alongside
    // the text part. bodyStructure is intentionally omitted here;
    // setting it makes the server ignore htmlBody/textBody/attachments.
    bodyFields = {
      bodyValues: {
        p1: { value: request.textBody ?? '' },
        h1: { value: extracted.html },
      },
      textBody: [{ partId: 'p1', type: 'text/plain' }],
      htmlBody: [{ partId: 'h1', type: 'text/html' }],
      attachments: inlineAttachments,
    };
  } else if (hasHtml) {
    bodyFields = {
      bodyStructure: {
        type: 'multipart/alternative',
        subParts: [
          { type: 'text/plain', partId: 'p1' },
          { type: 'text/html', partId: 'h1' },
        ],
      },
      bodyValues: {
        p1: { value: request.textBody ?? '' },
        h1: { value: extracted.html },
      },
    };
  } else {
    bodyFields = {
      bodyStructure: { type: 'text/plain', partId: 'p1' },
      bodyValues: { p1: { value: request.textBody ?? '' } },
    };
  }

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
    ...bodyFields,
  };

  const onSuccessUpdate = {
    ...(sentRemoteId ? { [`mailboxIds/${sentRemoteId}`]: true } : {}),
    ...(targetBox ? { [`mailboxIds/${targetBox}`]: null } : {}),
    'keywords/$draft': null,
    'keywords/$seen': true,
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

/**
 * Upload each inline pasted image to the JMAP blob endpoint and return
 * the EmailBodyPart attachment descriptors (blobId + cid + inline
 * disposition) the Email/set create references. Returns [] when there
 * are no images. Throws if any upload fails or returns no blobId so the
 * caller can fail the whole send and keep the draft for retry.
 */
async function uploadInlineImages({ transport, account, images }) {
  const attachments = [];
  for (const image of images) {
    const result = await transport.upload({
      accountId: account.remote_account_id,
      type: image.type,
      body: base64ToBytes(image.base64),
    });
    const blobId = result?.blobId;
    if (!blobId) {
      throw new Error('JMAP upload returned no blobId');
    }
    attachments.push({
      blobId,
      type: image.type,
      cid: image.cid,
      disposition: 'inline',
    });
  }
  return attachments;
}

// ----- post-success cache reconciliation -----------------------------
//
// Move and destroy delegate to the protocol-neutral DB handlers
// (inlined at their call sites above). Send and the notUpdated /
// notDestroyed fallback need a JMAP Email/get to find the canonical
// row, so they live here next to the dispatch code that calls them.

/**
 * Apply a successful Email/set create + EmailSubmission/set send
 * locally. The constitution requires the local cache to match the
 * server before the mutation RPC resolves; without this step the new
 * email would only land via a later StateChange push.
 *
 * Pulls the freshly-created email back from the server (its
 * mailboxIds reflect the post-onSuccessUpdateEmail state, i.e. the
 * Sent folder and not the transient Drafts/Outbox box used during
 * create), persists it via persistEmails so messages and
 * folder_messages match, and prepends the new remote_id at position 0
 * in any open Sent mailbox-window query_view so a subsequent
 * listMessagesForView read returns the row immediately.
 *
 * sentRemoteId is the JMAP mailbox id of Sent. With no sentRemoteId
 * we still persist the message but skip the query_view update; the
 * next folder visit will rebuild the window from the server.
 *
 * Exported so the unit test in tests/unit/sync/outbox-apply.test.ts
 * can drive it directly without spinning up a full SEND row.
 */
export async function applySendLocally({
  transport, account, handlers, useWebSocket = false,
  createdRemoteId, sentRemoteId,
}) {
  if (!createdRemoteId) return;
  const payload = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
    methodCalls: [[
      'Email/get',
      {
        accountId: account.remote_account_id,
        ids: [createdRemoteId],
        properties: EMAIL_LIST_PROPERTIES,
      },
      'r1',
    ]],
    useWebSocket,
  });
  const got = pickResponse(payload, 'Email/get');
  const email = got?.list?.[0];
  if (!email) return;

  await persistEmails({ account, emails: [email], handlers });

  if (!sentRemoteId) return;
  const folderRows = await handlers[DB_RPC.QUERY]({
    sql: 'SELECT id FROM folders WHERE account_id = ? AND remote_id = ?',
    params: [account.id, sentRemoteId],
  });
  const sentFolderId = folderRows[0]?.id;
  if (sentFolderId == null) return;

  // Prepend the new remote_id at position 0 of every open Sent
  // mailbox-window query_view and bump total. Sent is sorted newest
  // first, so position 0 is correct for any sort variant the open
  // view holds.
  const viewRows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT id FROM query_views
           WHERE account_id = ? AND folder_id = ?
             AND view_type = 'mailbox-window'`,
    params: [account.id, Number(sentFolderId)],
  });
  for (const view of viewRows) {
    const viewId = Number(view.id);
    const result = await handlers[DB_RPC.QUERY_VIEW_APPLY_CHANGES]({
      viewId,
      removed: [],
      added: [{ id: createdRemoteId, index: 0 }],
    });
    if (Number(result?.added ?? 0) > 0) {
      await handlers[DB_RPC.QUERY]({
        sql: `UPDATE query_views
                 SET total = COALESCE(total, 0) + ?,
                     updated_at = ?
               WHERE id = ?`,
        params: [Number(result.added), Date.now(), viewId],
      });
    }
  }
}

/**
 * Reconcile local state for a single message against what the server
 * actually has. Called when Email/set update or destroy returned
 * notUpdated/notDestroyed - the most common reason is that local cache
 * and server are out of sync (someone else moved/deleted the message),
 * so the patch could not be applied. A push-only client could trust
 * Email/set and let the next StateChange catch up, but with a SQLite
 * cache the user would navigate through stale rows until the push
 * landed, so we reconcile inline instead.
 *
 * Returns:
 *   { gone: true }                  -> message no longer on server; we
 *                                      applied destroy locally
 *   { gone: false, email }          -> message still on server with the
 *                                      shown mailboxIds; local cache has
 *                                      been refreshed to match
 *   { gone: false, email: null,
 *     error: 'getFailed' }          -> Email/get itself failed; local
 *                                      state is unchanged
 */
async function reconcileMessageFromServer({
  transport, account, handlers, messageId, remoteId,
  removeRemoteFolderIds = [], useWebSocket = false,
}) {
  let payload;
  try {
    payload = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
      methodCalls: [[
        'Email/get',
        {
          accountId: account.remote_account_id,
          ids: [remoteId],
          properties: EMAIL_LIST_PROPERTIES,
        },
        'r1',
      ]],
      useWebSocket,
    });
  } catch (err) {
    return { gone: false, email: null, error: 'getFailed', detail: err?.message };
  }

  const got = pickResponse(payload, 'Email/get');
  const list = got?.list ?? [];
  const notFound = got?.notFound ?? [];

  if (list.length === 0 || notFound.includes(remoteId)) {
    // Server confirmed the message is gone; apply the destroy locally
    // through the protocol-neutral handler.
    await handlers[DB_RPC.OUTBOX_APPLY_DESTROY_BATCH]({
      accountId: account.id,
      messageIds: [messageId],
    });
    return { gone: true };
  }

  const email = list[0];
  await persistEmails({ account, emails: [email], handlers });

  // Even though persistEmails fixed folder_messages, query_view_items
  // still references this remote_id in any view whose folder is no
  // longer in the email's mailboxIds. Drop those entries explicitly so
  // the user does not keep seeing the message in those folders.
  for (const remoteFolderId of removeRemoteFolderIds) {
    if (email.mailboxIds?.[remoteFolderId] === true) continue;
    const rows = await handlers[DB_RPC.QUERY]({
      sql: 'SELECT id FROM folders WHERE account_id = ? AND remote_id = ?',
      params: [account.id, remoteFolderId],
    });
    if (!rows[0]) continue;
    await dropFromActiveViews(handlers, account, {
      folderId: Number(rows[0].id),
      remoteId,
    });
  }

  return { gone: false, email };
}

async function dropFromActiveViews(handlers, account, { folderId, remoteId }) {
  // Used by reconcileMessageFromServer when an Email/get confirms the
  // message moved out of a folder we expected it to leave. Going
  // through OUTBOX_APPLY_MOVE here would require knowing the
  // messageId; this narrow per-view fix only needs the remoteId.
  const viewRows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT id FROM query_views
           WHERE account_id = ?
             AND folder_id = ?
             AND view_type = 'mailbox-window'`,
    params: [account.id, folderId],
  });
  for (const view of viewRows) {
    const result = await handlers[DB_RPC.QUERY_VIEW_APPLY_CHANGES]({
      viewId: Number(view.id),
      removed: [remoteId],
      added: [],
    });
    if (Number(result?.removed ?? 0) > 0) {
      await handlers[DB_RPC.QUERY]({
        sql: `UPDATE query_views
                 SET total = MAX(0, COALESCE(total, 0) - 1),
                     updated_at = ?
               WHERE id = ?`,
        params: [Date.now(), Number(view.id)],
      });
    }
  }
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
