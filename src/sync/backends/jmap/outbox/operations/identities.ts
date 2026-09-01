import {
  IDENTITY_PHASE,
  MUTATION_TYPE,
  SEND_PHASE,
} from '../../../../../constants/states';
import { IDENTITY_ERROR } from '../../../../../constants/identity-errors';
import { DB_RPC } from '../../../../../db/protocol';
import { wlog } from '../../../../../db/worker-log';
import {
  cleanIdentityAddresses,
  hasOwn,
  parseIdentityMailbox,
  pickIdentityMutableFields,
  validateIdentitySignatures,
} from '../../../../../utils/identity-fields';
import { syncIdentities, syncIdentityById } from '../../identities';
import { callJmap, pickResponse } from '../../invoke';
import {
  CACHE_REPAIR_MAX_ATTEMPTS,
  readMutationCheckpoint,
  saveMutationCheckpoint,
  type MutationCheckpointRead,
} from '../../mutation-checkpoint';
import { errorProperties, hasErrorProperty } from '../../set-error';
import { JMAP_CAPS } from '../../transport';

const RETRYABLE_SET_ERRORS = new Set([
  'noResponse',
  'rateLimit',
  'serverFail',
  'serverUnavailable',
  'stateMismatch',
]);

type IdentitySetOperation = 'create' | 'delete' | 'update';

interface IdentityCreateCheckpoint {
  baselineIdentityIds: string[];
  requestIdentity: Record<string, unknown>;
}

function descriptionMentions(description: string, ...terms: string[]): boolean {
  return terms.some((term) => description.includes(term));
}

export function identityErrorType(
  reason: any,
  fallbackType: string,
  operation: IdentitySetOperation,
): string {
  const protocolType = reason?.type ?? fallbackType;
  const description = String(reason?.description ?? '').toLowerCase();
  if (protocolType === 'invalidProperties') {
    const properties = errorProperties(reason);
    if (hasErrorProperty(properties, 'replyTo')) {
      return IDENTITY_ERROR.INVALID_REPLY_TO;
    }
    if (hasErrorProperty(properties, 'bcc')) {
      return IDENTITY_ERROR.INVALID_BCC;
    }
    if (
      hasErrorProperty(properties, 'htmlSignature')
      || hasErrorProperty(properties, 'textSignature')
    ) {
      return descriptionMentions(description, 'too large', 'too long', '2048', '2,048', 'size')
        ? IDENTITY_ERROR.SIGNATURE_TOO_LARGE
        : IDENTITY_ERROR.INVALID_SIGNATURE;
    }
    if (
      hasErrorProperty(properties, 'id')
      || hasErrorProperty(properties, 'mayDelete')
      || (operation === 'update' && hasErrorProperty(properties, 'email'))
    ) {
      return IDENTITY_ERROR.IMMUTABLE_FIELD;
    }
    if (hasErrorProperty(properties, 'email')) {
      if (
        descriptionMentions(description, 'not configured', 'not allowed', 'not permitted')
        && descriptionMentions(description, 'account', 'address')
      ) {
        return IDENTITY_ERROR.ADDRESS_NOT_CONFIGURED;
      }
      return IDENTITY_ERROR.INVALID_EMAIL;
    }
    if (hasErrorProperty(properties, 'name')) return IDENTITY_ERROR.INVALID_NAME;

    if (descriptionMentions(description, 'reply-to', 'replyto')) {
      return IDENTITY_ERROR.INVALID_REPLY_TO;
    }
    if (description.includes('bcc')) return IDENTITY_ERROR.INVALID_BCC;
    if (description.includes('signature')) {
      return descriptionMentions(description, 'too large', 'too long', '2048', '2,048', 'size')
        ? IDENTITY_ERROR.SIGNATURE_TOO_LARGE
        : IDENTITY_ERROR.INVALID_SIGNATURE;
    }
    if (descriptionMentions(description, 'immutable', 'read-only', 'read only')) {
      return IDENTITY_ERROR.IMMUTABLE_FIELD;
    }
    return IDENTITY_ERROR.UNKNOWN;
  }
  switch (protocolType) {
    case 'accountNotFound':
    case 'accountNotSupportedByMethod':
    case 'accountReadOnly':
    case 'forbidden':
      return IDENTITY_ERROR.PERMISSION_DENIED;
    case 'forbiddenFrom':
      return IDENTITY_ERROR.ADDRESS_NOT_CONFIGURED;
    case 'overQuota':
      return IDENTITY_ERROR.OVER_QUOTA;
    case 'tooLarge':
      return IDENTITY_ERROR.OBJECT_TOO_LARGE;
    case 'invalidPatch':
      return IDENTITY_ERROR.INVALID_PATCH;
    case 'willDestroy':
      return IDENTITY_ERROR.WILL_DESTROY;
    case 'singleton':
      return IDENTITY_ERROR.SINGLETON;
    case 'invalidArguments':
      return IDENTITY_ERROR.INVALID_ARGUMENTS;
    case 'notFound':
      return IDENTITY_ERROR.MISSING;
    case 'rateLimit':
    case 'serverFail':
    case 'serverUnavailable':
    case 'noResponse':
      return IDENTITY_ERROR.SERVER_UNAVAILABLE;
    default:
      return IDENTITY_ERROR.UNKNOWN;
  }
}

