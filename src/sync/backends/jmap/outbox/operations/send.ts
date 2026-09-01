import { MUTATION_TYPE, SEND_PHASE } from '../../../../../constants/states';
import { DB_RPC } from '../../../../../db/protocol';
import { wlog } from '../../../../../db/worker-log';
import { addressKey } from '../../../../../utils/address-key';
import { createContactUid } from '../../../../../utils/contact-uid';
import { normalizeMessageId } from '../../../../../utils/message-id';
import {
  missingRegularAttachmentIndexes,
  prepareComposeEmail,
  regularAttachmentSources,
  type ComposeRegularAttachmentSource,
} from '../../compose-email';
import { assertCanonicalAttachmentOwnership } from '../../compose-body-checkpoint';
import { callJmap, pickResponse, pickResponseById } from '../../invoke';
import { CACHE_REPAIR_MAX_ATTEMPTS } from '../../mutation-checkpoint';
import {
  newCheckpoint,
  readCheckpoint,
  readPhase,
  saveCheckpoint,
} from '../../send-checkpoint';
import { findEmailByMessageId, findSubmissionEvidence } from '../../send-reconcile';
import { requireScheduleCapability } from '../../schedule-capability';
import { computeHoldFor, scheduledSendAtOf } from '../../schedule-time';
import {
  ensureScheduledMailbox,
  readScheduledMailboxRemoteId,
  reconcileScheduledSubscription,
} from '../../scheduled-mailbox';
import { JMAP_CAPS } from '../../transport';
import {
  extractMethodError,
  extractMethodErrorById,
  isRetryableMethodError,
  isRetryableSubmissionError,
  submissionError,
} from '../errors';
import { resolveFolderRemoteIds, resolveIdentity } from '../resolve';
import { dropDraftPredecessors } from '../draft-apply';
import { fileSentCopy, markFolderViewsStale } from '../send-apply';
import { rejectedSendOutcome } from '../send-outcome';
import type { SendOutcome } from '../send-outcome';

// What the transport raises when a request never reached the server, or
// its answer never arrived (see transport.ts). Distinct from every
// server-reported error in that it carries no information about what the
// server did.
const TRANSPORT_FAILURE_TYPES = new Set([
  'httpRequestTimeout',
  'wsRequestTimeout',
  'transportAborted',
]);
/**
 * Build the explicit RFC 8621 §7 envelope recipients in header order.
 * Canonical keys de-duplicate addresses while each entry keeps the
 * first-seen addr-spec that goes on the wire.
 */
function buildEnvelopeRecipients(request: any): Array<{ email: string }> {
  const recipients: Array<{ email: string }> = [];
  const seen = new Set<string>();
  for (const recipient of [
    ...(request?.to ?? []),
    ...(request?.cc ?? []),
    ...(request?.bcc ?? []),
  ]) {
    if (typeof recipient?.email !== 'string') continue;
    const key = addressKey(recipient.email);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    recipients.push({ email: recipient.email });
  }
  return recipients;
}

async function verifySendAttachmentSources({
  transport,
  account,
  draftsRemoteId,
  draftEmailIds,
  attachments,
  useWebSocket,
}: {
  transport: any;
  account: any;
  draftsRemoteId: string | null;
  draftEmailIds: unknown;
  attachments: ComposeRegularAttachmentSource[];
  useWebSocket: boolean;
}): Promise<void> {
  if (!attachments.some((attachment) => attachment.partId != null)) return;
  const ids = Array.isArray(draftEmailIds)
    ? [...new Set(draftEmailIds.filter((id): id is string =>
      typeof id === 'string' && id.trim().length > 0))]
    : [];
  if (!draftsRemoteId || ids.length === 0) {
    const error: any = new Error('Canonical send attachment has no live draft owner');
    error.type = 'blobNotFound';
    throw error;
  }
  const payload = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
    methodCalls: [[
      'Email/get',
      {
        accountId: account.remote_account_id,
        ids,
        properties: [
          'id', 'mailboxIds', 'keywords', 'bodyStructure', 'attachments',
        ],
        bodyProperties: [
          'partId', 'blobId', 'type', 'name', 'size', 'disposition', 'cid', 'subParts',
        ],
      },
      'sa1',
    ]],
    useWebSocket,
  });
  const response = pickResponseById(payload, 'Email/get', 'sa1');
  const liveOwners = Array.isArray(response?.list)
    ? response.list.filter((email) =>
      email?.mailboxIds?.[draftsRemoteId] === true && email?.keywords?.$draft === true)
    : [];
  if (!response
      || !Array.isArray(response.list)
      || !Array.isArray(response.notFound)
      || liveOwners.length !== ids.length) {
    const error: any = new Error('Canonical send attachment owner could not be confirmed');
    error.type = 'blobNotFound';
    throw error;
  }
  assertCanonicalAttachmentOwnership(attachments, liveOwners);
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
 *     inReplyTo: [<bare msg-id>, ...], references: [...],
 *     draftsFolderId?, sentFolderId?, outboxFolderId?,
 *     scheduledAt?: <ISO UTC instant>,
 *   }
 *
 * A `scheduledAt` request is the same durable operation on a different
 * target: the Email is created directly in the real Scheduled mailbox
 * with `sentAt` set to the target instant, the submission carries an
 * RFC 4865 HOLDFOR envelope parameter, and filing/cleanup reuse the
 * normal machinery with the Scheduled mailbox in place of Sent. Every
 * checkpoint, resume, and ambiguity rule is shared.
 */
