#!/usr/bin/env node
/**
 * Compare body-open latency when the user clicks during an in-flight
 * prefetch batch:
 *
 *   queue   — current store: click only enqueues; user waits for the
 *             active ensureMessageBodies(batch) to finish.
 *   parallel — getMessageBodyForDisplay (priority single-id fetch) while
 *             prefetch continues.
 *
 * Modes:
 *   repo  — __repo-only timing (no UI), 3 rounds
 *   ui    — full click in MessageView, 3 rounds per strategy
 *   both  — default
 *
 * Env: STAGE_USERNAME, STAGE_PASSWORD (or SANCUS_STAGE_THUNDERMAIL),
 *      PLAYWRIGHT_BASE_URL (default https://localhost:3000)
 *
 * Run:
 *   source ~/secrets.sh
 *   node tests/perf/body-click-benchmark.mjs
 */

import { chromium } from '@playwright/test';

const USERNAME = process.env.STAGE_USERNAME || 'sancus@stage-thundermail.com';
const PASSWORD = process.env.STAGE_PASSWORD || process.env.SANCUS_STAGE_THUNDERMAIL;
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'https://localhost:3000';
const MODE = process.env.MODE || 'both';
const DEEP_OFFSET = Number(process.env.DEEP_OFFSET || 1500);
const PREFETCH_BATCH = Number(process.env.PREFETCH_BATCH || 25);
const ROUNDS = Number(process.env.ROUNDS || 3);

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function avg(arr) {
  if (!arr.length) return null;
  return Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);
}

