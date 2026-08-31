import {
  SETTINGS_DOCUMENT_OWNER,
  SETTINGS_DOCUMENT_TYPE,
  SETTINGS_DOCUMENT_VERSION,
  SETTINGS_MAX_DOCUMENT_BYTES,
  type SettingsDocument,
} from '../../../constants/settings-document';
import { DB_RPC } from '../../../db/protocol';
import {
  ensureThundermailFileNodeFolder,
  findThundermailFileNodeFolder,
  hasFileNodeCapability,
  moveFileNodes,
  readJsonFileNode,
  writeJsonFileNode,
  type FileNodeDocumentError,
  type FileNodeDocumentRead,
} from './file-node';

export const SETTINGS_FILE_NAME = 'stormbox-settings.json';

const SETTINGS_MARKER = {
  owner: SETTINGS_DOCUMENT_OWNER,
  documentType: SETTINGS_DOCUMENT_TYPE,
  version: SETTINGS_DOCUMENT_VERSION,
};

const MAX_WRITE_ATTEMPTS = 3;
const CONFLICT_ERRORS = new Set(['stateMismatch', 'alreadyExists', 'notFound']);

export { hasFileNodeCapability };

export type SettingsSyncResult =
  | { ok: true; skipped?: boolean; pulled?: boolean; repairQueued?: boolean }
  | { ok: false; error: FileNodeDocumentError };

type SuccessfulSettingsRead = Extract<
  FileNodeDocumentRead<SettingsDocument>,
  { ok: true }
>;

type SettingsLocations =
  | {
      ok: true;
      parentId: string | null;
      current: SuccessfulSettingsRead | null;
      legacy: SuccessfulSettingsRead;
    }
  | Extract<FileNodeDocumentRead<SettingsDocument>, { ok: false }>;

async function readSettingsLocations({
  transport,
  account,
  createFolder,
  useWebSocket,
}: {
  transport: any;
  account: any;
  createFolder: boolean;
  useWebSocket: boolean;
}): Promise<SettingsLocations> {
  const folder = createFolder
    ? await ensureThundermailFileNodeFolder({ transport, account, useWebSocket })
    : await findThundermailFileNodeFolder({ transport, account, useWebSocket });
  if (folder.ok === false) return folder;
  const folderMissing = 'status' in folder && folder.status === 'missing';
  let current: SuccessfulSettingsRead | null = null;
  if (!folderMissing) {
    const remote = await readJsonFileNode<SettingsDocument>({
      transport,
      account,
      fileName: SETTINGS_FILE_NAME,
      marker: SETTINGS_MARKER,
      maxBytes: SETTINGS_MAX_DOCUMENT_BYTES,
      parentId: folder.node.id,
      useWebSocket,
    });
    if (remote.ok === false) return remote;
    current = remote;
  }
  const legacy = await readJsonFileNode<SettingsDocument>({
    transport,
    account,
    fileName: SETTINGS_FILE_NAME,
    marker: SETTINGS_MARKER,
    maxBytes: SETTINGS_MAX_DOCUMENT_BYTES,
    useWebSocket,
  });
  if (legacy.ok === false) return legacy;
  return {
    ok: true,
    parentId: folderMissing ? null : folder.node.id,
    current,
    legacy,
  };
}

export async function syncSettingsFromServer({
  transport,
  account,
  handlers,
  useWebSocket = false,
}: {
  transport: any;
  account: any;
  handlers: Record<string, (params: any) => Promise<any>>;
  useWebSocket?: boolean;
}): Promise<SettingsSyncResult> {
  if (!hasFileNodeCapability(transport, account)) {
    return { ok: true, skipped: true };
  }
  const locations = await readSettingsLocations({
    transport,
    account,
    createFolder: false,
    useWebSocket,
  });
  if (locations.ok === false) return locations;
  let pulled = false;
  let needsPush = locations.current == null || locations.current.status === 'missing';
  if (locations.legacy.status === 'found') {
    const merged = await handlers[DB_RPC.SETTINGS_MERGE_REMOTE]({
      accountId: account.id,
      doc: locations.legacy.document,
      remoteNodeId: locations.legacy.node.id,
      ensurePush: false,
    });
    pulled = true;
    needsPush = true;
    if (merged.localNewer) needsPush = true;
  }
  if (locations.current?.status === 'found') {
    const merged = await handlers[DB_RPC.SETTINGS_MERGE_REMOTE]({
      accountId: account.id,
      doc: locations.current.document,
      remoteNodeId: locations.current.node.id,
      ensurePush: false,
    });
    pulled = true;
    if (merged.localNewer) needsPush = true;
  }
  const ensured = needsPush
    ? await handlers[DB_RPC.SETTINGS_ENSURE_PUSH]({ accountId: account.id })
    : null;
  return {
    ok: true,
    pulled,
    repairQueued: ensured?.mutation != null,
  };
}

