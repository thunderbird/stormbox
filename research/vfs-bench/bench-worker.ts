/**
 * Head-to-head SQLite VFS benchmark worker, driven by the
 * vfs-bench Playwright spec.
 *
 * The same workload runs against each VFS:
 *   - Schema mimics our hot path: `query_view_items` shaped table
 *     plus a small `messages`-shaped table, both small rows.
 *   - Foreground transactions mimic OUTBOX_APPLY_MOVE: one tx with
 *     six small statements (SELECT + DELETE + INSERT + UPDATEs).
 *   - Background "indexer" transactions mimic our metadata indexer
 *     chunks: one tx with N row inserts into query_view_items.
 *
 * We measure foreground latency under continuous background churn
 * for `durationMs`. Reported: foreground p50/p95/p99 and background
 * rows/sec.
 *
 * Each run uses a fresh database file to keep VFS comparisons fair
 * (OPFSAnyContextVFS write perf degrades with file size by design).
 */

import * as SQLite from '@journeyapps/wa-sqlite';
import SQLiteAsyncESMFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite-async.mjs';
import SQLiteSyncESMFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite.mjs';
import { OPFSAnyContextVFS } from '@journeyapps/wa-sqlite/src/examples/OPFSAnyContextVFS.js';
import { AccessHandlePoolVFS } from '@journeyapps/wa-sqlite/src/examples/AccessHandlePoolVFS.js';
import { OPFSCoopSyncVFS } from '@journeyapps/wa-sqlite/src/examples/OPFSCoopSyncVFS.js';

declare const self: DedicatedWorkerGlobalScope;

function log(message: string) {
  self.postMessage({ type: 'log', message });
}

self.addEventListener('message', async (e) => {
  const msg = e.data;
  if (msg?.type !== 'run') return;
  try {
    const result = await run(msg);
    self.postMessage({ type: 'result', result });
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: (err as Error).message,
      stack: (err as Error).stack,
    });
  }
});

type RunArgs = {
  vfs: 'opfsAnyContext' | 'accessHandlePool' | 'opfsCoopSync';
  durationMs: number;
  fgIntervalMs: number;
  bgChunk: number;
  // 0 disables the background loop entirely (solo / no-contention
  // benchmark). Non-zero means bg loop sleeps this long between
  // chunks, mirroring the indexer's 250 ms tick spacing.
  bgPauseMs: number;
};

