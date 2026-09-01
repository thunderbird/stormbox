/**
 * Thin EmailSubmission synchronizer for Send Later.
 *
 * Scheduled messages are ordinary cached messages in the real Scheduled
 * mailbox; the only extra state is two columns on their `messages` rows
 * (submission remote id + undo status). This module keeps those columns
 * honest against the server and hands settled schedules to existing
 * durable operations — the generic move for released sends, the cancel
 * operation for externally canceled ones. It holds no state machine of
 * its own: every pass re-reads both sides and converges.
 *
 * Stalwart 0.15.4 compatibility: filtered EmailSubmission/query
 * (undoStatus, before/after) returns unreliable results, so the one
 * portable read is an unfiltered query for ids, an explicit get, and
 * client-side filtering. Do not branch by server version.
 */

import { MUTATION_TYPE } from '../../../constants/states';
import { DB_RPC } from '../../../db/protocol';
import { wlog } from '../../../db/worker-log';
import { callJmap, pickResponse, requireResponse } from './invoke';
import { maxObjectsInGet } from './limits';
import { EMAIL_LIST_PROPERTIES, persistEmails } from './messages';
import {
  pageCompleteQuery,
  type CompleteQueryFailureReason,
} from './query-paging';
import {
  scheduleClockWindow,
  SUBMISSION_RELEASE_OBSERVATION_DELAY_MS,
} from './schedule-time';
import {
  ensureScheduledMailbox,
  readScheduledMailboxRemoteId,
  reconcileScheduledSubscription,
} from './scheduled-mailbox';
import { JMAP_CAPS } from './transport';

export interface SubmissionRecord {
  id: string;
  emailId: string;
  undoStatus: 'pending' | 'final' | 'canceled' | null;
  sendAt: string | null;
}

interface SubmissionSyncArgs {
  transport: any;
  account: { id: number; remote_account_id: string };
  handlers: Record<string, (params: any) => Promise<any>>;
  useWebSocket?: boolean;
}

function submissionPagingError(reason: CompleteQueryFailureReason): Error {
  switch (reason) {
    case 'queryStateChanged':
    case 'queryTotalChanged':
      return new Error('EmailSubmission query changed while paging');
    case 'truncated':
    case 'pageLimitReached':
      return new Error('EmailSubmission query stopped before its reported total');
    case 'queryStateMissing':
    case 'cursorStalled':
    case 'positionPastTotal':
      return new Error('EmailSubmission paging returned a malformed response');
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/**
 * Every retained submission the server will show us, validated but not
 * interpreted. An undoStatus outside the RFC 8621 §7 set maps to null so
 * callers treat it conservatively instead of misreading it.
 */
export async function fetchSubmissionRecords({
  transport, account, useWebSocket = false,
}: Omit<SubmissionSyncArgs, 'handlers'>): Promise<SubmissionRecord[]> {
  const records: SubmissionRecord[] = [];
  const seen = new Set<string>();
  const limit = maxObjectsInGet(transport);
  const paging = await pageCompleteQuery({
    pageSize: limit,
    readPage: async ({ position, limit: pageLimit }) => {
      const queryCallId = `subq-${position}`;
      const getCallId = `subg-${position}`;
      const payload = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL, JMAP_CAPS.SUBMISSION],
        methodCalls: [
          [
            'EmailSubmission/query',
            {
              accountId: account.remote_account_id,
              position,
              limit: pageLimit,
              calculateTotal: true,
            },
            queryCallId,
          ],
          [
            'EmailSubmission/get',
            {
              accountId: account.remote_account_id,
              '#ids': {
                resultOf: queryCallId,
                name: 'EmailSubmission/query',
                path: '/ids',
              },
              properties: ['id', 'emailId', 'undoStatus', 'sendAt'],
            },
            getCallId,
          ],
        ],
        useWebSocket,
      });
      const query = requireResponse(payload, 'EmailSubmission/query');
      const got = requireResponse(payload, 'EmailSubmission/get');
      const ids = Array.isArray(query.ids)
        ? query.ids.filter((id: unknown): id is string => typeof id === 'string')
        : null;
      const pageTotal = Number(query.total);
      if (
        ids == null
        || ids.length !== query.ids.length
        || ids.length > pageLimit
        || !Number.isSafeInteger(query.position)
        || Number(query.position) !== position
        || !Number.isSafeInteger(pageTotal)
        || pageTotal < 0
        || typeof query.queryState !== 'string'
        || query.queryState.length === 0
        || !Array.isArray(got.list)
        || !Array.isArray(got.notFound)
      ) {
        throw new Error('EmailSubmission paging returned a malformed response');
      }
      return {
        ids,
        queryState: query.queryState,
        total: pageTotal,
        position: query.position,
        limit: query.limit,
        value: got,
      };
    },
    visitPage: ({ ids, value: got }) => {
      const pageIds = ids as string[];
      if (got.notFound.length > 0 || got.list.length !== ids.length) {
        throw new Error('EmailSubmission records changed while paging');
      }
      const byId = new Map(got.list.map((raw: any) => [raw?.id, raw]));
      for (const id of pageIds) {
        const raw: any = byId.get(id);
        if (
          !raw
          || typeof raw.emailId !== 'string'
          || seen.has(id)
        ) {
          throw new Error('EmailSubmission paging returned incomplete records');
        }
        seen.add(id);
        records.push({
          id,
          emailId: raw.emailId,
          undoStatus:
            raw.undoStatus === 'pending'
            || raw.undoStatus === 'final'
            || raw.undoStatus === 'canceled'
              ? raw.undoStatus
              : null,
          sendAt: typeof raw.sendAt === 'string' ? raw.sendAt : null,
        });
      }
    },
  });
  if (paging.complete === false) {
    throw submissionPagingError(paging.reason);
  }
  return records;
}

