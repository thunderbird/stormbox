import stormboxConfigJson from '../../stormbox.config.json';

const IEC_KIB = 1024;
const IEC_MIB = IEC_KIB ** 2;
const IEC_GIB = IEC_KIB ** 3;
const SI_KB = 1000;
const SI_MB = SI_KB ** 2;
const SI_GB = SI_KB ** 3;

export const CONTACTS_TRASH_SNAPSHOT_SAFETY_BYTES = 2 * IEC_MIB;

export interface ContactsTrashLimits {
  serverFileStorage: {
    maxSize: number | null;
    maxFiles: number | null;
    maxFolders: number | null;
  };
  snapshotShardMaxBytesOverride: number | null;
  snapshotShardMaxBytes: number;
  shardMaxRecords: number;
  tombstoneShardMaxBytes: number;
  maxMediaItems: number;
  maxMediaItemBytes: number;
  maxTotalMediaBytes: number;
}

const SIZE_FACTORS: Readonly<Record<string, number>> = Object.freeze({
  b: 1,
  kb: SI_KB,
  kib: IEC_KIB,
  mb: SI_MB,
  mib: IEC_MIB,
  gb: SI_GB,
  gib: IEC_GIB,
});

function configError(name: string, detail: string): Error {
  return new Error(`Invalid contacts-trash configuration ${name}: ${detail}`);
}

export function parsePositiveByteSize(value: string, name = 'value'): number {
  const match = /^(\d+)\s*(b|kb|kib|mb|mib|gb|gib)?$/i.exec(value.trim());
  if (!match) {
    throw configError(name, 'expected a positive integer byte count or size such as 25MiB');
  }
  const amount = Number(match[1]);
  const factor = SIZE_FACTORS[(match[2] ?? 'b').toLowerCase()];
  const bytes = amount * factor;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw configError(name, 'value must resolve to a positive safe integer number of bytes');
  }
  return bytes;
}

function parsePositiveInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw configError(name, 'expected a positive integer');
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw configError(name, 'value must be a positive safe integer');
  }
  return parsed;
}

function nullableSize(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw configError(name, 'expected null, integer bytes, or a size such as 25MiB');
  }
  return parsePositiveByteSize(String(value), name);
}

function requiredSize(value: unknown, name: string): number {
  const parsed = nullableSize(value, name);
  if (parsed === null) throw configError(name, 'must not be null');
  return parsed;
}

function nullableInteger(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw configError(name, 'expected null or a positive integer');
  }
  return parsePositiveInteger(String(value), name);
}

function requiredInteger(value: unknown, name: string): number {
  const parsed = nullableInteger(value, name);
  if (parsed === null) throw configError(name, 'must not be null');
  return parsed;
}

export function parseContactsTrashLimits(input: unknown): Readonly<ContactsTrashLimits> {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    throw configError('contactsTrash', 'stormbox.config.json must contain an object');
  }
  const contactsTrash = (input as Record<string, unknown>).contactsTrash;
  if (
    contactsTrash == null
    || typeof contactsTrash !== 'object'
    || Array.isArray(contactsTrash)
  ) {
    throw configError('contactsTrash', 'section is required');
  }
  const values = contactsTrash as Record<string, unknown>;
  const serverValue = values.serverFileStorage;
  if (serverValue == null || typeof serverValue !== 'object' || Array.isArray(serverValue)) {
    throw configError('contactsTrash.serverFileStorage', 'section is required');
  }
  const server = serverValue as Record<string, unknown>;
  const serverFileStorage = Object.freeze({
    maxSize: nullableSize(
      server.maxSize,
      'contactsTrash.serverFileStorage.maxSize',
    ),
    maxFiles: nullableInteger(
      server.maxFiles,
      'contactsTrash.serverFileStorage.maxFiles',
    ),
    maxFolders: nullableInteger(
      server.maxFolders,
      'contactsTrash.serverFileStorage.maxFolders',
    ),
  });
  const snapshotShardMaxBytesOverride = nullableSize(
    values.snapshotShardMaxBytes,
    'contactsTrash.snapshotShardMaxBytes',
  );
  const snapshotShardMaxBytes =
    snapshotShardMaxBytesOverride ?? serverFileStorage.maxSize;
  if (snapshotShardMaxBytes === null) {
    throw configError(
      'contactsTrash.snapshotShardMaxBytes',
      'must be set when contactsTrash.serverFileStorage.maxSize is null',
    );
  }
  if (
    serverFileStorage.maxSize !== null
    && snapshotShardMaxBytes > serverFileStorage.maxSize
  ) {
    throw configError(
      'contactsTrash.snapshotShardMaxBytes',
      'must not exceed contactsTrash.serverFileStorage.maxSize',
    );
  }
  const limits: ContactsTrashLimits = {
    serverFileStorage,
    snapshotShardMaxBytesOverride,
    snapshotShardMaxBytes,
    shardMaxRecords: requiredInteger(
      values.maxRecordsPerShard,
      'contactsTrash.maxRecordsPerShard',
    ),
    tombstoneShardMaxBytes: requiredSize(
      values.tombstoneShardMaxBytes,
      'contactsTrash.tombstoneShardMaxBytes',
    ),
    maxMediaItems: requiredInteger(
      values.maxMediaItems,
      'contactsTrash.maxMediaItems',
    ),
    maxMediaItemBytes: requiredSize(
      values.maxMediaItemBytes,
      'contactsTrash.maxMediaItemBytes',
    ),
    maxTotalMediaBytes: requiredSize(
      values.maxTotalMediaBytes,
      'contactsTrash.maxTotalMediaBytes',
    ),
  };

  if (limits.tombstoneShardMaxBytes > limits.snapshotShardMaxBytes) {
    throw configError(
      'contactsTrash.tombstoneShardMaxBytes',
      'must not exceed the resolved snapshot shard limit',
    );
  }
  if (limits.maxMediaItemBytes > limits.maxTotalMediaBytes) {
    throw configError(
      'contactsTrash.maxMediaItemBytes',
      'must not exceed contactsTrash.maxTotalMediaBytes',
    );
  }
  const worstCaseBase64Bytes = Math.ceil(limits.maxTotalMediaBytes / 3) * 4;
  if (
    worstCaseBase64Bytes + CONTACTS_TRASH_SNAPSHOT_SAFETY_BYTES
    > limits.snapshotShardMaxBytes
  ) {
    throw configError(
      'contactsTrash.maxTotalMediaBytes',
      `base64 expansion plus the ${CONTACTS_TRASH_SNAPSHOT_SAFETY_BYTES} byte `
        + 'snapshot safety budget must fit the resolved snapshot shard limit',
    );
  }

  return Object.freeze(limits);
}

export const CONTACTS_TRASH_LIMITS = parseContactsTrashLimits(stormboxConfigJson);
