import { DRAFT_PHASE } from '../../../../../constants/states';
import { DB_RPC } from '../../../../../db/protocol';
import { normalizeMessageId } from '../../../../../utils/message-id';
import {
  missingRegularAttachmentIndexes,
  prepareComposeEmail,
  regularAttachmentSources,
  type ComposeRegularAttachmentSource,
} from '../../compose-email';
import { assertCanonicalAttachmentOwnership } from '../../compose-body-checkpoint';
import {
  draftCheckpointConflictReason,
  isDraftEmailId,
  newDraftCheckpoint,
  readDraftCheckpoint,
  readDraftPhase,
  saveDraftCheckpoint,
} from '../../draft-checkpoint';
import { findDraftRevision } from '../../draft-reconcile';
import { callJmap, pickResponseById } from '../../invoke';
import { maxObjectsInGet } from '../../limits';
import {
  readMutationCheckpoint,
  saveMutationCheckpoint,
} from '../../mutation-checkpoint';
import {
  classifyAuthenticationOrAuthorizationError,
  isAuthenticationError,
  JMAP_CAPS,
} from '../../transport';
import {
  destroyDraftEmails,
  persistDraftSuccessor,
} from '../draft-apply';
import { extractMethodErrorById, isRetryableDraftError } from '../errors';
import { resolveFolderRemoteIds, resolveIdentity } from '../resolve';

function draftFailure(type: string, detail: any, retryable = true, result?: any) {
  return {
    ok: false,
    error: {
      type,
      detail,
      ...(result != null ? { result } : {}),
      ...(!retryable ? { terminal: true } : {}),
    },
  };
}

function draftTransportFailure(type: string, error: any) {
  const authentication = classifyAuthenticationOrAuthorizationError(error);
  const failureType = authentication?.type ?? type;
  return draftFailure(failureType, {
    message: error?.message ?? String(error),
    status: error?.status,
    ...(authentication ? { operation: type } : {}),
  }, authentication?.retryable ?? true);
}

interface DiscardDraftCheckpoint {
  version: 1;
  pendingDestroyIds: string[];
  destroyedIds: string[];
}

function exactDraftIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every(isDraftEmailId)) return null;
  const ids = value as string[];
  return new Set(ids).size === ids.length ? [...ids] : null;
}

function readDiscardDraftCheckpoint(row: any) {
  return readMutationCheckpoint<DiscardDraftCheckpoint>(row, (parsed: any) => {
    if (!parsed || parsed.version !== 1) return null;
    const pendingDestroyIds = exactDraftIds(parsed.pendingDestroyIds);
    const destroyedIds = exactDraftIds(parsed.destroyedIds);
    if (!pendingDestroyIds || !destroyedIds) return null;
    const destroyed = new Set(destroyedIds);
    if (pendingDestroyIds.some((id) => destroyed.has(id))) return null;
    return { version: 1, pendingDestroyIds, destroyedIds };
  });
}

async function saveDiscardDraftCheckpoint({
  handlers,
  rowId,
  checkpoint,
}: {
  handlers: Record<string, (params: any) => Promise<any>>;
  rowId: number | null;
  checkpoint: DiscardDraftCheckpoint;
}): Promise<DiscardDraftCheckpoint> {
  if (rowId == null) return checkpoint;
  await saveMutationCheckpoint({
    handlers,
    rowId,
    phase: null,
    checkpoint,
  });
  return checkpoint;
}

