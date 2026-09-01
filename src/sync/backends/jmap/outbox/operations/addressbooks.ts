import { ADDRESSBOOK_ERROR } from '../../../../../constants/addressbook-errors';
import {
  ADDRESSBOOK_PHASE,
  SERVICE_KIND,
} from '../../../../../constants/states';
import { DB_RPC } from '../../../../../db/protocol';
import { wlog } from '../../../../../db/worker-log';
import type {
  AddressBookInventory,
  AddressBookInventoryContact,
} from '../../../../../types/db';
import { hasOwn } from '../../../../../utils/identity-fields';
import {
  ADDRESSBOOK_PROPERTIES,
  inventoryAddressBook,
  syncAddressBooks,
  syncContacts,
  TRUSTED_SENDERS_BOOK_NAME,
} from '../../contacts';
import { callJmap, pickResponse } from '../../invoke';
import {
  CACHE_REPAIR_MAX_ATTEMPTS,
  readMutationCheckpoint,
  saveMutationCheckpoint,
  type MutationCheckpointRead,
} from '../../mutation-checkpoint';
import { errorProperties, hasErrorProperty } from '../../set-error';
import { JMAP_CAPS } from '../../transport';

const ADDRESSBOOK_CREATION_KEY = 'addressbook';
const ADDRESSBOOK_ERROR_TYPES = new Set<string>(Object.values(ADDRESSBOOK_ERROR));

type AddressBookSetOperation = 'create' | 'destroy' | 'update';

interface CanonicalAddressBook {
  id?: string;
  name: string;
  description: string | null;
  sortOrder: number;
  isSubscribed: boolean;
}

interface AddressBookCheckpoint {
  version: 1;
  operation: AddressBookSetOperation;
  remoteId?: string;
  attempts?: number;
  baselineAddressBooks?: CanonicalAddressBook[];
  baselineState?: string | null;
  requestAddressBook?: CanonicalAddressBook;
  confirmationInventory?: AddressBookInventory;
}

class AddressBookOperationError extends Error {
  type: string;
  detail?: unknown;

  constructor(type: string, message: string, detail?: unknown) {
    super(message);
    this.type = type;
    this.detail = detail;
  }
}

function localFailure(
  type: string,
  detail: Record<string, unknown> = {},
  terminal = true,
) {
  return {
    ok: false,
    error: {
      type,
      protocolType: 'clientValidation',
      detail,
      ...(terminal ? { terminal: true } : {}),
    },
  };
}

export function addressBookErrorType(
  reason: any,
  fallbackType: string,
  operation: AddressBookSetOperation,
  touchesSubscription = false,
): string {
  const protocolType = reason?.type ?? fallbackType;
  const properties = errorProperties(reason);
  const description = String(reason?.description ?? '').toLowerCase();
  if (protocolType === 'invalidProperties') {
    if (hasErrorProperty(properties, 'name') || description.includes('name')) {
      return ADDRESSBOOK_ERROR.INVALID_NAME;
    }
    if (
      hasErrorProperty(properties, 'isSubscribed')
      || description.includes('subscrib')
    ) {
      return ADDRESSBOOK_ERROR.UNSUPPORTED_SUBSCRIPTION;
    }
    return ADDRESSBOOK_ERROR.INVALID_ARGUMENTS;
  }
  switch (protocolType) {
    case 'accountNotFound':
    case 'accountNotSupportedByMethod':
    case 'accountReadOnly':
    case 'forbidden':
      return operation === 'update' && touchesSubscription
        ? ADDRESSBOOK_ERROR.UNSUPPORTED_SUBSCRIPTION
        : ADDRESSBOOK_ERROR.PERMISSION_DENIED;
    case 'stateMismatch':
      return ADDRESSBOOK_ERROR.STATE_MISMATCH;
    case 'notFound':
      return ADDRESSBOOK_ERROR.MISSING;
    case 'rateLimit':
    case 'serverFail':
    case 'serverPartialFail':
    case 'serverUnavailable':
    case 'noResponse':
      return ADDRESSBOOK_ERROR.SERVER_UNAVAILABLE;
    default:
      return ADDRESSBOOK_ERROR.SERVER_UNAVAILABLE;
  }
}