async function run(args: RunArgs) {
  const { vfs: vfsName, durationMs, fgIntervalMs, bgChunk, bgPauseMs } = args;
  log(`vfs=${vfsName} dur=${durationMs}ms fgInterval=${fgIntervalMs}ms bgChunk=${bgChunk} bgPause=${bgPauseMs}ms`);

  // Wipe any previous benchmark DB so the test always starts from
  // an empty file. OPFSAnyContextVFS in particular degrades with
  // file size by design and we want to control that variable.
  const root = await navigator.storage.getDirectory();
  for await (const name of (root as any).keys()) {
    if (typeof name === 'string' && name.includes('vfs-bench')) {
      await root.removeEntry(name, { recursive: true }).catch(() => {});
    }
  }

  const { sqlite3, db } = await openDb(vfsName);

  // Per-connection serialisation mirroring our production Engine's
  // `_withLock` FIFO. All SQL goes through `withLock` so foreground
  // and background contend on the same queue, just like in the app.
  let tail: Promise<unknown> = Promise.resolve();
  const withLock = <T,>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn) as Promise<T>;
    tail = next.catch(() => {});
    return next;
  };

  // Schema. Foreign keys turned on so DELETE FROM messages cascades
  // realistically. journal_mode/locking are set per VFS in openDb.
  await withLock(() => exec(sqlite3, db, 'PRAGMA foreign_keys = ON'));
  await withLock(() => exec(sqlite3, db, 'PRAGMA synchronous = NORMAL'));
  await withLock(() => exec(sqlite3, db, `
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      remote_id TEXT UNIQUE,
      subject TEXT
    );
  `));
  await withLock(() => exec(sqlite3, db, `
    CREATE TABLE IF NOT EXISTS query_view_items (
      view_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      remote_id TEXT NOT NULL,
      message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      UNIQUE(view_id, position),
      UNIQUE(view_id, remote_id)
    );
  `));
  await withLock(() => exec(sqlite3, db, `
    CREATE TABLE IF NOT EXISTS query_views (
      id INTEGER PRIMARY KEY,
      total INTEGER DEFAULT 0
    );
  `));
  await withLock(() => run1(sqlite3, db, 'INSERT INTO query_views(id, total) VALUES (1, 0)', []));

  // Seed: 500 messages, 500 view items. One big transaction.
  await withLock(async () => {
    await begin(sqlite3, db);
    for (let i = 1; i <= 500; i += 1) {
      await run1(sqlite3, db, 'INSERT INTO messages(id, remote_id, subject) VALUES (?,?,?)', [
        i, `r-${i}`, `subj ${i}`,
      ]);
      await run1(sqlite3, db, 'INSERT INTO query_view_items(view_id, position, remote_id, message_id) VALUES (1, ?, ?, ?)', [
        i - 1, `r-${i}`, i,
      ]);
    }
    await run1(sqlite3, db, 'UPDATE query_views SET total = 500 WHERE id = 1', []);
    await commit(sqlite3, db);
  });

  // Report journal_mode actually in effect after our PRAGMA calls.
  // OPFSAnyContextVFS will sit at "delete" (rollback journal); the
  // sync VFSes will report whatever we successfully set.
  const jmRow = await withLock(() => get(sqlite3, db, 'PRAGMA journal_mode', []));
  log(`actual journal_mode = ${jmRow?.['journal_mode'] ?? '?'}`);

  // Concurrent workloads: background "indexer" never stops, foreground
  // "deletes" fire on a fixed cadence. Latency of each foreground tx
  // is recorded; we report p50/p95/p99 plus how many background rows
  // got written in the same window for the throughput side.
  const fgLatencies: number[] = [];
  let bgRows = 0;
  let bgTxs = 0;
  let nextMessageId = 501;
  let nextPosition = 500;
  let nextDeleteRemoteId = 1;

  const stopAt = performance.now() + durationMs;
  let stopped = false;
  setTimeout(() => { stopped = true; }, durationMs + 100);

  // Background loop: INSERT-bgChunk-rows-per-transaction, paced by
  // bgPauseMs. Queued through the same lock as the foreground so
  // contention shows up in the fg latency stats.
  //   bgPauseMs = 0   -> saturated background (worst case)
  //   bgPauseMs > 0   -> indexer-style duty cycle (more realistic)
  //   bgChunk = 0     -> no background at all (solo / floor)
  const backgroundLoop = (async () => {
    if (bgChunk === 0) return;
    while (!stopped && performance.now() < stopAt) {
      const startId = nextMessageId;
      const startPos = nextPosition;
      await withLock(async () => {
        await begin(sqlite3, db);
        for (let i = 0; i < bgChunk; i += 1) {
          const id = startId + i;
          const pos = startPos + i;
          await run1(sqlite3, db, 'INSERT INTO messages(id, remote_id, subject) VALUES (?,?,?)', [
            id, `r-${id}`, `subj ${id}`,
          ]);
          await run1(sqlite3, db, 'INSERT INTO query_view_items(view_id, position, remote_id, message_id) VALUES (1, ?, ?, ?)', [
            pos, `r-${id}`, id,
          ]);
        }
        await run1(sqlite3, db, 'UPDATE query_views SET total = total + ? WHERE id = 1', [bgChunk]);
        await commit(sqlite3, db);
      });
      nextMessageId += bgChunk;
      nextPosition += bgChunk;
      bgRows += bgChunk;
      bgTxs += 1;
      // Yield to macrotasks. Without this the sync VFS builds keep
      // the microtask queue saturated forever and the foreground
      // setTimeout never fires, which would unfairly make every sync
      // VFS look like it has infinite fg latency. Production has
      // constant macrotask interrupts (WebSocket I/O, ResizeObservers,
      // BroadcastChannel etc.) so this models real scheduling.
      await sleep(Math.max(0, bgPauseMs));
    }
  })();

  // Foreground loop: every fgIntervalMs, run a delete-equivalent
  // transaction and time it. The timed window covers the full
  // lock-wait + execution, which is exactly what the user perceives.
  const foregroundLoop = (async () => {
    await sleep(100);
    while (!stopped && performance.now() < stopAt) {
      const remoteId = `r-${nextDeleteRemoteId}`;
      nextDeleteRemoteId += 1;
      const t0 = performance.now();
      await withLock(async () => {
        await begin(sqlite3, db);
        const row = await get(sqlite3, db, 'SELECT id FROM messages WHERE remote_id = ?', [remoteId]);
        if (row?.id != null) {
          const id = Number(row.id);
          await run1(sqlite3, db, 'DELETE FROM query_view_items WHERE view_id = 1 AND remote_id = ?', [remoteId]);
          await run1(sqlite3, db, 'UPDATE query_view_items SET position = position - 1 WHERE view_id = 1 AND position > 0', []);
          await run1(sqlite3, db, 'UPDATE query_views SET total = total - 1 WHERE id = 1', []);
          await run1(sqlite3, db, 'DELETE FROM messages WHERE id = ?', [id]);
        }
        await commit(sqlite3, db);
      });
      fgLatencies.push(performance.now() - t0);
      await sleep(fgIntervalMs);
    }
  })();

  await Promise.all([backgroundLoop, foregroundLoop]);

  fgLatencies.sort((a, b) => a - b);
  const pct = (p: number) =>
    fgLatencies.length === 0
      ? 0
      : fgLatencies[Math.min(fgLatencies.length - 1, Math.floor(fgLatencies.length * p))];

  await sqlite3.close(db);

  return {
    vfs: vfsName,
    journalMode: jmRow?.['journal_mode'] ?? null,
    fgCount: fgLatencies.length,
    fgP50ms: Math.round(pct(0.5)),
    fgP95ms: Math.round(pct(0.95)),
    fgP99ms: Math.round(pct(0.99)),
    fgMaxMs: fgLatencies.length ? Math.round(fgLatencies[fgLatencies.length - 1]) : 0,
    fgMeanMs: fgLatencies.length
      ? Math.round(fgLatencies.reduce((a, b) => a + b, 0) / fgLatencies.length)
      : 0,
    bgTxs,
    bgRows,
    bgRowsPerSec: Math.round((bgRows / durationMs) * 1000),
    durationMs,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function openDb(vfsName: RunArgs['vfs']) {
  const stamp = Date.now();
  if (vfsName === 'opfsAnyContext') {
    const mod = await SQLiteAsyncESMFactory();
    const sqlite3 = SQLite.Factory(mod);
    const vfs = await OPFSAnyContextVFS.create(`bench-${stamp}-any`, mod);
    sqlite3.vfs_register(vfs, true);
    const db = await sqlite3.open_v2(`vfs-bench-any-${stamp}.sqlite`, undefined, `bench-${stamp}-any`);
    return { sqlite3, db };
  }
  if (vfsName === 'accessHandlePool') {
    const mod = await SQLiteSyncESMFactory();
    const sqlite3 = SQLite.Factory(mod);
    // AccessHandlePoolVFS stores files in a single dedicated OPFS
    // directory; each benchmark run gets its own so the previous
    // run's pool does not stick around.
    const vfs = await AccessHandlePoolVFS.create(`bench-${stamp}-pool`, mod, `vfs-bench-pool-${stamp}`);
    sqlite3.vfs_register(vfs, true);
    const db = await sqlite3.open_v2(`vfs-bench-pool-${stamp}.sqlite`, undefined, `bench-${stamp}-pool`);
    // Required pair: locking_mode=exclusive unlocks journal_mode=wal
    // on AccessHandlePoolVFS (which only supports a single connection).
    await exec(sqlite3, db, 'PRAGMA locking_mode = EXCLUSIVE');
    await exec(sqlite3, db, 'PRAGMA journal_mode = WAL');
    return { sqlite3, db };
  }
  if (vfsName === 'opfsCoopSync') {
    const mod = await SQLiteSyncESMFactory();
    const sqlite3 = SQLite.Factory(mod);
    const vfs = await OPFSCoopSyncVFS.create(`bench-${stamp}-coop`, mod);
    sqlite3.vfs_register(vfs, true);
    const db = await sqlite3.open_v2(`vfs-bench-coop-${stamp}.sqlite`, undefined, `bench-${stamp}-coop`);
    return { sqlite3, db };
  }
  throw new Error(`unknown vfs: ${vfsName}`);
}

async function exec(sqlite3: any, db: number, sql: string) {
  for await (const stmt of sqlite3.statements(db, sql)) {
    while ((await sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
      // discard
    }
  }
}

async function begin(sqlite3: any, db: number) {
  await exec(sqlite3, db, 'BEGIN');
}

async function commit(sqlite3: any, db: number) {
  await exec(sqlite3, db, 'COMMIT');
}

async function run1(sqlite3: any, db: number, sql: string, params: any[]) {
  for await (const stmt of sqlite3.statements(db, sql)) {
    if (params.length > 0) sqlite3.bind_collection(stmt, params);
    while ((await sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
      // discard rows
    }
  }
}

async function get(sqlite3: any, db: number, sql: string, params: any[]) {
  for await (const stmt of sqlite3.statements(db, sql)) {
    if (params.length > 0) sqlite3.bind_collection(stmt, params);
    if ((await sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
      const cols = sqlite3.column_names(stmt);
      const row: Record<string, any> = {};
      for (let i = 0; i < cols.length; i += 1) {
        row[cols[i]] = sqlite3.column(stmt, i);
      }
      return row;
    }
  }
  return null;
}