async function verifyDraftBases({
  transport,
  account,
  draftsRemoteId,
  ids,
  attachments,
  useWebSocket,
}: {
  transport: any;
  account: any;
  draftsRemoteId: string;
  ids: string[];
  attachments: ComposeRegularAttachmentSource[];
  useWebSocket: boolean;
}): Promise<'present' | 'stale' | 'attachment-missing' | 'inconclusive'> {
  if (ids.length === 0) {
    return attachments.some((attachment) => attachment.partId != null)
      ? 'attachment-missing'
      : 'present';
  }
  try {
    const needsBodyParts = attachments.some((attachment) => attachment.partId != null);
    const emails: any[] = [];
    const getLimit = maxObjectsInGet(transport);
    for (let offset = 0; offset < ids.length; offset += getLimit) {
      const chunk = ids.slice(offset, offset + getLimit);
      const callId = `draft-base-${offset / getLimit}`;
      const result = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
        methodCalls: [[
          'Email/get',
          {
            accountId: account.remote_account_id,
            ids: chunk,
            properties: [
              'id', 'mailboxIds', 'keywords',
              ...(needsBodyParts ? ['bodyStructure', 'attachments'] : []),
            ],
            ...(needsBodyParts ? {
              bodyProperties: [
                'partId', 'blobId', 'type', 'name', 'size', 'disposition', 'cid', 'subParts',
              ],
            } : {}),
          },
          callId,
        ]],
        useWebSocket,
      });
      const response = pickResponseById(result, 'Email/get', callId);
      if (!response || !Array.isArray(response.list) || !Array.isArray(response.notFound)) {
        const methodError = extractMethodErrorById(result, callId);
        if (isAuthenticationError(methodError)) throw methodError;
        return 'inconclusive';
      }
      const observedIds = [
        ...response.list.map((email) => email?.id),
        ...response.notFound,
      ];
      const requested = new Set(chunk);
      if (
        observedIds.some((id) => typeof id !== 'string' || !requested.has(id))
        || new Set(observedIds).size !== observedIds.length
        || new Set(observedIds).size !== requested.size
      ) {
        return 'inconclusive';
      }
      emails.push(...response.list);
    }
    const present = new Set(
      emails
        .filter((email) =>
          email?.mailboxIds?.[draftsRemoteId] === true && email?.keywords?.$draft === true)
        .map((email) => email.id),
    );
    if (!ids.every((id) => present.has(id))) return 'stale';
    try {
      assertCanonicalAttachmentOwnership(attachments, emails);
    } catch (error: any) {
      return error?.type === 'blobNotFound' ? 'attachment-missing' : 'inconclusive';
    }
    return 'present';
  } catch (error) {
    if (isAuthenticationError(error)) throw error;
    return 'inconclusive';
  }
}

