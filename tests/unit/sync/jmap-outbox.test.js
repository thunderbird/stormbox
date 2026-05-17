import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory.js';
import { makeHandlers } from '../../../src/db/handlers.js';
import { DB_RPC } from '../../../src/db/protocol.js';
import { drainOutbox, MUTATION_TYPES } from '../../../src/sync/backends/jmap/outbox.js';
import { syncMailboxes } from '../../../src/sync/backends/jmap/mailboxes.js';
import { syncFolderWindow } from '../../../src/sync/backends/jmap/messages.js';
import { MockTransport } from './_mock-transport.js';

let engine;
let handlers;
let account;
let inbox;
let messageId;

const NOW = Date.parse('2026-05-01T12:00:00Z');

function emailFixture(id) {
  return {
    id,
    blobId: `b-${id}`,
    threadId: `t-${id}`,
    mailboxIds: { 'mb-inbox': true },
    keywords: {},
    size: 1,
    receivedAt: new Date(NOW).toISOString(),
    sentAt: new Date(NOW).toISOString(),
    messageId: [`<${id}@example.com>`],
    from: [{ email: 'from@example.com' }],
    to: [{ email: 'to@example.com' }],
    sender: [{ email: 'sender@example.com' }],
    subject: 's', preview: 'p', hasAttachment: false,
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

  // Seed an inbox + a message via the regular sync path so the outbox
  // has real local rows to operate on.
  const t = new MockTransport();
  t.handle('Mailbox/get', () => ({
    list: [{ id: 'mb-inbox', name: 'Inbox', role: 'inbox' }],
    state: 's0',
  }));
  await syncMailboxes({ transport: t, account, handlers });
  inbox = await engine.get(
    'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
    [account.id, 'mb-inbox'],
  );

  const m = new MockTransport();
  m.handle('Email/query', () => ({
    ids: ['e-1'], total: 1, queryState: 'qs', canCalculateChanges: true, position: 0,
  }));
  m.handle('Email/get', (params) => ({
    list: params.ids.map(emailFixture),
    state: 'es',
  }));
  await syncFolderWindow({ transport: m, account, folder: inbox, handlers });

  const row = await engine.get(
    'SELECT id FROM messages WHERE account_id = ? AND remote_id = ?',
    [account.id, 'e-1'],
  );
  messageId = row.id;
});

afterEach(async () => {
  await engine.close();
});

