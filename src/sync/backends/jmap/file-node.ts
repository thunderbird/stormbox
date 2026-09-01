/**
 * Reusable transport for owned JSON documents stored as JMAP FileNodes.
 */

import type { JmapFileNode } from '../../../types/jmap';
import { callJmap, pickResponse, pickResponseById } from './invoke';
import { JMAP_CAPS } from './transport';

const FILE_NODE_PROPERTIES = [
  'id',
  'name',
  'parentId',
  'blobId',
  'type',
  'size',
  'myRights',
];

export const THUNDERMAIL_FILE_NODE_FOLDER = 'thundermail';
export const CONTACTS_TRASH_FILE_NODE_FOLDER = 'contacts_trash';

export interface JsonDocumentMarker {
  owner: string;
  documentType: string;
  version: number;
}

export type FileNodeDocumentErrorType =
  | 'unsupported'
  | 'accountNotFound'
  | 'accountNotSupportedByMethod'
  | 'accountReadOnly'
  | 'stateMismatch'
  | 'alreadyExists'
  | 'notFound'
  | 'forbidden'
  | 'invalidDocument'
  | 'invalidArguments'
  | 'invalidResultReference'
  | 'invalidProperties'
  | 'invalidPatch'
  | 'unknownMethod'
  | 'overQuota'
  | 'tooLarge'
  | 'requestTooLarge'
  | 'tooManyObjectsInSet'
  | 'cannotCalculateChanges'
  | 'anchorNotFound'
  | 'unsupportedFilter'
  | 'unsupportedSort'
  | 'tooManyChanges'
  | 'willDestroy'
  | 'singleton'
  | 'rateLimit'
  | 'serverUnavailable'
  | 'serverPartialFail'
  | 'noResponse'
  | 'authenticationFailed'
  | 'authorizationFailed'
  | 'other'
  | 'serverFail'
  | 'transport';

export interface FileNodeDocumentError {
  type: FileNodeDocumentErrorType;
  message?: string;
  detail?: unknown;
  terminal?: boolean;
}

export type FileNodeDocumentRead<T> =
  | {
    ok: true;
    status: 'missing';
    state: string;
    node: null;
  }
  | {
    ok: true;
    status: 'found';
    state: string;
    node: JmapFileNode;
    document: T;
  }
  | {
    ok: false;
    error: FileNodeDocumentError;
  };

export type FileNodeDocumentWrite =
  | { ok: true; nodeId: string; blobId: string; state: string | null }
  | { ok: false; error: FileNodeDocumentError };

export type FileNodeCollectionRead =
  | { ok: true; state: string; nodes: JmapFileNode[] }
  | { ok: false; error: FileNodeDocumentError };

export type FileNodeFolderRead =
  | { ok: true; state: string; node: JmapFileNode }
  | { ok: false; error: FileNodeDocumentError };

interface FileNodeAccount {
  remote_account_id: string;
}

interface FileNodeTransport {
  session?: any;
  request: (using: string[], methodCalls: any[]) => Promise<any>;
  wsRequest: (using: string[], methodCalls: any[]) => Promise<any>;
  upload: (input: { accountId: string; type: string; body: string }) => Promise<any>;
  download: (input: {
    accountId: string;
    blobId: string;
    type: string;
    name: string;
    maxBytes?: number;
  }) => Promise<Uint8Array>;
}

export function fileNodeAccountCapability(
  transport: Pick<FileNodeTransport, 'session'>,
  account: FileNodeAccount,
): Record<string, unknown> | null {
  const accountCapabilities = transport.session?.accounts
    ?.[account.remote_account_id]?.accountCapabilities;
  if (!accountCapabilities || !Object.hasOwn(accountCapabilities, JMAP_CAPS.FILENODE)) {
    return null;
  }
  const capability = accountCapabilities[JMAP_CAPS.FILENODE];
  return capability && typeof capability === 'object'
    ? capability as Record<string, unknown>
    : {};
}

export function hasFileNodeCapability(
  transport: Pick<FileNodeTransport, 'session'>,
  account: FileNodeAccount,
): boolean {
  return fileNodeAccountCapability(transport, account) != null;
}

function methodError(result: any, callId: string): unknown {
  return pickResponseById(result, 'error', callId);
}

