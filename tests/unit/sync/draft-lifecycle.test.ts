import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DRAFT_PHASE } from '../../../src/constants/states';
import { DB_RPC } from '../../../src/db/protocol';
import {
  drainOutbox,
  MUTATION_TYPES,
  processMutationRow,
} from '../../../src/sync/backends/jmap/outbox';
import { prepareComposeEmail } from '../../../src/sync/backends/jmap/compose-email';
import { findDraftRevision } from '../../../src/sync/backends/jmap/draft-reconcile';
import { MockTransport } from './_mock-transport';

let engine: any;
let handlers: any;
let account: any;
let drafts: any;
let sent: any;
let identity: any;
let transport: MockTransport;
let nextEmail = 1;
let rejectNextCreate = false;
let loseNextCreateResponse = false;
let deleteBaseAfterNextCreate = false;
const serverEmails = new Map<string, any>();

function serverEmail(id: string, create: any) {
  const bodyStructure = create.bodyStructure;
  const bodyValues = create.bodyValues ?? {};
  const textPart = bodyStructure?.type === 'text/plain'
    ? bodyStructure
    : bodyStructure?.subParts?.find((part) => part.type === 'text/plain');
  const htmlPart = bodyStructure?.subParts?.find((part) => part.type === 'text/html');
  return {
    id,
    blobId: `blob-${id}`,
    threadId: `thread-${id}`,
    mailboxIds: create.mailboxIds,
    keywords: create.keywords,
    size: 100,
    receivedAt: new Date(1_787_850_000_000 + nextEmail).toISOString(),
    sentAt: new Date(1_787_850_000_000 + nextEmail).toISOString(),
    messageId: create.messageId,
    from: create.from,
    to: create.to,
    cc: create.cc ?? [],
    bcc: create.bcc ?? [],
    subject: create.subject,
    preview: bodyValues.p1?.value ?? '',
    hasAttachment: false,
    bodyStructure,
    textBody: textPart ? [{ ...textPart, blobId: `part-${id}-text` }] : [],
    htmlBody: htmlPart
      ? [{ ...htmlPart, blobId: `part-${id}-html` }]
      : (textPart ? [{ ...textPart, blobId: `part-${id}-text` }] : []),
    attachments: [],
    bodyValues,
  };
}

function requestFor(revision: number, priorIds: string[] = []) {
  return {
    draftSessionId: 'session-1',
    revision,
    payloadHash: `hash-${revision}`,
    identityId: identity.id,
    to: [{ email: 'recipient@example.com' }],
    cc: [],
    bcc: [],
    subject: `Draft ${revision}`,
    textBody: `Body ${revision}`,
    htmlBody: '',
    attachments: [],
    inReplyTo: [],
    references: [],
    draftsFolderId: drafts.id,
    draftEmailIds: priorIds,
  };
}

async function enqueueSave(revision: number, priorIds: string[] = []) {
  return handlers[DB_RPC.PENDING_MUTATION_INSERT]({
    accountId: account.id,
    mutationType: MUTATION_TYPES.SAVE_DRAFT,
    targetMessageId: null,
    requestJson: JSON.stringify(requestFor(revision, priorIds)),
  });
}

beforeEach(async () => {
  engine = await bootTestEngine();
  handlers = makeHandlers(engine);
  account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
    displayName: 'Draft test',
    primaryEmail: 'writer@example.com',
    serverOrigin: 'https://mail.example.com',
    remoteAccountId: 'account-1',
    isPrimary: true,
  })).row;
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
      remoteId: 'identity-1',
      name: 'Writer',
      email: 'writer@example.com',
    }],
  });
  drafts = await engine.get(
    'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
    [account.id, 'mb-drafts'],
  );
  sent = await engine.get(
    'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
    [account.id, 'mb-sent'],
  );
  identity = await engine.get(
    'SELECT * FROM identities WHERE account_id = ? AND remote_id = ?',
    [account.id, 'identity-1'],
  );

  nextEmail = 1;
  rejectNextCreate = false;
  loseNextCreateResponse = false;
  deleteBaseAfterNextCreate = false;
  serverEmails.clear();
  transport = new MockTransport();
  transport.handle('Email/set', (params) => {
    if (params.create) {
      if (rejectNextCreate) {
        rejectNextCreate = false;
        return { notCreated: { draft: { type: 'invalidProperties' } } };
      }
      const [creationId, create] = Object.entries(params.create)[0] as [string, any];
      const id = creationId === 'draft' ? `draft-${nextEmail}` : `send-${nextEmail}`;
      nextEmail += 1;
      const email = serverEmail(id, create);
      serverEmails.set(id, email);
      if (deleteBaseAfterNextCreate) {
        deleteBaseAfterNextCreate = false;
        serverEmails.delete('draft-1');
      }
      if (loseNextCreateResponse) {
        loseNextCreateResponse = false;
        throw new Error('response lost');
      }
      return { created: { [creationId]: { id } } };
    }
    const destroyed: string[] = [];
    const notDestroyed: Record<string, any> = {};
    for (const id of params.destroy ?? []) {
      if (serverEmails.delete(id)) destroyed.push(id);
      else notDestroyed[id] = { type: 'notFound' };
    }
    return { destroyed, notDestroyed };
  });
  transport.handle('Email/get', (params) => ({
    list: (params.ids ?? []).map((id) => serverEmails.get(id)).filter(Boolean),
    notFound: (params.ids ?? []).filter((id) => !serverEmails.has(id)),
    state: `email-state-${serverEmails.size}`,
  }));
  transport.handle('Email/query', (params) => {
    const ids = [...serverEmails.keys()];
    const start = Number(params.position ?? 0);
    const page = ids.slice(start, start + Number(params.limit ?? ids.length));
    const anchorIndex = params.anchor ? ids.indexOf(params.anchor) : -1;
    return {
      ids: params.anchor ? (anchorIndex >= 0 ? [params.anchor] : []) : page,
      position: params.anchor ? Math.max(0, anchorIndex) : start,
      total: ids.length,
      queryState: `query-state-${serverEmails.size}`,
    };
  });
  transport.handle('Mailbox/get', (params) => ({
    list: (params.ids ?? []).map((id) => ({
      id,
      totalEmails: serverEmails.size,
      unreadEmails: serverEmails.size,
      totalThreads: serverEmails.size,
      unreadThreads: serverEmails.size,
    })),
    state: 'mailbox-state',
  }));
});

