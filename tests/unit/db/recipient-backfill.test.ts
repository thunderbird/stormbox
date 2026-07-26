import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SERVICE_KIND } from '../../../src/constants/states';
import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers, noopBroadcaster } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';

/**
 * The Sent-folder backfill (T503).
 *
 * Three things make this worth testing rather than trusting: it decides what
 * counts as the user's own mail, it must stop where it said it stopped, and
 * it must not run away with a large mailbox. Each is a case below.
 */

let engine: any;
let h: any;
const ACCOUNT = 1;
const SENT_FOLDER = 20;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 0, 15);

beforeEach(async () => {
  engine = await bootTestEngine();
  h = makeHandlers(engine, noopBroadcaster());
  await engine.run(
    `INSERT INTO accounts(
       id, display_name, primary_email, server_origin, remote_account_id,
       created_at, updated_at
     ) VALUES (?, 'Me', 'me@example.com', 'https://mail.example.com', 'acct-1', 0, 0)`,
    [ACCOUNT],
  );
});

afterEach(async () => {
  await engine.close();
});

async function sentFolder(role = 'sent') {
  await engine.run(
    `INSERT INTO folders(id, account_id, remote_id, name, role, updated_at)
     VALUES (?, ?, 'f-sent', 'Sent', ?, 0)`,
    [SENT_FOLDER, ACCOUNT, role],
  );
}

let messageSeq = 0;

/** A message in the Sent folder, with the addresses it carried. */
async function sentMessage({
  from, to = [], cc = [], bcc = [], sentAt = NOW, folderId = SENT_FOLDER,
}: {
  from: string | null;
  to?: (string | { email: string; name: string })[];
  cc?: string[];
  bcc?: string[];
  sentAt?: number | null;
  folderId?: number;
}) {
  messageSeq += 1;
  const id = messageSeq;
  await engine.run(
    `INSERT INTO messages(
       id, account_id, remote_id, rfc822_message_id, subject,
       metadata_fetched_at, updated_at
     ) VALUES (?, ?, ?, ?, 'sent thing', 0, 0)`,
    [id, ACCOUNT, `m-${id}`, `<m-${id}@example.com>`],
  );
  await engine.run(
    `INSERT INTO folder_messages(folder_id, message_id, account_id, sort_sent_at)
     VALUES (?, ?, ?, ?)`,
    [folderId, id, ACCOUNT, sentAt],
  );
  let position = 0;
  const add = async (kind: string, value: string | { email: string; name: string }) => {
    const email = typeof value === 'string' ? value : value.email;
    const name = typeof value === 'string' ? null : value.name;
    await engine.run(
      `INSERT INTO message_addresses(message_id, kind, position, name, email)
       VALUES (?, ?, ?, ?, ?)`,
      [id, kind, position, name, email],
    );
    position += 1;
  };
  if (from) await add('from', from);
  for (const value of to) await add('to', value);
  for (const value of cc) await add('cc', value);
  for (const value of bcc) await add('bcc', value);
  return id;
}

function backfill(params: any = {}) {
  return h[DB_RPC.RECIPIENT_HISTORY_BACKFILL]({ accountId: ACCOUNT, ...params });
}

async function historyRows() {
  return engine.all(
    `SELECT email, name, send_count, last_sent_at FROM recipient_history
      WHERE account_id = ? ORDER BY email_key`,
    [ACCOUNT],
  );
}

