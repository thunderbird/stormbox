/**
 * Thin EmailSubmission synchronizer for Send Later.
 *
 * Scheduled messages are ordinary cached messages in the real Scheduled
 * mailbox; the only extra state is two columns on their `messages` rows
 * (submission remote id + undo status). A message is scheduled exactly
 * while that status is `pending`; everything else is ordinary mail
 * wherever it sits. This module keeps the columns honest against the
 * server for every tracked row and for everything the Scheduled mailbox
 * holds, and hands settled schedules to existing durable operations —
 * the generic move for released sends, the cancel operation for
 * externally canceled ones. It holds no state machine of its own: every
 * pass re-reads both sides and converges.
 *
 * Stalwart 0.15.4 compatibility: filtered EmailSubmission/query
 * (undoStatus, before/after) returns unreliable results, so the one
 * portable read is an unfiltered query for ids, an explicit get, and
 * client-side filtering. The unfiltered query also lists only recent
 * sendAt values, so tracked ids it omits are read explicitly by id.
 * Do not branch by server version.
 */

import { MUTATION_TYPE } from '../../../constants/states';
import { DB_RPC } from '../../../db/protocol';
import { wlog } from '../../../db/worker-log';
import type { ScheduledUndoStatus } from '../../../types/db';
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
import { ensureScheduledMailbox } from './scheduled-mailbox';
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

type SubmissionReadArgs = Omit<SubmissionSyncArgs, 'handlers'>;

const SUBMISSION_PROPERTIES = ['id', 'emailId', 'undoStatus', 'sendAt'];

/** One row the pass reconciles, with its Scheduled placement resolved. */
interface ReconcileRow {
  id: number;
  remote_id: string;
  sent_at: number | null;
  scheduled_submission_remote_id: string | null;
  scheduled_undo_status: ScheduledUndoStatus;
  in_scheduled: number;
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
 * Validate one raw EmailSubmission object without interpreting it. An
 * undoStatus outside the RFC 8621 §7 set maps to null so callers treat
 * it conservatively instead of misreading it.
 */
function toSubmissionRecord(raw: any): SubmissionRecord | null {
  if (!raw || typeof raw.id !== 'string' || typeof raw.emailId !== 'string') return null;
  return {
    id: raw.id,
    emailId: raw.emailId,
    undoStatus:
      raw.undoStatus === 'pending'
      || raw.undoStatus === 'final'
      || raw.undoStatus === 'canceled'
        ? raw.undoStatus
        : null,
    sendAt: typeof raw.sendAt === 'string' ? raw.sendAt : null,
  };
}

/** Every retained submission the unfiltered query lists. */
export async function fetchSubmissionRecords({
  transport, account, useWebSocket = false,
}: SubmissionReadArgs): Promise<SubmissionRecord[]> {
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
              properties: SUBMISSION_PROPERTIES,
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
        const record = toSubmissionRecord(byId.get(id));
        if (!record || seen.has(id)) {
          throw new Error('EmailSubmission paging returned incomplete records');
        }
        seen.add(id);
        records.push(record);
      }
    },
  });
  if (paging.complete === false) {
    throw submissionPagingError(paging.reason);
  }
  return records;
}

/** Explicit EmailSubmission/get for known ids; absent ids are simply omitted. */
async function fetchSubmissionRecordsById(
  { transport, account, useWebSocket = false }: SubmissionReadArgs,
  ids: string[],
): Promise<SubmissionRecord[]> {
  const records: SubmissionRecord[] = [];
  const limit = maxObjectsInGet(transport);
  for (let offset = 0; offset < ids.length; offset += limit) {
    const payload = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL, JMAP_CAPS.SUBMISSION],
      methodCalls: [[
        'EmailSubmission/get',
        {
          accountId: account.remote_account_id,
          ids: ids.slice(offset, offset + limit),
          properties: SUBMISSION_PROPERTIES,
        },
        `subid-${offset}`,
      ]],
      useWebSocket,
    });
    const got = requireResponse(payload, 'EmailSubmission/get');
    if (!Array.isArray(got.list)) {
      throw new Error('EmailSubmission/get returned a malformed response');
    }
    for (const raw of got.list) {
      const record = toSubmissionRecord(raw);
      if (!record) throw new Error('EmailSubmission/get returned incomplete records');
      records.push(record);
    }
  }
  return records;
}

/**
 * The unfiltered listing plus explicit reads of any tracked submission
 * ids it omitted. A tracked id still absent afterwards is genuinely gone.
 */
export async function fetchSubmissionRecordsFor(
  args: SubmissionReadArgs,
  trackedSubmissionIds: Iterable<string | null | undefined>,
): Promise<SubmissionRecord[]> {
  const records = await fetchSubmissionRecords(args);
  const listed = new Set(records.map((record) => record.id));
  const missing = [...new Set(trackedSubmissionIds)].filter(
    (id): id is string => typeof id === 'string' && id.length > 0 && !listed.has(id),
  );
  if (missing.length === 0) return records;
  return records.concat(await fetchSubmissionRecordsById(args, missing));
}

