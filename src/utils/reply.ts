/**
 * How a reply is addressed and threaded, computed from the parent's
 * structured fields rather than its rendered header text.
 *
 * Rendered text is what the old Reply All read, and it cannot answer the
 * questions that matter: which of these addresses is mine, is this one the
 * same person as that one, was there a Reply-To. The cache already holds
 * the parent's addresses one per row and its Message-ID and References
 * verbatim, so all of it is answerable without parsing anything back.
 */

import { addressKey } from './address-key';
import type { ParsedAddress } from './address-parse';

/** A `message_addresses` row, as the repository returns it. */
export interface MessageAddress {
  kind: string;
  position: number;
  name: string | null;
  email: string | null;
}

export interface ReplyAudience {
  to: ParsedAddress[];
  cc: ParsedAddress[];
}

export interface ThreadHeaders {
  /** Bare msg-ids, as RFC 8621 §4.1.3 and the cache both hold them. */
  inReplyTo: string[];
  references: string[];
}

const KIND = {
  FROM: 'from',
  TO: 'to',
  CC: 'cc',
  REPLY_TO: 'replyTo',
} as const;

function pick(addresses: readonly MessageAddress[], kind: string): ParsedAddress[] {
  return addresses
    .filter((row) => row.kind === kind && row.email)
    .sort((a, b) => a.position - b.position)
    .map((row) => ({
      ...(row.name?.trim() ? { name: row.name.trim() } : {}),
      email: row.email as string,
    }));
}

function key(address: ParsedAddress): string {
  return addressKey(address.email);
}

/**
 * Keep the first occurrence of each address, skipping any the caller
 * already has and any that belong to the user.
 */
function collect(
  out: ParsedAddress[],
  seen: Set<string>,
  candidates: readonly ParsedAddress[],
): void {
  for (const candidate of candidates) {
    const id = key(candidate);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(candidate);
  }
}

/**
 * Decide who a reply goes to.
 *
 * `all` distinguishes the two commands: a plain reply is narrow — the
 * author and nobody else — while Reply All carries the original audience
 * forward. Neither copies Bcc: those recipients were hidden from everyone
 * else on the message, and revealing them in a reply would be a
 * disclosure the sender deliberately avoided.
 *
 * Every address the user owns is removed, so a reply does not mail the user
 * their own copy. Replying to a message the user sent is the one case where
 * that would leave nobody, and there the people it was sent to are the
 * audience — which is what replying to something you sent means.
 *
 * Whether the user sent it is a fact about From alone. Reply-To says where
 * the author wants replies, and on someone else's message it can name the
 * user's own address without making the message theirs; reading it as
 * authorship put the whole original To into a plain reply to a message the
 * user never sent.
 */
export function buildReplyAudience({
  addresses,
  ownedEmails = [],
  all = false,
}: {
  addresses: readonly MessageAddress[];
  ownedEmails?: readonly (string | null | undefined)[];
  all?: boolean;
}): ReplyAudience {
  // Keyed with `addressKey` (CS-3.5): identity rows and server-returned
  // addresses can spell the same address in different Unicode normalization
  // forms or as U-label vs punycode, and any mismatch here leaves the user's
  // own address in the audience of their own reply.
  const owned = new Set(
    ownedEmails
      .filter((email): email is string => !!email)
      .map((email) => addressKey(email))
      .filter(Boolean),
  );
  const originalTo = pick(addresses, KIND.TO);
  const originalCc = pick(addresses, KIND.CC);
  // RFC 5322 §3.6.2: Reply-To names where the author wants replies sent,
  // and it exists precisely to override From.
  const replyTo = pick(addresses, KIND.REPLY_TO);
  const from = pick(addresses, KIND.FROM);
  const target = replyTo.length > 0 ? replyTo : from;
  const selfAuthored = from.length > 0 && from.every((a) => owned.has(key(a)));
  const notOwned = (candidates: readonly ParsedAddress[]) =>
    candidates.filter((a) => !owned.has(key(a)));

  const to: ParsedAddress[] = [];
  const seen = new Set<string>();
  if (selfAuthored) {
    collect(to, seen, notOwned(originalTo));
    // A message the user sent with a Cc and no To was still sent to those
    // people, and they are the audience this rule means. Without this the
    // composer opened addressed to the user themselves.
    if (to.length === 0) collect(to, seen, notOwned(originalCc));
    // Sent to nobody but the user: a note to self, which replies to them.
    if (to.length === 0) collect(to, seen, originalTo);
  } else {
    collect(to, seen, notOwned(target));
    // A Reply-To naming only the user leaves nobody to reply to, and the
    // author is who is left.
    if (to.length === 0) collect(to, seen, notOwned(from));
  }
  // Nothing on the message is anybody but the user: a note to self, which
  // replies to the user.
  if (to.length === 0) collect(to, seen, target);

  const cc: ParsedAddress[] = [];
  if (all) {
    for (const id of owned) seen.add(id);
    collect(cc, seen, originalTo);
    collect(cc, seen, originalCc);
  }
  return { to, cc };
}

function parseIdList(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((id): id is string => typeof id === 'string')
      .map((id) => id.replace(/^<|>$/g, '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Build the threading headers for a reply to this message.
 *
 * RFC 5322 §3.6.4: In-Reply-To is the parent's Message-ID, and References
 * is the parent's References with the parent's own Message-ID appended.
 * When the parent has no References — it started the thread — its
 * In-Reply-To stands in, which keeps a chain intact across a client that
 * sent one header but not the other.
 *
 * A parent with no Message-ID cannot be threaded to at all, and inventing
 * one would attach the reply to nothing. Subject prefixing is not
 * threading (CS-2.6), so the reply simply carries no threading headers.
 */
export function buildThreadHeaders(parent: {
  rfc822_message_id?: string | null;
  references_json?: string | null;
  in_reply_to_json?: string | null;
}): ThreadHeaders {
  const parentId = parent.rfc822_message_id?.replace(/^<|>$/g, '').trim();
  if (!parentId) return { inReplyTo: [], references: [] };
  const inherited = parseIdList(parent.references_json);
  // RFC 5322 §3.6.4 allows In-Reply-To to stand in for missing References
  // only when it "contains a single message identifier"; with more than one
  // the chain is the parent's Message-ID alone.
  const substitute = parseIdList(parent.in_reply_to_json);
  const chain = inherited.length > 0
    ? inherited
    : (substitute.length === 1 ? substitute : []);
  const references = [...chain.filter((id) => id !== parentId), parentId];
  return { inReplyTo: [parentId], references };
}
