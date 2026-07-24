import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import {
  drainOutbox,
  MUTATION_TYPES,
  processMutationRow,
} from '../../../src/sync/backends/jmap/outbox';
import { syncMailboxes } from '../../../src/sync/backends/jmap/mailboxes';
import { syncFolderWindow } from '../../../src/sync/backends/jmap/messages';
import { MockTransport } from './_mock-transport';

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

  it('batches setKeywords across multiple messageIds into a single Email/set', async () => {
    const m2 = new MockTransport();
    m2.handle('Email/query', () => ({
      ids: ['e-2'], total: 1, queryState: 'qs-2', canCalculateChanges: true, position: 0,
    }));
    m2.handle('Email/get', (params) => ({
      list: params.ids.map((id) => ({
        id,
        blobId: `b-${id}`,
        threadId: `t-${id}`,
        mailboxIds: { 'mb-inbox': true },
        keywords: {},
        size: 1,
        receivedAt: new Date(NOW + 1).toISOString(),
        sentAt: new Date(NOW + 1).toISOString(),
        messageId: [`<${id}@example.com>`],
        from: [{ email: 'from@example.com' }],
        subject: `subject ${id}`,
      })),
      state: 'es',
    }));
    await syncFolderWindow({ transport: m2, account, folder: inbox, handlers });
    const secondRow = await engine.get(
      'SELECT id FROM messages WHERE account_id = ? AND remote_id = ?',
      [account.id, 'e-2'],
    );

    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.SET_KEYWORDS,
      requestJson: JSON.stringify({ messageIds: [messageId, secondRow.id], add: ['$seen'], remove: [] }),
      optimisticPatchJson: JSON.stringify({ is_seen: 1 }),
    });

    const transport = new MockTransport();
    let setRequest;
    transport.handle('Email/set', (params) => {
      setRequest = params;
      return { accountId: 'acct-1', updated: { 'e-1': null, 'e-2': null } };
    });

    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(Object.keys(setRequest.update).sort()).toEqual(['e-1', 'e-2']);
    expect(setRequest.update['e-1']).toEqual({ 'keywords/$seen': true });
    expect(setRequest.update['e-2']).toEqual({ 'keywords/$seen': true });
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
        keywords: { $seen: true },
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
    expect(submitParams.onSuccessUpdateEmail['#s1']['keywords/$seen']).toBe(true);
    // No inline images means no blob uploads and no attachments.
    expect(transport.uploads).toHaveLength(0);
    expect(setParams.create.c1.attachments).toBeUndefined();
  });

  it('uploads inline pasted images and sends them as cid attachments', async () => {
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

    const pngBase64 = btoa('fake-png-bytes');
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.SEND,
      requestJson: JSON.stringify({
        identityId: identity.id,
        to: [{ email: 'rcpt@example.com' }],
        subject: 'With image',
        textBody: 'See image.',
        htmlBody: `<p>See image.</p><img src="data:image/png;base64,${pngBase64}">`,
        draftsFolderId: drafts.id,
        sentFolderId: sent.id,
        outboxFolderId: null,
      }),
    });

    const transport = new MockTransport();
    let setParams;
    transport.handle('Email/set', (params) => {
      setParams = params;
      return { created: { c1: { id: 'em-new', threadId: 'thr-new', size: 100 } } };
    });
    transport.handle('EmailSubmission/set', () => ({
      created: { s1: { id: 'sub-1', sendAt: '2026-05-01T12:00:00Z' } },
    }));
    transport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => ({
        id,
        blobId: `b-${id}`,
        threadId: 'thr-new',
        mailboxIds: { 'mb-sent': true },
        keywords: { $seen: true },
        size: 100,
        receivedAt: '2026-05-01T12:00:00Z',
        sentAt: '2026-05-01T12:00:00Z',
        messageId: [`<${id}@example.com>`],
        from: [{ email: 'tester@example.com' }],
        to: [{ email: 'rcpt@example.com' }],
        sender: [{ email: 'tester@example.com' }],
        subject: 'With image',
        preview: 'See image.',
        hasAttachment: true,
      })),
      state: 'es',
    }));

    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });

    // The image bytes are uploaded as a blob before Email/set references it.
    expect(transport.uploads).toHaveLength(1);
    expect(transport.uploads[0].type).toBe('image/png');
    expect(transport.uploads[0].body).toBeInstanceOf(Uint8Array);

    // Inline images must be multipart/related to the HTML so recipients
    // can resolve the cid:; the convenience attachments property is not used.
    const create = setParams.create.c1;
    expect(create.attachments).toBeUndefined();
    expect(create.bodyStructure.type).toBe('multipart/related');
    const relatedParts = create.bodyStructure.subParts;
    expect(relatedParts[0]).toEqual({
      type: 'multipart/alternative',
      subParts: [
        { type: 'text/plain', partId: 'p1' },
        { type: 'text/html', partId: 'h1' },
      ],
    });
    const imagePart = relatedParts.find((p) => p.disposition === 'inline');
    expect(imagePart).toMatchObject({
      blobId: 'blob-1',
      type: 'image/png',
      disposition: 'inline',
    });
    expect(imagePart.cid).toBeTruthy();
    // The HTML references the cid and no longer carries the data: URL.
    expect(create.bodyValues.h1.value).toContain(`src="cid:${imagePart.cid}"`);
    expect(create.bodyValues.h1.value).not.toContain('data:image/');
  });

  it('fails the send and keeps the draft when an inline image upload fails', async () => {
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
        subject: 'With image',
        textBody: 'See image.',
        htmlBody: `<img src="data:image/png;base64,${btoa('x')}">`,
        draftsFolderId: drafts.id,
        sentFolderId: sent.id,
        outboxFolderId: null,
      }),
    });

    const transport = new MockTransport();
    transport.handleUpload(() => {
      throw new Error('upload boom');
    });
    transport.handle('Email/set', () => {
      throw new Error('Email/set must not run when an inline image upload fails');
    });

    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1 });

    const row = await engine.get(
      `SELECT local_status, error_json FROM pending_mutations
        WHERE mutation_type = ?`,
      [MUTATION_TYPES.SEND],
    );
    expect(row.local_status).toBe('conflicted');
    expect(JSON.parse(row.error_json).type).toBe('uploadFailed');
  });

  it('surfaces method-level JMAP errors instead of generic noResponse', async () => {
    // RFC 8620 §3.6.1: when a JMAP server cannot run a method call,
    // it replaces that call's response slot with ["error", {...},
    // callId]. Stalwart does this for requestTooLarge / limit when
    // the Email/set is too big for its batch handler. The outbox
    // must surface that typed error to the user; the previous
    // implementation reported "noResponse" which made every kind of
    // failure look like a network blip and caused 8 useless retries.
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.DESTROY,
      targetMessageId: messageId,
      requestJson: JSON.stringify({}),
    });

    const transport = {
      session: {
        capabilities: {
          'urn:ietf:params:jmap:core': {
            maxObjectsInGet: 500,
            maxObjectsInSet: 500,
          },
        },
      },
      async request(_using: any, methodCalls: any) {
        const callId = methodCalls?.[0]?.[2] ?? 's1';
        return {
          methodResponses: [
            ['error', { type: 'requestTooLarge', description: 'too big' }, callId],
          ],
        };
      },
    };

    const summary = await drainOutbox({
      transport: transport as any,
      account,
      handlers,
      mutationId: undefined,
    });
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1 });

    const row = await engine.get(
      `SELECT local_status, error_json FROM pending_mutations
        WHERE mutation_type = ?`,
      [MUTATION_TYPES.DESTROY],
    );
    expect(row.local_status).toBe('conflicted');
    const err = JSON.parse(row.error_json);
    expect(err.type).toBe('requestTooLarge');
    expect(err.description).toBe('too big');
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

