import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { fetchEmailBodies } from '../../../src/sync/backends/jmap/bodies';
import { syncMailboxes } from '../../../src/sync/backends/jmap/mailboxes';
import { syncFolderWindow } from '../../../src/sync/backends/jmap/messages';
import { MockTransport } from './_mock-transport';

let engine;
let handlers;
let account;
let inbox;

const NOW = Date.parse('2026-05-01T12:00:00Z');

function emailListFixture(id) {
  return {
    id,
    blobId: `blob-${id}`,
    threadId: `thr-${id}`,
    mailboxIds: { 'mb-inbox': true },
    keywords: {},
    size: 1234,
    receivedAt: new Date(NOW).toISOString(),
    sentAt: new Date(NOW - 1000).toISOString(),
    messageId: [`<${id}@example.com>`],
    inReplyTo: null,
    references: null,
    sender: [{ email: 'sender@example.com' }],
    from: [{ email: 'from@example.com' }],
    to: [{ email: 'to@example.com' }],
    cc: null,
    bcc: null,
    replyTo: null,
    subject: `s-${id}`,
    preview: `p-${id}`,
    hasAttachment: false,
  };
}

beforeEach(async () => {
  engine = await bootTestEngine();
  handlers = makeHandlers(engine);
  account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
    displayName: 'T',
    primaryEmail: 't@example.com',
    serverOrigin: 'https://mail.example.com',
    remoteAccountId: 'acct-1',
    isPrimary: true,
  })).row;

  // Seed a folder + a message so fetchEmailBodies has something to attach to.
  const mb = new MockTransport();
  mb.handle('Mailbox/get', () => ({
    list: [{ id: 'mb-inbox', name: 'Inbox', role: 'inbox' }],
    state: 's',
  }));
  await syncMailboxes({ transport: mb, account, handlers });
  inbox = await engine.get(
    'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
    [account.id, 'mb-inbox'],
  );
  const tx = new MockTransport();
  tx.handle('Email/query', () => ({
    ids: ['e-1'],
    total: 1,
    queryState: 'qs',
    canCalculateChanges: true,
    position: 0,
  }));
  tx.handle('Email/get', (params) => ({
    list: params.ids.map(emailListFixture),
    state: 'es',
  }));
  await syncFolderWindow({ transport: tx, account, folder: inbox, handlers });
});

afterEach(async () => {
  await engine.close();
});

