import { test, expect } from '@playwright/test';

/**
 * VFS A/B/C benchmark. Loads tests/perf/vfs-bench/index.html in a
 * DedicatedWorker context and runs the same delete-under-indexer-
 * churn workload against three wa-sqlite VFS configurations:
 *
 *   - opfsAnyContext   : current production VFS (async build, no WAL,
 *                        works in SharedWorker)
 *   - accessHandlePool : sync build + locking_mode=exclusive +
 *                        journal_mode=WAL (DedicatedWorker only, single
 *                        connection - the migration candidate)
 *   - opfsCoopSync     : sync build, multi-handle, no WAL (the
 *                        no-locking-mode alternative)
 *
 * Both engines (chromium + firefox) run all three so we can spot
 * browser-specific surprises before committing to a migration. The
 * test asserts no failures - the *values* are the point. Run with:
 *
 *   docker exec -u node -w /workspace -e PLAYWRIGHT_REUSE=1 \
 *     thundermail-dev npx playwright test tests/e2e/vfs-bench.spec.js \
 *     --reporter=list
 */

const VFSES = ['opfsAnyContext', 'accessHandlePool', 'opfsCoopSync', 'idbBatchAtomic'];
const DURATION_MS = Number(process.env.VFS_BENCH_DURATION ?? 8000);
const FG_INTERVAL_MS = Number(process.env.VFS_BENCH_FG_INTERVAL ?? 50);

// Each scenario is a different background-contention pattern so we
// can see how the VFSes compare both in the easy case (solo) and
// the realistic / worst case.
const SCENARIOS = [
  // bgChunk=0 disables the background loop; this is the floor.
  // Measures pure single-transaction cost for each VFS.
  { name: 'solo', bgChunk: 0, bgPause: 0 },
  // bgChunk=100 every 250ms approximates our metadata indexer at
  // the current production settings (5 chunks/tick * 100 rows,
  // amortised as one chunk per 50ms = 1 chunk per 250ms tick).
  { name: 'indexer', bgChunk: 100, bgPause: 250 },
  // bgChunk=100 with zero pause is the worst case: a runaway sync
  // job hammering the connection nonstop. Shows the ceiling of
  // contention damage.
  { name: 'saturated', bgChunk: 100, bgPause: 0 },
];

test.describe('VFS benchmark: foreground delete latency vs background contention', () => {
  test.setTimeout(300_000);

  for (const vfs of VFSES) {
    for (const scenario of SCENARIOS) {
      test(`vfs=${vfs} scenario=${scenario.name}`, async ({ page, browserName }, testInfo) => {
        page.on('pageerror', (err) => {
          // eslint-disable-next-line no-console
          console.log(`[page error] ${err.message}`);
        });

        const url = `/research/vfs-bench/index.html?vfs=${vfs}`
          + `&duration=${DURATION_MS}&fgInterval=${FG_INTERVAL_MS}`
          + `&bgChunk=${scenario.bgChunk}&bgPause=${scenario.bgPause}`;
        await page.goto(url, { waitUntil: 'load' });

        const outcome = await page.waitForFunction(
          () => window.__benchResult ?? (window.__benchError ? { error: window.__benchError } : null),
          null,
          { timeout: 200_000, polling: 200 },
        );
        const result = await outcome.jsonValue();
        if (result?.error) throw new Error(`worker error: ${result.error}`);

        // eslint-disable-next-line no-console
        console.log(`[vfs-bench] ${browserName} ${vfs} ${scenario.name} -> ${JSON.stringify(result)}`);
        await testInfo.attach(`${browserName}-${vfs}-${scenario.name}.json`, {
          body: JSON.stringify({ ...result, scenario: scenario.name }, null, 2),
          contentType: 'application/json',
        });

        expect(result.fgCount, `${vfs}/${scenario.name} produced no foreground transactions`).toBeGreaterThan(0);
      });
    }
  }
});
