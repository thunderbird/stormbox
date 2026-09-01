import type {
  IdentityAddress,
  IdentityMutableFields,
} from '../types';
import { parseAddressEntries } from './address-parse';
import { randomToken } from './random-token';

export const IDENTITY_SIGNATURE_BYTE_LIMIT = 2048;

export type IdentitySignatureIssue = 'invalid' | 'too-large';

const MUTABLE_IDENTITY_FIELDS = [
  'name',
  'replyTo',
  'bcc',
  'textSignature',
  'htmlSignature',
] as const satisfies readonly (keyof IdentityMutableFields)[];

export function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function createIdentityOperationId(): string {
  return `identity-${randomToken()}`;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function identityAddressesFromUnknown(
  value: unknown,
): IdentityAddress[] | null | undefined {
  if (value == null) return null;
  if (!Array.isArray(value)) return undefined;
  const addresses: IdentityAddress[] = [];
  for (const entry of value) {
    if (
      !entry
      || typeof entry !== 'object'
      || typeof (entry as { email?: unknown }).email !== 'string'
    ) {
      return undefined;
    }
    const rawName = (entry as { name?: unknown }).name;
    if (rawName !== undefined && rawName !== null && typeof rawName !== 'string') {
      return undefined;
    }
    addresses.push({
      name: rawName === undefined ? null : rawName as string | null,
      email: (entry as { email: string }).email,
    });
  }
  return addresses;
}

export function decodeIdentityAddresses(
  json: string | null | undefined,
): IdentityAddress[] | null {
  if (json == null) return null;
  try {
    return identityAddressesFromUnknown(JSON.parse(json)) ?? null;
  } catch {
    return null;
  }
}

export function parseIdentityMailbox(value: string): string | null {
  const email = value.trim();
  if (!email) return null;
  const entries = parseAddressEntries(email);
  if (entries.length !== 1 || !('address' in entries[0])) return null;
  const parsed = entries[0].address;
  if (parsed.name !== undefined || parsed.email !== email) return null;
  return parsed.email;
}

export function cleanIdentityAddresses(
  value: IdentityAddress[] | null,
): IdentityAddress[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value)) return undefined;
  const addresses: IdentityAddress[] = [];
  for (const address of value) {
    if (
      !address
      || (address.name !== null && typeof address.name !== 'string')
      || typeof address.email !== 'string'
      || /[\r\n]/.test(address.name ?? '')
    ) {
      return undefined;
    }
    const email = parseIdentityMailbox(address.email);
    if (!email) return undefined;
    addresses.push({ name: address.name, email });
  }
  return addresses;
}

function hasInvalidRasterDataUrl(html: string): boolean {
  const imageSource = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu;
  for (const match of html.matchAll(imageSource)) {
    const source = match[1] ?? match[2] ?? match[3] ?? '';
    if (!source.toLowerCase().startsWith('data:')) continue;
    const dataUrl = /^data:image\/(png|jpeg|gif|webp);base64,([a-z0-9+/]+={0,2})$/iu.exec(source);
    if (!dataUrl || dataUrl[2].length % 4 !== 0) return true;
  }
  return false;
}

export function validateIdentitySignatures(
  htmlSignature: unknown,
  textSignature: unknown,
): IdentitySignatureIssue | null {
  if (htmlSignature === undefined && textSignature === undefined) return null;
  if ((htmlSignature === undefined) !== (textSignature === undefined)) return 'invalid';
  const validValue = (value: unknown) => value === null || typeof value === 'string';
  if (!validValue(htmlSignature) || !validValue(textSignature)) return 'invalid';
  if (
    utf8ByteLength((htmlSignature as string | null) ?? '') >= IDENTITY_SIGNATURE_BYTE_LIMIT
    || utf8ByteLength((textSignature as string | null) ?? '') >= IDENTITY_SIGNATURE_BYTE_LIMIT
  ) {
    return 'too-large';
  }
  return typeof htmlSignature === 'string' && hasInvalidRasterDataUrl(htmlSignature)
    ? 'invalid'
    : null;
}

export function pickIdentityMutableFields(
  input: Record<string, unknown>,
): IdentityMutableFields {
  const fields: IdentityMutableFields = {};
  for (const key of MUTABLE_IDENTITY_FIELDS) {
    if (hasOwn(input, key)) {
      Object.assign(fields, { [key]: input[key] });
    }
  }
  return fields;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function textSignatureToHtml(value: string): string {
  if (!value) return '';
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => `<div>${line ? escapeHtml(line) : '<br>'}</div>`)
    .join('');
}