function setFailure(
  reason: any,
  fallbackType: string,
  operation: AddressBookSetOperation,
  touchesSubscription = false,
) {
  const protocolType = reason?.type ?? fallbackType;
  const type = addressBookErrorType(
    reason,
    fallbackType,
    operation,
    touchesSubscription,
  );
  const retryable = type === ADDRESSBOOK_ERROR.SERVER_UNAVAILABLE;
  return {
    ok: false,
    error: {
      type,
      protocolType,
      ...(reason ? { detail: reason } : {}),
      ...(!retryable ? { terminal: true } : {}),
    },
  };
}

function caughtFailure(error: any) {
  if (
    error instanceof AddressBookOperationError
    || (
      typeof error?.type === 'string'
      && ADDRESSBOOK_ERROR_TYPES.has(error.type)
    )
  ) {
    return {
      ok: false,
      error: {
        type: error.type,
        protocolType: 'addressBookReadFailed',
        message: error.message,
        ...(error.detail === undefined ? {} : { detail: error.detail }),
        ...(error.type === ADDRESSBOOK_ERROR.SERVER_UNAVAILABLE
          ? {}
          : { terminal: true }),
      },
    };
  }
  return {
    ok: false,
    error: {
      type: ADDRESSBOOK_ERROR.SERVER_UNAVAILABLE,
      protocolType: 'transport',
      message: error?.message ?? String(error),
    },
  };
}

function canonicalText(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFC').replace(/\r\n?/gu, '\n')
    : '';
}

function canonicalName(value: unknown): string {
  return canonicalText(value).trim();
}

function canonicalDescription(value: unknown): string | null {
  return value == null ? null : canonicalText(value);
}

function canonicalBook(book: any): CanonicalAddressBook {
  return {
    ...(typeof book?.id === 'string' ? { id: book.id } : {}),
    name: canonicalName(book?.name),
    description: canonicalDescription(book?.description),
    sortOrder: Number.isSafeInteger(book?.sortOrder) && book.sortOrder >= 0
      ? Number(book.sortOrder)
      : 0,
    isSubscribed: book?.isSubscribed !== false,
  };
}

function canonicalCachedBook(book: any): CanonicalAddressBook {
  return {
    id: String(book.remote_id),
    name: canonicalName(book.name),
    description: canonicalDescription(book.description),
    sortOrder: Number.isSafeInteger(book.sort_order) && book.sort_order >= 0
      ? Number(book.sort_order)
      : 0,
    isSubscribed: Number(book.is_subscribed) !== 0,
  };
}

function prepareCreate(request: any) {
  const name = canonicalName(request?.name);
  if (!name || /[\r\n]/u.test(request?.name)) {
    return {
      failure: localFailure(ADDRESSBOOK_ERROR.INVALID_NAME, { properties: ['name'] }),
      payload: null,
    };
  }
  if (hasOwn(request, 'description')
      && request.description !== null
      && typeof request.description !== 'string') {
    return {
      failure: localFailure(
        ADDRESSBOOK_ERROR.INVALID_ARGUMENTS,
        { properties: ['description'] },
      ),
      payload: null,
    };
  }
  if (hasOwn(request, 'sortOrder')
      && (!Number.isSafeInteger(request.sortOrder)
        || request.sortOrder < 0)) {
    return {
      failure: localFailure(
        ADDRESSBOOK_ERROR.INVALID_ARGUMENTS,
        { properties: ['sortOrder'] },
      ),
      payload: null,
    };
  }
  if (hasOwn(request, 'isSubscribed')
      && typeof request.isSubscribed !== 'boolean') {
    return {
      failure: localFailure(
        ADDRESSBOOK_ERROR.INVALID_ARGUMENTS,
        { properties: ['isSubscribed'] },
      ),
      payload: null,
    };
  }
  if (hasOwn(request, 'setAsDefault')
      && typeof request.setAsDefault !== 'boolean') {
    return {
      failure: localFailure(
        ADDRESSBOOK_ERROR.INVALID_ARGUMENTS,
        { properties: ['setAsDefault'] },
      ),
      payload: null,
    };
  }
  return {
    failure: null,
    payload: {
      name,
      description: canonicalDescription(request.description),
      sortOrder: hasOwn(request, 'sortOrder') ? Number(request.sortOrder) : 0,
      isSubscribed: hasOwn(request, 'isSubscribed')
        ? request.isSubscribed
        : true,
    } as CanonicalAddressBook,
  };
}

