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

const MIGRATIONS = [
  { version: 1, name: '001_init', sql: migration001 },
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
  constructor(sqlite3, db) {
    this.sqlite3 = sqlite3;
    this.db = db;
    this._closed = false;
  }

  /**
   * Run a SQL string with no parameters, supporting multi-statement input
   * (e.g. migration files). Result rows are discarded.
   */
  async exec(sql) {
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
   * Callback receives this Engine instance.
   */
  async transaction(callback) {
    await this.exec('BEGIN');
    try {
      const result = await callback(this);
      await this.exec('COMMIT');
      return result;
    } catch (error) {
      await this.exec('ROLLBACK').catch(() => {
        // We are unwinding from a primary error; ROLLBACK errors are noise.
      });
      throw error;
    }
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
      await this.exec('BEGIN');
      await this.exec(migration.sql);
      await this.run(
        'INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)',
        ['schema_version', String(migration.version)],
      );
      await this.exec('COMMIT');
    } catch (error) {
      await this.exec('ROLLBACK').catch(() => {});
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
    await this.sqlite3.close(this.db);
    this._closed = true;
  }
}

/**
 * Exposed for tests so the migrations runner can be exercised in isolation
 * without re-importing the SQL files.
 */
export const __MIGRATIONS = MIGRATIONS;