const RETRYABLE_FILE_NODE_ERROR_TYPES = new Set<FileNodeDocumentErrorType>([
  'authenticationFailed',
  'noResponse',
  'rateLimit',
  'serverFail',
  'serverUnavailable',
  'stateMismatch',
  'transport',
]);

const FILE_NODE_WRITE_CONFLICT_TYPES = new Set<FileNodeDocumentErrorType>([
  'alreadyExists',
  'notFound',
  'stateMismatch',
]);

const TYPED_FILE_NODE_ERROR_TYPES = new Set<FileNodeDocumentErrorType>([
  'unsupported',
  'accountNotFound',
  'accountNotSupportedByMethod',
  'accountReadOnly',
  'stateMismatch',
  'alreadyExists',
  'notFound',
  'forbidden',
  'invalidDocument',
  'invalidArguments',
  'invalidResultReference',
  'invalidProperties',
  'invalidPatch',
  'unknownMethod',
  'overQuota',
  'tooLarge',
  'requestTooLarge',
  'tooManyObjectsInSet',
  'cannotCalculateChanges',
  'anchorNotFound',
  'unsupportedFilter',
  'unsupportedSort',
  'tooManyChanges',
  'willDestroy',
  'singleton',
  'rateLimit',
  'serverUnavailable',
  'serverPartialFail',
  'noResponse',
  'authenticationFailed',
  'authorizationFailed',
  'other',
  'serverFail',
  'transport',
]);

export function isRetryableFileNodeDocumentError(
  error: Pick<FileNodeDocumentError, 'type'>,
): boolean {
  return RETRYABLE_FILE_NODE_ERROR_TYPES.has(error.type);
}

export function isFileNodeWriteConflictError(
  error: Pick<FileNodeDocumentError, 'type'>,
): boolean {
  return FILE_NODE_WRITE_CONFLICT_TYPES.has(error.type);
}

export async function retryFileNodeWrite<
  T extends { ok: true } | { ok: false; error: FileNodeDocumentError },
>(
  write: () => Promise<T>,
): Promise<T> {
  let result = await write();
  for (let attempt = 1; attempt < 3 && result.ok === false; attempt += 1) {
    if (!isFileNodeWriteConflictError(result.error)) return result;
    result = await write();
  }
  return result;
}

function typedError(detail: any, fallback: FileNodeDocumentErrorType): FileNodeDocumentError {
  const reportedType = detail?.type;
  const type = TYPED_FILE_NODE_ERROR_TYPES.has(reportedType)
    ? reportedType as FileNodeDocumentErrorType
    : (typeof reportedType === 'string' ? 'other' : fallback);
  return {
    type,
    message: detail?.description ?? detail?.message,
    detail,
    ...(!isRetryableFileNodeDocumentError({ type }) ? { terminal: true } : {}),
  };
}

function transportError(error: any): FileNodeDocumentError {
  if (error?.status === 401) {
    return { type: 'authenticationFailed', message: error?.message };
  }
  if (error?.status === 403) {
    return { type: 'forbidden', message: error?.message, terminal: true };
  }
  if (error?.status === 404) {
    return { type: 'notFound', message: error?.message, terminal: true };
  }
  if (error?.status === 413) {
    return { type: 'tooLarge', message: error?.message, terminal: true };
  }
  if (error?.status === 429) return { type: 'rateLimit', message: error?.message };
  if (error?.status === 503) return { type: 'serverUnavailable', message: error?.message };
  return { type: 'transport', message: error?.message ?? String(error) };
}

function markerMatches(value: unknown, marker: JsonDocumentMarker): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const document = value as Record<string, unknown>;
  return document.owner === marker.owner
    && document.documentType === marker.documentType
    && document.version === marker.version;
}

function mayReadNode(node: JmapFileNode): boolean {
  return node.myRights?.mayRead !== false;
}

function mayModifyNode(node: JmapFileNode): boolean {
  const rights = node.myRights;
  if (!rights) return true;
  if (rights.mayWrite === false) return false;
  if (rights.mayModifyContent === false) return false;
  return true;
}

function fileNodeGetLimit(transport: FileNodeTransport): number {
  const configured = Number(
    transport.session?.capabilities?.[JMAP_CAPS.CORE]?.maxObjectsInGet,
  );
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 500;
}

function fileNodeSetLimit(transport: FileNodeTransport): number {
  const configured = Number(
    transport.session?.capabilities?.[JMAP_CAPS.CORE]?.maxObjectsInSet,
  );
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 500;
}

