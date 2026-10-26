import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IDBFactory, IDBKeyRange, IDBRequest, forceCloseDatabase,
} from 'fake-indexeddb';
import SQLiteAsyncFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite-async.mjs';
import * as SQLite from '@journeyapps/wa-sqlite';
import { IDBBatchAtomicVFS, IDBContext } from '@journeyapps/wa-sqlite/src/examples/IDBBatchAtomicVFS';

import { openEngine } from '../../../src/db/engine';
import { createWorkerLifecycle } from '../../../src/db/worker-lifecycle';

const wasmBinary = readFileSync(new URL(
  '../../../node_modules/@journeyapps/wa-sqlite/dist/wa-sqlite-async.wasm', import.meta.url,
));
const databasePath = '/recovery.sqlite';
const expectedRows = Array.from({ length: 64 }, (_, id) => ({ id, value: `${id}:${'x'.repeat(4096)}` }));
let factory;
let connections;
let engines;
let idbName;

beforeEach(() => {
  factory = new IDBFactory();
  connections = [];
  engines = [];
  idbName = `recovery-${crypto.randomUUID()}`;
  vi.stubGlobal('indexedDB', factory);
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('IDBRequest', IDBRequest);
  const open = factory.open.bind(factory);
  vi.spyOn(factory, 'open').mockImplementation((...args) => {
    const request = open(...args);
    request.addEventListener('success', () => {
      const connection = request.result;
      // fake-indexeddb accepts arrays where Web IDL also accepts DOMStringList.
      const transaction = connection.transaction.bind(connection);
      connection.transaction = (names, ...options) => transaction(
        typeof names === 'string' ? names : Array.from(names), ...options,
      );
      connections.push(connection);
    });
    return request;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of engines) {
    if (!database.abandoned) await database.engine.close();
    database.vfs.close();
  }
  for (const connection of connections) connection.close();
  vi.unstubAllGlobals();
});

async function open(exclusive) {
  const module = await SQLiteAsyncFactory({ wasmBinary });
  const sqlite3 = SQLite.Factory(module);
  let context;
  const create = IDBContext.create;
  const capture = vi.spyOn(IDBContext, 'create').mockImplementation(async (...args) => {
    context = await create(...args);
    return context;
  });
  let vfs;
  try {
    vfs = await IDBBatchAtomicVFS.create(idbName, module, { lockPolicy: 'exclusive' });
  } finally {
    capture.mockRestore();
  }
  sqlite3.vfs_register(vfs, true);
  const db = await sqlite3.open_v2(databasePath, undefined, idbName);
  const engine = await openEngine({ sqlite3, db, exclusive, upTo: 0 });
  const database = { engine, vfs, context, abandoned: false };
  engines.push(database);
  await engine.exec('PRAGMA cache_size = 8');
  return database;
}

async function seed(engine) {
  await engine.exec('CREATE TABLE entries(id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  await engine.transaction(async tx => {
    for (const row of expectedRows) await tx.run('INSERT INTO entries VALUES (?, ?)', [row.id, row.value]);
  });
}

const rows = engine => engine.all('SELECT id, value FROM entries ORDER BY id');