async function runSend({
  transport, account, handlers, row, request, useWebSocket,
}): Promise<SendOutcome> {
  // ---- phase 0: checkpoint ------------------------------------------
  //
  // Read before doing any work: a row parked as unknown must refuse
  // immediately, a resuming row must not repeat the blob uploads that
  // phase 1 needs, and a row past submission must not be failed over
  // preparation work its message no longer depends on — the identity
  // lookup below included.
  const rowId = row?.id ?? null;
  const resumePhase = readPhase(row);
  let checkpoint = readCheckpoint(row);
  if (row?.phase != null && resumePhase === null) {
    // Recorded progress this build cannot interpret — a phase written by a
    // newer worker, say — is the unreadable-checkpoint case (CS-1.6), not a
    // fresh row. Falling through would re-run create-and-submit against
    // work that may already sit past the submission.
    return {
      outcome: 'ambiguous',
      error: {
        type: 'outcomeUnknown',
        terminal: true,
        reason: 'unrecognizedPhase',
        description: 'This send recorded a phase this build cannot interpret.',
      },
    };
  }
  if (resumePhase === SEND_PHASE.UNKNOWN) {
    // A previous attempt could not determine whether the message was
    // sent. Guessing here is exactly what must not happen.
    return {
      outcome: 'ambiguous',
      error: {
        type: 'outcomeUnknown',
        terminal: true,
        reason: 'alreadyParked',
        description: 'A previous attempt left the outcome of this send unknown.',
      },
    };
  }
  if (resumePhase && !checkpoint) {
    // The phase says work happened but the checkpoint is unreadable, so
    // there is no way to know what to skip. Starting over could submit a
    // second time; stop instead.
    return {
      outcome: 'ambiguous',
      error: {
        type: 'outcomeUnknown',
        terminal: true,
        reason: 'unreadableCheckpoint',
        description: 'This send recorded progress but its checkpoint is unreadable.',
      },
    };
  }

  // ---- resume that owes only local filing ---------------------------
  //
  // The server has accepted this message; the one thing still missing is
  // the local Sent copy. Retrying anything else would be wrong twice
  // over: re-entering submission could deliver a second copy, and
  // failing on create-phase preparation (a since-deleted identity, a
  // stalled inline-image upload) would report a message already in
  // transit as a failed send.
  if (resumePhase === SEND_PHASE.SUBMITTED || resumePhase === SEND_PHASE.CACHE_PENDING) {
    return resumeCacheReconciliation({
      transport,
      account,
      handlers,
      useWebSocket,
      rowId,
      checkpoint,
      sentFolderId: request.sentFolderId,
      draftsFolderId: request.draftsFolderId,
      request,
    });
  }

  const identity = await resolveIdentity(handlers, account, request.identityId);
  if (!identity) {
    return { outcome: 'rejectedTerminal', error: { type: 'unknownIdentity' } };
  }
  // A SUBMITTING row is exempt: its submission may already have been
  // accepted, so it has to reach the evidence probe below rather than be
  // failed here. Rows past submission returned above, so every other
  // phase reaching this point has sent nothing.
  const rcptTo = buildEnvelopeRecipients(request);
  if (rcptTo.length === 0 && resumePhase !== SEND_PHASE.SUBMITTING) {
    const detail = {
      type: 'noRecipients',
      description: 'At least one To, Cc, or Bcc recipient is required.',
    };
    const error = submissionError('notSubmitted', detail);
    return rejectedSendOutcome(error, isRetryableSubmissionError(detail));
  }

  const folderRemoteIds = await resolveFolderRemoteIds(handlers, [
    request.draftsFolderId,
    request.sentFolderId,
    request.outboxFolderId,
  ]);
  const draftsRemoteId = folderRemoteIds[0];
  const sentRemoteId = folderRemoteIds[1];
  const outboxRemoteId = folderRemoteIds[2];

  const scheduledAt = scheduledSendAtOf(request);
  let targetBox = outboxRemoteId ?? draftsRemoteId ?? null;
  let emailCreate: any = null;
  let regularAttachments: ComposeRegularAttachmentSource[] = [];

  const onSuccessUpdate = {
    ...(sentRemoteId ? { mailboxIds: { [sentRemoteId]: true } } : {}),
    'keywords/$draft': null,
    'keywords/$seen': true,
  };

  // Creation and submission are separate round trips with a durable
  // checkpoint between them. One chained call is cheaper, but it leaves
  // no way to distinguish "nothing happened" from "already delivered"
  // when a response is lost, which is the difference between retrying
  // safely and mailing someone twice. R-4.4 was amended to allow the
  // extra round trip for exactly this reason.
  if (!checkpoint) {
    // The Message-ID is fixed here, before anything is sent, so every
    // retry of this operation carries the same one.
    checkpoint = await saveCheckpoint(
      handlers,
      rowId,
      newCheckpoint(identity.email),
      SEND_PHASE.QUEUED,
    );
  }

  // A resume that got as far as issuing the submission cannot tell from
  // the checkpoint alone whether the server accepted it. Ask the server
  // before deciding: proof that it was submitted lets the row finish
  // normally, and only genuine absence of evidence parks it.
  if (resumePhase === SEND_PHASE.SUBMITTING && !checkpoint.submissionRemoteId) {
    const evidence = await findSubmissionEvidence({
      transport,
      account,
      emailRemoteId: checkpoint.emailRemoteId,
      // A scheduled Email sits in the Scheduled mailbox from the moment
      // it is created, so its placement proves nothing about submission;
      // only a retained EmailSubmission record counts as evidence.
      sentRemoteId: scheduledAt ? null : sentRemoteId,
      useWebSocket,
    });
    if (evidence.outcome === 'submitted') {
      const recorded = await recordAcceptedSubmission({
        handlers,
        rowId,
        checkpoint,
        submissionRemoteId: evidence.submissionRemoteId ?? 'reconciled',
        account,
        request,
        allowMissing: row?.account_id == null,
      });
      if (recorded.err) {
        return {
          outcome: 'rejectedRetryable',
          error: {
            type: 'acceptanceCheckpointFailed',
            message: recorded.err?.message ?? String(recorded.err),
            result: {
              submitted: true,
              filed: false,
              createdRemoteId: checkpoint.emailRemoteId,
              submissionRemoteId: evidence.submissionRemoteId ?? 'reconciled',
            },
          },
        };
      }
      checkpoint = recorded.checkpoint;
    } else {
      await parkUnknown(handlers, rowId, checkpoint);
      return {
        outcome: 'ambiguous',
        error: {
          type: 'outcomeUnknown',
          terminal: true,
          reason: 'noEvidence',
          description: 'Interrupted while submitting, and the server shows no evidence either way.',
        },
      };
    }
  }

  // ---- phase 1: create the Email ------------------------------------
  //
  // A scheduled message is created in the real Scheduled mailbox, not
  // Outbox/Drafts. The mailbox is resolved (or created) before anything
  // irreversible happens, so a failure here simply retries; rows already
  // past the create use the settings-cached id instead and never fail on
  // this step.
  if (scheduledAt && !checkpoint.emailRemoteId) {
    try {
      targetBox = await ensureScheduledMailbox({
        transport, account, handlers, useWebSocket,
      });
    } catch (err: any) {
      const terminal = err?.terminal === true;
      return rejectedSendOutcome({
        type: err?.type ?? 'scheduledMailboxUnavailable',
        message: err?.message ?? String(err),
        ...(terminal ? { terminal: true as const, description: err?.message } : {}),
      }, !terminal);
    }
  }

  // A previous attempt may have created the Email and lost the response.
  // The Message-ID it stamped is the only handle on it, and finding it
  // avoids leaving an orphaned draft behind on every retry. Only a
  // resume needs to look: the phase is written before the create, so a
  // row that has never carried one cannot have an Email on the server.
  if (!checkpoint.emailRemoteId && resumePhase) {
    const probe = await findEmailByMessageId({
      transport,
      account,
      mailboxId: targetBox,
      messageId: checkpoint.messageId,
      useWebSocket,
    });
    if (probe.outcome === 'inconclusive') {
      // The scan did not run, so it has not ruled out a draft from an
      // earlier attempt. Creating on that basis would put a second copy
      // in the mailbox — the orphan the scan exists to prevent. Stop
      // instead: nothing has been sent, the row and its Message-ID
      // survive, and a later attempt can scan again.
      return {
        outcome: 'rejectedTerminal',
        error: {
          type: 'createProbeFailed',
          terminal: true,
          description: 'Could not check whether an earlier attempt already '
            + 'created this message.',
          detail: { reason: probe.reason, ...probe.detail },
        },
      };
    }
    if (probe.outcome === 'found') {
      checkpoint = await saveCheckpoint(
        handlers,
        rowId,
        { ...checkpoint, emailRemoteId: probe.emailRemoteId },
        SEND_PHASE.CREATED,
      );
    }
  }

  if (!checkpoint.emailRemoteId) {
    try {
      regularAttachments = regularAttachmentSources(request.attachments);
      await verifySendAttachmentSources({
        transport,
        account,
        draftsRemoteId,
        draftEmailIds: request.draftEmailIds,
        attachments: regularAttachments,
        useWebSocket,
      });
      emailCreate = await prepareComposeEmail({
        transport,
        account,
        identity,
        request,
        mailboxRemoteId: targetBox,
        isDraft: !scheduledAt && targetBox === draftsRemoteId,
      });
      if (scheduledAt) {
        // Fastmail semantics: the stored message wears its future send
        // time. sentAt becomes the RFC 5322 Date header of the created
        // Email (RFC 8621 §4.1.3), and $seen keeps the scheduled copy
        // from counting as unread mail.
        emailCreate.sentAt = scheduledAt;
        emailCreate.keywords = { $seen: true };
      }
    } catch (err: any) {
      const errorType = err?.type === 'blobNotFound' || err?.type === 'invalidAttachment'
        ? err.type
        : 'uploadFailed';
      const terminal = errorType !== 'uploadFailed'
        || TRANSPORT_FAILURE_TYPES.has(err?.type);
      const error = {
        type: errorType,
        message: err?.message ?? String(err),
        ...(errorType === 'blobNotFound' ? {
          result: {
            submitted: false,
            attachmentIndexes: regularAttachments.map((attachment) => attachment.index),
          },
        } : {}),
        ...(terminal ? { terminal: true as const } : {}),
      };
      return rejectedSendOutcome(error, !terminal);
    }
  }

  if (!checkpoint.emailRemoteId) {
    let createResult;
    try {
      createResult = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
        methodCalls: [[
          'Email/set',
          {
            accountId: account.remote_account_id,
            create: {
              c1: {
                ...emailCreate,
                // Supplying the id makes the created Email findable by it
                // later; RFC 8621 §4.6 has the server generate one only
                // when the client omits it.
                messageId: [normalizeMessageId(checkpoint.messageId)],
              },
            },
          },
          'c1',
        ]],
        useWebSocket,
      });
    } catch (err: any) {
      // Nothing was submitted by this request, and the QUEUED phase plus
      // the Message-ID probe above make a replay safe. Classified here as
      // retryable rather than allowed to escape: the runner terminals any
      // throw from a send, which would strand the row on the one failure
      // the recovery machinery exists for.
      return {
        outcome: 'rejectedRetryable',
        error: { type: err?.type ?? 'transport', message: err?.message ?? String(err) },
      };
    }
    const emailSet = pickResponseById(createResult, 'Email/set', 'c1');
    if (!emailSet) {
      // Nothing was submitted in this request, so a retry cannot
      // duplicate delivery. It can leave an orphaned draft: the
      // Message-ID is recorded so a future reconciliation pass (CS-1.8,
      // not yet implemented) can recognise one instead of creating a
      // second.
      const error = extractMethodErrorById(createResult, 'c1');
      return rejectedSendOutcome(error, isRetryableMethodError(error));
    }
    const createdId = emailSet.created?.c1?.id ?? null;
    if (!createdId) {
      const detail = emailSet.notCreated?.c1 ?? null;
      if (detail?.type === 'blobNotFound') {
        return rejectedSendOutcome({
          type: 'blobNotFound',
          detail,
          terminal: true,
          result: {
            submitted: false,
            attachmentIndexes: missingRegularAttachmentIndexes(detail, regularAttachments),
          },
        }, false);
      }
      const error = submissionError('notCreated', detail);
      return rejectedSendOutcome(error, isRetryableSubmissionError(detail));
    }
    checkpoint = await saveCheckpoint(
      handlers,
      rowId,
      { ...checkpoint, emailRemoteId: createdId },
      SEND_PHASE.CREATED,
    );
  }

  // ---- phase 2: submit ----------------------------------------------
  let result = null;
  if (!checkpoint.submissionRemoteId) {
    // HOLDFOR is a relative duration, so it is computed against a fresh
    // server clock reference immediately before each submission attempt
    // — a retry after a long outage must not replay a stale delay. Both
    // failures land before SUBMITTING is written: nothing has been
    // submitted, so a terminal answer (capability gone, target passed,
    // beyond the server limit) rewinds and destroys the phase-1 Email,
    // while a transport failure simply retries from CREATED.
    let holdFor: number | null = null;
    if (scheduledAt) {
      try {
        const { maxDelayedSend } = await requireScheduleCapability(transport, account);
        holdFor = computeHoldFor({
          targetAt: scheduledAt,
          maxDelayedSend,
          transport,
        }).holdFor;
      } catch (err: any) {
        if (err?.terminal === true) {
          const error = {
            type: err?.type ?? 'scheduleRejected',
            terminal: true as const,
            description: err?.description ?? err?.message ?? String(err),
          };
          await rewindDefinitiveSubmissionRejection({
            transport,
            account,
            handlers,
            useWebSocket,
            rowId,
            checkpoint,
            error,
          });
          return rejectedSendOutcome(error, false);
        }
        return {
          outcome: 'rejectedRetryable',
          error: { type: err?.type ?? 'transport', message: err?.message ?? String(err) },
        };
      }
    }
    // Recorded before the call, not after. Everything irreversible
    // happens inside the round trip below, so a worker that dies while it
    // is in flight must come back to a phase that says "this may already
    // have been accepted" — never to one that looks resumable.
    await saveCheckpoint(handlers, rowId, checkpoint, SEND_PHASE.SUBMITTING);
    // A throw from this call — a dead socket, a deadline — leaves exactly
    // the ambiguity the phase above was written for, so it is handled
    // like a response that omitted the submission's slot rather than
    // being allowed to escape. Letting it propagate would reach the
    // runner as a generic transport failure with no phase on it, and the
    // composer would tell the user the send failed when the server may
    // have accepted it.
    let submitFailure: { type: string; message: string } | null = null;
    try {
      result = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL, JMAP_CAPS.SUBMISSION],
        methodCalls: [[
          'EmailSubmission/set',
          {
            accountId: account.remote_account_id,
            create: {
              s1: {
                identityId: identity.remote_id,
                emailId: checkpoint.emailRemoteId,
                // RFC 8621 §§7 and 7.5: the explicit complete envelope makes
                // the server validate every recipient before submitting
                // instead of deriving it and silently skipping addresses.
                envelope: {
                  mailFrom: {
                    email: identity.email,
                    // RFC 4865 via RFC 8621 §7: envelope parameter values
                    // are strings. The server holds the message and
                    // releases it when the delay elapses.
                    ...(holdFor != null
                      ? { parameters: { HOLDFOR: String(holdFor) } }
                      : {}),
                  },
                  rcptTo,
                },
              },
            },
            // A scheduled Email already sits in its final mailbox with
            // $seen set at create time; there is nothing to move on
            // acceptance. The move-to-Sent patch is immediate-send only.
            ...(scheduledAt ? {} : { onSuccessUpdateEmail: { '#s1': onSuccessUpdate } }),
          },
          's1',
        ]],
        useWebSocket,
      });
    } catch (err: any) {
      submitFailure = {
        type: err?.type ?? 'transport',
        message: err?.message ?? String(err),
      };
      result = null;
    }

    const submission = pickResponseById(result, 'EmailSubmission/set', 's1');
    let accepted: string;
    if (!submission) {
      // An intact envelope carrying an error tuple for this call is a
      // definitive answer, not a lost one: RFC 8620 §3.6.2 has every
      // method-level error except serverPartialFail leave server state
      // unchanged, so nothing was submitted. The Email from phase 1
      // survives for a retryable type (serverUnavailable, rateLimit), while
      // a terminal type destroys it. The row rewinds to CREATED instead of
      // resuming into the crash-ambiguity path, and the server's reason is
      // surfaced rather than a false "may already have been sent".
      const methodError = submitFailure ? null : extractMethodErrorById(result, 's1');
      if (methodError
        && methodError.type !== 'noResponse'
        && methodError.type !== 'serverPartialFail') {
        await rewindDefinitiveSubmissionRejection({
          transport,
          account,
          handlers,
          useWebSocket,
          rowId,
          checkpoint,
          error: methodError,
        });
        return rejectedSendOutcome(methodError, isRetryableMethodError(methodError));
      }
      // Either the server answered without reporting this call, or there
      // was no answer at all. Ask it what happened rather than assuming:
      // the Email id is known, so both the submission record and the
      // message's own mailbox placement are available as evidence. For a
      // scheduled send the placement signal is disabled — the Email was
      // created in the Scheduled mailbox before submission.
      const evidence = await findSubmissionEvidence({
        transport,
        account,
        emailRemoteId: checkpoint.emailRemoteId,
        sentRemoteId: scheduledAt ? null : sentRemoteId,
        useWebSocket,
      });
      if (evidence.outcome !== 'submitted') {
        await parkUnknown(handlers, rowId, checkpoint);
        // Parked, so `type` says so: one string classifies every send
        // whose outcome nobody can establish, wherever it was parked from,
        // which is what the composer keys its warning off. Whatever the
        // server or the transport managed to say lands in `reason` — the
        // only diagnostic left of a response nobody saw.
        const { type: reason, ...diagnostic } = submitFailure
          ?? extractMethodErrorById(result, 's1');
        return {
          outcome: 'ambiguous',
          error: {
            ...diagnostic,
            type: 'outcomeUnknown',
            terminal: true,
            reason,
          },
        };
      }
      accepted = evidence.submissionRemoteId ?? 'reconciled';
    } else {
      const created = submission.created?.s1?.id ?? null;
      if (!created) {
        const detail = submission.notCreated?.s1
          ?? Object.values(submission.notCreated ?? {})[0]
          ?? null;
        // A notCreated is the server saying nothing was submitted, so the
        // phase must not keep claiming an in-flight submission: left at
        // SUBMITTING, the retry a rateLimit earns re-enters the
        // crash-resume branch, finds no evidence of a submission the
        // server refused, and parks the send as outcome-unknown.
        const error = submissionError('notSubmitted', detail);
        await rewindDefinitiveSubmissionRejection({
          transport,
          account,
          handlers,
          useWebSocket,
          rowId,
          checkpoint,
          error,
        });
        return rejectedSendOutcome(error, isRetryableSubmissionError(detail));
      }
      accepted = created;
    }
    // The message is out. From here a local write that fails is a filing
    // problem, never a failed send — including this one, which is the
    // write that tells a resume not to submit again.
    const recorded = await recordAcceptedSubmission({
      handlers,
      rowId,
      checkpoint,
      submissionRemoteId: accepted,
      account,
      request,
      allowMissing: row?.account_id == null,
    });
    if (recorded.err) {
      return {
        outcome: 'rejectedRetryable',
        error: {
          type: 'acceptanceCheckpointFailed',
          message: recorded.err?.message ?? String(recorded.err),
          result: {
            submitted: true,
            filed: false,
            createdRemoteId: checkpoint.emailRemoteId,
            submissionRemoteId: accepted,
          },
        },
      };
    }
    checkpoint = recorded.checkpoint;
  }
  const submissionRemoteId = checkpoint.submissionRemoteId;

  // ---- phase 3: reconcile the local cache ---------------------------
  //
  // Past this point the message has been accepted for submission and may
  // already be in transit. Everything below is repairable filing work,
  // and none of it may report a failure that sends the row back through
  // submission.
  const createdRemoteId = checkpoint.emailRemoteId;
  return reconcileSentLocally({
    transport,
    account,
    handlers,
    useWebSocket,
    rowId,
    checkpoint,
    result,
    createdRemoteId,
    submissionRemoteId,
    sentRemoteId,
    draftsRemoteId,
    request,
  });
}

