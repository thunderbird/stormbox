/**
 * wa-sqlite engine wrapper. Pure SQLite plumbing: small, promise-friendly
 * query API and a migration runner. Does not know about VFSes; callers
 * register one (or none) before constructing.
 *
 * Bootstrap modules:
 *   bootstrap-opfs.js   - production SharedWorker (OPFS via AccessHandlePoolVFS)
 *   bootstrap-memory.js - tests and stories (built-in default VFS, ':memory:')
 */

import * as SQLite from '@journeyapps/wa-sqlite';

import migration001 from './migrations/001_init.sql?raw';
import migration002 from './migrations/002_outbox_runner.sql?raw';

const MIGRATIONS = [
  { version: 1, name: '001_init', sql: migration001 },
  { version: 2, name: '002_outbox_runner', sql: migration002 },
];

/**
 * @param {object} args
 * @param {object} args.sqlite3 wa-sqlite Factory output
 * @param {number} args.db opaque sqlite3 db pointer (already opened by caller)
 * @param {boolean} [args.useWal=true] apply PRAGMA journal_mode=WAL on open
 *   (no-op for ':memory:' databases; SQLite quietly keeps memory journals)
 * @returns {Promise<Engine>}
 */
export async function openEngine({ sqlite3, db, useWal = true }) {
  const engine = new Engine(sqlite3, db);
  await engine.exec('PRAGMA foreign_keys = ON');
  if (useWal) {
    await engine.exec('PRAGMA journal_mode = WAL').catch(() => {
      // ':memory:' databases ignore journal_mode changes silently in some
      // builds, raise in others; either is fine for our purposes.
    });
    await engine.exec('PRAGMA synchronous = NORMAL').catch(() => {});
  }
  await engine.runMigrations();
  return engine;
}

export class Engine {
  sqlite3: any;
  db: any;
  _closed: boolean;
  _tail: Promise<any>;

  constructor(sqlite3: any, db: any) {
    this.sqlite3 = sqlite3;
    this.db = db;
    this._closed = false;
    // wa-sqlite uses a single connection handle and step() yields the
    // event loop between rows. Two concurrent operations on the same
    // handle interleave at the step level and deadlock. We serialise
    // every public SQL call on a per-engine promise tail.
    this._tail = Promise.resolve();
  }

  /**
   * Acquire the engine lock and run fn with it held. The lock chain
   * stays alive even on rejection, so failures do not poison later
   * tasks.
   */
  _withLock(fn) {
    const next = this._tail.then(fn, fn);
    this._tail = next.catch(() => {});
    return next;
  }

  /**
   * Run a SQL string with no parameters, supporting multi-statement input
   * (e.g. migration files). Result rows are discarded.
   */
  async exec(sql) {
    return this._withLock(() => this._execRaw(sql));
  }

