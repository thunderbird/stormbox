import {
  afterEach, beforeEach, describe, expect, it,
} from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { IDENTITY_ERROR } from '../../../src/constants/identity-errors';
import {
  IDENTITY_PHASE,
  SEND_PHASE,
} from '../../../src/constants/states';
import {
  MUTATION_TYPES,
  processMutationRow,
} from '../../../src/sync/backends/jmap/outbox';
import { identityErrorType } from '../../../src/sync/backends/jmap/outbox/operations/identities';
import { MockTransport } from './_mock-transport';

let engine: any;
let handlers: any;
let account: any;

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
});

afterEach(async () => {
  await engine.close();
});

async function queueRow(mutationType: string, request: any) {
  const { id } = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
    accountId: account.id,
    mutationType,
    targetMessageId: null,
    requestJson: JSON.stringify(request),
  });
  return handlers[DB_RPC.QUERY]({
    sql: 'SELECT * FROM pending_mutations WHERE id = ?',
    params: [id],
  }).then((rows: any[]) => rows[0]);
}

function reload(rowId: number) {
  return handlers[DB_RPC.QUERY]({
    sql: 'SELECT * FROM pending_mutations WHERE id = ?',
    params: [rowId],
  }).then((rows: any[]) => rows[0]);
}

function identityServer() {
  const transport = new MockTransport();
  let identities: any[] = [];
  let setCalls = 0;
  const setRequests: any[] = [];
  transport.handle('Identity/set', (params) => {
    setCalls += 1;
    setRequests.push(params);
    if (params.create) {
      identities.push({
        id: 'identity-1',
        name: '',
        ...params.create.identity,
        mayDelete: true,
      });
      return { created: { identity: { id: 'identity-1' } } };
    }
    if (params.update) {
      const [remoteId] = Object.keys(params.update);
      identities = identities.map((identity) =>
        identity.id === remoteId
          ? { ...identity, ...params.update[remoteId] }
          : identity);
      return { updated: { [remoteId]: null } };
    }
    const remoteId = params.destroy[0];
    identities = identities.filter((identity) => identity.id !== remoteId);
    return { destroyed: [remoteId] };
  });
  transport.handle('Identity/get', (params) => ({
    list: Array.isArray(params.ids)
      ? identities.filter((identity) => params.ids.includes(identity.id))
      : identities,
    state: 'identity-state',
  }));
  return {
    transport,
    get setCalls() {
      return setCalls;
    },
    get setRequests() {
      return setRequests;
    },
  };
}