describe('setMailboxSubscription', () => {
  it('issues Mailbox/set against the folder-owning account and mirrors the flag locally', async () => {
    // The folder belongs to a shared account (RFC 9670), so the JMAP
    // accountId must come from that account's row, not the mutation's.
    const shared = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'other@example.com',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'acct-shared',
      isPrimary: false,
      isPersonal: false,
    })).row;
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: shared.id,
      folders: [{ remoteId: 'mb-team', name: 'Team', isSubscribed: false }],
    });
    const folder = await engine.get(
      'SELECT id FROM folders WHERE account_id = ? AND remote_id = ?',
      [shared.id, 'mb-team'],
    );

    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.SET_MAILBOX_SUBSCRIPTION,
      requestJson: JSON.stringify({ folderId: folder.id, isSubscribed: true }),
    });

    const transport = new MockTransport();
    let setParams;
    transport.handle('Mailbox/set', (params) => {
      setParams = params;
      return { updated: { 'mb-team': null }, newState: 'mb-s2' };
    });

    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(setParams.accountId).toBe('acct-shared');
    expect(setParams.update).toEqual({ 'mb-team': { isSubscribed: true } });

    const after = await engine.get(
      'SELECT is_subscribed FROM folders WHERE id = ?',
      [folder.id],
    );
    expect(Number(after.is_subscribed)).toBe(1);
  });

  it('marks the row failed and leaves the local flag unchanged on notUpdated', async () => {
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [{ remoteId: 'mb-locked', name: 'Locked', isSubscribed: true }],
    });
    const folder = await engine.get(
      'SELECT id FROM folders WHERE account_id = ? AND remote_id = ?',
      [account.id, 'mb-locked'],
    );

    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.SET_MAILBOX_SUBSCRIPTION,
      requestJson: JSON.stringify({ folderId: folder.id, isSubscribed: false }),
    });

    const transport = new MockTransport();
    transport.handle('Mailbox/set', () => ({
      notUpdated: {
        'mb-locked': { type: 'forbidden', description: 'You are not allowed to modify this mailbox.' },
      },
    }));

    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1 });

    const row = await engine.get(
      `SELECT local_status, error_json FROM pending_mutations WHERE mutation_type = ?`,
      [MUTATION_TYPES.SET_MAILBOX_SUBSCRIPTION],
    );
    expect(row.local_status).toBe('conflicted');
    expect(JSON.parse(row.error_json).type).toBe('notUpdated');

    const after = await engine.get(
      'SELECT is_subscribed FROM folders WHERE id = ?',
      [folder.id],
    );
    expect(Number(after.is_subscribed)).toBe(1);
  });

  it('fails with unknownFolder when the folder id does not resolve', async () => {
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.SET_MAILBOX_SUBSCRIPTION,
      requestJson: JSON.stringify({ folderId: 999999, isSubscribed: true }),
    });

    const transport = new MockTransport();
    transport.handle('Mailbox/set', () => {
      throw new Error('Mailbox/set must not be called for an unknown folder');
    });

    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
  });

  it('groups, chunks, and applies only confirmed subscription ids in one plural row', async () => {
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [
        { remoteId: 'mb-p1', name: 'P1', isSubscribed: true },
        { remoteId: 'mb-p2', name: 'P2', isSubscribed: true },
        { remoteId: 'mb-p3', name: 'P3', isSubscribed: true },
      ],
    });
    const shared = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'shared@example.com',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'acct-shared',
      isPrimary: false,
      isPersonal: false,
    })).row;
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: shared.id,
      folders: [{ remoteId: 'mb-s1', name: 'S1', isSubscribed: true }],
    });
    const folders = await engine.all(
      `SELECT id, remote_id FROM folders WHERE remote_id IN ('mb-p1','mb-p2','mb-p3','mb-s1')`,
    );
    const byRemote = Object.fromEntries(folders.map((folder) => [folder.remote_id, folder.id]));
    await handlers[DB_RPC.FOLDER_SET_STARRED_MANY]({
      folderIds: Object.values(byRemote),
      isStarred: true,
    });
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.SET_MAILBOX_SUBSCRIPTION,
      requestJson: JSON.stringify({
        operations: Object.values(byRemote).map((folderId) => ({
          folderId,
          isSubscribed: false,
        })),
      }),
    });

    const transport = new MockTransport({
      capabilities: {
        'urn:ietf:params:jmap:core': {
          maxObjectsInGet: 500,
          maxObjectsInSet: 2,
        },
      },
    });
    const calls = [];
    transport.handle('Mailbox/set', (params) => {
      calls.push(params);
      const updated = {};
      const notUpdated = {};
      for (const remoteId of Object.keys(params.update)) {
        if (remoteId === 'mb-p3') notUpdated[remoteId] = { type: 'forbidden' };
        else updated[remoteId] = null;
      }
      return { updated, notUpdated };
    });

    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.accountId).sort()).toEqual([
      'acct-1',
      'acct-1',
      'acct-shared',
    ]);
    expect(calls.every((call) => Object.keys(call.update).length <= 2)).toBe(true);

    const after = await engine.all(
      `SELECT remote_id, is_subscribed, is_starred
         FROM folders WHERE remote_id IN ('mb-p1','mb-p2','mb-p3','mb-s1')`,
    );
    const state = Object.fromEntries(after.map((folder) => [folder.remote_id, {
      subscribed: Number(folder.is_subscribed),
      starred: Number(folder.is_starred),
    }]));
    expect(state['mb-p1']).toEqual({ subscribed: 0, starred: 0 });
    expect(state['mb-p2']).toEqual({ subscribed: 0, starred: 0 });
    expect(state['mb-s1']).toEqual({ subscribed: 0, starred: 0 });
    expect(state['mb-p3']).toEqual({ subscribed: 1, starred: 1 });
  });

  it('applies an earlier subscription chunk before a later transport failure', async () => {
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [
        { remoteId: 'mb-a', name: 'A', isSubscribed: true },
        { remoteId: 'mb-b', name: 'B', isSubscribed: true },
        { remoteId: 'mb-c', name: 'C', isSubscribed: true },
      ],
    });
    const folders = await engine.all(
      `SELECT id, remote_id FROM folders WHERE remote_id IN ('mb-a','mb-b','mb-c') ORDER BY remote_id`,
    );
    const transport = new MockTransport({
      capabilities: {
        'urn:ietf:params:jmap:core': {
          maxObjectsInGet: 500,
          maxObjectsInSet: 2,
        },
      },
    });
    let calls = 0;
    transport.handle('Mailbox/set', (params) => {
      calls += 1;
      if (calls === 2) throw new Error('socket closed');
      return {
        updated: Object.fromEntries(Object.keys(params.update).map((remoteId) => [remoteId, null])),
      };
    });

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: {
        mutation_type: MUTATION_TYPES.SET_MAILBOX_SUBSCRIPTION,
        request_json: JSON.stringify({
          operations: folders.map((folder) => ({
            folderId: folder.id,
            isSubscribed: false,
          })),
        }),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('transport');
    expect(result.error.terminal).toBeUndefined();
    expect(result.result.succeededIds).toEqual(folders.slice(0, 2).map((folder) => folder.id));
    expect(result.result.errors[String(folders[2].id)].type).toBe('transport');
    const after = await engine.all(
      `SELECT remote_id, is_subscribed FROM folders
        WHERE remote_id IN ('mb-a','mb-b','mb-c') ORDER BY remote_id`,
    );
    expect(after.map((folder) => Number(folder.is_subscribed))).toEqual([0, 0, 1]);
  });

  it('uses deterministic last-wins semantics for duplicate subscription targets', async () => {
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [{ remoteId: 'mb-duplicate', name: 'Duplicate', isSubscribed: false }],
    });
    const folder = await engine.get(
      `SELECT id FROM folders WHERE account_id = ? AND remote_id = 'mb-duplicate'`,
      [account.id],
    );
    const transport = new MockTransport();
    let update;
    transport.handle('Mailbox/set', (params) => {
      update = params.update;
      return { updated: { 'mb-duplicate': null } };
    });

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: {
        mutation_type: MUTATION_TYPES.SET_MAILBOX_SUBSCRIPTION,
        request_json: JSON.stringify({
          operations: [
            { folderId: folder.id, isSubscribed: false },
            { folderId: folder.id, isSubscribed: true },
          ],
        }),
      },
    });

    expect(result.ok).toBe(true);
    expect(update).toEqual({ 'mb-duplicate': { isSubscribed: true } });
    expect(result.result.succeededIds).toEqual([folder.id]);
  });

  it('keeps method-level and transient per-object failures retryable', async () => {
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [{ remoteId: 'mb-retry', name: 'Retry', isSubscribed: true }],
    });
    const folder = await engine.get(
      `SELECT id FROM folders WHERE account_id = ? AND remote_id = 'mb-retry'`,
      [account.id],
    );
    const row = {
      mutation_type: MUTATION_TYPES.SET_MAILBOX_SUBSCRIPTION,
      request_json: JSON.stringify({
        operations: [{ folderId: folder.id, isSubscribed: false }],
      }),
    };
    const setErrorTransport = new MockTransport();
    setErrorTransport.handle('Mailbox/set', () => ({
      notUpdated: { 'mb-retry': { type: 'serverFail' } },
    }));
    const setErrorResult = await processMutationRow({
      transport: setErrorTransport,
      account,
      handlers,
      row,
    });
    expect(setErrorResult.error.terminal).toBeUndefined();

    const methodErrorTransport = {
      session: {
        capabilities: {
          'urn:ietf:params:jmap:core': {
            maxObjectsInGet: 500,
            maxObjectsInSet: 500,
          },
        },
      },
      request: async () => ({
        methodResponses: [['error', { type: 'serverUnavailable' }, 's1']],
      }),
    };
    const methodErrorResult = await processMutationRow({
      transport: methodErrorTransport,
      account,
      handlers,
      row,
    });
    expect(methodErrorResult.error.type).toBe('serverUnavailable');
    expect(methodErrorResult.error.terminal).toBeUndefined();
  });
});