/**
 * The record that speaks for one message. Once an id is tracked, only
 * that immutable server object is authoritative; emailId fallback covers
 * untracked rows (acceptance recovery, other clients' schedules).
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
  undoStatus: ScheduledUndoStatus,
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

/** Local folder ids the pass needs, resolved per pass. */
async function resolveHandoffFolders(
  handlers: SubmissionSyncArgs['handlers'],
  accountId: number,
): Promise<{ sentFolderId: number | null; scheduledFolderId: number | null }> {
  const rows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT id, role FROM folders
           WHERE account_id = ? AND is_deleted = 0
             AND role IN ('sent', 'scheduled')`,
    params: [accountId],
  });
  let sentFolderId: number | null = null;
  let scheduledFolderId: number | null = null;
  for (const row of rows ?? []) {
    if (row.role === 'sent') sentFolderId = Number(row.id);
    if (row.role === 'scheduled') scheduledFolderId = Number(row.id);
  }
  return { sentFolderId, scheduledFolderId };
}

/**
 * Every tracked row plus everything the local mirror of the Scheduled
 * mailbox holds. Mail another client parks there — or a released
 * message it never filed — is reconciled like any tracked row.
 */
async function loadReconcileRows(
  handlers: SubmissionSyncArgs['handlers'],
  accountId: number,
  scheduledFolderId: number | null,
): Promise<ReconcileRow[]> {
  const folderId = scheduledFolderId ?? -1;
  return handlers[DB_RPC.QUERY]({
    sql: `SELECT m.id, m.remote_id, m.sent_at, m.scheduled_submission_remote_id,
                 m.scheduled_undo_status,
                 EXISTS (SELECT 1 FROM folder_messages fm
                          WHERE fm.message_id = m.id AND fm.folder_id = ?) AS in_scheduled
            FROM messages m
           WHERE m.account_id = ?
             AND (m.scheduled_undo_status IS NOT NULL
                  OR EXISTS (SELECT 1 FROM folder_messages fm
                              WHERE fm.message_id = m.id AND fm.folder_id = ?))`,
    params: [folderId, accountId, folderId],
  });
}

async function enqueueHandoff(
  handlers: SubmissionSyncArgs['handlers'],
  accountId: number,
  mutationType: string,
  row: ReconcileRow,
  request: Record<string, unknown>,
): Promise<boolean> {
  const state = await handoffMutationState(handlers, accountId, mutationType, row.id);
  if (state == null) {
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId,
      mutationType,
      targetMessageId: row.id,
      requestJson: JSON.stringify(request),
      optimisticPatchJson: null,
    });
  }
  return state !== 'conflicted';
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
  const { sentFolderId, scheduledFolderId } = await resolveHandoffFolders(
    handlers,
    account.id,
  );
  const rows = await loadReconcileRows(handlers, account.id, scheduledFolderId);
  const records = await fetchSubmissionRecordsFor(
    { transport, account, useWebSocket },
    rows.map((row) => row.scheduled_submission_remote_id),
  );
  const byEmailId = new Map<string, SubmissionRecord[]>();
  for (const record of records) {
    const group = byEmailId.get(record.emailId) ?? [];
    group.push(record);
    byEmailId.set(record.emailId, group);
  }
  const clock = scheduleClockWindow(transport);

  // ---- per-row status from the server's records ----------------------
  for (const row of rows) {
    const record = pickRecordForRow(
      byEmailId.get(row.remote_id) ?? [],
      row.scheduled_submission_remote_id ?? null,
    );
    let nextStatus: ScheduledUndoStatus;
    let nextId: string | null;
    if (record) {
      // An unreadable status may still release, so the row stays
      // cancelable rather than guessed as settled.
      nextStatus = record.undoStatus ?? 'pending';
      nextId = record.id;
    } else if (row.scheduled_undo_status === 'pending') {
      // Not listed yet while the target is still ahead: keep waiting.
      // Past the target, RFC 8621 §7 lets the server drop the record;
      // nothing remains to cancel, so the row is ordinary mail again.
      if (row.sent_at != null && Number(row.sent_at) > clock.lowerMs) continue;
      nextStatus = null;
      nextId = null;
    } else {
      // Settled rows keep the status the server already reported;
      // untracked rows without a record stay untracked.
      continue;
    }
    if (
      nextStatus !== row.scheduled_undo_status
      || nextId !== row.scheduled_submission_remote_id
    ) {
      await setScheduled(handlers, account.id, row.remote_id, nextId, nextStatus);
      row.scheduled_undo_status = nextStatus;
      row.scheduled_submission_remote_id = nextId;
    }
  }

  // ---- discovery of schedules created by other clients ---------------
  const reconciledRemoteIds = new Set(rows.map((row) => row.remote_id));
  const external: Array<{ emailId: string; record: SubmissionRecord }> = [];
  for (const [emailId, group] of byEmailId) {
    if (reconciledRemoteIds.has(emailId)) continue;
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
  let unresolvedSettled = false;
  for (const row of rows) {
    if (row.scheduled_undo_status !== 'final' && row.scheduled_undo_status !== 'canceled') {
      continue;
    }
    // Placement is only known once the Scheduled folder is cached.
    if (scheduledFolderId == null) continue;
    if (Number(row.in_scheduled) !== 1) {
      // Out of Scheduled — filed by the handoff or moved by someone else.
      // Either way the schedule is over; the message stays where it is.
      await setScheduled(handlers, account.id, row.remote_id, null, null);
      continue;
    }
    if (row.scheduled_undo_status === 'final') {
      // Released by the server: file it with the existing move. The
      // columns clear on a later pass once it has left Scheduled, so a
      // crash in between repeats the idempotent move.
      if (sentFolderId == null) continue;
      const live = await enqueueHandoff(
        handlers, account.id, MUTATION_TYPE.MOVE_TO_FOLDERS, row,
        {
          messageIds: [row.id],
          addFolderIds: [sentFolderId],
          removeFolderIds: [scheduledFolderId],
        },
      );
      if (live) unresolvedSettled = true;
    } else {
      // Canceled from another client. The durable cancel operation
      // restores Drafts + $draft and clears the columns once server and
      // cache agree.
      const live = await enqueueHandoff(
        handlers, account.id, MUTATION_TYPE.CANCEL_SCHEDULED_SEND, row,
        { messageId: row.id },
      );
      if (live) unresolvedSettled = true;
    }
  }

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
