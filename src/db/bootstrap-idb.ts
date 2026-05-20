/**
 * Production engine bootstrap. Used by the SharedWorker.
 *
 * Stores the database in IndexedDB via @journeyapps/wa-sqlite's
 * IDBBatchAtomicVFS. IDBBatchAtomicVFS leverages IndexedDB's batch
 * atomic transactions in place of an external SQLite journal file,
 * which is how it achieves competitive write performance without
 * needing WAL.
 *
 * Why IndexedDB and not OPFS:
 *
 * - The two OPFS VFSes that work in a SharedWorker (OPFSAnyContextVFS
 *   and OPFSAdaptiveVFS) cannot use SQLite WAL because OPFS's async
 *   API does not support the shared-memory primitives WAL needs.
 *   OPFSAnyContextVFS in particular is documented by its author as
 *   "very bad" for writes and "increasingly worse as the file grows".
 * - The faster OPFS VFSes (AccessHandlePoolVFS, OPFSCoopSyncVFS) use
 *   `createSyncAccessHandle`, which Firefox only exposes in dedicated
 *   workers - incompatible with our SharedWorker topology.
 * - IDBBatchAtomicVFS works in any worker context, supports multiple
 *   connections, and benches 5-8x faster than OPFSAnyContextVFS on
 *   both Chromium and Firefox for our workload (see
 *   research/vfs-bench/ and research/README.md for the matrix).
 *
 * `lockPolicy: 'exclusive'` is correct for our single-connection
 * SharedWorker setup; it avoids per-call lock churn on the underlying
 * `navigator.locks` mutex.
 *
 * Pairs with the asyncify build of wa-sqlite (`wa-sqlite-async.mjs`).
 */

import SQLiteAsyncESMFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite-async.mjs';
import * as SQLite from '@journeyapps/wa-sqlite';
import { IDBBatchAtomicVFS } from '@journeyapps/wa-sqlite/src/examples/IDBBatchAtomicVFS.js';

import { openEngine } from './engine.js';

const DB_NAME = 'stormbox.sqlite';
const VFS_NAME = 'idb-stormbox';
// Legacy OPFS storage from before the IDB switch. Cleared once on
// first boot of this version so the user doesn't keep paying quota
// for an unreachable database. Stormbox is alpha and treats the
// cache as disposable (the server owns the data), so blowing this
// away unconditionally is fine.
const LEGACY_OPFS_FILE = 'stormbox.sqlite';

let bootPromise = null;

/**
 * Boot the production engine once per worker process and return the
 * same Engine on subsequent calls. A SharedWorker only runs one
 * process per origin, so this is effectively a singleton across all
 * tabs.
 */
export function bootProductionEngine() {
  if (bootPromise) {
    return bootPromise;
  }
  bootPromise = doBoot();
  return bootPromise;
}

async function doBoot() {
  await cleanupLegacyOpfsDb().catch(() => {
    // Best-effort: a failure here just leaves stale OPFS bytes
    // unreferenced, it does not block the new engine.
  });

  const module = await SQLiteAsyncESMFactory();
  const sqlite3 = SQLite.Factory(module);

  // VFS registration is process-singleton; vfs_register throws on a
  // duplicate. During dev HMR reloads we may run this twice on the
  // same module instance, so tolerate the duplicate error.
  try {
    const vfs = await IDBBatchAtomicVFS.create(VFS_NAME, module, {
      lockPolicy: 'exclusive',
    });
    sqlite3.vfs_register(vfs, true);
  } catch (error) {
    if (!/already registered/.test(error?.message ?? '')) {
      throw error;
    }
  }

  const db = await sqlite3.open_v2(DB_NAME, undefined, VFS_NAME);
  return openEngine({ sqlite3, db });
}

async function cleanupLegacyOpfsDb() {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    return;
  }
  const root = await navigator.storage.getDirectory();
  // OPFSAnyContextVFS stored the database under its own name with
  // no prefix; also clean up sidecar journal files just in case.
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    await root.removeEntry(LEGACY_OPFS_FILE + suffix).catch(() => {
      // Not present is the expected case for new installs.
    });
  }
}
