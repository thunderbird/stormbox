import { CREATE_EMAILS_PHASE } from '../../../../../constants/states';
import { callJmap, pickResponse } from '../../invoke';
import { maxObjectsInSet } from '../../limits';
import { CACHE_REPAIR_MAX_ATTEMPTS, saveMutationCheckpoint } from '../../mutation-checkpoint';
import { JMAP_CAPS } from '../../transport';
import type { FolderProcessResult } from '../batch';
import { extractMethodError, isRetryableMessageError } from '../errors';
import { chunks } from '../jmap';
import { resolveFolderContexts } from '../resolve';
import type { FolderMutationHandlerArgs } from '../resolve';
import { ambiguousWriteCreateFailure, readAcceptedWrite } from '../write-scaffold';
import {
  fetchAndPersistCopiedEmails,
  reconcileCopiedDestinationViews,
  refreshCopiedDestinationCounters,
} from './copy-to-folders';

/**
 * One email to create, as carried in the mutation's request_json.
 * `receivedAt` is epoch milliseconds or an ISO string; `textBody` is the
 * plain-text body (the only body shape this operation produces).
 */
export interface CreateEmailSpec {
  clientId?: string;
  from: { name?: string; email: string };
  to: Array<{ name?: string; email: string }>;
  subject: string;
  receivedAt: number | string;
  keywords?: Record<string, boolean>;
  textBody: string;
}

export interface CreateEmailsRequest {
  /** Local folders.id the emails are filed into. */
  folderId: number;
  emails: CreateEmailSpec[];
}

/** Persisted in server_response_json once every create is acknowledged. */
interface CreateEmailsCheckpoint {
  version: 1;
  folderId: number;
  /** clientId → server Email id, for every acknowledged create. */
  created: Record<string, string>;
  /** clientIds whose create was rejected by the server (notCreated). */
  rejected: Record<string, any>;
  /** Local mirror attempts made so far. */
  attempts: number;
}

export const CREATE_EMAILS_ERROR = {
  OUTCOME_UNKNOWN: 'createEmailsOutcomeUnknown',
  CACHE_REPAIR_FAILED: 'createEmailsCacheRepairFailed',
} as const;

export function buildEmailCreate(spec: CreateEmailSpec, mailboxRemoteId: string) {
  const receivedAt = new Date(spec.receivedAt);
  return {
    mailboxIds: { [mailboxRemoteId]: true },
    keywords: spec.keywords ?? {},
    from: [{ name: spec.from.name ?? '', email: spec.from.email }],
    to: spec.to.map((recipient) => ({ name: recipient.name ?? '', email: recipient.email })),
    subject: spec.subject,
    receivedAt: (Number.isNaN(receivedAt.valueOf()) ? new Date() : receivedAt).toISOString(),
    bodyStructure: { type: 'text/plain', partId: 'p1' },
    bodyValues: { p1: { value: spec.textBody } },
  };
}

type CreateEmailsArgs = FolderMutationHandlerArgs & { row?: any };

function decodeCheckpoint(value: any): CreateEmailsCheckpoint | null {
  if (value?.version !== 1 || !Number.isFinite(Number(value.folderId))) return null;
  if (typeof value.created !== 'object' || value.created === null) return null;
  return {
    version: 1,
    folderId: Number(value.folderId),
    created: Object.fromEntries(
      Object.entries(value.created).filter(([, id]) => typeof id === 'string' && id),
    ) as Record<string, string>,
    rejected: typeof value.rejected === 'object' && value.rejected !== null ? value.rejected : {},
    attempts: Number.isFinite(Number(value.attempts)) ? Number(value.attempts) : 0,
  };
}

/**
 * Create emails straight into a mailbox (RFC 8621 §4.6 Email/set create).
 *
 * Email/set creates have no idempotency key, so the operation is
 * at-most-once: the row is checkpointed SUBMITTING before the call, and
 * any outcome the client cannot read (transport failure, missing
 * response slot, serverPartialFail) is terminal `createOutcomeUnknown`
 * rather than a retry. Creates the server did acknowledge are always
 * mirrored locally, even when a later chunk was lost.
 *
 * Once every chunk is acknowledged the row moves to CACHE_PENDING with
 * the created ids, and the local mirror (Email/get, query-view advance,
 * counter refresh) may be retried on its own up to
 * CACHE_REPAIR_MAX_ATTEMPTS without ever re-sending the creates.
 */
