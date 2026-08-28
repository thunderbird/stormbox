import { MUTATION_TYPE, SEND_PHASE } from '../../../../../constants/states';
import { IDENTITY_ERROR } from '../../../../../constants/identity-errors';
import { DB_RPC } from '../../../../../db/protocol';
import { wlog } from '../../../../../db/worker-log';
import { syncIdentities } from '../../identities';
import { callJmap, pickResponse } from '../../invoke';
import { JMAP_CAPS } from '../../transport';

const CACHE_RECONCILE_MAX_ATTEMPTS = 3;
const TERMINAL_SET_ERRORS = new Set([
  'accountNotFound',
  'accountNotSupportedByMethod',
  'accountReadOnly',
  'forbidden',
  'invalidArguments',
  'invalidProperties',
  'notFound',
  'unknownMethod',
]);

function identityErrorType(reason: any, fallbackType: string): string {
  const protocolType = reason?.type ?? fallbackType;
  const emailProperty = Array.isArray(reason?.properties)
    && reason.properties.includes('email');
  const description = String(reason?.description ?? '').toLowerCase();
  if (protocolType === 'invalidProperties' && emailProperty) {
    if (description.includes('not configured for') && description.includes('account')) {
      return IDENTITY_ERROR.ADDRESS_NOT_ALLOWED;
    }
    if (description.includes('invalid e-mail address')
      || description.includes('invalid email address')) {
      return IDENTITY_ERROR.INVALID_EMAIL;
    }
  }
  return protocolType;
}

function setFailure(reason: any, fallbackType: string) {
  const protocolType = reason?.type ?? fallbackType;
  const type = identityErrorType(reason, fallbackType);
  return {
    ok: false,
    error: {
      type,
      ...(reason ? { detail: reason } : {}),
      ...(TERMINAL_SET_ERRORS.has(protocolType) ? { terminal: true } : {}),
    },
  };
}

function missingSetResponse(result: any) {
  return setFailure(pickResponse(result, 'error'), 'noResponse');
}

async function identitySet({
  transport,
  account,
  create,
  update,
  destroy,
  useWebSocket,
}: any) {
  return callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.SUBMISSION],
    methodCalls: [[
      'Identity/set',
      {
        accountId: account.remote_account_id,
        ...(create ? { create } : {}),
        ...(update ? { update } : {}),
        ...(destroy ? { destroy } : {}),
      },
      'identity-set',
    ]],
    useWebSocket,
  });
}

async function createIdentity({ transport, account, request, useWebSocket }: any) {
  const result = await identitySet({
    transport,
    account,
    create: {
      identity: {
        name: request.name ?? '',
        email: request.email,
      },
    },
    useWebSocket,
  });
  const response = pickResponse(result, 'Identity/set');
  if (!response) return missingSetResponse(result);
  if (response.notCreated?.identity) {
    return setFailure(response.notCreated.identity, 'notCreated');
  }
  const remoteId = response.created?.identity?.id;
  return typeof remoteId === 'string' && remoteId
    ? { ok: true, remoteId }
    : setFailure(null, 'noResponse');
}

async function updateIdentity({ transport, account, request, useWebSocket }: any) {
  const remoteId = request.remoteId;
  const result = await identitySet({
    transport,
    account,
    update: {
      [remoteId]: {
        name: request.name ?? '',
      },
    },
    useWebSocket,
  });
  const response = pickResponse(result, 'Identity/set');
  if (!response) return missingSetResponse(result);
  if (response.notUpdated?.[remoteId]) {
    return setFailure(response.notUpdated[remoteId], 'notUpdated');
  }
  return response.updated && remoteId in response.updated
    ? { ok: true, remoteId }
    : setFailure(null, 'noResponse');
}

async function deleteIdentity({ transport, account, request, useWebSocket }: any) {
  const remoteId = request.remoteId;
  const result = await identitySet({
    transport,
    account,
    destroy: [remoteId],
    useWebSocket,
  });
  const response = pickResponse(result, 'Identity/set');
  if (!response) return missingSetResponse(result);
  if ((response.destroyed ?? []).includes(remoteId)) return { ok: true, remoteId };
  const rejection = response.notDestroyed?.[remoteId];
  if (rejection?.type === 'notFound') return { ok: true, remoteId };
  return rejection
    ? setFailure(rejection, 'notDestroyed')
    : setFailure(null, 'noResponse');
}

function appliedWrite(row: any): { remoteId: string; attempts: number } | null {
  if (row?.phase !== SEND_PHASE.CACHE_PENDING) return null;
  try {
    const checkpoint = JSON.parse(row.server_response_json ?? 'null');
    if (typeof checkpoint?.identityRemoteId !== 'string') return null;
    return {
      remoteId: checkpoint.identityRemoteId,
      attempts: Number.isInteger(checkpoint.attempts) ? checkpoint.attempts : 0,
    };
  } catch {
    return null;
  }
}

function checkpointWrite({
  handlers,
  row,
  remoteId,
  attempts,
}: any) {
  return handlers[DB_RPC.QUERY]({
    sql: `UPDATE pending_mutations
             SET phase = ?, server_response_json = ?, updated_at = ?
           WHERE id = ?`,
    params: [
      SEND_PHASE.CACHE_PENDING,
      JSON.stringify({ identityRemoteId: remoteId, attempts }),
      Date.now(),
      row.id,
    ],
  });
}

async function reconcileWrite({
  transport,
  account,
  handlers,
  row,
  remoteId,
  attempts,
  useWebSocket,
}: any) {
  const attempting = attempts + 1;
  await checkpointWrite({
    handlers, row, remoteId, attempts: attempting,
  });
  try {
    await syncIdentities({
      transport,
      account,
      handlers,
      useWebSocket,
      requireSnapshot: true,
    });
    const cached = await handlers[DB_RPC.IDENTITY_LIST]({ accountId: account.id });
    const reconciled = cached.find((identity: any) => identity.remote_id === remoteId);
    if (row.mutation_type === MUTATION_TYPE.DELETE_IDENTITY) {
      if (reconciled) throw new Error('Deleted identity remains in the authoritative snapshot');
    } else if (!reconciled) {
      throw new Error('Identity write is missing from the authoritative snapshot');
    }
    return { ok: true };
  } catch (error: any) {
    wlog.warn(
      'jmap-outbox',
      `identity write applied but the cache did not follow: ${error?.message ?? error}`,
    );
    return {
      ok: false,
      error: {
        type: 'cacheReconcileFailed',
        message: error?.message ?? String(error),
        ...(attempting >= CACHE_RECONCILE_MAX_ATTEMPTS ? { terminal: true } : {}),
        result: { applied: true, cached: false },
      },
    };
  }
}

async function runIdentityWrite(args: any, write: (args: any) => Promise<any>) {
  const applied = appliedWrite(args.row);
  let remoteId = applied?.remoteId;
  if (!applied) {
    const result = await write(args);
    if (!result.ok) return result;
    remoteId = result.remoteId;
  }
  return reconcileWrite({
    ...args,
    remoteId,
    attempts: applied?.attempts ?? 0,
  });
}

export function runCreateIdentity(args: any) {
  return runIdentityWrite(args, createIdentity);
}

export function runUpdateIdentity(args: any) {
  return runIdentityWrite(args, updateIdentity);
}

export function runDeleteIdentity(args: any) {
  return runIdentityWrite(args, deleteIdentity);
}