export type FileNodeFolderLookup =
  | { ok: true; status: 'found'; state: string; node: JmapFileNode }
  | { ok: true; status: 'missing'; state: string; node: null }
  | { ok: false; error: FileNodeDocumentError };

export async function findFileNodeFolder({
  transport,
  account,
  name,
  parentId,
  useWebSocket,
}: {
  transport: FileNodeTransport;
  account: FileNodeAccount;
  name: string;
  parentId: string | null;
  useWebSocket: boolean;
}): Promise<FileNodeFolderLookup> {
  const limit = fileNodeGetLimit(transport);
  let result;
  try {
    result = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.FILENODE],
      methodCalls: [
        ['FileNode/query', {
          accountId: account.remote_account_id,
          filter: { name },
          limit,
          calculateTotal: true,
        }, 'folder-query'],
        ['FileNode/get', {
          accountId: account.remote_account_id,
          '#ids': {
            resultOf: 'folder-query',
            name: 'FileNode/query',
            path: '/ids',
          },
          properties: FILE_NODE_PROPERTIES,
        }, 'folder-get'],
      ],
      useWebSocket,
    });
  } catch (error) {
    return { ok: false, error: transportError(error) };
  }
  const queryFailure = methodError(result, 'folder-query');
  if (queryFailure) return { ok: false, error: typedError(queryFailure, 'serverFail') };
  const getFailure = methodError(result, 'folder-get');
  if (getFailure) return { ok: false, error: typedError(getFailure, 'serverFail') };
  const query = pickResponseById(result, 'FileNode/query', 'folder-query');
  const get = pickResponseById(result, 'FileNode/get', 'folder-get');
  if (
    !query
    || !Array.isArray(query.ids)
    || !get
    || !Array.isArray(get.list)
    || !Array.isArray(get.notFound)
    || typeof get.state !== 'string'
  ) {
    return {
      ok: false,
      error: { type: 'serverFail', message: 'FileNode folder query was malformed' },
    };
  }
  if (
    get.notFound.length > 0
    || get.list.length !== query.ids.length
    || (Number.isSafeInteger(query.total) && query.total > limit)
  ) {
    return {
      ok: false,
      error: { type: 'stateMismatch', message: 'FileNode folder collection changed' },
    };
  }
  let state = get.state;
  let matches = get.list.filter((node: any) =>
    node?.name === name && (node?.parentId ?? null) === parentId);
  if (matches.length === 0) {
    let allResult;
    try {
      allResult = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.FILENODE],
        methodCalls: [['FileNode/get', {
          accountId: account.remote_account_id,
          properties: FILE_NODE_PROPERTIES,
        }, 'folder-all']],
        useWebSocket,
      });
    } catch (error) {
      return { ok: false, error: transportError(error) };
    }
    const allFailure = methodError(allResult, 'folder-all');
    if (allFailure) return { ok: false, error: typedError(allFailure, 'serverFail') };
    const all = pickResponseById(allResult, 'FileNode/get', 'folder-all');
    if (
      !all
      || !Array.isArray(all.list)
      || !Array.isArray(all.notFound)
      || typeof all.state !== 'string'
    ) {
      return {
        ok: false,
        error: { type: 'serverFail', message: 'FileNode folder listing was malformed' },
      };
    }
    state = all.state;
    matches = all.list.filter((node: any) =>
      node?.name === name && (node?.parentId ?? null) === parentId);
    if (matches.length === 0) {
      return { ok: true, status: 'missing', state, node: null };
    }
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: {
        type: 'alreadyExists',
        message: `Multiple FileNode folders are named ${name} under the same parent`,
        detail: matches.map((node: any) => node?.id),
        terminal: true,
      },
    };
  }
  const node = matches[0] as JmapFileNode;
  if (node.blobId != null || node.type != null) {
    return {
      ok: false,
      error: {
        type: 'invalidDocument',
        message: `${name} is not a FileNode folder`,
        terminal: true,
      },
    };
  }
  if (!mayReadNode(node)) {
    return { ok: false, error: { type: 'forbidden', terminal: true } };
  }
  return { ok: true, status: 'found', state, node };
}

