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

export function parseAddressList(input: string): ParsedAddress[] {
  if (!input) return [];
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^(.+?)\s*<(.+?)>$/);
      if (m) {
        return { name: m[1].trim().replace(/^"|"$/g, ''), email: m[2].trim() };
      }
      return { email: part };
    });
}
