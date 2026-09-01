import {
  normalizeMessageId,
  normalizeMessageIds,
} from '../../../utils/message-id';
import { callJmap, pickResponseById } from './invoke';
import { maxObjectsInGet } from './limits';
import { JMAP_CAPS } from './transport';

export type DraftRevisionProbe =
  | { outcome: 'found'; emailIds: string[]; email: any }
  | { outcome: 'absent' }
  | { outcome: 'conflict'; emailIds: string[] }
  | { outcome: 'inconclusive'; reason: string; detail?: any };

function addresses(value: unknown): Array<{ name: string; email: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((address: any) => ({
    name: String(address?.name ?? ''),
    email: String(address?.email ?? ''),
  }));
}

interface ReconciledBodyPart {
  partId: string;
  type: string | null;
  value: string;
}

function bodyPartsFor(
  email: any,
  kind: 'textBody' | 'htmlBody',
): { parts: ReconciledBodyPart[]; isComplete: boolean } {
  const parts = Array.isArray(email?.[kind]) ? email[kind] : [];
  const values: ReconciledBodyPart[] = [];
  for (const part of parts) {
    const bodyValue = email?.bodyValues?.[part?.partId];
    if (bodyValue?.isTruncated === true || bodyValue?.isEncodingProblem === true) {
      return { parts: [], isComplete: false };
    }
    if (typeof part?.partId !== 'string' || typeof bodyValue?.value !== 'string') {
      return { parts: [], isComplete: false };
    }
    values.push({
      partId: part.partId,
      type: typeof part.type === 'string' ? part.type.toLowerCase() : null,
      value: bodyValue.value,
    });
  }
  return { parts: values, isComplete: true };
}

function preparedBodyValue(preparedEmail: any, partId: string): string {
  const value = preparedEmail?.bodyValues?.[partId]?.value;
  return typeof value === 'string' ? value : '';
}

function compareSemanticEmail(
  email: any,
  preparedEmail: any,
): 'same' | 'different' | 'inconclusive' {
  if (!preparedEmail || typeof preparedEmail !== 'object') return 'different';
  const expectedText = preparedBodyValue(preparedEmail, 'p1');
  const expectedHtml = preparedBodyValue(preparedEmail, 'h1');
  const expectedHasHtml = typeof preparedEmail?.bodyValues?.h1?.value === 'string';
  const textBody = bodyPartsFor(email, 'textBody');
  const htmlBody = bodyPartsFor(email, 'htmlBody');
  if (!textBody.isComplete || !htmlBody.isComplete) {
    return 'inconclusive';
  }
  const textPartIds = new Set(textBody.parts.map((part) => part.partId));
  const semanticHtmlParts = htmlBody.parts.filter((part) =>
    part.type === 'text/html' || !textPartIds.has(part.partId));
  const same = String(email?.subject ?? '') === String(preparedEmail.subject ?? '')
    && JSON.stringify(addresses(email?.from)) === JSON.stringify(addresses(preparedEmail.from))
    && JSON.stringify(addresses(email?.to)) === JSON.stringify(addresses(preparedEmail.to))
    && JSON.stringify(addresses(email?.cc)) === JSON.stringify(addresses(preparedEmail.cc))
    && JSON.stringify(addresses(email?.bcc)) === JSON.stringify(addresses(preparedEmail.bcc))
    && textBody.parts.length === 1
    && textBody.parts[0].value === expectedText
    && semanticHtmlParts.length === (expectedHasHtml ? 1 : 0)
    && (!expectedHasHtml || semanticHtmlParts[0].value === expectedHtml);
  return same ? 'same' : 'different';
}

/**
 * Scan the complete Drafts mailbox for a revision Message-ID.
 *
 * Stalwart does not implement Email/query's header filter, so a bounded
 * "newest messages" probe cannot establish absence. Stable queryState and
 * complete paging are required before a retry is licensed (CD-4.8).
 */
