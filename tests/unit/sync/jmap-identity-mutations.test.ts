import {
  afterEach, beforeEach, describe, expect, it,
} from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { IDENTITY_ERROR } from '../../../src/constants/identity-errors';
import { SEND_PHASE } from '../../../src/constants/states';
import {
  MUTATION_TYPES,
  processMutationRow,
} from '../../../src/sync/backends/jmap/outbox';
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
  transport.handle('Identity/set', (params) => {
    setCalls += 1;
    if (params.create) {
      identities.push({
        id: 'identity-1',
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
  transport.handle('Identity/get', () => ({
    list: identities,
    state: 'identity-state',
  }));
  return {
    transport,
    get setCalls() {
      return setCalls;
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

  it('retries cache reconciliation without repeating an accepted create', async () => {
    const server = identityServer();
    server.transport.handleError('Identity/get', { type: 'serverFail' });
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
        type: 'cacheReconcileFailed',
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
    expect(server.setCalls).toBe(1);
    expect(await handlers[DB_RPC.IDENTITY_LIST]({ accountId: account.id }))
      .toHaveLength(1);
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
        type: 'cacheReconcileFailed',
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

  it('retries a missing method response', async () => {
    const missingTransport = new MockTransport();
    missingTransport.handle('Identity/set', () => null);
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
      error: { type: 'noResponse' },
    });
    expect(missing.error?.terminal).not.toBe(true);
  });
});
