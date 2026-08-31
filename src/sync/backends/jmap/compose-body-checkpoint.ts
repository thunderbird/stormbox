import { DB_RPC } from '../../../db/protocol';
import type { BodyAttachmentRow } from '../../../types';
import { fetchEmailBodies } from './bodies';
import type { ComposeRegularAttachmentSource } from './compose-email';

function checkpointError(message: string, type = 'composeBodyIncomplete'): Error {
  const error: any = new Error(message);
  error.type = type;
  return error;
}

function rethrowCheckpointError(error: any): never {
  if (error?.type === 'composeBodyIncomplete') throw error;
  const wrapped: any = checkpointError(error?.message ?? String(error));
  wrapped.cause = error;
  throw wrapped;
}

function isHandle(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.trim() === value
    && ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    });
}

function normalizedType(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function normalizedCid(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.replace(/^<|>$/g, '').toLowerCase();
}

function partMetadataMatches(
  actual: any,
  expected: Pick<ComposeRegularAttachmentSource, 'type' | 'name' | 'size'>,
): boolean {
  return normalizedType(actual?.type ?? actual?.mime_type) === expected.type
    && actual?.name === expected.name
    && actual?.disposition === 'attachment'
    && normalizedCid(actual?.cid) === null
    && (expected.size == null || Number(actual?.size) === expected.size);
}

function walkBodyParts(part: any, visit: (part: any) => void): void {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return;
  visit(part);
  if (!Array.isArray(part.subParts)) return;
  for (const child of part.subParts) walkBodyParts(child, visit);
}

function candidateParts(email: any): any[] {
  const parts: any[] = [];
  const seen = new Set<string>();
  const add = (part: any) => {
    const key = `${String(part?.partId ?? '')}\u0000${String(part?.blobId ?? '')}`;
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(part);
  };
  if (Array.isArray(email?.attachments)) {
    for (const part of email.attachments) add(part);
  }
  walkBodyParts(email?.bodyStructure, add);
  return parts;
}

/**
 * Canonical Email-part handles may only be reused from an Email that is
 * still present in the same account. Temporary upload rows have no part id
 * and are validated by Email/set when the server resolves their blob ids.
 */
export function assertCanonicalAttachmentOwnership(
  sources: ComposeRegularAttachmentSource[],
  emails: any[],
): void {
  const canonical = sources.filter((source) => source.partId != null);
  if (canonical.length === 0) return;
  if (!Array.isArray(emails) || emails.length === 0) {
    throw checkpointError('Canonical attachment owner is missing', 'blobNotFound');
  }
  const parts = emails.flatMap(candidateParts);
  for (const source of canonical) {
    const owned = parts.some((part) =>
      part?.partId === source.partId
      && part?.blobId === source.blobId
      && partMetadataMatches(part, source));
    if (!owned) {
      throw checkpointError(
        `Canonical attachment ${source.index + 1} is not owned by a live predecessor`,
        'blobNotFound',
      );
    }
  }
}

function compareSuccessorPart(
  expected: any,
  actual: any,
  expectedBodyValues: Record<string, any>,
  bodyValues: Record<string, any>,
  path: string,
): void {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)
      || !actual || typeof actual !== 'object' || Array.isArray(actual)
      || normalizedType(actual.type) !== normalizedType(expected.type)) {
    throw checkpointError(`Successor body part ${path} does not match the created MIME tree`);
  }
  const expectedChildren = Array.isArray(expected.subParts) ? expected.subParts : [];
  const actualChildren = Array.isArray(actual.subParts) ? actual.subParts : [];
  if (expectedChildren.length > 0 || actualChildren.length > 0) {
    if (expectedChildren.length !== actualChildren.length) {
      throw checkpointError(`Successor body part ${path} has incomplete children`);
    }
    expectedChildren.forEach((child, index) => {
      compareSuccessorPart(
        child,
        actualChildren[index],
        expectedBodyValues,
        bodyValues,
        `${path}.${index + 1}`,
      );
    });
    return;
  }
  if (!isHandle(actual.partId) || !isHandle(actual.blobId)) {
    throw checkpointError(`Successor body part ${path} has no canonical handles`);
  }
  if (isHandle(expected.blobId)) {
    if ((actual.name ?? null) !== (expected.name ?? null)
        || (actual.disposition ?? null) !== (expected.disposition ?? null)
        || normalizedCid(actual.cid) !== normalizedCid(expected.cid)) {
      throw checkpointError(`Successor attachment part ${path} has different metadata`);
    }
    return;
  }
  const value = bodyValues[actual.partId];
  const expectedValue = expectedBodyValues[expected.partId];
  if (!value || typeof value.value !== 'string'
      || value.isTruncated === true
      || value.isEncodingProblem === true
      || (typeof expectedValue?.value === 'string' && value.value !== expectedValue.value)) {
    throw checkpointError(`Successor text part ${path} is incomplete`);
  }
}

