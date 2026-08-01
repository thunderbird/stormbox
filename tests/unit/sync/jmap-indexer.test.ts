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

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { JmapBackend } from '../../../src/sync/backends/jmap/backend';
import { MockTransport } from './_mock-transport';

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
  registerInboxFixtures(transport);

  backend = makeBackend();
});

/**
 * The default single-mailbox fixtures: Stalwart-style positional
 * Email/query returning up to `limit` ids starting from `position`
 * plus an authoritative total, and an Email/get answering fixtures
 * for whatever ids it is handed.
 */
function registerInboxFixtures(t) {
  t.handle('Email/query', (params) => {
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
  t.handle('Email/get', (params) => ({
    accountId: account.remote_account_id,
    state: 'es',
    list: (params.ids ?? []).map(emailFixture),
    notFound: [],
  }));
}

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

async function readProgress(folderId, accountId = account.id) {
  return handlers[DB_RPC.QUERY_VIEW_PROGRESS]({
    accountId,
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
      stale: false,
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
  it('clamps to the server-advertised maxObjectsInGet cap', async () => {
    // RFC 8620 §3.5 — Email/get with more than maxObjectsInGet ids
    // gets a 'tooManyObjectsInGet' SetError. Clamp protects us from
    // ever asking for more than the server is willing to serve.
    expect(backend._selectIndexerChunkSize(10_000, 100)).toBe(100);
    expect(backend._selectIndexerChunkSize(10_000, 50)).toBe(50);
    // If the server cap is generous, the foreground-sized target still wins.
    expect(backend._selectIndexerChunkSize(800, 999_999)).toBe(100);
  });

  it('reads maxObjectsInGet from the live JMAP Session, not SQLite', async () => {
    transport.session = {
      capabilities: {
        'urn:ietf:params:jmap:core': {
          maxObjectsInGet: 75,
          maxObjectsInSet: 100,
          maxConcurrentRequests: 4,
        },
      },
    };
    // A contradictory persisted value must not affect wire chunking.
    await handlers[DB_RPC.ACCOUNT_CAPABILITIES_REPLACE]({
      accountId: account.id,
      serviceKind: 'jmap-mail',
      capabilities: {
        'urn:ietf:params:jmap:core': {
          maxObjectsInGet: 999,
          maxObjectsInSet: 100,
          maxConcurrentRequests: 4,
        },
      },
    });
    const cap = await backend._loadMaxObjectsInGetCap();
    expect(cap).toBe(75);
    await engine.run(
      `DELETE FROM account_capabilities WHERE account_id = ?`,
      [account.id],
    );
    expect(await backend._loadMaxObjectsInGetCap()).toBe(75);
  });

  it('rejects a malformed JMAP Session without maxObjectsInGet', async () => {
    transport.session = {
      capabilities: {
        'urn:ietf:params:jmap:core': {},
      },
    };
    await expect(backend._loadMaxObjectsInGetCap()).rejects.toThrow(
      /maxObjectsInGet/,
    );
  });
});

describe('metadata indexer: shared accounts', () => {
  const SHARED_TOTAL = 120;
  let sharedAccount;
  let sharedFolder;
  // Read lazily by the Email/query fixture so attachSharedAccount can
  // grow the shared folder after the fixture was registered.
  let currentSharedTotal = SHARED_TOTAL;

  /**
   * Attach a shared account carrying one folder, wired the way
   * ingestSession would leave the backend after a Session advertising a
   * second, non-primary account. role/totalEmails override the shared
   * folder's sort keys for tests that need it to outrank the primary
   * Inbox on the secondary ORDER BY criteria.
   */
  async function attachSharedAccount({ isSubscribed, role = null, totalEmails = SHARED_TOTAL }) {
    currentSharedTotal = totalEmails;
    sharedAccount = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
      displayName: 'Team',
      primaryEmail: 'team@example.com',
      serverOrigin: 'https://mail.example.com',
      remoteAccountId: 'acct-shared',
      isPrimary: false,
      isPersonal: false,
    })).row;
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: sharedAccount.id,
      folders: [{
        remoteId: 'mb-shared',
        name: 'Team Mail',
        role,
        totalEmails,
        unreadEmails: 0,
        isSubscribed,
      }],
    });
    sharedFolder = await engine.get(
      'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
      [sharedAccount.id, 'mb-shared'],
    );
    backend.sharedAccounts = [sharedAccount];
    backend._accountsByLocalId = new Map(
      [account, sharedAccount].map((a) => [Number(a.id), a]),
    );
  }

  /**
   * Replace the single-mailbox fixtures from the outer beforeEach with
   * ones that answer for both accounts, keyed by the requested mailbox.
   */
  function registerTwoAccountFixtures() {
    const prefixes = new Map([['mb-inbox', 'e'], ['mb-shared', 's']]);
    transport.handle('Email/query', (params) => {
      const mailbox = params.filter?.inMailbox;
      const total = mailbox === 'mb-shared' ? currentSharedTotal : INBOX_TOTAL;
      const position = Number(params.position ?? 0);
      const limit = Number(params.limit ?? 100);
      const ids = [];
      for (let i = position; i < Math.min(position + limit, total); i += 1) {
        ids.push(`${prefixes.get(mailbox)}-${i}`);
      }
      return {
        accountId: params.accountId,
        filter: params.filter,
        sort: params.sort,
        queryState: `qs-${mailbox}-${position}-${ids.length}`,
        canCalculateChanges: true,
        position,
        total,
        ids,
      };
    });
    transport.handle('Email/get', (params) => ({
      accountId: params.accountId,
      state: 'es',
      list: (params.ids ?? []).map((id) => ({
        ...emailFixture(id),
        mailboxIds: { [id.startsWith('s-') ? 'mb-shared' : 'mb-inbox']: true },
      })),
      notFound: [],
    }));
  }

  /** Drive ticks until the primary Inbox is fully covered. */
  async function coverPrimaryInbox() {
    await backend.ensureFolderWindow(inbox.id, { offset: 0, limit: 100 });
    await backend._runMetadataIndexerChunk();
    const progress = await readProgress(inbox.id);
    expect(progress.covered).toBe(INBOX_TOTAL);
  }

  beforeEach(() => {
    registerTwoAccountFixtures();
  });

  it('indexes a subscribed shared folder once the primary account is covered', async () => {
    await attachSharedAccount({ isSubscribed: true });
    await coverPrimaryInbox();

    expect((await readProgress(sharedFolder.id, sharedAccount.id)).covered).toBe(0);

    await backend._runMetadataIndexerChunk();
    const shared = await readProgress(sharedFolder.id, sharedAccount.id);
    expect(shared.total).toBe(SHARED_TOTAL);
    expect(shared.covered).toBe(SHARED_TOTAL);
    expect(shared.percent).toBe(100);
  });

  it('finishes every primary folder before starting a shared one', async () => {
    // Ordering pin: the signed-in account must not starve behind a
    // shared folder. The Inbox still has 250 uncovered positions here,
    // so the tick has to spend itself there.
    //
    // The shared fixture deliberately outranks the primary Inbox on
    // every secondary sort key — same 'inbox' role, larger
    // total_emails — so without the account-priority CASE in the
    // indexer SQL the tick would pick the shared folder first and
    // both assertions below would fail.
    backend = makeBackend({ indexerChunksPerTick: 1 });
    await attachSharedAccount({
      isSubscribed: true,
      role: 'inbox',
      totalEmails: INBOX_TOTAL + 250,
    });
    await backend.ensureFolderWindow(inbox.id, { offset: 0, limit: 100 });

    await backend._runMetadataIndexerChunk();

    expect((await readProgress(inbox.id)).covered).toBe(200);
    expect((await readProgress(sharedFolder.id, sharedAccount.id)).covered).toBe(0);
  });

  it('never indexes an unsubscribed shared folder', async () => {
    // An unsubscribed shared folder renders in neither the sidebar nor
    // a message list (FM-6.9), so pulling its metadata would be pure
    // waste.
    await attachSharedAccount({ isSubscribed: false });
    await coverPrimaryInbox();

    const requestCountBefore = transport.requests.length;
    await backend._runMetadataIndexerChunk();

    expect(transport.requests.length).toBe(requestCountBefore);
    expect((await readProgress(sharedFolder.id, sharedAccount.id)).covered).toBe(0);
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

describe('metadata indexer: folder failure isolation', () => {
  /**
   * Make Email/query against one mailbox answer a JMAP error tuple —
   * the shape a server produces when e.g. a shared mailbox's
   * mayReadItems was revoked while the folder stayed subscribed.
   */
  function armQueryError(mailboxId) {
    transport.handleError('Email/query', (params) => (
      params?.filter?.inMailbox === mailboxId
        ? { type: 'forbidden', description: 'simulated revocation' }
        : null
    ));
  }

  beforeEach(() => {
    transport = new MockTransport();
    registerInboxFixtures(transport);
    backend = makeBackend();
  });

  /** Requests that carried an Email/query filtered on the Inbox. */
  function inboxQueryCount() {
    return transport.requests.filter((req) =>
      req.methodCalls.some(([name, params]) =>
        name === 'Email/query' && params?.filter?.inMailbox === 'mb-inbox'),
    ).length;
  }

  it('keeps indexing lower-priority folders when a higher-priority folder errors, and backs the failing folder off', async () => {
    const ARCHIVE_TOTAL = 200;
    await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
      accountId: account.id,
      folders: [{
        remoteId: 'mb-archive',
        name: 'Archive',
        role: 'archive',
        totalEmails: ARCHIVE_TOTAL,
        unreadEmails: 0,
      }],
    });
    const archive = await engine.get(
      'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
      [account.id, 'mb-archive'],
    );
    const totals = new Map([['mb-inbox', INBOX_TOTAL], ['mb-archive', ARCHIVE_TOTAL]]);
    transport.handle('Email/query', (params) => {
      const mailbox = params.filter?.inMailbox;
      const total = totals.get(mailbox) ?? 0;
      const position = Number(params.position ?? 0);
      const limit = Number(params.limit ?? 100);
      const ids = [];
      for (let i = position; i < Math.min(position + limit, total); i += 1) {
        ids.push(`${mailbox}-${i}`);
      }
      return {
        accountId: params.accountId,
        filter: params.filter,
        sort: params.sort,
        queryState: `qs-${mailbox}-${position}-${ids.length}`,
        canCalculateChanges: true,
        position,
        total,
        ids,
      };
    });
    transport.handle('Email/get', (params) => ({
      accountId: params.accountId,
      state: 'es',
      list: (params.ids ?? []).map((id) => ({
        ...emailFixture(id),
        mailboxIds: { [id.startsWith('mb-archive-') ? 'mb-archive' : 'mb-inbox']: true },
      })),
      notFound: [],
    }));
    // The Inbox outranks Archive (role sort 0 < 2), so without
    // per-folder isolation its error would abort every tick and
    // starve Archive forever.
    armQueryError('mb-inbox');

    await backend._runMetadataIndexerChunk();

    // The same tick moved past the erroring Inbox and fully indexed
    // the healthy Archive behind it.
    expect((await readProgress(inbox.id)).covered).toBe(0);
    expect((await readProgress(archive.id)).covered).toBe(ARCHIVE_TOTAL);
    expect(backend._indexerFolderFailures.has(inbox.id)).toBe(true);
    expect(inboxQueryCount()).toBe(1);

    // While backed off, subsequent ticks skip the Inbox entirely —
    // no re-query every 250 ms.
    const requestsAfterFirstTick = transport.requests.length;
    await backend._runMetadataIndexerChunk();
    expect(inboxQueryCount()).toBe(1);
    expect(transport.requests.length).toBe(requestsAfterFirstTick);
  });

  it('does not hot-loop when the server overstates the total and tail pages come back empty', async () => {
    // The folder row and every Email/query response claim
    // INBOX_TOTAL, but the server stops returning ids at REAL_TOTAL
    // (e.g. contents purged server-side, totals not yet re-synced).
    // The gap at REAL_TOTAL can never be filled; the indexer must
    // back the folder off instead of re-probing it every tick.
    const REAL_TOTAL = 200;
    transport.handle('Email/query', (params) => {
      const position = Number(params.position ?? 0);
      const limit = Number(params.limit ?? 100);
      const ids = [];
      for (let i = position; i < Math.min(position + limit, REAL_TOTAL); i += 1) {
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
    await backend.ensureFolderWindow(inbox.id, { offset: 0, limit: 100 });

    // First tick covers the honest gap (100..200) and stops at the
    // first empty page rather than probing further empty offsets.
    await backend._runMetadataIndexerChunk();
    expect((await readProgress(inbox.id)).covered).toBe(REAL_TOTAL);

    // Second tick probes the stuck gap exactly once (a dense JMAP
    // result that is empty at 200 has nothing at 300 either), marks
    // the folder failed, and backs it off.
    const queriesBeforeStuckTick = inboxQueryCount();
    await backend._runMetadataIndexerChunk();
    expect(inboxQueryCount()).toBe(queriesBeforeStuckTick + 1);
    expect((await readProgress(inbox.id)).covered).toBe(REAL_TOTAL);
    expect(backend._indexerFolderFailures.has(inbox.id)).toBe(true);

    // Third tick: backed off, so no traffic at all.
    await backend._runMetadataIndexerChunk();
    expect(inboxQueryCount()).toBe(queriesBeforeStuckTick + 1);
  });

  it('does not hot-loop when the live query says the folder is empty but the cached total says otherwise', async () => {
    // Folder row still claims INBOX_TOTAL (so it passes the candidate
    // SQL prefilter) but the live Email/query answers total 0, ids []
    // (folder purged server-side before folder totals re-synced).
    // No range is ever recorded, so coverage never advances.
    transport.handle('Email/query', (params) => ({
      accountId: account.remote_account_id,
      filter: params.filter,
      sort: params.sort,
      queryState: 'qs-empty',
      canCalculateChanges: true,
      position: Number(params.position ?? 0),
      total: 0,
      ids: [],
    }));

    // One probe per tick attempt — the empty-ids break must stop the
    // chunk loop from re-issuing the identical position-0 query for
    // every remaining chunk in the tick.
    await backend._runMetadataIndexerChunk();
    expect(inboxQueryCount()).toBe(1);
    expect((await readProgress(inbox.id)).covered).toBe(0);
    expect(backend._indexerFolderFailures.has(inbox.id)).toBe(true);

    // Backed off on the following tick rather than re-probed.
    await backend._runMetadataIndexerChunk();
    expect(inboxQueryCount()).toBe(1);
  });

  it('resumes indexing a folder once its failure clears and the sync succeeds', async () => {
    armQueryError('mb-inbox');
    await backend._runMetadataIndexerChunk();
    expect(backend._indexerFolderFailures.has(inbox.id)).toBe(true);
    expect((await readProgress(inbox.id)).covered).toBe(0);

    transport.clearError('Email/query');
    // Expire the backoff so the next tick retries immediately.
    backend._indexerFolderFailures.get(inbox.id).nextRetryAfter = 0;

    await backend._runMetadataIndexerChunk();
    expect(backend._indexerFolderFailures.has(inbox.id)).toBe(false);
    expect((await readProgress(inbox.id)).covered).toBe(INBOX_TOTAL);
  });
});