function prepareUpdate(request: any) {
  const patch: Record<string, unknown> = {};
  if (hasOwn(request, 'name')) {
    const name = canonicalName(request.name);
    if (!name || /[\r\n]/u.test(request.name)) {
      return {
        failure: localFailure(
          ADDRESSBOOK_ERROR.INVALID_NAME,
          { properties: ['name'] },
        ),
        patch: null,
      };
    }
    patch.name = name;
  }
  if (hasOwn(request, 'description')) {
    if (request.description !== null && typeof request.description !== 'string') {
      return {
        failure: localFailure(
          ADDRESSBOOK_ERROR.INVALID_ARGUMENTS,
          { properties: ['description'] },
        ),
        patch: null,
      };
    }
    patch.description = canonicalDescription(request.description);
  }
  if (hasOwn(request, 'sortOrder')) {
    if (!Number.isSafeInteger(request.sortOrder)
        || request.sortOrder < 0) {
      return {
        failure: localFailure(
          ADDRESSBOOK_ERROR.INVALID_ARGUMENTS,
          { properties: ['sortOrder'] },
        ),
        patch: null,
      };
    }
    patch.sortOrder = Number(request.sortOrder);
  }
  if (hasOwn(request, 'isSubscribed')) {
    if (typeof request.isSubscribed !== 'boolean') {
      return {
        failure: localFailure(
          ADDRESSBOOK_ERROR.INVALID_ARGUMENTS,
          { properties: ['isSubscribed'] },
        ),
        patch: null,
      };
    }
    patch.isSubscribed = request.isSubscribed;
  }
  if (hasOwn(request, 'setAsDefault')
      && typeof request.setAsDefault !== 'boolean') {
    return {
      failure: localFailure(
        ADDRESSBOOK_ERROR.INVALID_ARGUMENTS,
        { properties: ['setAsDefault'] },
      ),
      patch: null,
    };
  }
  if (Object.keys(patch).length === 0 && request?.setAsDefault !== true) {
    return {
      failure: localFailure(ADDRESSBOOK_ERROR.INVALID_ARGUMENTS, {
        reason: 'emptyUpdate',
      }),
      patch: null,
    };
  }
  return { failure: null, patch };
}

function addressBookAccountCapability(transport: any, account: any): any {
  const capabilities = transport?.session?.accounts
    ?.[account.remote_account_id]?.accountCapabilities;
  if (!capabilities || !Object.hasOwn(capabilities, JMAP_CAPS.CONTACTS)) {
    return null;
  }
  const capability = capabilities[JMAP_CAPS.CONTACTS];
  return capability && typeof capability === 'object' ? capability : {};
}

async function fetchAddressBooks({
  transport,
  account,
  useWebSocket,
}: any): Promise<{ list: any[]; state: string | null }> {
  let result;
  try {
    result = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
      methodCalls: [[
        'AddressBook/get',
        {
          accountId: account.remote_account_id,
          properties: ADDRESSBOOK_PROPERTIES,
        },
        'abget',
      ]],
      useWebSocket,
    });
  } catch (error: any) {
    throw new AddressBookOperationError(
      ADDRESSBOOK_ERROR.SERVER_UNAVAILABLE,
      error?.message ?? String(error),
    );
  }
  const response = pickResponse(result, 'AddressBook/get');
  if (!response || !Array.isArray(response.list)) {
    const methodError = pickResponse(result, 'error');
    throw new AddressBookOperationError(
      addressBookErrorType(methodError, 'noResponse', 'update'),
      'AddressBook/get did not return a complete snapshot',
      methodError ?? undefined,
    );
  }
  if (typeof response.state !== 'string' || !response.state) {
    throw new AddressBookOperationError(
      ADDRESSBOOK_ERROR.SERVER_UNAVAILABLE,
      'AddressBook/get did not return a stable state',
    );
  }
  const ids = new Set<string>();
  if (response.list.some((book: any) => {
    if (typeof book?.id !== 'string' || !book.id || ids.has(book.id)) return true;
    ids.add(book.id);
    return false;
  })) {
    throw new AddressBookOperationError(
      ADDRESSBOOK_ERROR.SERVER_UNAVAILABLE,
      'AddressBook/get returned invalid or duplicate ids',
    );
  }
  return {
    list: response.list,
    state: response.state,
  };
}

