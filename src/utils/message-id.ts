function randomToken(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID().replaceAll('-', '');
  if (cryptoRef?.getRandomValues) {
    const bytes = cryptoRef.getRandomValues(new Uint8Array(16));
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
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
  return `<${randomToken()}@${asciiDomain(domain) || 'localhost'}>`;
}

export function makeOperationId(): string {
  return randomToken();
}
