/**
 * Production engine bootstrap. Used by the SharedWorker.
 *
 * Stores the database in OPFS via @journeyapps/wa-sqlite's
 * OPFSAnyContextVFS. This VFS uses the async OPFS APIs
 * (FileSystemFileHandle.getFile / createWritable) rather than the
 * synchronous access-handle API that Firefox restricts to dedicated
 * workers. As a result it works in any worker context - including the
 * SharedWorker that Stormbox needs for multi-tab safety - on every
 * browser that supports OPFS at all (Chromium, Firefox, Safari).
 *
 * Pairs with the asyncify build of wa-sqlite (`wa-sqlite-async.mjs`)
 * and the built-in WebLocksMixin for SQLite-style locking across
 * connections.
 */

import SQLiteAsyncESMFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite-async.mjs';
import * as SQLite from '@journeyapps/wa-sqlite';
import { OPFSAnyContextVFS } from '@journeyapps/wa-sqlite/src/examples/OPFSAnyContextVFS.js';

import { openEngine } from './engine.js';

const DB_NAME = 'stormbox.sqlite';
const VFS_NAME = 'opfs-stormbox';

let bootPromise = null;

/**
 * Boot the production engine once per worker process and return the same
 * Engine on subsequent calls. A SharedWorker only runs one process per
 * origin, so this is effectively a singleton across all tabs.
 */
export function bootProductionEngine() {
  if (bootPromise) {
    return bootPromise;
  }
  bootPromise = doBoot();
  return bootPromise;
}

async function doBoot() {
  const module = await SQLiteAsyncESMFactory();
  const sqlite3 = SQLite.Factory(module);

  // VFS registration is process-singleton; vfs_register throws on a
  // duplicate. During dev HMR reloads we may run this twice on the same
  // module instance, so tolerate the duplicate error.
  try {
    const vfs = await OPFSAnyContextVFS.create(VFS_NAME, module);
    sqlite3.vfs_register(vfs, true);
  } catch (error) {
    if (!/already registered/.test(error?.message ?? '')) {
      throw error;
    }
  }

  const db = await sqlite3.open_v2(DB_NAME, undefined, VFS_NAME);
  return openEngine({ sqlite3, db });
}