export async function ensureFileNodeFolder({
  transport,
  account,
  name,
  parentId = null,
  useWebSocket = false,
}: {
  transport: FileNodeTransport;
  account: FileNodeAccount;
  name: string;
  parentId?: string | null;
  useWebSocket?: boolean;
}): Promise<FileNodeFolderRead> {
  const capability = fileNodeAccountCapability(transport, account);
  if (!capability) {
    return { ok: false, error: { type: 'unsupported', terminal: true } };
  }
  if (!name) {
    return { ok: false, error: { type: 'invalidArguments', terminal: true } };
  }
  let lastError: FileNodeDocumentError = { type: 'stateMismatch' };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const found = await findFileNodeFolder({
      transport,
      account,
      name,
      parentId,
      useWebSocket,
    });
    if (found.ok === false) return found;
    if (found.status === 'found') {
      if (!mayModifyNode(found.node)) {
        return { ok: false, error: { type: 'forbidden', terminal: true } };
      }
      return { ok: true, state: found.state, node: found.node };
    }
    if (parentId == null && capability.mayCreateTopLevelFileNode === false) {
      return { ok: false, error: { type: 'forbidden', terminal: true } };
    }
    let result;
    try {
      result = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.FILENODE],
        methodCalls: [['FileNode/set', {
          accountId: account.remote_account_id,
          ifInState: found.state,
          onExists: null,
          create: {
            folder: {
              parentId,
              name,
            },
          },
        }, 'folder-set']],
        useWebSocket,
      });
    } catch (error) {
      return { ok: false, error: transportError(error) };
    }
    const setFailure = methodError(result, 'folder-set');
    if (setFailure) {
      lastError = typedError(setFailure, 'serverFail');
      if (isRetryableFileNodeDocumentError(lastError)) continue;
      return { ok: false, error: lastError };
    }
    const set = pickResponseById(result, 'FileNode/set', 'folder-set');
    const createFailure = set?.notCreated?.folder;
    if (createFailure) {
      lastError = typedError(createFailure, 'serverFail');
      if (lastError.type === 'alreadyExists' || isRetryableFileNodeDocumentError(lastError)) {
        continue;
      }
      return { ok: false, error: lastError };
    }
    const id = set?.created?.folder?.id;
    if (typeof id === 'string' && id) {
      return {
        ok: true,
        state: set.newState ?? found.state,
        node: {
          id,
          name,
          parentId,
          blobId: null,
          type: null,
        },
      };
    }
    lastError = { type: 'serverFail', message: 'FileNode/set did not create the folder' };
  }
  return { ok: false, error: lastError };
}

export async function ensureThundermailFileNodeFolder({
  transport,
  account,
  useWebSocket = false,
}: {
  transport: FileNodeTransport;
  account: FileNodeAccount;
  useWebSocket?: boolean;
}): Promise<FileNodeFolderRead> {
  return ensureFileNodeFolder({
    transport,
    account,
    name: THUNDERMAIL_FILE_NODE_FOLDER,
    useWebSocket,
  });
}

export async function findThundermailFileNodeFolder({
  transport,
  account,
  useWebSocket = false,
}: {
  transport: FileNodeTransport;
  account: FileNodeAccount;
  useWebSocket?: boolean;
}): Promise<FileNodeFolderLookup> {
  return findFileNodeFolder({
    transport,
    account,
    name: THUNDERMAIL_FILE_NODE_FOLDER,
    parentId: null,
    useWebSocket,
  });
}

export async function findContactsTrashFileNodeFolder({
  transport,
  account,
  useWebSocket = false,
}: {
  transport: FileNodeTransport;
  account: FileNodeAccount;
  useWebSocket?: boolean;
}): Promise<FileNodeFolderLookup> {
  const root = await findThundermailFileNodeFolder({
    transport,
    account,
    useWebSocket,
  });
  if (root.ok === false || root.status === 'missing') return root;
  return findFileNodeFolder({
    transport,
    account,
    name: CONTACTS_TRASH_FILE_NODE_FOLDER,
    parentId: root.node.id,
    useWebSocket,
  });
}

export async function ensureContactsTrashFileNodeFolder({
  transport,
  account,
  useWebSocket = false,
}: {
  transport: FileNodeTransport;
  account: FileNodeAccount;
  useWebSocket?: boolean;
}): Promise<FileNodeFolderRead> {
  const root = await ensureThundermailFileNodeFolder({
    transport,
    account,
    useWebSocket,
  });
  if (root.ok === false) return root;
  return ensureFileNodeFolder({
    transport,
    account,
    name: CONTACTS_TRASH_FILE_NODE_FOLDER,
    parentId: root.node.id,
    useWebSocket,
  });
}