/**
 * Rewind a submission the server definitively rejected.
 *
 * Retryable rejections keep the created Email and its checkpoint id at
 * CREATED so the next attempt resubmits the same object. A terminal
 * rejection proves no submission was created, so the phase-1 Email is
 * destroyed, its id cleared, and the row rewound to QUEUED (CS-1.5;
 * RFC 8620 §3.6.2). Neither cleanup failure is allowed to replace the
 * submission error the caller must surface.
 */
async function rewindDefinitiveSubmissionRejection({
  transport, account, handlers, useWebSocket, rowId, checkpoint, error,
}) {
  const terminal = error?.terminal === true;
  const emailRemoteId = checkpoint.emailRemoteId;
  if (terminal && emailRemoteId) {
    try {
      const raw = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
        methodCalls: [['Email/set', {
          accountId: account.remote_account_id,
          destroy: [emailRemoteId],
        }, 'd1']],
        useWebSocket,
      });
      const response = pickResponse(raw, 'Email/set');
      const destroyed = new Set(response?.destroyed ?? []);
      if (!response || !destroyed.has(emailRemoteId)) {
        const failure = response?.notDestroyed?.[emailRemoteId]
          ?? extractMethodError(raw);
        wlog.warn(
          'jmap-outbox',
          `terminally rejected Email not destroyed: ${
            failure?.description ?? failure?.type ?? 'server did not confirm destroy'
          }`,
        );
      }
    } catch (err: any) {
      wlog.warn(
        'jmap-outbox',
        `terminally rejected Email not destroyed: ${err?.message ?? err}`,
      );
    }
  }

  // A terminal rejection rewinds past the create as well, because the
  // Email it names no longer exists; CREATED would assert one does. If the
  // destroy above did not land, the Message-ID probe a resume runs from
  // QUEUED finds the survivor rather than creating a second copy.
  const rewound = terminal ? { ...checkpoint, emailRemoteId: null } : checkpoint;
  const phase = terminal ? SEND_PHASE.QUEUED : SEND_PHASE.CREATED;
  try {
    await saveCheckpoint(handlers, rowId, rewound, phase);
  } catch (err: any) {
    // An unrewound row probes before assuming whether submission happened.
    if (terminal) {
      wlog.warn(
        'jmap-outbox',
        `terminally rejected Email id not cleared: ${err?.message ?? err}`,
      );
    }
  }
}

