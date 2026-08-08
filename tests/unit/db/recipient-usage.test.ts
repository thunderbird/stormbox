import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SERVICE_KIND } from '../../../src/constants/states';
import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers, noopBroadcaster } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';

let engine: any;
let h: any;
const ACCOUNT = 1;
const SENT_FOLDER = 20;
const NOW = Date.UTC(2026, 0, 15);
let messageSeq = 0;

beforeEach(async () => {
  engine = await bootTestEngine();
  h = makeHandlers(engine, noopBroadcaster());
  messageSeq = 0;
  await engine.run(
    `INSERT INTO accounts(
       id, display_name, primary_email, server_origin, remote_account_id,
       created_at, updated_at
     ) VALUES (?, 'Me', 'me@example.com', 'https://mail.example.com', 'acct-1', 0, 0)`,
    [ACCOUNT],
  );
  await engine.run(
    `INSERT INTO folders(id, account_id, remote_id, name, role, updated_at)
     VALUES (?, ?, 'sent', 'Sent', 'sent', 0)`,
    [SENT_FOLDER, ACCOUNT],
  );
  await h[DB_RPC.ADDRESSBOOK_UPSERT_MANY]({
    accountId: ACCOUNT,
    serviceKind: SERVICE_KIND.JMAP_CONTACTS,
    addressbooks: [{ remoteId: 'ab', name: 'Contacts', isDefault: true }],
  });
  const book = await engine.get('SELECT id FROM addressbooks WHERE remote_id = ?', ['ab']);
  await h[DB_RPC.CONTACT_UPSERT_MANY]({
    accountId: ACCOUNT,
    contacts: [
      {
        remoteId: 'c-alice',
        addressbookIds: [book.id],
        displayName: 'Alice',
        emails: [{ email: 'alice@example.com' }],
      },
      {
        remoteId: 'c-bob',
        addressbookIds: [book.id],
        displayName: 'Bob',
        emails: [{ email: 'bob@example.com' }],
      },
    ],
  });
});

afterEach(async () => {
  await engine.close();
});

async function sentMessage({
  from = 'me@example.com',
  to = [],
  cc = [],
  bcc = [],
  sentAt = NOW,
}: {
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  sentAt?: number;
}) {
  messageSeq += 1;
  const id = messageSeq;
  await engine.run(
    `INSERT INTO messages(
       id, account_id, remote_id, sent_at, metadata_fetched_at, updated_at
     ) VALUES (?, ?, ?, ?, 0, 0)`,
    [id, ACCOUNT, `m-${id}`, sentAt],
  );
  await engine.run(
    `INSERT INTO folder_messages(folder_id, message_id, account_id, sort_sent_at)
     VALUES (?, ?, ?, ?)`,
    [SENT_FOLDER, id, ACCOUNT, sentAt],
  );
  let position = 0;
  for (const [kind, values] of Object.entries({ from: [from], to, cc, bcc })) {
    for (const email of values) {
      await engine.run(
        `INSERT INTO message_addresses(message_id, kind, position, email)
         VALUES (?, ?, ?, ?)`,
        [id, kind, position, email],
      );
      position += 1;
    }
  }
}

async function rebuild(limit = 300) {
  return h[DB_RPC.RECIPIENT_USAGE_REBUILD]({ accountId: ACCOUNT, limit });
}

async function usageRows() {
  return engine.all(
    `SELECT email_key, send_count, last_sent_at
       FROM recipient_usage
      WHERE account_id = ?
      ORDER BY email_key`,
    [ACCOUNT],
  );
}

describe('recipient usage cache', () => {
  it('ranks only contacts from mail authored by an owned identity', async () => {
    await sentMessage({
      to: ['alice@example.com', 'not-a-contact@example.com'],
      cc: ['bob@example.com'],
      bcc: ['alice@example.com'],
    });
    await sentMessage({ from: 'other@example.com', to: ['alice@example.com'] });

    expect(await rebuild()).toEqual({ scanned: 2, ranked: 2 });
    expect(await usageRows()).toEqual([
      { email_key: 'alice@example.com', send_count: 1, last_sent_at: NOW },
      { email_key: 'bob@example.com', send_count: 1, last_sent_at: NOW },
    ]);
  });

  it('counts one canonical address once per message and keeps newest recency', async () => {
    await sentMessage({
      to: ['Alice@Example.com'],
      cc: ['alice@example.com'],
      sentAt: NOW - 10_000,
    });
    await sentMessage({ bcc: ['alice@example.com'], sentAt: NOW });

    await rebuild();
    expect(await usageRows()).toEqual([
      { email_key: 'alice@example.com', send_count: 2, last_sent_at: NOW },
    ]);
  });

  it('uses a rolling newest-message window and replaces the prior snapshot', async () => {
    await sentMessage({ to: ['alice@example.com'], sentAt: NOW - 20_000 });
    await sentMessage({ to: ['bob@example.com'], sentAt: NOW - 10_000 });
    await sentMessage({ to: ['bob@example.com'], sentAt: NOW });

    await rebuild(2);
    expect(await usageRows()).toEqual([
      { email_key: 'bob@example.com', send_count: 2, last_sent_at: NOW },
    ]);

    await engine.run(`UPDATE contacts SET is_deleted = 1 WHERE remote_id = 'c-bob'`);
    await rebuild(2);
    expect(await usageRows()).toEqual([]);
  });
});