async function runCreateEmails({
  transport, handlers, request, row, useWebSocket,
}: CreateEmailsArgs): Promise<FolderProcessResult> {
  const terminal = (error: any): FolderProcessResult => ({
    ok: false,
    error: { ...error, terminal: true },
    result: { succeededIds: [], errors: { request: error } },
  });

  const applied = readAcceptedWrite(row, CREATE_EMAILS_PHASE.CACHE_PENDING, decodeCheckpoint);
  if (row?.phase === CREATE_EMAILS_PHASE.CACHE_PENDING) {
    if (!applied) {
      return ambiguousWriteCreateFailure(CREATE_EMAILS_ERROR.OUTCOME_UNKNOWN, {
        reason: 'unreadableCheckpoint',
        phase: row.phase,
      }) as FolderProcessResult;
    }
    return mirrorAcceptedCreates({
      transport, handlers, row, useWebSocket, checkpoint: applied,
    });
  }
  if (row?.phase != null) {
    // SUBMITTING (or anything else) at entry means a previous run never
    // learned the outcome; the recovery sweep parks such rows, so this
    // is only reached if one slipped through.
    return ambiguousWriteCreateFailure(CREATE_EMAILS_ERROR.OUTCOME_UNKNOWN, {
      reason: 'interrupted',
      phase: row.phase,
    }) as FolderProcessResult;
  }

  const folderId = Number(request?.folderId);
  const specs: CreateEmailSpec[] = Array.isArray(request?.emails) ? request.emails : [];
  if (!Number.isFinite(folderId)) return terminal({ type: 'unknownFolder' });
  if (specs.length === 0) return terminal({ type: 'invalidEmails' });
  const folder = (await resolveFolderContexts(handlers, [folderId])).get(folderId);
  if (!folder) return terminal({ type: 'unknownFolder' });
  const remoteAccountId = folder.remote_account_id;

  const items = specs.map((spec, index) => ({
    clientId: String(spec.clientId ?? `e${index + 1}`),
    spec,
  }));
  const created: Record<string, string> = {};
  const rejected: Record<string, any> = {};
  const methodErrors: any[] = [];
  let unknown: { clientIds: string[]; detail: any } | null = null;
  let lastResponse: any;

  await saveMutationCheckpoint({
    handlers,
    rowId: row?.id,
    phase: CREATE_EMAILS_PHASE.SUBMITTING,
    checkpoint: null,
  });

  for (const chunk of chunks(items, maxObjectsInSet(transport))) {
    let raw;
    try {
      raw = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
        methodCalls: [['Email/set', {
          accountId: remoteAccountId,
          create: Object.fromEntries(chunk.map((item) => [
            item.clientId,
            buildEmailCreate(item.spec, folder.remote_id),
          ])),
        }, 's1']],
        useWebSocket,
      });
    } catch (error: any) {
      unknown = {
        clientIds: chunk.map((item) => item.clientId),
        detail: { type: 'transport', message: error?.message ?? String(error) },
      };
      break;
    }
    lastResponse = raw;
    const response = pickResponse(raw, 'Email/set');
    if (!response) {
      const failure = extractMethodError(raw, { count: chunk.length });
      // A method-level error other than serverPartialFail means the call
      // did not run (RFC 8620 §3.6.2), so the chunk can be retried; the
      // other two leave the server state unknowable.
      if (failure.type === 'noResponse' || failure.type === 'serverPartialFail') {
        unknown = { clientIds: chunk.map((item) => item.clientId), detail: failure };
        break;
      }
      methodErrors.push(failure);
      continue;
    }
    for (const item of chunk) {
      const made = response.created?.[item.clientId];
      if (made?.id) {
        created[item.clientId] = made.id;
      } else {
        rejected[item.clientId] = {
          type: 'notCreated',
          detail: response.notCreated?.[item.clientId] ?? null,
        };
      }
    }
  }

  const succeededIds = Object.keys(created);
  if (succeededIds.length === 0 && !unknown) {
    // Nothing exists on the server: leave the row phaseless so a retry
    // starts from scratch.
    await saveMutationCheckpoint({
      handlers, rowId: row?.id, phase: null, checkpoint: null,
    });
    const errors = { ...rejected };
    methodErrors.forEach((failure, index) => { errors[`method${index + 1}`] = failure; });
    const first = Object.values(errors)[0] ?? { type: 'noResponse' };
    const retryable = Object.keys(rejected).length === 0
      && methodErrors.length > 0
      && methodErrors.every(isRetryableMessageError);
    const result = { succeededIds: [], errors, created: {} };
    return {
      ok: false,
      error: { ...first, ...(retryable ? {} : { terminal: true }), result },
      response: lastResponse,
      result,
    };
  }

  const checkpoint: CreateEmailsCheckpoint = {
    version: 1, folderId, created, rejected, attempts: 0,
  };
  if (unknown) {
    // Mirror what was acknowledged, then park: the lost chunk must never
    // be re-sent.
    if (succeededIds.length > 0) {
      await saveMutationCheckpoint({
        handlers, rowId: row?.id, phase: CREATE_EMAILS_PHASE.CACHE_PENDING, checkpoint,
      });
      await mirrorAcceptedCreates({
        transport, handlers, row, useWebSocket, checkpoint,
      });
    }
    const failure = ambiguousWriteCreateFailure(CREATE_EMAILS_ERROR.OUTCOME_UNKNOWN, {
      reason: 'responseLost',
      unknownClientIds: unknown.clientIds,
      cause: unknown.detail,
    }) as FolderProcessResult;
    failure.response = lastResponse;
    failure.result = {
      succeededIds,
      errors: {
        ...rejected,
        ...Object.fromEntries(unknown.clientIds.map((id) => [id, unknown!.detail])),
      },
      created: Object.fromEntries(succeededIds.map((id) => [id, { remoteId: created[id] }])),
    };
    return failure;
  }

  await saveMutationCheckpoint({
    handlers, rowId: row?.id, phase: CREATE_EMAILS_PHASE.CACHE_PENDING, checkpoint,
  });
  const mirrored = await mirrorAcceptedCreates({
    transport, handlers, row, useWebSocket, checkpoint,
  });
  mirrored.response = lastResponse;
  if (mirrored.ok && (Object.keys(rejected).length > 0 || methodErrors.length > 0)) {
    // Some creates were rejected outright; the accepted ones are filed,
    // so a replay would duplicate them.
    const errors = { ...rejected };
    methodErrors.forEach((failure, index) => { errors[`method${index + 1}`] = failure; });
    const result = { ...mirrored.result, errors };
    return {
      ok: false,
      error: { ...Object.values(errors)[0], terminal: true, result },
      response: lastResponse,
      result,
    };
  }
  return mirrored;
}

