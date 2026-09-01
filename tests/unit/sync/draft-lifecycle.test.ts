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
import {
  draftCheckpointConflictReason,
  newDraftCheckpoint,
  readDraftCheckpoint,
  saveDraftCheckpoint,
} from '../../../src/sync/backends/jmap/draft-checkpoint';
import { findDraftRevision } from '../../../src/sync/backends/jmap/draft-reconcile';
import { JMAP_CAPS } from '../../../src/sync/backends/jmap/transport';
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
let blobNotFoundNextCreate = false;
let malformNextSuccessor = false;
let protocolEvents: string[] = [];
const serverEmails = new Map<string, any>();

function canonicalBody(id: string, create: any) {
  const bodyValues: Record<string, any> = {};
  const textBody: any[] = [];
  const htmlBody: any[] = [];
  const attachments: any[] = [];
  let position = 0;
  const convert = (part: any): any => {
    if (Array.isArray(part?.subParts)) {
      return {
        ...part,
        subParts: part.subParts.map(convert),
      };
    }
    position += 1;
    const partId = `part-${id}-${position}`;
    const converted = {
      ...part,
      partId,
      blobId: `blob-${id}-${position}`,
      ...(part.disposition ? { size: 3 } : {}),
    };
    const value = create.bodyValues?.[part.partId];
    if (value) bodyValues[partId] = value;
    if (part.disposition === 'attachment' || part.disposition === 'inline') {
      attachments.push(converted);
    } else if (part.type === 'text/plain') {
      textBody.push(converted);
    } else if (part.type === 'text/html') {
      htmlBody.push(converted);
    }
    return converted;
  };
  const bodyStructure = convert(create.bodyStructure);
  return {
    bodyStructure,
    bodyValues,
    textBody,
    htmlBody: htmlBody.length > 0 ? htmlBody : textBody,
    attachments,
  };
}