describe('createMailbox', () => {
  it('creates a top-level mailbox on the mutation account and inserts the local row subscribed', async () => {
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.CREATE_MAILBOX,
      requestJson: JSON.stringify({ name: 'Receipts', parentFolderId: null }),
    });

    const transport = new MockTransport();
    let setParams;
    transport.handle('Mailbox/set', (params) => {
      setParams = params;
      return {
        created: { c1: { id: 'mb-new', sortOrder: 10, myRights: { mayRename: true } } },
        newState: 'mb-s2',
      };
    });

    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(setParams.accountId).toBe('acct-1');
    expect(setParams.create.c1).toEqual({
      name: 'Receipts', parentId: null, isSubscribed: true,
    });

    const row = await engine.get(
      'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
      [account.id, 'mb-new'],
    );
    expect(row.name).toBe('Receipts');
    expect(row.parent_id).toBeNull();
    expect(Number(row.is_subscribed)).toBe(1);
    expect(Number(row.is_deleted)).toBe(0);
  });

  it('persists an earlier create chunk before a later transport failure', async () => {
    const transport = new MockTransport({
      capabilities: {
        'urn:ietf:params:jmap:core': {
          maxObjectsInGet: 500,
          maxObjectsInSet: 1,
        },
      },
    });
    let calls = 0;
    transport.handle('Mailbox/set', (params) => {
      calls += 1;
      if (calls === 2) throw new Error('later chunk failed');
      const clientId = Object.keys(params.create)[0];
      return {
        created: { [clientId]: { id: 'mb-created-first' } },
        newState: 'mb-create-1',
      };
    });

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: {
        mutation_type: MUTATION_TYPES.CREATE_MAILBOX,
        request_json: JSON.stringify({
          operations: [
            { clientId: 'first', name: 'First', parentFolderId: null },
            { clientId: 'second', name: 'Second', parentFolderId: null },
          ],
        }),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.result.succeededIds).toEqual(['first']);
    expect(result.result.errors.second).toMatchObject({ type: 'transport' });
    expect(await engine.get(
      `SELECT id FROM folders WHERE account_id = ? AND remote_id = 'mb-created-first'`,
      [account.id],
    )).toBeTruthy();
  });

  it('creates a child under a shared folder in the owning account', async () => {
    const shared = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'other@example.com',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'acct-shared',
      isPrimary: false,
      isPersonal: false,
    })).row;
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: shared.id,
      folders: [{ remoteId: 'mb-team', name: 'Team', isSubscribed: true }],
    });
    const parent = await engine.get(
      'SELECT id FROM folders WHERE account_id = ? AND remote_id = ?',
      [shared.id, 'mb-team'],
    );

    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.CREATE_MAILBOX,
      requestJson: JSON.stringify({ name: 'Minutes', parentFolderId: parent.id }),
    });

    const transport = new MockTransport();
    let setParams;
    transport.handle('Mailbox/set', (params) => {
      setParams = params;
      return { created: { c1: { id: 'mb-minutes' } }, newState: 'mb-s3' };
    });

    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(setParams.accountId).toBe('acct-shared');
    expect(setParams.create.c1.parentId).toBe('mb-team');

    const row = await engine.get(
      'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
      [shared.id, 'mb-minutes'],
    );
    expect(row.parent_id).toBe(parent.id);
  });

  it('marks the row failed on notCreated and inserts nothing locally', async () => {
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.CREATE_MAILBOX,
      requestJson: JSON.stringify({ name: 'Nope', parentFolderId: null }),
    });

    const transport = new MockTransport();
    transport.handle('Mailbox/set', () => ({
      notCreated: { c1: { type: 'forbidden' } },
    }));

    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1 });

    const row = await engine.get(
      `SELECT error_json FROM pending_mutations WHERE mutation_type = ?`,
      [MUTATION_TYPES.CREATE_MAILBOX],
    );
    const error = JSON.parse(row.error_json);
    expect(error.type).toBe('notCreated');
    expect(error.detail.type).toBe('forbidden');

    const created = await engine.get(
      `SELECT id FROM folders WHERE account_id = ? AND name = 'Nope'`,
      [account.id],
    );
    expect(created).toBeFalsy();
  });
});

