/**
 * Parse a free-form recipient input into a list of {name?, email}
 * pairs. Accepts the two RFC 5322 address shapes the compose UI lets
 * a user type:
 *
 *   alice@example.com
 *   "Alice Example" <alice@example.com>
 *
 * Comma-separated. Whitespace is trimmed. Quoted-display-name pairs
 * keep the inner text minus surrounding double quotes.
 */

export interface ParsedAddress {
  name?: string;
  email: string;
}

/**
 * Parse a single address token (one comma-separated entry) into a
 * {name?, email} pair. Handles both shapes above; the display name keeps
 * its inner text minus surrounding double quotes. Returns null for an
 * empty token.
 */
export function parseOneAddress(part: string): ParsedAddress | null {
  const trimmed = part.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^(.+?)\s*<(.+?)>$/);
  if (m) {
    return { name: m[1].trim().replace(/^"|"$/g, ''), email: m[2].trim() };
  }
  return { email: trimmed };
}

export function parseAddressList(input: string): ParsedAddress[] {
  if (!input) return [];
  return input
    .split(',')
    .map(parseOneAddress)
    .filter((a): a is ParsedAddress => a != null);
}
