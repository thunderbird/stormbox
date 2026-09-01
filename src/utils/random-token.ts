const UUID_BYTE_LENGTH = 16;
const FALLBACK_RANDOM_RANGE = 0x1_0000_0000_0000;

let fallbackSequence = 0;

function uuidFromBytes(source: Uint8Array): string {
  const bytes = Uint8Array.from(source);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`
    + `-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function timestampToken(): string {
  fallbackSequence = (fallbackSequence + 1) >>> 0;
  const timestamp = Math.max(0, Math.trunc(Date.now()))
    .toString(16)
    .padStart(12, '0')
    .slice(-12);
  const sequence = fallbackSequence.toString(16).padStart(8, '0');
  const random = Math.floor(Math.random() * FALLBACK_RANDOM_RANGE)
    .toString(16)
    .padStart(12, '0');
  const hex = `${timestamp}${sequence}${random}`;
  return uuidFromBytes(Uint8Array.from(
    { length: UUID_BYTE_LENGTH },
    (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  ));
}

export function randomToken(): string {
  const cryptoRef = globalThis.crypto;
  try {
    if (typeof cryptoRef?.randomUUID === 'function') {
      return cryptoRef.randomUUID();
    }
  } catch {
    // Continue through the bounded fallback chain.
  }
  try {
    if (typeof cryptoRef?.getRandomValues === 'function') {
      return uuidFromBytes(cryptoRef.getRandomValues(new Uint8Array(UUID_BYTE_LENGTH)));
    }
  } catch {
    // The timestamp fallback remains available without Web Crypto.
  }
  return timestampToken();
}