export async function moveFileNodes({
  transport,
  account,
  nodes,
  state,
  parentId,
  useWebSocket = false,
}: {
  transport: FileNodeTransport;
  account: FileNodeAccount;
  nodes: JmapFileNode[];
  state: string;
  parentId: string;
  useWebSocket?: boolean;
}): Promise<FileNodeDocumentWrite> {
  if (nodes.length === 0) {
    return { ok: true, nodeId: '', blobId: '', state };
  }
  if (nodes.some((node) => !mayModifyNode(node))) {
    return { ok: false, error: { type: 'forbidden', terminal: true } };
  }
  const limit = fileNodeSetLimit(transport);
  let currentState = state;
  for (let offset = 0; offset < nodes.length; offset += limit) {
    const chunk = nodes.slice(offset, offset + limit);
    let result;
    try {
      result = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.FILENODE],
        methodCalls: [['FileNode/set', {
          accountId: account.remote_account_id,
          ifInState: currentState,
          onExists: null,
          update: Object.fromEntries(chunk.map((node) => [node.id, { parentId }])),
        }, 'move-set']],
        useWebSocket,
      });
    } catch (error) {
      return { ok: false, error: transportError(error) };
    }
    const setFailure = methodError(result, 'move-set');
    if (setFailure) return { ok: false, error: typedError(setFailure, 'serverFail') };
    const set = pickResponseById(result, 'FileNode/set', 'move-set');
    for (const node of chunk) {
      const failure = set?.notUpdated?.[node.id];
      if (failure) return { ok: false, error: typedError(failure, 'serverFail') };
      if (!set?.updated || !(node.id in set.updated)) {
        return {
          ok: false,
          error: { type: 'serverFail', message: 'FileNode/set did not confirm the move' },
        };
      }
    }
    currentState = set.newState ?? currentState;
  }
  return {
    ok: true,
    nodeId: nodes[0].id,
    blobId: nodes[0].blobId ?? '',
    state: currentState,
  };
}

export async function discoverJsonFileNodes({
  transport,
  account,
  nameMatch,
  acceptName,
  parentId = null,
  useWebSocket = false,
}: {
  transport: FileNodeTransport;
  account: FileNodeAccount;
  nameMatch: string;
  acceptName: (name: string) => boolean;
  parentId?: string | null;
  useWebSocket?: boolean;
}): Promise<FileNodeCollectionRead> {
  if (!hasFileNodeCapability(transport, account)) {
    return { ok: false, error: { type: 'unsupported', terminal: true } };
  }
  const limit = fileNodeGetLimit(transport);
  const nodes: JmapFileNode[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  let position = 0;
  let state = '';
  let queryState = '';
  for (let page = 0; page < 10_000; page += 1) {
    const callId = `file-node-collection-${page}`;
    let result;
    try {
      result = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.FILENODE],
        methodCalls: [
          ['FileNode/query', {
            accountId: account.remote_account_id,
            filter: { nameMatch },
            position,
            limit,
            calculateTotal: true,
          }, `q-${callId}`],
          ['FileNode/get', {
            accountId: account.remote_account_id,
            '#ids': {
              resultOf: `q-${callId}`,
              name: 'FileNode/query',
              path: '/ids',
            },
            properties: FILE_NODE_PROPERTIES,
          }, `g-${callId}`],
        ],
        useWebSocket,
      });
    } catch (error) {
      return { ok: false, error: transportError(error) };
    }
    const queryFailure = methodError(result, `q-${callId}`);
    if (queryFailure) return { ok: false, error: typedError(queryFailure, 'serverFail') };
    const getFailure = methodError(result, `g-${callId}`);
    if (getFailure) return { ok: false, error: typedError(getFailure, 'serverFail') };
    const query = pickResponseById(result, 'FileNode/query', `q-${callId}`);
    const get = pickResponseById(result, 'FileNode/get', `g-${callId}`);
    if (
      !query
      || !Array.isArray(query.ids)
      || !get
      || !Array.isArray(get.list)
      || !Array.isArray(get.notFound)
      || typeof get.state !== 'string'
    ) {
      return {
        ok: false,
        error: { type: 'serverFail', message: 'FileNode collection query was malformed' },
      };
    }
    if (
      (queryState && query.queryState !== queryState)
      || (state && get.state !== state)
    ) {
      return { ok: false, error: { type: 'stateMismatch' } };
    }
    queryState = query.queryState;
    state = get.state;
    const selectedIds = new Set(query.ids);
    if (
      get.notFound.length > 0
      || get.list.some((node: any) => !selectedIds.has(node?.id))
      || get.list.length !== selectedIds.size
      || query.ids.some((id: unknown) => typeof id !== 'string' || !id || ids.has(id))
    ) {
      return {
        ok: false,
        error: { type: 'stateMismatch', message: 'FileNode collection changed during discovery' },
      };
    }
    for (const id of query.ids) ids.add(id);
    for (const candidate of get.list) {
      const name = typeof candidate?.name === 'string' ? candidate.name : '';
      if ((candidate?.parentId ?? null) !== parentId || !acceptName(name)) continue;
      if (names.has(name)) {
        return {
          ok: false,
          error: {
            type: 'alreadyExists',
            message: `Multiple FileNodes are named ${name} under the same parent`,
            terminal: true,
          },
        };
      }
      names.add(name);
      nodes.push(candidate as JmapFileNode);
    }
    position += query.ids.length;
    const total = Number(query.total);
    const hasTotal = Number.isSafeInteger(total) && total >= 0;
    if (
      query.ids.length === 0
      || (hasTotal ? position >= total : query.ids.length < limit)
    ) {
      return { ok: true, state, nodes };
    }
  }
  return {
    ok: false,
    error: {
      type: 'tooManyChanges',
      message: 'FileNode collection pagination did not converge',
    },
  };
}