export async function pushSettings({
  transport,
  account,
  handlers,
  useWebSocket = false,
}: {
  transport: any;
  account: any;
  handlers: Record<string, (params: any) => Promise<any>>;
  useWebSocket?: boolean;
}): Promise<
  { ok: true; skipped?: boolean } | { ok: false; error: FileNodeDocumentError }
> {
  if (!hasFileNodeCapability(transport, account)) {
    return { ok: true, skipped: true };
  }

  let lastError: FileNodeDocumentError = { type: 'stateMismatch' };
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const locations = await readSettingsLocations({
      transport,
      account,
      createFolder: true,
      useWebSocket,
    });
    if (locations.ok === false) {
      lastError = locations.error;
      if (CONFLICT_ERRORS.has(locations.error.type)) continue;
      return locations;
    }
    if (locations.parentId == null || locations.current == null) {
      return {
        ok: false,
        error: { type: 'serverFail', message: 'Settings folder was not created' },
      };
    }
    let local = await handlers[DB_RPC.SETTINGS_GET]({ accountId: account.id });
    if (locations.legacy.status === 'found') {
      local = await handlers[DB_RPC.SETTINGS_MERGE_REMOTE]({
        accountId: account.id,
        doc: locations.legacy.document,
        remoteNodeId: locations.legacy.node.id,
        ensurePush: false,
      });
    }
    if (locations.current.status === 'found') {
      local = await handlers[DB_RPC.SETTINGS_MERGE_REMOTE]({
        accountId: account.id,
        doc: locations.current.document,
        remoteNodeId: locations.current.node.id,
        ensurePush: false,
      });
    }
    const document = local.doc as SettingsDocument;
    if (
      locations.current.status === 'missing'
      && locations.legacy.status === 'missing'
      && Object.keys(document.settings).length === 0
    ) {
      return { ok: true };
    }

    let snapshot = locations.current;
    let destroyNodeIds: string[] = [];
    if (locations.legacy.status === 'found') {
      if (locations.current.status === 'missing') {
        const moved = await moveFileNodes({
          transport,
          account,
          nodes: [locations.legacy.node],
          state: locations.legacy.state,
          parentId: locations.parentId,
          useWebSocket,
        });
        if (moved.ok === false) {
          lastError = moved.error;
          if (CONFLICT_ERRORS.has(moved.error.type)) continue;
          return moved;
        }
        snapshot = {
          ...locations.legacy,
          state: moved.state ?? locations.legacy.state,
          node: {
            ...locations.legacy.node,
            parentId: locations.parentId,
          },
        };
      } else {
        snapshot = {
          ...locations.current,
          state: locations.legacy.state,
        };
        destroyNodeIds = [locations.legacy.node.id];
      }
    }
    const write = await writeJsonFileNode({
      transport,
      account,
      fileName: SETTINGS_FILE_NAME,
      marker: SETTINGS_MARKER,
      document,
      snapshot,
      parentId: locations.parentId,
      destroyNodeIds,
      useWebSocket,
    });
    if (write.ok === true) {
      await handlers[DB_RPC.SETTINGS_SET_REMOTE_NODE]({
        accountId: account.id,
        remoteNodeId: write.nodeId,
      });
      return { ok: true };
    }
    lastError = write.error;
    if (!CONFLICT_ERRORS.has(write.error.type)) return write;
  }
  return { ok: false, error: lastError };
}
