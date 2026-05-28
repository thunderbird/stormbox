/**
 * Email body fetch. JMAP Email/get with bodyStructure + textBody +
 * htmlBody + attachments + body properties + fetchTextBodyValues +
 * fetchHTMLBodyValues. Persists body_parts (full MIME tree) and
 * body_values (decoded text/html), keyed by part_id.
 *
 * Truncated bodyValues come back from the server; we record
 * is_truncated so the UI can fall back to a blob download for the
 * complete content.
 */

import { DB_RPC } from '../../../db/protocol';
import { wlog } from '../../../db/worker-log';
import { JMAP_CAPS } from './transport';
import { callJmap, pickResponse } from './invoke';

const BODY_PROPERTIES = [
  'id', 'blobId', 'threadId', 'mailboxIds', 'keywords',
  'bodyStructure', 'textBody', 'htmlBody', 'attachments',
  // bodyValues is the keyed map that fetchTextBodyValues /
  // fetchHTMLBodyValues populates. Stalwart only includes it in the
  // response when it's explicitly listed as a requested property.
  'bodyValues',
];

const BODY_PART_PROPERTIES = [
  'partId', 'blobId', 'size', 'name', 'type', 'charset',
  'disposition', 'cid', 'language', 'location', 'subParts',
];

const MAX_BODY_VALUE_BYTES = 256 * 1024;

/**
 * Fetch and persist the body for a list of messages. Caller passes the
 * remote ids; we resolve to local message rows and write body_parts +
 * body_values + (re)write the inline attachment metadata.
 */
export async function fetchEmailBodies({
  transport, account, handlers, remoteIds,
  maxBodyValueBytes = MAX_BODY_VALUE_BYTES,
  useWebSocket = false,
}) {
  if (!remoteIds?.length) {
    return { fetched: 0 };
  }
  const result = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
    methodCalls: [[
      'Email/get',
      {
        accountId: account.remote_account_id,
        ids: remoteIds,
        properties: BODY_PROPERTIES,
        bodyProperties: BODY_PART_PROPERTIES,
        fetchTextBodyValues: true,
        fetchHTMLBodyValues: true,
        maxBodyValueBytes,
      },
      'gb1',
    ]],
    useWebSocket,
  });
  const list = pickResponse(result, 'Email/get')?.list ?? [];
  if (list.length === 0) {
    return { fetched: 0 };
  }
  for (const email of list) {
    const bvKeys = Object.keys(email.bodyValues ?? {});
    wlog.info(
      'jmap-bodies',
      `email=${email.id} bodyStructure.type=${email.bodyStructure?.type} subParts=${email.bodyStructure?.subParts?.length ?? 0} textBody.parts=${(email.textBody ?? []).length} htmlBody.parts=${(email.htmlBody ?? []).length} bodyValues.keys=${bvKeys.join(',') || '(none)'}`,
    );
  }
  await persistBodies({ account, emails: list, handlers });
  return { fetched: list.length };
}

async function persistBodies({ account, emails, handlers }) {
  const bodies = [];
  for (const email of emails) {
    const parts = [];
    const values = [];

    const textPartIds = new Set((email.textBody ?? []).map((p) => p.partId));
    const htmlPartIds = new Set((email.htmlBody ?? []).map((p) => p.partId));
    const attachmentPartIds = new Set((email.attachments ?? []).map((p) => p.partId));

    // partId -> MIME media type, captured from the body structure walk so
    // body values can be classified by their actual content type rather
    // than by list membership. A plaintext-only message lists its single
    // text/plain part in BOTH textBody and htmlBody (RFC 8621: htmlBody
    // falls back to the text part when no text/html alternative exists),
    // so keying off htmlBody alone misfiles plaintext as HTML and the
    // viewer then renders it through the HTML iframe, collapsing every
    // newline into one unformatted block (issue #25).
    const mediaTypeByPartId = new Map<string, string>();

    let position = 0;
    walkParts(email.bodyStructure, null, (part, parentPartId) => {
      const partId = part.partId ?? null;
      if (partId != null && part.type) {
        mediaTypeByPartId.set(partId, String(part.type).toLowerCase());
      }
      parts.push({
        partId: partId ?? `idx-${position}`,
        position,
        blobId: part.blobId ?? null,
        parentPartId,
        mediaType: part.type ?? null,
        charset: part.charset ?? null,
        name: part.name ?? null,
        disposition: part.disposition ?? null,
        cid: part.cid ? part.cid.replace(/^<|>$/g, '') : null,
        language: Array.isArray(part.language) ? JSON.stringify(part.language) : (part.language ?? null),
        location: part.location ?? null,
        size: part.size ?? null,
        isBodyText: textPartIds.has(partId),
        isBodyHtml: htmlPartIds.has(partId),
        isAttachment: attachmentPartIds.has(partId),
        isInline: part.disposition === 'inline',
        rawJson: JSON.stringify(part),
      });
      position += 1;
    });

    const bodyValues = email.bodyValues ?? {};
    for (const [partId, payload] of Object.entries(bodyValues) as Array<[string, any]>) {
      const mediaType = mediaTypeByPartId.get(partId) ?? '';
      let kind: 'html' | 'text';
      if (mediaType === 'text/html') {
        kind = 'html';
      } else if (mediaType === 'text/plain') {
        kind = 'text';
      } else {
        // No usable media type (truncated/odd structure): only treat as
        // HTML when the part is exclusively in the htmlBody list.
        kind = htmlPartIds.has(partId) && !textPartIds.has(partId) ? 'html' : 'text';
      }
      const value = payload?.value ?? '';
      values.push({
        partId,
        kind,
        value,
        isTruncated: !!payload?.isTruncated,
        byteSize: new Blob([value]).size,
      });
    }
    bodies.push({
      remoteId: email.id,
      parts,
      values,
    });
  }
  await handlers[DB_RPC.MESSAGE_BODY_PERSIST_BATCH]({
    accountId: account.id,
    bodies,
  });
}

function walkParts(part, parentPartId, visit) {
  if (!part) return;
  visit(part, parentPartId);
  for (const child of part.subParts ?? []) {
    walkParts(child, part.partId ?? null, visit);
  }
}

