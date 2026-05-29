/**
 * Inline-image helpers shared by the sync layer.
 */

/**
 * Encode bytes as a base64 string. Chunks the input before calling
 * `btoa` (a window+worker global) so a large blob does not blow the
 * argument-count limit of `String.fromCharCode`. Used to ferry a
 * downloaded inline-image blob across the worker RPC boundary as JSON.
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