describe('recipient history backfill', () => {
  it('does not count a batch it could not record having read', async () => {
    // The counts and the cursor that says they were taken have to land
    // together. Committed apart, a crash between them leaves the counts raised
    // and the cursor where it was, so the next pass reads the same messages and
    // raises them again — and send frequency is a ranking input, so whichever
    // batch was interrupted quietly climbs the list.
    await sentFolder();
    await sentMessage({
      from: 'me@example.com', to: ['twice@example.com'], sentAt: NOW,
    });

    // Fail the checkpoint the way a crash would: after the learning, before
    // the transaction can commit.
    await engine.run(
      `CREATE TRIGGER no_checkpoint BEFORE INSERT ON sync_states
         BEGIN SELECT RAISE(ABORT, 'checkpoint refused'); END`,
    );
    await expect(backfill({ batchSize: 200 })).rejects.toThrow(/checkpoint refused/);
    expect(
      await historyRows(),
      'the counts must go back with the cursor that was never written',
    ).toEqual([]);

    await engine.run('DROP TRIGGER no_checkpoint');
    const retried = await backfill({ batchSize: 200 });

    expect(retried.learned).toBe(1);
    const rows = await historyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].send_count, 'one message, counted once').toBe(1);
  });

  it('learns the recipients of mail the user sent', async () => {
    await sentFolder();
    await sentMessage({
      from: 'me@example.com',
      to: [{ email: 'colleague@example.com', name: 'A Colleague' }],
      cc: ['cc@example.com'],
      // CS-3.13: Bcc is collected. The user addressed them deliberately, and
      // the history never leaves the device.
      bcc: ['secret@example.com'],
    });

    const result = await backfill();
    expect(result.scanned).toBe(1);
    expect(await historyRows()).toEqual([
      { email: 'cc@example.com', name: null, send_count: 1, last_sent_at: NOW },
      { email: 'colleague@example.com', name: 'A Colleague', send_count: 1, last_sent_at: NOW },
      { email: 'secret@example.com', name: null, send_count: 1, last_sent_at: NOW },
    ]);
  });

  it('ignores mail in the Sent folder that the user did not send', async () => {
    await sentFolder();
    // An imported or shared mailbox holds other people's sent mail. Being
    // in a folder called Sent is not evidence of authorship.
    await sentMessage({ from: 'someone.else@example.com', to: ['stranger@example.com'] });
    await sentMessage({ from: null, to: ['headerless@example.com'] });
    await sentMessage({ from: 'me@example.com', to: ['real@example.com'] });

    await backfill();
    expect((await historyRows()).map((r: any) => r.email)).toEqual(['real@example.com']);
  });

  it('recognises an alias as the user, not a stranger', async () => {
    await sentFolder();
    await engine.run(
      `INSERT INTO identities(account_id, remote_id, name, email, updated_at)
       VALUES (?, 'i-alias', 'Alias', 'alias@example.com', 0)`,
      [ACCOUNT],
    );
    await sentMessage({ from: 'Alias@Example.com', to: ['viaalias@example.com'] });

    await backfill();
    expect((await historyRows()).map((r: any) => r.email)).toEqual(['viaalias@example.com']);
  });

  it('does not learn the user\'s own address as a recipient', async () => {
    await sentFolder();
    await sentMessage({ from: 'me@example.com', to: ['me@example.com', 'other@example.com'] });

    await backfill();
    expect((await historyRows()).map((r: any) => r.email)).toEqual(['other@example.com']);
  });

  it('counts repeat recipients and keeps the most recent send', async () => {
    await sentFolder();
    await sentMessage({ from: 'me@example.com', to: ['often@example.com'], sentAt: NOW - 9 * DAY });
    await sentMessage({ from: 'me@example.com', to: ['often@example.com'], sentAt: NOW - 2 * DAY });
    await sentMessage({ from: 'me@example.com', to: ['often@example.com'], sentAt: NOW - 5 * DAY });

    await backfill();
    const [row] = await historyRows();
    expect(row.send_count).toBe(3);
    expect(row.last_sent_at).toBe(NOW - 2 * DAY);
  });

  it('resumes where it stopped instead of starting again', async () => {
    await sentFolder();
    for (let i = 0; i < 5; i += 1) {
      await sentMessage({
        from: 'me@example.com', to: [`p${i}@example.com`], sentAt: NOW - i * DAY,
      });
    }

    const first = await backfill({ batchSize: 2 });
    expect(first.scanned).toBe(2);
    expect(first.done).toBe(false);
    // Newest first, so the two most recent are the ones already learned.
    expect((await historyRows()).map((r: any) => r.email))
      .toEqual(['p0@example.com', 'p1@example.com']);

    const second = await backfill({ batchSize: 2 });
    expect(second.scanned).toBe(2);
    // Not the same two again: a resume that restarted would count each send
    // twice and never reach the end of a long folder.
    expect((await historyRows()).map((r: any) => r.email)).toEqual([
      'p0@example.com', 'p1@example.com', 'p2@example.com', 'p3@example.com',
    ]);
    expect((await historyRows()).every((r: any) => r.send_count === 1)).toBe(true);

    const third = await backfill({ batchSize: 2 });
    expect(third.scanned).toBe(1);
    // A short batch is not the end of the folder. Only the message budget
    // finishes this work; see the case below.
    expect(third.done).toBe(false);
  });

  it('keeps reading a Sent folder that is still filling in', async () => {
    // The folder arrives in pieces: `folder_messages` grows as Sent syncs and
    // as the user pages back through it. A batch shorter than the one asked
    // for therefore means "nothing more cached yet", not "no more mail" — and
    // treating it as the end retired the backfill after a single message.
    await sentFolder();
    await sentMessage({
      from: 'me@example.com', to: ['early@example.com'], sentAt: NOW,
    });

    const first = await backfill({ batchSize: 200 });
    expect(first.scanned).toBe(1);
    expect(first.done, 'one cached message is not a finished folder').toBe(false);

    // Older mail syncs afterwards, which is past the cursor.
    await sentMessage({
      from: 'me@example.com', to: ['later@example.com'], sentAt: NOW - DAY,
    });

    const second = await backfill({ batchSize: 200 });
    expect(second.scanned, 'the mail that arrived later is read').toBe(1);
    expect((await historyRows()).map((r: any) => r.email))
      .toEqual(['early@example.com', 'later@example.com']);
  });

  it('reads nothing, and gives nothing up, until it knows an address of the user\'s own', async () => {
    // Identities sync separately and a failure there is warned about rather
    // than fatal. With none known, every message looks like someone else's:
    // the scan would skip the lot and leave the cursor past them for good.
    await sentFolder();
    await sentMessage({
      from: 'me@example.com', to: ['friend@example.com'], sentAt: NOW,
    });
    await engine.run('UPDATE accounts SET primary_email = NULL WHERE id = ?', [ACCOUNT]);
    await engine.run('DELETE FROM identities WHERE account_id = ?', [ACCOUNT]);

    const blind = await backfill({ batchSize: 200 });
    expect(blind.scanned, 'nothing is read while the account has no address').toBe(0);
    expect(blind.done).toBe(false);
    expect(await historyRows()).toEqual([]);

    // Once an identity arrives the same message is still there to be read.
    await engine.run(
      'UPDATE accounts SET primary_email = ? WHERE id = ?',
      ['me@example.com', ACCOUNT],
    );
    const sighted = await backfill({ batchSize: 200 });
    expect(sighted.scanned, 'and the message was not consumed by the blind pass').toBe(1);
    expect((await historyRows()).map((r: any) => r.email)).toEqual(['friend@example.com']);
  });

  it('stops at the message bound rather than reading the whole folder', async () => {
    await sentFolder();
    for (let i = 0; i < 10; i += 1) {
      await sentMessage({
        from: 'me@example.com', to: [`p${i}@example.com`], sentAt: NOW - i * DAY,
      });
    }

    const result = await backfill({ batchSize: 4, maxMessages: 6 });
    expect(result.scanned).toBe(4);
    const second = await backfill({ batchSize: 4, maxMessages: 6 });
    // Two, not four: the bound is on messages read, not on batches.
    expect(second.scanned).toBe(2);
    expect(second.done).toBe(true);
    expect(await historyRows()).toHaveLength(6);

    // And it stays finished.
    expect((await backfill({ batchSize: 4, maxMessages: 6 })).scanned).toBe(0);
  });

  it('skips a message with no send time rather than misordering the scan', async () => {
    await sentFolder();
    await sentMessage({ from: 'me@example.com', to: ['timed@example.com'], sentAt: NOW });
    await sentMessage({ from: 'me@example.com', to: ['untimed@example.com'], sentAt: null });

    await backfill();
    // "The newest N" has no meaning for a message with no time, so it is
    // left out rather than given an arbitrary place in the order.
    expect((await historyRows()).map((r: any) => r.email)).toEqual(['timed@example.com']);
  });

  it('waits for a Sent folder rather than declaring itself finished', async () => {
    // The first pass can run before mail has synced. Retiring the backfill
    // then would leave the account without one for good.
    const early = await backfill();
    expect(early.done).toBe(false);

    await sentFolder();
    await sentMessage({ from: 'me@example.com', to: ['late@example.com'] });
    const later = await backfill();
    expect(later.scanned).toBe(1);
    expect((await historyRows()).map((r: any) => r.email)).toEqual(['late@example.com']);
  });

  it('waits for the Sent folder to have mail in it, too', async () => {
    // The folder syncs before its messages do. An empty read at that moment
    // is "not yet", not "nothing to do".
    await sentFolder();
    const early = await backfill();
    expect(early.scanned).toBe(0);
    expect(early.done).toBe(false);

    await sentMessage({ from: 'me@example.com', to: ['arrived@example.com'] });
    await backfill();
    expect((await historyRows()).map((r: any) => r.email)).toEqual(['arrived@example.com']);
  });

  it('reads only the Sent folder', async () => {
    await sentFolder();
    await engine.run(
      `INSERT INTO folders(id, account_id, remote_id, name, role, updated_at)
       VALUES (99, ?, 'f-inbox', 'Inbox', 'inbox', 0)`,
      [ACCOUNT],
    );
    await sentMessage({ from: 'me@example.com', to: ['sent@example.com'] });
    await sentMessage({ from: 'me@example.com', to: ['inbox@example.com'], folderId: 99 });

    await backfill();
    expect((await historyRows()).map((r: any) => r.email)).toEqual(['sent@example.com']);
  });

  it('leaves a suggestion the user removed removed', async () => {
    await sentFolder();
    await sentMessage({ from: 'me@example.com', to: ['unwanted@example.com'] });
    await h[DB_RPC.RECIPIENT_HISTORY_RECORD]({
      accountId: ACCOUNT, recipients: [{ email: 'unwanted@example.com', name: 'Unwanted' }],
    });
    await h[DB_RPC.RECIPIENT_HISTORY_SUPPRESS]({ accountId: ACCOUNT, email: 'unwanted@example.com' });

    await backfill();
    const suggestions = await h[DB_RPC.CONTACT_AUTOCOMPLETE]({
      accountId: ACCOUNT, prefix: 'unwanted', limit: 10,
    });
    expect(suggestions).toEqual([]);
  });

  it('does not let a backfilled send look newer than it was', async () => {
    await sentFolder();
    await sentMessage({
      from: 'me@example.com', to: ['old@example.com'], sentAt: NOW - 500 * DAY,
    });
    // Learned live today, which is the more recent truth.
    await h[DB_RPC.RECIPIENT_HISTORY_RECORD]({
      accountId: ACCOUNT, recipients: [{ email: 'old@example.com', name: 'Old' }],
    });
    const before = await engine.get(
      `SELECT last_sent_at FROM recipient_history WHERE account_id = ?`, [ACCOUNT],
    );

    await backfill();
    const after = await engine.get(
      `SELECT last_sent_at, send_count FROM recipient_history WHERE account_id = ?`, [ACCOUNT],
    );
    expect(after.last_sent_at).toBe(before.last_sent_at);
    expect(after.send_count).toBe(2);
  });

  it('starts over rather than giving up on an unreadable checkpoint', async () => {
    await sentFolder();
    await sentMessage({ from: 'me@example.com', to: ['p@example.com'] });
    await engine.run(
      `INSERT INTO sync_states(account_id, object_type, scope, state, updated_at)
       VALUES (?, 'RecipientHistoryBackfill', '', 'not json', 0)`,
      [ACCOUNT],
    );

    const result = await backfill();
    expect(result.scanned).toBe(1);
  });
});