function serverEmail(id: string, create: any) {
  const body = canonicalBody(id, create);
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
    preview: create.bodyValues?.p1?.value ?? '',
    hasAttachment: body.attachments.length > 0,
    ...body,
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

async function enqueueDraftRequest(request: any) {
  return handlers[DB_RPC.PENDING_MUTATION_INSERT]({
    accountId: account.id,
    mutationType: MUTATION_TYPES.SAVE_DRAFT,
    targetMessageId: null,
    requestJson: JSON.stringify(request),
  });
}

async function localRegularAttachments(remoteId: string) {
  const row = await engine.get(
    'SELECT id FROM messages WHERE account_id = ? AND remote_id = ?',
    [account.id, remoteId],
  );
  const body = await handlers[DB_RPC.MESSAGE_BODY_READ]({ messageId: row.id });
  return body.attachments.filter((attachment) =>
    attachment.disposition === 'attachment' && !attachment.cid);
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
  blobNotFoundNextCreate = false;
  malformNextSuccessor = false;
  protocolEvents = [];
  serverEmails.clear();
  transport = new MockTransport();
  transport.handle('Email/set', (params) => {
    if (params.create) {
      protocolEvents.push('create');
      if (rejectNextCreate) {
        rejectNextCreate = false;
        return { notCreated: { draft: { type: 'invalidProperties' } } };
      }
      if (blobNotFoundNextCreate) {
        blobNotFoundNextCreate = false;
        return { notCreated: { draft: { type: 'blobNotFound' } } };
      }
      const [creationId, create] = Object.entries(params.create)[0] as [string, any];
      const id = creationId === 'draft' ? `draft-${nextEmail}` : `send-${nextEmail}`;
      nextEmail += 1;
      const email = serverEmail(id, create);
      if (malformNextSuccessor) {
        malformNextSuccessor = false;
        const attachment = email.attachments[0];
        if (attachment) attachment.blobId = null;
        const removeBlobId = (part: any): boolean => {
          if (part?.partId === attachment?.partId) {
            part.blobId = null;
            return true;
          }
          return (part?.subParts ?? []).some(removeBlobId);
        };
        removeBlobId(email.bodyStructure);
      }
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
    protocolEvents.push('destroy');
    const notDestroyed: Record<string, any> = {};
    for (const id of params.destroy ?? []) {
      if (serverEmails.delete(id)) destroyed.push(id);
      else notDestroyed[id] = { type: 'notFound' };
    }
    return { destroyed, notDestroyed };
  });
  transport.handle('Email/get', (params) => {
    if (params.fetchTextBodyValues || params.fetchHTMLBodyValues) {
      protocolEvents.push('body-fetch');
    }
    return {
      list: (params.ids ?? []).map((id) => serverEmails.get(id)).filter(Boolean),
      notFound: (params.ids ?? []).filter((id) => !serverEmails.has(id)),
      state: `email-state-${serverEmails.size}`,
    };
  });
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
  it('requires the durable fields owned by each resumable phase', () => {
    const queued = {
      ...newDraftCheckpoint(requestFor(1, ['base']), identity.email),
      preparedEmail: {},
    };
    const created = { ...queued, newEmailId: 'successor' };
    const cached = { ...created, localMessageId: 42 };

    expect(draftCheckpointConflictReason(queued, DRAFT_PHASE.QUEUED)).toBeNull();
    expect(draftCheckpointConflictReason(created, DRAFT_PHASE.CREATED)).toBeNull();
    expect(draftCheckpointConflictReason(cached, DRAFT_PHASE.CACHE_PENDING)).toBeNull();
    expect(draftCheckpointConflictReason(
      { ...cached, pendingDestroyIds: [] },
      DRAFT_PHASE.CLEANUP_PENDING,
    )).toBeNull();
    expect(draftCheckpointConflictReason(
      { ...queued, pendingDestroyIds: [] },
      DRAFT_PHASE.QUEUED,
    )).toBe('queuedDestroySetChanged');
    expect(draftCheckpointConflictReason(queued, DRAFT_PHASE.CREATED))
      .toBe('createdMissingSuccessor');
    expect(draftCheckpointConflictReason(
      { ...created, newEmailId: '' },
      DRAFT_PHASE.CREATED,
    )).toBe('createdMissingSuccessor');
    expect(draftCheckpointConflictReason(created, DRAFT_PHASE.CACHE_PENDING))
      .toBe('pendingMissingLocalSuccessor');
  });

  it.each([
    ['mixed base ids', { baseEmailIds: ['base', 42] }],
    ['missing destroy ids', { pendingDestroyIds: undefined }],
    ['duplicate destroy ids', { pendingDestroyIds: ['base', 'base'] }],
    ['array prepared email', { preparedEmail: [] }],
  ])('rejects a checkpoint with %s', (_description, patch) => {
    const checkpoint = {
      ...newDraftCheckpoint(requestFor(1, ['base']), identity.email),
      preparedEmail: {},
      ...patch,
    };

    expect(readDraftCheckpoint({
      server_response_json: JSON.stringify(checkpoint),
    })).toBeNull();
  });

  it('keeps a checkpoint-without-phase abandonment terminal on retry', async () => {
    const { id } = await enqueueSave(1);
    const checkpoint = {
      ...newDraftCheckpoint(requestFor(1), identity.email),
      preparedEmail: {},
    };
    await engine.run(
      `UPDATE pending_mutations
          SET server_response_json = ?
        WHERE id = ?`,
      [JSON.stringify(checkpoint), id],
    );
    await expect(handlers[DB_RPC.PENDING_MUTATION_ABANDON_DRAFT]({
      accountId: account.id,
      mutationId: id,
      intent: 'keep-confirmed',
    })).resolves.toMatchObject({ parked: 1 });
    await expect(handlers[DB_RPC.PENDING_MUTATION_RETRY]({
      accountId: account.id,
      mutationId: id,
    })).resolves.toMatchObject({ retried: 0 });
    const row = await engine.get('SELECT * FROM pending_mutations WHERE id = ?', [id]);

    await expect(processMutationRow({
      transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({
      ok: false,
      error: {
        type: 'draftCheckpointConflict',
        terminal: true,
        detail: { reason: 'checkpointWithoutPhase' },
      },
    });
    expect(transport.requests).toHaveLength(0);
  });

  it.each([
    [null, 'createdMissingSuccessor'],
    ['', 'unreadableCheckpoint'],
    [' ', 'unreadableCheckpoint'],
    [123, 'unreadableCheckpoint'],
  ])(
    'rejects a created checkpoint with invalid successor id %j',
    async (newEmailId, reason) => {
    const request = requestFor(1);
    const { id } = await enqueueSave(1);
    const checkpoint = {
      ...newDraftCheckpoint(request, identity.email),
      preparedEmail: {},
      newEmailId,
    };
    await engine.run(
      `UPDATE pending_mutations
          SET phase = ?, server_response_json = ?
        WHERE id = ?`,
      [DRAFT_PHASE.CREATED, JSON.stringify(checkpoint), id],
    );
    const row = await engine.get('SELECT * FROM pending_mutations WHERE id = ?', [id]);

    await expect(processMutationRow({
      transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({
      ok: false,
      error: {
        type: 'draftCheckpointConflict',
        terminal: true,
        detail: { reason },
      },
    });
    expect(transport.requests).toHaveLength(0);
    },
  );

  it('refuses to persist a checkpoint that contradicts its phase', async () => {
    const { id } = await enqueueSave(1);
    const checkpoint = {
      ...newDraftCheckpoint(requestFor(1), identity.email),
      preparedEmail: {},
    };

    await expect(saveDraftCheckpoint(
      handlers,
      id,
      checkpoint,
      DRAFT_PHASE.CREATED,
    )).rejects.toThrow('createdMissingSuccessor');
    expect(await engine.get(
      'SELECT phase FROM pending_mutations WHERE id = ?',
      [id],
    )).toMatchObject({ phase: null });
  });

  it('converts an abandoned successor into cleanup without deleting its predecessor', async () => {
    const request = requestFor(2, ['draft-old']);
    const { id } = await enqueueSave(2, ['draft-old']);
    const checkpoint = {
      ...newDraftCheckpoint(request, identity.email),
      preparedEmail: {},
      newEmailId: 'draft-new',
    };
    await engine.run(
      `UPDATE pending_mutations
          SET local_status = 'retry',
              phase = ?,
              server_response_json = ?
        WHERE id = ?`,
      [DRAFT_PHASE.CREATED, JSON.stringify(checkpoint), id],
    );

    await expect(handlers[DB_RPC.PENDING_MUTATION_ABANDON_DRAFT]({
      accountId: account.id,
      mutationId: id,
      intent: 'keep-confirmed',
      confirmedEmailIds: ['draft-old'],
      draftSessionId: 'session-1',
      draftsFolderId: drafts.id,
    })).resolves.toMatchObject({
      abandoned: 0,
      converted: 1,
      parked: 0,
      mutationId: id,
    });
    const converted = await engine.get(
      'SELECT * FROM pending_mutations WHERE id = ?',
      [id],
    );
    expect(converted).toMatchObject({
      mutation_type: MUTATION_TYPES.DISCARD_DRAFT,
      local_status: 'pending',
      phase: null,
      server_response_json: null,
    });
    expect(JSON.parse(converted.request_json)).toMatchObject({
      draftEmailIds: ['draft-new'],
    });
  });

  it('merges the confirmed and checkpoint-owned revisions for Discard', async () => {
    const request = requestFor(2, ['draft-old']);
    const { id } = await enqueueSave(2, ['draft-old']);
    const checkpoint = {
      ...newDraftCheckpoint(request, identity.email),
      preparedEmail: {},
      newEmailId: 'draft-new',
    };
    await engine.run(
      `UPDATE pending_mutations
          SET local_status = 'retry', phase = ?, server_response_json = ?
        WHERE id = ?`,
      [DRAFT_PHASE.CREATED, JSON.stringify(checkpoint), id],
    );

    await expect(handlers[DB_RPC.PENDING_MUTATION_ABANDON_DRAFT]({
      accountId: account.id,
      mutationId: id,
      intent: 'discard-all',
      confirmedEmailIds: ['draft-old'],
      draftSessionId: 'session-1',
      draftsFolderId: drafts.id,
    })).resolves.toMatchObject({ converted: 1, mutationId: id });
    const converted = await engine.get(
      'SELECT request_json FROM pending_mutations WHERE id = ?',
      [id],
    );
    expect(new Set(JSON.parse(converted.request_json).draftEmailIds))
      .toEqual(new Set(['draft-old', 'draft-new']));
  });

  it('chunks discard cleanup and checkpoints every confirmed chunk', async () => {
    transport.session.capabilities[JMAP_CAPS.CORE] = {
      ...transport.session.capabilities[JMAP_CAPS.CORE],
      maxObjectsInGet: 2,
      maxObjectsInSet: 2,
    };
    const draftEmailIds = Array.from(
      { length: 5 },
      (_, index) => `discard-${index + 1}`,
    );
    for (const id of draftEmailIds) {
      serverEmails.set(id, {
        id,
        mailboxIds: { 'mb-drafts': true },
        keywords: { $draft: true },
      });
    }
    const inserted = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.DISCARD_DRAFT,
      targetMessageId: null,
      requestJson: JSON.stringify({
        draftSessionId: 'session-1',
        draftsFolderId: drafts.id,
        draftEmailIds,
      }),
    });
    const row = await engine.get(
      'SELECT * FROM pending_mutations WHERE id = ?',
      [inserted.id],
    );

    await expect(processMutationRow({
      transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({
      ok: true,
      result: { destroyed: draftEmailIds },
    });

    const destroyCalls = transport.requests
      .flatMap((request) => request.methodCalls)
      .filter(([name, params]) => name === 'Email/set' && params.destroy);
    expect(destroyCalls.map(([, params]) => params.destroy)).toEqual([
      draftEmailIds.slice(0, 2),
      draftEmailIds.slice(2, 4),
      draftEmailIds.slice(4),
    ]);
    const checkpoint = await engine.get(
      'SELECT server_response_json FROM pending_mutations WHERE id = ?',
      [inserted.id],
    );
    expect(JSON.parse(checkpoint.server_response_json)).toEqual({
      version: 1,
      pendingDestroyIds: [],
      destroyedIds: draftEmailIds,
    });
  });

  it('turns an ambiguous queued create into a probe-only discard', async () => {
    loseNextCreateResponse = true;
    const { id } = await enqueueSave(1);
    const initial = await engine.get('SELECT * FROM pending_mutations WHERE id = ?', [id]);
    await expect(processMutationRow({
      transport,
      account,
      handlers,
      row: initial,
    })).resolves.toMatchObject({
      ok: false,
      error: { type: 'draftCreateAmbiguous' },
    });
    expect([...serverEmails.keys()]).toEqual(['draft-1']);

    await expect(handlers[DB_RPC.PENDING_MUTATION_ABANDON_DRAFT]({
      accountId: account.id,
      mutationId: id,
      intent: 'keep-confirmed',
      confirmedEmailIds: [],
      draftSessionId: 'session-1',
      draftsFolderId: drafts.id,
    })).resolves.toMatchObject({ converted: 1, mutationId: id });
    const converted = await engine.get(
      'SELECT * FROM pending_mutations WHERE id = ?',
      [id],
    );
    expect(JSON.parse(converted.request_json)).toMatchObject({
      draftEmailIds: [],
      probeRevision: true,
    });
    await expect(processMutationRow({
      transport,
      account,
      handlers,
      row: converted,
    })).resolves.toMatchObject({ ok: true });
    expect([...serverEmails.keys()]).toEqual([]);
  });

  it('deletes an unstarted save with no possible server effect', async () => {
    const untouched = await enqueueSave(2);
    await expect(handlers[DB_RPC.PENDING_MUTATION_ABANDON_DRAFT]({
      accountId: account.id,
      mutationId: untouched.id,
      intent: 'keep-confirmed',
    })).resolves.toMatchObject({ abandoned: 1, converted: 0, parked: 0 });
    await expect(engine.get(
      'SELECT id FROM pending_mutations WHERE id = ?',
      [untouched.id],
    )).resolves.toBeNull();
  });

  it('keeps an HTTP authentication rejection retryable without replaying creation', async () => {
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

    const result = await processMutationRow({
      transport,
      account,
      handlers,
      row,
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        type: 'authenticationFailed',
        detail: {
          status: 401,
          operation: 'draftCreateAmbiguous',
        },
      },
    });
    expect(result.error).not.toHaveProperty('terminal');
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

  it.each(['method', 'notCreated'])(
    'classifies retryable draft failures from the %s error path',
    async (errorPath) => {
      if (errorPath === 'method') {
        transport.handleError('Email/set', { type: 'serverPartialFail' });
      } else {
        transport.handle('Email/set', () => ({
          notCreated: { draft: { type: 'serverPartialFail' } },
        }));
      }
      const { id } = await enqueueSave(1);
      const row = await engine.get(
        'SELECT * FROM pending_mutations WHERE id = ?',
        [id],
      );

      const result = await processMutationRow({
        transport,
        account,
        handlers,
        row,
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          type: 'draftCreateFailed',
          detail: { type: 'serverPartialFail' },
        },
      });
      expect(result.error).not.toHaveProperty('terminal');
    },
  );

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

  it('chunks base checks and checkpoints completed predecessor cleanup', async () => {
    transport.session.capabilities[JMAP_CAPS.CORE] = {
      ...transport.session.capabilities[JMAP_CAPS.CORE],
      maxObjectsInGet: 2,
      maxObjectsInSet: 2,
    };
    const baseIds = Array.from({ length: 5 }, (_, index) => `base-${index + 1}`);
    for (const id of baseIds) {
      serverEmails.set(id, {
        id,
        mailboxIds: { 'mb-drafts': true },
        keywords: { $draft: true },
      });
    }
    const defaultEmailSet = transport._handlers.get('Email/set')!;
    const destroyRequests: string[][] = [];
    let rejectSecondChunk = true;
    transport.handle('Email/set', (params) => {
      if (params.destroy) {
        destroyRequests.push([...params.destroy]);
        if (rejectSecondChunk && destroyRequests.length === 2) {
          rejectSecondChunk = false;
          return {
            notDestroyed: Object.fromEntries(
              params.destroy.map((id) => [id, { type: 'serverFail' }]),
            ),
          };
        }
      }
      return defaultEmailSet(params);
    });
    const inserted = await enqueueSave(2, baseIds);
    const row = await engine.get(
      'SELECT * FROM pending_mutations WHERE id = ?',
      [inserted.id],
    );

    await expect(processMutationRow({
      transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({
      ok: false,
      error: { type: 'draftCleanupFailed' },
    });

    const afterFailure = await engine.get(
      'SELECT * FROM pending_mutations WHERE id = ?',
      [inserted.id],
    );
    expect(JSON.parse(afterFailure.server_response_json).pendingDestroyIds)
      .toEqual(baseIds.slice(2));
    await expect(processMutationRow({
      transport,
      account,
      handlers,
      row: afterFailure,
    })).resolves.toMatchObject({ ok: true });

    const baseGets = transport.requests
      .flatMap((request) => request.methodCalls)
      .filter(([name, params]) =>
        name === 'Email/get' && params.ids?.some((id) => id.startsWith('base-')));
    expect(baseGets).toHaveLength(3);
    expect(baseGets.every(([, params]) => params.ids.length <= 2)).toBe(true);
    expect(destroyRequests).toEqual([
      baseIds.slice(0, 2),
      baseIds.slice(2, 4),
      baseIds.slice(2, 4),
      baseIds.slice(4),
    ]);
  });

  it('uploads once, then reuses canonical regular parts across two revisions', async () => {
    const upload = await transport.upload({
      accountId: account.remote_account_id,
      type: 'application/pdf',
      body: new Uint8Array([1, 2, 3]),
    });
    const first = requestFor(1);
    first.attachments = [{
      part_id: '',
      blob_id: upload.blobId,
      name: 'report.pdf',
      mime_type: 'application/pdf',
      size: 3,
      disposition: 'attachment',
      cid: null,
    }];
    await enqueueDraftRequest(first);
    await expect(drainOutbox({ transport, account, handlers }))
      .resolves.toMatchObject({ succeeded: 1, failed: 0 });

    const [firstPart] = await localRegularAttachments('draft-1');
    const second = requestFor(2, ['draft-1']);
    second.attachments = [firstPart];
    await enqueueDraftRequest(second);
    await expect(drainOutbox({ transport, account, handlers }))
      .resolves.toMatchObject({ succeeded: 1, failed: 0 });

    const [secondPart] = await localRegularAttachments('draft-2');
    const third = requestFor(3, ['draft-2']);
    third.attachments = [secondPart];
    await enqueueDraftRequest(third);
    await expect(drainOutbox({ transport, account, handlers }))
      .resolves.toMatchObject({ succeeded: 1, failed: 0 });

    expect(transport.uploads).toHaveLength(1);
    const createParts = transport.requests
      .flatMap((request) => request.methodCalls)
      .filter(([name, params]) => name === 'Email/set' && params.create)
      .map(([, params]) => params.create.draft.bodyStructure.subParts[1]);
    expect(createParts.map((part) => part.blobId)).toEqual([
      upload.blobId,
      firstPart.blob_id,
      secondPart.blob_id,
    ]);
    expect([...serverEmails.keys()]).toEqual(['draft-3']);
  });

  it('checkpoints successor parts before destroying the predecessor', async () => {
    const first = requestFor(1);
    first.attachments = [{
      part_id: '',
      blob_id: 'temporary-upload',
      name: 'report.pdf',
      mime_type: 'application/pdf',
      size: 3,
      disposition: 'attachment',
      cid: null,
    }];
    await enqueueDraftRequest(first);
    await drainOutbox({ transport, account, handlers });
    const [source] = await localRegularAttachments('draft-1');

    protocolEvents = [];
    const query = handlers[DB_RPC.QUERY];
    handlers[DB_RPC.QUERY] = async (params) => {
      if (String(params?.sql).includes('UPDATE pending_mutations')
          && params?.params?.[0] === DRAFT_PHASE.CACHE_PENDING) {
        protocolEvents.push('checkpoint');
      }
      return query(params);
    };
    const second = requestFor(2, ['draft-1']);
    second.attachments = [source];
    await enqueueDraftRequest(second);
    await expect(drainOutbox({ transport, account, handlers }))
      .resolves.toMatchObject({ succeeded: 1, failed: 0 });

    expect(protocolEvents.indexOf('body-fetch')).toBeGreaterThan(
      protocolEvents.indexOf('create'),
    );
    expect(protocolEvents.indexOf('checkpoint')).toBeGreaterThan(
      protocolEvents.indexOf('body-fetch'),
    );
    expect(protocolEvents.indexOf('destroy')).toBeGreaterThan(
      protocolEvents.indexOf('checkpoint'),
    );
  });

  it('preserves the predecessor when successor attachment handles are malformed', async () => {
    const first = requestFor(1);
    first.attachments = [{
      part_id: '',
      blob_id: 'temporary-upload',
      name: 'report.pdf',
      mime_type: 'application/pdf',
      size: 3,
      disposition: 'attachment',
      cid: null,
    }];
    await enqueueDraftRequest(first);
    await drainOutbox({ transport, account, handlers });
    const [source] = await localRegularAttachments('draft-1');

    malformNextSuccessor = true;
    protocolEvents = [];
    const second = requestFor(2, ['draft-1']);
    second.attachments = [source];
    await enqueueDraftRequest(second);
    await expect(drainOutbox({ transport, account, handlers }))
      .resolves.toMatchObject({ succeeded: 0, failed: 1 });

    expect(serverEmails.has('draft-1')).toBe(true);
    expect(serverEmails.has('draft-2')).toBe(true);
    expect(protocolEvents).not.toContain('destroy');
  });

  it('preserves the predecessor when successor body persistence fails', async () => {
    const first = requestFor(1);
    first.attachments = [{
      part_id: '',
      blob_id: 'temporary-upload',
      name: 'report.pdf',
      mime_type: 'application/pdf',
      size: 3,
      disposition: 'attachment',
      cid: null,
    }];
    await enqueueDraftRequest(first);
    await drainOutbox({ transport, account, handlers });
    const [source] = await localRegularAttachments('draft-1');
    const second = requestFor(2, ['draft-1']);
    second.attachments = [source];
    const inserted = await enqueueDraftRequest(second);
    const row = await engine.get(
      'SELECT * FROM pending_mutations WHERE id = ?',
      [inserted.id],
    );
    const failingHandlers = {
      ...handlers,
      [DB_RPC.MESSAGE_BODY_PERSIST_BATCH]: async () => {
        throw new Error('cache unavailable');
      },
    };
    protocolEvents = [];

    await expect(processMutationRow({
      transport,
      account,
      handlers: failingHandlers,
      row,
    })).resolves.toMatchObject({
      ok: false,
      error: { type: 'draftCacheReconcileFailed' },
    });

    expect(serverEmails.has('draft-1')).toBe(true);
    expect(serverEmails.has('draft-2')).toBe(true);
    expect(protocolEvents).not.toContain('destroy');
  });

  it('preserves the predecessor when a reused part returns blobNotFound', async () => {
    const first = requestFor(1);
    first.attachments = [{
      part_id: '',
      blob_id: 'temporary-upload',
      name: 'report.pdf',
      mime_type: 'application/pdf',
      size: 3,
      disposition: 'attachment',
      cid: null,
    }];
    await enqueueDraftRequest(first);
    await drainOutbox({ transport, account, handlers });
    const [source] = await localRegularAttachments('draft-1');

    blobNotFoundNextCreate = true;
    protocolEvents = [];
    const second = requestFor(2, ['draft-1']);
    second.attachments = [source];
    const row = await enqueueDraftRequest(second);
    const pending = await engine.get('SELECT * FROM pending_mutations WHERE id = ?', [row.id]);
    await expect(processMutationRow({
      transport,
      account,
      handlers,
      row: pending,
    })).resolves.toMatchObject({
      ok: false,
      error: {
        type: 'blobNotFound',
        terminal: true,
        result: { attachmentIndexes: [0] },
      },
    });

    expect(serverEmails.has('draft-1')).toBe(true);
    expect(protocolEvents).not.toContain('destroy');
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

  it('resumes post-send cleanup from its first unconfirmed chunk', async () => {
    transport.session.capabilities[JMAP_CAPS.CORE] = {
      ...transport.session.capabilities[JMAP_CAPS.CORE],
      maxObjectsInGet: 2,
      maxObjectsInSet: 2,
    };
    const draftEmailIds = Array.from(
      { length: 5 },
      (_, index) => `send-draft-${index + 1}`,
    );
    for (const id of draftEmailIds) {
      serverEmails.set(id, {
        id,
        mailboxIds: { 'mb-drafts': true },
        keywords: { $draft: true },
      });
    }
    let submissions = 0;
    transport.handle('EmailSubmission/set', (params) => {
      submissions += 1;
      const submitted = params.create.s1;
      const email = serverEmails.get(submitted.emailId);
      email.mailboxIds = { 'mb-sent': true };
      email.keywords = { $seen: true };
      return { created: { s1: { id: 'submission-chunked' } } };
    });
    const defaultEmailSet = transport._handlers.get('Email/set')!;
    const destroyRequests: string[][] = [];
    let rejectSecondChunk = true;
    transport.handle('Email/set', (params) => {
      if (params.destroy) {
        destroyRequests.push([...params.destroy]);
        if (rejectSecondChunk && destroyRequests.length === 2) {
          rejectSecondChunk = false;
          return {
            notDestroyed: Object.fromEntries(
              params.destroy.map((id) => [id, { type: 'serverFail' }]),
            ),
          };
        }
      }
      return defaultEmailSet(params);
    });
    const inserted = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.SEND,
      targetMessageId: null,
      requestJson: JSON.stringify({
        draftSessionId: 'session-1',
        identityId: identity.id,
        to: [{ email: 'recipient@example.com' }],
        cc: [],
        bcc: [],
        subject: 'Chunk cleanup',
        textBody: 'Final body',
        htmlBody: '',
        inReplyTo: [],
        references: [],
        draftsFolderId: drafts.id,
        sentFolderId: sent.id,
        outboxFolderId: null,
        draftEmailIds,
      }),
    });
    const row = await engine.get(
      'SELECT * FROM pending_mutations WHERE id = ?',
      [inserted.id],
    );

    await expect(processMutationRow({
      transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({
      ok: false,
      error: {
        type: 'cacheReconcileFailed',
        result: { submitted: true },
      },
    });
    const afterFailure = await engine.get(
      'SELECT * FROM pending_mutations WHERE id = ?',
      [inserted.id],
    );
    expect(JSON.parse(afterFailure.server_response_json)).toMatchObject({
      pendingDraftDestroyIds: draftEmailIds.slice(2),
      cacheAttempts: 1,
    });

    await expect(processMutationRow({
      transport,
      account,
      handlers,
      row: afterFailure,
    })).resolves.toMatchObject({ ok: true });
    expect(submissions).toBe(1);
    expect(destroyRequests).toEqual([
      draftEmailIds.slice(0, 2),
      draftEmailIds.slice(2, 4),
      draftEmailIds.slice(2, 4),
      draftEmailIds.slice(4),
    ]);
  });

  it('checkpoints sent attachment handles before draft cleanup and never resubmits repair', async () => {
    const draftRequest = requestFor(1);
    draftRequest.attachments = [{
      part_id: '',
      blob_id: 'temporary-upload',
      name: 'report.pdf',
      mime_type: 'application/pdf',
      size: 3,
      disposition: 'attachment',
      cid: null,
    }];
    await enqueueDraftRequest(draftRequest);
    await drainOutbox({ transport, account, handlers });
    const [source] = await localRegularAttachments('draft-1');
    let submissions = 0;
    transport.handle('EmailSubmission/set', (params) => {
      submissions += 1;
      const submitted = params.create.s1;
      const email = serverEmails.get(submitted.emailId);
      email.mailboxIds = { 'mb-sent': true };
      email.keywords = { $seen: true };
      return { created: { s1: { id: 'submission-attachment' } } };
    });
    const inserted = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.SEND,
      targetMessageId: null,
      requestJson: JSON.stringify({
        draftSessionId: 'session-1',
        identityId: identity.id,
        to: [{ email: 'recipient@example.com' }],
        cc: [],
        bcc: [],
        subject: 'Send attachment',
        textBody: 'Attached',
        htmlBody: '',
        attachments: [source],
        attachmentClientMap: [{ clientId: 'client-1', order: 0 }],
        inReplyTo: [],
        references: [],
        draftsFolderId: drafts.id,
        sentFolderId: sent.id,
        outboxFolderId: null,
        draftEmailIds: ['draft-1'],
      }),
    });
    const row = await engine.get(
      'SELECT * FROM pending_mutations WHERE id = ?',
      [inserted.id],
    );
    let failSentBodyPersist = true;
    const failingHandlers = {
      ...handlers,
      [DB_RPC.MESSAGE_BODY_PERSIST_BATCH]: async (params) => {
        if (failSentBodyPersist && params.bodies?.[0]?.remoteId === 'send-2') {
          failSentBodyPersist = false;
          throw new Error('sent body cache unavailable');
        }
        return handlers[DB_RPC.MESSAGE_BODY_PERSIST_BATCH](params);
      },
    };

    const first = await processMutationRow({
      transport,
      account,
      handlers: failingHandlers,
      row,
    });
    expect(first).toMatchObject({
      ok: false,
      error: {
        type: 'cacheReconcileFailed',
        result: { submitted: true, filed: false },
      },
    });
    expect(submissions).toBe(1);
    expect(serverEmails.has('draft-1')).toBe(true);
    const sentCreate = transport.requests
      .flatMap((request) => request.methodCalls)
      .find(([name, params]) => name === 'Email/set' && params.create?.c1)?.[1]
      ?.create?.c1;
    expect(sentCreate.attachments).toBeUndefined();
    expect(sentCreate.bodyStructure).toMatchObject({
      type: 'multipart/mixed',
      subParts: [
        { type: 'text/plain' },
        {
          blobId: source.blob_id,
          name: 'report.pdf',
          disposition: 'attachment',
        },
      ],
    });
    expect(transport.uploads).toHaveLength(0);

    const retryRow = await engine.get(
      'SELECT * FROM pending_mutations WHERE id = ?',
      [inserted.id],
    );
    await expect(processMutationRow({
      transport,
      account,
      handlers,
      row: retryRow,
    })).resolves.toMatchObject({
      ok: true,
      result: { createdRemoteId: 'send-2', filed: true },
    });

    expect(submissions).toBe(1);
    expect(serverEmails.has('draft-1')).toBe(false);
    expect(serverEmails.has('send-2')).toBe(true);
    const [sentPart] = await localRegularAttachments('send-2');
    expect(sentPart).toMatchObject({
      name: 'report.pdf',
      mime_type: 'application/pdf',
      disposition: 'attachment',
    });
    (transport as any).download = vi.fn(async ({ blobId }) => {
      const downloadable = [...serverEmails.values()].some((email) =>
        email.attachments.some((attachment) => attachment.blobId === blobId));
      if (!downloadable) throw new Error('blobNotFound');
      return new Uint8Array([1, 2, 3]);
    });
    await expect((transport as any).download({
      accountId: account.remote_account_id,
      blobId: sentPart.blob_id,
      type: sentPart.mime_type,
      name: sentPart.name,
    })).resolves.toEqual(new Uint8Array([1, 2, 3]));
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
    const html = saved.bodyValues[saved.htmlBody[0].partId].value;
    expect(html).toContain('Image signature');
    expect(html).toMatch(/src="cid:[^"]+@stormbox"/);
    expect(html).not.toContain('data:image/');
    expect(html).not.toContain('data-stormbox-');
    expect(saved.bodyStructure.type).toBe('multipart/related');
  });
});

describe('draft attachment preparation', () => {
  it('reuses a predecessor-owned regular part without downloading or uploading it', async () => {
    const download = vi.fn();
    const upload = vi.fn();
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
        htmlBody: '<p>See the attached image.</p>',
        attachments: [{
          part_id: 'old-part-1',
          blob_id: 'part-blob-on-old-draft',
          mime_type: 'image/png',
          name: 'image.png',
          size: 3,
          disposition: 'attachment',
          cid: null,
        }],
      },
    });

    expect(download).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(prepared.bodyStructure).toMatchObject({
      type: 'multipart/mixed',
      subParts: [
        { type: 'multipart/alternative' },
        {
          blobId: 'part-blob-on-old-draft',
          type: 'image/png',
          name: 'image.png',
          disposition: 'attachment',
        },
      ],
    });
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

  it('nests inline images inside related before ordered regular parts', async () => {
    const download = vi.fn();
    const upload = vi.fn(async () => ({ blobId: 'inline-blob' }));
    const prepared = await prepareComposeEmail({
      transport: { download, upload },
      account: { remote_account_id: 'account-1' },
      identity: { email: 'writer@example.com' },
      mailboxRemoteId: 'mb-drafts',
      isDraft: true,
      request: {
        to: [{ email: 'recipient@example.com' }],
        subject: 'Mixed MIME',
        textBody: 'Body and files',
        htmlBody: '<p>Body<img src="data:image/png;base64,iVBORw0KGgo="></p>',
        attachments: [
          {
            part_id: '',
            blob_id: 'regular-one',
            mime_type: 'application/pdf',
            name: 'one.pdf',
            size: 1,
            disposition: 'attachment',
            cid: null,
          },
          {
            part_id: '',
            blob_id: 'regular-two',
            mime_type: 'text/plain',
            name: 'two.txt',
            size: 2,
            disposition: 'attachment',
            cid: null,
          },
        ],
      },
    });

    expect(download).not.toHaveBeenCalled();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(prepared.bodyStructure).toMatchObject({
      type: 'multipart/mixed',
      subParts: [
        {
          type: 'multipart/related',
          subParts: [
            { type: 'multipart/alternative' },
            { blobId: 'inline-blob', disposition: 'inline' },
          ],
        },
        { blobId: 'regular-one', name: 'one.pdf', disposition: 'attachment' },
        { blobId: 'regular-two', name: 'two.txt', disposition: 'attachment' },
      ],
    });
    expect(prepared).not.toHaveProperty('attachments');
  });
});

describe('draft reconciliation paging', () => {
  function preparedRevision(body = 'complete body') {
    return {
      subject: 'Recovered draft',
      from: [{ name: '', email: 'writer@example.com' }],
      to: [{ name: '', email: 'recipient@example.com' }],
      cc: [],
      bcc: [],
      bodyValues: { p1: { value: body } },
    };
  }

  function recoveredRevision(
    id: string,
    body = 'complete body',
    isTruncated = false,
  ) {
    return {
      id,
      messageId: ['wanted@example.com'],
      mailboxIds: { 'mb-drafts': true },
      keywords: { $draft: true },
      subject: 'Recovered draft',
      from: [{ name: '', email: 'writer@example.com' }],
      to: [{ name: '', email: 'recipient@example.com' }],
      cc: [],
      bcc: [],
      textBody: [{ partId: 'p1' }],
      htmlBody: [],
      bodyValues: { p1: { value: body, isTruncated } },
    };
  }

  it('hydrates bodies only for Message-ID candidates', async () => {
    const paged = new MockTransport();
    paged.handle('Email/query', () => ({
      ids: ['unrelated', 'wanted'],
      total: 2,
      position: 0,
      queryState: 'stable',
    }));
    paged.handle('Email/get', (params) => ({
      list: params.ids.map((id) => {
        if (params.properties.length === 2) {
          return {
            id,
            messageId: id === 'wanted' ? ['wanted@example.com'] : ['other@example.com'],
          };
        }
        return recoveredRevision(id);
      }),
      state: 'email-state',
    }));

    await expect(findDraftRevision({
      transport: paged,
      account: { remote_account_id: 'account-1' },
      draftsRemoteId: 'mb-drafts',
      revisionMessageId: '<wanted@example.com>',
      preparedEmail: preparedRevision(),
    })).resolves.toMatchObject({
      outcome: 'found',
      emailIds: ['wanted'],
    });

    const getCalls = paged.requests
      .flatMap((request) => request.methodCalls)
      .filter(([name]) => name === 'Email/get');
    expect(getCalls).toHaveLength(2);
    expect(getCalls[0][1]).toMatchObject({
      properties: ['id', 'messageId'],
    });
    expect(getCalls[0][1]).not.toHaveProperty('fetchTextBodyValues');
    expect(getCalls[1][1]).toMatchObject({
      ids: ['wanted'],
      fetchTextBodyValues: true,
      fetchHTMLBodyValues: true,
    });
  });

  it('does not classify a truncated matching body as conflicting', async () => {
    const paged = new MockTransport();
    paged.handle('Email/query', () => ({
      ids: ['wanted'],
      total: 1,
      position: 0,
      queryState: 'stable',
    }));
    paged.handle('Email/get', (params) => ({
      list: params.properties.length === 2
        ? [{ id: 'wanted', messageId: ['wanted@example.com'] }]
        : [recoveredRevision('wanted', 'complete bod', true)],
      state: 'email-state',
    }));

    await expect(findDraftRevision({
      transport: paged,
      account: { remote_account_id: 'account-1' },
      draftsRemoteId: 'mb-drafts',
      revisionMessageId: '<wanted@example.com>',
      preparedEmail: preparedRevision(),
    })).resolves.toEqual({
      outcome: 'inconclusive',
      reason: 'incompleteBodyValue',
    });
  });

  it('does not compare a body with an encoding problem', async () => {
    const paged = new MockTransport();
    paged.handle('Email/query', () => ({
      ids: ['wanted'],
      total: 1,
      position: 0,
      queryState: 'stable',
    }));
    paged.handle('Email/get', (params) => {
      if (params.properties.length === 2) {
        return {
          list: [{ id: 'wanted', messageId: ['wanted@example.com'] }],
          state: 'email-state',
        };
      }
      const recovered: any = recoveredRevision('wanted');
      recovered.bodyValues.p1 = {
        value: 'complete body',
        isTruncated: false,
        isEncodingProblem: true,
      };
      return { list: [recovered], state: 'email-state' };
    });

    await expect(findDraftRevision({
      transport: paged,
      account: { remote_account_id: 'account-1' },
      draftsRemoteId: 'mb-drafts',
      revisionMessageId: '<wanted@example.com>',
      preparedEmail: preparedRevision(),
    })).resolves.toEqual({
      outcome: 'inconclusive',
      reason: 'incompleteBodyValue',
    });
  });

  it.each([
    [false, { outcome: 'conflict', emailIds: ['wanted'] }],
    [true, { outcome: 'inconclusive', reason: 'incompleteBodyValue' }],
  ])(
    'does not accept unexpected HTML when truncation is %s',
    async (isTruncated, expected) => {
      const paged = new MockTransport();
      paged.handle('Email/query', () => ({
        ids: ['wanted'],
        total: 1,
        position: 0,
        queryState: 'stable',
      }));
      paged.handle('Email/get', (params) => {
        if (params.properties.length === 2) {
          return {
            list: [{ id: 'wanted', messageId: ['wanted@example.com'] }],
            state: 'email-state',
          };
        }
        const recovered: any = recoveredRevision('wanted');
        recovered.htmlBody = [{ partId: 'h1', type: 'text/html' }];
        recovered.bodyValues.h1 = {
          value: '<p>Unexpected HTML</p>',
          isTruncated,
        };
        return { list: [recovered], state: 'email-state' };
      });

      await expect(findDraftRevision({
        transport: paged,
        account: { remote_account_id: 'account-1' },
        draftsRemoteId: 'mb-drafts',
        revisionMessageId: '<wanted@example.com>',
        preparedEmail: preparedRevision(),
      })).resolves.toEqual(expected);
    },
  );

  it('rejects a candidate that no longer belongs to Drafts', async () => {
    const paged = new MockTransport();
    paged.handle('Email/query', () => ({
      ids: ['wanted'],
      total: 1,
      position: 0,
      queryState: 'stable',
    }));
    paged.handle('Email/get', (params) => {
      if (params.properties.length === 2) {
        return {
          list: [{ id: 'wanted', messageId: ['wanted@example.com'] }],
          state: 'email-state',
        };
      }
      return {
        list: [{
          ...recoveredRevision('wanted'),
          mailboxIds: { elsewhere: true },
        }],
        state: 'email-state',
      };
    });

    await expect(findDraftRevision({
      transport: paged,
      account: { remote_account_id: 'account-1' },
      draftsRemoteId: 'mb-drafts',
      revisionMessageId: '<wanted@example.com>',
      preparedEmail: preparedRevision(),
    })).resolves.toEqual({
      outcome: 'inconclusive',
      reason: 'candidateChanged',
    });
  });

  it.each([null, false, '0'])('rejects malformed query total %j', async (total) => {
    const paged = new MockTransport();
    paged.handle('Email/query', () => ({
      ids: [],
      total,
      position: 0,
      queryState: 'stable',
    }));
    paged.handle('Email/get', () => ({ list: [], state: 'email-state' }));

    await expect(findDraftRevision({
      transport: paged,
      account: { remote_account_id: 'account-1' },
      draftsRemoteId: 'mb-drafts',
      revisionMessageId: '<wanted@example.com>',
      preparedEmail: preparedRevision(),
    })).resolves.toEqual({
      outcome: 'inconclusive',
      reason: 'malformedQuery',
    });
  });

  it('rejects a repeated query page instead of proving absence', async () => {
    const paged = new MockTransport({
      capabilities: {
        'urn:ietf:params:jmap:core': { maxObjectsInGet: 2, maxObjectsInSet: 500 },
      },
    });
    paged.handle('Email/query', (params) => ({
      ids: ['one', 'two'],
      total: 4,
      position: params.position,
      queryState: 'stable',
    }));
    paged.handle('Email/get', (params) => ({
      list: params.ids.map((id) => ({ id, messageId: [] })),
      state: 'email-state',
    }));

    await expect(findDraftRevision({
      transport: paged,
      account: { remote_account_id: 'account-1' },
      draftsRemoteId: 'mb-drafts',
      revisionMessageId: '<wanted@example.com>',
      preparedEmail: preparedRevision(),
    })).resolves.toEqual({
      outcome: 'inconclusive',
      reason: 'repeatedQueryPage',
    });
  });

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