async function runSaveDraft({
  transport, account, handlers, row, request, useWebSocket,
}) {
  const rowId = row?.id ?? null;
  const recordedPhase = readDraftPhase(row);
  let checkpoint = readDraftCheckpoint(row);
  if (row?.phase != null && !recordedPhase) {
    return draftFailure('draftCheckpointConflict', { reason: 'unrecognizedPhase' }, false);
  }
  if (row?.phase == null && row?.server_response_json != null) {
    return draftFailure('draftCheckpointConflict', { reason: 'checkpointWithoutPhase' }, false);
  }
  if (recordedPhase === DRAFT_PHASE.CONFLICT) {
    return draftFailure('draftCheckpointConflict', { reason: 'alreadyConflicted' }, false);
  }
  if (recordedPhase && !checkpoint) {
    return draftFailure('draftCheckpointConflict', { reason: 'unreadableCheckpoint' }, false);
  }
  if (recordedPhase && checkpoint) {
    const reason = draftCheckpointConflictReason(checkpoint, recordedPhase);
    if (reason) {
      return draftFailure('draftCheckpointConflict', { reason }, false);
    }
  }

  const identity = await resolveIdentity(handlers, account, request.identityId);
  if (!identity) return draftFailure('unknownIdentity', null, false);
  const draftsRemoteId = (await resolveFolderRemoteIds(
    handlers,
    [request.draftsFolderId],
  ))[0] ?? null;
  if (!draftsRemoteId) return draftFailure('unknownFolder', { role: 'drafts' }, false);
  let regularAttachments: ComposeRegularAttachmentSource[];
  try {
    regularAttachments = regularAttachmentSources(request.attachments);
  } catch (error: any) {
    return draftFailure(
      error?.type ?? 'invalidAttachment',
      { message: error?.message ?? String(error) },
      false,
    );
  }
  const shouldProbe = recordedPhase === DRAFT_PHASE.QUEUED;

  if (!checkpoint) {
    checkpoint = newDraftCheckpoint(request, identity.email);
    const baseStatus = await verifyDraftBases({
      transport,
      account,
      draftsRemoteId,
      ids: checkpoint.baseEmailIds,
      attachments: regularAttachments,
      useWebSocket,
    });
    if (baseStatus === 'inconclusive') {
      return draftFailure('draftBaseCheckFailed', null);
    }
    if (baseStatus === 'stale') {
      await saveDraftCheckpoint(handlers, rowId, checkpoint, DRAFT_PHASE.CONFLICT);
      return draftFailure('draftRevisionConflict', { reason: 'staleBase' }, false);
    }
    if (baseStatus === 'attachment-missing') {
      return draftFailure(
        'blobNotFound',
        { reason: 'canonicalAttachmentOwnerMissing' },
        false,
        { attachmentIndexes: regularAttachments.map((attachment) => attachment.index) },
      );
    }
    let preparedEmail;
    try {
      preparedEmail = await prepareComposeEmail({
        transport,
        account,
        identity,
        request,
        mailboxRemoteId: draftsRemoteId,
        isDraft: true,
      });
    } catch (error: any) {
      return draftTransportFailure('draftPreparationFailed', error);
    }
    checkpoint = await saveDraftCheckpoint(
      handlers,
      rowId,
      { ...checkpoint, preparedEmail },
      DRAFT_PHASE.QUEUED,
    );
  }

  if (!checkpoint.newEmailId && shouldProbe) {
    const probe = await findDraftRevision({
      transport,
      account,
      draftsRemoteId,
      revisionMessageId: checkpoint.revisionMessageId,
      preparedEmail: checkpoint.preparedEmail,
      useWebSocket,
    });
    if (probe.outcome === 'inconclusive') {
      if (isAuthenticationError(probe.detail)) {
        return draftTransportFailure('draftRevisionProbeFailed', probe.detail);
      }
      return draftFailure('draftCreateAmbiguous', probe);
    }
    if (probe.outcome === 'conflict') {
      await saveDraftCheckpoint(handlers, rowId, checkpoint, DRAFT_PHASE.CONFLICT);
      return draftFailure('draftRevisionConflict', probe, false);
    }
    if (probe.outcome === 'found') {
      const [newEmailId, ...duplicateIds] = probe.emailIds;
      if (!isDraftEmailId(newEmailId)) {
        return draftFailure(
          'draftRevisionProbeFailed',
          { reason: 'invalidSuccessorId' },
          false,
        );
      }
      checkpoint = await saveDraftCheckpoint(
        handlers,
        rowId,
        {
          ...checkpoint,
          newEmailId,
          pendingDestroyIds: [...new Set([
            ...checkpoint.pendingDestroyIds,
            ...duplicateIds,
          ])].filter((id) => id !== newEmailId),
        },
        DRAFT_PHASE.CREATED,
      );
    } else {
      const baseStatus = await verifyDraftBases({
        transport,
        account,
        draftsRemoteId,
        ids: checkpoint.baseEmailIds,
        attachments: regularAttachments,
        useWebSocket,
      });
      if (baseStatus === 'inconclusive') {
        return draftFailure('draftBaseCheckFailed', null);
      }
      if (baseStatus === 'stale') {
        await saveDraftCheckpoint(handlers, rowId, checkpoint, DRAFT_PHASE.CONFLICT);
        return draftFailure('draftRevisionConflict', { reason: 'staleBase' }, false);
      }
      if (baseStatus === 'attachment-missing') {
        return draftFailure(
          'blobNotFound',
          { reason: 'canonicalAttachmentOwnerMissing' },
          false,
          { attachmentIndexes: regularAttachments.map((attachment) => attachment.index) },
        );
      }
    }
  }

  const phaseMayCreate = recordedPhase == null || recordedPhase === DRAFT_PHASE.QUEUED;
  if (!checkpoint.newEmailId && !phaseMayCreate) {
    return draftFailure(
      'draftCheckpointConflict',
      { reason: 'createNotAllowedForPhase' },
      false,
    );
  }
  if (!checkpoint.newEmailId) {
    let result;
    try {
      result = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
        methodCalls: [[
          'Email/set',
          {
            accountId: account.remote_account_id,
            create: {
              draft: {
                ...checkpoint.preparedEmail,
                messageId: [normalizeMessageId(checkpoint.revisionMessageId)],
              },
            },
          },
          'dc1',
        ]],
        useWebSocket,
      });
    } catch (error: any) {
      return draftTransportFailure('draftCreateAmbiguous', error);
    }
    const response = pickResponseById(result, 'Email/set', 'dc1');
    if (!response) {
      const error = extractMethodErrorById(result, 'dc1');
      return draftFailure(
        'draftCreateFailed',
        error,
        isRetryableDraftError(error),
      );
    }
    const newEmailId = response.created?.draft?.id;
    if (!isDraftEmailId(newEmailId)) {
      const detail = response.notCreated?.draft ?? { type: 'notCreated' };
      if (detail?.type === 'blobNotFound') {
        return draftFailure(
          'blobNotFound',
          detail,
          false,
          { attachmentIndexes: missingRegularAttachmentIndexes(detail, regularAttachments) },
        );
      }
      return draftFailure('draftCreateFailed', detail, isRetryableDraftError(detail));
    }
    checkpoint = await saveDraftCheckpoint(
      handlers,
      rowId,
      { ...checkpoint, newEmailId },
      DRAFT_PHASE.CREATED,
    );
  }

  if (recordedPhase !== DRAFT_PHASE.CACHE_PENDING
      && recordedPhase !== DRAFT_PHASE.CLEANUP_PENDING) {
    try {
      const applied = await persistDraftSuccessor({
        transport,
        account,
        handlers,
        draftsRemoteId,
        successorId: checkpoint.newEmailId,
        expectedBodyStructure: checkpoint.preparedEmail?.bodyStructure,
        expectedBodyValues: (
          checkpoint.preparedEmail?.bodyValues ?? {}
        ) as Record<string, any>,
        expectedRegularAttachments: regularAttachments,
        useWebSocket,
      });
      checkpoint = await saveDraftCheckpoint(
        handlers,
        rowId,
        { ...checkpoint, localMessageId: applied.localMessageId },
        DRAFT_PHASE.CACHE_PENDING,
      );
    } catch (error: any) {
      return draftTransportFailure('draftCacheReconcileFailed', error);
    }
  }

  let pending = checkpoint.pendingDestroyIds.filter((id) => id !== checkpoint.newEmailId);
  if (pending.length > 0) {
    checkpoint = await saveDraftCheckpoint(
      handlers,
      rowId,
      { ...checkpoint, pendingDestroyIds: pending },
      DRAFT_PHASE.CLEANUP_PENDING,
    );
    let cleanup;
    try {
      cleanup = await destroyDraftEmails({
        transport,
        account,
        handlers,
        draftsRemoteId,
        remoteIds: pending,
        useWebSocket,
        onProgress: async ({ remainingIds }) => {
          pending = remainingIds;
          checkpoint = await saveDraftCheckpoint(
            handlers,
            rowId,
            { ...checkpoint, pendingDestroyIds: pending },
            DRAFT_PHASE.CLEANUP_PENDING,
          );
        },
      });
    } catch (error: any) {
      return draftTransportFailure('draftCleanupFailed', error);
    }
    if (cleanup.ok === false) {
      return draftFailure('draftCleanupFailed', cleanup.error);
    }
  }

  const successorBody = checkpoint.localMessageId != null
    ? await handlers[DB_RPC.MESSAGE_BODY_READ]({ messageId: checkpoint.localMessageId })
    : null;
  return {
    ok: true,
    response: null,
    result: {
      draftSessionId: checkpoint.draftSessionId,
      revision: checkpoint.revision,
      emailId: checkpoint.newEmailId,
      localMessageId: checkpoint.localMessageId,
      messageId: checkpoint.revisionMessageId,
      payloadHash: checkpoint.payloadHash,
      attachments: successorBody?.attachments ?? [],
    },
  };
}

