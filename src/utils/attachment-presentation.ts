import type { BodyAttachmentRow } from '../types';
import {
  isInlineRasterType,
  MAX_INLINE_RASTER_BYTES,
} from './raster-images';

export const MAX_RASTER_PREVIEW_BYTES = MAX_INLINE_RASTER_BYTES;
export const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;
export const DOWNLOAD_URL_REVOKE_DELAY_MS = 60_000;

export type AttachmentPreviewKind =
  | 'raster-auto'
  | 'text-on-demand'
  | 'pdf-browser'
  | 'download-only';

type RasterImageType = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'avif' | 'ico';

function rasterImageType(type: string | null | undefined): RasterImageType | null {
  if (!isInlineRasterType(type)) return null;
  const normalized = String(type).trim().toLowerCase();
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpeg';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/bmp') return 'bmp';
  if (normalized === 'image/avif') return 'avif';
  if (normalized === 'image/x-icon' || normalized === 'image/vnd.microsoft.icon') {
    return 'ico';
  }
  return null;
}

export function attachmentPreviewKind(
  part: BodyAttachmentRow,
): AttachmentPreviewKind {
  const size = Number(part.size);
  if (
    rasterImageType(part.mime_type) != null
    && (
      part.size == null
      || (
        Number.isSafeInteger(size)
        && size >= 0
        && size <= MAX_RASTER_PREVIEW_BYTES
      )
    )
  ) {
    return 'raster-auto';
  }
  if (String(part.mime_type ?? '').trim().toLowerCase() === 'text/plain') {
    return 'text-on-demand';
  }
  if (String(part.mime_type ?? '').trim().toLowerCase() === 'application/pdf') {
    return 'pdf-browser';
  }
  return 'download-only';
}

export function shouldSuppressResolvedCidPart(
  part: BodyAttachmentRow,
  resolvedPartIds: ReadonlySet<string>,
): boolean {
  if (!part.cid || String(part.disposition ?? '').trim().toLowerCase() === 'attachment') {
    return false;
  }
  return resolvedPartIds.has(part.part_id);
}

/**
 * Size label for a message attachment: exact bytes below 1 KiB, whole
 * KiB rounded up below 1 MiB, otherwise MiB to one decimal. Callers pass
 * a finite, non-negative count.
 */
export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function sanitizeAttachmentFilename(
  untrustedName: string | null | undefined,
): string {
  const leaf = String(untrustedName ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop() ?? '';
  const withoutControls = Array.from(leaf.normalize('NFC'))
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x1f
        && codePoint !== 0x7f
        && !(codePoint >= 0x202a && codePoint <= 0x202e)
        && !(codePoint >= 0x2066 && codePoint <= 0x2069);
    })
    .join('');
  let safe = withoutControls
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[.\s]+$/g, '')
    .trim();

  if (!safe || safe === '.' || safe === '..') safe = 'attachment';
  const stem = safe.split('.')[0].replace(/[.\s]+$/g, '');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) {
    safe = `_${safe}`;
  }

  const codePoints = Array.from(safe);
  if (codePoints.length <= 180) return safe;
  const extensionIndex = safe.lastIndexOf('.');
  const extension = extensionIndex > 0 && safe.length - extensionIndex <= 20
    ? safe.slice(extensionIndex)
    : '';
  const extensionLength = Array.from(extension).length;
  return `${codePoints.slice(0, 180 - extensionLength).join('')}${extension}`;
}

function startsWith(bytes: Uint8Array, expected: number[]): boolean {
  return expected.every((value, index) => bytes[index] === value);
}

function asciiAt(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (bytes.length < offset + expected.length) return false;
  return Array.from(expected).every(
    (value, index) => bytes[offset + index] === value.charCodeAt(0),
  );
}

function hasAvifBrand(bytes: Uint8Array): boolean {
  if (!asciiAt(bytes, 4, 'ftyp')) return false;
  for (let offset = 8; offset + 4 <= bytes.length; offset += 4) {
    if (asciiAt(bytes, offset, 'avif') || asciiAt(bytes, offset, 'avis')) {
      return true;
    }
  }
  return false;
}

export async function hasMatchingRasterSignature(
  blob: Blob,
  declaredType: string | null | undefined,
): Promise<boolean> {
  const kind = rasterImageType(declaredType);
  if (!kind || blob.size > MAX_RASTER_PREVIEW_BYTES) return false;
  const bytes = new Uint8Array(await blob.slice(0, 64).arrayBuffer());

  switch (kind) {
    case 'png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'gif':
      return asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a');
    case 'webp':
      return asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP');
    case 'bmp':
      return asciiAt(bytes, 0, 'BM');
    case 'avif':
      return hasAvifBrand(bytes);
    case 'ico':
      return startsWith(bytes, [0x00, 0x00, 0x01, 0x00]);
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export async function canDecodeRasterBlob(blob: Blob): Promise<boolean> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      const decoded = bitmap.width > 0 && bitmap.height > 0;
      bitmap.close();
      return decoded;
    } catch {
      return false;
    }
  }
  if (
    typeof Image !== 'function'
    || typeof URL.createObjectURL !== 'function'
    || typeof URL.revokeObjectURL !== 'function'
  ) {
    return false;
  }

  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<boolean>((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image.naturalWidth > 0 && image.naturalHeight > 0);
      image.onerror = () => resolve(false);
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function decodePlainTextPreview(
  blob: Blob,
  charset: string | null | undefined,
  declaredSize: number | null | undefined,
): Promise<{ text: string; truncated: boolean }> {
  const capped = blob.slice(0, MAX_TEXT_PREVIEW_BYTES);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset?.trim() || 'utf-8');
  } catch {
    decoder = new TextDecoder();
  }
  return capped.arrayBuffer().then((buffer) => ({
    text: decoder.decode(buffer),
    truncated: blob.size > MAX_TEXT_PREVIEW_BYTES
      || (Number.isSafeInteger(Number(declaredSize)) && Number(declaredSize) > capped.size),
  }));
}
