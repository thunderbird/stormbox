import { base64ToBytes, extractDataUriImages } from '../../../utils/inline-images';
import { hasInternalProvenanceAttribute } from '../../../utils/compose-provenance';

interface ComposeAttachment {
  part_id?: string | null;
  partId?: string | null;
  blob_id?: string | null;
  blobId?: string | null;
  mime_type?: string | null;
  type?: string | null;
  name?: string | null;
  disposition?: string | null;
  cid?: string | null;
  size?: number | null;
}

export interface ComposeRegularAttachmentSource {
  index: number;
  blobId: string;
  type: string;
  name: string;
  disposition: 'attachment';
  partId: string | null;
  size: number | null;
}

interface PreparedAttachment {
  blobId: string;
  type: string;
  name?: string;
  disposition: 'attachment' | 'inline';
  cid?: string;
}

const MIME_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function attachmentInputError(index: number, field: string): Error {
  const error: any = new Error(`Compose attachment ${index + 1} has an invalid ${field}`);
  error.type = 'invalidAttachment';
  error.attachmentIndex = index;
  return error;
}

function sourceString(
  value: unknown,
  index: number,
  field: string,
  { trim = false }: { trim?: boolean } = {},
): string {
  if (typeof value !== 'string'
      || value.length === 0
      || value.trim().length === 0
      || hasControlCharacter(value)
      || (trim && value.trim() !== value)) {
    throw attachmentInputError(index, field);
  }
  return value;
}

function sourceMimeType(value: unknown, index: number): string {
  const type = sourceString(value, index, 'type', { trim: true });
  const slash = type.indexOf('/');
  if (slash <= 0
      || slash !== type.lastIndexOf('/')
      || !MIME_TOKEN.test(type.slice(0, slash))
      || !MIME_TOKEN.test(type.slice(slash + 1))) {
    throw attachmentInputError(index, 'type');
  }
  return type.toLowerCase();
}

/**
 * Validate the regular attachment rows captured by compose-store.
 *
 * A non-empty part id marks a canonical Email-part blob. An empty part
 * id marks a temporary upload that has not reached a draft checkpoint.
 */
export function regularAttachmentSources(value: unknown): ComposeRegularAttachmentSource[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw attachmentInputError(0, 'attachment list');
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw attachmentInputError(index, 'attachment');
    }
    const attachment = raw as ComposeAttachment;
    if (attachment.blob_id != null
        && attachment.blobId != null
        && attachment.blob_id !== attachment.blobId) {
      throw attachmentInputError(index, 'blobId');
    }
    if (attachment.mime_type != null
        && attachment.type != null
        && (typeof attachment.mime_type !== 'string'
          || typeof attachment.type !== 'string'
          || attachment.mime_type.toLowerCase() !== attachment.type.toLowerCase())) {
      throw attachmentInputError(index, 'type');
    }
    const blobId = sourceString(
      attachment.blob_id ?? attachment.blobId,
      index,
      'blobId',
      { trim: true },
    );
    const type = sourceMimeType(attachment.mime_type ?? attachment.type, index);
    const name = sourceString(attachment.name, index, 'name');
    if (attachment.disposition !== 'attachment') {
      throw attachmentInputError(index, 'disposition');
    }
    if (attachment.cid != null) {
      throw attachmentInputError(index, 'cid');
    }
    if (attachment.part_id != null
        && attachment.partId != null
        && attachment.part_id !== attachment.partId) {
      throw attachmentInputError(index, 'partId');
    }
    const rawPartId = attachment.part_id ?? attachment.partId ?? null;
    const partId = rawPartId === ''
      ? null
      : (rawPartId == null
        ? null
        : sourceString(rawPartId, index, 'partId', { trim: true }));
    const size = attachment.size ?? null;
    if (size != null
        && (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)) {
      throw attachmentInputError(index, 'size');
    }
    return {
      index,
      blobId,
      type,
      name,
      disposition: 'attachment',
      partId,
      size,
    };
  });
}

export function missingRegularAttachmentIndexes(
  detail: any,
  attachments: ComposeRegularAttachmentSource[],
): number[] {
  const missingBlobIds = Array.isArray(detail?.notFound)
    ? new Set(detail.notFound.filter((id: unknown): id is string =>
      typeof id === 'string' && id.length > 0))
    : new Set<string>();
  const matched = attachments
    .filter((attachment) => missingBlobIds.has(attachment.blobId))
    .map((attachment) => attachment.index);
  return matched.length > 0
    ? matched
    : attachments.map((attachment) => attachment.index);
}

