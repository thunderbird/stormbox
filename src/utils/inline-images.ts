/**
 * Inline-image helpers for the compose send pipeline.
 *
 * The compose editor inlines pasted images as base64 `data:` URLs so the
 * draft renders instantly and survives offline. JMAP, however, cannot
 * carry binary inside an Email/set body; a real inline image must be an
 * uploaded blob referenced from the HTML by `cid:`. These pure helpers
 * let the worker rewrite a draft's HTML and turn each `data:` image into
 * something it can upload, with no DOM dependency (the sync code runs in
 * a worker).
 */

export interface InlineImage {
  /** Content-ID without angle brackets; matches `src="cid:<cid>"`. */
  cid: string;
  /** MIME type pulled from the data URL, e.g. "image/png". */
  type: string;
  /** The raw base64 payload (whitespace stripped). */
  base64: string;
}

export interface ExtractedInlineImages {
  /** HTML with each data-URL image src rewritten to `cid:<cid>`. */
  html: string;
  /** One entry per rewritten image, in document order. */
  images: InlineImage[];
}

// Squire serialises attributes with double quotes, but accept single
// quotes too. The value is a base64 image data URL; capture the MIME
// subtype and payload so the caller can upload the bytes.
const DATA_URI_IMAGE_SRC = /src\s*=\s*(["'])data:(image\/[a-z0-9.+-]+);base64,([^"']*)\1/gi;

function makeCid(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  return `${uuid}@stormbox`;
}

/**
 * Find every `<img src="data:image/...;base64,...">` in the HTML and
 * rewrite its src to a generated `cid:` reference, returning the new HTML
 * plus the image descriptors the caller needs to upload. HTML with no
 * inline images is returned unchanged with an empty images array.
 */
export function extractDataUriImages(html: string): ExtractedInlineImages {
  if (!html || !html.includes('data:image/')) {
    return { html: html ?? '', images: [] };
  }
  const images: InlineImage[] = [];
  const rewritten = html.replace(DATA_URI_IMAGE_SRC, (_match, _quote, type, payload) => {
    const cid = makeCid();
    images.push({ cid, type, base64: String(payload).replace(/\s+/g, '') });
    return `src="cid:${cid}"`;
  });
  return { html: rewritten, images };
}

/**
 * Decode a base64 string into bytes. Uses `atob`, which is available in
 * both window and worker global scopes.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(String(base64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encode bytes as a base64 string. Chunks the input before calling
 * `btoa` (also a window+worker global) so a large blob does not blow the
 * argument-count limit of `String.fromCharCode`.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(binary);
}
