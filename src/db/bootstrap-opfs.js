/**
 * Production engine bootstrap. Used by the SharedWorker. Mounts the
 * AccessHandlePoolVFS, which uses synchronous OPFS access handles - this
 * only works inside a Worker context, so do not call from the main thread.
 */

import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite.mjs';
import * as SQLite from 'wa-sqlite';
import { AccessHandlePoolVFS } from 'wa-sqlite/src/examples/AccessHandlePoolVFS.js';

import { openEngine } from './engine.js';

const DB_NAME = 'stormbox.sqlite';
const VFS_DIR = '/stormbox';

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
  const module = await SQLiteESMFactory();
  const sqlite3 = SQLite.Factory(module);

  const vfs = new AccessHandlePoolVFS(VFS_DIR);
  await vfs.isReady;
  sqlite3.vfs_register(vfs, true);

  const db = await sqlite3.open_v2(DB_NAME);
  return openEngine({ sqlite3, db });
}