describe('updateMailbox', () => {
  let folderId;

  beforeEach(async () => {
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [
        { remoteId: 'mb-projects', name: 'Projects', isSubscribed: true },
        { remoteId: 'mb-reports', name: 'Reports', isSubscribed: true },
      ],
    });
    const row = await engine.get(
      'SELECT id FROM folders WHERE account_id = ? AND remote_id = ?',
      [account.id, 'mb-reports'],
    );
    folderId = row.id;
  });

  it('renames a mailbox and mirrors the name locally', async () => {
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.UPDATE_MAILBOX,
      requestJson: JSON.stringify({ folderId, name: 'Quarterly Reports' }),
    });

    const transport = new MockTransport();
    let setParams;
    transport.handle('Mailbox/set', (params) => {
      setParams = params;
      return { updated: { 'mb-reports': null }, newState: 'mb-s2' };
    });

    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    // A rename-only update must not touch parentId (a patch with
    // parentId: null would move the mailbox to the top level).
    expect(setParams.update['mb-reports']).toEqual({ name: 'Quarterly Reports' });

    const after = await engine.get('SELECT name, parent_id FROM folders WHERE id = ?', [folderId]);
    expect(after.name).toBe('Quarterly Reports');
    expect(after.parent_id).toBeNull();
  });

  it('moves a mailbox under a new parent and mirrors parent_id locally', async () => {
    const parent = await engine.get(
      'SELECT id FROM folders WHERE account_id = ? AND remote_id = ?',
      [account.id, 'mb-projects'],
    );
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.UPDATE_MAILBOX,
      requestJson: JSON.stringify({ folderId, parentFolderId: parent.id }),
    });

    const transport = new MockTransport();
    let setParams;
    transport.handle('Mailbox/set', (params) => {
      setParams = params;
      return { updated: { 'mb-reports': null }, newState: 'mb-s2' };
    });

    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(setParams.update['mb-reports']).toEqual({ parentId: 'mb-projects' });

    const after = await engine.get('SELECT name, parent_id FROM folders WHERE id = ?', [folderId]);
    expect(after.parent_id).toBe(parent.id);
    expect(after.name).toBe('Reports');
  });

  it('marks the row failed and leaves the local row unchanged on notUpdated', async () => {
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.UPDATE_MAILBOX,
      requestJson: JSON.stringify({ folderId, name: 'Elsewhere' }),
    });

    const transport = new MockTransport();
    transport.handle('Mailbox/set', () => ({
      notUpdated: { 'mb-reports': { type: 'forbidden' } },
    }));

    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1 });

    const row = await engine.get(
      `SELECT local_status, error_json FROM pending_mutations WHERE mutation_type = ?`,
      [MUTATION_TYPES.UPDATE_MAILBOX],
    );
    expect(row.local_status).toBe('conflicted');
    expect(JSON.parse(row.error_json).type).toBe('notUpdated');

    const after = await engine.get('SELECT name FROM folders WHERE id = ?', [folderId]);
    expect(after.name).toBe('Reports');
  });
});