export async function readJsonFileNodeFromNode<T>({
  transport,
  account,
  node,
  state,
  marker,
  maxBytes,
  parentId = null,
}: {
  transport: FileNodeTransport;
  account: FileNodeAccount;
  node: JmapFileNode;
  state: string;
  marker: JsonDocumentMarker;
  maxBytes: number;
  parentId?: string | null;
}): Promise<FileNodeDocumentRead<T>> {
  if (!mayReadNode(node)) {
    return { ok: false, error: { type: 'forbidden', terminal: true } };
  }
  if (
    (node.parentId ?? null) !== parentId
    || (node.nodeType !== undefined && node.nodeType !== 'file')
  ) {
    return {
      ok: false,
      error: {
        type: 'invalidDocument',
        message: 'FileNode is not in the expected folder',
        terminal: true,
      },
    };
  }
  if (!node.blobId || node.type !== 'application/json') {
    return {
      ok: false,
      error: {
        type: 'invalidDocument',
        message: 'FileNode is not an application/json document',
        terminal: true,
      },
    };
  }
  if (typeof node.size === 'number' && node.size > maxBytes) {
    return {
      ok: false,
      error: {
        type: 'tooLarge',
        message: `FileNode document is ${node.size} bytes, exceeding the ${maxBytes} byte limit`,
        terminal: true,
      },
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = await transport.download({
      accountId: account.remote_account_id,
      blobId: node.blobId,
      type: 'application/json',
      name: node.name,
      maxBytes,
    });
  } catch (error) {
    return { ok: false, error: transportError(error) };
  }
  if (bytes.byteLength > maxBytes) {
    return {
      ok: false,
      error: {
        type: 'tooLarge',
        message: `FileNode document is ${bytes.byteLength} bytes, exceeding the ${maxBytes} byte limit`,
        terminal: true,
      },
    };
  }
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    return {
      ok: false,
      error: {
        type: 'invalidDocument',
        message: error instanceof Error ? error.message : String(error),
        terminal: true,
      },
    };
  }
  if (!markerMatches(document, marker)) {
    return {
      ok: false,
      error: {
        type: 'invalidDocument',
        message: 'FileNode document ownership or version marker does not match',
        terminal: true,
      },
    };
  }
  return { ok: true, status: 'found', state, node, document: document as T };
}

