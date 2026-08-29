export function createContactUid(): string {
  return `urn:uuid:${crypto.randomUUID()}`;
}

export function createContactMapKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function isContactUid(value: unknown): value is string {
  return typeof value === 'string'
    && /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
}

export function normalizeContactUid(value: unknown): string | null {
  return isContactUid(value) ? value.toLowerCase() : null;
}
