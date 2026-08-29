import { base64ToBytes, extractDataUriImages } from '../../../utils/inline-images';
import { hasInternalProvenanceAttribute } from '../../../utils/compose-provenance';

interface ComposeAttachment {
  blob_id?: string | null;
  blobId?: string | null;
  mime_type?: string | null;
  type?: string | null;
  name?: string | null;
  disposition?: string | null;
  cid?: string | null;
}

interface PreparedAttachment {
  blobId: string;
  type: string;
  name?: string;
  disposition: 'attachment' | 'inline';
  cid?: string;
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

async function refreshExistingAttachments({
  transport,
  account,
  attachments,
}: {
  transport: any;
  account: any;
  attachments: ComposeAttachment[];
}): Promise<PreparedAttachment[]> {
  const refreshed: PreparedAttachment[] = [];
  for (const attachment of attachments) {
    const sourceBlobId = attachment.blob_id ?? attachment.blobId;
    if (!sourceBlobId) throw new Error('Draft attachment has no readable blobId');
    const type = attachment.mime_type ?? attachment.type ?? 'application/octet-stream';
    const name = attachment.name ?? 'attachment';
    const bytes = await transport.download({
      accountId: account.remote_account_id,
      blobId: sourceBlobId,
      type,
      name,
    });
    const uploaded = await transport.upload({
      accountId: account.remote_account_id,
      type,
      body: bytes,
    });
    if (!uploaded?.blobId) throw new Error('JMAP upload returned no blobId');
    const cid = attachment.cid?.replace(/^<|>$/g, '') || undefined;
    refreshed.push({
      blobId: uploaded.blobId,
      type,
      ...(attachment.name ? { name: attachment.name } : {}),
      disposition: attachment.disposition === 'inline' || cid ? 'inline' : 'attachment',
      ...(cid ? { cid } : {}),
    });
  }
  return refreshed;
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
      subParts: [structure, ...inline],
    };
  }
  if (regular.length > 0) {
    structure = {
      type: 'multipart/mixed',
      subParts: [structure, ...regular],
    };
  }
  return {
    bodyStructure: structure,
    bodyValues: body.values,
  };
}

/**
 * Build one immutable JMAP Email revision.
 *
 * Existing Email-part blobs are downloaded and uploaded again before the
 * predecessor may be destroyed, so every returned blobId is owned
 * independently of the prior revision (CD-6.10).
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
  const extracted = extractDataUriImages(sourceHtml);
  const [dataAttachments, existingAttachments] = await Promise.all([
    uploadDataImages({ transport, account, images: extracted.images }),
    refreshExistingAttachments({
      transport,
      account,
      attachments: Array.isArray(request.attachments) ? request.attachments : [],
    }),
  ]);
  const attachments = [...existingAttachments, ...dataAttachments];
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