async function login(page) {
  await page.goto(BASE_URL);
  await page.getByRole('button', { name: /use app password instead/i }).click();
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('App password').fill(PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.locator('.shell').waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForFunction(() => !!window.__repo, { timeout: 60_000 });
}

async function loadDeepArchiveWindow(page) {
  return page.evaluate(async ({ deepOffset, prefetchBatch }) => {
    const accounts = await window.__repo.listAccounts();
    const account = accounts[0];
    const folders = await window.__repo.listFolders(account.id);
    const archive = folders.find((f) => f.role === 'archive' || /archive/i.test(f.name));
    if (!archive) throw new Error('No archive folder');

    await window.__repo.ensureFolderWindow(account.id, archive.id, {
      offset: deepOffset,
      limit: prefetchBatch,
    });
    const rows = await window.__repo.listMessagesForView({
      accountId: account.id,
      folderId: archive.id,
      sort: 'received',
      offset: deepOffset,
      limit: prefetchBatch,
    });
    const ids = rows.map((r) => r.id).filter((id) => id != null);
    if (ids.length < 2) {
      throw new Error(`Need >=2 messages at offset ${deepOffset}, got ${ids.length}`);
    }
    return {
      accountId: account.id,
      folderId: archive.id,
      folderName: archive.name,
      ids,
    };
  }, { deepOffset: DEEP_OFFSET, prefetchBatch: PREFETCH_BATCH });
}

async function clearBodies(page, messageIds) {
  await page.evaluate(async (ids) => {
    if (!ids.length) return;
    const ph = ids.map(() => '?').join(',');
    await window.__repo.call('db.transaction', {
      statements: [
        { sql: `DELETE FROM body_values WHERE message_id IN (${ph})`, params: ids },
        { sql: `DELETE FROM body_parts WHERE message_id IN (${ph})`, params: ids },
        {
          sql: `UPDATE messages SET body_fetched_at = NULL WHERE id IN (${ph})`,
          params: ids,
        },
      ],
    });
  }, messageIds);
  const ready = await page.evaluate(async (ids) => {
    if (!ids.length) return true;
    const ph = ids.map(() => '?').join(',');
    const rows = await window.__repo.call('db.query', {
      sql: `SELECT COUNT(*) AS c FROM body_values WHERE message_id IN (${ph})`,
      params: ids,
    });
    return Number(rows[0]?.c ?? 0) === 0;
  }, messageIds);
  if (!ready) {
    throw new Error('body cache not cleared before timed run');
  }
}

async function bodyReady(page, messageId) {
  return page.evaluate(async (id) => {
    const rows = await window.__repo.call('db.query', {
      sql: 'SELECT 1 AS ok FROM body_values WHERE message_id = ? LIMIT 1',
      params: [id],
    });
    return rows.length > 0;
  }, messageId);
}

async function waitForBody(page, messageId, timeoutMs = 120_000) {
  const start = nowMs();
  while (nowMs() - start < timeoutMs) {
    if (await bodyReady(page, messageId)) {
      return Math.round(nowMs() - start);
    }
    await page.waitForTimeout(50);
  }
  return null;
}

/**
 * Simulate current store behaviour when user clicks during prefetch:
 * await the in-flight batch; only then fetch click id if it was outside batch.
 */
async function repoQueueOnly(page, { accountId, ids, clickInBatch }) {
  const batch = ids.slice(0, PREFETCH_BATCH);
  const clickId = clickInBatch ? batch[Math.floor(batch.length / 2)] : ids[ids.length - 1];
  const prefetchIds = clickInBatch ? batch : batch.slice(0, -1);

  await clearBodies(page, batch);

  const t0 = nowMs();
  const batchPromise = page.evaluate(
    ({ accountId, prefetchIds }) => window.__repo.ensureMessageBodies(accountId, prefetchIds),
    { accountId, prefetchIds },
  );
  // Click "during" batch — store does not call ensureMessageBody; user waits on batch.
  await batchPromise;
  let ms = Math.round(nowMs() - t0);
  if (!prefetchIds.includes(clickId)) {
    const t1 = nowMs();
    await page.evaluate(
      ({ accountId, clickId }) => window.__repo.getMessageBodyForDisplay(accountId, clickId),
      { accountId, clickId },
    );
    ms = Math.round(nowMs() - t0);
    await waitForBody(page, clickId, 5_000);
  } else {
    await waitForBody(page, clickId, 5_000);
  }
  return { clickId, clickInBatch, ms, prefetchCount: prefetchIds.length };
}

/**
 * Proposed: parallel ensureMessageBody while batch prefetch runs.
 */
async function repoParallel(page, { accountId, ids, clickInBatch }) {
  const batch = ids.slice(0, PREFETCH_BATCH);
  const clickId = clickInBatch ? batch[Math.floor(batch.length / 2)] : ids[ids.length - 1];
  const prefetchIds = clickInBatch ? batch : batch.slice(0, -1);

  await clearBodies(page, batch);

  const t0 = nowMs();
  const batchPromise = page.evaluate(
    ({ accountId, prefetchIds }) => window.__repo.ensureMessageBodies(accountId, prefetchIds),
    { accountId, prefetchIds },
  );
  const clickRpcStart = nowMs();
  await page.evaluate(
    ({ accountId, clickId }) => window.__repo.getMessageBodyForDisplay(accountId, clickId),
    { accountId, clickId },
  );
  const clickRpcMs = Math.round(nowMs() - clickRpcStart);
  const bodyMs = await waitForBody(page, clickId, 120_000);
  const batchMs = Math.round(nowMs() - t0);
  await batchPromise.catch(() => {});
  return {
    clickId,
    clickInBatch,
    ms: bodyMs,
    clickRpcMs,
    batchMs,
    prefetchCount: prefetchIds.length,
    note: clickInBatch
      ? 'ensureMessageBody piggybacks on batch _bodyFetchInflight when click id is in prefetchIds'
      : 'separate RPC from batch',
  };
}

async function runRepoBenchmark(page, setup) {
  const scenarios = [
    { name: 'repo-queue-click-in-batch', fn: repoQueueOnly, clickInBatch: true },
    { name: 'repo-parallel-click-in-batch', fn: repoParallel, clickInBatch: true },
    { name: 'repo-queue-click-outside-batch', fn: repoQueueOnly, clickInBatch: false },
    { name: 'repo-parallel-click-outside-batch', fn: repoParallel, clickInBatch: false },
  ];
  const results = [];
  for (const scenario of scenarios) {
    const times = [];
    for (let round = 1; round <= ROUNDS; round += 1) {
      const row = await scenario.fn(page, { accountId: setup.accountId, ids: setup.ids, clickInBatch: scenario.clickInBatch });
      if (row.ms == null) throw new Error(`${scenario.name} round ${round} timed out`);
      times.push(row.ms);
    }
    results.push({
      scenario: scenario.name,
      avgMs: avg(times),
      rounds: times,
      clickInBatch: scenario.clickInBatch,
    });
  }
  return results;
}

async function uiBodyVisible(page) {
  return page.evaluate(() => {
    const iframe = document.querySelector('.message-view__html-frame');
    if (iframe?.srcdoc) return true;
    const text = document.querySelector('.message-view__text');
    if (text?.textContent?.trim()) return true;
    return false;
  });
}

async function runUiBenchmark(browser, setup, strategy) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addInitScript((s) => {
    globalThis.__STORMBOX_BODY_CLICK_STRATEGY__ = s;
  }, strategy);
  const page = await context.newPage();
  await login(page);

  const times = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    await page.evaluate(async ({ folderId, deepOffset, prefetchBatch }) => {
      const accounts = await window.__repo.listAccounts();
      const account = accounts[0];
      await window.__repo.ensureFolderWindow(account.id, folderId, {
        offset: deepOffset,
        limit: prefetchBatch,
      });
    }, {
      folderId: setup.folderId,
      deepOffset: DEEP_OFFSET,
      prefetchBatch: PREFETCH_BATCH,
    });

    const batchIds = setup.ids;
    await clearBodies(page, batchIds);

    const archives = page.locator('.folder-node').filter({ hasText: /archive/i }).first();
    await archives.click();
    await page.waitForTimeout(300);

    await page.evaluate(({ deepOffset }) => {
      const sc = document.querySelector('.msg-list__scroller');
      if (sc) sc.scrollTop = deepOffset * 88;
    }, { deepOffset: DEEP_OFFSET });

    await page.waitForFunction(
      ({ deepOffset }) => {
        const real = Array.from(document.querySelectorAll('.msg-list__items > li'))
          .filter((li) => li.dataset.placeholder !== 'true');
        const idx = real.map((li) => Number(li.dataset.index));
        return idx.length > 0 && Math.max(...idx) >= deepOffset - 50;
      },
      { deepOffset: DEEP_OFFSET },
      { timeout: 90_000 },
    );

    // Start prefetch (visible window) without awaiting — same as scroll-pause.
    const prefetchPromise = page.evaluate(
      ({ accountId, batchIds }) => window.__repo.ensureMessageBodies(accountId, batchIds),
      { accountId: setup.accountId, batchIds },
    );

    const mid = Math.floor(PREFETCH_BATCH / 2);
    const clickIndex = DEEP_OFFSET + mid;
    const row = page.locator(`.msg-list__item[data-index="${clickIndex}"]`).first();
    await row.waitFor({ state: 'visible', timeout: 30_000 });

    const t0 = nowMs();
    await row.click();

    let ms = null;
    while (nowMs() - t0 < 120_000) {
      if (await uiBodyVisible(page)) {
        ms = Math.round(nowMs() - t0);
        break;
      }
      await page.waitForTimeout(50);
    }
    if (ms == null) throw new Error(`UI ${strategy} round ${round} timed out`);
    times.push(ms);
    await prefetchPromise.catch(() => {});
  }

  await context.close();
  return { strategy, avgMs: avg(times), rounds: times };
}

