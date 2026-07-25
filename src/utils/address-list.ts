/**
 * Address-list helpers for callers that only want the addresses.
 *
 * The parsing itself lives in `address-parse.ts`, which also reports the
 * fragments it could not read. This module is the narrower view: it drops
 * the rejections, which is only appropriate where nothing can be done
 * about them. A caller acting on user input should use the parser directly
 * and surface them (CS-2.4).
 */

import { parseAddressList as parseAddresses, type ParsedAddress } from './address-parse';

export type { ParsedAddress };

/**
 * Parse a display string into the one address it names, or null when it
 * names none. Used for header text the server has already validated —
 * a `from_text` — rather than for anything a user typed.
 */
export function parseOneAddress(part: string): ParsedAddress | null {
  return parseAddresses(part).addresses[0] ?? null;
}

/** Parse an address list, keeping only what parsed. */
export function parseAddressList(input: string): ParsedAddress[] {
  return parseAddresses(input).addresses;
}
