/**
 * Regression coverage for the metadata indexer: the worker-side
 * background sync that fills in folder pages past the first page so
 * the user gets a full positional index without having to scroll
 * through every page manually.
 *
 * These tests drive _runMetadataIndexerChunk directly (no timer) so
 * we can step the indexer through several chunks and verify both
 * query_view_ranges and the queryViewProgress percent the FolderNode
 * UI reads from.
 *
 * Why this file exists: a previous patch quietly broke the indexer —
 * loading stopped at 100 messages and the percent indicator in the
 * folder tree disappeared. There was no unit test against the
 * indexer at the time so the regression slipped through. Adding
 * direct coverage closes that gap.
 */

import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';

import { bootTestEngine } from '../../../src/db/bootstrap-memory.js';
import { makeHandlers } from '../../../src/db/handlers.js';
import { DB_RPC } from '../../../src/db/protocol.js';
import { JmapBackend } from '../../../src/sync/backends/jmap/backend.js';
import { MockTransport } from './_mock-transport.js';

const INBOX_TOTAL = 350; // ~3.5 pages of 100 each

let engine;
let handlers;
let account;
let inbox;
let transport;
let backend;

function emailFixture(id) {
  return {
    id,
    blobId: `b-${id}`,
    threadId: `t-${id}`,
    mailboxIds: { 'mb-inbox': true },
    keywords: {},
    size: 100,
    receivedAt: '2026-05-01T12:00:00Z',
    sentAt: '2026-05-01T11:59:00Z',
    messageId: [`<${id}@example.com>`],
    from: [{ email: 'from@example.com' }],
    to: [{ email: 'to@example.com' }],
    sender: [{ email: 'sender@example.com' }],
    subject: `subject ${id}`,
    preview: `preview ${id}`,
    hasAttachment: false,
  };
}

beforeEach(async () => {
  engine = await bootTestEngine();
  handlers = makeHandlers(engine);
  account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
    displayName: 'T',
    primaryEmail: 't@example.com',
    serverOrigin: 'https://mail.example.com',
    remoteAccountId: 'acct-1',
    isPrimary: true,
  })).row;

  // Pre-create the Inbox folder row directly so we don't have to
  // round-trip syncMailboxes for these tests; the indexer reads
  // straight out of folders.
  await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
    accountId: account.id,
    folders: [{
      remoteId: 'mb-inbox',
      name: 'Inbox',
      role: 'inbox',
      totalEmails: INBOX_TOTAL,
      unreadEmails: 0,
    }],
  });
  inbox = await engine.get(
    'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
    [account.id, 'mb-inbox'],
  );

  transport = new MockTransport();
  transport.handle('Email/query', (params) => {
    // Stalwart-style positional Email/query: return up to `limit`
    // ids starting from `position`, plus an authoritative total.
    const position = Number(params.position ?? 0);
    const limit = Number(params.limit ?? 100);
    const ids = [];
    for (let i = position; i < Math.min(position + limit, INBOX_TOTAL); i += 1) {
      ids.push(`e-${i}`);
    }
    return {
      accountId: account.remote_account_id,
      filter: params.filter,
      sort: params.sort,
      queryState: `qs-${position}-${ids.length}`,
      canCalculateChanges: true,
      position,
      total: INBOX_TOTAL,
      ids,
    };
  });
  transport.handle('Email/get', (params) => ({
    accountId: account.remote_account_id,
    state: 'es',
    list: (params.ids ?? []).map(emailFixture),
    notFound: [],
  }));

  backend = makeBackend();
});

/**
 * Build a JmapBackend wired to the test engine + transport. Tests
 * that want to step chunk-by-chunk pass `indexerChunksPerTick: 1`
 * (matches the pre-speedup behaviour); tests that want to exercise
 * the production batching default leave it at 5.
 */
function makeBackend(options = {}) {
  const b = new JmapBackend({
    transport,
    serverOrigin: 'https://mail.example.com',
    handlers,
    options: { useWebSocket: false, ...options },
  });
  // Skip start() (which would talk to a real session); pretend
  // session ingest already happened.
  b.account = account;
  b._started = true;
  return b;
}