async function resolveRemoteId(
  handlers: any,
  accountId: number,
  request: any,
): Promise<string | null> {
  if (typeof request?.remoteId === 'string' && request.remoteId) {
    return request.remoteId;
  }
  if (!Number.isSafeInteger(request?.addressbookId) || request.addressbookId <= 0) {
    return null;
  }
  const rows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT remote_id
            FROM addressbooks
           WHERE id = ?
             AND account_id = ?
             AND service_kind = ?
             AND is_deleted = 0
           LIMIT 1`,
    params: [request.addressbookId, accountId, SERVICE_KIND.JMAP_CONTACTS],
  });
  return typeof rows[0]?.remote_id === 'string' && rows[0].remote_id
    ? rows[0].remote_id
    : null;
}

function parseCheckpoint(
  row: any,
): MutationCheckpointRead<AddressBookCheckpoint> {
  return readMutationCheckpoint(row, (value: any) => {
    const checkpoint = value?.addressBook;
    if (checkpoint?.version !== 1) return null;
    if (!['create', 'update', 'destroy'].includes(checkpoint.operation)) return null;
    return checkpoint as AddressBookCheckpoint;
  });
}

function validCanonicalAddressBook(
  value: unknown,
  requireId: boolean,
): value is CanonicalAddressBook {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const book = value as Record<string, unknown>;
  return (!requireId || (typeof book.id === 'string' && book.id.length > 0))
    && typeof book.name === 'string'
    && book.name.length > 0
    && (book.description === null || typeof book.description === 'string')
    && Number.isSafeInteger(book.sortOrder)
    && Number(book.sortOrder) >= 0
    && typeof book.isSubscribed === 'boolean';
}

function parseCreateCheckpoint(
  row: any,
): MutationCheckpointRead<AddressBookCheckpoint> {
  const result = parseCheckpoint(row);
  if (result.status !== 'valid') return result;
  const checkpoint = result.checkpoint;
  if (
    checkpoint.operation !== 'create'
    || !Array.isArray(checkpoint.baselineAddressBooks)
    || !checkpoint.baselineAddressBooks.every((book) =>
      validCanonicalAddressBook(book, true))
    || !validCanonicalAddressBook(checkpoint.requestAddressBook, false)
  ) {
    return { status: 'invalid' };
  }
  return result;
}

async function savePhase(
  handlers: any,
  rowId: number,
  phase: string | null,
  checkpoint: AddressBookCheckpoint | null,
) {
  await saveMutationCheckpoint({
    handlers,
    rowId,
    phase,
    checkpoint: checkpoint ? { addressBook: checkpoint } : null,
  });
}

function appliedWrite(row: any): AddressBookCheckpoint | null {
  if (row?.phase !== ADDRESSBOOK_PHASE.CACHE_PENDING) return null;
  const result = parseCheckpoint(row);
  if (
    result.status !== 'valid'
    || typeof result.checkpoint.remoteId !== 'string'
    || !result.checkpoint.remoteId
  ) {
    return null;
  }
  return result.checkpoint;
}

async function reconcileAcceptedWrite({
  transport,
  account,
  handlers,
  row,
  operation,
  remoteId,
  attempts,
  useWebSocket,
}: any) {
  const attempting = attempts + 1;
  await savePhase(
    handlers,
    row.id,
    ADDRESSBOOK_PHASE.CACHE_PENDING,
    {
      version: 1,
      operation,
      remoteId,
      attempts: attempting,
    },
  );
  try {
    const addressBooks = await syncAddressBooks({
      transport,
      account,
      handlers,
      useWebSocket,
    });
    if (!addressBooks.complete) {
      throw new Error('AddressBook/get reconciliation was incomplete');
    }
    if (operation === 'destroy') {
      const contacts = await syncContacts({
        transport,
        account,
        handlers,
        useWebSocket,
      });
      if (contacts.unstable || contacts.needsFullSync) {
        throw new Error('ContactCard reconciliation was incomplete');
      }
    }
    const list = await handlers[DB_RPC.ADDRESSBOOK_LIST]({
      accountId: account.id,
    });
    const addressbook = list.find(
      (book: any) => book.remote_id === remoteId,
    ) ?? null;
    if (operation === 'destroy' ? addressbook !== null : addressbook === null) {
      throw new Error(
        operation === 'destroy'
          ? 'Destroyed address book is still present after reconciliation'
          : 'Address book is missing after reconciliation',
      );
    }
    return {
      ok: true,
      result: {
        ids: [remoteId],
        addressbooks: list,
        addressbook,
      },
    };
  } catch (error: any) {
    wlog.warn(
      'jmap-outbox',
      `address book write applied but cache reconciliation failed: ${
        error?.message ?? error
      }`,
    );
    return {
      ok: false,
      error: {
        type: ADDRESSBOOK_ERROR.CACHE_REPAIR_FAILED,
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

function ambiguousCreateFailure(detail: Record<string, unknown>) {
  return {
    ok: false,
    error: {
      type: ADDRESSBOOK_ERROR.AMBIGUOUS_CREATE,
      protocolType: 'createOutcomeUnknown',
      detail,
      terminal: true,
    },
  };
}

async function recoverCreate({
  transport,
  account,
  handlers,
  row,
  checkpoint,
  useWebSocket,
}: any) {
  try {
    const reconciled = await syncAddressBooks({
      transport,
      account,
      handlers,
      useWebSocket,
    });
    if (!reconciled.complete) {
      return ambiguousCreateFailure({ reason: 'snapshotIncomplete' });
    }
  } catch (error: any) {
    return ambiguousCreateFailure({
      reason: 'snapshotIncomplete',
      message: error?.message ?? String(error),
    });
  }
  const baselineIds = new Set(
    checkpoint.baselineAddressBooks.map((book: CanonicalAddressBook) => book.id),
  );
  const expected = JSON.stringify(checkpoint.requestAddressBook);
  const books = await handlers[DB_RPC.ADDRESSBOOK_LIST]({
    accountId: account.id,
  });
  const matches = books.filter((book: any) => {
    const canonical = canonicalCachedBook(book);
    const { id, ...fields } = canonical;
    return !baselineIds.has(id) && JSON.stringify(fields) === expected;
  });
  if (matches.length !== 1) {
    return ambiguousCreateFailure({
      reason: matches.length === 0 ? 'noUniqueMatch' : 'multipleMatches',
      candidateIds: matches.map((book: any) => book.remote_id),
    });
  }
  return reconcileAcceptedWrite({
    transport,
    account,
    handlers,
    row,
    operation: 'create',
    remoteId: matches[0].remote_id,
    attempts: 0,
    useWebSocket,
  });
}

export async function runCreateAddressBook(args: any) {
  const applied = appliedWrite(args.row);
  if (args.row?.phase === ADDRESSBOOK_PHASE.CACHE_PENDING) {
    if (applied?.operation !== 'create') {
      return ambiguousCreateFailure({
        reason: 'unreadableCheckpoint',
        phase: args.row.phase,
      });
    }
    return reconcileAcceptedWrite({
      ...args,
      operation: 'create',
      remoteId: applied.remoteId,
      attempts: applied.attempts ?? 0,
    });
  }
  const checkpointRead = parseCreateCheckpoint(args.row);
  if (args.row?.phase === ADDRESSBOOK_PHASE.CREATE_SUBMITTING) {
    if (checkpointRead.status !== 'valid') {
      return ambiguousCreateFailure({ reason: 'unreadableCheckpoint' });
    }
    return recoverCreate({ ...args, checkpoint: checkpointRead.checkpoint });
  }
  if (args.row?.phase !== null || checkpointRead.status !== 'absent') {
    return ambiguousCreateFailure({
      reason: 'unreadableCheckpoint',
      phase: args.row?.phase ?? null,
    });
  }

  const capability = addressBookAccountCapability(args.transport, args.account);
  if (capability?.mayCreateAddressBook !== true) {
    return localFailure(ADDRESSBOOK_ERROR.PERMISSION_DENIED, {
      capability: 'mayCreateAddressBook',
    });
  }
  const prepared = prepareCreate(args.request);
  if (prepared.failure) return prepared.failure;

  let baseline;
  try {
    baseline = await fetchAddressBooks(args);
  } catch (error) {
    return caughtFailure(error);
  }
  const checkpoint: AddressBookCheckpoint = {
    version: 1,
    operation: 'create',
    baselineAddressBooks: baseline.list.map(canonicalBook),
    baselineState: baseline.state,
    requestAddressBook: prepared.payload,
  };
  await savePhase(
    args.handlers,
    args.row.id,
    ADDRESSBOOK_PHASE.CREATE_SUBMITTING,
    checkpoint,
  );

  let result;
  try {
    result = await callJmap(args.transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
      methodCalls: [[
        'AddressBook/set',
        {
          accountId: args.account.remote_account_id,
          ...(baseline.state ? { ifInState: baseline.state } : {}),
          create: {
            [ADDRESSBOOK_CREATION_KEY]: prepared.payload,
          },
          ...(args.request?.setAsDefault === true
            ? { onSuccessSetIsDefault: `#${ADDRESSBOOK_CREATION_KEY}` }
            : {}),
        },
        'abset',
      ]],
      useWebSocket: args.useWebSocket,
    });
  } catch {
    return recoverCreate({ ...args, checkpoint });
  }
  const response = pickResponse(result, 'AddressBook/set');
  if (!response) {
    const methodError = pickResponse(result, 'error');
    if (methodError && methodError.type !== 'serverPartialFail') {
      await savePhase(args.handlers, args.row.id, null, null);
      return setFailure(methodError, methodError.type, 'create');
    }
    return recoverCreate({ ...args, checkpoint });
  }
  if (response.notCreated?.[ADDRESSBOOK_CREATION_KEY]) {
    await savePhase(args.handlers, args.row.id, null, null);
    return setFailure(
      response.notCreated[ADDRESSBOOK_CREATION_KEY],
      'notCreated',
      'create',
    );
  }
  const remoteId = response.created?.[ADDRESSBOOK_CREATION_KEY]?.id;
  if (typeof remoteId !== 'string' || !remoteId) {
    return recoverCreate({ ...args, checkpoint });
  }
  return reconcileAcceptedWrite({
    ...args,
    operation: 'create',
    remoteId,
    attempts: 0,
  });
}

