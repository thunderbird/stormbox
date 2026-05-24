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

  it('batches destroy across multiple messageIds into a single Email/set', async () => {
    // Seed a second message so the batch has more than one id to
    // operate on.
    const m2 = new MockTransport();
    m2.handle('Email/query', () => ({
      ids: ['e-1', 'e-2'], total: 2, queryState: 'qs2',
      canCalculateChanges: true, position: 0,
    }));
    m2.handle('Email/get', (params) => ({
      list: params.ids.map(emailFixture),
      state: 'es',
    }));
    await syncFolderWindow({ transport: m2, account, folder: inbox, handlers });
    const secondRow = await engine.get(
      'SELECT id FROM messages WHERE account_id = ? AND remote_id = ?',
      [account.id, 'e-2'],
    );

    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.DESTROY,
      targetMessageId: null,
      requestJson: JSON.stringify({ messageIds: [messageId, secondRow.id] }),
    });

    const transport = new MockTransport();
    const setCalls = [];
    transport.handle('Email/set', (params) => {
      setCalls.push(params);
      return { destroyed: params.destroy };
    });
    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    // Single round trip, both ids in the destroy array.
    expect(setCalls).toHaveLength(1);
    expect([...(setCalls[0].destroy ?? [])].sort()).toEqual(['e-1', 'e-2']);
    // Both messages are gone locally.
    expect(await engine.get('SELECT id FROM messages WHERE id = ?', [messageId])).toBeNull();
    expect(await engine.get('SELECT id FROM messages WHERE id = ?', [secondRow.id])).toBeNull();
  });

  it('batches moveToFolders across multiple messageIds into a single Email/set', async () => {
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [{ remoteId: 'mb-archive', name: 'Archive', role: 'archive' }],
    });
    const archive = await engine.get(
      'SELECT id FROM folders WHERE account_id = ? AND remote_id = ?',
      [account.id, 'mb-archive'],
    );
    const m2 = new MockTransport();
    m2.handle('Email/query', () => ({
      ids: ['e-1', 'e-2'], total: 2, queryState: 'qs2',
      canCalculateChanges: true, position: 0,
    }));
    m2.handle('Email/get', (params) => ({
      list: params.ids.map(emailFixture),
      state: 'es',
    }));
    await syncFolderWindow({ transport: m2, account, folder: inbox, handlers });
    const secondRow = await engine.get(
      'SELECT id FROM messages WHERE account_id = ? AND remote_id = ?',
      [account.id, 'e-2'],
    );

    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.MOVE_TO_FOLDERS,
      targetMessageId: null,
      requestJson: JSON.stringify({
        messageIds: [messageId, secondRow.id],
        addFolderIds: [archive.id],
        removeFolderIds: [inbox.id],
      }),
    });

    const transport = new MockTransport();
    const setCalls = [];
    transport.handle('Email/set', (params) => {
      setCalls.push(params);
      return { updated: Object.fromEntries(Object.keys(params.update).map((id) => [id, null])) };
    });
    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(setCalls).toHaveLength(1);
    // Both ids carried the same patch, sent in a single update map.
    expect(Object.keys(setCalls[0].update).sort()).toEqual(['e-1', 'e-2']);
    expect(setCalls[0].update['e-1']['mailboxIds/mb-archive']).toBe(true);
    expect(setCalls[0].update['e-1']['mailboxIds/mb-inbox']).toBeNull();
    expect(setCalls[0].update['e-2']['mailboxIds/mb-archive']).toBe(true);
    expect(setCalls[0].update['e-2']['mailboxIds/mb-inbox']).toBeNull();
  });

  it('can run one specific pending mutation without draining older rows first', async () => {
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.SET_KEYWORDS,
      targetMessageId: messageId,
      requestJson: JSON.stringify({ add: ['$seen'], remove: [] }),
    });
    const deleteMutation = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
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
    const summary = await drainOutbox({
      transport,
      account,
      handlers,
      mutationId: deleteMutation.id,
    });
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(setParams.destroy).toEqual(['e-1']);

    const remaining = await engine.all(
      'SELECT mutation_type, local_status FROM pending_mutations ORDER BY created_at',
    );
    expect(remaining).toEqual([{
      mutation_type: MUTATION_TYPES.SET_KEYWORDS,
      local_status: 'pending',
    }]);
  });

  it('runs send via Email/set + EmailSubmission/set with onSuccessUpdateEmail', async () => {
    // Seed Drafts and Sent folders plus an identity so the local-id
    // payload can be resolved at dispatch.
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [
        { remoteId: 'mb-drafts', name: 'Drafts', role: 'drafts', sortOrder: 1 },
        { remoteId: 'mb-sent', name: 'Sent', role: 'sent', sortOrder: 2 },
      ],
    });
    const drafts = await engine.get(
      'SELECT id FROM folders WHERE account_id = ? AND remote_id = ?',
      [account.id, 'mb-drafts'],
    );
    const sent = await engine.get(
      'SELECT id FROM folders WHERE account_id = ? AND remote_id = ?',
      [account.id, 'mb-sent'],
    );
    await handlers[DB_RPC.IDENTITY_UPSERT_MANY]({
      accountId: account.id,
      identities: [{
        remoteId: 'id-1',
        name: 'Tester',
        email: 'tester@example.com',
        replyToJson: null,
        rawJson: null,
      }],
    });
    const identity = await engine.get(
      'SELECT id FROM identities WHERE account_id = ? AND remote_id = ?',
      [account.id, 'id-1'],
    );

    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.SEND,
      requestJson: JSON.stringify({
        identityId: identity.id,
        to: [{ email: 'rcpt@example.com' }],
        subject: 'Hello',
        textBody: 'Hi.',
        htmlBody: '<p>Hi.</p>',
        draftsFolderId: drafts.id,
        sentFolderId: sent.id,
        outboxFolderId: null,
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
    // Email/get follow-up is issued by applySendLocally so the local
    // cache mirrors the server before drainOutbox resolves.
    transport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => ({
        id,
        blobId: `b-${id}`,
        threadId: 'thr-new',
        mailboxIds: { 'mb-sent': true },
        keywords: {},
        size: 100,
        receivedAt: '2026-05-01T12:00:00Z',
        sentAt: '2026-05-01T12:00:00Z',
        messageId: [`<${id}@example.com>`],
        from: [{ email: 'tester@example.com' }],
        to: [{ email: 'rcpt@example.com' }],
        sender: [{ email: 'tester@example.com' }],
        subject: 'Hello',
        preview: 'Hi.',
        hasAttachment: false,
      })),
      state: 'es',
    }));

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

  it('fails cleanly when identityId does not resolve to a local row', async () => {
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.SEND,
      requestJson: JSON.stringify({
        identityId: 9999,
        to: [{ email: 'rcpt@example.com' }],
        subject: 'Hello',
        textBody: 'Hi.',
        htmlBody: '',
        draftsFolderId: null,
        sentFolderId: null,
        outboxFolderId: null,
      }),
    });

    const transport = new MockTransport();
    transport.handle('Email/set', () => {
      throw new Error('Email/set must not be called when identity is missing');
    });

    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1 });

    const row = await engine.get(
      `SELECT local_status, error_json FROM pending_mutations
        WHERE mutation_type = ?`,
      [MUTATION_TYPES.SEND],
    );
    expect(row.local_status).toBe('conflicted');
    expect(JSON.parse(row.error_json).type).toBe('unknownIdentity');
  });
});