export async function readJsonFileNode<T>({
  transport,
  account,
  fileName,
  marker,
  maxBytes,
  parentId = null,
  useWebSocket = false,
}: {
  transport: FileNodeTransport;
  account: FileNodeAccount;
  fileName: string;
  marker: JsonDocumentMarker;
  maxBytes: number;
  parentId?: string | null;
  useWebSocket?: boolean;
}): Promise<FileNodeDocumentRead<T>> {
  if (!hasFileNodeCapability(transport, account)) {
    return { ok: false, error: { type: 'unsupported', terminal: true } };
  }

  let result;
  const limit = fileNodeGetLimit(transport);
  try {
    result = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.FILENODE],
      methodCalls: [
        ['FileNode/query', {
          accountId: account.remote_account_id,
          filter: { name: fileName },
          limit,
          calculateTotal: true,
        }, 'q1'],
        ['FileNode/get', {
          accountId: account.remote_account_id,
          '#ids': { resultOf: 'q1', name: 'FileNode/query', path: '/ids' },
          properties: FILE_NODE_PROPERTIES,
        }, 'g1'],
      ],
      useWebSocket,
    });
  } catch (error) {
    return { ok: false, error: transportError(error) };
  }

  const queryFailure = methodError(result, 'q1');
  if (queryFailure) return { ok: false, error: typedError(queryFailure, 'serverFail') };
  const getFailure = methodError(result, 'g1');
  if (getFailure) return { ok: false, error: typedError(getFailure, 'serverFail') };

  const query = pickResponseById(result, 'FileNode/query', 'q1');
  const response = pickResponseById(result, 'FileNode/get', 'g1');
  if (
    !query
    || !Array.isArray(query.ids)
    || !response
    || typeof response.state !== 'string'
  ) {
    return {
      ok: false,
      error: { type: 'serverFail', message: 'FileNode/get returned no object state' },
    };
  }
  if (Number.isSafeInteger(query.total) && query.total > limit) {
    return {
      ok: false,
      error: {
        type: 'alreadyExists',
        message: `Too many FileNodes are named ${fileName}`,
        terminal: true,
      },
    };
  }
  const nodes = (Array.isArray(response.list) ? response.list : [])
    .filter((node: any) =>
      node?.name === fileName && (node?.parentId ?? null) === parentId);
  if (nodes.length === 0) {
    return { ok: true, status: 'missing', state: response.state, node: null };
  }
  if (nodes.length !== 1) {
    return {
      ok: false,
      error: {
        type: 'alreadyExists',
        message: `Multiple FileNodes are named ${fileName} under the same parent`,
        detail: nodes.map((node: any) => node?.id),
        terminal: true,
      },
    };
  }

  const node = nodes[0] as JmapFileNode;
  if (!mayReadNode(node)) {
    return { ok: false, error: { type: 'forbidden', terminal: true } };
  }
  if (node.nodeType !== undefined && node.nodeType !== 'file') {
    return {
      ok: false,
      error: { type: 'invalidDocument', message: 'FileNode is not a file', terminal: true },
    };
  }
  if (!node.blobId || node.type !== 'application/json') {
    return {
      ok: false,
      error: {
        type: 'invalidDocument',
        message: 'FileNode is not an application/json document',
        terminal: true,
      },
    };
  }
  if (typeof node.size === 'number' && node.size > maxBytes) {
    return {
      ok: false,
      error: {
        type: 'tooLarge',
        message: `FileNode document is ${node.size} bytes, exceeding the ${maxBytes} byte limit`,
        terminal: true,
      },
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = await transport.download({
      accountId: account.remote_account_id,
      blobId: node.blobId,
      type: 'application/json',
      name: fileName,
      maxBytes,
    });
  } catch (error) {
    return { ok: false, error: transportError(error) };
  }
  if (bytes.byteLength > maxBytes) {
    return {
      ok: false,
      error: {
        type: 'tooLarge',
        message: `FileNode document is ${bytes.byteLength} bytes, exceeding the ${maxBytes} byte limit`,
        terminal: true,
      },
    };
  }
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    return {
      ok: false,
      error: {
        type: 'invalidDocument',
        message: error instanceof Error ? error.message : String(error),
        terminal: true,
      },
    };
  }
  if (!markerMatches(document, marker)) {
    return {
      ok: false,
      error: {
        type: 'invalidDocument',
        message: 'FileNode document ownership or version marker does not match',
        terminal: true,
      },
    };
  }
  return { ok: true, status: 'found', state: response.state, node, document: document as T };
}

