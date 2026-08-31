import { DRAFT_PHASE } from '../../../../../constants/states';
import { DB_RPC } from '../../../../../db/protocol';
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
import { isAuthenticationError, JMAP_CAPS } from '../../transport';
import { extractMethodErrorById, isRetryableMethodError } from '../errors';
import { dropDraftPredecessors, persistDraftSuccessor } from '../draft-apply';
import { resolveFolderRemoteIds, resolveIdentity } from '../resolve';

const RETRYABLE_DRAFT_METHOD_ERRORS = new Set([
  'noResponse',
  'rateLimit',
  'serverFail',
  'serverPartialFail',
  'serverUnavailable',
]);

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
  const authenticationFailed = error?.status === 401;
  const authorizationFailed = error?.status === 403;
  const failureType = authenticationFailed
    ? 'authenticationFailed'
    : authorizationFailed
      ? 'authorizationFailed'
      : type;
  return draftFailure(failureType, {
    message: error?.message ?? String(error),
    status: error?.status,
    ...((authenticationFailed || authorizationFailed) ? { operation: type } : {}),
  }, !isAuthenticationError(error));
}

async function reconcileDestroyedIds({
  transport,
  account,
  ids,
  useWebSocket,
}): Promise<{ conclusive: boolean; gone: string[]; existing: string[] }> {
  try {
    const result = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
      methodCalls: [[
        'Email/get',
        { accountId: account.remote_account_id, ids, properties: ['id'] },
        'dr1',
      ]],
      useWebSocket,
    });
    const response = pickResponseById(result, 'Email/get', 'dr1');
    if (!response || !Array.isArray(response.list) || !Array.isArray(response.notFound)) {
      return { conclusive: false, gone: [], existing: ids };
    }
    const existing = response.list.map((email) => email?.id).filter(Boolean);
    const gone = response.notFound.filter((id) => ids.includes(id));
    return {
      conclusive: new Set([...existing, ...gone]).size === new Set(ids).size,
      gone,
      existing,
    };
  } catch (error) {
    if (isAuthenticationError(error)) throw error;
    return { conclusive: false, gone: [], existing: ids };
  }
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
    const result = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
      methodCalls: [[
        'Email/get',
        {
          accountId: account.remote_account_id,
          ids,
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
        'db1',
      ]],
      useWebSocket,
    });
    const response = pickResponseById(result, 'Email/get', 'db1');
    if (!response || !Array.isArray(response.list) || !Array.isArray(response.notFound)) {
      return 'inconclusive';
    }
    const present = new Set(
      response.list
        .filter((email) =>
          email?.mailboxIds?.[draftsRemoteId] === true && email?.keywords?.$draft === true)
        .map((email) => email.id),
    );
    if (!ids.every((id) => present.has(id))) return 'stale';
    try {
      assertCanonicalAttachmentOwnership(attachments, response.list);
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
                messageId: [checkpoint.revisionMessageId.replace(/^<|>$/g, '')],
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
        isRetryableMethodError(error) || RETRYABLE_DRAFT_METHOD_ERRORS.has(error?.type),
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
      return draftFailure('draftCreateFailed', detail, isRetryableMethodError(detail));
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
    let result;
    try {
      result = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
        methodCalls: [[
          'Email/set',
          { accountId: account.remote_account_id, destroy: pending },
          'dd1',
        ]],
        useWebSocket,
      });
    } catch (error: any) {
      return draftTransportFailure('draftCleanupFailed', error);
    }
    const response = pickResponseById(result, 'Email/set', 'dd1');
    if (!response) {
      const methodError = extractMethodErrorById(result, 'dd1');
      if (methodError?.type === 'serverPartialFail') {
        const reconciled = await reconcileDestroyedIds({
          transport,
          account,
          ids: pending,
          useWebSocket,
        });
        if (reconciled.gone.length > 0) {
          await dropDraftPredecessors({
            transport,
            account,
            handlers,
            draftsRemoteId,
            remoteIds: reconciled.gone,
            useWebSocket,
          });
        }
        checkpoint = await saveDraftCheckpoint(
          handlers,
          rowId,
          { ...checkpoint, pendingDestroyIds: reconciled.existing },
          DRAFT_PHASE.CLEANUP_PENDING,
        );
        if (reconciled.conclusive && reconciled.existing.length === 0) {
          pending = [];
        } else {
          return draftFailure('draftCleanupFailed', methodError);
        }
      } else {
        return draftFailure('draftCleanupFailed', methodError);
      }
    }
    if (response) {
      const destroyed = new Set<string>(response.destroyed ?? []);
      const confirmed = pending.filter((id) =>
        destroyed.has(id) || response.notDestroyed?.[id]?.type === 'notFound');
      if (confirmed.length > 0) {
        await dropDraftPredecessors({
          transport,
          account,
          handlers,
          draftsRemoteId,
          remoteIds: confirmed,
          useWebSocket,
        });
      }
      pending = pending.filter((id) => !confirmed.includes(id));
      checkpoint = await saveDraftCheckpoint(
        handlers,
        rowId,
        { ...checkpoint, pendingDestroyIds: pending },
        DRAFT_PHASE.CLEANUP_PENDING,
      );
      if (pending.length > 0) {
        const detail = Object.fromEntries(
          pending.map((id) => [id, response.notDestroyed?.[id] ?? { type: 'notDestroyed' }]),
        );
        return draftFailure('draftCleanupFailed', detail);
      }
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
  if (request?.probeRevision === true) {
    const checkpoint = readDraftCheckpoint(row);
    if (!checkpoint || !draftsRemoteId) {
      return draftFailure(
        'draftDiscardProbeFailed',
        { reason: checkpoint ? 'unknownDraftsFolder' : 'unreadableCheckpoint' },
        false,
      );
    }
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
  if (ids.length === 0) {
    return { ok: true, result: { draftSessionId: request?.draftSessionId, destroyed: [] } };
  }
  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
    methodCalls: [[
      'Email/set',
      { accountId: account.remote_account_id, destroy: ids },
      'dd1',
    ]],
    useWebSocket,
  });
  const response = pickResponseById(result, 'Email/set', 'dd1');
  if (!response) {
    const methodError = extractMethodErrorById(result, 'dd1');
    if (methodError?.type !== 'serverPartialFail') {
      return draftFailure('draftDiscardFailed', methodError);
    }
    const reconciled = await reconcileDestroyedIds({
      transport,
      account,
      ids,
      useWebSocket,
    });
    if (reconciled.gone.length > 0) {
      await dropDraftPredecessors({
        transport,
        account,
        handlers,
        draftsRemoteId,
        remoteIds: reconciled.gone,
        useWebSocket,
      });
    }
    return reconciled.conclusive && reconciled.existing.length === 0
      ? {
          ok: true,
          result: { draftSessionId: request?.draftSessionId, destroyed: reconciled.gone },
        }
      : draftFailure('draftDiscardFailed', methodError);
  }
  const destroyed = new Set<string>(response.destroyed ?? []);
  const confirmed = ids.filter((id) =>
    destroyed.has(id) || response.notDestroyed?.[id]?.type === 'notFound');
  if (confirmed.length > 0) {
    await dropDraftPredecessors({
      transport,
      account,
      handlers,
      draftsRemoteId,
      remoteIds: confirmed,
      useWebSocket,
    });
  }
  const remaining = ids.filter((id) => !confirmed.includes(id));
  if (remaining.length > 0) {
    return draftFailure('draftDiscardFailed', Object.fromEntries(
      remaining.map((id) => [id, response.notDestroyed?.[id] ?? { type: 'notDestroyed' }]),
    ));
  }
  return {
    ok: true,
    response: result,
    result: { draftSessionId: request?.draftSessionId, destroyed: confirmed },
  };
}

export { runDiscardDraft, runSaveDraft };