async function uploadDataImages({ transport, account, images }): Promise<PreparedAttachment[]> {
  const attachments: PreparedAttachment[] = [];
  for (const image of images) {
    const result = await transport.upload({
      accountId: account.remote_account_id,
      type: image.type,
      body: base64ToBytes(image.base64),
    });
    if (!result?.blobId) throw new Error('JMAP upload returned no blobId');
    attachments.push({
      blobId: result.blobId,
      type: image.type,
      cid: image.cid,
      disposition: 'inline',
    });
  }
  return attachments;
}

function reuseRegularAttachments(
  attachments: ComposeRegularAttachmentSource[],
): PreparedAttachment[] {
  return attachments.map((attachment) => ({
    blobId: attachment.blobId,
    type: attachment.type,
    name: attachment.name,
    disposition: 'attachment',
  }));
}

function bodyPart(request: any, html: string) {
  const hasHtml = !!(html && /\S/.test(html));
  if (!hasHtml) {
    return {
      structure: { type: 'text/plain', partId: 'p1' },
      values: { p1: { value: request.textBody ?? '' } },
    };
  }
  return {
    structure: {
      type: 'multipart/alternative',
      subParts: [
        { type: 'text/plain', partId: 'p1' },
        { type: 'text/html', partId: 'h1' },
      ],
    },
    values: {
      p1: { value: request.textBody ?? '' },
      h1: { value: html },
    },
  };
}

function bodyFields(
  request: any,
  html: string,
  attachments: PreparedAttachment[],
) {
  const body = bodyPart(request, html);
  const inline = attachments.filter((attachment) => attachment.disposition === 'inline');
  const regular = attachments.filter((attachment) => attachment.disposition !== 'inline');
  let structure: any = body.structure;
  if (inline.length > 0) {
    structure = {
      type: 'multipart/related',
      subParts: [structure, ...inline.map(attachmentBodyPart)],
    };
  }
  if (regular.length > 0) {
    structure = {
      type: 'multipart/mixed',
      subParts: [structure, ...regular.map(attachmentBodyPart)],
    };
  }
  return {
    bodyStructure: structure,
    bodyValues: body.values,
  };
}

function attachmentBodyPart(attachment: PreparedAttachment) {
  return {
    blobId: attachment.blobId,
    type: attachment.type,
    ...(attachment.name ? { name: attachment.name } : {}),
    disposition: attachment.disposition,
    ...(attachment.cid ? { cid: attachment.cid } : {}),
  };
}

/**
 * Build one immutable JMAP Email revision.
 *
 * Regular parts reuse same-account blob ids while the owning predecessor
 * remains alive. Inline data-URL images keep their upload path.
 */
export async function prepareComposeEmail({
  transport,
  account,
  identity,
  request,
  mailboxRemoteId,
  isDraft,
}: {
  transport: any;
  account: any;
  identity: any;
  request: any;
  mailboxRemoteId: string | null;
  isDraft: boolean;
}) {
  const sourceHtml = String(request.htmlBody ?? '');
  if (hasInternalProvenanceAttribute(sourceHtml)) {
    throw new Error('Compose HTML contains an internal provenance attribute');
  }
  const regularSources = regularAttachmentSources(request.attachments);
  const extracted = extractDataUriImages(sourceHtml);
  const dataAttachments = await uploadDataImages({
    transport,
    account,
    images: extracted.images,
  });
  const attachments = [
    ...reuseRegularAttachments(regularSources),
    ...dataAttachments,
  ];
  return {
    ...(mailboxRemoteId ? { mailboxIds: { [mailboxRemoteId]: true } } : {}),
    ...(isDraft ? { keywords: { $draft: true } } : {}),
    from: [{
      ...(identity.name ? { name: identity.name } : {}),
      email: identity.email,
    }],
    to: request.to ?? [],
    ...(request.cc?.length ? { cc: request.cc } : {}),
    ...(request.bcc?.length ? { bcc: request.bcc } : {}),
    ...(request.replyTo?.length ? { replyTo: request.replyTo } : {}),
    ...(request.inReplyTo?.length ? { inReplyTo: request.inReplyTo } : {}),
    ...(request.references?.length ? { references: request.references } : {}),
    subject: request.subject ?? '',
    ...bodyFields(request, extracted.html, attachments),
  };
}