describe('destroyMailbox', () => {
  it('destroys an empty mailbox and soft-deletes the local row', async () => {
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [{ remoteId: 'mb-old', name: 'Old', isSubscribed: true }],
    });
    const folder = await engine.get(
      'SELECT id FROM folders WHERE account_id = ? AND remote_id = ?',
      [account.id, 'mb-old'],
    );

    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.DESTROY_MAILBOX,
      requestJson: JSON.stringify({ folderId: folder.id, onDestroyRemoveEmails: false }),
    });

    const transport = new MockTransport();
    let setParams;
    transport.handle('Mailbox/set', (params) => {
      setParams = params;
      return { destroyed: ['mb-old'], newState: 'mb-s2' };
    });

    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(setParams.destroy).toEqual(['mb-old']);
    expect(setParams.onDestroyRemoveEmails).toBe(false);

    const after = await engine.get('SELECT is_deleted FROM folders WHERE id = ?', [folder.id]);
    expect(Number(after.is_deleted)).toBe(1);
  });

  it('treats an already locally destroyed folder as successful on retry', async () => {
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [{ remoteId: 'mb-retried', name: 'Retried', isSubscribed: true }],
    });
    const folder = await engine.get(
      `SELECT id FROM folders WHERE account_id = ? AND remote_id = 'mb-retried'`,
      [account.id],
    );
    const requestJson = JSON.stringify({
      operations: [{
        folderId: folder.id,
        onDestroyRemoveEmails: false,
      }],
    });
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.DESTROY_MAILBOX,
      requestJson,
    });
    const firstTransport = new MockTransport();
    firstTransport.handle('Mailbox/set', () => ({ destroyed: ['mb-retried'] }));
    expect(await drainOutbox({ transport: firstTransport, account, handlers }))
      .toEqual({ attempted: 1, succeeded: 1, failed: 0 });

    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.DESTROY_MAILBOX,
      requestJson,
    });
    const retryTransport = new MockTransport();
    retryTransport.handle('Mailbox/set', () => {
      throw new Error('already-destroyed folder must not be sent again');
    });
    expect(await drainOutbox({ transport: retryTransport, account, handlers }))
      .toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(retryTransport.requests).toHaveLength(0);
  });

  it('surfaces mailboxHasEmail as a typed notDestroyed error for the escalation path', async () => {
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.DESTROY_MAILBOX,
      requestJson: JSON.stringify({ folderId: inbox.id, onDestroyRemoveEmails: false }),
    });

    const transport = new MockTransport();
    transport.handle('Mailbox/set', () => ({
      notDestroyed: { 'mb-inbox': { type: 'mailboxHasEmail' } },
    }));

    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1 });

    const row = await engine.get(
      `SELECT error_json FROM pending_mutations WHERE mutation_type = ?`,
      [MUTATION_TYPES.DESTROY_MAILBOX],
    );
    const error = JSON.parse(row.error_json);
    expect(error.type).toBe('notDestroyed');
    expect(error.detail.type).toBe('mailboxHasEmail');

    const after = await engine.get('SELECT is_deleted FROM folders WHERE id = ?', [inbox.id]);
    expect(Number(after.is_deleted)).toBe(0);
  });

  it('does not infer Email destruction from a non-destructive folder success', async () => {
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.DESTROY_MAILBOX,
      requestJson: JSON.stringify({
        operations: [{
          folderId: inbox.id,
          onDestroyRemoveEmails: false,
        }],
      }),
    });
    const transport = new MockTransport();
    transport.handle('Mailbox/set', () => ({ destroyed: ['mb-inbox'] }));

    expect(await drainOutbox({ transport, account, handlers }))
      .toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    const message = await engine.get(
      `SELECT id FROM messages WHERE account_id = ? AND remote_id = 'e-1'`,
      [account.id],
    );
    expect(message?.id).toBe(messageId);
    expect(await engine.all(
      `SELECT * FROM folder_messages WHERE message_id = ?`,
      [messageId],
    )).toHaveLength(0);
  });

  it('clears folder memberships and query views when the destroy removes emails', async () => {
    // The seeded inbox has one message and one mailbox-window view.
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.DESTROY_MAILBOX,
      requestJson: JSON.stringify({ folderId: inbox.id, onDestroyRemoveEmails: true }),
    });

    const transport = new MockTransport();
    let setParams;
    transport.handle('Mailbox/set', (params) => {
      setParams = params;
      return { destroyed: ['mb-inbox'], newState: 'mb-s2' };
    });

    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(setParams.onDestroyRemoveEmails).toBe(true);

    const memberships = await engine.all(
      'SELECT * FROM folder_messages WHERE folder_id = ?',
      [inbox.id],
    );
    expect(memberships).toHaveLength(0);
    const views = await engine.all(
      'SELECT * FROM query_views WHERE folder_id = ?',
      [inbox.id],
    );
    expect(views).toHaveLength(0);
    const message = await engine.get(
      `SELECT id FROM messages WHERE account_id = ? AND remote_id = 'e-1'`,
      [account.id],
    );
    expect(message).toBeFalsy();
  });

  it('preserves a multi-filed message when one destructive folder delete succeeds', async () => {
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [{ remoteId: 'mb-keep', name: 'Keep', isSubscribed: true }],
    });
    const keep = await engine.get(
      `SELECT id FROM folders WHERE account_id = ? AND remote_id = 'mb-keep'`,
      [account.id],
    );
    await handlers[DB_RPC.FOLDER_MEMBERSHIP_REPLACE_MANY]({
      accountId: account.id,
      replacements: [{
        messageId,
        memberships: [
          { folderId: inbox.id, remoteMembershipId: 'mb-inbox' },
          { folderId: keep.id, remoteMembershipId: 'mb-keep' },
        ],
      }],
    });
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.DESTROY_MAILBOX,
      requestJson: JSON.stringify({
        operations: [{
          folderId: inbox.id,
          onDestroyRemoveEmails: true,
        }],
      }),
    });
    const transport = new MockTransport();
    transport.handle('Mailbox/set', () => ({ destroyed: ['mb-inbox'] }));

    expect(await drainOutbox({ transport, account, handlers }))
      .toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    const message = await engine.get(
      `SELECT id FROM messages WHERE account_id = ? AND remote_id = 'e-1'`,
      [account.id],
    );
    expect(message?.id).toBe(messageId);
    const remaining = await engine.all(
      `SELECT folder_id FROM folder_messages WHERE message_id = ?`,
      [messageId],
    );
    expect(remaining.map((row) => row.folder_id)).toEqual([keep.id]);
  });
});