  async _execRaw(sql) {
    for await (const stmt of this.sqlite3.statements(this.db, sql)) {
      while ((await this.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
        // Multi-statement DDL may include SELECTs; discard their rows.
      }
    }
  }

  /**
   * Run a parameterised single-statement SQL and return all result rows
   * as objects keyed by column name. Statements with multi-statement SQL
   * are not supported here; use exec() for that.
   */
  async all(sql, params = []) {
    return this._withLock(() => this._allRaw(sql, params));
  }

  async _allRaw(sql, params) {
    return this._withStatement(sql, async (stmt) => {
      this._bindParams(stmt, params);
      const rows = [];
      while ((await this.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
        const columns = this.sqlite3.column_names(stmt);
        const row = {};
        for (let i = 0; i < columns.length; i += 1) {
          row[columns[i]] = this.sqlite3.column(stmt, i);
        }
        rows.push(row);
      }
      return rows;
    });
  }

  async get(sql, params = []) {
    const rows = await this.all(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Run a parameterised single-statement write. Returns
   * { changes, lastInsertRowid }. lastInsertRowid is read via a follow-up
   * SELECT because wa-sqlite does not expose sqlite3_last_insert_rowid as
   * a JS binding; the value is per-connection so the sequencing is safe
   * under the single-threaded JS model.
   */
  async run(sql, params = []) {
    return this._withLock(() => this._runRaw(sql, params));
  }

  async _runRaw(sql, params) {
    const result = await this._withStatement(sql, async (stmt) => {
      this._bindParams(stmt, params);
      while ((await this.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
        // RETURNING clauses produce rows; we ignore them for run() callers.
      }
      return {
        changes: this.sqlite3.changes(this.db),
      };
    });
    const ridRow = await this._withStatement(
      'SELECT last_insert_rowid() AS rid',
      async (stmt) => {
        await this.sqlite3.step(stmt);
        return this.sqlite3.column(stmt, 0);
      },
    );
    result.lastInsertRowid = Number(ridRow ?? 0);
    return result;
  }

  /**
   * Run a callback inside a deferred transaction. Rolls back on throw.
   * The whole transaction acquires the engine lock once and the
   * callback receives a TxContext that lets it run SQL on the held
   * connection without re-acquiring (which would deadlock against the
   * lock the transaction itself owns).
   *
   * Important: do NOT call methods on the parent Engine from inside
   * the callback - those would queue behind the very transaction
   * holding the lock. Always use the `tx` argument.
   */
  async transaction(callback) {
    return this._withLock(async () => {
      const tx = new TxContext(this);
      await this._execRaw('BEGIN');
      try {
        const result = await callback(tx);
        await this._execRaw('COMMIT');
        return result;
      } catch (error) {
        await this._execRaw('ROLLBACK').catch(() => {
          // We are unwinding from a primary error; ROLLBACK errors are noise.
        });
        throw error;
      }
    });
  }

  async runMigrations() {
    const hasMeta = await this._tableExists('schema_meta');
    let currentVersion = 0;
    if (hasMeta) {
      const row = await this.get(
        'SELECT value FROM schema_meta WHERE key = ?',
        ['schema_version'],
      );
      currentVersion = row ? Number(row.value) : 0;
    }

    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) {
        continue;
      }
      await this._applyMigration(migration);
      currentVersion = migration.version;
    }
  }

  async _applyMigration(migration) {
    try {
      await this.transaction(async (tx) => {
        await tx.exec(migration.sql);
        await tx.run(
          'INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)',
          ['schema_version', String(migration.version)],
        );
      });
    } catch (error) {
      const wrapped = new Error(
        `Migration ${migration.name} (v${migration.version}) failed: ${error.message}`,
      );
      wrapped.cause = error;
      throw wrapped;
    }
  }

  async _tableExists(name) {
    const row = await this.get(
      `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
      [name],
    );
    return row !== null;
  }

  /**
   * Prepare a single-statement SQL via the statements() async generator,
   * run the callback against the prepared stmt, then finalize. The
   * generator's finally block guarantees finalize even on throw.
   */
  async _withStatement(sql, fn) {
    const iter = this.sqlite3.statements(this.db, sql);
    let result;
    let executed = false;
    try {
      const next = await iter.next();
      if (next.done) {
        throw new Error(`No statement compiled from SQL: ${sql}`);
      }
      const stmt = next.value;
      executed = true;
      result = await fn(stmt);
      // Tell the generator to finalize and check for trailing SQL.
      const tail = await iter.next();
      if (!tail.done) {
        throw new Error(`Multi-statement SQL passed to single-statement helper: ${sql}`);
      }
    } finally {
      if (executed) {
        await iter.return?.();
      }
    }
    return result;
  }

  _bindParams(stmt, params) {
    for (let i = 0; i < params.length; i += 1) {
      const value = params[i];
      const slot = i + 1;
      if (value === null || value === undefined) {
        this.sqlite3.bind_null(stmt, slot);
      } else if (typeof value === 'number') {
        if (Number.isInteger(value)) {
          // SQLite INTEGER columns are 64-bit; epoch-ms timestamps and
          // similar values overflow bind_int's 32-bit slot. Use int64.
          this.sqlite3.bind_int64(stmt, slot, BigInt(value));
        } else {
          this.sqlite3.bind_double(stmt, slot, value);
        }
      } else if (typeof value === 'bigint') {
        this.sqlite3.bind_int64(stmt, slot, value);
      } else if (typeof value === 'boolean') {
        this.sqlite3.bind_int(stmt, slot, value ? 1 : 0);
      } else if (value instanceof Uint8Array) {
        this.sqlite3.bind_blob(stmt, slot, value);
      } else {
        this.sqlite3.bind_text(stmt, slot, String(value));
      }
    }
  }

  async close() {
    if (this._closed) {
      return;
    }
    // Wait for the engine lock before tearing down the connection.
    // _withStatement finalizes prepared statements in its finally
    // block, and that finally only runs after the awaited fn()
    // resolves; closing while another caller is between the await
    // and the finally would orphan its statement and the wa-sqlite
    // close() would throw "unable to close due to unfinalized
    // statements". Acquiring the lock here drains everything that
    // is currently queued, including the trailing await iter.return?
    // microtask, so close observes a quiesced connection.
    await this._withLock(async () => {});
    await this.sqlite3.close(this.db);
    this._closed = true;
  }
}

/**
 * Lock-free SQL view of the engine, only valid within a transaction
 * callback. Mirrors the public Engine SQL interface but routes through
 * the engine's *Raw private methods so it doesn't try to re-acquire the
 * lock the transaction is already holding.
 */
class TxContext {
  _engine: Engine;

  constructor(engine: Engine) {
    this._engine = engine;
  }

  exec(sql: string) {
    return (this._engine as any)._execRaw(sql);
  }

  async all(sql: string, params: any[] = []) {
    return (this._engine as any)._allRaw(sql, params);
  }

  async get(sql: string, params: any[] = []) {
    const rows = await (this._engine as any)._allRaw(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  run(sql: string, params: any[] = []) {
    return (this._engine as any)._runRaw(sql, params);
  }
}

/**
 * Exposed for tests so the migrations runner can be exercised in isolation
 * without re-importing the SQL files.
 */
export const __MIGRATIONS = MIGRATIONS;