afterEach(async () => {
  if (backend?.outboxRunner) await backend.outboxRunner.stop();
  await engine.close();
});

async function readRanges() {
  return engine.all(
    `SELECT qv.folder_id, qr.start_position, qr.end_position
       FROM query_view_ranges qr
       JOIN query_views qv ON qv.id = qr.view_id
      WHERE qv.account_id = ?
      ORDER BY qv.folder_id, qr.start_position`,
    [account.id],
  );
}

async function readProgress(folderId) {
  return handlers[DB_RPC.QUERY_VIEW_PROGRESS]({
    accountId: account.id,
    folderId,
    sort: 'received',
  });
}

describe('metadata indexer: fills folder views past the first page', () => {
  it('continues fetching beyond position 100 across multiple chunks (chunks-per-tick=1)', async () => {
    // With indexerChunksPerTick=1, each tick advances the covered
    // range by exactly one chunk. This is the pre-speedup behaviour;
    // we keep coverage of it so the single-chunk path stays sound
    // (e.g. if we ever throttle back per-account).
    backend = makeBackend({ indexerChunksPerTick: 1 });

    const initial = await backend.ensureFolderWindow(inbox.id, { offset: 0, limit: 100 });
    expect(initial.total).toBe(INBOX_TOTAL);

    let ranges = await readRanges();
    expect(ranges).toEqual([
      { folder_id: inbox.id, start_position: 0, end_position: 100 },
    ]);

    await backend._runMetadataIndexerChunk();
    ranges = await readRanges();
    expect(ranges.map((r) => `${r.start_position}-${r.end_position}`)).toEqual([
      '0-100', '100-200',
    ]);

    await backend._runMetadataIndexerChunk();
    ranges = await readRanges();
    expect(ranges.map((r) => `${r.start_position}-${r.end_position}`)).toEqual([
      '0-100', '100-200', '200-300',
    ]);

    await backend._runMetadataIndexerChunk();
    ranges = await readRanges();
    // The fourth chunk runs against the 50-position tail (300..350)
    // because INBOX_TOTAL is 350 and the gap helper clips to the
    // authoritative total.
    expect(ranges.map((r) => `${r.start_position}-${r.end_position}`)).toEqual([
      '0-100', '100-200', '200-300', '300-350',
    ]);
  });

  it('pauses while a foreground ensureFolderWindow is in flight', async () => {
    // Regression: if the indexer ran in parallel with a user-driven
    // page load, both could end up fetching the same window. The
    // gate is the _foregroundFolderWindowCount counter; this test
    // pins that the indexer no-ops while a foreground load is mid
    // flight.
    backend._foregroundFolderWindowCount = 1;
    try {
      await backend._runMetadataIndexerChunk();
      const ranges = await readRanges();
      expect(ranges).toEqual([]);
    } finally {
      backend._foregroundFolderWindowCount = 0;
    }
    // Once the foreground caller releases the counter, the indexer
    // makes progress on the next chunk.
    await backend._runMetadataIndexerChunk();
    const ranges = await readRanges();
    expect(ranges.length).toBeGreaterThan(0);
  });

  it('feeds queryViewProgress with growing covered counts so the FolderNode percent indicator updates', async () => {
    // The FolderTree shows `folder.index_percent` next to a folder
    // name when total_emails > 100 AND 0 < percent < 100. Both the
    // mail-store (refreshFolderProgress) and the indexer
    // (_queryViewProgress) read from the same QUERY_VIEW_PROGRESS
    // handler, so a regression here breaks BOTH the indexer's
    // progress decision AND the UI badge.
    backend = makeBackend({ indexerChunksPerTick: 1 });
    await backend.ensureFolderWindow(inbox.id, { offset: 0, limit: 100 });
    let progress = await readProgress(inbox.id);
    expect(progress).toEqual({
      total: INBOX_TOTAL,
      covered: 100,
      percent: 29, // 100 / 350 ≈ 28.57 -> 29
    });

    await backend._runMetadataIndexerChunk();
    progress = await readProgress(inbox.id);
    expect(progress.covered).toBe(200);
    expect(progress.percent).toBe(57);

    await backend._runMetadataIndexerChunk();
    progress = await readProgress(inbox.id);
    expect(progress.covered).toBe(300);
    expect(progress.percent).toBe(86);

    await backend._runMetadataIndexerChunk();
    progress = await readProgress(inbox.id);
    expect(progress.covered).toBe(INBOX_TOTAL);
    expect(progress.percent).toBe(100);
  });

  it('stops scheduling further chunks once a folder is fully covered', async () => {
    // After every page is in query_view_ranges, _runMetadataIndexerChunk
    // should see `covered >= total` and skip past the folder without
    // issuing another Email/query. This is what prevents the indexer
    // from looping forever on a finished folder.
    backend = makeBackend({ indexerChunksPerTick: 1 });
    await backend.ensureFolderWindow(inbox.id, { offset: 0, limit: 100 });
    await backend._runMetadataIndexerChunk(); // 100-200
    await backend._runMetadataIndexerChunk(); // 200-300
    await backend._runMetadataIndexerChunk(); // 300-350

    const requestCountBefore = transport.requests.length;
    await backend._runMetadataIndexerChunk();
    // No new JMAP traffic — everything is covered.
    expect(transport.requests.length).toBe(requestCountBefore);
  });
});

