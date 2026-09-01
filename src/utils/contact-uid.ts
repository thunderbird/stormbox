import { randomToken } from './random-token';

export function createContactUid(): string {
  return `urn:uuid:${randomToken()}`;
}

export async function createContactUidFromSeed(seed: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed)),
  ).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`
    + `-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createContactMapKey(prefix: string): string {
  return `${prefix}-${randomToken()}`;
}

export function isContactUid(value: unknown): value is string {
  return typeof value === 'string'
    && /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
}

export function normalizeContactUid(value: unknown): string | null {
  return isContactUid(value) ? value.toLowerCase() : null;
}
