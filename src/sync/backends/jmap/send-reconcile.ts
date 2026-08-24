/**
 * Positive reconciliation for a send whose response was lost (CS-1.8).
 *
 * The checkpoint records what the client believes; these helpers ask the
 * server what actually happened, so an interrupted send can resume
 * instead of stopping for a human. The rule throughout is that only
 * evidence resolves ambiguity: "I could not find it" never counts as
 * proof that nothing happened, because that reading is what delivers a
 * message twice.
 *
 * Two lost-response cases are covered, and they need different evidence:
 *
 *   - the create response was lost, so no Email id is known. The client
 *     Message-ID is the only handle, and it has to be matched by listing
 *     the candidate mailbox and comparing client-side: on Stalwart
 *     v0.15.4 every shape of the RFC 8621 `header` FilterCondition
 *     returns nothing, so the id cannot be filtered on server-side.
 *   - the submission response was lost, but the Email id is known. Two
 *     independent signals are consulted: a retained EmailSubmission for
 *     that Email, and the Email's own mailbox placement, since the
 *     server's onSuccessUpdateEmail moves it out of Drafts only after
 *     the submission is accepted.
 */

import { JMAP_CAPS } from './transport';
import { callJmap, pickResponse } from './invoke';

/** How many recent messages to scan when matching a Message-ID. */
const MESSAGE_ID_SCAN_LIMIT = 100;

function bareMessageId(messageId: string): string {
  return messageId.replace(/^<|>$/g, '');
}

export type EmailProbe =
  /** The scan ran and this Email carries the Message-ID. */
  | { outcome: 'found'; emailRemoteId: string }
  /** The scan ran and the mailbox holds no such Email. */
  | { outcome: 'absent' }
  /** The scan did not run, or could not be read, so it says nothing. */
  | { outcome: 'inconclusive'; reason: string; detail?: any };

/**
 * The Message-ID values of one Email, or null when they cannot be read.
 *
 * RFC 8621 specifies a list, and a server that sends something else has
 * not told us this Email is a different message — it has told us nothing
 * about it, which is not the same and must not be read as a mismatch.
 */
function messageIdsOf(email: any): string[] | null {
  const raw = email?.messageId;
  if (raw == null) return [];
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw) && raw.every((id) => typeof id === 'string')) return raw;
  return null;
}

/**
 * Look for an Email the client may have created, by the Message-ID it
 * stamped on it.
 *
 * The three outcomes are kept apart deliberately. A caller uses this to
 * decide whether to create an Email, and reading a scan that never ran
 * as `absent` is what puts a second copy in the mailbox — the module's
 * rule that only evidence resolves ambiguity applies to the failure of
 * the evidence-gathering itself.
 *
 * `absent` is bounded by MESSAGE_ID_SCAN_LIMIT: it means "not among the
 * newest N", which is sound for the case this serves, where the Email
 * would have been created moments ago.
 */
