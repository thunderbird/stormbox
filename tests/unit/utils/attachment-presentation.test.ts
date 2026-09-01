import { describe, expect, it } from 'vitest';

import {
  attachmentPreviewKind,
  decodePlainTextPreview,
  hasMatchingRasterSignature,
  MAX_RASTER_PREVIEW_BYTES,
  MAX_TEXT_PREVIEW_BYTES,
  sanitizeAttachmentFilename,
  shouldSuppressResolvedCidPart,
} from '../../../src/utils/attachment-presentation';
import { attachmentPart as part } from '../_fixtures/rows';

describe('attachment presentation classification', () => {
  it('auto-previews only bounded allowlisted rasters', () => {
    expect(attachmentPreviewKind(part({
      mime_type: 'image/png',
      size: MAX_RASTER_PREVIEW_BYTES,
    }))).toBe('raster-auto');
    expect(attachmentPreviewKind(part({
      mime_type: 'image/png',
      size: MAX_RASTER_PREVIEW_BYTES + 1,
    }))).toBe('download-only');
    expect(attachmentPreviewKind(part({
      mime_type: 'image/png',
      size: null,
    }))).toBe('raster-auto');
    expect(attachmentPreviewKind(part({
      mime_type: 'image/vnd.microsoft.icon',
      size: 1024,
    }))).toBe('raster-auto');
  });

  it('keeps plain text on demand, opens PDFs, and leaves active formats download-only', () => {
    expect(attachmentPreviewKind(part({ mime_type: 'text/plain' })))
      .toBe('text-on-demand');
    expect(attachmentPreviewKind(part({ mime_type: 'text/plain', size: null })))
      .toBe('text-on-demand');
    expect(attachmentPreviewKind(part({ mime_type: 'application/pdf' })))
      .toBe('pdf-browser');
    for (const mimeType of [
      'image/svg+xml',
      'text/html',
      'application/xml',
      'application/zip',
      'application/javascript',
    ]) {
      expect(attachmentPreviewKind(part({ mime_type: mimeType })))
        .toBe('download-only');
    }
  });

  it('suppresses only successfully resolved non-attachment CID parts', () => {
    const resolved = new Set(['part-1']);
    expect(shouldSuppressResolvedCidPart(part({
      disposition: 'inline',
      cid: 'logo@example.test',
    }), resolved)).toBe(true);
    expect(shouldSuppressResolvedCidPart(part({
      disposition: 'attachment',
      cid: 'logo@example.test',
    }), resolved)).toBe(false);
    expect(shouldSuppressResolvedCidPart(part({
      disposition: 'inline',
      cid: 'logo@example.test',
    }), new Set())).toBe(false);
    expect(shouldSuppressResolvedCidPart(part({
      disposition: 'inline',
      cid: null,
    }), resolved)).toBe(false);
  });
});

describe('raster signature validation', () => {
  it('requires the declared type and magic bytes to agree', async () => {
    const png = new Blob([
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ]);
    await expect(hasMatchingRasterSignature(png, 'image/png')).resolves.toBe(true);
    await expect(hasMatchingRasterSignature(png, 'image/jpeg')).resolves.toBe(false);
    await expect(hasMatchingRasterSignature(png, 'image/svg+xml')).resolves.toBe(false);
  });

  it('recognizes WebP and AVIF container brands at their fixed offsets', async () => {
    const webp = new Blob([new TextEncoder().encode('RIFF1234WEBPVP8 ')]);
    const avif = new Blob([new Uint8Array([
      0x00, 0x00, 0x00, 0x18,
      0x66, 0x74, 0x79, 0x70,
      0x61, 0x76, 0x69, 0x66,
      0x00, 0x00, 0x00, 0x00,
      0x61, 0x76, 0x69, 0x66,
    ])]);
    await expect(hasMatchingRasterSignature(webp, 'image/webp')).resolves.toBe(true);
    await expect(hasMatchingRasterSignature(avif, 'image/avif')).resolves.toBe(true);
  });
});

describe('safe attachment text and filenames', () => {
  it('caps decoded text and reports metadata-backed truncation', async () => {
    const blob = new Blob(['safe text']);
    await expect(decodePlainTextPreview(
      blob,
      'utf-8',
      MAX_TEXT_PREVIEW_BYTES + 20,
    )).resolves.toEqual({
      text: 'safe text',
      truncated: true,
    });
  });

  it('uses one lookahead byte to detect truncation without declared size', async () => {
    const blob = new Blob(['x'.repeat(MAX_TEXT_PREVIEW_BYTES + 1)]);
    const preview = await decodePlainTextPreview(blob, 'utf-8', null);

    expect(preview.text).toHaveLength(MAX_TEXT_PREVIEW_BYTES);
    expect(preview.truncated).toBe(true);
  });

  it('falls back to UTF-8 for unsupported declared charsets', async () => {
    await expect(decodePlainTextPreview(
      new Blob(['safe text']),
      'not-a-real-charset',
      9,
    )).resolves.toEqual({
      text: 'safe text',
      truncated: false,
    });
  });

  it('removes path, control, bidi, and reserved-name hazards', () => {
    expect(sanitizeAttachmentFilename('../../reports/q4.txt')).toBe('q4.txt');
    expect(sanitizeAttachmentFilename('..\\..\\evil\u0000\u202e.txt')).toBe('evil.txt');
    expect(sanitizeAttachmentFilename('CON.txt')).toBe('_CON.txt');
    expect(sanitizeAttachmentFilename('CON .txt')).toBe('_CON .txt');
    expect(sanitizeAttachmentFilename('...')).toBe('attachment');
    expect(sanitizeAttachmentFilename(null)).toBe('attachment');
  });
});