function setFailure(
  reason: any,
  fallbackType: string,
  operation: IdentitySetOperation,
) {
  const protocolType = reason?.type ?? fallbackType;
  const type = identityErrorType(reason, fallbackType, operation);
  return {
    ok: false,
    error: {
      type,
      protocolType,
      ...(reason ? { detail: reason } : {}),
      ...(!RETRYABLE_SET_ERRORS.has(protocolType) ? { terminal: true } : {}),
    },
  };
}

function localFailure(type: string, detail: Record<string, unknown>) {
  return {
    ok: false,
    error: {
      type,
      protocolType: 'clientValidation',
      detail,
      terminal: true,
    },
  };
}

function missingSetResponse(result: any, operation: IdentitySetOperation) {
  return setFailure(pickResponse(result, 'error'), 'noResponse', operation);
}

function mutableSetPayload(
  request: Record<string, unknown>,
  operation: Exclude<IdentitySetOperation, 'delete'>,
) {
  const forbidden = operation === 'create'
    ? ['id', 'mayDelete', 'remoteId']
    : ['id', 'mayDelete', 'email'];
  const immutable = forbidden.filter((property) => hasOwn(request, property));
  if (immutable.length > 0) {
    return {
      failure: localFailure(IDENTITY_ERROR.IMMUTABLE_FIELD, {
        properties: immutable,
      }),
      payload: null,
    };
  }
  if (
    hasOwn(request, 'name')
    && typeof request.name !== 'string'
  ) {
    return {
      failure: localFailure(IDENTITY_ERROR.INVALID_NAME, { properties: ['name'] }),
      payload: null,
    };
  }

  const payload = pickIdentityMutableFields(request);
  for (const [property, error] of [
    ['replyTo', IDENTITY_ERROR.INVALID_REPLY_TO],
    ['bcc', IDENTITY_ERROR.INVALID_BCC],
  ] as const) {
    if (!hasOwn(request, property)) continue;
    const addresses = cleanIdentityAddresses(request[property] as any);
    if (addresses === undefined) {
      return {
        failure: localFailure(error, { properties: [property] }),
        payload: null,
      };
    }
    Object.assign(payload, { [property]: addresses });
  }

  const signatureIssue = validateIdentitySignatures(
    hasOwn(request, 'htmlSignature') ? request.htmlSignature : undefined,
    hasOwn(request, 'textSignature') ? request.textSignature : undefined,
  );
  if (signatureIssue) {
    return {
      failure: localFailure(
        signatureIssue === 'too-large'
          ? IDENTITY_ERROR.SIGNATURE_TOO_LARGE
          : IDENTITY_ERROR.INVALID_SIGNATURE,
        { properties: ['htmlSignature', 'textSignature'] },
      ),
      payload: null,
    };
  }
  return { failure: null, payload };
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

function createIdentityPayload(request: Record<string, unknown>) {
  const email = typeof request.email === 'string'
    ? parseIdentityMailbox(request.email)
    : null;
  if (!email) {
    return {
      failure: localFailure(IDENTITY_ERROR.INVALID_EMAIL, { properties: ['email'] }),
      payload: null,
    };
  }
  const prepared = mutableSetPayload(request, 'create');
  if (prepared.failure) return { failure: prepared.failure, payload: null };
  return {
    failure: null,
    payload: {
      email,
      ...prepared.payload,
    },
  };
}

async function submitIdentityCreate({
  transport,
  account,
  payload,
  useWebSocket,
}: any) {
  const result = await identitySet({
    transport,
    account,
    create: {
      identity: payload,
    },
    useWebSocket,
  });
  const response = pickResponse(result, 'Identity/set');
  if (!response) {
    const methodError = pickResponse(result, 'error');
    return methodError && methodError.type !== 'serverPartialFail'
      ? { ...setFailure(methodError, methodError.type, 'create'), definitive: true }
      : { ok: false, ambiguous: true };
  }
  if (response.notCreated?.identity) {
    return {
      ...setFailure(response.notCreated.identity, 'notCreated', 'create'),
      definitive: true,
    };
  }
  const remoteId = response.created?.identity?.id;
  return typeof remoteId === 'string' && remoteId
    ? { ok: true, remoteId }
    : { ok: false, ambiguous: true };
}

async function updateIdentity({ transport, account, request, useWebSocket }: any) {
  const remoteId = request.remoteId;
  if (typeof remoteId !== 'string' || !remoteId) {
    return localFailure(IDENTITY_ERROR.MISSING, { properties: ['remoteId'] });
  }
  const prepared = mutableSetPayload(request, 'update');
  if (prepared.failure) return prepared.failure;
  const result = await identitySet({
    transport,
    account,
    update: {
      [remoteId]: prepared.payload,
    },
    useWebSocket,
  });
  const response = pickResponse(result, 'Identity/set');
  if (!response) return missingSetResponse(result, 'update');
  if (response.notUpdated?.[remoteId]) {
    return setFailure(response.notUpdated[remoteId], 'notUpdated', 'update');
  }
  return response.updated && remoteId in response.updated
    ? { ok: true, remoteId }
    : setFailure(null, 'noResponse', 'update');
}

async function deleteIdentity({
  transport,
  account,
  handlers,
  request,
  useWebSocket,
}: any) {
  const remoteId = request.remoteId;
  if (typeof remoteId !== 'string' || !remoteId) {
    return localFailure(IDENTITY_ERROR.MISSING, { properties: ['remoteId'] });
  }
  let cached = await handlers[DB_RPC.IDENTITY_GET_BY_REMOTE]({
    accountId: account.id,
    remoteId,
  });
  if (!cached) {
    try {
      cached = await syncIdentityById({
        transport,
        account,
        handlers,
        remoteId,
        useWebSocket,
      });
    } catch (error: any) {
      if (String(error?.message ?? '').includes('did not return')) {
        return localFailure(IDENTITY_ERROR.MISSING, { remoteId });
      }
      return {
        ok: false,
        error: {
          type: IDENTITY_ERROR.SERVER_UNAVAILABLE,
          protocolType: 'identityLookupFailed',
          message: error?.message ?? String(error),
        },
      };
    }
  }
  if (cached.may_delete !== 1) {
    return localFailure(IDENTITY_ERROR.PERMISSION_DENIED, {
      properties: ['mayDelete'],
    });
  }
  const result = await identitySet({
    transport,
    account,
    destroy: [remoteId],
    useWebSocket,
  });
  const response = pickResponse(result, 'Identity/set');
  if (!response) return missingSetResponse(result, 'delete');
  if ((response.destroyed ?? []).includes(remoteId)) return { ok: true, remoteId };
  const rejection = response.notDestroyed?.[remoteId];
  if (rejection?.type === 'notFound') return { ok: true, remoteId };
  return rejection
    ? setFailure(rejection, 'notDestroyed', 'delete')
    : setFailure(null, 'noResponse', 'delete');
}

function appliedWrite(row: any): { remoteId: string; attempts: number } | null {
  if (row?.phase !== SEND_PHASE.CACHE_PENDING) return null;
  const result = readMutationCheckpoint(row, (checkpoint: any) => {
    if (typeof checkpoint?.identityRemoteId !== 'string') return null;
    return {
      remoteId: checkpoint.identityRemoteId,
      attempts: Number.isInteger(checkpoint.attempts) ? checkpoint.attempts : 0,
    };
  });
  return result.status === 'valid' ? result.checkpoint : null;
}

function pendingCreateCheckpoint(
  row: any,
): MutationCheckpointRead<IdentityCreateCheckpoint> {
  return readMutationCheckpoint(row, (checkpoint: any) => {
    if (
      !Array.isArray(checkpoint?.baselineIdentityIds)
      || !checkpoint.baselineIdentityIds.every(
        (id: unknown) => typeof id === 'string' && id.length > 0,
      )
      || new Set(checkpoint.baselineIdentityIds).size
        !== checkpoint.baselineIdentityIds.length
      || !checkpoint.requestIdentity
      || typeof checkpoint.requestIdentity !== 'object'
      || Array.isArray(checkpoint.requestIdentity)
      || typeof checkpoint.requestIdentity.email !== 'string'
      || checkpoint.requestIdentity.email.length === 0
    ) {
      return null;
    }
    return checkpoint as IdentityCreateCheckpoint;
  });
}

function identityMatchesCreateRequest(
  identity: any,
  request: Record<string, unknown>,
): boolean {
  const canonicalMailbox = (value: unknown) =>
    typeof value === 'string' ? value.trim().toLowerCase() : '';
  const canonicalName = (value: unknown) =>
    typeof value === 'string'
      ? value.normalize('NFC').trim().replace(/\s+/gu, ' ')
      : '';
  const canonicalAddresses = (value: unknown) => {
    if (value == null) return [];
    const addresses = cleanIdentityAddresses(value as any);
    if (!addresses) return null;
    return addresses.map((address) => ({
      name: canonicalName(address.name),
      email: canonicalMailbox(address.email),
    }));
  };
  const canonicalTextSignature = (value: unknown) =>
    typeof value === 'string'
      ? value.normalize('NFC').replace(/\r\n?/gu, '\n')
      : '';
  const canonicalHtmlSignature = (value: unknown) => {
    if (typeof value !== 'string') return '';
    return value
      .normalize('NFC')
      .replace(/\r\n?/gu, '\n')
      .replace(/<!--[\s\S]*?-->/gu, '')
      .replace(/>\s+</gu, '><')
      .replace(/<br\s*\/?>/giu, '<br>')
      .trim();
  };

  if (canonicalMailbox(identity?.email) !== canonicalMailbox(request.email)) {
    return false;
  }
  const comparisons: Record<string, [unknown, unknown]> = {
    name: [canonicalName(identity.name), canonicalName(request.name)],
    replyTo: [
      canonicalAddresses(identity.reply_to),
      canonicalAddresses(request.replyTo),
    ],
    bcc: [canonicalAddresses(identity.bcc), canonicalAddresses(request.bcc)],
    textSignature: [
      canonicalTextSignature(identity.text_signature),
      canonicalTextSignature(request.textSignature),
    ],
    htmlSignature: [
      canonicalHtmlSignature(identity.html_signature),
      canonicalHtmlSignature(request.htmlSignature),
    ],
  };
  return Object.entries(comparisons).every(([key, [actual, expected]]) =>
    !hasOwn(request, key)
    || JSON.stringify(actual) === JSON.stringify(expected));
}

function ambiguousCreateFailure(detail: Record<string, unknown>) {
  return {
    ok: false,
    error: {
      type: IDENTITY_ERROR.AMBIGUOUS_CREATE,
      protocolType: 'createOutcomeUnknown',
      detail,
      terminal: true,
    },
  };
}

async function recoverAmbiguousCreate({
  transport,
  account,
  handlers,
  row,
  checkpoint,
  useWebSocket,
}: any) {
  try {
    await syncIdentities({
      transport,
      account,
      handlers,
      useWebSocket,
      requireSnapshot: true,
    });
  } catch (error: any) {
    return ambiguousCreateFailure({
      reason: 'snapshotIncomplete',
      message: error?.message ?? String(error),
    });
  }
  const baseline = new Set(checkpoint.baselineIdentityIds);
  const identities = await handlers[DB_RPC.IDENTITY_LIST]({ accountId: account.id });
  const matches = identities.filter((identity: any) =>
    !baseline.has(identity.remote_id)
    && identityMatchesCreateRequest(identity, checkpoint.requestIdentity));
  if (matches.length !== 1) {
    return ambiguousCreateFailure({
      reason: matches.length === 0 ? 'noUniqueMatch' : 'multipleMatches',
      candidateIds: matches.map((identity: any) => identity.remote_id),
    });
  }
  return reconcileWrite({
    transport,
    account,
    handlers,
    row,
    remoteId: matches[0].remote_id,
    attempts: 0,
    useWebSocket,
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
  await saveMutationCheckpoint({
    handlers,
    rowId: row.id,
    phase: SEND_PHASE.CACHE_PENDING,
    checkpoint: { identityRemoteId: remoteId, attempts: attempting },
  });
  try {
    let identity = null;
    if (row.mutation_type === MUTATION_TYPE.DELETE_IDENTITY) {
      await handlers[DB_RPC.IDENTITY_DELETE_LOCAL]({
        accountId: account.id,
        remoteId,
      });
    } else {
      identity = await syncIdentityById({
        transport,
        account,
        handlers,
        remoteId,
        useWebSocket,
      });
    }
    return {
      ok: true,
      result: {
        ids: [remoteId],
        ...(identity ? { identity } : {}),
      },
    };
  } catch (error: any) {
    wlog.warn(
      'jmap-outbox',
      `identity write applied but the cache did not follow: ${error?.message ?? error}`,
    );
    return {
      ok: false,
      error: {
        type: IDENTITY_ERROR.CACHE_REPAIR_FAILED,
        protocolType: 'cacheReconcileFailed',
        message: error?.message ?? String(error),
        ...(attempting >= CACHE_REPAIR_MAX_ATTEMPTS ? { terminal: true } : {}),
        result: {
          applied: true,
          cached: false,
          ids: [remoteId],
        },
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

async function runCreateIdentitySafely(args: any) {
  const applied = appliedWrite(args.row);
  if (args.row.phase === SEND_PHASE.CACHE_PENDING) {
    if (!applied) {
      return ambiguousCreateFailure({
        reason: 'unreadableCheckpoint',
        phase: args.row.phase,
      });
    }
    return reconcileWrite({
      ...args,
      remoteId: applied.remoteId,
      attempts: applied.attempts,
    });
  }

  const recorded = pendingCreateCheckpoint(args.row);
  if (args.row.phase === IDENTITY_PHASE.CREATE_SUBMITTING) {
    return recorded.status === 'valid'
      ? recoverAmbiguousCreate({ ...args, checkpoint: recorded.checkpoint })
      : ambiguousCreateFailure({ reason: 'unreadableCheckpoint' });
  }
  if (args.row.phase !== null || recorded.status !== 'absent') {
    return ambiguousCreateFailure({
      reason: 'unreadableCheckpoint',
      phase: args.row.phase ?? null,
    });
  }

  const prepared = createIdentityPayload(args.request);
  if (prepared.failure) return prepared.failure;
  let baselineRows;
  try {
    await syncIdentities({
      transport: args.transport,
      account: args.account,
      handlers: args.handlers,
      useWebSocket: args.useWebSocket,
      requireSnapshot: true,
    });
    baselineRows = await args.handlers[DB_RPC.IDENTITY_LIST]({
      accountId: args.account.id,
    });
  } catch (error: any) {
    return {
      ok: false,
      error: {
        type: IDENTITY_ERROR.SERVER_UNAVAILABLE,
        protocolType: 'identityBaselineFailed',
        message: error?.message ?? String(error),
      },
    };
  }
  const checkpoint = {
    baselineIdentityIds: baselineRows.map((identity: any) => identity.remote_id),
    requestIdentity: prepared.payload,
  };
  await saveMutationCheckpoint({
    handlers: args.handlers,
    rowId: args.row.id,
    phase: IDENTITY_PHASE.CREATE_SUBMITTING,
    checkpoint,
  });

  let created;
  try {
    created = await submitIdentityCreate({ ...args, payload: prepared.payload });
  } catch {
    return recoverAmbiguousCreate({ ...args, checkpoint });
  }
  if (!created.ok) {
    if (created.definitive) {
      await saveMutationCheckpoint({
        handlers: args.handlers,
        rowId: args.row.id,
        phase: null,
        checkpoint: null,
      });
      return created;
    }
    return recoverAmbiguousCreate({ ...args, checkpoint });
  }
  return reconcileWrite({
    ...args,
    remoteId: created.remoteId,
    attempts: 0,
  });
}

export function runCreateIdentity(args: any) {
  return runCreateIdentitySafely(args);
}

export function runUpdateIdentity(args: any) {
  return runIdentityWrite(args, updateIdentity);
}

export function runDeleteIdentity(args: any) {
  return runIdentityWrite(args, deleteIdentity);
}