/**
 * The record that speaks for one tracked message. Once an id is known,
 * only that immutable server object is authoritative; emailId fallback is
 * reserved for acceptance recovery where the submission id was unavailable.
 */
export function pickRecordForRow(
  records: SubmissionRecord[],
  trackedSubmissionId: string | null,
): SubmissionRecord | null {
  if (records.length === 0) return null;
  if (trackedSubmissionId) {
    const exact = records.find((record) => record.id === trackedSubmissionId);
    return exact ?? null;
  }
  return records.find((record) => record.undoStatus === 'pending') ?? records[0];
}

async function setScheduled(
  handlers: SubmissionSyncArgs['handlers'],
  accountId: number,
  emailRemoteId: string,
  submissionRemoteId: string | null,
  undoStatus: 'pending' | 'final' | 'canceled' | 'unknown' | null,
): Promise<void> {
  await handlers[DB_RPC.MESSAGE_SET_SCHEDULED]({
    accountId, emailRemoteId, submissionRemoteId, undoStatus,
  });
}

type HandoffMutationState = 'active' | 'conflicted' | null;

/** Current durable handoff state for a settled schedule. */
async function handoffMutationState(
  handlers: SubmissionSyncArgs['handlers'],
  accountId: number,
  mutationType: string,
  targetMessageId: number,
): Promise<HandoffMutationState> {
  const rows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT local_status FROM pending_mutations
           WHERE account_id = ? AND mutation_type = ? AND target_message_id = ?
             AND local_status IN ('pending', 'in_flight', 'retry', 'conflicted')`,
    params: [accountId, mutationType, targetMessageId],
  });
  if (rows.some((row) =>
    row.local_status === 'pending'
    || row.local_status === 'in_flight'
    || row.local_status === 'retry')) {
    return 'active';
  }
  return rows.some((row) => row.local_status === 'conflicted')
    ? 'conflicted'
    : null;
}

/** Local folder ids the settled-row handoffs need, resolved per pass. */
async function resolveHandoffFolders(
  handlers: SubmissionSyncArgs['handlers'],
  accountId: number,
): Promise<{ sentFolderId: number | null; scheduledFolderId: number | null }> {
  const scheduledRemoteId = await readScheduledMailboxRemoteId(handlers, accountId);
  const rows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT id, role, remote_id FROM folders
           WHERE account_id = ? AND is_deleted = 0
             AND (role = 'sent' OR remote_id = ?)`,
    params: [accountId, scheduledRemoteId ?? ''],
  });
  let sentFolderId: number | null = null;
  let scheduledFolderId: number | null = null;
  for (const row of rows ?? []) {
    if (row.role === 'sent') sentFolderId = Number(row.id);
    if (scheduledRemoteId && row.remote_id === scheduledRemoteId) {
      scheduledFolderId = Number(row.id);
    }
  }
  return { sentFolderId, scheduledFolderId };
}