export async function runUpdateAddressBook(args: any) {
  const applied = appliedWrite(args.row);
  if (applied?.operation === 'update') {
    return reconcileAcceptedWrite({
      ...args,
      operation: 'update',
      remoteId: applied.remoteId,
      attempts: applied.attempts ?? 0,
    });
  }
  const prepared = prepareUpdate(args.request);
  if (prepared.failure) return prepared.failure;
  const remoteId = await resolveRemoteId(
    args.handlers,
    args.account.id,
    args.request,
  );
  if (!remoteId) {
    return localFailure(ADDRESSBOOK_ERROR.MISSING, { properties: ['remoteId'] });
  }

  let snapshot;
  try {
    snapshot = await fetchAddressBooks(args);
  } catch (error) {
    return caughtFailure(error);
  }
  const current = snapshot.list.find((book: any) => book.id === remoteId);
  if (!current) return localFailure(ADDRESSBOOK_ERROR.MISSING, { remoteId });
  if (current.myRights?.mayWrite !== true) {
    return localFailure(ADDRESSBOOK_ERROR.PERMISSION_DENIED, {
      remoteId,
      property: 'myRights.mayWrite',
    });
  }

  let result;
  try {
    result = await callJmap(args.transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
      methodCalls: [[
        'AddressBook/set',
        {
          accountId: args.account.remote_account_id,
          ...(snapshot.state ? { ifInState: snapshot.state } : {}),
          update: { [remoteId]: prepared.patch },
          ...(args.request?.setAsDefault === true
            ? { onSuccessSetIsDefault: remoteId }
            : {}),
        },
        'abset',
      ]],
      useWebSocket: args.useWebSocket,
    });
  } catch (error: any) {
    return setFailure(
      { type: 'noResponse', description: error?.message ?? String(error) },
      'noResponse',
      'update',
      hasOwn(args.request, 'isSubscribed'),
    );
  }
  const response = pickResponse(result, 'AddressBook/set');
  if (!response) {
    const methodError = pickResponse(result, 'error');
    return setFailure(
      methodError,
      methodError?.type ?? 'noResponse',
      'update',
      hasOwn(args.request, 'isSubscribed'),
    );
  }
  if (response.notUpdated?.[remoteId]) {
    return setFailure(
      response.notUpdated[remoteId],
      'notUpdated',
      'update',
      hasOwn(args.request, 'isSubscribed'),
    );
  }
  if (!response.updated || !Object.hasOwn(response.updated, remoteId)) {
    return setFailure(null, 'noResponse', 'update');
  }
  return reconcileAcceptedWrite({
    ...args,
    operation: 'update',
    remoteId,
    attempts: 0,
  });
}