async function storedRecords() {
  const connection = await new Promise((resolve, reject) => {
    const request = factory.open(idbName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = connection.transaction(['metadata', 'blocks']);
      const metadata = tx.objectStore('metadata').getAll();
      const blocks = tx.objectStore('blocks').getAll();
      tx.oncomplete = () => resolve({ metadata: metadata.result, blocks: blocks.result });
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    connection.close();
  }
}

async function expectSpill() {
  const { metadata, blocks } = await storedRecords();
  expect(metadata.find(file => file.name === `${databasePath}-journal`).fileSize).toBeGreaterThan(0);
  const main = metadata.find(file => file.name === databasePath);
  expect(main.pendingVersion).toBeTypeOf('number');
  expect(blocks.some(block => block.path === databasePath && block.version === main.pendingVersion)).toBe(true);
}

async function abandon(database) {
  // Discard the connection at a persisted checkpoint, without SQLite cleanup.
  await database.context.sync(true);
  database.abandoned = true;
  for (const connection of connections) forceCloseDatabase(connection);
  const lockVfs = Object.getPrototypeOf(IDBBatchAtomicVFS.prototype);
  for (const [fileId, file] of database.vfs.mapIdToFile) {
    if (file.flags & SQLite.SQLITE_OPEN_MAIN_DB) {
      await lockVfs.jUnlock.call(database.vfs, fileId, SQLite.SQLITE_LOCK_NONE);
    }
  }
}

async function expectRecovered(exclusive, expected = expectedRows) {
  const { engine } = await open(exclusive);
  expect(await rows(engine)).toEqual(expected);
  expect(await engine.all('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  const { metadata, blocks } = await storedRecords();
  const main = metadata.find(file => file.name === databasePath);
  expect(main.pendingVersion).toBeUndefined();
  expect(blocks.some(block => block.path === databasePath && block.version < main.version)).toBe(false);
  expect(metadata.find(file => file.name === `${databasePath}-journal`)?.fileSize ?? 0).toBe(0);
  await engine.run('INSERT INTO entries VALUES (?, ?)', [999, 'after recovery']);
  expect(await engine.get('SELECT value FROM entries WHERE id = 999')).toEqual({ value: 'after recovery' });
}

for (const exclusive of [false, true]) {
  describe(exclusive ? 'exclusive locking' : 'normal locking', () => {
    it('commits and rolls back large transactions across journal reuse', async () => {
      const { engine } = await open(exclusive);
      expect(await engine.get('PRAGMA main.locking_mode')).toEqual({ locking_mode: exclusive ? 'exclusive' : 'normal' });
      expect(await engine.get('PRAGMA main.journal_size_limit')).toEqual({ journal_size_limit: exclusive ? 0 : -1 });
      await seed(engine);
      await engine.transaction(async tx => {
        await tx.exec("UPDATE entries SET value = 'committed:' || value");
      });
      if (exclusive) {
        const { metadata } = await storedRecords();
        expect(metadata.find(file => file.name === `${databasePath}-journal`).fileSize).toBe(0);
      }
      await expect(engine.transaction(async tx => {
        await tx.exec("UPDATE entries SET value = 'rolled back:' || value");
        await expectSpill();
        throw new Error('cancel transaction');
      })).rejects.toThrow('cancel transaction');
      const committed = expectedRows.map(row => ({ ...row, value: `committed:${row.value}` }));
      expect(await rows(engine)).toEqual(committed);
      await engine.close();
      await expectRecovered(exclusive, committed);
    });

    it('recovers a spilled transaction from a persisted checkpoint without rollback', async () => {
      const database = await open(exclusive);
      await seed(database.engine);
      await database.engine.exec("BEGIN IMMEDIATE; UPDATE entries SET value = 'unfinished:' || value");
      await expectSpill();
      await abandon(database);
      await expectRecovered(exclusive);
    });

    it('preserves a committed transaction in a persisted checkpoint', async () => {
      const database = await open(exclusive);
      await seed(database.engine);
      await database.engine.exec("UPDATE entries SET value = 'committed:' || value");
      await abandon(database);
      await expectRecovered(exclusive, expectedRows.map(row => ({ ...row, value: `committed:${row.value}` })));
    });

    it.each([SQLite.SQLITE_IOERR_WRITE, SQLite.SQLITE_FULL])('rolls back a spill-write fault when the VFS returns %i', async code => {
      const database = await open(exclusive);
      await seed(database.engine);
      const write = database.vfs.jWrite;
      let mainWrites = 0;
      let injected = 0;
      const fault = vi.spyOn(database.vfs, 'jWrite').mockImplementation(function (...args) {
        const file = this.mapIdToFile.get(args[0]);
        if (file.path === databasePath && ++mainWrites === 4) {
          injected++;
          return code;
        }
        return write.apply(this, args);
      });
      await expect(database.engine.transaction(tx => tx.exec("UPDATE entries SET value = 'failed:' || value")))
        .rejects.toMatchObject({ code: code & 0xff });
      expect(injected).toBe(1);
      fault.mockRestore();
      expect(await rows(database.engine)).toEqual(expectedRows);
      expect(await database.engine.all('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      await database.engine.run('INSERT INTO entries VALUES (?, ?)', [1000, 'live recovery']);
      await abandon(database);
      await expectRecovered(exclusive, [...expectedRows, { id: 1000, value: 'live recovery' }]);
    });

    it('recovers a persisted checkpoint when the handoff cleanup deadline expires', async () => {
      const database = await open(exclusive);
      await seed(database.engine);
      let reached;
      const spilled = new Promise(resolve => { reached = resolve; });
      const never = new Promise(() => {});
      let didRestart;
      const restarted = new Promise(resolve => { didRestart = resolve; });
      const lifecycle = createWorkerLifecycle({ restart: didRestart });
      const closeStorage = vi.fn(() => database.engine.close());
      const handlers = lifecycle.requestHandlers({ write: () => database.engine.transaction(async tx => {
        await tx.exec("UPDATE entries SET value = 'unfinished:' || value");
        await expectSpill();
        reached();
        await never;
      }) }, { stopSync: async () => {}, closeStorage });
      void handlers.write();
      await spilled;
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await lifecycle.requestRestart();
      await restarted;
      expect(closeStorage).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith('[shared-worker]', expect.stringContaining('Worker cleanup exceeded five seconds.'));
      await abandon(database);
      await expectRecovered(exclusive);
    }, 15_000);
  });
}
