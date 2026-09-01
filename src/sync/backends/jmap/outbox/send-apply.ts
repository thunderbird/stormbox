import { DB_RPC } from '../../../../db/protocol';
import { JMAP_CAPS } from '../transport';
import { callJmap, pickResponse, pickResponseById } from '../invoke';
import { EMAIL_LIST_PROPERTIES, persistEmails } from '../messages';
import { fetchAndCheckpointComposeBody } from '../compose-body-checkpoint';
import {
  regularAttachmentSources,
  type ComposeRegularAttachmentSource,
} from '../compose-email';
import { reconcileMailboxWindow } from './mailbox-window-reconcile';
import type { SendOutcome } from './send-outcome';

async function fileSentCopy({
  transport, account, handlers, useWebSocket,
  result, createdRemoteId, submissionRemoteId, sentRemoteId, request, afterPersist,
}): Promise<SendOutcome> {
  // onSuccessUpdateEmail generates a second, implicit Email/set response
  // under the submission's call id (RFC 8621 §7.5). When that patch
  // fails the message stayed in Drafts/Outbox on the server, so the
  // local cache must not claim it is filed in Sent either. On a resume
  // this attempt issued no submission call, so there is no such response
  // to read and applySendLocally's own Email/get decides.
  const implicitUpdate = result ? pickResponseById(result, 'Email/set', 's1') : null;
  const filingRejected = Boolean(
    createdRemoteId && implicitUpdate?.notUpdated?.[createdRemoteId],
  );

  // Mirror the server-side onSuccessUpdateEmail in the local cache
  // before resolving so listMessagesForView reads of Sent see the new
  // row immediately. Skipping this would leave the row visible only
  // after the JMAP push channel delivers the StateChange and
  // syncEmailChanges runs, which the constitution forbids.
  const applied = await applySendLocally({
    transport,
    account,
    handlers,
    useWebSocket,
    createdRemoteId,
    sentRemoteId,
    expectedRegularAttachments: request?.scheduledAt
      ? []
      : regularAttachmentSources(request?.attachments),
    afterPersist,
  });

  if (!applied.filed || filingRejected) {
    // The message went out but the local Sent view does not reflect it.
    // Mark the view stale so the next read rebuilds from the server
    // rather than leaving the user with a cache that silently disagrees.
    await markFolderViewsStale(handlers, account.id, sentRemoteId);
  }

  return {
    outcome: 'confirmed',
    createdRemoteId,
    submissionRemoteId,
    // Filing is reported separately from sending so a caller can tell
    // "delivered but not yet in Sent" from "delivered and filed".
    filed: applied.filed && !filingRejected,
    response: result,
  };
}

/**
 * Flag every open mailbox-window view for a folder as stale so the next
 * read rebuilds it from the server. Used when a send succeeded but its
 * local filing did not, which is the one case where the cache is known
 * to disagree with the server and cannot be repaired in place.
 */
async function markFolderViewsStale(handlers, accountId, folderRemoteId) {
  if (!folderRemoteId) return;
  await handlers[DB_RPC.QUERY]({
    sql: `UPDATE query_views
             SET stale = 1, updated_at = ?
           WHERE account_id = ?
             AND view_type = 'mailbox-window'
             AND folder_id IN (
               SELECT id FROM folders WHERE account_id = ? AND remote_id = ?
             )`,
    params: [Date.now(), accountId, accountId, folderRemoteId],
  });
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
 * The query_view insert is gated on the server actually reporting the
 * message in Sent. Inserting on the strength of the *requested* target
 * is how a message that never left can appear in the user's Sent list —
 * the same defect as Thunderbird bug 1656240, where an SMTP timeout
 * still produced a Sent copy and left the user unable to tell what had
 * gone out.
 *
 * sentRemoteId is the JMAP mailbox id of Sent. With no sentRemoteId
 * we still persist the message but skip the query_view update; the
 * next folder visit will rebuild the window from the server.
 *
 * Returns { filed } so the caller can distinguish "sent and filed in
 * Sent" from "sent, filing still pending".
 *
 * Exported so the unit tests in tests/unit/sync/outbox-effects.test.ts
 * can drive it directly without spinning up a full SEND row.
 */
export async function applySendLocally({
  transport, account, handlers, useWebSocket = false,
  createdRemoteId, sentRemoteId, expectedRegularAttachments = [], afterPersist,
}: {
  transport: any;
  account: any;
  handlers: Record<string, (params: any) => Promise<any>>;
  useWebSocket?: boolean;
  createdRemoteId: string | null;
  sentRemoteId: string | null;
  expectedRegularAttachments?: ComposeRegularAttachmentSource[];
  afterPersist?: () => Promise<void>;
}): Promise<{ filed: boolean }> {
  if (!createdRemoteId) return { filed: false };
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
  if (!email) return { filed: false };

  await persistEmails({ account, emails: [email], handlers });
  await afterPersist?.();
  if (expectedRegularAttachments.length > 0) {
    await fetchAndCheckpointComposeBody({
      transport,
      account,
      handlers,
      remoteId: createdRemoteId,
      expectedRegularAttachments,
      useWebSocket,
    });
  }

  if (!sentRemoteId) return { filed: false };
  // Trust the server's mailboxIds, not the target we asked for.
  if (email.mailboxIds?.[sentRemoteId] !== true) {
    return { filed: false };
  }
  const folderFound = await reconcileMailboxWindow({
    transport,
    account,
    handlers,
    mailboxRemoteId: sentRemoteId,
    insertedId: createdRemoteId,
    acceptEmptyFilter: false,
    requestFailurePolicy: 'markViewsStale',
    useWebSocket,
  });
  return { filed: folderFound };
}

export { fileSentCopy, markFolderViewsStale };
