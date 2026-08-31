// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import {
  missingRegularAttachmentIndexes,
  prepareComposeEmail,
  regularAttachmentSources,
} from '../../../src/sync/backends/jmap/compose-email';
import { stripInternalProvenanceHtml } from '../../../src/utils/compose-provenance';

function requestWithBodies(htmlBody: string, textBody: string) {
  return {
    to: [{ email: 'recipient@example.com' }],
    subject: 'Provenance prose',
    htmlBody,
    textBody,
    attachments: [],
  };
}

describe('prepareComposeEmail worker provenance invariant', () => {
  it('preserves marker-shaped prose and escaped code byte-for-byte', async () => {
    const html = '<p>Literal data-stormbox-origin="example"</p>'
      + '<pre><code>&lt;span data-stormbox-origin-touched="true"&gt;</code></pre>'
      + '<p title="data-stormbox-origin=&quot;attribute-value&quot;">Attribute value</p>';
    const text = 'Literal data-stormbox-origin="example"\n'
      + '<span data-stormbox-origin-touched="true">\nAttribute value';
    const prepared = await prepareComposeEmail({
      transport: { upload: vi.fn(), download: vi.fn() },
      account: { remote_account_id: 'account-1' },
      identity: { email: 'sender@example.com' },
      mailboxRemoteId: null,
      isDraft: false,
      request: requestWithBodies(html, text),
    });

    expect(prepared.bodyValues.h1.value).toBe(html);
    expect(prepared.bodyValues.p1.value).toBe(text);
  });

  it('rejects an actual leaked marker attribute without mutating either alternative', async () => {
    const upload = vi.fn();
    const html = '<p data-stormbox-origin="identity-signature">Signature</p>';
    const text = 'Signature';

    await expect(prepareComposeEmail({
      transport: { upload, download: vi.fn() },
      account: { remote_account_id: 'account-1' },
      identity: { email: 'sender@example.com' },
      mailboxRemoteId: null,
      isDraft: false,
      request: requestWithBodies(html, text),
    })).rejects.toThrow('internal provenance attribute');
    expect(upload).not.toHaveBeenCalled();
    expect(stripInternalProvenanceHtml(html)).toBe(html);
    expect(html).toBe('<p data-stormbox-origin="identity-signature">Signature</p>');
    expect(text).toBe('Signature');
  });
});

describe('prepareComposeEmail regular attachment validation', () => {
  const validAttachment = {
    part_id: '',
    blob_id: 'temporary-blob',
    mime_type: 'application/pdf',
    name: 'report.pdf',
    size: 3,
    disposition: 'attachment',
    cid: null,
  };

  it.each([
    ['blobId', { blob_id: ' bad-blob' }],
    ['type', { mime_type: 'not a media type' }],
    ['type alias', { type: 42 }],
    ['name', { name: 'bad\nname.pdf' }],
    ['empty name', { name: '   ' }],
    ['disposition', { disposition: 'inline' }],
    ['cid', { cid: '' }],
    ['partId alias', { partId: 'other-part' }],
    ['size', { size: '3' }],
  ])('rejects an invalid regular attachment %s before upload', async (_field, patch) => {
    const upload = vi.fn();
    await expect(prepareComposeEmail({
      transport: { upload },
      account: { remote_account_id: 'account-1' },
      identity: { email: 'sender@example.com' },
      mailboxRemoteId: null,
      isDraft: false,
      request: {
        ...requestWithBodies('<p>Attached.</p>', 'Attached.'),
        attachments: [{ ...validAttachment, ...patch }],
      },
    })).rejects.toMatchObject({ type: 'invalidAttachment' });
    expect(upload).not.toHaveBeenCalled();
  });

  it('uses structured notFound ids when blobNotFound has a generic description', () => {
    const attachments = regularAttachmentSources([
      { ...validAttachment, blob_id: 'blob-first', name: 'first.pdf' },
      { ...validAttachment, blob_id: 'blob-second', name: 'second.pdf' },
    ]);

    expect(missingRegularAttachmentIndexes({
      type: 'blobNotFound',
      description: 'At least one referenced blob does not exist.',
      notFound: ['blob-second'],
    }, attachments)).toEqual([1]);
  });

  it('fails closed against captured attachments when blobNotFound names no candidate', () => {
    const attachments = regularAttachmentSources([
      { ...validAttachment, blob_id: 'blob-first', name: 'first.pdf' },
      { ...validAttachment, blob_id: 'blob-second', name: 'second.pdf' },
    ]);

    expect(missingRegularAttachmentIndexes({
      type: 'blobNotFound',
      description: 'At least one referenced blob does not exist.',
      notFound: ['blob-not-in-request'],
    }, attachments)).toEqual([0, 1]);
    expect(missingRegularAttachmentIndexes({
      type: 'blobNotFound',
      description: 'At least one referenced blob does not exist.',
      notFound: 'blob-first',
    }, attachments)).toEqual([0, 1]);
  });
});