function normalizeConfirmation(
  value: any,
  remoteId: string,
): AddressBookInventory | null {
  if (
    value?.version !== 1
    || value.addressBookRemoteId !== remoteId
    || typeof value.queryState !== 'string'
    || !value.queryState
    || !Array.isArray(value.contacts)
  ) {
    return null;
  }
  const seen = new Set<string>();
  const contacts: AddressBookInventoryContact[] = [];
  for (const contact of value.contacts) {
    if (
      typeof contact?.remoteId !== 'string'
      || !contact.remoteId
      || seen.has(contact.remoteId)
      || !Array.isArray(contact.addressBookIds)
      || contact.addressBookIds.some(
        (id: unknown) => typeof id !== 'string' || !id,
      )
      || !['exclusive', 'shared'].includes(contact.classification)
      || typeof contact.hasMedia !== 'boolean'
    ) {
      return null;
    }
    const ids = [...new Set<string>(contact.addressBookIds)];
    const expectedClassification = ids.length === 1 ? 'exclusive' : 'shared';
    if (
      !ids.includes(remoteId)
      || contact.classification !== expectedClassification
    ) {
      return null;
    }
    seen.add(contact.remoteId);
    contacts.push({
      remoteId: contact.remoteId,
      addressBookIds: ids.sort(),
      classification: expectedClassification,
      hasMedia: contact.hasMedia,
    });
  }
  const exclusiveCount = contacts.filter(
    (contact) => contact.classification === 'exclusive',
  ).length;
  const sharedCount = contacts.length - exclusiveCount;
  const mediaBearingCount = contacts.filter((contact) => contact.hasMedia).length;
  if (
    value.total !== contacts.length
    || value.exclusiveCount !== exclusiveCount
    || value.sharedCount !== sharedCount
    || value.mediaBearingCount !== mediaBearingCount
  ) {
    return null;
  }
  contacts.sort((left, right) => left.remoteId.localeCompare(right.remoteId));
  return {
    version: 1,
    addressbookId: Number.isSafeInteger(value.addressbookId)
      ? Number(value.addressbookId)
      : null,
    addressBookRemoteId: remoteId,
    queryState: value.queryState,
    total: contacts.length,
    exclusiveCount,
    sharedCount,
    mediaBearingCount,
    contacts,
  };
}

