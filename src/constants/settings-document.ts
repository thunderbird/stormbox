export const SETTINGS_DOCUMENT_OWNER = 'stormbox';
export const SETTINGS_DOCUMENT_TYPE = 'user-settings';
export const SETTINGS_DOCUMENT_VERSION = 1;
export const SETTINGS_MAX_DOCUMENT_BYTES = 1024 * 1024;

export interface SettingsDocument {
  owner: typeof SETTINGS_DOCUMENT_OWNER;
  documentType: typeof SETTINGS_DOCUMENT_TYPE;
  version: typeof SETTINGS_DOCUMENT_VERSION;
  settings: Record<string, unknown>;
  updatedAt: Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function emptySettingsDocument(): SettingsDocument {
  return {
    owner: SETTINGS_DOCUMENT_OWNER,
    documentType: SETTINGS_DOCUMENT_TYPE,
    version: SETTINGS_DOCUMENT_VERSION,
    settings: {},
    updatedAt: {},
  };
}

/**
 * Convert locally persisted or trusted merged input to the current shape.
 * Remote documents are marker-validated before reaching this function.
 */
export function normalizeSettingsDocument(input: unknown): SettingsDocument {
  const document = emptySettingsDocument();
  if (!isRecord(input)) return document;

  const values = isRecord(input.settings) ? input.settings : {};
  const stamps = isRecord(input.updatedAt) ? input.updatedAt : {};
  for (const [key, value] of Object.entries(values)) {
    document.settings[key] = value;
    const stamp = Number(stamps[key]);
    document.updatedAt[key] = Number.isFinite(stamp) && stamp >= 0 ? Math.floor(stamp) : 0;
  }
  return document;
}

export function mergeSettingsDocuments(
  localInput: unknown,
  remoteInput: unknown,
): { document: SettingsDocument; localNewer: boolean } {
  const local = normalizeSettingsDocument(localInput);
  const remote = normalizeSettingsDocument(remoteInput);
  const document = emptySettingsDocument();
  let localNewer = false;
  const keys = new Set([...Object.keys(local.settings), ...Object.keys(remote.settings)]);

  for (const key of keys) {
    const hasLocal = Object.hasOwn(local.settings, key);
    const hasRemote = Object.hasOwn(remote.settings, key);
    const localStamp = local.updatedAt[key] ?? 0;
    const remoteStamp = remote.updatedAt[key] ?? 0;
    if (hasRemote && (!hasLocal || remoteStamp >= localStamp)) {
      document.settings[key] = remote.settings[key];
      document.updatedAt[key] = remoteStamp;
    } else {
      document.settings[key] = local.settings[key];
      document.updatedAt[key] = localStamp;
      if (!hasRemote || localStamp > remoteStamp) localNewer = true;
    }
  }

  return { document, localNewer };
}