export async function writeJsonFileNode<T>({
  transport,
  account,
  fileName,
  marker,
  document,
  snapshot,
  parentId = null,
  destroyNodeIds = [],
  useWebSocket = false,
}: {
  transport: FileNodeTransport;
  account: FileNodeAccount;
  fileName: string;
  marker: JsonDocumentMarker;
  document: T;
  snapshot: Extract<FileNodeDocumentRead<T>, { ok: true }>;
  parentId?: string | null;
  destroyNodeIds?: string[];
  useWebSocket?: boolean;
}): Promise<FileNodeDocumentWrite> {
  const capability = fileNodeAccountCapability(transport, account);
  if (!capability) {
    return { ok: false, error: { type: 'unsupported', terminal: true } };
  }
  if (!markerMatches(document, marker)) {
    return {
      ok: false,
      error: { type: 'invalidDocument', message: 'Document marker does not match', terminal: true },
    };
  }
  if (
    snapshot.status === 'missing'
    && parentId == null
    && capability.mayCreateTopLevelFileNode === false
  ) {
    return { ok: false, error: { type: 'forbidden', terminal: true } };
  }
  if (
    snapshot.status === 'found'
    && (snapshot.node.parentId ?? null) !== parentId
  ) {
    return {
      ok: false,
      error: {
        type: 'invalidDocument',
        message: 'FileNode is not in the expected folder',
        terminal: true,
      },
    };
  }
  if (snapshot.status === 'found' && !mayModifyNode(snapshot.node)) {
    return { ok: false, error: { type: 'forbidden', terminal: true } };
  }

  let upload;
  try {
    upload = await transport.upload({
      accountId: account.remote_account_id,
      type: 'application/json',
      body: JSON.stringify(document),
    });
  } catch (error) {
    return { ok: false, error: transportError(error) };
  }
  if (!upload?.blobId) {
    return { ok: false, error: { type: 'serverFail', message: 'Upload returned no blob id' } };
  }

  const update = snapshot.status === 'found'
    ? { [snapshot.node.id]: { blobId: upload.blobId, type: 'application/json' } }
    : undefined;
  const create = snapshot.status === 'missing'
    ? {
      document: {
        parentId,
        name: fileName,
        blobId: upload.blobId,
        type: 'application/json',
      },
    }
    : undefined;

  let result;
  try {
    result = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.FILENODE],
      methodCalls: [['FileNode/set', {
        accountId: account.remote_account_id,
        ifInState: snapshot.state,
        onExists: null,
        ...(update ? { update } : {}),
        ...(create ? { create } : {}),
        ...(destroyNodeIds.length > 0 ? { destroy: destroyNodeIds } : {}),
      }, 's1']],
      useWebSocket,
    });
  } catch (error) {
    return { ok: false, error: transportError(error) };
  }

  const setFailure = methodError(result, 's1');
  if (setFailure) return { ok: false, error: typedError(setFailure, 'serverFail') };
  const response = pickResponse(result, 'FileNode/set');
  if (!response) {
    return {
      ok: false,
      error: { type: 'serverFail', message: 'FileNode/set returned no response' },
    };
  }

  let nodeId: string | null = null;
  if (snapshot.status === 'found') {
    const detail = response.notUpdated?.[snapshot.node.id];
    if (detail) return { ok: false, error: typedError(detail, 'serverFail') };
    if (response.updated && snapshot.node.id in response.updated) {
      nodeId = snapshot.node.id;
    }
  } else {
    const detail = response.notCreated?.document;
    if (detail) return { ok: false, error: typedError(detail, 'serverFail') };
    nodeId = response.created?.document?.id ?? null;
  }
  if (!nodeId) {
    return {
      ok: false,
      error: { type: 'serverFail', message: 'FileNode/set did not confirm the write' },
    };
  }
  for (const destroyedId of destroyNodeIds) {
    const detail = response.notDestroyed?.[destroyedId];
    if (detail) return { ok: false, error: typedError(detail, 'serverFail') };
    if (!response.destroyed?.includes(destroyedId)) {
      return {
        ok: false,
        error: { type: 'serverFail', message: 'FileNode/set did not confirm the relocation' },
      };
    }
  }
  return {
    ok: true,
    nodeId,
    blobId: upload.blobId,
    state: response.newState ?? null,
  };
}