describe('drainOutbox', () => {
  it('runs setKeywords and removes the row on success', async () => {
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.SET_KEYWORDS,
      targetMessageId: messageId,
      requestJson: JSON.stringify({ add: ['$seen'], remove: [] }),
      optimisticPatchJson: JSON.stringify({ is_seen: 1 }),
    });

    const transport = new MockTransport();
    let setRequest;
    transport.handle('Email/set', (params) => {
      setRequest = params;
      return { accountId: 'acct-1', updated: { 'e-1': null } };
    });

    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });

    expect(setRequest.update['e-1']).toEqual({ 'keywords/$seen': true });

    const remaining = await handlers[DB_RPC.PENDING_MUTATION_LIST_PENDING]({
      accountId: account.id,
    });
    expect(remaining).toHaveLength(0);
  });

  it('runs moveToFolders by translating local folder ids to remote ids', async () => {
    // Create a second folder and seed it as an Archive.
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [{ remoteId: 'mb-archive', name: 'Archive', role: 'archive' }],
    });
    const archive = await engine.get(
      'SELECT id FROM folders WHERE account_id = ? AND remote_id = ?',
      [account.id, 'mb-archive'],
    );
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.MOVE_TO_FOLDERS,
      targetMessageId: messageId,
      requestJson: JSON.stringify({
        addFolderIds: [archive.id],
        removeFolderIds: [inbox.id],
      }),
    });

    const transport = new MockTransport();
    let setParams;
    transport.handle('Email/set', (params) => {
      setParams = params;
      return { updated: { 'e-1': null } };
    });
    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary.succeeded).toBe(1);
    expect(setParams.update['e-1']['mailboxIds/mb-archive']).toBe(true);
    expect(setParams.update['e-1']['mailboxIds/mb-inbox']).toBeNull();
  });

  it('runs destroy via Email/set destroy', async () => {
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.DESTROY,
      targetMessageId: messageId,
      requestJson: JSON.stringify({}),
    });
    const transport = new MockTransport();
    let setParams;
    transport.handle('Email/set', (params) => {
      setParams = params;
      return { destroyed: ['e-1'] };
    });
    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary.succeeded).toBe(1);
    expect(setParams.destroy).toEqual(['e-1']);
  });

  it('marks the row conflicted when the server reports notUpdated', async () => {
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.SET_KEYWORDS,
      targetMessageId: messageId,
      requestJson: JSON.stringify({ add: ['$seen'], remove: [] }),
    });
    const transport = new MockTransport();
    transport.handle('Email/set', () => ({
      notUpdated: { 'e-1': { type: 'forbidden', description: 'denied' } },
    }));
    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1 });

    const remaining = await engine.all('SELECT local_status, error_json FROM pending_mutations');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].local_status).toBe('conflicted');
    expect(remaining[0].error_json).toMatch(/notUpdated/);
  });

  it('runs send via Email/set + EmailSubmission/set with onSuccessUpdateEmail', async () => {
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.SEND,
      requestJson: JSON.stringify({
        identityId: 'id-1',
        from: { name: 'Tester', email: 'tester@example.com' },
        to: [{ email: 'rcpt@example.com' }],
        subject: 'Hello',
        textBody: 'Hi.',
        htmlBody: '<p>Hi.</p>',
        draftsRemoteId: 'mb-drafts',
        sentRemoteId: 'mb-sent',
        outboxRemoteId: null,
      }),
    });

    const transport = new MockTransport();
    let setParams;
    let submitParams;
    transport.handle('Email/set', (params) => {
      setParams = params;
      return { created: { c1: { id: 'em-new', threadId: 'thr-new', size: 100 } } };
    });
    transport.handle('EmailSubmission/set', (params) => {
      submitParams = params;
      return { created: { s1: { id: 'sub-1', sendAt: '2026-05-01T12:00:00Z' } } };
    });

    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });

    expect(setParams.create.c1.from[0].email).toBe('tester@example.com');
    expect(setParams.create.c1.subject).toBe('Hello');
    // multipart/alternative because htmlBody is non-trivial.
    expect(setParams.create.c1.bodyStructure.type).toBe('multipart/alternative');
    expect(setParams.create.c1.mailboxIds).toEqual({ 'mb-drafts': true });
    expect(setParams.create.c1.keywords).toEqual({ $draft: true });

    expect(submitParams.create.s1.identityId).toBe('id-1');
    expect(submitParams.create.s1.emailId).toBe('#c1');
    expect(submitParams.create.s1.envelope.rcptTo[0].email).toBe('rcpt@example.com');
    expect(submitParams.onSuccessUpdateEmail['#s1']['mailboxIds/mb-sent']).toBe(true);
    expect(submitParams.onSuccessUpdateEmail['#s1']['mailboxIds/mb-drafts']).toBeNull();
    expect(submitParams.onSuccessUpdateEmail['#s1']['keywords/$draft']).toBeNull();
  });

  it('marks the row conflicted on transport errors', async () => {
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.SET_KEYWORDS,
      targetMessageId: messageId,
      requestJson: JSON.stringify({ add: ['$seen'], remove: [] }),
    });
    const transport = new MockTransport();
    transport.handle('Email/set', () => {
      throw new Error('network down');
    });
    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary.failed).toBe(1);
    const row = await engine.get('SELECT local_status, error_json FROM pending_mutations');
    expect(row.local_status).toBe('conflicted');
    expect(row.error_json).toMatch(/network down/);
  });
});
