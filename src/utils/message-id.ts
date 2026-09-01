import { randomToken } from './random-token';

function compactRandomToken(): string {
  return randomToken().replaceAll('-', '');
}

export function normalizeMessageId(value: string): string {
  return value.replace(/^<|>$/g, '');
}

/** Returns null when a server value cannot be read as Message-ID values. */
export function normalizeMessageIds(value: unknown): string[] | null {
  if (value == null) return [];
  const messageIds = typeof value === 'string'
    ? [value]
    : Array.isArray(value) && value.every((messageId) => typeof messageId === 'string')
      ? value
      : null;
  return messageIds?.map(normalizeMessageId) ?? null;
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

function isMessageIdRight(value: string): boolean {
  if (value.startsWith('[') && value.endsWith(']')) {
    return /^[\x21-\x5a\x5e-\x7e]*$/.test(value.slice(1, -1));
  }
  return value.split('.').every(
    (atom) => atom.length > 0 && /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+$/.test(atom),
  );
}

function asciiDomain(domain: string): string {
  if (!domain) return '';
  if (isAscii(domain)) return isMessageIdRight(domain) ? domain : '';
  try {
    const parsed = new URL(`http://${domain}`);
    if (parsed.username || parsed.password || parsed.port
        || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return '';
    }
    return isAscii(parsed.hostname) && isMessageIdRight(parsed.hostname)
      ? parsed.hostname
      : '';
  } catch {
    return '';
  }
}

export function makeMessageId(identityEmail: string | null | undefined): string {
  const at = String(identityEmail ?? '').lastIndexOf('@');
  const domain = at > -1 ? String(identityEmail).slice(at + 1).trim() : '';
  return `<${compactRandomToken()}@${asciiDomain(domain) || 'localhost'}>`;
}

export function makeOperationId(): string {
  return compactRandomToken();
}