function validateRegularRows(
  rows: unknown,
  sources: ComposeRegularAttachmentSource[],
): BodyAttachmentRow[] {
  if (!Array.isArray(rows)) {
    throw checkpointError('Successor regular attachment rows are missing');
  }
  const regular = rows.filter((row) =>
    row?.disposition !== 'inline' && normalizedCid(row?.cid) === null);
  if (regular.length !== sources.length) {
    throw checkpointError('Successor regular attachment count does not match the captured draft');
  }
  return regular.map((row, index) => {
    const source = sources[index];
    if (!isHandle(row?.part_id)
        || !isHandle(row?.blob_id)
        || !partMetadataMatches(row, source)) {
      throw checkpointError(
        `Successor regular attachment ${index + 1} has incomplete canonical metadata`,
      );
    }
    return row as BodyAttachmentRow;
  });
}

export async function fetchAndCheckpointComposeBody({
  transport,
  account,
  handlers,
  remoteId,
  expectedBodyStructure,
  expectedBodyValues,
  expectedRegularAttachments,
  useWebSocket = false,
}: {
  transport: any;
  account: any;
  handlers: Record<string, (params: any) => Promise<any>>;
  remoteId: string;
  expectedBodyStructure?: any;
  expectedBodyValues?: Record<string, any>;
  expectedRegularAttachments: ComposeRegularAttachmentSource[];
  useWebSocket?: boolean;
}): Promise<{
  localMessageId: number;
  attachments: BodyAttachmentRow[];
  regularAttachments: BodyAttachmentRow[];
}> {
  let fetched;
  try {
    fetched = await fetchEmailBodies({
      transport,
      account,
      handlers,
      remoteIds: [remoteId],
      maxBodyValueBytes: null,
      useWebSocket,
    });
  } catch (error) {
    rethrowCheckpointError(error);
  }
  if (fetched.fetched !== 1 || fetched.emails?.length !== 1
      || fetched.emails[0]?.id !== remoteId) {
    throw checkpointError('Created Email body could not be fetched completely');
  }
  const email = fetched.emails[0];
  if (expectedBodyStructure != null) {
    compareSuccessorPart(
      expectedBodyStructure,
      email.bodyStructure,
      expectedBodyValues ?? {},
      email.bodyValues ?? {},
      '1',
    );
  }
  let rows;
  try {
    rows = await handlers[DB_RPC.QUERY]({
      sql: 'SELECT id FROM messages WHERE account_id = ? AND remote_id = ? LIMIT 1',
      params: [account.id, remoteId],
    });
  } catch (error) {
    rethrowCheckpointError(error);
  }
  const localMessageId = Number(rows[0]?.id);
  if (!Number.isSafeInteger(localMessageId) || localMessageId <= 0) {
    throw checkpointError('Created Email is missing from the local cache');
  }
  let body;
  try {
    body = await handlers[DB_RPC.MESSAGE_BODY_READ]({ messageId: localMessageId });
  } catch (error) {
    rethrowCheckpointError(error);
  }
  if (!body || body.isComplete !== true) {
    throw checkpointError('Created Email body was not persisted completely');
  }
  const regularAttachments = validateRegularRows(
    body.attachments,
    expectedRegularAttachments,
  );
  return {
    localMessageId,
    attachments: body.attachments,
    regularAttachments,
  };
}