describe('identity management mutations', () => {
  it('creates, updates, and deletes through Identity/set with cache read-back', async () => {
    const server = identityServer();
    const created = await queueRow(MUTATION_TYPES.CREATE_IDENTITY, {
      name: 'Alias',
      email: 'alias@example.com',
    });
    await expect(processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row: created,
    })).resolves.toMatchObject({ ok: true });

    let [identity] = await handlers[DB_RPC.IDENTITY_LIST]({ accountId: account.id });
    expect(identity).toMatchObject({
      remote_id: 'identity-1',
      name: 'Alias',
      email: 'alias@example.com',
    });

    const updated = await queueRow(MUTATION_TYPES.UPDATE_IDENTITY, {
      remoteId: identity.remote_id,
      name: 'Renamed Alias',
    });
    await expect(processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row: updated,
    })).resolves.toMatchObject({ ok: true });

    [identity] = await handlers[DB_RPC.IDENTITY_LIST]({ accountId: account.id });
    expect(identity).toMatchObject({
      name: 'Renamed Alias',
      email: 'alias@example.com',
    });

    const deleted = await queueRow(MUTATION_TYPES.DELETE_IDENTITY, {
      remoteId: identity.remote_id,
    });
    await expect(processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row: deleted,
    })).resolves.toMatchObject({ ok: true });

    expect(await handlers[DB_RPC.IDENTITY_LIST]({ accountId: account.id })).toEqual([]);
    expect(server.setCalls).toBe(3);
  });

  it('omits untouched optional fields from a sparse create', async () => {
    const server = identityServer();
    const row = await queueRow(MUTATION_TYPES.CREATE_IDENTITY, {
      operationId: 'sparse-create',
      email: 'sparse@example.com',
      bcc: null,
    });

    await expect(processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({ ok: true });

    expect(server.setRequests[0].create.identity).toEqual({
      email: 'sparse@example.com',
      bcc: null,
    });
  });

  it('sends a sparse update with ordered addresses and explicit clears', async () => {
    await handlers[DB_RPC.IDENTITY_UPSERT_MANY]({
      accountId: account.id,
      identities: [{
        remoteId: 'identity-1',
        name: 'Alias',
        email: 'alias@example.com',
        replyTo: null,
        bcc: null,
        textSignature: null,
        htmlSignature: null,
        mayDelete: true,
        rawJson: '{}',
      }],
    });
    const transport = new MockTransport();
    let serverIdentity: any = {
      id: 'identity-1',
      name: 'Alias',
      email: 'alias@example.com',
      mayDelete: true,
    };
    let updatePayload: any = null;
    transport.handle('Identity/set', (params) => {
      updatePayload = params.update['identity-1'];
      serverIdentity = { ...serverIdentity, ...updatePayload };
      return { updated: { 'identity-1': null } };
    });
    transport.handle('Identity/get', (params) => ({
      list: params.ids.includes('identity-1') ? [serverIdentity] : [],
      state: 'identity-state-2',
    }));
    const row = await queueRow(MUTATION_TYPES.UPDATE_IDENTITY, {
      operationId: 'update-operation',
      remoteId: 'identity-1',
      name: '',
      replyTo: null,
      bcc: [
        { name: null, email: 'first@example.com' },
        { name: 'Second', email: 'second@example.com' },
      ],
      htmlSignature: '',
      textSignature: '',
    });

    await expect(processMutationRow({
      transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({
      ok: true,
      result: { ids: ['identity-1'] },
    });

    expect(updatePayload).toEqual({
      name: '',
      replyTo: null,
      bcc: [
        { name: null, email: 'first@example.com' },
        { name: 'Second', email: 'second@example.com' },
      ],
      htmlSignature: '',
      textSignature: '',
    });
    expect(updatePayload).not.toHaveProperty('email');
    expect(updatePayload).not.toHaveProperty('id');
    expect(updatePayload).not.toHaveProperty('mayDelete');
    const cached = await handlers[DB_RPC.IDENTITY_GET_BY_REMOTE]({
      accountId: account.id,
      remoteId: 'identity-1',
    });
    expect(cached).toMatchObject({
      name: '',
      reply_to: null,
      bcc: [
        { name: null, email: 'first@example.com' },
        { name: 'Second', email: 'second@example.com' },
      ],
      html_signature: '',
      text_signature: '',
    });
  });

  it('removes exactly the confirmed identity from the local cache', async () => {
    await handlers[DB_RPC.IDENTITY_UPSERT_MANY]({
      accountId: account.id,
      identities: [
        {
          remoteId: 'identity-delete',
          name: 'Delete',
          email: 'delete@example.com',
          replyTo: null,
          bcc: null,
          textSignature: null,
          htmlSignature: null,
          mayDelete: true,
          rawJson: '{}',
        },
        {
          remoteId: 'identity-keep',
          name: 'Keep',
          email: 'keep@example.com',
          replyTo: null,
          bcc: null,
          textSignature: null,
          htmlSignature: null,
          mayDelete: false,
          rawJson: '{}',
        },
      ],
    });
    const transport = new MockTransport();
    transport.handle('Identity/set', () => ({ destroyed: ['identity-delete'] }));
    const row = await queueRow(MUTATION_TYPES.DELETE_IDENTITY, {
      operationId: 'delete-operation',
      remoteId: 'identity-delete',
    });

    await expect(processMutationRow({
      transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({ ok: true });

    const remaining = await handlers[DB_RPC.IDENTITY_LIST]({ accountId: account.id });
    expect(remaining.map((identity: any) => identity.remote_id)).toEqual(['identity-keep']);
    expect(transport.requests.flatMap((request) => request.methodCalls)
      .some(([method]) => method === 'Identity/get')).toBe(false);
  });

  it('target-reads an uncached identity and refuses destroy unless mayDelete is true', async () => {
    const transport = new MockTransport();
    let setCalls = 0;
    transport.handle('Identity/get', () => ({
      list: [{
        id: 'uncached-protected',
        name: 'Protected',
        email: 'protected@example.com',
        mayDelete: false,
      }],
      state: 'identity-state',
    }));
    transport.handle('Identity/set', () => {
      setCalls += 1;
      return { destroyed: ['uncached-protected'] };
    });
    const row = await queueRow(MUTATION_TYPES.DELETE_IDENTITY, {
      operationId: 'delete-protected',
      remoteId: 'uncached-protected',
    });

    await expect(processMutationRow({
      transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({
      ok: false,
      error: { type: IDENTITY_ERROR.PERMISSION_DENIED, terminal: true },
    });
    expect(setCalls).toBe(0);
  });

  it('target-reads an uncached deletable identity before destroy', async () => {
    const transport = new MockTransport();
    let setCalls = 0;
    transport.handle('Identity/get', () => ({
      list: [{
        id: 'uncached-deletable',
        name: 'Alias',
        email: 'alias@example.com',
        mayDelete: true,
      }],
      state: 'identity-state',
    }));
    transport.handle('Identity/set', () => {
      setCalls += 1;
      return { destroyed: ['uncached-deletable'] };
    });
    const row = await queueRow(MUTATION_TYPES.DELETE_IDENTITY, {
      operationId: 'delete-uncached',
      remoteId: 'uncached-deletable',
    });

    await expect(processMutationRow({
      transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({ ok: true });
    expect(setCalls).toBe(1);
  });

  it('does not destroy an uncached remote id that the server cannot find', async () => {
    const transport = new MockTransport();
    transport.handle('Identity/get', () => ({
      list: [],
      notFound: ['missing-identity'],
      state: 'identity-state',
    }));
    const row = await queueRow(MUTATION_TYPES.DELETE_IDENTITY, {
      operationId: 'delete-missing',
      remoteId: 'missing-identity',
    });

    await expect(processMutationRow({
      transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({
      ok: false,
      error: { type: IDENTITY_ERROR.MISSING, terminal: true },
    });
    expect(transport.requests.flatMap((request) => request.methodCalls)
      .some(([method]) => method === 'Identity/set')).toBe(false);
  });

  it('accepts 2047 UTF-8 bytes and rejects 2048 before Identity/set', async () => {
    const acceptedServer = identityServer();
    const acceptedValue = `${'é'.repeat(1023)}a`;
    const accepted = await queueRow(MUTATION_TYPES.CREATE_IDENTITY, {
      email: 'alias@example.com',
      htmlSignature: acceptedValue,
      textSignature: acceptedValue,
    });
    await expect(processMutationRow({
      transport: acceptedServer.transport,
      account,
      handlers,
      row: accepted,
    })).resolves.toMatchObject({ ok: true });
    expect(acceptedServer.setCalls).toBe(1);

    const rejectedServer = identityServer();
    const rejectedValue = 'é'.repeat(1024);
    const rejected = await queueRow(MUTATION_TYPES.CREATE_IDENTITY, {
      email: 'second@example.com',
      htmlSignature: rejectedValue,
      textSignature: rejectedValue,
    });
    await expect(processMutationRow({
      transport: rejectedServer.transport,
      account,
      handlers,
      row: rejected,
    })).resolves.toMatchObject({
      ok: false,
      error: { type: IDENTITY_ERROR.SIGNATURE_TOO_LARGE, terminal: true },
    });
    expect(rejectedServer.setCalls).toBe(0);
  });

  it('retains a bounded raster data URL in the paired signature', async () => {
    const server = identityServer();
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const html = `<div><img src="${dataUrl}" alt=""></div>`;
    const row = await queueRow(MUTATION_TYPES.CREATE_IDENTITY, {
      email: 'image@example.com',
      htmlSignature: html,
      textSignature: '',
    });

    await expect(processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({ ok: true });

    const [cached] = await handlers[DB_RPC.IDENTITY_LIST]({ accountId: account.id });
    expect(cached.html_signature).toContain(dataUrl);
  });

  it('counts the complete data-URL signature at the 2047/2048 boundary', async () => {
    const image = '<img src="data:image/png;base64,AAAA">';
    const acceptedHtml = image + 'x'.repeat(2047 - new TextEncoder().encode(image).byteLength);
    const rejectedHtml = `${acceptedHtml}x`;
    const acceptedServer = identityServer();
    const accepted = await queueRow(MUTATION_TYPES.CREATE_IDENTITY, {
      email: 'data-accepted@example.com',
      htmlSignature: acceptedHtml,
      textSignature: '',
    });

    await expect(processMutationRow({
      transport: acceptedServer.transport,
      account,
      handlers,
      row: accepted,
    })).resolves.toMatchObject({ ok: true });
    expect(acceptedServer.setCalls).toBe(1);

    const rejectedServer = identityServer();
    const rejected = await queueRow(MUTATION_TYPES.CREATE_IDENTITY, {
      email: 'data-rejected@example.com',
      htmlSignature: rejectedHtml,
      textSignature: '',
    });
    await expect(processMutationRow({
      transport: rejectedServer.transport,
      account,
      handlers,
      row: rejected,
    })).resolves.toMatchObject({
      ok: false,
      error: { type: IDENTITY_ERROR.SIGNATURE_TOO_LARGE },
    });
    expect(rejectedServer.setCalls).toBe(0);
  });

  it('recovers exactly one matching create after its response is lost', async () => {
    const transport = new MockTransport();
    const identities: any[] = [];
    let setCalls = 0;
    let durableBeforeSet: any = null;
    transport.handle('Identity/get', (params) => ({
      list: Array.isArray(params.ids)
        ? identities.filter((identity) => params.ids.includes(identity.id))
        : identities,
      state: 'identity-state',
    }));
    transport.handle('Identity/set', async (params) => {
      setCalls += 1;
      durableBeforeSet = await reload(row.id);
      identities.push({
        id: 'recovered-identity',
        ...params.create.identity,
        name: 'Alias',
        email: 'lost@example.com',
        replyTo: [{ name: 'Replies', email: 'reply@example.com' }],
        bcc: [],
        htmlSignature: '<div>FIRST</div>\n  <div>SECOND</div>',
        mayDelete: true,
      });
      return null;
    });
    const row = await queueRow(MUTATION_TYPES.CREATE_IDENTITY, {
      operationId: 'lost-create',
      email: 'Lost@Example.com',
      name: ' Alias ',
      replyTo: [{ name: ' Replies ', email: 'Reply@Example.com' }],
      bcc: null,
      textSignature: 'FIRST\nSECOND',
      htmlSignature: '<div>FIRST</div><div>SECOND</div>',
    });

    await expect(processMutationRow({
      transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({
      ok: true,
      result: {
        ids: ['recovered-identity'],
        identity: { remote_id: 'recovered-identity' },
      },
    });
    expect(setCalls).toBe(1);
    expect(durableBeforeSet.phase).toBe(IDENTITY_PHASE.CREATE_SUBMITTING);
    expect(JSON.parse(durableBeforeSet.server_response_json)).toMatchObject({
      baselineIdentityIds: [],
      requestIdentity: {
        email: 'Lost@Example.com',
        name: ' Alias ',
        replyTo: [{ name: ' Replies ', email: 'Reply@Example.com' }],
        bcc: null,
        textSignature: 'FIRST\nSECOND',
        htmlSignature: '<div>FIRST</div><div>SECOND</div>',
      },
    });
    expect((await reload(row.id)).phase).toBe(SEND_PHASE.CACHE_PENDING);
  });

  it('never replays a lost create when a complete recovery cannot be proven', async () => {
    const transport = new MockTransport();
    const identities: any[] = [];
    let setCalls = 0;
    transport.handle('Identity/get', (params) => ({
      list: Array.isArray(params.ids)
        ? identities.filter((identity) => params.ids.includes(identity.id))
        : identities,
      state: 'identity-state',
      ...(identities.length > 0 ? { hasMore: true } : {}),
    }));
    transport.handle('Identity/set', (params) => {
      setCalls += 1;
      identities.push({
        id: 'unproven-identity',
        name: '',
        ...params.create.identity,
        mayDelete: true,
      });
      return null;
    });
    const row = await queueRow(MUTATION_TYPES.CREATE_IDENTITY, {
      operationId: 'unproven-create',
      email: 'lost@example.com',
    });

    const first = await processMutationRow({
      transport,
      account,
      handlers,
      row,
    });
    expect(first).toMatchObject({
      ok: false,
      error: {
        type: IDENTITY_ERROR.AMBIGUOUS_CREATE,
        terminal: true,
        detail: { reason: 'snapshotIncomplete' },
      },
    });
    const checkpoint = await reload(row.id);
    expect(checkpoint.phase).toBe(IDENTITY_PHASE.CREATE_SUBMITTING);
    await handlers[DB_RPC.QUERY]({
      sql: `UPDATE pending_mutations
               SET local_status = 'conflicted',
                   error_json = ?
             WHERE id = ?`,
      params: [JSON.stringify(first.error), row.id],
    });
    const unchanged = JSON.stringify({
      operationId: 'unproven-create',
      email: 'lost@example.com',
    });
    await expect(handlers[DB_RPC.IDENTITY_MUTATION_ENSURE]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.CREATE_IDENTITY,
      operationId: 'unproven-create',
      requestJson: unchanged,
    })).resolves.toMatchObject({
      id: row.id,
      reused: true,
      errorType: IDENTITY_ERROR.AMBIGUOUS_CREATE,
    });
    expect((await reload(row.id)).local_status).toBe('conflicted');
    expect(setCalls).toBe(1);
  });

  it('retries cache reconciliation without repeating an accepted create', async () => {
    const server = identityServer();
    server.transport.handleError('Identity/get', (params: any) =>
      Array.isArray(params.ids) ? { type: 'serverFail' } : null);
    const row = await queueRow(MUTATION_TYPES.CREATE_IDENTITY, {
      name: 'Alias',
      email: 'alias@example.com',
    });

    const first = await processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    });
    expect(first).toMatchObject({
      ok: false,
      error: {
        type: IDENTITY_ERROR.CACHE_REPAIR_FAILED,
        protocolType: 'cacheReconcileFailed',
        result: { applied: true, cached: false },
      },
    });

    const checkpoint = await reload(row.id);
    expect(checkpoint.phase).toBe(SEND_PHASE.CACHE_PENDING);
    server.transport.clearError('Identity/get');

    await expect(processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row: checkpoint,
    })).resolves.toMatchObject({ ok: true });
    expect(server.transport.requests
      .flatMap((request) => request.methodCalls)
      .filter(([method]) => method === 'Identity/set')).toHaveLength(1);
    expect(await handlers[DB_RPC.IDENTITY_LIST]({ accountId: account.id }))
      .toHaveLength(1);
    const targetedGets = server.transport.requests
      .flatMap((request) => request.methodCalls)
      .filter(([method]) => method === 'Identity/get');
    expect(targetedGets.some(([, params]) => params.ids === undefined)).toBe(true);
    expect(targetedGets.filter(([, params]) => params.ids !== undefined)
      .every(([, params]) =>
        JSON.stringify(params.ids) === JSON.stringify(['identity-1']))).toBe(true);
  });

  it('reattaches Save to a durable cache-only create repair', async () => {
    const server = identityServer();
    server.transport.handleError('Identity/get', (params: any) =>
      Array.isArray(params.ids) ? { type: 'serverFail' } : null);
    const requestJson = JSON.stringify({
      operationId: 'stable-create-operation',
      email: 'alias@example.com',
    });
    const inserted = await handlers[DB_RPC.IDENTITY_MUTATION_ENSURE]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.CREATE_IDENTITY,
      operationId: 'stable-create-operation',
      requestJson,
    });
    const row = await reload(inserted.id);
    await processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    });
    await handlers[DB_RPC.QUERY]({
      sql: `UPDATE pending_mutations
               SET local_status = 'conflicted'
             WHERE id = ?`,
      params: [inserted.id],
    });

    const attached = await handlers[DB_RPC.IDENTITY_MUTATION_ENSURE]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.CREATE_IDENTITY,
      operationId: 'stable-create-operation',
      requestJson: JSON.stringify({
        operationId: 'stable-create-operation',
        email: 'alias@example.com',
        textSignature: 'SECOND',
        htmlSignature: '<div>SECOND</div>',
      }),
    });

    expect(attached).toMatchObject({
      id: inserted.id,
      reused: true,
      requestMatches: false,
      storedRequestJson: requestJson,
    });
    const repairedRow = await reload(inserted.id);
    expect(repairedRow).toMatchObject({
      local_status: 'retry',
      phase: SEND_PHASE.CACHE_PENDING,
    });
    expect(JSON.parse(repairedRow.server_response_json).attempts).toBe(0);
    expect(repairedRow.request_json).toBe(requestJson);
    expect(await handlers[DB_RPC.QUERY]({
      sql: 'SELECT COUNT(*) AS count FROM pending_mutations',
    })).toEqual([{ count: 1 }]);

    server.transport.clearError('Identity/get');
    await expect(processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row: repairedRow,
    })).resolves.toMatchObject({ ok: true });
    expect(server.setCalls).toBe(1);
  });

  it('updates one pre-write durable row instead of inserting a duplicate', async () => {
    const firstRequest = JSON.stringify({
      operationId: 'editable-operation',
      remoteId: 'identity-1',
      textSignature: 'FIRST',
      htmlSignature: '<div>FIRST</div>',
    });
    const secondRequest = JSON.stringify({
      operationId: 'editable-operation',
      remoteId: 'identity-1',
      textSignature: 'SECOND',
      htmlSignature: '<div>SECOND</div>',
    });
    const first = await handlers[DB_RPC.IDENTITY_MUTATION_ENSURE]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.UPDATE_IDENTITY,
      operationId: 'editable-operation',
      requestJson: firstRequest,
    });
    const second = await handlers[DB_RPC.IDENTITY_MUTATION_ENSURE]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.UPDATE_IDENTITY,
      operationId: 'editable-operation',
      requestJson: secondRequest,
    });

    expect(second).toMatchObject({
      id: first.id,
      reused: true,
      requestMatches: true,
      storedRequestJson: secondRequest,
    });
    expect((await reload(first.id)).request_json).toBe(secondRequest);
    expect(await handlers[DB_RPC.QUERY]({
      sql: 'SELECT COUNT(*) AS count FROM pending_mutations',
    })).toEqual([{ count: 1 }]);
  });

  it('returns an older conflicted operation instead of orphaning it', async () => {
    const requestJson = JSON.stringify({
      operationId: 'conflicted-operation',
      remoteId: 'identity-1',
      name: 'Alias',
    });
    const first = await handlers[DB_RPC.IDENTITY_MUTATION_ENSURE]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.UPDATE_IDENTITY,
      operationId: 'conflicted-operation',
      requestJson,
    });
    await handlers[DB_RPC.QUERY]({
      sql: `UPDATE pending_mutations
               SET local_status = 'conflicted',
                   error_json = ?
             WHERE id = ?`,
      params: [
        JSON.stringify({
          type: IDENTITY_ERROR.PERMISSION_DENIED,
          terminal: true,
        }),
        first.id,
      ],
    });

    const reused = await handlers[DB_RPC.IDENTITY_MUTATION_ENSURE]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.UPDATE_IDENTITY,
      operationId: 'conflicted-operation',
      requestJson,
    });

    expect(reused).toMatchObject({
      id: first.id,
      reused: true,
      errorType: IDENTITY_ERROR.PERMISSION_DENIED,
    });
    expect(await handlers[DB_RPC.QUERY]({
      sql: 'SELECT COUNT(*) AS count FROM pending_mutations',
    })).toEqual([{ count: 1 }]);
  });

  it('resumes an unchanged operation after retryable outage attempts are exhausted', async () => {
    await handlers[DB_RPC.IDENTITY_UPSERT_MANY]({
      accountId: account.id,
      identities: [{
        remoteId: 'identity-outage',
        name: 'Before',
        email: 'outage@example.com',
        mayDelete: true,
      }],
    });
    const transport = new MockTransport();
    let outage = true;
    let serverIdentity = {
      id: 'identity-outage',
      name: 'Before',
      email: 'outage@example.com',
      mayDelete: true,
    };
    transport.handleError('Identity/set', () =>
      outage ? { type: 'serverUnavailable' } : null);
    transport.handle('Identity/set', (params) => {
      serverIdentity = {
        ...serverIdentity,
        ...params.update['identity-outage'],
      };
      return { updated: { 'identity-outage': null } };
    });
    transport.handle('Identity/get', () => ({
      list: [serverIdentity],
      state: 'identity-state',
    }));
    const requestJson = JSON.stringify({
      operationId: 'outage-operation',
      remoteId: 'identity-outage',
      name: 'After',
    });
    const inserted = await handlers[DB_RPC.IDENTITY_MUTATION_ENSURE]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.UPDATE_IDENTITY,
      operationId: 'outage-operation',
      requestJson,
    });
    const failed = await processMutationRow({
      transport,
      account,
      handlers,
      row: await reload(inserted.id),
    });
    expect(failed).toMatchObject({
      ok: false,
      error: { type: IDENTITY_ERROR.SERVER_UNAVAILABLE },
    });
    await handlers[DB_RPC.QUERY]({
      sql: `UPDATE pending_mutations
               SET local_status = 'conflicted',
                   attempts = 8,
                   error_json = ?
             WHERE id = ?`,
      params: [JSON.stringify(failed.error), inserted.id],
    });

    const resumed = await handlers[DB_RPC.IDENTITY_MUTATION_ENSURE]({
      accountId: account.id,
      mutationType: MUTATION_TYPES.UPDATE_IDENTITY,
      operationId: 'outage-operation',
      requestJson,
    });
    expect(resumed).toMatchObject({
      id: inserted.id,
      reused: true,
      requestMatches: true,
    });
    expect(await reload(inserted.id)).toMatchObject({
      local_status: 'retry',
      attempts: 0,
      error_json: null,
    });

    outage = false;
    await expect(processMutationRow({
      transport,
      account,
      handlers,
      row: await reload(inserted.id),
    })).resolves.toMatchObject({
      ok: true,
      result: { identity: { name: 'After' } },
    });
  });

  it('does not report success when read-back omits the accepted identity', async () => {
    const transport = new MockTransport();
    transport.handle('Identity/set', () => ({
      created: { identity: { id: 'identity-missing' } },
    }));
    transport.handle('Identity/get', () => ({ list: [], state: 'identity-state' }));
    const row = await queueRow(MUTATION_TYPES.CREATE_IDENTITY, {
      name: 'Alias',
      email: 'alias@example.com',
    });

    await expect(processMutationRow({
      transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({
      ok: false,
      error: {
        type: IDENTITY_ERROR.CACHE_REPAIR_FAILED,
        result: { applied: true, cached: false },
      },
    });
  });

  it.each([
    [
      'E-mail address not configured for this account.',
      IDENTITY_ERROR.ADDRESS_NOT_ALLOWED,
    ],
    [
      'Invalid e-mail address.',
      IDENTITY_ERROR.INVALID_EMAIL,
    ],
  ])('enumerates an Identity email rejection: %s', async (description, errorType) => {
    const rejectedTransport = new MockTransport();
    rejectedTransport.handle('Identity/get', () => ({
      list: [],
      state: 'identity-state',
    }));
    rejectedTransport.handle('Identity/set', () => ({
      notCreated: {
        identity: {
          type: 'invalidProperties',
          description,
          properties: ['email'],
        },
      },
    }));
    const rejectedRow = await queueRow(MUTATION_TYPES.CREATE_IDENTITY, {
      name: 'Alias',
      email: 'not-allowed@example.com',
    });
    const rejected = await processMutationRow({
      transport: rejectedTransport,
      account,
      handlers,
      row: rejectedRow,
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: { type: errorType, terminal: true },
    });
  });

  it.each([
    ['forbiddenFrom', IDENTITY_ERROR.ADDRESS_NOT_CONFIGURED],
    ['overQuota', IDENTITY_ERROR.OVER_QUOTA],
    ['tooLarge', IDENTITY_ERROR.OBJECT_TOO_LARGE],
    ['invalidPatch', IDENTITY_ERROR.INVALID_PATCH],
    ['willDestroy', IDENTITY_ERROR.WILL_DESTROY],
    ['singleton', IDENTITY_ERROR.SINGLETON],
    ['invalidArguments', IDENTITY_ERROR.INVALID_ARGUMENTS],
    ['forbidden', IDENTITY_ERROR.PERMISSION_DENIED],
  ])('terminals the SetError %s immediately', async (protocolType, errorType) => {
    const server = identityServer();
    server.transport.handle('Identity/set', () => ({
      notCreated: { identity: { type: protocolType } },
    }));
    const row = await queueRow(MUTATION_TYPES.CREATE_IDENTITY, {
      operationId: `terminal-${protocolType}`,
      email: 'alias@example.com',
    });

    await expect(processMutationRow({
      transport: server.transport,
      account,
      handlers,
      row,
    })).resolves.toMatchObject({
      ok: false,
      error: {
        type: errorType,
        protocolType,
        terminal: true,
      },
    });
    expect(server.transport.requests
      .flatMap((request) => request.methodCalls)
      .filter(([method]) => method === 'Identity/set')).toHaveLength(1);
  });

  it('parks a missing create response instead of retrying Identity/set', async () => {
    const missingTransport = new MockTransport();
    missingTransport.handle('Identity/set', () => null);
    missingTransport.handle('Identity/get', () => ({
      list: [],
      state: 'identity-state',
    }));
    const missingRow = await queueRow(MUTATION_TYPES.CREATE_IDENTITY, {
      name: 'Alias',
      email: 'alias@example.com',
    });
    const missing = await processMutationRow({
      transport: missingTransport,
      account,
      handlers,
      row: missingRow,
    });
    expect(missing).toMatchObject({
      ok: false,
      error: {
        type: IDENTITY_ERROR.AMBIGUOUS_CREATE,
        protocolType: 'createOutcomeUnknown',
        terminal: true,
      },
    });
    const setCalls = missingTransport.requests
      .flatMap((request) => request.methodCalls)
      .filter(([method]) => method === 'Identity/set');
    expect(setCalls).toHaveLength(1);
  });
});

describe('Identity SetError classification', () => {
  it.each([
    [
      { type: 'invalidProperties', properties: ['/replyTo/0/email'] },
      'update',
      IDENTITY_ERROR.INVALID_REPLY_TO,
    ],
    [
      { type: 'invalidProperties', properties: ['bcc.1.email'] },
      'update',
      IDENTITY_ERROR.INVALID_BCC,
    ],
    [
      {
        type: 'invalidProperties',
        properties: ['htmlSignature'],
        description: 'Value is too large.',
      },
      'update',
      IDENTITY_ERROR.SIGNATURE_TOO_LARGE,
    ],
    [
      { type: 'invalidProperties', properties: ['textSignature'] },
      'update',
      IDENTITY_ERROR.INVALID_SIGNATURE,
    ],
    [
      { type: 'invalidProperties', properties: ['email'] },
      'update',
      IDENTITY_ERROR.IMMUTABLE_FIELD,
    ],
    [
      { type: 'forbidden' },
      'delete',
      IDENTITY_ERROR.PERMISSION_DENIED,
    ],
    [
      { type: 'forbiddenFrom' },
      'create',
      IDENTITY_ERROR.ADDRESS_NOT_CONFIGURED,
    ],
    [
      { type: 'overQuota' },
      'create',
      IDENTITY_ERROR.OVER_QUOTA,
    ],
    [
      { type: 'tooLarge' },
      'update',
      IDENTITY_ERROR.OBJECT_TOO_LARGE,
    ],
    [
      { type: 'invalidPatch' },
      'update',
      IDENTITY_ERROR.INVALID_PATCH,
    ],
    [
      { type: 'willDestroy' },
      'update',
      IDENTITY_ERROR.WILL_DESTROY,
    ],
    [
      { type: 'singleton' },
      'delete',
      IDENTITY_ERROR.SINGLETON,
    ],
    [
      { type: 'invalidArguments' },
      'create',
      IDENTITY_ERROR.INVALID_ARGUMENTS,
    ],
    [
      {
        type: 'invalidProperties',
        properties: ['email'],
        description: 'Address is not configured for this account.',
      },
      'create',
      IDENTITY_ERROR.ADDRESS_NOT_CONFIGURED,
    ],
    [
      { type: 'notFound' },
      'update',
      IDENTITY_ERROR.MISSING,
    ],
    [
      { type: 'serverFail' },
      'create',
      IDENTITY_ERROR.SERVER_UNAVAILABLE,
    ],
    [
      { type: 'invalidProperties', properties: ['x-unknown'] },
      'update',
      IDENTITY_ERROR.UNKNOWN,
    ],
  ] as const)('classifies %j as %s', (reason, operation, expected) => {
    expect(identityErrorType(reason, reason.type, operation)).toBe(expected);
  });
});