afterEach(async () => {
  await engine.close();
});

describe('JMAP draft replacement', () => {
  it('makes an HTTP authentication rejection terminal without retrying creation', async () => {
    await enqueueSave(1);
    await drainOutbox({ transport, account, handlers });
    expect([...serverEmails.keys()]).toEqual(['draft-1']);
    let createAttempts = 0;
    transport.handle('Email/set', (params) => {
      if (params.create) createAttempts += 1;
      const error: any = new Error('JMAP request failed: 401 Unauthorized');
      error.status = 401;
      throw error;
    });
    const { id } = await enqueueSave(2, ['draft-1']);
    const row = await engine.get('SELECT * FROM pending_mutations WHERE id = ?', [id]);

    await expect(processMutationRow({
      transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({
      ok: false,
      error: {
        type: 'authenticationFailed',
        terminal: true,
        detail: {
          status: 401,
          operation: 'draftCreateAmbiguous',
        },
      },
    });
    expect(createAttempts).toBe(1);
    expect([...serverEmails.keys()]).toEqual(['draft-1']);
    const retained = await engine.get(
      'SELECT phase, server_response_json FROM pending_mutations WHERE id = ?',
      [id],
    );
    expect(retained.phase).toBe(DRAFT_PHASE.QUEUED);
    expect(JSON.parse(retained.server_response_json)).toMatchObject({
      baseEmailIds: ['draft-1'],
      newEmailId: null,
    });
  });

  it('creates and confirms a successor before destroying its predecessor', async () => {
    await enqueueSave(1);
    await expect(drainOutbox({ transport, account, handlers })).resolves.toMatchObject({
      succeeded: 1,
      failed: 0,
    });
    expect([...serverEmails.keys()]).toEqual(['draft-1']);
    const firstMessageId = serverEmails.get('draft-1').messageId;

    transport.requests = [];
    await enqueueSave(2, ['draft-1']);
    await expect(drainOutbox({ transport, account, handlers })).resolves.toMatchObject({
      succeeded: 1,
      failed: 0,
    });

    const setCalls = transport.requests.flatMap((request) =>
      request.methodCalls.filter(([name]) => name === 'Email/set'));
    const createIndex = setCalls.findIndex(([, params]) => !!params.create);
    const destroyIndex = setCalls.findIndex(([, params]) => !!params.destroy);
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(destroyIndex).toBeGreaterThan(createIndex);
    expect(setCalls.every(([, params]) => !(params.create && params.destroy))).toBe(true);
    expect(transport.requests.flatMap((request) => request.methodCalls)
      .some(([name]) => name === 'Core/echo')).toBe(false);
    expect([...serverEmails.keys()]).toEqual(['draft-2']);
    expect(serverEmails.get('draft-2').messageId).not.toEqual(firstMessageId);

    const local = await engine.all(
      'SELECT remote_id, subject, is_draft FROM messages WHERE account_id = ?',
      [account.id],
    );
    expect(local).toEqual([
      expect.objectContaining({ remote_id: 'draft-2', subject: 'Draft 2', is_draft: 1 }),
    ]);
  });

  it('preserves the predecessor when successor creation is rejected', async () => {
    await enqueueSave(1);
    await drainOutbox({ transport, account, handlers });
    transport.requests = [];
    rejectNextCreate = true;

    await enqueueSave(2, ['draft-1']);
    await expect(drainOutbox({ transport, account, handlers })).resolves.toMatchObject({
      succeeded: 0,
      failed: 1,
    });

    expect(serverEmails.has('draft-1')).toBe(true);
    expect(transport.requests.flatMap((request) => request.methodCalls)
      .some(([, params]) => Array.isArray(params.destroy))).toBe(false);
  });

  it('treats a missing predecessor as an idempotent cleanup success', async () => {
    await enqueueSave(1);
    await drainOutbox({ transport, account, handlers });
    deleteBaseAfterNextCreate = true;

    await enqueueSave(2, ['draft-1']);
    await expect(drainOutbox({ transport, account, handlers })).resolves.toMatchObject({
      succeeded: 1,
      failed: 0,
    });
    expect([...serverEmails.keys()]).toEqual(['draft-2']);
  });

  it('refuses to create from a predecessor another client already replaced', async () => {
    await enqueueSave(1);
    await drainOutbox({ transport, account, handlers });
    serverEmails.delete('draft-1');
    serverEmails.set('external-successor', serverEmail('external-successor', {
      mailboxIds: { 'mb-drafts': true },
      keywords: { $draft: true },
      from: [{ email: 'writer@example.com' }],
      to: [{ email: 'recipient@example.com' }],
      subject: 'External edit',
      bodyStructure: { type: 'text/plain', partId: 'p1' },
      bodyValues: { p1: { value: 'External' } },
      messageId: ['external@example.com'],
    }));
    transport.requests = [];

    await enqueueSave(2, ['draft-1']);
    await expect(drainOutbox({ transport, account, handlers })).resolves.toMatchObject({
      succeeded: 0,
      failed: 1,
    });

    expect(transport.requests.flatMap((request) => request.methodCalls)
      .some(([, params]) => !!params.create)).toBe(false);
    expect([...serverEmails.keys()]).toEqual(['external-successor']);
  });

  it('adopts a matching revision after its create response is lost', async () => {
    await enqueueSave(1);
    await drainOutbox({ transport, account, handlers });
    const firstMessageId = serverEmails.get('draft-1').messageId;

    loseNextCreateResponse = true;
    const row = await enqueueSave(2, ['draft-1']);
    await expect(drainOutbox({ transport, account, handlers })).resolves.toMatchObject({
      succeeded: 0,
      failed: 1,
    });
    expect([...serverEmails.keys()]).toEqual(['draft-1', 'draft-2']);
    const secondMessageId = serverEmails.get('draft-2').messageId;
    expect(secondMessageId).not.toEqual(firstMessageId);

    await engine.run(
      `UPDATE pending_mutations
          SET local_status = 'retry', error_json = NULL
        WHERE id = ?`,
      [row.id],
    );
    transport.requests = [];
    await expect(drainOutbox({ transport, account, handlers })).resolves.toMatchObject({
      succeeded: 1,
      failed: 0,
    });

    expect(transport.requests.flatMap((request) => request.methodCalls)
      .filter(([, params]) => !!params.create)).toHaveLength(0);
    expect([...serverEmails.keys()]).toEqual(['draft-2']);
  });

  it('destroys only the checkpoint-owned draft after submission is confirmed', async () => {
    await enqueueSave(1);
    await drainOutbox({ transport, account, handlers });
    transport.handle('EmailSubmission/set', (params) => {
      const submitted = params.create.s1;
      const email = serverEmails.get(submitted.emailId);
      email.mailboxIds = { 'mb-sent': true };
      email.keywords = { $seen: true };
      return { created: { s1: { id: 'submission-1' } } };
    });
    const row = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.SEND,
      targetMessageId: null,
      requestJson: JSON.stringify({
        draftSessionId: 'session-1',
        identityId: identity.id,
        to: [{ email: 'recipient@example.com' }],
        cc: [],
        bcc: [],
        subject: 'Send this',
        textBody: 'Final body',
        htmlBody: '',
        inReplyTo: [],
        references: [],
        draftsFolderId: drafts.id,
        sentFolderId: sent.id,
        outboxFolderId: null,
        draftEmailIds: ['draft-1'],
      }),
    });

    await expect(drainOutbox({
      transport,
      account,
      handlers,
      mutationId: row.id,
    })).resolves.toMatchObject({ succeeded: 1, failed: 0 });

    expect(serverEmails.has('draft-1')).toBe(false);
    expect([...serverEmails.keys()]).toEqual(['send-2']);
    const sentRow = await engine.get(
      'SELECT remote_id, subject FROM messages WHERE account_id = ? AND remote_id = ?',
      [account.id, 'send-2'],
    );
    expect(sentRow).toMatchObject({ remote_id: 'send-2', subject: 'Send this' });
    const oldDraft = await engine.get(
      'SELECT id FROM messages WHERE account_id = ? AND remote_id = ?',
      [account.id, 'draft-1'],
    );
    expect(oldDraft).toBeNull();
  });

  it('stores a marker-free CID body for a draft with a default image', async () => {
    const request = requestFor(1);
    request.textBody = 'Image signature';
    request.htmlBody = '<p>Image signature'
      + '<img src="data:image/png;base64,iVBORw0KGgo="></p>';
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.SAVE_DRAFT,
      targetMessageId: null,
      requestJson: JSON.stringify(request),
    });

    await expect(drainOutbox({ transport, account, handlers }))
      .resolves.toMatchObject({ succeeded: 1, failed: 0 });

    const saved = serverEmails.get('draft-1');
    const html = saved.bodyValues.h1.value;
    expect(html).toContain('Image signature');
    expect(html).toMatch(/src="cid:[^"]+@stormbox"/);
    expect(html).not.toContain('data:image/');
    expect(html).not.toContain('data-stormbox-');
    expect(saved.bodyStructure.type).toBe('multipart/related');
  });
});

