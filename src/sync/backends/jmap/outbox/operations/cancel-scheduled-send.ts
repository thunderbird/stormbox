/**
 * Cancel a scheduled send: revoke the held EmailSubmission and return
 * the message to Drafts as an editable draft.
 *
 * Durable because it is a user action that must survive reload, but
 * deliberately checkpoint-free: nothing here is ambiguous the way a send
 * is. Every attempt re-reads the current submission and Email state and
 * converges — already-canceled plus Drafts placement is success, `final`
 * is too late, and a submission the server no longer shows is resolved
 * conservatively (retry while the target is still in the future,
 * `unknown` once it has passed; never guessed as sent or canceled).
 *
 * Server writes are the one portable two-call sequence:
 * `EmailSubmission/set { undoStatus: "canceled" }` (RFC 8621 §7.3), then
 * an idempotent `Email/set` that moves Scheduled → Drafts and restores
 * `$draft`.
 */

import { DB_RPC } from '../../../../../db/protocol';
import { callJmap, pickResponse } from '../../invoke';
import { scheduleClockWindow } from '../../schedule-time';
import {
  readScheduledMailboxRemoteId,
  reconcileScheduledSubscription,
} from '../../scheduled-mailbox';
import { fetchSubmissionRecords, pickRecordForRow } from '../../submissions';
import { JMAP_CAPS } from '../../transport';
import { extractMethodError } from '../errors';
import { reconcileMessageFromServer } from '../messages-shared';

async function setScheduledColumns(handlers, accountId, emailRemoteId, undoStatus) {
  await handlers[DB_RPC.MESSAGE_SET_SCHEDULED]({
    accountId,
    emailRemoteId,
    submissionRemoteId: null,
    undoStatus,
  });
}

async function resolveClearedCancel(
  handlers,
  accountId: number,
  messageId: number,
): Promise<{ ok: boolean; error?: any; result?: any }> {
  const scheduledRemoteId = await readScheduledMailboxRemoteId(handlers, accountId);
  const placements = await handlers[DB_RPC.QUERY]({
    sql: `SELECT f.role, f.remote_id
            FROM folder_messages fm
            JOIN folders f ON f.id = fm.folder_id
           WHERE fm.message_id = ? AND f.account_id = ? AND f.is_deleted = 0`,
    params: [messageId, accountId],
  });
  if (placements.some((placement) => placement.role === 'sent')) {
    return {
      ok: false,
      error: {
        type: 'scheduleAlreadySent',
        terminal: true,
        description: 'This message was already sent and can no longer be canceled.',
      },
    };
  }
  const inDrafts = placements.some((placement) => placement.role === 'drafts');
  const inScheduled = scheduledRemoteId != null
    && placements.some((placement) => placement.remote_id === scheduledRemoteId);
  if (inDrafts && !inScheduled) {
    return { ok: true, result: { canceled: true } };
  }
  return {
    ok: false,
    error: {
      type: 'scheduleStateUnknown',
      terminal: true,
      description: 'The message no longer has enough scheduling state to confirm cancellation.',
    },
  };
}

