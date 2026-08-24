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

// ----- send-path helpers ---------------------------------------------
//
// Every send test needs the same scaffolding (Drafts, Sent, one
// identity) and most need to control the exact response tuples, which
// MockTransport cannot express: it always emits one tuple per call,
// named after the method. A bare transport literal is the established
// way to build exotic envelopes in this file.

async function seedSendScaffolding() {
  await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
    accountId: account.id,
    folders: [
      { remoteId: 'mb-drafts', name: 'Drafts', role: 'drafts', sortOrder: 1 },
      { remoteId: 'mb-sent', name: 'Sent', role: 'sent', sortOrder: 2 },
    ],
  });
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
  const drafts = await engine.get(
    'SELECT id FROM folders WHERE account_id = ? AND remote_id = ?',
    [account.id, 'mb-drafts'],
  );
  const sent = await engine.get(
    'SELECT id FROM folders WHERE account_id = ? AND remote_id = ?',
    [account.id, 'mb-sent'],
  );
  const identity = await engine.get(
    'SELECT id FROM identities WHERE account_id = ? AND remote_id = ?',
    [account.id, 'id-1'],
  );
  // An open Sent mailbox window, so the "did this land in Sent?"
  // assertions are about real rows rather than an empty table. Without
  // it, applySendLocally has no view to insert into and every
  // expectNothingFiledInSent() would pass regardless of the code.
  const ts = Date.now();
  await engine.run(
    `INSERT INTO query_views(
       account_id, view_type, folder_id, filter_json, sort_json,
       query_state, total, created_at, updated_at, last_accessed_at
     ) VALUES (?, 'mailbox-window', ?, '{}', '[]', 'qs', 0, ?, ?, ?)`,
    [account.id, sent.id, ts, ts, ts],
  );
  return { drafts, sent, identity };
}

async function insertSendMutation({
  drafts, sent, to, cc, bcc, replyTo, inReplyTo, references,
}: any) {
  const identity = await engine.get(
    'SELECT id FROM identities WHERE account_id = ? AND remote_id = ?',
    [account.id, 'id-1'],
  );
  return handlers[DB_RPC.PENDING_MUTATION_INSERT]({
    accountId: account.id,
    mutationType: MUTATION_TYPES.SEND,
    requestJson: JSON.stringify({
      identityId: identity.id,
      to: to ?? [{ email: 'rcpt@example.com' }],
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references ? { references } : {}),
      subject: 'Hello',
      textBody: 'Hi.',
      draftsFolderId: drafts.id,
      sentFolderId: sent.id,
      outboxFolderId: null,
    }),
  });
}

/** A SEND row for processMutationRow, without touching the queue. */
function sendRow({
  drafts, sent, identityId, id = 9001, phase = null, checkpoint = null, htmlBody = null,
  to, cc, bcc,
}: any) {
  return {
    id,
    phase,
    ...(checkpoint ? { server_response_json: JSON.stringify(checkpoint) } : {}),
    mutation_type: MUTATION_TYPES.SEND,
    request_json: JSON.stringify({
      identityId: identityId ?? 1,
      to: to ?? [{ email: 'rcpt@example.com' }],
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
      subject: 'Hello',
      textBody: 'Hi.',
      ...(htmlBody ? { htmlBody } : {}),
      draftsFolderId: drafts.id,
      sentFolderId: sent.id,
      outboxFolderId: null,
    }),
  };
}

function emailInMailbox(id: string, mailboxRemoteId: string) {
  return {
    id,
    blobId: `b-${id}`,
    threadId: 'thr-new',
    mailboxIds: { [mailboxRemoteId]: true },
    keywords: { $seen: true },
    size: 100,
    receivedAt: new Date(NOW).toISOString(),
    sentAt: new Date(NOW).toISOString(),
    messageId: [`<${id}@example.com>`],
    from: [{ email: 'tester@example.com' }],
    to: [{ email: 'rcpt@example.com' }],
    sender: [{ email: 'tester@example.com' }],
    subject: 'Hello',
    preview: 'Hi.',
    hasAttachment: false,
  };
}

function sentEmailGetResponse(params: any) {
  return {
    list: (params.ids ?? []).map((id: string) => emailInMailbox(id, 'mb-sent')),
    state: 'es',
  };
}

/** Transport that returns whatever response tuples the test builds. */
function tupleTransport(build: (methodCalls: any[]) => any[]) {
  return {
    session: {
      capabilities: {
        'urn:ietf:params:jmap:core': { maxObjectsInGet: 500, maxObjectsInSet: 500 },
      },
    },
    async request(_using: any, methodCalls: any[]) {
      return { methodResponses: build(methodCalls) };
    },
  };
}

/** Answers the Email/set call and omits the submission's slot entirely. */
function onlyEmailSetTransport() {
  return tupleTransport(() => [
    ['Email/set', { created: { c1: { id: 'em-new', threadId: 'thr-new', size: 100 } } }, 'c1'],
  ]);
}

