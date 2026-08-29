// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { prepareComposeEmail } from '../../../src/sync/backends/jmap/compose-email';
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