async function runCancelScheduledSend({
  transport, account, handlers, row, request, useWebSocket,
}): Promise<{ ok: boolean; error?: any; result?: any }> {
  const messageId = Number(request?.messageId ?? row?.target_message_id);
  if (!Number.isFinite(messageId)) {
    return { ok: false, error: { type: 'unknownMessage', terminal: true } };
  }
  const messageRows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT id, remote_id, sent_at, scheduled_submission_remote_id,
                 scheduled_undo_status
            FROM messages
           WHERE id = ? AND account_id = ?`,
    params: [messageId, account.id],
  });
  const message = messageRows?.[0];
  if (!message?.remote_id) {
    return { ok: false, error: { type: 'unknownMessage', terminal: true } };
  }
  // Cleared columns are ambiguous on their own: both a completed cancel
  // and a released message eventually clear them. Placement distinguishes
  // the idempotent Drafts success from the too-late Sent outcome.
  if (message.scheduled_undo_status == null) {
    return resolveClearedCancel(handlers, account.id, message.id);
  }

  // ---- current submission state, read fresh on every attempt ---------
  let records;
  try {
    records = await fetchSubmissionRecords({ transport, account, useWebSocket });
  } catch (err: any) {
    return {
      ok: false,
      error: { type: err?.type ?? 'transport', message: err?.message ?? String(err) },
    };
  }
  const record = pickRecordForRow(
    records.filter((candidate) => candidate.emailId === message.remote_id),
    message.scheduled_submission_remote_id ?? null,
  );

  if (record?.undoStatus === 'final') {
    // Too late: the server released the message. The submission sync
    // files it into Sent from this status; the cancel itself failed.
    await setScheduledColumns(handlers, account.id, message.remote_id, 'final');
    return {
      ok: false,
      error: {
        type: 'scheduleAlreadySent',
        terminal: true,
        description: 'This message was already sent and can no longer be canceled.',
      },
    };
  }

  if (!record) {
    const clock = scheduleClockWindow(transport);
    if (message.sent_at != null && Number(message.sent_at) <= clock.lowerMs) {
      // The target passed and the record is gone — RFC 8621 §7 lets the
      // server destroy finished records, so nothing can prove whether
      // the message went out. Mark it unknown; never guess.
      await setScheduledColumns(handlers, account.id, message.remote_id, 'unknown');
      return {
        ok: false,
        error: {
          type: 'scheduleStateUnknown',
          terminal: true,
          description: 'The scheduled time has passed and the server no longer '
            + 'reports this message. It may already have been sent.',
        },
      };
    }
    // Future target with no visible record is transient (a submission
    // sync lag, a flaky query); the retry re-reads everything.
    return {
      ok: false,
      error: {
        type: 'submissionMissing',
        message: 'The scheduled submission is not visible on the server yet.',
      },
    };
  }

  // ---- call 1: revoke any submission not confirmed canceled ----------
  // An unreadable status is not evidence of cancellation. Updating the
  // known submission id is the only safe way to prevent a held message
  // from releasing after the UI reports success.
  if (record.undoStatus !== 'canceled') {
    let raw;
    try {
      raw = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL, JMAP_CAPS.SUBMISSION],
        methodCalls: [[
          'EmailSubmission/set',
          {
            accountId: account.remote_account_id,
            update: { [record.id]: { undoStatus: 'canceled' } },
          },
          'cs1',
        ]],
        useWebSocket,
      });
    } catch (err: any) {
      return {
        ok: false,
        error: { type: err?.type ?? 'transport', message: err?.message ?? String(err) },
      };
    }
    const response = pickResponse(raw, 'EmailSubmission/set');
    if (!response) {
      return { ok: false, error: extractMethodError(raw) };
    }
    const failure = response.notUpdated?.[record.id];
    if (failure) {
      // The likeliest cause is a release racing this cancel. Retryable:
      // the next attempt re-reads the record and answers `final`
      // definitively instead of guessing here.
      return {
        ok: false,
        error: {
          type: 'cancelRejected',
          message: failure.description ?? failure.type ?? 'cancel was rejected',
          detail: failure,
        },
      };
    }
  }
  // An already-canceled record (an earlier attempt or another client)
  // falls through: the remaining work is restoring the draft.

  // ---- call 2: idempotent restore to Drafts ---------------------------
  const draftsRows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT id, remote_id FROM folders
           WHERE account_id = ? AND role = 'drafts' AND is_deleted = 0`,
    params: [account.id],
  });
  const drafts = draftsRows?.[0];
  if (!drafts?.remote_id) {
    return { ok: false, error: { type: 'unknownFolder', terminal: true } };
  }
  const scheduledRemoteId = await readScheduledMailboxRemoteId(handlers, account.id);
  const patch: Record<string, boolean | null> = {
    [`mailboxIds/${drafts.remote_id}`]: true,
    'keywords/$draft': true,
  };
  if (scheduledRemoteId && scheduledRemoteId !== drafts.remote_id) {
    patch[`mailboxIds/${scheduledRemoteId}`] = null;
  }
  let restoreRaw;
  try {
    restoreRaw = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
      methodCalls: [[
        'Email/set',
        {
          accountId: account.remote_account_id,
          update: { [message.remote_id]: patch },
        },
        'cs2',
      ]],
      useWebSocket,
    });
  } catch (err: any) {
    return {
      ok: false,
      error: { type: err?.type ?? 'transport', message: err?.message ?? String(err) },
    };
  }
  const restore = pickResponse(restoreRaw, 'Email/set');
  if (!restore) {
    return { ok: false, error: extractMethodError(restoreRaw) };
  }
  const restoreFailure = restore.notUpdated?.[message.remote_id];
  if (restoreFailure && restoreFailure.type !== 'notFound') {
    return {
      ok: false,
      error: {
        type: 'restoreRejected',
        message: restoreFailure.description ?? restoreFailure.type,
        detail: restoreFailure,
      },
    };
  }

  // ---- make the local cache agree before reporting success -----------
  // A notFound restore means the Email itself is gone (another client
  // deleted it after canceling); the submission is revoked, so the
  // cancel still succeeded and reconciliation drops the local row.
  const reconciled = await reconcileMessageFromServer({
    transport,
    account,
    handlers,
    useWebSocket,
    messageId: message.id,
    remoteId: message.remote_id,
    removeRemoteFolderIds: scheduledRemoteId ? [scheduledRemoteId] : [],
  });
  if (!reconciled.gone && !reconciled.email) {
    // The server writes landed but the cache read failed; success may
    // only be reported once both agree, so retry the whole (idempotent)
    // resolution.
    return {
      ok: false,
      error: { type: 'cacheReconcileFailed', message: reconciled.detail ?? 'Email/get failed' },
    };
  }
  if (!reconciled.gone) {
    await setScheduledColumns(handlers, account.id, message.remote_id, null);
  }
  await reconcileScheduledSubscription(handlers, account.id);
  return { ok: true, result: { canceled: true } };
}

export { runCancelScheduledSend };