/**
 * Resume a row whose recorded phase proves the submission was accepted.
 * Runs phase 3 and nothing else.
 *
 * The two remote ids are what make that possible, so a post-submission
 * phase without them is parked rather than restarted: the alternative is
 * re-entering submission on a row that may already have delivered, which
 * is the one outcome CS-1.10 rules out unconditionally. It takes a
 * partially written checkpoint to get here, so parking is a guard rather
 * than an expected path.
 */
async function resumeCacheReconciliation({
  transport, account, handlers, useWebSocket, rowId, checkpoint, sentFolderId,
  draftsFolderId, request,
}): Promise<SendOutcome> {
  if (!checkpoint.emailRemoteId || !checkpoint.submissionRemoteId) {
    await parkUnknown(handlers, rowId, checkpoint);
    return {
      outcome: 'ambiguous',
      error: {
        type: 'outcomeUnknown',
        terminal: true,
        reason: 'incompleteCheckpoint',
        description: 'This send was submitted but its record of what was sent is incomplete.',
      },
    };
  }
  const createdRemoteId = checkpoint.emailRemoteId;
  const submissionRemoteId = checkpoint.submissionRemoteId;
  try {
    const [sentRemoteId, draftsRemoteId] = await resolveFolderRemoteIds(
      handlers,
      [sentFolderId, draftsFolderId],
    );
    return await reconcileSentLocally({
      transport,
      account,
      handlers,
      useWebSocket,
      rowId,
      checkpoint,
      // No submission call was issued on this attempt, so there is no
      // implicit Email/set response to read; applySendLocally's own
      // Email/get decides where the server put the message.
      result: null,
      createdRemoteId,
      submissionRemoteId,
      sentRemoteId,
      draftsRemoteId,
      request,
    });
  } catch (err: any) {
    // Resolving the folder is local bookkeeping, but it is bookkeeping
    // for a message that has already gone out, so a failure here is
    // subject to the same rule as the filing itself.
    return postSubmissionFailure({
      handlers,
      account,
      rowId,
      checkpoint,
      createdRemoteId,
      submissionRemoteId,
      sentRemoteId: null,
      response: null,
      err,
      request,
    });
  }
}