export async function findDraftRevision({
  transport,
  account,
  draftsRemoteId,
  revisionMessageId,
  preparedEmail,
  useWebSocket = false,
}: {
  transport: any;
  account: any;
  draftsRemoteId: string | null;
  revisionMessageId: string;
  preparedEmail: Record<string, unknown> | null;
  useWebSocket?: boolean;
}): Promise<DraftRevisionProbe> {
  if (!draftsRemoteId || !revisionMessageId) return { outcome: 'absent' };
  const pageSize = Math.max(1, Math.min(maxObjectsInGet(transport), 500));
  const wanted = normalizeMessageId(revisionMessageId);
  const candidateIds: string[] = [];
  const seenIds = new Set<string>();
  let position = 0;
  let firstQueryState: string | null = null;
  let firstTotal: number | null = null;

  try {
    for (;;) {
      const payload = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
        methodCalls: [
          [
            'Email/query',
            {
              accountId: account.remote_account_id,
              filter: { inMailbox: draftsRemoteId },
              sort: [{ property: 'receivedAt', isAscending: false }],
              position,
              limit: pageSize,
              calculateTotal: true,
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
      const query = pickResponseById(payload, 'Email/query', 'q1');
      const got = pickResponseById(payload, 'Email/get', 'g1');
      if (!query || !got || !Array.isArray(query.ids) || !Array.isArray(got.list)) {
        return { outcome: 'inconclusive', reason: 'scanRejected' };
      }
      if (typeof query.queryState !== 'string') {
        return { outcome: 'inconclusive', reason: 'malformedQuery' };
      }
      const total = query.total;
      if (!Number.isSafeInteger(query.position)
          || query.position !== position
          || !Number.isSafeInteger(total)
          || total < 0
          || query.ids.length > pageSize
          || query.ids.some((id) => typeof id !== 'string' || !id)) {
        return { outcome: 'inconclusive', reason: 'malformedQuery' };
      }
      if (firstQueryState == null) firstQueryState = query.queryState;
      if (query.queryState !== firstQueryState) {
        return { outcome: 'inconclusive', reason: 'queryStateChanged' };
      }
      if (firstTotal == null) firstTotal = total;
      if (total !== firstTotal) {
        return { outcome: 'inconclusive', reason: 'queryTotalChanged' };
      }
      if (query.ids.some((id) => seenIds.has(id))) {
        return { outcome: 'inconclusive', reason: 'repeatedQueryPage' };
      }
      const returnedIds = got.list.map((email) => email?.id);
      const returned = new Set(returnedIds);
      if (returned.size !== returnedIds.length
          || returned.size !== query.ids.length
          || query.ids.some((id) => !returned.has(id))) {
        return { outcome: 'inconclusive', reason: 'emailGetIncomplete' };
      }
      const byId = new Map<string, any>(got.list.map((email) => [email.id, email]));
      for (const id of query.ids) {
        seenIds.add(id);
        const email = byId.get(id);
        const ids = normalizeMessageIds(email?.messageId);
        if (ids === null) return { outcome: 'inconclusive', reason: 'malformedMessageId' };
        if (ids.includes(wanted)) {
          candidateIds.push(id);
        }
      }
      position = query.position + query.ids.length;
      if (position > total) {
        return { outcome: 'inconclusive', reason: 'malformedQuery' };
      }
      if (position === total) break;
      if (query.ids.length === 0) {
        return { outcome: 'inconclusive', reason: 'truncatedQuery' };
      }
    }

    if (candidateIds.length === 0) return { outcome: 'absent' };

    const candidates: any[] = [];
    for (let offset = 0; offset < candidateIds.length; offset += pageSize) {
      const ids = candidateIds.slice(offset, offset + pageSize);
      const callId = `g2-${offset / pageSize}`;
      const payload = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
        methodCalls: [[
          'Email/get',
          {
            accountId: account.remote_account_id,
            ids,
            properties: [
              'id', 'messageId', 'mailboxIds', 'keywords', 'from', 'to', 'cc', 'bcc',
              'subject', 'textBody', 'htmlBody', 'bodyValues',
            ],
            bodyProperties: ['partId', 'type'],
            fetchTextBodyValues: true,
            fetchHTMLBodyValues: true,
            maxBodyValueBytes: 256 * 1024,
          },
          callId,
        ]],
        useWebSocket,
      });
      const got = pickResponseById(payload, 'Email/get', callId);
      if (!got || !Array.isArray(got.list)) {
        return { outcome: 'inconclusive', reason: 'candidateGetRejected' };
      }
      const returnedIds = got.list.map((email) => email?.id);
      const returned = new Set(returnedIds);
      if (returned.size !== returnedIds.length
          || returned.size !== ids.length
          || ids.some((id) => !returned.has(id))) {
        return { outcome: 'inconclusive', reason: 'candidateGetIncomplete' };
      }
      const byId = new Map<string, any>(got.list.map((email) => [email.id, email]));
      for (const id of ids) {
        const email = byId.get(id);
        const idsForEmail = normalizeMessageIds(email?.messageId);
        if (idsForEmail === null
            || !idsForEmail.includes(wanted)
            || email?.mailboxIds?.[draftsRemoteId] !== true
            || email?.keywords?.$draft !== true) {
          return { outcome: 'inconclusive', reason: 'candidateChanged' };
        }
        candidates.push(email);
      }
    }

    const comparisons = candidates.map((email) => compareSemanticEmail(email, preparedEmail));
    if (comparisons.includes('inconclusive')) {
      return { outcome: 'inconclusive', reason: 'incompleteBodyValue' };
    }
    if (comparisons.some((comparison) => comparison !== 'same')) {
      return {
        outcome: 'conflict',
        emailIds: candidates.map((email) => String(email.id)).filter(Boolean),
      };
    }
    return {
      outcome: 'found',
      emailIds: candidates.map((email) => String(email.id)),
      email: candidates[0],
    };
  } catch (error: any) {
    return {
      outcome: 'inconclusive',
      reason: error?.type ?? 'requestFailed',
      detail: {
        message: error?.message ?? String(error),
        status: error?.status,
      },
    };
  }
}