describe('metadata indexer: production batching defaults', () => {
  it('covers a 350-message folder in a single tick at indexerChunksPerTick=5', async () => {
    // Production speedup pin: the new defaults run five back-to-back
    // round trips per tick (instead of one), so a small/medium
    // folder fully indexes in one tick rather than dripping in over
    // 75+ seconds of 2.5s ticks. INBOX_TOTAL is 350; chunkLimit is
    // 100 for folders < 500; 4 chunks of 100 covers the whole
    // folder. 5 chunks-per-tick means the tail chunk fits too.
    expect(backend._indexerChunksPerTick).toBe(5);
    expect(backend._indexerTickDelayMs).toBe(250);

    await backend.ensureFolderWindow(inbox.id, { offset: 0, limit: 100 });
    let progress = await readProgress(inbox.id);
    expect(progress.covered).toBe(100);

    await backend._runMetadataIndexerChunk();
    progress = await readProgress(inbox.id);
    expect(progress.covered).toBe(INBOX_TOTAL);
    expect(progress.percent).toBe(100);
  });

  it('caps chunks per tick at the budget even when the folder has many more gaps', async () => {
    // 5 chunks × 100 = 500 messages per tick. If the folder had say
    // 2000 messages and was empty, one tick should fetch 500 and
    // leave the remaining 1500 for subsequent ticks. We can't easily
    // resize INBOX_TOTAL mid-test, so verify the call count instead
    // — exactly one Email/query call per chunk per tick.
    backend = makeBackend({ indexerChunksPerTick: 3 });
    const beforeRequests = transport.requests.length;
    // Folder is empty (no view yet); _nextQueryViewGap returns gap
    // starting at 0. One tick = 3 chunks of 100 = positions 0..300.
    await backend._runMetadataIndexerChunk();
    const queryCalls = transport.requests.length - beforeRequests;
    expect(queryCalls).toBe(3);
    const progress = await readProgress(inbox.id);
    expect(progress.covered).toBe(300);
  });
});

