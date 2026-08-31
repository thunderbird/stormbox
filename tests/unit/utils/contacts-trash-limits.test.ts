import { describe, expect, it } from 'vitest';

import {
  CONTACTS_TRASH_LIMITS,
  parseContactsTrashLimits,
  parsePositiveByteSize,
} from '../../../src/config/contacts-trash-limits';

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contactsTrash: {
      serverFileStorage: {
        maxSize: '25MiB',
        maxFiles: null,
        maxFolders: null,
      },
      snapshotShardMaxBytes: null,
      maxRecordsPerShard: 128,
      tombstoneShardMaxBytes: '256KiB',
      maxMediaItems: 32,
      maxMediaItemBytes: '16MiB',
      maxTotalMediaBytes: '16MiB',
      ...overrides,
    },
  };
}

describe('contacts trash limits', () => {
  it('uses the checked-in local Stalwart limits', () => {
    expect(CONTACTS_TRASH_LIMITS).toMatchObject({
      serverFileStorage: {
        maxSize: 25 * 1024 ** 2,
        maxFiles: null,
        maxFolders: null,
      },
      snapshotShardMaxBytes: 25 * 1024 ** 2,
      shardMaxRecords: 128,
      tombstoneShardMaxBytes: 256 * 1024,
      maxMediaItems: 32,
      maxMediaItemBytes: 16 * 1024 ** 2,
      maxTotalMediaBytes: 16 * 1024 ** 2,
    });
  });

  it('parses byte values with IEC and SI suffixes', () => {
    expect(parsePositiveByteSize('25MiB')).toBe(25 * 1024 ** 2);
    expect(parsePositiveByteSize('25mb')).toBe(25_000_000);
    expect(parsePositiveByteSize('4096')).toBe(4096);
  });

  it('allows a lower explicit shard limit', () => {
    const limits = parseContactsTrashLimits(config({
      snapshotShardMaxBytes: '24MiB',
      maxMediaItemBytes: '15MiB',
      maxTotalMediaBytes: '15MiB',
    }));

    expect(limits.snapshotShardMaxBytes).toBe(24 * 1024 ** 2);
  });

  it('rejects a shard limit above the configured server limit', () => {
    expect(() => parseContactsTrashLimits(config({
      snapshotShardMaxBytes: '26MiB',
    }))).toThrow('must not exceed contactsTrash.serverFileStorage.maxSize');
  });

  it('rejects media that cannot fit after base64 expansion', () => {
    expect(() => parseContactsTrashLimits(config({
      maxMediaItemBytes: '18MiB',
      maxTotalMediaBytes: '18MiB',
    }))).toThrow('snapshot safety budget must fit');
  });
});