/**
 * Local mirror of acknowledged creates, retried as a unit. Mirrors the
 * cache-repair contract of the other checkpointed writes: retryable
 * until CACHE_REPAIR_MAX_ATTEMPTS, then terminal with `applied: true`
 * so the caller knows the server side is done.
 */
async function mirrorAcceptedCreates({
  transport, handlers, row, useWebSocket, checkpoint,
}: {
  transport: any;
  handlers: Record<string, (params: any) => Promise<any>>;
  row: any;
  useWebSocket: boolean;
  checkpoint: CreateEmailsCheckpoint;
}): Promise<FolderProcessResult> {
  const attempting = checkpoint.attempts + 1;
  await saveMutationCheckpoint({
    handlers,
    rowId: row?.id,
    phase: CREATE_EMAILS_PHASE.CACHE_PENDING,
    checkpoint: { ...checkpoint, attempts: attempting },
  });
  const succeededIds = Object.keys(checkpoint.created);
  const remoteIds = succeededIds.map((clientId) => checkpoint.created[clientId]);
  const result = {
    succeededIds,
    errors: { ...checkpoint.rejected },
    created: Object.fromEntries(
      succeededIds.map((clientId) => [clientId, { remoteId: checkpoint.created[clientId] }]),
    ),
  };
  try {
    const folder = (await resolveFolderContexts(handlers, [checkpoint.folderId]))
      .get(checkpoint.folderId);
    if (!folder) throw new Error('destination folder disappeared before the mirror ran');
    const account = { id: folder.account_id, remote_account_id: folder.remote_account_id };
    const persisted = await fetchAndPersistCopiedEmails({
      transport, account, handlers, remoteIds, useWebSocket,
    });
    const missing = Object.keys(persisted.errors ?? {});
    if (missing.length > 0) {
      throw new Error(`Email/get did not return ${missing.length} created email(s)`);
    }
    await reconcileCopiedDestinationViews({
      transport, account, handlers, destinationFolderIds: [checkpoint.folderId], useWebSocket,
    });
    await refreshCopiedDestinationCounters({
      transport, account, handlers, destinationMailboxIds: [folder.remote_id], useWebSocket,
    });
    return { ok: true, result };
  } catch (error: any) {
    const message = error?.message ?? String(error);
    return {
      ok: false,
      error: {
        type: CREATE_EMAILS_ERROR.CACHE_REPAIR_FAILED,
        protocolType: 'cacheReconcileFailed',
        message,
        ...(attempting >= CACHE_REPAIR_MAX_ATTEMPTS ? { terminal: true } : {}),
        result: { applied: true, cached: false, ids: remoteIds },
      },
      result,
    };
  }
}

export { runCreateEmails };