describe('metadata indexer: chunk-size selection', () => {
  it('uses 100 for small folders and 500 for everything ≥500', async () => {
    // Pure unit-level pin on the tiering function — keeps the
    // contract visible to anyone tweaking the boundaries.
    // Stalwart measurement: 500-per-chunk has the best per-record
    // throughput (~9ms/record) vs 100 (~14ms/record), so big
    // folders amortise the round trip and small ones stay at 100
    // to avoid over-fetching.
    expect(backend._selectIndexerChunkSize(0, null)).toBe(100);
    expect(backend._selectIndexerChunkSize(499, null)).toBe(100);
    expect(backend._selectIndexerChunkSize(500, null)).toBe(500);
    expect(backend._selectIndexerChunkSize(5_000, null)).toBe(500);
    expect(backend._selectIndexerChunkSize(50_000, null)).toBe(500);
  });

  it('clamps to the server-advertised maxObjectsInGet cap', async () => {
    // RFC 8620 §3.5 — Email/get with more than maxObjectsInGet ids
    // gets a 'tooManyObjectsInGet' SetError. Clamp protects us from
    // ever asking for more than the server is willing to serve.
    expect(backend._selectIndexerChunkSize(10_000, 100)).toBe(100);
    expect(backend._selectIndexerChunkSize(10_000, 50)).toBe(50);
    // If the server cap is generous, the tier still wins.
    expect(backend._selectIndexerChunkSize(800, 999_999)).toBe(500);
  });

  it('reads maxObjectsInGet out of account_capabilities', async () => {
    // Seed the jmap-core capability with a small cap. _loadMaxObjectsInGetCap
    // should cache the value on first read.
    await handlers[DB_RPC.ACCOUNT_CAPABILITIES_REPLACE]({
      accountId: account.id,
      serviceKind: 'jmap-mail',
      capabilities: {
        'urn:ietf:params:jmap:core': {
          maxObjectsInGet: 75,
          maxObjectsInSet: 100,
          maxConcurrentRequests: 4,
        },
      },
    });
    const cap = await backend._loadMaxObjectsInGetCap();
    expect(cap).toBe(75);
    // Cached: a second call returns the same value without reading
    // account_capabilities again. Hard to assert directly; cover by
    // dropping the row and re-querying — the cached value must win.
    await engine.run(
      `DELETE FROM account_capabilities WHERE account_id = ?`,
      [account.id],
    );
    expect(await backend._loadMaxObjectsInGetCap()).toBe(75);
  });

  it('returns null cap when the server did not advertise one', async () => {
    // No core capability registered for this account. The indexer
    // falls back to the tier's target without clamping.
    expect(await backend._loadMaxObjectsInGetCap()).toBeNull();
    expect(backend._selectIndexerChunkSize(10_000, null)).toBe(500);
  });
});

describe('metadata indexer: yields to foreground requests mid-tick', () => {
  it('aborts the in-tick chunk loop when _foregroundFolderWindowCount becomes positive', async () => {
    // Without this, a 5-chunk tick locks the WebSocket for ~25s on
    // a big folder. The user clicks something during that window
    // and their ensureFolderWindow has to queue behind all 5
    // indexer chunks. The yield check inside ensureFolderIndex
    // (gated on `yieldToForeground: true`, which only the indexer
    // sets) breaks the loop the moment a foreground caller bumps
    // the counter.
    backend = makeBackend({ indexerChunksPerTick: 5 });
    let chunksDone = 0;
    // Intercept Email/query so we can simulate "foreground arrives
    // mid-tick" between two chunks.
    const originalQuery = transport._handlers.get('Email/query');
    transport.handle('Email/query', (params) => {
      chunksDone += 1;
      if (chunksDone === 2) {
        // After the SECOND chunk is requested, pretend a foreground
        // load just started. ensureFolderIndex should see this and
        // break before chunk 3 runs.
        backend._foregroundFolderWindowCount = 1;
      }
      return originalQuery(params);
    });

    await backend._runMetadataIndexerChunk();

    // Two chunks ran (the one that triggered the foreground gate
    // does still complete its in-flight query) and the loop broke
    // before chunk 3, 4, 5.
    expect(chunksDone).toBe(2);
    backend._foregroundFolderWindowCount = 0;
  });

  it('does NOT yield when yieldToForeground is omitted (foreground callers must complete their own multi-chunk requests)', async () => {
    // Belt-and-braces: a foreground caller that passes a large
    // limit + maxChunks must not abort itself the moment it
    // increments _foregroundFolderWindowCount. The default is no
    // yielding; only the indexer opts in.
    backend._foregroundFolderWindowCount = 1;
    try {
      const result = await backend.ensureFolderIndex(inbox.id, {
        limit: 100,
        maxChunks: 3,
        total: INBOX_TOTAL,
      });
      // All three chunks completed despite the counter being > 0.
      expect(result.fetched).toBe(300);
    } finally {
      backend._foregroundFolderWindowCount = 0;
    }
  });
});