async function runDiscardDraft({
  transport, account, handlers, row, request, useWebSocket,
}) {
  const rowId = row?.id ?? null;
  const inputIds: unknown[] = Array.isArray(request?.draftEmailIds)
    ? request.draftEmailIds
    : [];
  let ids = [...new Set<string>(
    inputIds.filter(isDraftEmailId),
  )];
  const draftsRemoteId = (await resolveFolderRemoteIds(
    handlers,
    [request.draftsFolderId],
  ))[0] ?? null;
  const checkpointRead = readDiscardDraftCheckpoint(row);
  let checkpoint = checkpointRead.status === 'valid'
    ? checkpointRead.checkpoint
    : null;
  if (!checkpoint && checkpointRead.status === 'invalid' && request?.probeRevision !== true) {
    return draftFailure(
      'draftDiscardCheckpointConflict',
      { reason: 'unreadableCheckpoint' },
      false,
    );
  }
  if (!checkpoint && request?.probeRevision === true) {
    const draftCheckpoint = readDraftCheckpoint(row);
    if (!draftCheckpoint || !draftsRemoteId) {
      return draftFailure(
        'draftDiscardProbeFailed',
        { reason: draftCheckpoint ? 'unknownDraftsFolder' : 'unreadableCheckpoint' },
        false,
      );
    }
    const probe = await findDraftRevision({
      transport,
      account,
      draftsRemoteId,
      revisionMessageId: draftCheckpoint.revisionMessageId,
      preparedEmail: draftCheckpoint.preparedEmail,
      useWebSocket,
    });
    if (probe.outcome === 'inconclusive') {
      if (isAuthenticationError(probe.detail)) {
        return draftTransportFailure('draftDiscardProbeFailed', probe.detail);
      }
      return draftFailure('draftDiscardProbeFailed', probe);
    }
    if (probe.outcome === 'conflict') {
      return draftFailure('draftDiscardProbeConflict', probe, false);
    }
    if (probe.outcome === 'found') {
      ids = [...new Set([...ids, ...probe.emailIds.filter(isDraftEmailId)])];
    }
  }
  if (!checkpoint) {
    checkpoint = await saveDiscardDraftCheckpoint({
      handlers,
      rowId,
      checkpoint: {
        version: 1,
        pendingDestroyIds: ids,
        destroyedIds: [],
      },
    });
  }
  if (checkpoint.pendingDestroyIds.length === 0) {
    return {
      ok: true,
      result: {
        draftSessionId: request?.draftSessionId,
        destroyed: checkpoint.destroyedIds,
      },
    };
  }
  let durableCheckpoint: DiscardDraftCheckpoint = checkpoint;
  let cleanup;
  try {
    cleanup = await destroyDraftEmails({
      transport,
      account,
      handlers,
      draftsRemoteId,
      remoteIds: durableCheckpoint.pendingDestroyIds,
      useWebSocket,
      onProgress: async ({ confirmedIds, remainingIds }) => {
        durableCheckpoint = await saveDiscardDraftCheckpoint({
          handlers,
          rowId,
          checkpoint: {
            ...durableCheckpoint,
            pendingDestroyIds: remainingIds,
            destroyedIds: [...new Set([
              ...durableCheckpoint.destroyedIds,
              ...confirmedIds,
            ])],
          },
        });
      },
    });
  } catch (error: any) {
    return draftTransportFailure('draftDiscardFailed', error);
  }
  if (cleanup.ok === false) {
    return draftFailure('draftDiscardFailed', cleanup.error);
  }
  return {
    ok: true,
    response: cleanup.response,
    result: {
      draftSessionId: request?.draftSessionId,
      destroyed: durableCheckpoint.destroyedIds,
    },
  };
}

export { runDiscardDraft, runSaveDraft };
