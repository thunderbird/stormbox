import { callJmap, pickResponseById } from './invoke';
import { maxObjectsInGet } from './limits';
import { JMAP_CAPS } from './transport';

export type DraftRevisionProbe =
  | { outcome: 'found'; emailIds: string[]; email: any }
  | { outcome: 'absent' }
  | { outcome: 'conflict'; emailIds: string[] }
  | { outcome: 'inconclusive'; reason: string; detail?: any };

function bareMessageId(value: string): string {
  return value.replace(/^<|>$/g, '');
}

function messageIds(email: any): string[] | null {
  if (email?.messageId == null) return [];
  if (typeof email.messageId === 'string') return [email.messageId];
  return Array.isArray(email.messageId)
    && email.messageId.every((value) => typeof value === 'string')
    ? email.messageId
    : null;
}

function addresses(value: unknown): Array<{ name: string; email: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((address: any) => ({
    name: String(address?.name ?? ''),
    email: String(address?.email ?? ''),
  }));
}

function bodyValueFor(email: any, kind: 'textBody' | 'htmlBody'): string {
  const parts = Array.isArray(email?.[kind]) ? email[kind] : [];
  for (const part of parts) {
    const value = email?.bodyValues?.[part?.partId]?.value;
    if (typeof value === 'string') return value;
  }
  return '';
}

function preparedBodyValue(preparedEmail: any, partId: string): string {
  const value = preparedEmail?.bodyValues?.[partId]?.value;
  return typeof value === 'string' ? value : '';
}

function sameSemanticEmail(email: any, preparedEmail: any): boolean {
  if (!preparedEmail || typeof preparedEmail !== 'object') return false;
  const expectedHtml = preparedBodyValue(preparedEmail, 'h1');
  return String(email?.subject ?? '') === String(preparedEmail.subject ?? '')
    && JSON.stringify(addresses(email?.from)) === JSON.stringify(addresses(preparedEmail.from))
    && JSON.stringify(addresses(email?.to)) === JSON.stringify(addresses(preparedEmail.to))
    && JSON.stringify(addresses(email?.cc)) === JSON.stringify(addresses(preparedEmail.cc))
    && JSON.stringify(addresses(email?.bcc)) === JSON.stringify(addresses(preparedEmail.bcc))
    && bodyValueFor(email, 'textBody') === preparedBodyValue(preparedEmail, 'p1')
    && (!expectedHtml || bodyValueFor(email, 'htmlBody') === expectedHtml);
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
  const wanted = bareMessageId(revisionMessageId);
  const candidates: any[] = [];
  let position = 0;
  let firstQueryState: string | null = null;

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
              properties: [
                'id', 'messageId', 'mailboxIds', 'keywords', 'from', 'to', 'cc', 'bcc',
                'subject', 'bodyStructure', 'textBody', 'htmlBody', 'bodyValues',
              ],
              bodyProperties: [
                'partId', 'blobId', 'size', 'name', 'type', 'charset',
                'disposition', 'cid', 'language', 'location', 'subParts',
              ],
              fetchTextBodyValues: true,
              fetchHTMLBodyValues: true,
              maxBodyValueBytes: 256 * 1024,
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
      if (typeof query.queryState !== 'string' || !Number.isFinite(Number(query.total))) {
        return { outcome: 'inconclusive', reason: 'malformedQuery' };
      }
      if (firstQueryState == null) firstQueryState = query.queryState;
      if (query.queryState !== firstQueryState) {
        return { outcome: 'inconclusive', reason: 'queryStateChanged' };
      }
      const total = Number(query.total);
      const returned = new Set(got.list.map((email) => email?.id).filter(Boolean));
      if (query.ids.some((id) => !returned.has(id))) {
        return { outcome: 'inconclusive', reason: 'emailGetIncomplete' };
      }
      for (const email of got.list) {
        const ids = messageIds(email);
        if (ids === null) return { outcome: 'inconclusive', reason: 'malformedMessageId' };
        if (ids.some((id) => bareMessageId(id) === wanted)) candidates.push(email);
      }
      position += query.ids.length;
      if (position >= total) break;
      if (query.ids.length === 0) {
        return { outcome: 'inconclusive', reason: 'truncatedQuery' };
      }
    }
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

  if (candidates.length === 0) return { outcome: 'absent' };
  const matching = candidates.filter((email) => sameSemanticEmail(email, preparedEmail));
  if (matching.length !== candidates.length || matching.length === 0) {
    return {
      outcome: 'conflict',
      emailIds: candidates.map((email) => String(email.id)).filter(Boolean),
    };
  }
  return {
    outcome: 'found',
    emailIds: matching.map((email) => String(email.id)),
    email: matching[0],
  };
}