async function main() {
  if (!PASSWORD) throw new Error('STAGE_PASSWORD or SANCUS_STAGE_THUNDERMAIL required');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await login(page);
  const setup = await loadDeepArchiveWindow(page);
  await browser.close();

  const out = {
    baseUrl: BASE_URL,
    folder: setup.folderName,
    deepOffset: DEEP_OFFSET,
    prefetchBatch: PREFETCH_BATCH,
    rounds: ROUNDS,
  };

  if (MODE === 'repo' || MODE === 'both') {
    const repoBrowser = await chromium.launch({ headless: true });
    const repoPage = await repoBrowser.newPage({ ignoreHTTPSErrors: true });
    await login(repoPage);
    out.repo = await runRepoBenchmark(repoPage, setup);
    await repoBrowser.close();
  }

  if (MODE === 'ui' || MODE === 'both') {
    const uiBrowser = await chromium.launch({ headless: true });
    out.ui = [
      await runUiBenchmark(uiBrowser, setup, 'queue'),
      await runUiBenchmark(uiBrowser, setup, 'parallel'),
    ];
    await uiBrowser.close();
  }

  if (out.repo) {
    const inBatch = out.repo.filter((r) => r.clickInBatch);
    const qIn = inBatch.find((r) => r.scenario.includes('queue-click-in'));
    const pIn = inBatch.find((r) => r.scenario.includes('parallel-click-in'));
    if (qIn?.avgMs && pIn?.avgMs) {
      out.summary = {
        ...out.summary,
        repoClickInBatchSpeedup: Number((qIn.avgMs / pIn.avgMs).toFixed(2)),
        repoQueueInBatchMs: qIn.avgMs,
        repoParallelInBatchMs: pIn.avgMs,
      };
    }
  }
  if (out.ui?.length === 2) {
    const [queue, parallel] = out.ui;
    if (queue?.avgMs && parallel?.avgMs) {
      out.summary = {
        ...out.summary,
        uiSpeedup: Number((queue.avgMs / parallel.avgMs).toFixed(2)),
        uiQueueMs: queue.avgMs,
        uiParallelMs: parallel.avgMs,
      };
    }
  }

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