/**
 * Phase 3: make the local cache match the server after a confirmed
 * submission.
 *
 * Wrapped so no failure in here can escape as a send failure — the
 * checkpoint write included, since that is what a resume reads. The
 * message is already in transit; reporting it as failed would tell the
 * user to press Send again, and a second press builds a new mutation row
 * with a new operation id, so the checkpoint could not stop the second
 * delivery.
 *
 * CACHE_PENDING is written before reconciling rather than after, so a
 * worker that dies mid-reconciliation leaves a row whose phase proves the
 * message was already submitted. Startup recovery reads that and finishes
 * the row instead of replaying it.
 */
async function reconcileSentLocally(args): Promise<SendOutcome> {
  const {
    transport, handlers, account, rowId, checkpoint, result, createdRemoteId,
    submissionRemoteId, sentRemoteId, draftsRemoteId, request, useWebSocket,
  } = args;
  // For a scheduled send the accepted message files into the Scheduled
  // mailbox instead of Sent; the machinery is otherwise identical. The
  // id comes from the settings cache, which any row that reached this
  // point has already populated.
  const scheduledAt = scheduledSendAtOf(request);
  let filingRemoteId = sentRemoteId;
  try {
    if (scheduledAt) {
      filingRemoteId = await readScheduledMailboxRemoteId(handlers, account.id);
    }
    const saved = rowId != null && checkpoint
      ? await saveCheckpoint(handlers, rowId, checkpoint, SEND_PHASE.CACHE_PENDING)
      : checkpoint;
    const outcome = await fileSentCopy({
      ...args,
      sentRemoteId: filingRemoteId,
      checkpoint: saved,
      afterPersist: scheduledAt
        ? async () => {
            await handlers[DB_RPC.MESSAGE_SET_SCHEDULED]({
              accountId: account.id,
              emailRemoteId: createdRemoteId,
              // A resume that proved acceptance without recovering the
              // record's id carries the 'reconciled' placeholder; the
              // synchronizer fills the real id in by emailId later.
              submissionRemoteId:
                submissionRemoteId === 'reconciled' ? null : submissionRemoteId,
              undoStatus: 'pending',
            });
            await reconcileScheduledSubscription(handlers, account.id);
          }
        : undefined,
    });
    await cleanupDraftsAfterSend({
      transport,
      account,
      handlers,
      draftsRemoteId,
      draftEmailIds: request?.draftEmailIds ?? [],
      useWebSocket,
    });
    return outcome;
  } catch (err: any) {
    return postSubmissionFailure({
      handlers,
      account,
      rowId,
      checkpoint,
      createdRemoteId,
      submissionRemoteId,
      sentRemoteId: filingRemoteId,
      response: result,
      err,
      request,
    });
  }
}