export async function findEmailByMessageId({
  transport, account, mailboxId, messageId, useWebSocket = false,
}): Promise<EmailProbe> {
  // Nothing to scan is not a failed scan: with no candidate mailbox no
  // earlier attempt could have filed an Email anywhere this one would
  // look either.
  if (!mailboxId || !messageId) return { outcome: 'absent' };
  const wanted = bareMessageId(messageId);
  try {
    const payload = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
      methodCalls: [
        [
          'Email/query',
          {
            accountId: account.remote_account_id,
            filter: { inMailbox: mailboxId },
            sort: [{ property: 'receivedAt', isAscending: false }],
            limit: MESSAGE_ID_SCAN_LIMIT,
          },
          'q1',
        ],
        [
          'Email/get',
          {
            accountId: account.remote_account_id,
            '#ids': { resultOf: 'q1', name: 'Email/query', path: '/ids' },
            properties: ['id', 'messageId'],
          },
          'g1',
        ],
      ],
      useWebSocket,
    });
    // A method-level error (RFC 8620 §3.6.2) replaces the response slot,
    // and the chained Email/get then fails its dependency. Either way the
    // scan did not happen, so an empty list would be an artefact of the
    // failure rather than a statement about the mailbox.
    const query = pickResponse(payload, 'Email/query');
    const got = pickResponse(payload, 'Email/get');
    if (!query || !got) {
      return {
        outcome: 'inconclusive',
        reason: 'scanRejected',
        detail: { methodResponses: payload?.methodResponses },
      };
    }
    if (!Array.isArray(got.list)) {
      return {
        outcome: 'inconclusive',
        reason: 'malformedResponse',
        detail: { list: got.list },
      };
    }
    let match: any = null;
    for (const email of got.list) {
      const ids = messageIdsOf(email);
      // An entry that cannot be read leaves the scan unable to say the
      // mailbox holds no such message, which is the only answer that
      // licenses creating one.
      if (ids === null) {
        return {
          outcome: 'inconclusive',
          reason: 'malformedResponse',
          detail: { emailRemoteId: email?.id ?? null },
        };
      }
      if (ids.some((id) => bareMessageId(id) === wanted)) {
        match = email;
        break;
      }
    }
    return match?.id
      ? { outcome: 'found', emailRemoteId: match.id }
      : { outcome: 'absent' };
  } catch (err: any) {
    // Either the request never produced a response — a stalled or aborted
    // HTTP leg, a WebSocket deadline, a dead socket — or reading what came
    // back failed. Both are the same thing to a caller: no evidence.
    return {
      outcome: 'inconclusive',
      reason: err?.type ?? 'requestFailed',
      detail: { message: err?.message ?? String(err) },
    };
  }
}

export type SubmissionEvidence =
  | { outcome: 'submitted'; submissionRemoteId: string | null }
  | { outcome: 'unknown' };

/**
 * Decide whether an Email whose submission response was lost was in fact
 * submitted.
 *
 * Absence of a retained EmailSubmission proves nothing: RFC 8621 §7 lets
 * a server destroy successful records, and Stalwart keeps them only
 * briefly. So a negative here falls through to the mailbox check rather
 * than concluding failure.
 *
 * Never throws. Callers ask this precisely when a request has already
 * failed, so the network it depends on is likely to be broken too, and a
 * throw from here would escape the send as an ordinary transport failure
 * — reported to the user as "your message did not go out" for a message
 * that may be in transit. A request that fails is simply not evidence.
 */
export async function findSubmissionEvidence({
  transport, account, emailRemoteId, sentRemoteId, useWebSocket = false,
}): Promise<SubmissionEvidence> {
  if (!emailRemoteId) return { outcome: 'unknown' };

  // Signal 1: a submission record still referencing this Email.
  try {
    const payload = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL, JMAP_CAPS.SUBMISSION],
      methodCalls: [[
        'EmailSubmission/query',
        {
          accountId: account.remote_account_id,
          filter: { emailIds: [emailRemoteId] },
          limit: 1,
        },
        'q1',
      ]],
      useWebSocket,
    });
    const ids = pickResponse(payload, 'EmailSubmission/query')?.ids ?? [];
    if (ids.length > 0) {
      return { outcome: 'submitted', submissionRemoteId: ids[0] };
    }
  } catch {
    // A server that cannot filter submissions this way tells us nothing
    // either way; fall through to the mailbox signal.
  }

  // Signal 2: the server's own onSuccessUpdateEmail. It runs only after
  // the submission is accepted, so finding the message filed in Sent
  // without its draft flag is proof the submission happened.
  if (!sentRemoteId) return { outcome: 'unknown' };
  try {
    const payload = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
      methodCalls: [[
        'Email/get',
        {
          accountId: account.remote_account_id,
          ids: [emailRemoteId],
          properties: ['id', 'mailboxIds', 'keywords'],
        },
        'g1',
      ]],
      useWebSocket,
    });
    const email = pickResponse(payload, 'Email/get')?.list?.[0];
    if (!email) return { outcome: 'unknown' };
    const inSent = email.mailboxIds?.[sentRemoteId] === true;
    const stillDraft = email.keywords?.$draft === true;
    if (inSent && !stillDraft) {
      return { outcome: 'submitted', submissionRemoteId: null };
    }
  } catch {
    // Same reasoning as above: a failed lookup is not a negative.
  }
  return { outcome: 'unknown' };
}