describe('fetchEmailBodies', () => {
  it('persists multipart/alternative tree as body_parts and body_values', async () => {
    const transport = new MockTransport();
    transport.handle('Email/get', () => ({
      list: [{
        id: 'e-1',
        blobId: 'blob-e-1',
        threadId: 'thr-e-1',
        mailboxIds: { 'mb-inbox': true },
        keywords: {},
        bodyStructure: {
          partId: '0',
          type: 'multipart/alternative',
          subParts: [
            { partId: '1', type: 'text/plain', size: 12, charset: 'utf-8' },
            { partId: '2', type: 'text/html', size: 40, charset: 'utf-8' },
          ],
        },
        textBody: [{ partId: '1', type: 'text/plain' }],
        htmlBody: [{ partId: '2', type: 'text/html' }],
        attachments: [],
        bodyValues: {
          1: { value: 'Hello world.', isTruncated: false },
          2: { value: '<p>Hello <strong>world</strong>.</p>', isTruncated: false },
        },
      }],
      state: 'es',
    }));

    const result = await fetchEmailBodies({
      transport, account, handlers,
      remoteIds: ['e-1'],
    });
    expect(result.fetched).toBe(1);

    const messageRow = await handlers[DB_RPC.MESSAGE_GET_BY_REMOTE]({
      accountId: account.id,
      remoteId: 'e-1',
    });
    const parts = await engine.all(
      'SELECT part_id, media_type, parent_part_id, is_body_text, is_body_html FROM body_parts WHERE message_id = ? ORDER BY position',
      [messageRow.id],
    );
    expect(parts).toHaveLength(3);
    expect(parts.map((p) => p.media_type)).toEqual(['multipart/alternative', 'text/plain', 'text/html']);
    expect(parts[1].parent_part_id).toBe('0');
    expect(Number(parts[1].is_body_text)).toBe(1);
    expect(Number(parts[2].is_body_html)).toBe(1);

    const values = await engine.all(
      'SELECT part_id, kind, value FROM body_values WHERE message_id = ? ORDER BY part_id',
      [messageRow.id],
    );
    expect(values).toHaveLength(2);
    expect(values.find((v) => v.kind === 'text').value).toBe('Hello world.');
    expect(values.find((v) => v.kind === 'html').value).toMatch(/<strong>/);

    const stamped = await engine.get(
      'SELECT body_fetched_at FROM messages WHERE id = ?',
      [messageRow.id],
    );
    expect(stamped.body_fetched_at).not.toBeNull();
  });

  it('classifies a plaintext-only body as text even when htmlBody echoes the text/plain part', async () => {
    // RFC 8621: a message with no text/html alternative still lists its
    // single text/plain part in BOTH textBody and htmlBody. The classifier
    // must key off the part's media type, otherwise the plaintext is stored
    // as kind='html' and the viewer renders it through the HTML iframe,
    // collapsing newlines into one unformatted block (issue #25).
    const transport = new MockTransport();
    transport.handle('Email/get', () => ({
      list: [{
        id: 'e-1',
        blobId: 'blob-e-1',
        threadId: 'thr-e-1',
        mailboxIds: { 'mb-inbox': true },
        keywords: {},
        bodyStructure: { partId: '1', type: 'text/plain', charset: 'utf-8' },
        textBody: [{ partId: '1', type: 'text/plain' }],
        htmlBody: [{ partId: '1', type: 'text/plain' }],
        attachments: [],
        bodyValues: {
          1: { value: 'line one\nline two\n\nindented:\n    spaced', isTruncated: false },
        },
      }],
      state: 'es',
    }));

    await fetchEmailBodies({ transport, account, handlers, remoteIds: ['e-1'] });

    const messageRow = await handlers[DB_RPC.MESSAGE_GET_BY_REMOTE]({
      accountId: account.id,
      remoteId: 'e-1',
    });
    const values = await engine.all(
      'SELECT kind, value FROM body_values WHERE message_id = ?',
      [messageRow.id],
    );
    expect(values).toHaveLength(1);
    expect(values[0].kind).toBe('text');

    const body = await handlers[DB_RPC.MESSAGE_BODY_READ]({ messageId: messageRow.id });
    expect(body.text).toBe('line one\nline two\n\nindented:\n    spaced');
    expect(body.html).toBe('');
  });

  it('records is_truncated when the server reports a truncated body value', async () => {
    const transport = new MockTransport();
    transport.handle('Email/get', () => ({
      list: [{
        id: 'e-1',
        blobId: 'blob-e-1',
        threadId: 'thr-e-1',
        mailboxIds: { 'mb-inbox': true },
        keywords: {},
        bodyStructure: { partId: '1', type: 'text/plain' },
        textBody: [{ partId: '1' }],
        htmlBody: [],
        attachments: [],
        bodyValues: {
          1: { value: 'truncated...', isTruncated: true },
        },
      }],
      state: 'es',
    }));
    await fetchEmailBodies({ transport, account, handlers, remoteIds: ['e-1'] });
    const row = await engine.get(
      `SELECT is_truncated FROM body_values
        WHERE message_id = (SELECT id FROM messages WHERE remote_id = ?)`,
      ['e-1'],
    );
    expect(Number(row.is_truncated)).toBe(1);
  });

  it('marks attachment parts is_attachment=1 in body_parts', async () => {
    const transport = new MockTransport();
    transport.handle('Email/get', () => ({
      list: [{
        id: 'e-1',
        blobId: 'blob-e-1',
        threadId: 'thr-e-1',
        mailboxIds: { 'mb-inbox': true },
        keywords: {},
        bodyStructure: {
          partId: '0',
          type: 'multipart/mixed',
          subParts: [
            { partId: '1', type: 'text/plain' },
            { partId: '2', type: 'application/pdf', name: 'doc.pdf', disposition: 'attachment', size: 100 },
          ],
        },
        textBody: [{ partId: '1' }],
        htmlBody: [],
        attachments: [{ partId: '2', type: 'application/pdf', name: 'doc.pdf' }],
        bodyValues: { 1: { value: 'see attached' } },
      }],
      state: 'es',
    }));
    await fetchEmailBodies({ transport, account, handlers, remoteIds: ['e-1'] });
    const att = await engine.get(
      `SELECT is_attachment, name FROM body_parts
        WHERE message_id = (SELECT id FROM messages WHERE remote_id = ?)
          AND part_id = ?`,
      ['e-1', '2'],
    );
    expect(Number(att.is_attachment)).toBe(1);
    expect(att.name).toBe('doc.pdf');
  });
});