/**
 * Mark a send whose outcome nobody can establish, and do not let the
 * marking itself change the answer.
 *
 * The error the caller returns is what makes the composer warn instead of
 * inviting a second press, so a failed write here must not be allowed to
 * replace it with an ordinary transport failure. What the write buys is a
 * shorter path on the next boot: without it the row comes back at
 * `submitting`, which recovery resolves by asking the server again rather
 * than by resubmitting.
 */
async function parkUnknown(handlers, rowId, checkpoint) {
  try {
    await saveCheckpoint(handlers, rowId, checkpoint, SEND_PHASE.UNKNOWN);
  } catch (err: any) {
    wlog.warn(
      'jmap-outbox',
      `could not park a send with an unknown outcome: ${err?.message ?? err}`,
    );
  }
}

/**
 * Record that the server accepted the submission.
 *
 * This is the write that stops a resume from submitting a second time, so
 * it is made as soon as acceptance is known. It is also the last write
 * that could still be mistaken for part of the send itself: it happens
 * after the point of no return, so the caller hands a failure here to
 * `postSubmissionFailure` rather than letting it reach the runner, which
 * would classify it as an ordinary transport failure and have the
 * composer invite a second delivery.
 */
async function recordAcceptedSubmission({
  handlers, rowId, checkpoint, submissionRemoteId, account, request, allowMissing = false,
}): Promise<{ checkpoint?: any; err?: any }> {
  try {
    if (allowMissing) {
      const saved = await saveCheckpoint(
        handlers,
        rowId,
        { ...checkpoint, submissionRemoteId },
        SEND_PHASE.SUBMITTED,
      );
      return { checkpoint: saved };
    }
    const saved = await handlers[DB_RPC.SEND_ACCEPT_AND_QUEUE_TRUST]({
      accountId: account.id,
      rowId,
      checkpoint: { ...checkpoint, submissionRemoteId },
      senders: trustedRecipients(request),
    });
    return { checkpoint: saved };
  } catch (err: any) {
    return { err };
  }
}