function isNotMoreDestructive(
  confirmed: AddressBookInventory,
  current: AddressBookInventory,
): boolean {
  const confirmedById = new Map(
    confirmed.contacts.map((contact) => [contact.remoteId, contact]),
  );
  return current.contacts.every((contact) => {
    const prior = confirmedById.get(contact.remoteId);
    if (!prior) return false;
    if (
      contact.classification === 'exclusive'
      && prior.classification !== 'exclusive'
    ) {
      return false;
    }
    return !(
      contact.classification === 'exclusive'
      && contact.hasMedia
      && !prior.hasMedia
    );
  });
}

function isTrustedSendersBook(book: any): boolean {
  return canonicalName(book?.name).toLocaleLowerCase()
    === TRUSTED_SENDERS_BOOK_NAME.toLocaleLowerCase();
}

async function checkDestroy({
  transport,
  account,
  handlers,
  remoteId,
  confirmation,
  useWebSocket,
}: any) {
  let snapshot;
  try {
    snapshot = await fetchAddressBooks({
      transport,
      account,
      useWebSocket,
    });
  } catch (error) {
    return { failure: caughtFailure(error), absent: false };
  }
  const current = snapshot.list.find((book: any) => book.id === remoteId);
  if (!current) return { failure: null, absent: true };
  if (current.myRights?.mayDelete !== true) {
    return {
      failure: localFailure(ADDRESSBOOK_ERROR.PERMISSION_DENIED, {
        remoteId,
        property: 'myRights.mayDelete',
      }),
      absent: false,
    };
  }
  if (isTrustedSendersBook(current)) {
    return {
      failure: localFailure(ADDRESSBOOK_ERROR.PROTECTED, {
        remoteId,
        reason: 'trustedSenders',
      }),
      absent: false,
    };
  }
  const remainingPersonalBooks = snapshot.list.filter(
    (book: any) => !isTrustedSendersBook(book),
  );
  if (remainingPersonalBooks.length <= 1) {
    return {
      failure: localFailure(ADDRESSBOOK_ERROR.LAST_ADDRESSBOOK, { remoteId }),
      absent: false,
    };
  }

  let inventory;
  try {
    inventory = await inventoryAddressBook({
      transport,
      account,
      handlers,
      remoteId,
      useWebSocket,
    });
  } catch (error) {
    return { failure: caughtFailure(error), absent: false };
  }
  if (!isNotMoreDestructive(confirmation, inventory)) {
    return {
      failure: localFailure(ADDRESSBOOK_ERROR.CONFIRMATION_STALE, {
        remoteId,
        confirmed: {
          exclusiveCount: confirmation.exclusiveCount,
          sharedCount: confirmation.sharedCount,
          mediaBearingCount: confirmation.mediaBearingCount,
        },
        current: {
          exclusiveCount: inventory.exclusiveCount,
          sharedCount: inventory.sharedCount,
          mediaBearingCount: inventory.mediaBearingCount,
        },
      }),
      absent: false,
    };
  }
  return {
    failure: null,
    absent: false,
    snapshot,
    inventory,
  };
}