describe('draft attachment preparation', () => {
  it('reuploads predecessor-owned part blobs before building the successor', async () => {
    const download = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const upload = vi.fn(async () => ({ blobId: 'blob-refreshed' }));
    const prepared = await prepareComposeEmail({
      transport: { download, upload },
      account: { remote_account_id: 'account-1' },
      identity: { email: 'writer@example.com' },
      mailboxRemoteId: 'mb-drafts',
      isDraft: true,
      request: {
        to: [{ email: 'recipient@example.com' }],
        subject: 'Attachment',
        textBody: 'See image',
        htmlBody: '<p><img src="cid:image-1"></p>',
        attachments: [{
          blob_id: 'part-blob-on-old-draft',
          mime_type: 'image/png',
          disposition: 'inline',
          cid: 'image-1',
        }],
      },
    });

    expect(download).toHaveBeenCalledWith(expect.objectContaining({
      blobId: 'part-blob-on-old-draft',
    }));
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({
      body: new Uint8Array([1, 2, 3]),
    }));
    expect(JSON.stringify(prepared.bodyStructure)).toContain('blob-refreshed');
    expect(JSON.stringify(prepared.bodyStructure)).not.toContain('part-blob-on-old-draft');
  });

  it('uploads a default data image from a marker-free draft request', async () => {
    const upload = vi.fn(async () => ({ blobId: 'signature-image-blob' }));
    const prepared = await prepareComposeEmail({
      transport: { download: vi.fn(), upload },
      account: { remote_account_id: 'account-1' },
      identity: { email: 'writer@example.com' },
      mailboxRemoteId: 'mb-drafts',
      isDraft: true,
      request: {
        to: [{ email: 'recipient@example.com' }],
        subject: 'Signature image',
        textBody: 'Image signature',
        htmlBody: '<p>Image signature'
          + '<img src="data:image/png;base64,iVBORw0KGgo="></p>',
        attachments: [],
      },
    });

    expect(upload).toHaveBeenCalledTimes(1);
    const html = prepared.bodyValues.h1.value;
    expect(html).toContain('Image signature');
    expect(html).toMatch(/src="cid:[^"]+@stormbox"/);
    expect(html).not.toContain('data:image/');
    expect(html).not.toContain('data-stormbox-');
    expect(prepared.bodyStructure.type).toBe('multipart/related');
    expect(prepared.bodyStructure.subParts).toContainEqual(expect.objectContaining({
      blobId: 'signature-image-blob',
      type: 'image/png',
      disposition: 'inline',
    }));
  });
});

describe('draft reconciliation paging', () => {
  it('stays inconclusive when query state changes between pages', async () => {
    const paged = new MockTransport({
      capabilities: {
        'urn:ietf:params:jmap:core': { maxObjectsInGet: 2, maxObjectsInSet: 500 },
      },
    });
    let page = 0;
    paged.handle('Email/query', (params) => {
      page += 1;
      const ids = ['one', 'two', 'three'].slice(params.position, params.position + params.limit);
      return {
        ids,
        total: 3,
        position: params.position,
        queryState: page === 1 ? 'state-one' : 'state-two',
      };
    });
    paged.handle('Email/get', (params) => ({
      list: params.ids.map((id) => ({ id, messageId: [] })),
      state: 'email-state',
    }));

    await expect(findDraftRevision({
      transport: paged,
      account: { remote_account_id: 'account-1' },
      draftsRemoteId: 'mb-drafts',
      revisionMessageId: '<wanted@example.com>',
      preparedEmail: {},
    })).resolves.toEqual({
      outcome: 'inconclusive',
      reason: 'queryStateChanged',
    });
  });
});