async function cleanupDraftsAfterSend({
  transport,
  account,
  handlers,
  draftsRemoteId,
  draftEmailIds,
  useWebSocket,
}) {
  const ids = [...new Set(
    (Array.isArray(draftEmailIds) ? draftEmailIds : [])
      .filter((id) => typeof id === 'string' && id),
  )];
  if (ids.length === 0) return;
  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
    methodCalls: [[
      'Email/set',
      { accountId: account.remote_account_id, destroy: ids },
      'sd1',
    ]],
    useWebSocket,
  });
  const response = pickResponseById(result, 'Email/set', 'sd1');
  if (!response) throw new Error('Sent draft cleanup returned no Email/set response');
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
    throw new Error(`Sent draft cleanup was not confirmed for ${remaining.length} draft(s)`);
  }
}

/**
 * The canonical recipient set attached to a confirmed send.
 *
 * The DB handler commits this set's mutation with the accepted checkpoint,
 * closing the crash window between the irreversible send and its follow-up.
 */
function trustedRecipients(request): Array<{
  email: string;
  name: string | null;
  sourceSentAt: number;
  uid: string;
}> {
  const byKey = new Map<string, { email: string; name: string | null }>();
  for (const recipient of [
    ...(request?.to ?? []),
    ...(request?.cc ?? []),
    ...(request?.bcc ?? []),
  ]) {
    const email = String(recipient?.email ?? '').trim();
    const key = addressKey(email);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, { email, name: recipient?.name?.trim() || null });
  }
  const sourceSentAt = Date.now();
  return [...byKey.values()].map((recipient) => ({
    ...recipient,
    sourceSentAt,
    uid: createContactUid(),
  }));
}