export async function runDestroyAddressBook(args: any) {
  const applied = appliedWrite(args.row);
  if (applied?.operation === 'destroy') {
    return reconcileAcceptedWrite({
      ...args,
      operation: 'destroy',
      remoteId: applied.remoteId,
      attempts: applied.attempts ?? 0,
    });
  }

  const recovering = args.row?.phase === ADDRESSBOOK_PHASE.DESTROY_SUBMITTING;
  const checkpointResult = recovering ? parseCheckpoint(args.row) : null;
  const checkpoint = checkpointResult?.status === 'valid'
    ? checkpointResult.checkpoint
    : null;
  const remoteId = recovering
    ? checkpoint?.remoteId ?? null
    : await resolveRemoteId(args.handlers, args.account.id, args.request);
  if (!remoteId) {
    return localFailure(
      recovering
        ? ADDRESSBOOK_ERROR.SERVER_UNAVAILABLE
        : ADDRESSBOOK_ERROR.MISSING,
      { reason: recovering ? 'unreadableCheckpoint' : 'missingRemoteId' },
    );
  }
  const confirmation = normalizeConfirmation(
    recovering
      ? checkpoint?.confirmationInventory
      : args.request?.confirmationInventory,
    remoteId,
  );
  if (!confirmation) {
    return localFailure(ADDRESSBOOK_ERROR.CONFIRMATION_REQUIRED, { remoteId });
  }

  const checked = await checkDestroy({
    ...args,
    remoteId,
    confirmation,
  });
  if (checked.absent) {
    if (!recovering) {
      return localFailure(ADDRESSBOOK_ERROR.MISSING, { remoteId });
    }
    return reconcileAcceptedWrite({
      ...args,
      operation: 'destroy',
      remoteId,
      attempts: 0,
    });
  }
  if (checked.failure) return checked.failure;

  const destroyCheckpoint: AddressBookCheckpoint = {
    version: 1,
    operation: 'destroy',
    remoteId,
    confirmationInventory: confirmation,
  };
  await savePhase(
    args.handlers,
    args.row.id,
    ADDRESSBOOK_PHASE.DESTROY_SUBMITTING,
    destroyCheckpoint,
  );

  let result;
  try {
    result = await callJmap(args.transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.CONTACTS],
      methodCalls: [[
        'AddressBook/set',
        {
          accountId: args.account.remote_account_id,
          ...(checked.snapshot.state
            ? { ifInState: checked.snapshot.state }
            : {}),
          destroy: [remoteId],
          onDestroyRemoveContents: true,
        },
        'abset',
      ]],
      useWebSocket: args.useWebSocket,
    });
  } catch (error: any) {
    return setFailure(
      { type: 'noResponse', description: error?.message ?? String(error) },
      'noResponse',
      'destroy',
    );
  }
  const response = pickResponse(result, 'AddressBook/set');
  if (!response) {
    const methodError = pickResponse(result, 'error');
    return setFailure(
      methodError,
      methodError?.type ?? 'noResponse',
      'destroy',
    );
  }
  if ((response.destroyed ?? []).includes(remoteId)) {
    return reconcileAcceptedWrite({
      ...args,
      operation: 'destroy',
      remoteId,
      attempts: 0,
    });
  }
  const rejection = response.notDestroyed?.[remoteId];
  if (rejection?.type === 'notFound') {
    return reconcileAcceptedWrite({
      ...args,
      operation: 'destroy',
      remoteId,
      attempts: 0,
    });
  }
  return setFailure(rejection, rejection?.type ?? 'noResponse', 'destroy');
}