/**
 * Reconcile local scheduling state with the server's submissions and
 * hand settled rows to durable operations. Level-based: every pass
 * re-derives all decisions, so triggers can fire as often as they like.
 *
 * Returns the nearest pending target (epoch ms) for the account-level
 * wake-up, and whether an active settled-row handoff still awaits local
 * resolution (a caller may schedule one short follow-up pass for those).
 */
export async function syncSubmissionsForAccount({
  transport, account, handlers, useWebSocket = false,
}: SubmissionSyncArgs): Promise<{
  nearestPendingAt: number | null;
  unresolvedSettled: boolean;
}> {
  const records = await fetchSubmissionRecords({ transport, account, useWebSocket });
  const byEmailId = new Map<string, SubmissionRecord[]>();
  for (const record of records) {
    const group = byEmailId.get(record.emailId) ?? [];
    group.push(record);
    byEmailId.set(record.emailId, group);
  }

  const tracked: any[] = await handlers[DB_RPC.QUERY]({
    sql: `SELECT id, remote_id, sent_at, scheduled_submission_remote_id,
                 scheduled_undo_status
            FROM messages
           WHERE account_id = ? AND scheduled_undo_status IS NOT NULL`,
    params: [account.id],
  });
  const clock = scheduleClockWindow(transport);

  // ---- transitions for rows we already track -------------------------
  for (const row of tracked) {
    const record = pickRecordForRow(
      byEmailId.get(row.remote_id) ?? [],
      row.scheduled_submission_remote_id ?? null,
    );
    if (!record) {
      // No record: settled rows keep their status (records are reaped
      // after resolution; the handoff below still runs). A pending row
      // whose target has passed can no longer be confirmed either way —
      // RFC 8621 §7 lets the server destroy finished records — so it
      // becomes 'unknown', never guessed as sent or canceled.
      if (
        row.scheduled_undo_status === 'pending'
        && row.sent_at != null
        && Number(row.sent_at) <= clock.lowerMs
      ) {
        await setScheduled(handlers, account.id, row.remote_id, null, 'unknown');
        row.scheduled_undo_status = 'unknown';
      }
      continue;
    }
    const next = record.undoStatus ?? 'unknown';
    if (
      next !== row.scheduled_undo_status
      || record.id !== row.scheduled_submission_remote_id
    ) {
      await setScheduled(handlers, account.id, row.remote_id, record.id, next);
      row.scheduled_undo_status = next;
      row.scheduled_submission_remote_id = record.id;
    }
  }

  // ---- discovery of schedules created by other clients ---------------
  const trackedRemoteIds = new Set(tracked.map((row) => row.remote_id));
  const external: Array<{ emailId: string; record: SubmissionRecord }> = [];
  for (const [emailId, group] of byEmailId) {
    if (trackedRemoteIds.has(emailId)) continue;
    const pending = group.find((record) =>
      record.undoStatus === 'pending'
      && record.sendAt != null
      && Date.parse(record.sendAt) > clock.upperMs);
    if (pending) external.push({ emailId, record: pending });
  }
  let canAdoptExternal = external.length > 0;
  if (canAdoptExternal) {
    // Adopting an external schedule may also mean adopting the Scheduled
    // mailbox another client created.
    try {
      await ensureScheduledMailbox({ transport, account, handlers, useWebSocket });
    } catch (error: any) {
      wlog.warn(
        'jmap-submissions',
        `scheduled mailbox adoption failed: ${error?.message ?? error}`,
      );
      if (error?.terminal !== true) throw error;
      canAdoptExternal = false;
    }
  }
  if (canAdoptExternal) {
    const missing: string[] = [];
    for (const { emailId } of external) {
      const local = await handlers[DB_RPC.MESSAGE_GET_BY_REMOTE]({
        accountId: account.id,
        remoteId: emailId,
      });
      if (!local) missing.push(emailId);
    }
    if (missing.length > 0) {
      const limit = maxObjectsInGet(transport);
      for (let offset = 0; offset < missing.length; offset += limit) {
        const payload = await callJmap(transport, {
          using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
          methodCalls: [[
            'Email/get',
            {
              accountId: account.remote_account_id,
              ids: missing.slice(offset, offset + limit),
              properties: EMAIL_LIST_PROPERTIES,
            },
            `sube-${offset}`,
          ]],
          useWebSocket,
        });
        const emails = pickResponse(payload, 'Email/get')?.list ?? [];
        if (emails.length > 0) await persistEmails({ account, emails, handlers });
      }
    }
    for (const { emailId, record } of external) {
      // The column write keys on an existing row; an Email the fetch
      // could not produce is picked up again on the next pass.
      await setScheduled(handlers, account.id, emailId, record.id, 'pending');
    }
  }

  // ---- hand settled rows to durable operations -----------------------
  const settled = tracked.filter((row) =>
    row.scheduled_undo_status === 'final' || row.scheduled_undo_status === 'canceled');
  let unresolvedSettled = false;
  if (settled.length > 0) {
    const { sentFolderId, scheduledFolderId } = await resolveHandoffFolders(
      handlers,
      account.id,
    );
    for (const row of settled) {
      const placements: any[] = await handlers[DB_RPC.QUERY]({
        sql: `SELECT f.id AS folder_id, f.role, f.remote_id
                FROM folder_messages fm
                JOIN folders f ON f.id = fm.folder_id
               WHERE fm.message_id = ?`,
        params: [row.id],
      });
      if (row.scheduled_undo_status === 'final') {
        // Released by the server. Local resolution is the existing move
        // to Sent; the columns clear only once placement confirms it, so
        // a crash between the two repeats the idempotent move instead of
        // stranding a released message under scheduling adornments.
        const inSent = placements.some((p) => p.role === 'sent');
        const inScheduled = scheduledFolderId != null
          && placements.some((p) => Number(p.folder_id) === scheduledFolderId);
        if (inSent && !inScheduled) {
          await setScheduled(handlers, account.id, row.remote_id, null, null);
          continue;
        }
        if (sentFolderId == null || scheduledFolderId == null) {
          continue;
        }
        const moveState = await handoffMutationState(
          handlers, account.id, MUTATION_TYPE.MOVE_TO_FOLDERS, row.id,
        );
        if (moveState == null) {
          await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
            accountId: account.id,
            mutationType: MUTATION_TYPE.MOVE_TO_FOLDERS,
            targetMessageId: row.id,
            requestJson: JSON.stringify({
              messageIds: [row.id],
              addFolderIds: [sentFolderId],
              removeFolderIds: [scheduledFolderId],
            }),
            optimisticPatchJson: null,
          });
        }
        if (moveState !== 'conflicted') unresolvedSettled = true;
      } else {
        // Canceled from another client. The durable cancel operation
        // already knows how to converge this: restore Drafts + $draft,
        // then clear the columns once server and cache agree.
        const cancelState = await handoffMutationState(
          handlers, account.id, MUTATION_TYPE.CANCEL_SCHEDULED_SEND, row.id,
        );
        if (cancelState == null) {
          await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
            accountId: account.id,
            mutationType: MUTATION_TYPE.CANCEL_SCHEDULED_SEND,
            targetMessageId: row.id,
            requestJson: JSON.stringify({ messageId: row.id }),
            optimisticPatchJson: null,
          });
        }
        if (cancelState !== 'conflicted') unresolvedSettled = true;
      }
    }
  }

  await reconcileScheduledSubscription(handlers, account.id);

  const nearest: any[] = await handlers[DB_RPC.QUERY]({
    sql: `SELECT MIN(sent_at) AS at FROM messages
           WHERE account_id = ? AND scheduled_undo_status = 'pending'
             AND sent_at + ? > ?`,
    params: [
      account.id,
      SUBMISSION_RELEASE_OBSERVATION_DELAY_MS,
      clock.lowerMs,
    ],
  });
  const at = nearest?.[0]?.at;
  return {
    nearestPendingAt: at != null && Number.isFinite(Number(at)) ? Number(at) : null,
    unresolvedSettled,
  };
}
