/**
 * In-memory engine bootstrap for unit tests and stories. Uses the
 * sync wa-sqlite build with the library's built-in default VFS and
 * SQLite's native ':memory:' DB - no OPFS, no persistence.
 *
 * Each call returns a fresh Engine with its own database; tests that need
 * isolation should not share Engines.
 *
 * Works in both Node (vitest) and browser contexts. Under Node the WASM
 * binary is loaded from disk via fs because there is no fetch handler
 * for the package's relative wa-sqlite.wasm URL.
 */

import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite.mjs';
import * as SQLite from 'wa-sqlite';

import { openEngine } from './engine.js';

const isNode =
  typeof process !== 'undefined' && process.versions != null && process.versions.node != null;

let sqlite3Promise = null;

function getSqlite3() {
  if (sqlite3Promise) {
    return sqlite3Promise;
  }
  sqlite3Promise = (async () => {
    let module;
    if (!isNode) {
      module = await SQLiteESMFactory();
    } else {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const wasmUrl = new URL(
        '../../node_modules/wa-sqlite/dist/wa-sqlite.wasm',
        import.meta.url,
      );
      const wasmBinary = readFileSync(fileURLToPath(wasmUrl));
      module = await SQLiteESMFactory({ wasmBinary });
    }
    return SQLite.Factory(module);
  })();
  return sqlite3Promise;
}

/**
 * Open a fresh in-memory database. The wa-sqlite module is cached per
 * process; each call gets a new ':memory:' DB so tests do not leak rows
 * into each other.
 */
export async function bootTestEngine() {
  const sqlite3 = await getSqlite3();
  const db = await sqlite3.open_v2(':memory:');
  return openEngine({ sqlite3, db });
}
