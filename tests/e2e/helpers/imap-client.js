import net from 'node:net';

import { getAccessToken } from './jmap-client.js';
import {
  IMAP_HOST,
  IMAP_PORT,
  TEST_OIDC_EMAIL,
  TEST_OIDC_PASSWORD,
} from './stack-env.js';

/**
 * Minimal IMAP4rev1 client for tests that act as an external, non-JMAP
 * mail client against the local Stalwart: the same account, the same
 * mailboxes, but through the protocol Thunderbird or Apple Mail would
 * use. Authenticates with the account's OIDC access token over SASL
 * OAUTHBEARER (RFC 7628); mailbox names are the JMAP `Mailbox.name`
 * values of top-level folders.
 */

const RESPONSE_TIMEOUT_MS = 20_000;

function quoted(value) {
  return `"${String(value).replace(/(["\\])/g, '\\$1')}"`;
}

function parseUidSearch(lines) {
  const uids = [];
  for (const line of lines) {
    // IMAP4rev1: `* SEARCH 12 13`; ESEARCH: `* ESEARCH (TAG "A3") UID ALL 12:13,15`.
    const legacy = line.match(/^\* SEARCH(?: (.*))?$/);
    if (legacy) {
      uids.push(...(legacy[1] ?? '').split(' ').filter(Boolean));
      continue;
    }
    const esearch = line.match(/^\* ESEARCH .*\bALL ([0-9:,]+)/);
    if (esearch) {
      for (const part of esearch[1].split(',')) {
        const [start, end] = part.split(':').map(Number);
        if (end == null) uids.push(String(start));
        else for (let uid = start; uid <= end; uid += 1) uids.push(String(uid));
      }
    }
  }
  return uids;
}

export async function connectImap({
  username = TEST_OIDC_EMAIL,
  password = TEST_OIDC_PASSWORD,
} = {}) {
  const token = await getAccessToken({ username, password });
  const socket = net.connect({ host: IMAP_HOST, port: IMAP_PORT });
  socket.setEncoding('utf8');

  let buffer = '';
  let tagCounter = 0;
  const waiting = [];
  let greeting = null;
  let resolveGreeting = null;
  const greeted = new Promise((resolve) => { resolveGreeting = resolve; });

  socket.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 2);
      if (greeting == null) {
        greeting = line;
        resolveGreeting(line);
        continue;
      }
      const current = waiting[0];
      if (!current) continue;
      current.lines.push(line);
      if (line.startsWith(`${current.tag} `)) {
        waiting.shift();
        clearTimeout(current.timer);
        current.resolve(current.lines);
      }
    }
  });
  socket.on('error', (error) => {
    for (const pending of waiting.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  });

  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  await greeted;
  if (!greeting.startsWith('* OK')) {
    socket.destroy();
    throw new Error(`IMAP greeting was not OK: ${greeting}`);
  }

  /** Send one tagged command; resolve with every response line, throw on NO/BAD. */
  function command(text) {
    const tag = `T${++tagCounter}`;
    return new Promise((resolve, reject) => {
      const entry = {
        tag,
        lines: [],
        resolve: (lines) => {
          const status = lines.at(-1);
          if (status.startsWith(`${tag} OK`)) resolve(lines);
          else reject(new Error(`IMAP ${text.split(' ')[0]} failed: ${status}`));
        },
        reject,
        timer: setTimeout(() => {
          const index = waiting.indexOf(entry);
          if (index >= 0) waiting.splice(index, 1);
          reject(new Error(`IMAP ${text.split(' ')[0]} timed out`));
        }, RESPONSE_TIMEOUT_MS),
      };
      waiting.push(entry);
      socket.write(`${tag} ${text}\r\n`);
    });
  }

  const gs2 = `n,a=${username},\x01host=${IMAP_HOST}\x01port=${IMAP_PORT}`
    + `\x01auth=Bearer ${token}\x01\x01`;
  await command(`AUTHENTICATE OAUTHBEARER ${Buffer.from(gs2).toString('base64')}`);

  return {
    command,
    select: (mailbox) => command(`SELECT ${quoted(mailbox)}`),
    /** UIDs in the selected mailbox whose Subject matches `subject`. */
    uidSearchSubject: async (subject) =>
      parseUidSearch(await command(`UID SEARCH SUBJECT ${quoted(subject)}`)),
    /** Poll the selected mailbox until `subject` resolves to at least one UID. */
    async waitForUidBySubject(subject, { timeoutMs = 15_000, intervalMs = 250 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const uids = await this.uidSearchSubject(subject);
        if (uids.length > 0) return uids[0];
        if (Date.now() >= deadline) {
          throw new Error(`IMAP never listed "${subject}" in the selected mailbox`);
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    },
    /** The move-to-Trash style of deletion, and the undo of one (RFC 6851). */
    uidMove: (uid, mailbox) => command(`UID MOVE ${uid} ${quoted(mailbox)}`),
    uidCopy: (uid, mailbox) => command(`UID COPY ${uid} ${quoted(mailbox)}`),
    /** The mark-as-deleted style of deletion: `uidStore(uid, '+FLAGS', '(\\Deleted)')`. */
    uidStore: (uid, action, flags) => command(`UID STORE ${uid} ${action} ${flags}`),
    expunge: () => command('EXPUNGE'),
    /** APPEND an RFC 5322 message with a non-synchronizing literal (LITERAL+). */
    append: (mailbox, rfc822, flags = '(\\Seen)') => {
      const bytes = Buffer.byteLength(rfc822, 'utf8');
      return command(`APPEND ${quoted(mailbox)} ${flags} {${bytes}+}\r\n${rfc822}`);
    },
    async logout() {
      try {
        await command('LOGOUT');
      } finally {
        socket.end();
      }
    },
  };
}