/**
 * Answer for a send that the server has accepted but whose local repair
 * work failed.
 *
 * A first failure keeps the row, at `cache_pending` with both remote ids
 * recorded — the checkpoint state that makes the next attempt skip create
 * and submit and retry the filing alone. The error carries
 * `submitted: true` so the composer reports a send rather than a failure
 * however the row eventually retires.
 *
 * Once the repair budget is spent the row succeeds anyway, with the Sent
 * view flagged for rebuild, because a message that went out must not end
 * up as a conflicted row asking the user to intervene. The same applies
 * when the checkpoint cannot be written: without a durable record of the
 * attempt count a retry would never terminate, so the row retires here
 * instead.
 */
async function postSubmissionFailure({
  handlers, account, rowId, checkpoint, createdRemoteId, submissionRemoteId, sentRemoteId,
  response, err, request,
}): Promise<SendOutcome> {
  wlog.warn(
    'jmap-outbox',
    `send succeeded but local filing failed: ${err?.message ?? err}`,
  );
  const cacheAttempts = (checkpoint?.cacheAttempts ?? 0) + 1;
  if (rowId != null && checkpoint && cacheAttempts < CACHE_REPAIR_MAX_ATTEMPTS) {
    let recorded = true;
    try {
      await saveCheckpoint(
        handlers,
        rowId,
        { ...checkpoint, cacheAttempts },
        SEND_PHASE.CACHE_PENDING,
      );
    } catch (saveErr: any) {
      wlog.warn(
        'jmap-outbox',
        `could not record the filing attempt: ${saveErr?.message ?? saveErr}`,
      );
      recorded = false;
    }
    if (recorded) {
      return {
        outcome: 'rejectedRetryable',
        error: {
          type: 'cacheReconcileFailed',
          message: err?.message ?? String(err),
          result: {
            createdRemoteId,
            submissionRemoteId,
            filed: false,
            submitted: true,
          },
        },
      };
    }
  }
  if (err?.type !== 'composeBodyIncomplete') {
    await queueDraftCleanupRepair({ handlers, account, request }).catch((queueError) => {
      wlog.warn(
        'jmap-outbox',
        `could not queue sent draft cleanup: ${queueError?.message ?? queueError}`,
      );
    });
  }
  await markFolderViewsStale(handlers, account.id, sentRemoteId).catch(() => {});
  return {
    outcome: 'confirmed',
    createdRemoteId,
    submissionRemoteId,
    filed: false,
    response,
  };
}

async function queueDraftCleanupRepair({ handlers, account, request }) {
  const draftEmailIds = [...new Set(
    (Array.isArray(request?.draftEmailIds) ? request.draftEmailIds : [])
      .filter((id) => typeof id === 'string' && id),
  )];
  if (draftEmailIds.length === 0) return;
  await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
    accountId: account.id,
    mutationType: MUTATION_TYPE.DISCARD_DRAFT,
    targetMessageId: null,
    requestJson: JSON.stringify({
      draftSessionId: request.draftSessionId,
      draftsFolderId: request.draftsFolderId ?? null,
      draftEmailIds,
    }),
    optimisticPatchJson: null,
  });
}

export { runSend };
