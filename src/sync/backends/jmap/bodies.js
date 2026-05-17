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

import { DB_RPC } from '../../../db/protocol.js';
import { JMAP_CAPS } from './transport.js';

const BODY_PROPERTIES = [
  'id', 'blobId', 'threadId', 'mailboxIds', 'keywords',
  'bodyStructure', 'textBody', 'htmlBody', 'attachments',
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
  await persistBodies({ account, emails: list, handlers });
  return { fetched: list.length };
}

async function persistBodies({ account, emails, handlers }) {
  const ts = Date.now();

  for (const email of emails) {
    const messageRow = await handlers[DB_RPC.MESSAGE_GET_BY_REMOTE]({
      accountId: account.id,
      remoteId: email.id,
    });
    if (!messageRow) {
      continue;
    }
    const messageId = messageRow.id;

    // Replace body_parts and body_values entirely; bodies are an LRU
    // cache and the cheapest correct strategy is to drop and rewrite.
    const txStatements = [
      { sql: 'DELETE FROM body_parts WHERE message_id = ?', params: [messageId] },
      { sql: 'DELETE FROM body_values WHERE message_id = ?', params: [messageId] },
    ];
    await handlers[DB_RPC.TRANSACTION]({ statements: txStatements });

    const partInserts = [];
    const valueInserts = [];

    const textPartIds = new Set((email.textBody ?? []).map((p) => p.partId));
    const htmlPartIds = new Set((email.htmlBody ?? []).map((p) => p.partId));
    const attachmentPartIds = new Set((email.attachments ?? []).map((p) => p.partId));

    let position = 0;
    walkParts(email.bodyStructure, null, (part, parentPartId) => {
      const partId = part.partId ?? null;
      partInserts.push({
        sql: `INSERT INTO body_parts(
                message_id, part_id, position, blob_id, parent_part_id,
                media_type, charset, name, disposition, cid,
                language, location, size,
                is_body_text, is_body_html, is_attachment, is_inline,
                raw_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(message_id, part_id) DO UPDATE SET
                position = excluded.position,
                blob_id = excluded.blob_id,
                parent_part_id = excluded.parent_part_id,
                media_type = excluded.media_type,
                charset = excluded.charset,
                name = excluded.name,
                disposition = excluded.disposition,
                cid = excluded.cid,
                language = excluded.language,
                location = excluded.location,
                size = excluded.size,
                is_body_text = excluded.is_body_text,
                is_body_html = excluded.is_body_html,
                is_attachment = excluded.is_attachment,
                is_inline = excluded.is_inline,
                raw_json = excluded.raw_json`,
        params: [
          messageId,
          partId ?? `idx-${position}`,
          position,
          part.blobId ?? null,
          parentPartId,
          part.type ?? null,
          part.charset ?? null,
          part.name ?? null,
          part.disposition ?? null,
          part.cid ? part.cid.replace(/^<|>$/g, '') : null,
          Array.isArray(part.language) ? JSON.stringify(part.language) : (part.language ?? null),
          part.location ?? null,
          part.size ?? null,
          textPartIds.has(partId) ? 1 : 0,
          htmlPartIds.has(partId) ? 1 : 0,
          attachmentPartIds.has(partId) ? 1 : 0,
          part.disposition === 'inline' ? 1 : 0,
          JSON.stringify(part),
        ],
      });
      position += 1;
    });

    const bodyValues = email.bodyValues ?? {};
    for (const [partId, payload] of Object.entries(bodyValues)) {
      const isHtml = htmlPartIds.has(partId);
      const kind = isHtml ? 'html' : 'text';
      const value = payload?.value ?? '';
      valueInserts.push({
        sql: `INSERT INTO body_values(
                message_id, part_id, kind, value, is_truncated,
                fetched_at, last_accessed_at, byte_size
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(message_id, part_id, kind) DO UPDATE SET
                value = excluded.value,
                is_truncated = excluded.is_truncated,
                fetched_at = excluded.fetched_at,
                last_accessed_at = excluded.last_accessed_at,
                byte_size = excluded.byte_size`,
        params: [
          messageId,
          partId,
          kind,
          value,
          payload?.isTruncated ? 1 : 0,
          ts,
          ts,
          new Blob([value]).size,
        ],
      });
    }

    if (partInserts.length > 0) {
      await handlers[DB_RPC.TRANSACTION]({ statements: partInserts });
    }
    if (valueInserts.length > 0) {
      await handlers[DB_RPC.TRANSACTION]({ statements: valueInserts });
    }
    await handlers[DB_RPC.QUERY]({
      sql: 'UPDATE messages SET body_fetched_at = ?, updated_at = ? WHERE id = ?',
      params: [ts, ts, messageId],
    });
  }
}

function walkParts(part, parentPartId, visit) {
  if (!part) return;
  visit(part, parentPartId);
  for (const child of part.subParts ?? []) {
    walkParts(child, part.partId ?? null, visit);
  }
}

async function callJmap(transport, { using, methodCalls, useWebSocket }) {
  if (useWebSocket) {
    return transport.wsRequest(using, methodCalls);
  }
  return transport.request(using, methodCalls);
}

function pickResponse(result, methodName) {
  const responses = result?.methodResponses ?? [];
  const found = responses.find((r) => r[0] === methodName);
  return found?.[1] ?? null;
}