describe('account-aware message mutations', () => {
  async function seedSharedMessage(remoteId = 'shared-e-1') {
    const shared = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'Shared',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'acct-shared',
      isPrimary: false,
      isPersonal: false,
    })).row;
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: shared.id,
      folders: [
        { remoteId: 'shared-inbox', name: 'Inbox', role: 'inbox' },
        { remoteId: 'shared-archive', name: 'Archive', role: 'archive' },
      ],
    });
    const source = await engine.get(
      `SELECT * FROM folders WHERE account_id = ? AND remote_id = 'shared-inbox'`,
      [shared.id],
    );
    const target = await engine.get(
      `SELECT * FROM folders WHERE account_id = ? AND remote_id = 'shared-archive'`,
      [shared.id],
    );
    const transport = new MockTransport();
    transport.handle('Email/query', () => ({
      ids: [remoteId],
      total: 1,
      queryState: 'shared-q1',
      canCalculateChanges: true,
      position: 0,
    }));
    transport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => ({
        ...emailFixture(id),
        mailboxIds: { 'shared-inbox': true },
      })),
      state: 'shared-es1',
    }));
    await syncFolderWindow({
      transport,
      account: shared,
      folder: source,
      handlers,
    });
    const message = await engine.get(
      'SELECT * FROM messages WHERE account_id = ? AND remote_id = ?',
      [shared.id, remoteId],
    );
    return { shared, source, target, message };
  }

  it('moves and destroys shared messages in their owning account', async () => {
    const { shared, source, target, message } = await seedSharedMessage();
    const moveTransport = new MockTransport();
    let moveRequest;
    moveTransport.handle('Email/set', (params) => {
      moveRequest = params;
      return { updated: { 'shared-e-1': null } };
    });
    const moved = await processMutationRow({
      transport: moveTransport,
      account,
      handlers,
      row: {
        mutation_type: MUTATION_TYPES.MOVE_TO_FOLDERS,
        request_json: JSON.stringify({
          messageIds: [message.id],
          addFolderIds: [target.id],
          removeFolderIds: [source.id],
        }),
      },
    });
    expect(moved.ok).toBe(true);
    expect(moveRequest.accountId).toBe('acct-shared');
    expect(await engine.all(
      'SELECT folder_id FROM folder_messages WHERE message_id = ?',
      [message.id],
    )).toEqual([{ folder_id: target.id }]);

    const destroyTransport = new MockTransport();
    let destroyRequest;
    destroyTransport.handle('Email/set', (params) => {
      destroyRequest = params;
      return { destroyed: ['shared-e-1'] };
    });
    const destroyed = await processMutationRow({
      transport: destroyTransport,
      account,
      handlers,
      row: {
        mutation_type: MUTATION_TYPES.DESTROY,
        request_json: JSON.stringify({ messageIds: [message.id] }),
      },
    });
    expect(destroyed.ok).toBe(true);
    expect(destroyRequest.accountId).toBe(shared.remote_account_id);
    expect(await engine.get('SELECT id FROM messages WHERE id = ?', [message.id])).toBeNull();
  });

  it('copies across accounts without stale local keyword or date fields', async () => {
    const shared = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'Shared',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'acct-shared',
      isPrimary: false,
      isPersonal: false,
    })).row;
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: shared.id,
      folders: [{ remoteId: 'shared-team', name: 'Team' }],
    });
    const destination = await engine.get(
      `SELECT id FROM folders WHERE account_id = ? AND remote_id = 'shared-team'`,
      [shared.id],
    );
    const transport = new MockTransport();
    let copyRequest;
    let copyCalls = 0;
    transport.handle('Email/copy', (params) => {
      copyCalls += 1;
      copyRequest = params;
      return { created: { 'e-1': { id: 'shared-copy-1' } } };
    });
    transport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => ({
        ...emailFixture(id),
        mailboxIds: { 'shared-team': true },
        keywords: { $seen: true, $flagged: true },
        receivedAt: '2026-06-02T03:04:05Z',
      })),
      state: 'shared-es2',
    }));
    transport.handle('Mailbox/get', (params) => {
      expect(params).toMatchObject({
        accountId: 'acct-shared',
        ids: ['shared-team'],
      });
      return {
        list: [{
          id: 'shared-team',
          name: 'Team',
          totalEmails: 7,
          unreadEmails: 3,
          totalThreads: 6,
          unreadThreads: 2,
        }],
        state: 'shared-mb2',
      };
    });

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: {
        mutation_type: MUTATION_TYPES.COPY_TO_FOLDERS,
        request_json: JSON.stringify({
          messageIds: [messageId],
          addFolderIds: [destination.id],
          removeFolderIds: [],
        }),
      },
    });

    expect(result.ok).toBe(true);
    expect(copyCalls).toBe(1);
    expect(copyRequest).toMatchObject({
      fromAccountId: 'acct-1',
      accountId: 'acct-shared',
      onSuccessDestroyOriginal: false,
    });
    const create = copyRequest.create['e-1'];
    expect(create).toEqual({
      id: 'e-1',
      mailboxIds: { 'shared-team': true },
    });
    expect(create.keywords).toBeUndefined();
    expect(create.receivedAt).toBeUndefined();
    expect(await engine.get(
      `SELECT id FROM messages WHERE account_id = ? AND remote_id = 'e-1'`,
      [account.id],
    )).toBeTruthy();
    const copied = await engine.get(
      `SELECT id, keywords_json, received_at FROM messages
        WHERE account_id = ? AND remote_id = 'shared-copy-1'`,
      [shared.id],
    );
    expect(JSON.parse(copied.keywords_json)).toEqual({ $seen: true, $flagged: true });
    expect(copied.received_at).toBe(Date.parse('2026-06-02T03:04:05Z'));
    expect(await engine.get(
      'SELECT folder_id FROM folder_messages WHERE message_id = ?',
      [copied.id],
    )).toEqual({ folder_id: destination.id });
    expect(await engine.get(
      `SELECT total_emails, unread_emails, total_threads, unread_threads
         FROM folders WHERE id = ?`,
      [destination.id],
    )).toEqual({
      total_emails: 7,
      unread_emails: 3,
      total_threads: 6,
      unread_threads: 2,
    });
  });

  it('uses the Stalwart 0.15 copy shape only after explicit id rejection', async () => {
    const shared = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'Shared',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'acct-shared',
      isPrimary: false,
      isPersonal: false,
    })).row;
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: shared.id,
      folders: [{ remoteId: 'shared-team', name: 'Team' }],
    });
    const destination = await engine.get(
      `SELECT id FROM folders WHERE account_id = ? AND remote_id = 'shared-team'`,
      [shared.id],
    );
    const transport = new MockTransport();
    const copyRequests = [];
    transport.handle('Email/copy', (params) => {
      copyRequests.push(params);
      if (copyRequests.length === 1) {
        return {
          notCreated: {
            'e-1': {
              type: 'invalidProperties',
              properties: ['id'],
            },
          },
        };
      }
      return { created: { 'e-1': { id: 'legacy-copy-1' } } };
    });
    transport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => ({
        ...emailFixture(id),
        mailboxIds: { 'shared-team': true },
      })),
      state: 'legacy-copy-state',
    }));

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: {
        mutation_type: MUTATION_TYPES.COPY_TO_FOLDERS,
        request_json: JSON.stringify({
          messageIds: [messageId],
          addFolderIds: [destination.id],
        }),
      },
    });

    expect(result.ok).toBe(true);
    expect(copyRequests).toHaveLength(2);
    expect(copyRequests[0].create['e-1']).toEqual({
      id: 'e-1',
      mailboxIds: { 'shared-team': true },
    });
    expect(copyRequests[1].create['e-1']).toEqual({
      mailboxIds: { 'shared-team': true },
    });
  });

  it('reconciles shared alreadyExists ids and reports per-source copy failures', async () => {
    const secondTransport = new MockTransport();
    secondTransport.handle('Email/query', () => ({
      ids: ['e-1', 'e-2', 'e-3'],
      total: 3,
      queryState: 'q2',
      canCalculateChanges: true,
      position: 0,
    }));
    secondTransport.handle('Email/get', (params) => ({
      list: params.ids.map(emailFixture),
      state: 'es2',
    }));
    await syncFolderWindow({
      transport: secondTransport,
      account,
      folder: inbox,
      handlers,
    });
    const sourceRows = await engine.all(
      `SELECT id, remote_id FROM messages
        WHERE account_id = ? AND remote_id IN ('e-1','e-2','e-3') ORDER BY remote_id`,
      [account.id],
    );
    const shared = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'Shared',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'acct-shared',
      isPrimary: false,
      isPersonal: false,
    })).row;
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: shared.id,
      folders: [{ remoteId: 'shared-team', name: 'Team' }],
    });
    const destination = await engine.get(
      `SELECT id FROM folders WHERE account_id = ? AND remote_id = 'shared-team'`,
      [shared.id],
    );
    const transport = new MockTransport({
      capabilities: {
        'urn:ietf:params:jmap:core': {
          maxObjectsInGet: 500,
          maxObjectsInSet: 1,
        },
      },
    });
    transport.handle('Email/copy', () => ({
      notCreated: {
        [sourceRows[0].remote_id]: {
          type: 'alreadyExists',
          existingId: 'existing-copy',
        },
        [sourceRows[1].remote_id]: {
          type: 'alreadyExists',
          existingId: 'existing-copy',
        },
        [sourceRows[2].remote_id]: { type: 'forbidden' },
      },
    }));
    let membershipAdded = false;
    transport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => ({
        ...emailFixture(id),
        mailboxIds: membershipAdded
          ? { 'shared-team': true }
          : { 'shared-elsewhere': true },
      })),
      state: 'shared-es3',
    }));
    transport.handle('Email/set', (params) => {
      expect(params).toEqual({
        accountId: 'acct-shared',
        update: {
          'existing-copy': {
            'mailboxIds/shared-team': true,
          },
        },
      });
      membershipAdded = true;
      return { updated: { 'existing-copy': null }, newState: 'shared-es3a' };
    });

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: {
        mutation_type: MUTATION_TYPES.COPY_TO_FOLDERS,
        request_json: JSON.stringify({
          messageIds: sourceRows.map((message) => message.id),
          addFolderIds: [destination.id],
        }),
      },
    });
    expect(result.ok).toBe(false);
    expect(transport.requests.filter((request) =>
      request.methodCalls[0]?.[0] === 'Email/copy')).toHaveLength(3);
    expect(result.result.succeededIds).toEqual([
      sourceRows[0].id,
      sourceRows[1].id,
    ]);
    expect(result.result.errors[String(sourceRows[2].id)]).toMatchObject({
      type: 'notCreated',
      detail: { type: 'forbidden' },
    });
    expect(transport.requests.filter((request) =>
      request.methodCalls[0]?.[0] === 'Email/set')).toHaveLength(1);
    expect(await engine.get(
      `SELECT id FROM messages WHERE account_id = ? AND remote_id = 'existing-copy'`,
      [shared.id],
    )).toBeTruthy();
    expect(await engine.all(
      `SELECT id FROM messages WHERE account_id = ? AND remote_id IN ('e-1','e-2','e-3')`,
      [account.id],
    )).toHaveLength(3);
  });

  it('does not retry a completed copy when destination Email/get is incomplete', async () => {
    const shared = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'Shared',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'acct-shared',
      isPrimary: false,
      isPersonal: false,
    })).row;
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: shared.id,
      folders: [{ remoteId: 'shared-team', name: 'Team' }],
    });
    const destination = await engine.get(
      `SELECT id FROM folders WHERE account_id = ? AND remote_id = 'shared-team'`,
      [shared.id],
    );
    const transport = new MockTransport();
    let copyCalls = 0;
    transport.handle('Email/copy', () => {
      copyCalls += 1;
      return { created: { 'e-1': { id: 'copied-but-not-readable-yet' } } };
    });
    transport.handle('Email/get', () => ({
      list: [],
      notFound: ['copied-but-not-readable-yet'],
      state: 'shared-es4',
    }));

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: {
        mutation_type: MUTATION_TYPES.COPY_TO_FOLDERS,
        request_json: JSON.stringify({
          messageIds: [messageId],
          addFolderIds: [destination.id],
        }),
      },
    });

    expect(copyCalls).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      type: 'copyReconcileFailed',
      terminal: true,
    });
    expect(result.result.succeededIds).toEqual([messageId]);
    expect(result.result.copied[String(messageId)]).toEqual({
      remoteId: 'copied-but-not-readable-yet',
      sourceId: messageId,
    });
  });

  it('classifies a later transport failure as terminal after an earlier copy succeeded', async () => {
    const sourceTransport = new MockTransport();
    sourceTransport.handle('Email/query', () => ({
      ids: ['e-1', 'e-2'],
      total: 2,
      queryState: 'q-partial',
      canCalculateChanges: true,
      position: 0,
    }));
    sourceTransport.handle('Email/get', (params) => ({
      list: params.ids.map(emailFixture),
      state: 'es-partial',
    }));
    await syncFolderWindow({
      transport: sourceTransport,
      account,
      folder: inbox,
      handlers,
    });
    const sourceRows = await engine.all(
      `SELECT id, remote_id FROM messages
        WHERE account_id = ? AND remote_id IN ('e-1','e-2') ORDER BY remote_id`,
      [account.id],
    );
    const shared = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'Shared',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'acct-shared',
      isPrimary: false,
      isPersonal: false,
    })).row;
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: shared.id,
      folders: [{ remoteId: 'shared-team', name: 'Team' }],
    });
    const destination = await engine.get(
      `SELECT id FROM folders WHERE account_id = ? AND remote_id = 'shared-team'`,
      [shared.id],
    );
    let copyCalls = 0;
    const requests = [];
    const transport = {
      session: {
        capabilities: {
          'urn:ietf:params:jmap:core': {
            maxObjectsInGet: 500,
            maxObjectsInSet: 1,
          },
        },
      },
      async request(_using, methodCalls) {
        requests.push(methodCalls);
        const [method, params, callId] = methodCalls[0];
        if (method === 'Email/copy') {
          copyCalls += 1;
          if (copyCalls === 1) {
            const creationId = Object.keys(params.create)[0];
            return {
              methodResponses: [[
                'Email/copy',
                { created: { [creationId]: { id: 'partial-copy-1' } } },
                callId,
              ]],
            };
          }
          throw new Error('socket lost after first copy');
        }
        if (method === 'Email/get') {
          return {
            methodResponses: [[
              'Email/get',
              {
                list: params.ids.map((id) => ({
                  ...emailFixture(id),
                  mailboxIds: { 'shared-team': true },
                })),
                state: 'shared-es5',
              },
              callId,
            ]],
          };
        }
        if (method === 'Mailbox/get') {
          return {
            methodResponses: [[
              'Mailbox/get',
              {
                list: params.ids.map((id) => ({
                  id,
                  totalEmails: 1,
                  unreadEmails: 1,
                  totalThreads: 1,
                  unreadThreads: 1,
                })),
                state: 'shared-mb5',
              },
              callId,
            ]],
          };
        }
        throw new Error(`Unexpected method ${method}`);
      },
    };

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: {
        mutation_type: MUTATION_TYPES.COPY_TO_FOLDERS,
        request_json: JSON.stringify({
          messageIds: sourceRows.map((message) => message.id),
          addFolderIds: [destination.id],
        }),
      },
    });

    expect(copyCalls).toBe(2);
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      type: 'copyPartialSuccess',
      terminal: true,
      detail: { type: 'transport', message: 'socket lost after first copy' },
    });
    expect(result.result.succeededIds).toEqual([sourceRows[0].id]);
    expect(result.result.copied[String(sourceRows[0].id)]).toEqual({
      remoteId: 'partial-copy-1',
      sourceId: sourceRows[0].id,
    });
    expect(requests.filter((calls) => calls[0]?.[0] === 'Email/copy')).toHaveLength(2);
  });

  it.each(['serverPartialFail', 'unknownTemporaryFailure'])(
    'keeps pre-copy method error %s retryable',
    async (errorType) => {
      const shared = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
        displayName: 'Shared',
        serverOrigin: 'https://mail.example.com',
        remoteAccountId: 'acct-shared',
        isPrimary: false,
        isPersonal: false,
      })).row;
      await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
        accountId: shared.id,
        folders: [{ remoteId: 'shared-team', name: 'Team' }],
      });
      const destination = await engine.get(
        `SELECT id FROM folders WHERE account_id = ? AND remote_id = 'shared-team'`,
        [shared.id],
      );
      const transport = {
        session: {
          capabilities: {
            'urn:ietf:params:jmap:core': {
              maxObjectsInGet: 500,
              maxObjectsInSet: 500,
            },
          },
        },
        async request(_using, methodCalls) {
          return {
            methodResponses: [['error', { type: errorType }, methodCalls[0][2]]],
          };
        },
      };

      const result = await processMutationRow({
        transport,
        account,
        handlers,
        row: {
          mutation_type: MUTATION_TYPES.COPY_TO_FOLDERS,
          request_json: JSON.stringify({
            messageIds: [messageId],
            addFolderIds: [destination.id],
          }),
        },
      });

      expect(result.ok).toBe(false);
      expect(result.error.type).toBe(errorType);
      expect(result.error.terminal).toBeUndefined();
      expect(result.result.succeededIds).toEqual([]);
    },
  );

  it('returns unknownMessage for fully stale move and copy payloads', async () => {
    const shared = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'Shared',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'acct-shared',
      isPrimary: false,
      isPersonal: false,
    })).row;
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: shared.id,
      folders: [{ remoteId: 'shared-team', name: 'Team' }],
    });
    const destination = await engine.get(
      `SELECT id FROM folders WHERE account_id = ? AND remote_id = 'shared-team'`,
      [shared.id],
    );
    const transport = new MockTransport();
    transport.handle('Email/set', () => {
      throw new Error('stale messages must not reach Email/set');
    });
    transport.handle('Email/copy', () => {
      throw new Error('stale messages must not reach Email/copy');
    });

    const move = await processMutationRow({
      transport,
      account,
      handlers,
      row: {
        mutation_type: MUTATION_TYPES.MOVE_TO_FOLDERS,
        request_json: JSON.stringify({
          messageIds: [999_999],
          addFolderIds: [inbox.id],
          removeFolderIds: [],
        }),
      },
    });
    const copy = await processMutationRow({
      transport,
      account,
      handlers,
      row: {
        mutation_type: MUTATION_TYPES.COPY_TO_FOLDERS,
        request_json: JSON.stringify({
          messageIds: [999_999],
          addFolderIds: [destination.id],
        }),
      },
    });

    expect(move.error.type).toBe('unknownMessage');
    expect(copy.error.type).toBe('unknownMessage');
    expect(transport.requests).toHaveLength(0);
  });
});