async function expectNothingFiledInSent() {
  const filed = await engine.get(
    `SELECT COUNT(*) AS n
       FROM folder_messages fm
       JOIN folders f ON f.id = fm.folder_id
      WHERE f.account_id = ? AND f.remote_id = 'mb-sent'`,
    [account.id],
  );
  expect(Number(filed.n)).toBe(0);

  const inView = await engine.get(
    `SELECT COUNT(*) AS n
       FROM query_view_items qvi
       JOIN query_views qv ON qv.id = qvi.view_id
       JOIN folders f ON f.id = qv.folder_id
      WHERE f.account_id = ? AND f.remote_id = 'mb-sent'`,
    [account.id],
  );
  expect(Number(inView.n)).toBe(0);
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

  it('batches all-alphabetic moves with one shared pointer patch', async () => {
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
    expect(setCalls[0]).toEqual({
      accountId: 'acct-1',
      update: {
        'e-1': {
          'mailboxIds/mb-archive': true,
          'mailboxIds/mb-inbox': null,
        },
        'e-2': {
          'mailboxIds/mb-archive': true,
          'mailboxIds/mb-inbox': null,
        },
      },
    });
    expect(transport.requests.map((request) => request.methodCalls[0][0]))
      .toEqual(['Email/set']);
  });

  it('preserves unrelated memberships when a numeric mailbox id requires replacement', async () => {
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [
        { remoteId: '7', name: 'Numeric destination' },
        { remoteId: 'mb-keep', name: 'Keep' },
      ],
    });
    const numeric = await engine.get(
      `SELECT id FROM folders WHERE account_id = ? AND remote_id = '7'`,
      [account.id],
    );
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

    const transport = new MockTransport();
    let getParams;
    let setParams;
    transport.handle('Email/get', (params) => {
      getParams = params;
      return {
        list: [{
          id: 'e-1',
          mailboxIds: {
            'mb-inbox': true,
            'mb-keep': true,
          },
        }],
        state: 'move-state-1',
      };
    });
    transport.handle('Email/set', (params) => {
      setParams = params;
      return { updated: { 'e-1': null } };
    });

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: {
        mutation_type: MUTATION_TYPES.MOVE_TO_FOLDERS,
        request_json: JSON.stringify({
          messageIds: [messageId],
          addFolderIds: [numeric.id],
          removeFolderIds: [inbox.id],
        }),
      },
    });

    expect(result.ok).toBe(true);
    expect(getParams).toEqual({
      accountId: 'acct-1',
      ids: ['e-1'],
      properties: ['id', 'mailboxIds'],
    });
    expect(setParams).toEqual({
      accountId: 'acct-1',
      update: {
        'e-1': {
          mailboxIds: {
            '7': true,
            'mb-keep': true,
          },
        },
      },
    });
    expect(Object.keys(setParams.update['e-1']).some((key) =>
      key.startsWith('mailboxIds/'))).toBe(false);
    const memberships = await engine.all(
      `SELECT f.remote_id
         FROM folder_messages fm
         JOIN folders f ON f.id = fm.folder_id
        WHERE fm.message_id = ?
        ORDER BY f.remote_id`,
      [messageId],
    );
    expect(memberships.map((membership) => membership.remote_id))
      .toEqual(['7', 'mb-keep']);
  });

  it('does not send an empty mailboxIds replacement for a move', async () => {
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [{ remoteId: '7', name: 'Numeric source' }],
    });
    const numeric = await engine.get(
      `SELECT id FROM folders WHERE account_id = ? AND remote_id = '7'`,
      [account.id],
    );
    const transport = new MockTransport();
    transport.handle('Email/get', () => ({
      list: [{ id: 'e-1', mailboxIds: { '7': true } }],
      state: 'move-state-2',
    }));

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: {
        mutation_type: MUTATION_TYPES.MOVE_TO_FOLDERS,
        request_json: JSON.stringify({
          messageIds: [messageId],
          addFolderIds: [],
          removeFolderIds: [numeric.id],
        }),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.result.errors[String(messageId)]).toMatchObject({
      type: 'invalidProperties',
      properties: ['mailboxIds'],
    });
    expect(transport.requests.map((request) => request.methodCalls[0][0]))
      .toEqual(['Email/get']);
  });

  it('fails numeric-id moves when current memberships cannot be fetched', async () => {
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [{ remoteId: '7', name: 'Numeric destination' }],
    });
    const numeric = await engine.get(
      `SELECT id FROM folders WHERE account_id = ? AND remote_id = '7'`,
      [account.id],
    );
    const transport = new MockTransport();
    transport.handle('Email/get', () => {
      throw new Error('membership lookup failed');
    });

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: {
        mutation_type: MUTATION_TYPES.MOVE_TO_FOLDERS,
        request_json: JSON.stringify({
          messageIds: [messageId],
          addFolderIds: [numeric.id],
          removeFolderIds: [inbox.id],
        }),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.result.errors[String(messageId)]).toEqual({
      type: 'transport',
      message: 'membership lookup failed',
    });
    expect(transport.requests.map((request) => request.methodCalls[0][0]))
      .toEqual(['Email/get']);
  });

  it('treats a message deleted elsewhere as moved on the replacement path too', async () => {
    // Both move paths have to agree that a message the server no longer
    // holds satisfies a move out of a folder. Erroring instead would
    // leave a conflicted row and a cache entry for a message that is
    // gone, which the patch path avoids by reconciling.
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [{ remoteId: '7', name: 'Numeric destination' }],
    });
    const numeric = await engine.get(
      `SELECT id FROM folders WHERE account_id = ? AND remote_id = '7'`,
      [account.id],
    );
    const transport = new MockTransport();
    transport.handle('Email/get', () => ({ list: [], notFound: ['e-1'] }));

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: {
        mutation_type: MUTATION_TYPES.MOVE_TO_FOLDERS,
        request_json: JSON.stringify({
          messageIds: [messageId],
          addFolderIds: [numeric.id],
          removeFolderIds: [inbox.id],
        }),
      },
    });

    expect(result.ok).toBe(true);
    expect(result.result.succeededIds).toEqual([messageId]);
    expect(transport.requests.map((request) => request.methodCalls[0][0]))
      .toEqual(['Email/get', 'Email/get']);
    const memberships = await engine.all(
      `SELECT folder_id FROM folder_messages WHERE message_id = ?`,
      [messageId],
    );
    expect(memberships).toEqual([]);
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
    // The submission is its own round trip against the already-created
    // Email, not a back-reference into a chained create, so that the
    // checkpoint between the two survives a lost response.
    expect(submitParams.create.s1.emailId).toBe('em-new');
    // RFC 8621 §7 carries the selected identity and complete recipient
    // set in the explicit submission envelope.
    expect(submitParams.create.s1.envelope).toEqual({
      mailFrom: { email: 'tester@example.com' },
      rcptTo: [{ email: 'rcpt@example.com' }],
    });
    const onSuccessUpdate = submitParams.onSuccessUpdateEmail['#s1'];
    expect(onSuccessUpdate).toEqual({
      mailboxIds: { 'mb-sent': true },
      'keywords/$draft': null,
      'keywords/$seen': true,
    });
    expect(Object.keys(onSuccessUpdate).some((key) =>
      key.startsWith('mailboxIds/'))).toBe(false);
    // No inline images means no blob uploads and no attachments.
    expect(transport.uploads).toHaveLength(0);
    expect(setParams.create.c1.attachments).toBeUndefined();
  });

  it('files a send into a numeric Sent id with a full mailboxIds replacement', async () => {
    const { drafts } = await seedSendScaffolding();
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [{ remoteId: '7', name: 'Numeric Sent', role: 'sent' }],
    });
    const sent = await engine.get(
      `SELECT id FROM folders WHERE account_id = ? AND remote_id = '7'`,
      [account.id],
    );
    const transport = new MockTransport();
    let submitParams;
    transport.handle('Email/set', () => ({
      created: { c1: { id: 'em-numeric-sent' } },
    }));
    transport.handle('EmailSubmission/set', (params) => {
      submitParams = params;
      return { created: { s1: { id: 'sub-numeric-sent' } } };
    });
    transport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailInMailbox(id, '7')),
      state: 'numeric-sent-state',
    }));

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: sendRow({ drafts, sent, id: 9101 }),
    });

    expect(result.ok).toBe(true);
    const onSuccessUpdate = submitParams.onSuccessUpdateEmail['#s1'];
    expect(onSuccessUpdate).toEqual({
      mailboxIds: { '7': true },
      'keywords/$draft': null,
      'keywords/$seen': true,
    });
    expect(Object.keys(onSuccessUpdate).some((key) =>
      key.startsWith('mailboxIds/'))).toBe(false);
  });

  it('omits mailboxIds when no Sent folder resolves', async () => {
    const { drafts } = await seedSendScaffolding();
    const transport = new MockTransport();
    let submitParams;
    transport.handle('Email/set', () => ({
      created: { c1: { id: 'em-without-sent' } },
    }));
    transport.handle('EmailSubmission/set', (params) => {
      submitParams = params;
      return { created: { s1: { id: 'sub-without-sent' } } };
    });
    transport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => emailInMailbox(id, 'mb-drafts')),
      state: 'without-sent-state',
    }));

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: sendRow({
        drafts,
        sent: { id: 999_999 },
        id: 9102,
      }),
    });

    expect(result.ok).toBe(true);
    expect(submitParams.onSuccessUpdateEmail['#s1']).toEqual({
      'keywords/$draft': null,
      'keywords/$seen': true,
    });
    expect(submitParams.onSuccessUpdateEmail['#s1']).not.toHaveProperty('mailboxIds');
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
    // RFC 8620 §3.6.2: when a JMAP server cannot run a method call,
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

  it('carries To, Cc, and Bcc in the complete submission envelope', async () => {
    const { drafts, sent } = await seedSendScaffolding();
    await insertSendMutation({
      drafts,
      sent,
      to: [{ email: 'to@example.com' }],
      cc: [{ email: 'cc@example.com' }],
      bcc: [{ email: 'bcc@example.com' }],
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
      return { created: { s1: { id: 'sub-1' } } };
    });
    transport.handle('Email/get', (params) => sentEmailGetResponse(params));

    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary.succeeded).toBe(1);
    expect(setParams.create.c1.to).toEqual([{ email: 'to@example.com' }]);
    expect(setParams.create.c1.cc).toEqual([{ email: 'cc@example.com' }]);
    expect(setParams.create.c1.bcc).toEqual([{ email: 'bcc@example.com' }]);
    expect(submitParams.create.s1.envelope).toEqual({
      mailFrom: { email: 'tester@example.com' },
      rcptTo: [
        { email: 'to@example.com' },
        { email: 'cc@example.com' },
        { email: 'bcc@example.com' },
      ],
    });
    const trust = await engine.get(
      `SELECT request_json FROM pending_mutations
        WHERE mutation_type = ?`,
      [MUTATION_TYPES.WHITELIST_SENDER],
    );
    expect(JSON.parse(trust.request_json).senders).toEqual([
      { email: 'to@example.com', name: null, sourceSentAt: expect.any(Number) },
      { email: 'cc@example.com', name: null, sourceSentAt: expect.any(Number) },
      { email: 'bcc@example.com', name: null, sourceSentAt: expect.any(Number) },
    ]);
  });

  it.each([
    ['Cc', { to: [], cc: [{ email: 'cc-only@example.com' }] }, 'cc-only@example.com'],
    ['Bcc', { to: [], bcc: [{ email: 'bcc-only@example.com' }] }, 'bcc-only@example.com'],
  ])('sends a non-empty envelope for a %s-only message', async (_field, request, email) => {
    const { drafts, sent } = await seedSendScaffolding();
    await insertSendMutation({ drafts, sent, ...request });

    const transport = new MockTransport();
    let submitParams;
    transport.handle('Email/set', () => ({
      created: { c1: { id: 'em-new', threadId: 'thr-new', size: 100 } },
    }));
    transport.handle('EmailSubmission/set', (params) => {
      submitParams = params;
      return { created: { s1: { id: 'sub-1' } } };
    });
    transport.handle('Email/get', (params) => sentEmailGetResponse(params));

    const summary = await drainOutbox({ transport, account, handlers });

    expect(summary.succeeded).toBe(1);
    expect(submitParams.create.s1.envelope.rcptTo).toEqual([{ email }]);
  });

  it('deduplicates envelope recipients while preserving the first addr-spec', async () => {
    const { drafts, sent } = await seedSendScaffolding();
    await insertSendMutation({
      drafts,
      sent,
      to: [{ name: 'Alice', email: 'Alice@Example.com' }],
      cc: [
        { name: 'Duplicate Alice', email: 'alice@example.com' },
        { name: 'Bob', email: 'bob@example.com' },
      ],
    });

    const transport = new MockTransport();
    let submitParams;
    transport.handle('Email/set', () => ({
      created: { c1: { id: 'em-new', threadId: 'thr-new', size: 100 } },
    }));
    transport.handle('EmailSubmission/set', (params) => {
      submitParams = params;
      return { created: { s1: { id: 'sub-1' } } };
    });
    transport.handle('Email/get', (params) => sentEmailGetResponse(params));

    const summary = await drainOutbox({ transport, account, handlers });

    expect(summary.succeeded).toBe(1);
    expect(submitParams.create.s1.envelope.rcptTo).toEqual([
      { email: 'Alice@Example.com' },
      { email: 'bob@example.com' },
    ]);
  });

  it('rejects an empty envelope before issuing a protocol call', async () => {
    const { drafts, sent } = await seedSendScaffolding();
    const calls: string[] = [];
    const transport = tupleTransport((methodCalls) => {
      calls.push(methodCalls[0][0]);
      return [];
    });

    const result = await processMutationRow({
      transport: transport as any,
      account,
      handlers,
      row: sendRow({ drafts, sent, to: [] }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      type: 'notSubmitted',
      terminal: true,
      detail: {
        type: 'noRecipients',
        description: 'At least one To, Cc, or Bcc recipient is required.',
      },
    });
    expect(calls).toEqual([]);
  });

  it('threads a reply with In-Reply-To and References so other clients follow it', async () => {
    // Subject prefixing is not threading (CS-2.6): without these headers a
    // reply arrives as a new conversation in every other mail client.
    const { drafts, sent } = await seedSendScaffolding();
    await insertSendMutation({
      drafts,
      sent,
      to: [{ email: 'to@example.com' }],
      inReplyTo: ['parent@example.com'],
      references: ['first@example.com', 'parent@example.com'],
      replyTo: [{ email: 'replies@example.com' }],
    });

    const transport = new MockTransport();
    let setParams;
    transport.handle('Email/set', (params) => {
      setParams = params;
      return { created: { c1: { id: 'em-new', threadId: 'thr-new', size: 100 } } };
    });
    transport.handle('EmailSubmission/set', () => ({ created: { s1: { id: 'sub-1' } } }));
    transport.handle('Email/get', (params) => sentEmailGetResponse(params));

    const summary = await drainOutbox({ transport, account, handlers });

    expect(summary.succeeded).toBe(1);
    expect(setParams.create.c1.inReplyTo).toEqual(['parent@example.com']);
    expect(setParams.create.c1.references).toEqual([
      'first@example.com',
      'parent@example.com',
    ]);
    expect(setParams.create.c1.replyTo).toEqual([{ email: 'replies@example.com' }]);
  });

  it('leaves threading headers off a message that is not a reply', async () => {
    const { drafts, sent } = await seedSendScaffolding();
    await insertSendMutation({ drafts, sent, inReplyTo: [], references: [] });

    const transport = new MockTransport();
    let setParams;
    transport.handle('Email/set', (params) => {
      setParams = params;
      return { created: { c1: { id: 'em-new', threadId: 'thr-new', size: 100 } } };
    });
    transport.handle('EmailSubmission/set', () => ({ created: { s1: { id: 'sub-1' } } }));
    transport.handle('Email/get', (params) => sentEmailGetResponse(params));

    await drainOutbox({ transport, account, handlers });

    expect(setParams.create.c1).not.toHaveProperty('inReplyTo');
    expect(setParams.create.c1).not.toHaveProperty('references');
  });

  it('fails the send when the EmailSubmission/set response is absent', async () => {
    // The envelope came back without the submission's response slot, so
    // whether the message was submitted is unknowable. Reporting success
    // here used to delete the mutation row that held the only durable
    // copy of the message.
    const { drafts, sent } = await seedSendScaffolding();
    await insertSendMutation({ drafts, sent });

    const transport = onlyEmailSetTransport();

    const summary = await drainOutbox({ transport: transport as any, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1 });

    const row = await engine.get(
      `SELECT local_status, request_json FROM pending_mutations
        WHERE mutation_type = ?`,
      [MUTATION_TYPES.SEND],
    );
    expect(row.local_status).toBe('conflicted');
    // The request payload survives so the message is recoverable.
    expect(JSON.parse(row.request_json).subject).toBe('Hello');
    await expectNothingFiledInSent();
  });

  it('marks an unreported submission terminal so the runner cannot retry it', async () => {
    // A retry could deliver a second copy, so the error carries the
    // terminal flag the outbox runner honours instead of backing off, and
    // the type that says the outcome could not be established.
    const { drafts, sent } = await seedSendScaffolding();
    const result = await processMutationRow({
      transport: onlyEmailSetTransport() as any,
      account,
      handlers,
      row: sendRow({ drafts, sent }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      type: 'outcomeUnknown',
      terminal: true,
      reason: 'noResponse',
    });
  });

  it('destroys the created Email when a terminal method error rejects submission', async () => {
    const { drafts, sent } = await seedSendScaffolding();
    await insertSendMutation({ drafts, sent });

    const destroyedIds: string[][] = [];
    const transport = tupleTransport((methodCalls) => {
      const [name, params, callId] = methodCalls[0];
      if (name === 'Email/set' && params.destroy) {
        destroyedIds.push(params.destroy);
        return [['Email/set', { destroyed: params.destroy }, callId]];
      }
      if (name === 'Email/set') {
        return [['Email/set', { created: { c1: { id: 'em-new' } } }, callId]];
      }
      return [['error', { type: 'serverFail', description: 'submission blew up' }, callId]];
    });

    const summary = await drainOutbox({ transport: transport as any, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1 });

    const row = await engine.get(
      `SELECT local_status, phase, server_response_json, error_json
         FROM pending_mutations WHERE mutation_type = ?`,
      [MUTATION_TYPES.SEND],
    );
    expect(row.local_status).toBe('conflicted');
    // An error tuple for the submission call is a definitive rejection:
    // RFC 8620 §3.6.2 has every method-level error except serverPartialFail
    // leave server state unchanged, and serverFail's own text says a retry
    // is expected to fail again. The server's reason is surfaced as a
    // terminal failure rather than parked as an ambiguous outcome.
    const error = JSON.parse(row.error_json);
    expect(error.type).toBe('serverFail');
    expect(error.terminal).toBe(true);
    expect(error.description).toBe('submission blew up');
    expect(row.phase).not.toBe('unknown');
    expect(destroyedIds).toEqual([['em-new']]);
    expect(JSON.parse(row.server_response_json).emailRemoteId).toBeNull();
    await expectNothingFiledInSent();
  });

  it('fails the send when the created Email id is missing', async () => {
    const { drafts, sent } = await seedSendScaffolding();
    await insertSendMutation({ drafts, sent });

    const transport = new MockTransport();
    transport.handle('Email/set', () => ({
      notCreated: { c1: { type: 'tooLarge', description: 'message too big' } },
    }));
    transport.handle('EmailSubmission/set', () => ({
      notCreated: { s1: { type: 'invalidProperties', properties: ['emailId'] } },
    }));
    transport.handle('Email/get', () => {
      throw new Error('Email/get must not run when nothing was created');
    });

    const summary = await drainOutbox({ transport, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1 });

    const row = await engine.get(
      `SELECT local_status, error_json FROM pending_mutations WHERE mutation_type = ?`,
      [MUTATION_TYPES.SEND],
    );
    expect(row.local_status).toBe('conflicted');
    const err = JSON.parse(row.error_json);
    expect(err.type).toBe('notCreated');
    expect(err.detail.type).toBe('tooLarge');
    await expectNothingFiledInSent();
  });

  it('marks a permanently rejected submission terminal, not retryable', async () => {
    // Unknown rejection types are terminal too: only the SetError
    // allowlist admits a rejection whose Email may be resubmitted later.
    const { drafts, sent } = await seedSendScaffolding();
    const transport = new MockTransport();
    transport.handle('Email/set', (params) => (params.destroy
      ? { destroyed: params.destroy }
      : { created: { c1: { id: 'em-new', threadId: 'thr-new', size: 100 } } }));
    transport.handle('EmailSubmission/set', () => ({
      notCreated: { s1: { type: 'forbiddenFrom' } },
    }));

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: sendRow({ drafts, sent }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      type: 'notSubmitted',
      terminal: true,
      detail: { type: 'forbiddenFrom' },
    });
  });

  it('marks a method-level create rejection terminal so the composer stops waiting', async () => {
    // A method-level error naming the request (RFC 8620 §3.6.2) earns
    // the same answer eight times over. Retrying is safe here — the
    // operation's Message-ID finds any Email a replay would otherwise
    // orphan — but the composer stays in its sending state until the
    // row reaches a terminal outcome, so two minutes of backoff buys
    // the user nothing but a frozen dialog.
    const { drafts, sent } = await seedSendScaffolding();
    const calls: string[] = [];
    const transport = tupleTransport((methodCalls) => {
      const [name, , callId] = methodCalls[0];
      calls.push(name);
      if (name === 'Email/query') return [[name, { ids: [] }, callId]];
      return [['error', { type: 'invalidArguments', description: 'bad create' }, callId]];
    });

    const result = await processMutationRow({
      transport: transport as any,
      account,
      handlers,
      row: sendRow({ drafts, sent }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      type: 'invalidArguments',
      description: 'bad create',
      terminal: true,
    });
    expect(calls).not.toContain('EmailSubmission/set');
    await expectNothingFiledInSent();
  });

  it('leaves a transient method-level create rejection retryable', async () => {
    const { drafts, sent } = await seedSendScaffolding();
    const transport = tupleTransport((methodCalls) => {
      const [name, , callId] = methodCalls[0];
      if (name === 'Email/query') return [[name, { ids: [] }, callId]];
      return [['error', { type: 'serverUnavailable' }, callId]];
    });

    const result = await processMutationRow({
      transport: transport as any,
      account,
      handlers,
      row: sendRow({ drafts, sent }),
    });

    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('serverUnavailable');
    expect(result.error.terminal).toBeUndefined();
  });

  it('leaves a rate-limited submission retryable', async () => {
    const { drafts, sent } = await seedSendScaffolding();
    const transport = new MockTransport();
    transport.handle('Email/set', () => ({
      created: { c1: { id: 'em-new', threadId: 'thr-new', size: 100 } },
    }));
    transport.handle('EmailSubmission/set', () => ({
      notCreated: { s1: { type: 'rateLimit' } },
    }));

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: sendRow({ drafts, sent }),
    });

    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('notSubmitted');
    expect(result.error.terminal).toBeUndefined();
  });

  it('destroys the created Email after a terminal invalid envelope rejection', async () => {
    const { drafts, sent } = await seedSendScaffolding();
    const inserted = await insertSendMutation({
      drafts,
      sent,
      to: [{ email: 'bob@mail.internal' }],
    });
    const description = 'Invalid e-mail address "bob@mail.internal".';
    const destroyedIds: string[][] = [];
    const transport = new MockTransport();
    transport.handle('Email/set', (params) => {
      if (params.destroy) {
        destroyedIds.push(params.destroy);
        return { destroyed: params.destroy };
      }
      return { created: { c1: { id: 'em-new', threadId: 'thr-new', size: 100 } } };
    });
    transport.handle('EmailSubmission/set', () => ({
      notCreated: {
        s1: {
          type: 'invalidProperties',
          description,
          properties: ['envelope'],
        },
      },
    }));
    const expectedError = {
      type: 'notSubmitted',
      detail: {
        type: 'invalidProperties',
        description,
        properties: ['envelope'],
      },
      terminal: true,
    };
    const pending = await engine.get('SELECT * FROM pending_mutations WHERE id = ?', [inserted.id]);
    const result = await processMutationRow({ transport, account, handlers, row: pending });

    // CS-1.5 retains the submission reason while removing the Email that
    // has no purpose after the server definitively rejected submission.
    expect(result).toEqual({ ok: false, error: expectedError });
    expect(destroyedIds).toEqual([['em-new']]);
    const row = await engine.get(
      'SELECT phase, server_response_json FROM pending_mutations WHERE id = ?',
      [inserted.id],
    );
    // Rewound past the create too: the row must not claim an Email that
    // was just destroyed.
    expect(row.phase).toBe('queued');
    expect(JSON.parse(row.server_response_json).emailRemoteId).toBeNull();
  });

  it('returns the terminal submission error when cleanup destroy is rejected', async () => {
    const { drafts, sent } = await seedSendScaffolding();
    const inserted = await insertSendMutation({ drafts, sent });
    let destroyCalls = 0;
    const transport = tupleTransport((methodCalls) => {
      const [name, params, callId] = methodCalls[0];
      if (name === 'Email/set' && params.destroy) {
        destroyCalls += 1;
        return [['error', { type: 'serverFail', description: 'cleanup failed' }, callId]];
      }
      if (name === 'Email/set') {
        return [['Email/set', { created: { c1: { id: 'em-cleanup-fails' } } }, callId]];
      }
      return [['error', { type: 'invalidArguments', description: 'bad identityId' }, callId]];
    });
    const expectedError = {
      type: 'invalidArguments',
      description: 'bad identityId',
      detail: { type: 'invalidArguments', description: 'bad identityId' },
      terminal: true,
    };
    const pending = await engine.get('SELECT * FROM pending_mutations WHERE id = ?', [inserted.id]);
    const result = await processMutationRow({
      transport: transport as any,
      account,
      handlers,
      row: pending,
    });

    // Cleanup is best-effort so its failure cannot hide the definitive
    // submission reason the composer needs to present.
    expect(result).toEqual({ ok: false, error: expectedError });
    expect(destroyCalls).toBe(1);
    const row = await engine.get(
      'SELECT server_response_json FROM pending_mutations WHERE id = ?',
      [inserted.id],
    );
    expect(JSON.parse(row.server_response_json).emailRemoteId).toBeNull();
  });

  it('does not file into Sent when the server left the message in Drafts', async () => {
    // The submission succeeded, so the message is in transit and must
    // not be re-submitted. But onSuccessUpdateEmail failed to move it,
    // so the local Sent view must not claim otherwise.
    const { drafts, sent } = await seedSendScaffolding();
    await insertSendMutation({ drafts, sent });

    const transport = tupleTransport((methodCalls) => {
      const isGet = methodCalls?.[0]?.[0] === 'Email/get';
      if (isGet) {
        return [[
          'Email/get',
          { list: [emailInMailbox('em-new', 'mb-drafts')], state: 'es' },
          'r1',
        ]];
      }
      return [
        ['Email/set', { created: { c1: { id: 'em-new' } } }, 'c1'],
        ['EmailSubmission/set', { created: { s1: { id: 'sub-1' } } }, 's1'],
        // Implicit Email/set from onSuccessUpdateEmail, tagged with the
        // submission's call id (RFC 8621 §7.5).
        ['Email/set', { notUpdated: { 'em-new': { type: 'forbidden' } } }, 's1'],
      ];
    });

    const summary = await drainOutbox({ transport: transport as any, account, handlers });
    // The send itself succeeded: it must not be retried.
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    await expectNothingFiledInSent();
  });

  it('reports filing unconfirmed when the implicit patch is rejected but the message is in Sent', async () => {
    // Isolates the implicit-response check: Email/get says Sent, so the
    // only thing that can make filing unconfirmed is the notUpdated
    // entry in the implicit Email/set. Removing that check would flip
    // `filed` to true here.
    const { drafts, sent } = await seedSendScaffolding();
    const transport = tupleTransport((methodCalls) => {
      if (methodCalls?.[0]?.[0] === 'Email/get') {
        return [['Email/get', sentEmailGetResponse(methodCalls[0][1]), 'r1']];
      }
      return [
        ['Email/set', { created: { c1: { id: 'em-new' } } }, 'c1'],
        ['EmailSubmission/set', { created: { s1: { id: 'sub-1' } } }, 's1'],
        ['Email/set', { notUpdated: { 'em-new': { type: 'forbidden' } } }, 's1'],
      ];
    });

    const result = await processMutationRow({
      transport: transport as any,
      account,
      handlers,
      row: sendRow({ drafts, sent }),
    });

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      submissionRemoteId: 'sub-1',
      createdRemoteId: 'em-new',
      filed: false,
    });
  });

  it('reports the message filed when the server confirms it in Sent', async () => {
    const { drafts, sent } = await seedSendScaffolding();
    const transport = new MockTransport();
    transport.handle('Email/set', () => ({ created: { c1: { id: 'em-new' } } }));
    transport.handle('EmailSubmission/set', () => ({ created: { s1: { id: 'sub-1' } } }));
    transport.handle('Email/get', (params) => sentEmailGetResponse(params));
    // The CS-1.14 reconciliation asks the server for the view's position
    // and total rather than assuming them.
    transport.handle('Email/query', () => ({
      ids: ['em-new'], position: 0, total: 1, queryState: 'qs2',
    }));
    transport.handle('Mailbox/get', (params) => {
      expect(params).toMatchObject({
        ids: ['mb-sent'],
        properties: ['id', 'totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads'],
      });
      return {
        list: [{
          id: 'mb-sent',
          totalEmails: 11,
          unreadEmails: 4,
          totalThreads: 8,
          unreadThreads: 3,
        }],
        state: 'ms2',
      };
    });

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: sendRow({ drafts, sent }),
    });

    expect(result.ok).toBe(true);
    expect(result.result.filed).toBe(true);
    // The seeded Sent window now holds the message.
    const inView = await engine.get(
      `SELECT COUNT(*) AS n
         FROM query_view_items qvi
         JOIN query_views qv ON qv.id = qvi.view_id
         JOIN folders f ON f.id = qv.folder_id
        WHERE f.account_id = ? AND f.remote_id = 'mb-sent'`,
      [account.id],
    );
    expect(Number(inView.n)).toBe(1);
    expect(await engine.get(
      `SELECT total_emails, unread_emails, total_threads, unread_threads
         FROM folders WHERE id = ?`,
      [sent.id],
    )).toEqual({
      total_emails: 11,
      unread_emails: 4,
      total_threads: 8,
      unread_threads: 3,
    });
  });

  it('never issues a submission when the create response is missing', async () => {
    // Creation and submission are separate round trips now, so an absent
    // Email/set response means nothing was submitted and a retry is
    // safe. The important part is that no submission was attempted.
    const { drafts, sent } = await seedSendScaffolding();
    const calls: string[] = [];
    const transport = tupleTransport((methodCalls) => {
      calls.push(methodCalls[0][0]);
      return [];
    });

    const result = await processMutationRow({
      transport: transport as any,
      account,
      handlers,
      row: sendRow({ drafts, sent }),
    });

    expect(result.ok).toBe(false);
    // A first attempt goes straight to the create — there is no earlier
    // draft to look for — and stops there.
    expect(calls).toEqual(['Email/set']);
    expect(calls).not.toContain('EmailSubmission/set');
    expect(result.error.terminal).toBeUndefined();
    await expectNothingFiledInSent();
    expect(await engine.get(
      `SELECT id FROM pending_mutations WHERE mutation_type = ?`,
      [MUTATION_TYPES.WHITELIST_SENDER],
    )).toBeNull();
  });

  it('persists each phase before the call it guards', async () => {
    // Read the row from inside the transport handlers, which is the only
    // way to observe what a crashed worker would have left behind. The
    // submission phase is the one that matters: it must already say
    // "may have been submitted" while the submission is in flight,
    // because that is the window a replay would duplicate.
    const { drafts, sent } = await seedSendScaffolding();
    const inserted = await insertSendMutation({ drafts, sent });
    const observed: Array<{ at: string; phase: string; checkpoint: any }> = [];

    async function snapshot(at: string) {
      const row = await engine.get(
        'SELECT phase, server_response_json FROM pending_mutations WHERE id = ?',
        [inserted.id],
      );
      observed.push({
        at,
        phase: row?.phase,
        checkpoint: row?.server_response_json ? JSON.parse(row.server_response_json) : null,
      });
    }

    const transport = new MockTransport();
    let createParams;
    transport.handle('Email/set', async (params) => {
      createParams = params;
      await snapshot('during Email/set');
      return { created: { c1: { id: 'em-new' } } };
    });
    transport.handle('EmailSubmission/set', async () => {
      await snapshot('during EmailSubmission/set');
      return { created: { s1: { id: 'sub-1' } } };
    });
    transport.handle('Email/get', (params) => sentEmailGetResponse(params));

    await drainOutbox({ transport, account, handlers });

    const duringCreate = observed.find((o) => o.at === 'during Email/set');
    expect(duringCreate.phase).toBe('queued');
    expect(duringCreate.checkpoint.messageId).toMatch(/^<[0-9a-f]+@example\.com>$/);
    expect(duringCreate.checkpoint.emailRemoteId).toBeNull();

    const duringSubmit = observed.find((o) => o.at === 'during EmailSubmission/set');
    expect(duringSubmit.phase).toBe('submitting');
    expect(duringSubmit.checkpoint.emailRemoteId).toBe('em-new');

    // The header sent matches the persisted id, minus the angle brackets
    // JMAP strips (RFC 8621 §4.1.2.5).
    expect(createParams.create.c1.messageId).toEqual([
      duringCreate.checkpoint.messageId.replace(/^<|>$/g, ''),
    ]);
  });

  it('reuses the same Message-ID when a failed send is retried', async () => {
    const { drafts, sent } = await seedSendScaffolding();
    const inserted = await insertSendMutation({ drafts, sent });
    const suppliedIds: string[][] = [];
    let attempt = 0;

    const transport = new MockTransport();
    transport.handle('Email/set', (params) => {
      suppliedIds.push(params.create.c1.messageId);
      attempt += 1;
      // First attempt: the create response never arrives.
      return attempt === 1 ? {} : { created: { c1: { id: 'em-new' } } };
    });
    transport.handle('EmailSubmission/set', () => ({ created: { s1: { id: 'sub-1' } } }));
    transport.handle('Email/get', (params) => sentEmailGetResponse(params));
    // The second pass scans for a draft the lost first response might
    // have left behind. Here there is none — the create never reached
    // the server — and the scan has to say so, because a scan that
    // cannot answer stops the send rather than creating.
    transport.handle('Email/query', () => ({ ids: [], total: 0, queryState: 'q' }));

    // Two passes over the same row, as a retry would do.
    await drainOutbox({ transport, account, handlers, mutationId: inserted.id });
    await engine.run(
      `UPDATE pending_mutations SET local_status = 'pending' WHERE id = ?`,
      [inserted.id],
    );
    await drainOutbox({ transport, account, handlers, mutationId: inserted.id });

    expect(suppliedIds).toHaveLength(2);
    expect(suppliedIds[1]).toEqual(suppliedIds[0]);
  });

  it('resumes after the Email was created without creating a second one', async () => {
    // The worker died between create and submit. The checkpoint says an
    // Email already exists, so this attempt must submit that one.
    const { drafts, sent } = await seedSendScaffolding();
    const transport = new MockTransport();
    let createCalls = 0;
    let submittedEmailId = null;
    transport.handle('Email/set', () => {
      createCalls += 1;
      return { created: { c1: { id: 'should-not-be-used' } } };
    });
    transport.handle('EmailSubmission/set', (params) => {
      submittedEmailId = params.create.s1.emailId;
      return { created: { s1: { id: 'sub-1' } } };
    });
    transport.handle('Email/get', (params) => sentEmailGetResponse(params));

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: sendRow({
        drafts,
        sent,
        id: 4242,
        phase: 'created',
        checkpoint: {
          operationId: 'op-1',
          messageId: '<abc@example.com>',
          emailRemoteId: 'em-from-earlier-attempt',
          submissionRemoteId: null,
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(createCalls, 'the Email must not be created twice').toBe(0);
    expect(submittedEmailId).toBe('em-from-earlier-attempt');
  });

  it('rebuilds the same envelope when resuming after Email creation', async () => {
    const { drafts, sent } = await seedSendScaffolding();
    const envelopes = [];
    const request = {
      to: [{ name: 'Alice', email: 'Alice@Example.com' }],
      cc: [{ email: 'alice@example.com' }, { email: 'cc@example.com' }],
      bcc: [{ name: 'Hidden', email: 'bcc@example.com' }],
    };
    const transport = new MockTransport();
    transport.handle('Email/set', () => ({
      created: { c1: { id: 'em-first', threadId: 'thr-new', size: 100 } },
    }));
    transport.handle('EmailSubmission/set', (params) => {
      envelopes.push(params.create.s1.envelope);
      return { created: { s1: { id: `sub-${envelopes.length}` } } };
    });
    transport.handle('Email/get', (params) => sentEmailGetResponse(params));

    const first = await processMutationRow({
      transport,
      account,
      handlers,
      row: sendRow({ drafts, sent, id: 4270, ...request }),
    });
    const resumed = await processMutationRow({
      transport,
      account,
      handlers,
      row: sendRow({
        drafts,
        sent,
        id: 4271,
        ...request,
        phase: 'created',
        checkpoint: {
          operationId: 'op-envelope-resume',
          messageId: '<envelope@example.com>',
          emailRemoteId: 'em-from-earlier-attempt',
          submissionRemoteId: null,
        },
      }),
    });

    expect(first.ok).toBe(true);
    expect(resumed.ok).toBe(true);
    expect(envelopes).toHaveLength(2);
    expect(envelopes[1]).toEqual(envelopes[0]);
  });

  it('resumes after submission without submitting a second time', async () => {
    const { drafts, sent } = await seedSendScaffolding();
    const transport = new MockTransport();
    let submitCalls = 0;
    transport.handle('Email/set', () => ({ created: { c1: { id: 'nope' } } }));
    transport.handle('EmailSubmission/set', () => {
      submitCalls += 1;
      return { created: { s1: { id: 'nope' } } };
    });
    transport.handle('Email/get', (params) => sentEmailGetResponse(params));

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: sendRow({
        drafts,
        sent,
        id: 4243,
        phase: 'submitted',
        checkpoint: {
          operationId: 'op-2',
          messageId: '<def@example.com>',
          emailRemoteId: 'em-new',
          submissionRemoteId: 'sub-earlier',
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(submitCalls, 'an accepted submission must never be repeated').toBe(0);
    expect(result.result.submissionRemoteId).toBe('sub-earlier');
  });

  it('parks a lost submission response without destroying the created Email', async () => {
    const { drafts, sent } = await seedSendScaffolding();
    const inserted = await insertSendMutation({ drafts, sent });
    const destroyedIds: string[][] = [];
    const transport = tupleTransport((methodCalls) => {
      const [name, params, callId] = methodCalls[0];
      if (name === 'Email/set' && params.destroy) {
        destroyedIds.push(params.destroy);
        return [['Email/set', { destroyed: params.destroy }, callId]];
      }
      if (name === 'Email/set') {
        return [['Email/set', { created: { c1: { id: 'em-orphan' } } }, callId]];
      }
      // Server answered, but without reporting the submission.
      return [];
    });

    const result = await processMutationRow({
      transport: transport as any,
      account,
      handlers,
      row: sendRow({ drafts, sent, id: inserted.id }),
    });

    expect(result.ok).toBe(false);
    // One type classifies every parked send; the server's own word for
    // what went wrong is kept alongside it as the diagnostic.
    expect(result.error).toMatchObject({
      type: 'outcomeUnknown',
      terminal: true,
      reason: 'noResponse',
    });

    const row = await engine.get(
      'SELECT phase, server_response_json FROM pending_mutations WHERE id = ?',
      [inserted.id],
    );
    expect(row.phase).toBe('unknown');
    // The Email id and Message-ID survive, which is what makes the
    // ambiguity resolvable later instead of permanent.
    const checkpoint = JSON.parse(row.server_response_json);
    expect(checkpoint.emailRemoteId).toBe('em-orphan');
    expect(checkpoint.messageId).toMatch(/@example\.com>$/);
    // An unknown outcome may already be in transit; its Email remains as
    // evidence until mailbox reconciliation can establish what happened.
    expect(destroyedIds).toEqual([]);
    await expectNothingFiledInSent();
  });

  it('resolves an interrupted submission from the message being filed in Sent', async () => {
    // The worker died inside the submission round trip. The server's
    // onSuccessUpdateEmail only runs once a submission is accepted, so
    // finding the message in Sent without its draft flag is proof it
    // went out — the row can finish instead of stopping for a human.
    const { drafts, sent } = await seedSendScaffolding();
    let submitCalls = 0;
    const transport = new MockTransport();
    transport.handle('Email/set', () => {
      throw new Error('must not create a second Email');
    });
    transport.handle('EmailSubmission/set', () => {
      submitCalls += 1;
      return { created: { s1: { id: 'must-not-happen' } } };
    });
    transport.handle('EmailSubmission/query', () => ({ ids: [] }));
    transport.handle('Email/get', (params) => sentEmailGetResponse(params));

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: sendRow({
        drafts,
        sent,
        id: 4245,
        phase: 'submitting',
        checkpoint: {
          operationId: 'op-4',
          messageId: '<jkl@example.com>',
          emailRemoteId: 'em-new',
          submissionRemoteId: null,
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(submitCalls, 'an accepted submission must not be repeated').toBe(0);
  });

  it('resolves an interrupted submission from a retained submission record', async () => {
    const { drafts, sent } = await seedSendScaffolding();
    let submitCalls = 0;
    const transport = new MockTransport();
    transport.handle('Email/set', () => {
      throw new Error('must not create a second Email');
    });
    transport.handle('EmailSubmission/set', () => {
      submitCalls += 1;
      return { created: { s1: { id: 'must-not-happen' } } };
    });
    transport.handle('EmailSubmission/query', () => ({ ids: ['sub-found'] }));
    transport.handle('Email/get', (params) => sentEmailGetResponse(params));

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: sendRow({
        drafts,
        sent,
        id: 4246,
        phase: 'submitting',
        checkpoint: {
          operationId: 'op-5',
          messageId: '<mno@example.com>',
          emailRemoteId: 'em-new',
          submissionRemoteId: null,
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(submitCalls).toBe(0);
    expect(result.result.submissionRemoteId).toBe('sub-found');
  });

  it('parks an interrupted submission when the server shows no evidence', async () => {
    // Still in Drafts and no submission record: that is not proof it was
    // never sent, so the row must stop rather than guess.
    const { drafts, sent } = await seedSendScaffolding();
    let submitCalls = 0;
    const transport = new MockTransport();
    transport.handle('Email/set', () => {
      throw new Error('must not create a second Email');
    });
    transport.handle('EmailSubmission/set', () => {
      submitCalls += 1;
      return { created: { s1: { id: 'must-not-happen' } } };
    });
    transport.handle('EmailSubmission/query', () => ({ ids: [] }));
    transport.handle('Email/get', (params) => ({
      list: (params.ids ?? []).map((id: string) => ({
        ...emailInMailbox(id, 'mb-drafts'),
        keywords: { $draft: true },
      })),
      state: 'es',
    }));

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: sendRow({
        drafts,
        sent,
        id: 4247,
        phase: 'submitting',
        checkpoint: {
          operationId: 'op-6',
          messageId: '<pqr@example.com>',
          emailRemoteId: 'em-new',
          submissionRemoteId: null,
        },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ type: 'outcomeUnknown', terminal: true });
    expect(submitCalls).toBe(0);
  });

  it('adopts an Email left behind by a lost create response instead of making another', async () => {
    const { drafts, sent } = await seedSendScaffolding();
    let createCalls = 0;
    const transport = new MockTransport();
    transport.handle('Email/query', () => ({ ids: ['em-orphaned'] }));
    transport.handle('Email/set', () => {
      createCalls += 1;
      return { created: { c1: { id: 'em-duplicate' } } };
    });
    transport.handle('EmailSubmission/set', () => ({ created: { s1: { id: 'sub-1' } } }));
    transport.handle('Email/get', (params) => ({
      list: (params.ids ?? []).map((id: string) => ({
        ...emailInMailbox(id, 'mb-sent'),
        // The orphan carries the Message-ID this operation stamped.
        messageId: ['stu@example.com'],
      })),
      state: 'es',
    }));

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: sendRow({
        drafts,
        sent,
        id: 4248,
        phase: 'queued',
        checkpoint: {
          operationId: 'op-7',
          messageId: '<stu@example.com>',
          emailRemoteId: null,
          submissionRemoteId: null,
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(createCalls, 'the orphaned draft must be reused').toBe(0);
    expect(result.result.createdRemoteId).toBe('em-orphaned');
  });

  it('fails a send terminally when an inline image upload stalls', async () => {
    // Re-uploading a blob is safe, so this could be retried — but not
    // worth waiting for. The blob deadline is deliberately generous, and
    // eight of those plus backoff would hold the composer in its sending
    // state, with Close and Discard disabled, for a quarter of an hour.
    // The draft survives either way, so the user gets the choice.
    const { drafts, sent } = await seedSendScaffolding();
    const transport = new MockTransport();
    transport.handleUpload(() => {
      const err: any = new Error('JMAP HTTP request upload image/png timed out after 120000ms');
      err.type = 'httpRequestTimeout';
      throw err;
    });
    transport.handle('Email/set', () => {
      throw new Error('Email/set must not run when an inline image upload fails');
    });

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: sendRow({
        drafts,
        sent,
        id: 4263,
        htmlBody: `<img src="data:image/png;base64,${btoa('x')}">`,
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ type: 'uploadFailed', terminal: true });
  });

  it('leaves a server-reported upload rejection retryable', async () => {
    // A server that answered with a reason (a 503, say) may well accept
    // the same blob a moment later, so the retry budget still applies.
    const { drafts, sent } = await seedSendScaffolding();
    const transport = new MockTransport();
    transport.handleUpload(() => {
      throw new Error('JMAP upload failed: 503 Service Unavailable');
    });

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: sendRow({
        drafts,
        sent,
        id: 4264,
        htmlBody: `<img src="data:image/png;base64,${btoa('x')}">`,
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('uploadFailed');
    expect(result.error.terminal).toBeUndefined();
  });

  it('stops rather than create a second draft when the resume probe cannot reach the server', async () => {
    // The probe is the only thing standing between a retry and an
    // orphaned draft, and it can only rule one out by getting an answer.
    // A request that never reached the server has not ruled anything
    // out, so treating its silence as "nothing exists" would create a
    // second draft on every retry that happens while the network is
    // stalled.
    const { drafts, sent } = await seedSendScaffolding();
    const transport = new MockTransport();
    let createCalls = 0;
    transport.handle('Email/query', () => {
      const err: any = new Error('JMAP HTTP request timed out after 30000ms');
      err.type = 'httpRequestTimeout';
      throw err;
    });
    transport.handle('Email/set', () => {
      createCalls += 1;
      return { created: { c1: { id: 'em-would-be-orphan' } } };
    });

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: sendRow({
        drafts,
        sent,
        id: 4260,
        phase: 'queued',
        checkpoint: {
          operationId: 'op-probe',
          messageId: '<probe@example.com>',
          emailRemoteId: null,
          submissionRemoteId: null,
        },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      type: 'createProbeFailed',
      terminal: true,
      detail: { reason: 'httpRequestTimeout' },
    });
    expect(createCalls, 'nothing may be created while the probe is inconclusive').toBe(0);
    await expectNothingFiledInSent();
  });

  it('stops when the server rejects the resume probe instead of running it', async () => {
    // A method-level error means the query did not run, so the empty
    // result is an artefact of the rejection rather than a statement
    // about the mailbox. Reading it as "no draft exists" would create
    // the second copy just as surely as a stalled request does.
    const { drafts, sent } = await seedSendScaffolding();
    let createCalls = 0;
    const transport = tupleTransport((methodCalls) => {
      const method = methodCalls[0][0];
      if (method === 'Email/query') {
        return [
          ['error', { type: 'unsupportedFilter' }, 'q1'],
          ['error', { type: 'invalidResultReference' }, 'g1'],
        ];
      }
      createCalls += 1;
      return [['Email/set', { created: { c1: { id: 'em-would-be-orphan' } } }, 'c1']];
    });

    const result = await processMutationRow({
      transport: transport as any,
      account,
      handlers,
      row: sendRow({
        drafts,
        sent,
        id: 4261,
        phase: 'queued',
        checkpoint: {
          operationId: 'op-probe-2',
          messageId: '<probe2@example.com>',
          emailRemoteId: null,
          submissionRemoteId: null,
        },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      type: 'createProbeFailed',
      terminal: true,
      detail: { reason: 'scanRejected' },
    });
    expect(createCalls).toBe(0);
    await expectNothingFiledInSent();
  });

  it('stops when the resume probe stalls on the WebSocket', async () => {
    // The transport prefers the WebSocket whenever one is open, so its
    // deadline is the one a stalled probe hits in practice. A type the
    // classifier did not know about would fall through to the create.
    const { drafts, sent } = await seedSendScaffolding();
    const transport = new MockTransport();
    let createCalls = 0;
    transport.handle('Email/query', () => {
      const err: any = new Error('JMAP WebSocket request r9 timed out after 30000ms');
      err.type = 'wsRequestTimeout';
      throw err;
    });
    transport.handle('Email/set', () => {
      createCalls += 1;
      return { created: { c1: { id: 'em-would-be-orphan' } } };
    });

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: sendRow({
        drafts,
        sent,
        id: 4265,
        phase: 'queued',
        checkpoint: {
          operationId: 'op-probe-3',
          messageId: '<probe3@example.com>',
          emailRemoteId: null,
          submissionRemoteId: null,
        },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      type: 'createProbeFailed',
      terminal: true,
      detail: { reason: 'wsRequestTimeout' },
    });
    expect(createCalls).toBe(0);
  });

  it('does not probe on a first attempt', async () => {
    // The phase is written before the create, so a row that has never
    // carried one cannot have an Email on the server. Probing anyway
    // costs every send an extra round trip and gives the send another
    // way to fail for nothing. (The anchored Email/query after success is
    // the CS-1.14 view reconciliation, not a probe.)
    const { drafts, sent } = await seedSendScaffolding();
    const transport = new MockTransport();
    let created = false;
    transport.handle('Email/query', (params) => {
      if (!created || !params.anchor) {
        throw new Error('a first attempt must not probe for an earlier draft');
      }
      return { ids: ['em-new'], position: 0, total: 1, queryState: 'qs2' };
    });
    transport.handle('Email/set', () => {
      created = true;
      return { created: { c1: { id: 'em-new' } } };
    });
    transport.handle('EmailSubmission/set', () => ({ created: { s1: { id: 'sub-1' } } }));
    transport.handle('Email/get', (params) => sentEmailGetResponse(params));

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: sendRow({ drafts, sent, id: 4262 }),
    });

    expect(result.ok).toBe(true);
  });

  it('refuses to touch a send already parked as outcome-unknown', async () => {
    const { drafts, sent } = await seedSendScaffolding();
    const transport = new MockTransport();
    transport.handle('Email/set', () => {
      throw new Error('must not send anything for an unknown-outcome row');
    });
    transport.handle('EmailSubmission/set', () => {
      throw new Error('must not submit anything for an unknown-outcome row');
    });

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: sendRow({
        drafts,
        sent,
        id: 4244,
        phase: 'unknown',
        checkpoint: {
          operationId: 'op-3',
          messageId: '<ghi@example.com>',
          emailRemoteId: 'em-ambiguous',
          submissionRemoteId: null,
        },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ type: 'outcomeUnknown', terminal: true });
  });

  it('marks the Sent view stale when the message went out but filing did not', async () => {
    const { drafts, sent } = await seedSendScaffolding();
    const transport = tupleTransport((methodCalls) => {
      const method = methodCalls[0][0];
      if (method === 'Email/set') {
        return [['Email/set', { created: { c1: { id: 'em-new' } } }, 'c1']];
      }
      if (method === 'EmailSubmission/set') {
        return [
          ['EmailSubmission/set', { created: { s1: { id: 'sub-1' } } }, 's1'],
          // onSuccessUpdateEmail could not move it out of Drafts.
          ['Email/set', { notUpdated: { 'em-new': { type: 'forbidden' } } }, 's1'],
        ];
      }
      return [[
        'Email/get',
        { list: [emailInMailbox('em-new', 'mb-drafts')], state: 'es' },
        'r1',
      ]];
    });

    const result = await processMutationRow({
      transport: transport as any,
      account,
      handlers,
      row: sendRow({ drafts, sent }),
    });

    expect(result.ok).toBe(true);
    expect(result.result.filed).toBe(false);
    await expectNothingFiledInSent();
    // The next read of Sent has to rebuild from the server rather than
    // trusting a cache that is known to disagree.
    const view = await engine.get(
      `SELECT stale FROM query_views qv
         JOIN folders f ON f.id = qv.folder_id
        WHERE f.account_id = ? AND f.remote_id = 'mb-sent'`,
      [account.id],
    );
    expect(Number(view.stale)).toBe(1);
  });

  // ----- phase 3: filing is retried on its own (CS-1.10) --------------

  /** Park a real queue row at a post-submission phase. */
  async function parkAtPhase({ drafts, sent, phase, checkpoint }: any) {
    const inserted = await insertSendMutation({ drafts, sent });
    await engine.run(
      `UPDATE pending_mutations
          SET phase = ?, server_response_json = ?
        WHERE id = ?`,
      [phase, JSON.stringify(checkpoint), inserted.id],
    );
    return inserted.id;
  }

  it('resumes a cache-pending row into filing and nothing else', async () => {
    // Everything ahead of phase 3 is create-phase work: the identity
    // lookup, the inline-image uploads that build the body, the create,
    // the submission. A row whose phase says the server already accepted
    // the message must touch none of it — re-running the submission could
    // deliver twice, and failing on the preparation would report a
    // message already in transit as a failed send.
    const { drafts, sent } = await seedSendScaffolding();
    const transport = new MockTransport();
    const calls: string[] = [];
    transport.handle('Email/set', () => {
      calls.push('Email/set');
      return { created: { c1: { id: 'em-second' } } };
    });
    transport.handle('EmailSubmission/set', () => {
      calls.push('EmailSubmission/set');
      return { created: { s1: { id: 'sub-second' } } };
    });
    transport.handle('Email/query', (params) => {
      calls.push('Email/query');
      // Only the CS-1.14 view reconciliation may query, and it is
      // anchored at the filed message — never the create-probe scan.
      expect(params.anchor).toBe('em-new');
      return { ids: ['em-new'], position: 0, total: 1, queryState: 'q' };
    });
    transport.handle('Email/get', (params) => {
      calls.push('Email/get');
      return sentEmailGetResponse(params);
    });

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: sendRow({
        drafts,
        sent,
        id: 4247,
        // An identity that no longer resolves and an image that would have
        // to be uploaded again: both fail a resume that redoes the create.
        identityId: 9999,
        htmlBody: '<p><img src="data:image/png;base64,iVBORw0KGgo="></p>',
        phase: 'cache_pending',
        checkpoint: {
          operationId: 'op-6',
          messageId: '<pqr@example.com>',
          emailRemoteId: 'em-new',
          submissionRemoteId: 'sub-6',
          cacheAttempts: 0,
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      createdRemoteId: 'em-new',
      submissionRemoteId: 'sub-6',
      filed: true,
    });
    expect(
      calls,
      'only the filing read and its view reconciliation belong to phase 3',
    ).toEqual(['Email/get', 'Email/query']);
    expect(transport.uploads).toHaveLength(0);
  });

  it('keeps a cache-pending row for another filing attempt when filing fails', async () => {
    const { drafts, sent } = await seedSendScaffolding();
    const rowId = await parkAtPhase({
      drafts,
      sent,
      phase: 'cache_pending',
      checkpoint: {
        operationId: 'op-7',
        messageId: '<stu@example.com>',
        emailRemoteId: 'em-new',
        submissionRemoteId: 'sub-7',
        cacheAttempts: 0,
      },
    });
    const row = await engine.get('SELECT * FROM pending_mutations WHERE id = ?', [rowId]);

    const transport = new MockTransport();
    const calls: string[] = [];
    transport.handle('EmailSubmission/set', () => {
      calls.push('EmailSubmission/set');
      return { created: { s1: { id: 'must-not-happen' } } };
    });
    transport.handle('Email/get', () => {
      const err: any = new Error('socket died');
      err.type = 'wsRequestTimeout';
      throw err;
    });

    const result = await processMutationRow({ transport, account, handlers, row });

    expect(result.ok).toBe(false);
    // Retryable rather than terminal: the runner backs off and comes back
    // to the filing, which is the only thing left to do.
    expect(result.error.terminal).toBeUndefined();
    expect(result.error.type).toBe('cacheReconcileFailed');
    // And it says so: a failure past the point of no return must not read
    // as "your message did not go out".
    expect(result.error.result).toMatchObject({ submitted: true, filed: false });
    expect(calls, 'a filing failure must never re-enter submission').toEqual([]);

    const after = await engine.get(
      'SELECT phase, server_response_json FROM pending_mutations WHERE id = ?',
      [rowId],
    );
    expect(after.phase).toBe('cache_pending');
    expect(JSON.parse(after.server_response_json)).toMatchObject({
      emailRemoteId: 'em-new',
      submissionRemoteId: 'sub-7',
      cacheAttempts: 1,
    });
  });

  it('retires a cache-pending row once its filing budget is spent', async () => {
    // Two filing attempts have already failed. A third failure has to end
    // the row rather than keep it: a message that went out must not age
    // into a conflicted row asking the user what to do about it.
    const { drafts, sent } = await seedSendScaffolding();
    const rowId = await parkAtPhase({
      drafts,
      sent,
      phase: 'cache_pending',
      checkpoint: {
        operationId: 'op-8',
        messageId: '<vwx@example.com>',
        emailRemoteId: 'em-new',
        submissionRemoteId: 'sub-8',
        cacheAttempts: 2,
      },
    });

    const transport = new MockTransport();
    transport.handle('Email/get', () => {
      const err: any = new Error('still unreachable');
      err.type = 'wsRequestTimeout';
      throw err;
    });

    const summary = await drainOutbox({ transport, account, handlers, mutationId: rowId });

    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    const after = await engine.get(
      'SELECT id FROM pending_mutations WHERE id = ?',
      [rowId],
    );
    expect(after, 'the row is done, not conflicted').toBeFalsy();
    await expectNothingFiledInSent();
    // The cache is known to disagree with the server, so the next read of
    // Sent rebuilds instead of trusting it.
    const view = await engine.get(
      `SELECT stale FROM query_views qv
         JOIN folders f ON f.id = qv.folder_id
        WHERE f.account_id = ? AND f.remote_id = 'mb-sent'`,
      [account.id],
    );
    expect(Number(view.stale)).toBe(1);
  });

  it('restarts the give-up budget once the message is out', async () => {
    // The runner retires a row that reaches its attempt cap. Those
    // attempts were tries at getting the message onto the server, which
    // has now happened, so counting them against the local filing that
    // follows would retire a delivered message as a conflicted row on its
    // first filing failure. The filing has its own budget instead.
    const { drafts, sent } = await seedSendScaffolding();
    const rowId = await parkAtPhase({
      drafts,
      sent,
      phase: 'created',
      checkpoint: {
        operationId: 'op-12',
        messageId: '<yza@example.com>',
        emailRemoteId: 'em-new',
        submissionRemoteId: null,
        cacheAttempts: 0,
      },
    });
    await engine.run('UPDATE pending_mutations SET attempts = 7 WHERE id = ?', [rowId]);
    const row = await engine.get('SELECT * FROM pending_mutations WHERE id = ?', [rowId]);

    const transport = new MockTransport();
    transport.handle('EmailSubmission/set', () => ({ created: { s1: { id: 'sub-12' } } }));
    transport.handle('Email/get', () => {
      const err: any = new Error('cache write failed');
      err.type = 'wsRequestTimeout';
      throw err;
    });

    const result = await processMutationRow({ transport, account, handlers, row });

    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('cacheReconcileFailed');
    const after = await engine.get(
      'SELECT attempts, phase FROM pending_mutations WHERE id = ?',
      [rowId],
    );
    expect(after.phase).toBe('cache_pending');
    expect(Number(after.attempts), 'the send-phase attempts no longer count').toBe(0);
  });

  it('leaves the give-up budget alone before the message is out', async () => {
    // A row still trying to reach the server must keep aging toward the
    // cap, or a create that fails the same way every time would retry
    // forever. This one gets as far as writing two checkpoints — created,
    // then submitting — before the submission is refused.
    const { drafts, sent } = await seedSendScaffolding();
    const rowId = await parkAtPhase({
      drafts,
      sent,
      phase: 'queued',
      checkpoint: {
        operationId: 'op-13',
        messageId: '<bcd@example.com>',
        emailRemoteId: null,
        submissionRemoteId: null,
        cacheAttempts: 0,
      },
    });
    await engine.run('UPDATE pending_mutations SET attempts = 4 WHERE id = ?', [rowId]);
    const row = await engine.get('SELECT * FROM pending_mutations WHERE id = ?', [rowId]);

    const transport = new MockTransport();
    // The resume scan for an Email an earlier attempt might have created:
    // it ran and found nothing, so this attempt creates one.
    transport.handle('Email/query', () => ({ ids: [], queryState: 'qs' }));
    transport.handle('Email/get', () => ({ list: [], state: 'es' }));
    transport.handle('Email/set', (params) => (params.destroy
      ? { destroyed: params.destroy }
      : { created: { c1: { id: 'em-13' } } }));
    transport.handle('EmailSubmission/set', () => ({
      notCreated: { s1: { type: 'forbiddenFrom' } },
    }));

    const result = await processMutationRow({ transport, account, handlers, row });

    expect(result.ok).toBe(false);
    const after = await engine.get(
      'SELECT attempts, phase FROM pending_mutations WHERE id = ?',
      [rowId],
    );
    // The server's notCreated is a definitive answer, and forbiddenFrom is
    // terminal, so the row rewinds past its destroyed Email to `queued`
    // rather than sitting at `submitting` as if the call were in flight.
    expect(after.phase, 'the row stopped short of submission succeeding').toBe('queued');
    expect(Number(after.attempts)).toBe(4);
  });

  it('parks a post-submission row whose checkpoint lost the submission id', async () => {
    // Impossible from this code — phase and checkpoint are written in one
    // UPDATE — so this is a guard against a corrupted pair. There is
    // nothing to reconcile against and no safe way to redo the send, and
    // re-entering submission is the one response CS-1.10 rules out.
    const { drafts, sent } = await seedSendScaffolding();
    const rowId = await parkAtPhase({
      drafts,
      sent,
      phase: 'submitted',
      checkpoint: {
        operationId: 'op-9',
        messageId: '<yza@example.com>',
        emailRemoteId: 'em-new',
        submissionRemoteId: null,
        cacheAttempts: 0,
      },
    });
    const row = await engine.get('SELECT * FROM pending_mutations WHERE id = ?', [rowId]);

    const transport = new MockTransport();
    let submitCalls = 0;
    transport.handle('EmailSubmission/set', () => {
      submitCalls += 1;
      return { created: { s1: { id: 'must-not-happen' } } };
    });
    transport.handle('Email/get', (params) => sentEmailGetResponse(params));

    const result = await processMutationRow({ transport, account, handlers, row });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      type: 'outcomeUnknown',
      terminal: true,
      reason: 'incompleteCheckpoint',
    });
    expect(submitCalls).toBe(0);
    const after = await engine.get(
      'SELECT phase FROM pending_mutations WHERE id = ?',
      [rowId],
    );
    expect(after.phase).toBe('unknown');
  });

  it('resolves an interrupted submission when the submission record cannot be queried', async () => {
    // Stalwart destroys successful EmailSubmissions, and a server may not
    // support the filter at all. Neither is evidence that nothing was
    // sent, so the mailbox signal has to decide.
    const { drafts, sent } = await seedSendScaffolding();
    let submitCalls = 0;
    const transport = new MockTransport();
    transport.handle('EmailSubmission/query', () => {
      throw new Error('unsupportedFilter');
    });
    transport.handle('EmailSubmission/set', () => {
      submitCalls += 1;
      return { created: { s1: { id: 'must-not-happen' } } };
    });
    transport.handle('Email/get', (params) => sentEmailGetResponse(params));

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row: sendRow({
        drafts,
        sent,
        id: 4248,
        phase: 'submitting',
        checkpoint: {
          operationId: 'op-10',
          messageId: '<bcd@example.com>',
          emailRemoteId: 'em-new',
          submissionRemoteId: null,
          cacheAttempts: 0,
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(submitCalls).toBe(0);
    // No record was found, so nothing claims to be the submission id.
    expect(result.result.submissionRemoteId).toBe('reconciled');
  });

  it('reconciles a submission whose request died on the wire', async () => {
    // The socket dropped mid-call, so there is no response to read at
    // all. Letting that throw would reach the runner as a nondescript
    // transport failure and the composer would report a failed send —
    // for a message the server had in fact accepted.
    const { drafts, sent } = await seedSendScaffolding();
    let submitCalls = 0;
    const transport = new MockTransport();
    transport.handle('EmailSubmission/set', () => {
      submitCalls += 1;
      const err: any = new Error('socket closed');
      err.type = 'wsRequestTimeout';
      throw err;
    });
    transport.handle('EmailSubmission/query', () => ({ ids: ['sub-11'] }));
    transport.handle('Email/get', (params) => sentEmailGetResponse(params));

    const rowId = await parkAtPhase({
      drafts,
      sent,
      phase: 'created',
      checkpoint: {
        operationId: 'op-11',
        messageId: '<efg@example.com>',
        emailRemoteId: 'em-new',
        submissionRemoteId: null,
        cacheAttempts: 0,
      },
    });
    const row = await engine.get('SELECT * FROM pending_mutations WHERE id = ?', [rowId]);

    const result = await processMutationRow({ transport, account, handlers, row });

    expect(result.ok).toBe(true);
    expect(submitCalls, 'the submission was attempted exactly once').toBe(1);
    expect(result.result.submissionRemoteId).toBe('sub-11');
  });

  it('parks a submission that died on the wire with no evidence either way', async () => {
    // Same interruption, but now nothing can be proven. The error has to
    // classify itself as an unknown outcome so the composer warns instead
    // of blaming the send, and it must keep the transport's own word for
    // what happened as the only diagnostic of a response nobody saw.
    const { drafts, sent } = await seedSendScaffolding();
    const transport = new MockTransport();
    transport.handle('EmailSubmission/set', () => {
      const err: any = new Error('socket closed');
      err.type = 'wsRequestTimeout';
      throw err;
    });
    transport.handle('EmailSubmission/query', () => {
      throw new Error('also unreachable');
    });
    transport.handle('Email/get', () => {
      throw new Error('also unreachable');
    });

    const rowId = await parkAtPhase({
      drafts,
      sent,
      phase: 'created',
      checkpoint: {
        operationId: 'op-14',
        messageId: '<hij@example.com>',
        emailRemoteId: 'em-new',
        submissionRemoteId: null,
        cacheAttempts: 0,
      },
    });
    const row = await engine.get('SELECT * FROM pending_mutations WHERE id = ?', [rowId]);

    const result = await processMutationRow({ transport, account, handlers, row });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      type: 'outcomeUnknown',
      terminal: true,
      reason: 'wsRequestTimeout',
    });
    const after = await engine.get('SELECT phase FROM pending_mutations WHERE id = ?', [rowId]);
    expect(after.phase, 'the row refuses further attempts on its own').toBe('unknown');
    await expectNothingFiledInSent();
  });

  /**
   * Handlers whose checkpoint writes fail for the given phases. Everything
   * else — folder lookups, the local upsert — still works, so a test can
   * break one write and watch what the send makes of it.
   */
  function handlersFailingCheckpoint(phases: string[]) {
    const query = handlers[DB_RPC.QUERY];
    const accept = handlers[DB_RPC.SEND_ACCEPT_AND_QUEUE_TRUST];
    return {
      ...handlers,
      [DB_RPC.SEND_ACCEPT_AND_QUEUE_TRUST]: async (args: any) => {
        if (phases.includes('submitted')) {
          throw new Error('checkpoint write refused for phase submitted');
        }
        return accept(args);
      },
      [DB_RPC.QUERY]: async (args: any) => {
        if (args?.sql?.includes('SET phase = ?') && phases.includes(args.params?.[0])) {
          throw new Error(`checkpoint write refused for phase ${args.params[0]}`);
        }
        return query(args);
      },
    };
  }

  it('retries the atomic acceptance effect without replaying submission', async () => {
    // The server took the message and the write that records that fact
    // failed. The row still has to answer "sent": a failure here would put
    // Send back in front of the user for a message already in transit,
    // and the second press carries a new Message-ID that no duplicate
    // guard can match.
    const { drafts, sent, identity } = await seedSendScaffolding();
    const transport = new MockTransport();
    transport.handle('Email/set', () => ({ created: { c1: { id: 'em-new' } } }));
    transport.handle('EmailSubmission/set', () => ({ created: { s1: { id: 'sub-20' } } }));
    transport.handle('Email/get', (params) => sentEmailGetResponse(params));
    const inserted = await insertSendMutation({ drafts, sent, identity });
    const row = await engine.get('SELECT * FROM pending_mutations WHERE id = ?', [inserted.id]);

    const result = await processMutationRow({
      transport,
      account,
      handlers: handlersFailingCheckpoint(['submitted']),
      row,
    });

    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('acceptanceCheckpointFailed');
    expect(
      result.error.result,
      'the composer reads this to report a send rather than a failure',
    ).toMatchObject({ submitted: true, submissionRemoteId: 'sub-20' });
    expect(result.error.terminal, 'local filing is worth retrying').toBeUndefined();
  });

  it('keeps retrying when the accepted-send checkpoint cannot be written', async () => {
    // The row remains at `submitting`, whose retry path probes for evidence
    // and retries only the atomic checkpoint/trust effect.
    const { drafts, sent, identity } = await seedSendScaffolding();
    const transport = new MockTransport();
    transport.handle('Email/set', () => ({ created: { c1: { id: 'em-new' } } }));
    transport.handle('EmailSubmission/set', () => ({ created: { s1: { id: 'sub-21' } } }));
    transport.handle('Email/get', (params) => sentEmailGetResponse(params));
    const inserted = await insertSendMutation({ drafts, sent, identity });
    const row = await engine.get('SELECT * FROM pending_mutations WHERE id = ?', [inserted.id]);

    const result = await processMutationRow({
      transport,
      account,
      handlers: handlersFailingCheckpoint(['submitted', 'cache_pending']),
      row,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      type: 'acceptanceCheckpointFailed',
      result: { submitted: true, filed: false, submissionRemoteId: 'sub-21' },
    });
  });

  it('still warns when the park itself cannot be written', async () => {
    // The row cannot be marked, but the answer the composer keys its
    // warning off is the returned error, and that has to survive: a
    // transport failure here would blame a send nobody can account for.
    const { drafts, sent } = await seedSendScaffolding();
    const transport = new MockTransport();
    transport.handle('EmailSubmission/set', () => {
      const err: any = new Error('socket closed');
      err.type = 'wsRequestTimeout';
      throw err;
    });
    transport.handle('EmailSubmission/query', () => {
      throw new Error('also unreachable');
    });
    transport.handle('Email/get', () => {
      throw new Error('also unreachable');
    });
    const rowId = await parkAtPhase({
      drafts,
      sent,
      phase: 'created',
      checkpoint: {
        operationId: 'op-23',
        messageId: '<nop@example.com>',
        emailRemoteId: 'em-new',
        submissionRemoteId: null,
        cacheAttempts: 0,
      },
    });
    const row = await engine.get('SELECT * FROM pending_mutations WHERE id = ?', [rowId]);

    const result = await processMutationRow({
      transport,
      account,
      handlers: handlersFailingCheckpoint(['unknown']),
      row,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ type: 'outcomeUnknown', terminal: true });
    const after = await engine.get('SELECT phase FROM pending_mutations WHERE id = ?', [rowId]);
    expect(
      after.phase,
      'the phase is unchanged, and a resume from it asks the server rather than resubmitting',
    ).toBe('submitting');
  });

  it('retries a resumed send whose proven acceptance could not be recorded', async () => {
    // Same rule on the recovery path: the evidence proved the message went
    // out, so a failed write is filing work, not a failed send.
    const { drafts, sent } = await seedSendScaffolding();
    const transport = new MockTransport();
    transport.handle('EmailSubmission/query', () => ({ ids: ['sub-22'] }));
    transport.handle('Email/get', (params) => sentEmailGetResponse(params));
    transport.handle('EmailSubmission/set', () => {
      throw new Error('a proven submission must not be repeated');
    });
    const rowId = await parkAtPhase({
      drafts,
      sent,
      phase: 'submitting',
      checkpoint: {
        operationId: 'op-22',
        messageId: '<klm@example.com>',
        emailRemoteId: 'em-new',
        submissionRemoteId: null,
        cacheAttempts: 0,
      },
    });
    const row = await engine.get('SELECT * FROM pending_mutations WHERE id = ?', [rowId]);

    const result = await processMutationRow({
      transport,
      account,
      handlers: handlersFailingCheckpoint(['submitted']),
      row,
    });

    expect(result.ok).toBe(false);
    expect(result.error.type).toBe('acceptanceCheckpointFailed');
    expect(result.error.result).toMatchObject({ submitted: true, submissionRemoteId: 'sub-22' });
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
          ? { 'shared-elsewhere': true, 'shared-team': true }
          : { 'shared-elsewhere': true },
      })),
      state: 'shared-es3',
    }));
    transport.handle('Email/set', (params) => {
      expect(params).toEqual({
        accountId: 'acct-shared',
        update: {
          'existing-copy': {
            mailboxIds: {
              'shared-elsewhere': true,
              'shared-team': true,
            },
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

  it('skips Email/set when an existing copy is already in every destination', async () => {
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
    transport.handle('Email/copy', () => ({
      notCreated: {
        'e-1': {
          type: 'alreadyExists',
          existingId: 'existing-copy',
        },
      },
    }));
    transport.handle('Email/get', (params) => ({
      list: params.ids.map((id) => ({
        ...emailFixture(id),
        mailboxIds: {
          'shared-elsewhere': true,
          'shared-team': true,
        },
      })),
      state: 'already-filed-state',
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
    expect(transport.requests.filter((request) =>
      request.methodCalls[0]?.[0] === 'Email/set')).toHaveLength(0);
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

describe('send-state classification of definitive server answers', () => {
  async function lastSendRow() {
    return engine.get(
      `SELECT * FROM pending_mutations WHERE mutation_type = ? ORDER BY id DESC LIMIT 1`,
      [MUTATION_TYPES.SEND],
    );
  }

  it('resubmits a rate-limited submission on the retry instead of parking it', async () => {
    // The one submission SetError classified retryable must actually be
    // able to retry. The server's notCreated is a definitive answer —
    // nothing was submitted — so the row rewinds to `created` and the
    // retry re-enters at the submission, not the crash-ambiguity path.
    const { drafts, sent } = await seedSendScaffolding();
    await insertSendMutation({ drafts, sent });

    let submitCalls = 0;
    let createCalls = 0;
    const destroyedIds: string[][] = [];
    const transport = new MockTransport();
    transport.handle('Email/set', (params) => {
      if (params.destroy) {
        destroyedIds.push(params.destroy);
        return { destroyed: params.destroy };
      }
      createCalls += 1;
      return { created: { c1: { id: 'em-new', threadId: 'thr-new', size: 100 } } };
    });
    transport.handle('EmailSubmission/set', () => {
      submitCalls += 1;
      // First attempt: refused (RFC 8620 §5.3 rateLimit, "It may work if
      // tried again later"). Second attempt: accepted.
      return submitCalls === 1
        ? { notCreated: { s1: { type: 'rateLimit' } } }
        : { created: { s1: { id: 'sub-1' } } };
    });
    transport.handle('Email/get', (params) => sentEmailGetResponse(params));
    transport.handle('Email/query', (params) => (params.anchor
      ? { ids: ['em-new'], position: 0, total: 1, queryState: 'qs2' }
      : { ids: [], position: 0, total: 0, queryState: 'q-scan' }));

    const first = await processMutationRow({
      transport, account, handlers, row: await lastSendRow(),
    });
    expect(first.ok).toBe(false);
    expect(first.error.terminal).toBeUndefined();

    const row = await lastSendRow();
    // The rejection was definitive, so the phase must not claim an
    // in-flight submission.
    expect(row.phase).toBe('created');
    expect(JSON.parse(row.server_response_json).emailRemoteId).toBe('em-new');
    expect(destroyedIds).toEqual([]);

    const second = await processMutationRow({ transport, account, handlers, row });
    expect(second.ok).toBe(true);
    expect(submitCalls, 'the refused submission must be re-issued').toBe(2);
    expect(createCalls, 'the retry must reuse the phase-1 Email').toBe(1);
    expect(destroyedIds).toEqual([]);
  });

  it('retries the submission after an explicit serverUnavailable method error', async () => {
    // RFC 8620 §3.6.2: except serverPartialFail, a method-level error means
    // the call made no changes. serverUnavailable is transient, so the send
    // stays retryable and resumes at the submission leg.
    const { drafts, sent } = await seedSendScaffolding();
    await insertSendMutation({ drafts, sent });

    let submitCalls = 0;
    const transport = tupleTransport((methodCalls) => {
      const [name, params, callId] = methodCalls[0];
      if (name === 'Email/set') {
        return [['Email/set', { created: { c1: { id: 'em-new', threadId: 'thr-new', size: 100 } } }, 'c1']];
      }
      if (name === 'EmailSubmission/set') {
        submitCalls += 1;
        return submitCalls === 1
          ? [['error', { type: 'serverUnavailable', description: 'temporary' }, 's1']]
          : [['EmailSubmission/set', { created: { s1: { id: 'sub-1' } } }, 's1']];
      }
      if (name === 'Email/get') {
        return [['Email/get', sentEmailGetResponse(params), callId]];
      }
      if (name === 'Email/query') {
        return [['Email/query', { ids: ['em-new'], position: 0, total: 1, queryState: 'qs2' }, callId]];
      }
      throw new Error(`unexpected method ${name}`);
    });

    const first = await processMutationRow({
      transport: transport as any, account, handlers, row: await lastSendRow(),
    });
    expect(first.ok).toBe(false);
    expect(first.error.type).toBe('serverUnavailable');
    expect(first.error.terminal).toBeUndefined();

    const row = await lastSendRow();
    expect(row.phase).toBe('created');

    const second = await processMutationRow({
      transport: transport as any, account, handlers, row,
    });
    expect(second.ok).toBe(true);
    expect(submitCalls).toBe(2);
  });

  it('fails the send with the server reason when the submission call is rejected outright', async () => {
    // A complete envelope carrying ["error", …, "s1"] is CS-5.5 case 1
    // (server-rejected), not case 3 (genuinely ambiguous): RFC 8620 §3.6.2
    // guarantees no state changed, so no evidence probe may run and the
    // composer must keep Send available.
    const { drafts, sent } = await seedSendScaffolding();
    await insertSendMutation({ drafts, sent });

    const transport = tupleTransport((methodCalls) => {
      const [name] = methodCalls[0];
      if (name === 'Email/set') {
        const [, params, callId] = methodCalls[0];
        if (params.destroy) {
          return [['Email/set', { destroyed: params.destroy }, callId]];
        }
        return [['Email/set', { created: { c1: { id: 'em-new', threadId: 'thr-new', size: 100 } } }, callId]];
      }
      if (name === 'EmailSubmission/set') {
        return [['error', { type: 'invalidArguments', description: 'bad identityId' }, 's1']];
      }
      throw new Error(`evidence probe issued for a definitive rejection: ${name}`);
    });

    const summary = await drainOutbox({ transport: transport as any, account, handlers });
    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1 });

    const row = await lastSendRow();
    expect(row.local_status).toBe('conflicted');
    const error = JSON.parse(row.error_json);
    expect(error.type).toBe('invalidArguments');
    expect(error.terminal).toBe(true);
    expect(row.phase).not.toBe('unknown');
    await expectNothingFiledInSent();
  });

  it('leaves a send retryable when the create call dies on the wire', async () => {
    // The QUEUED phase is written before the create and the Message-ID
    // probe recognises an Email a lost response created, so a transport
    // death here is the exact case the recovery machinery exists for — it
    // must not escape to the runner's blanket terminal rule for sends.
    const { drafts, sent } = await seedSendScaffolding();
    await insertSendMutation({ drafts, sent });

    const inner = new MockTransport();
    inner.handle('Email/set', () => ({
      created: { c1: { id: 'em-new', threadId: 'thr-new', size: 100 } },
    }));
    inner.handle('EmailSubmission/set', () => ({ created: { s1: { id: 'sub-1' } } }));
    inner.handle('Email/get', (params) => sentEmailGetResponse(params));
    inner.handle('Email/query', (params) => (params.anchor
      ? { ids: ['em-new'], position: 0, total: 1, queryState: 'qs2' }
      : { ids: [], position: 0, total: 0, queryState: 'q-scan' }));
    let threw = false;
    const transport = {
      session: inner.session,
      async request(using: any, methodCalls: any[]) {
        if (!threw && methodCalls[0][0] === 'Email/set') {
          threw = true;
          throw Object.assign(new Error('socket died mid-create'), {
            type: 'httpRequestTimeout',
          });
        }
        return inner.request(using, methodCalls);
      },
    };

    const first = await processMutationRow({
      transport: transport as any, account, handlers, row: await lastSendRow(),
    });
    expect(first.ok).toBe(false);
    expect(first.error.terminal).toBeUndefined();

    // The retry scans for the Message-ID (finding nothing), creates, and
    // submits — one delivery, no orphan.
    const second = await processMutationRow({
      transport: transport as any, account, handlers, row: await lastSendRow(),
    });
    expect(second.ok).toBe(true);
  });

  it('refuses a phase this build does not recognise instead of re-running the send', async () => {
    // CS-1.6: recorded progress that cannot be interpreted is ambiguous.
    // A phase written by a newer build may sit past the submission; falling
    // through to a fresh create-and-submit could deliver twice.
    const { drafts, sent } = await seedSendScaffolding();
    const calls: string[] = [];
    const transport = tupleTransport((methodCalls) => {
      calls.push(methodCalls[0][0]);
      throw new Error('no call may be issued for an uninterpretable phase');
    });

    const result = await processMutationRow({
      transport: transport as any,
      account,
      handlers,
      row: sendRow({
        drafts,
        sent,
        phase: 'submitting-v2',
        checkpoint: { messageId: '<op-1@example.com>', emailRemoteId: 'em-old' },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ type: 'outcomeUnknown', terminal: true });
    expect(calls).toEqual([]);
  });
});
