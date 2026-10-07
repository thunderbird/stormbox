# Research & benchmarks

Slow or opt-in measurements that are useful for investigations but
should NOT run on every push. The default `npx playwright test`
invocation does not see anything in this directory; you have to ask
for it explicitly (see below).

If you add something here, prefer:

- One focused workload per file
- Print the headline number(s) to stdout in a stable `[name] key=value`
  format so future runs can be diffed cheaply
- Attach the full result as JSON via `testInfo.attach` so we can pull
  it back out of `test-results/` if needed
- A docstring at the top explaining the hypothesis being tested and
  the baseline numbers when the file was added, so the next person
  can spot regressions without re-running everything

## Running

Everything in here runs inside the dev container. The specs that log
in (`delete-latency`, `indexer-speed`) need the local stack and
`LOCAL_STACK=1`. Under `LOCAL_STACK=1` Playwright reuses a vite already
running on `localhost:3000` (opt out with `PLAYWRIGHT_NO_REUSE=1`) and
only runs the Firefox project unless `INCLUDE_CHROMIUM=1` is set.

```bash
docker exec -u node -w /workspace \
  -e LOCAL_STACK=1 -e INCLUDE_CHROMIUM=1 \
  thundermail-dev \
  npx playwright test --config research/playwright.config.js
```

Common filters:

```bash
# One file
... npx playwright test --config research/playwright.config.js \
  research/delete-latency.spec.js

# One browser
... npx playwright test --config research/playwright.config.js \
  --project=firefox

# Single test by name pattern
... npx playwright test --config research/playwright.config.js \
  -g "vfs=accessHandlePool"
```

## What's here

### `delete-latency.spec.js`

Reproduces the user-reported "first delete after login is slow"
complaint. Seeds two disposable inbox messages, logs in, then:

- **cold**: deletes one immediately after first render (background
  bootstrap / indexer / state-change handlers all in flight)
- **warm**: waits `WARM_DELAY_MS` (default 8s) of idle, deletes the
  other

Reports `cold = N ms / warm = N ms` and asserts `cold < 800 ms` as
a regression guard. A page-side MutationObserver captures the exact
moment the row leaves the DOM (Playwright's `waitFor(state: 'detached')`
polls every 50–100 ms and overstates by that much).

Baseline at time of authoring (Chromium, local Stalwart):
cold ~380 ms, warm ~900–1300 ms.

After the switch to `IDBBatchAtomicVFS` (2026-05-20): Firefox cold
~180 ms / warm ~190 ms; Chromium cold ~190 ms, warm 1.5–2.4 s.

### `vfs-bench.spec.js` + `vfs-bench/`

Head-to-head SQLite VFS comparison run in a DedicatedWorker:

- `idbBatchAtomic` — production VFS since 2026-05-20 (async build,
  IndexedDB-backed, `lockPolicy: 'exclusive'`, works in SharedWorker,
  no `-journal`/`-wal` file: atomic batch writes via IndexedDB
  transactions instead)
- `opfsAnyContext` — previous production VFS (async build, OPFS, no
  WAL, works in SharedWorker)
- `accessHandlePool` — sync build + `locking_mode=exclusive` +
  `journal_mode=WAL`, OPFS (DedicatedWorker only, single connection)
- `opfsCoopSync` — sync build, multi-handle, OPFS, no WAL
  (DedicatedWorker only)

Three scenarios per VFS:

- `solo` — no background load, measures the per-tx floor
- `indexer` — 100 inserts per tx every 250 ms (production indexer
  pacing)
- `saturated` — 100 inserts per tx with no pause (worst case)

The foreground workload is one delete-shaped transaction (SELECT,
two DELETEs, two UPDATEs) every `VFS_BENCH_FG_INTERVAL` ms (default
50), serialized with the background writes through one FIFO lock like
the production Engine. Each scenario runs for `VFS_BENCH_DURATION` ms
(default 8000) and reports foreground p50/p95/p99/max latency plus
background rows/sec.

The bench needs no local stack. Run it without `LOCAL_STACK` so both
browser projects exist and keep one worker so cases do not contend
with each other. `PLAYWRIGHT_NO_REUSE=1` makes Playwright start its
own vite; drop it if one is already serving `localhost:3000`.

```bash
docker exec -u node -w /workspace -e PLAYWRIGHT_NO_REUSE=1 \
  thundermail-dev \
  npx playwright test --config research/playwright.config.js \
  research/vfs-bench.spec.js --workers=1 --repeat-each=3 --reporter=list
```

#### Results, 2026-10-07

Median of 3 runs per case. Chromium 148.0.7778.96 (headless shell),
Firefox 150.0.2, Playwright 1.60.0, `@journeyapps/wa-sqlite` 1.7.0,
EC2 m8i-flex.2xlarge (8 vCPU Xeon 6975P-C) with other dev containers
running. Run-to-run spread was within 10 ms on p50 and 8% on
throughput.

Foreground latency in ms, background rows/sec from the `saturated`
scenario:

Chromium:

| VFS | solo p50 / p99 | indexer p50 / p95 / p99 | saturated p50 / p95 / p99 | bg rows/s |
|---|--:|--:|--:|--:|
| idbBatchAtomic (production) | 5 / 9 | 10 / 16 / 20 | 72 / 135 / 158 | 2188 |
| opfsAnyContext | 33 / 44 | 57 / 92 / 125 | 141 / 219 / 230 | 963 |
| accessHandlePool + WAL | 8 / 13 | 27 / 48 / 57 | 114 / 221 / 287 | 2038 |
| opfsCoopSync | 19 / 24 | 33 / 53 / 57 | 84 / 146 / 153 | 1438 |

Firefox:

| VFS | solo p50 / p99 | indexer p50 / p95 / p99 | saturated p50 / p95 / p99 | bg rows/s |
|---|--:|--:|--:|--:|
| idbBatchAtomic (production) | 11 / 15 | 27 / 46 / 66 | 81 / 146 / 177 | 1288 |
| opfsAnyContext | 113 / 121 | 183 / 261 / 264 | 258 / 287 / 295 | 338 |
| accessHandlePool + WAL | 6 / 10 | 23 / 38 / 42 | 84 / 165 / 176 | 1700 |
| opfsCoopSync | 14 / 17 | 28 / 43 / 46 | 77 / 136 / 144 | 1400 |

The `indexer` scenario's background rate is capped by its pacing at
400 rows/s, so only `saturated` measures write throughput. Under
`indexer` every VFS except `opfsAnyContext` (325 Chromium, 213
Firefox) kept up at 350–388 rows/s.

On Chromium `idbBatchAtomic` has the lowest p50 and p95 and the
highest throughput in every scenario. On Firefox it is about 2×
slower than `accessHandlePool` + WAL on the solo floor (11 vs 6 ms),
level with the two OPFS sync VFSes on indexer p50 but with a longer
p99 tail (66 vs 42–46 ms), and the slowest of those three on
saturated throughput (1288 vs 1400–1700 rows/s). On Firefox
`opfsAnyContext` is 3× slower than the other VFSes when saturated and
8–19× slower on the solo floor.

#### Original run, 2026-05-20

Single run per case, browser versions not recorded. Foreground p50
in ms, background rows/sec from `saturated`:

| VFS | Chromium solo / indexer / saturated | Chromium bg rows/s | Firefox solo / indexer / saturated | Firefox bg rows/s |
|---|--:|--:|--:|--:|
| idbBatchAtomic | 8 / 15 / 69 | 1863 | 16 / 36 / 100 | 988 |
| opfsAnyContext | 43 / 74 / 115 | 625 | 129 / 220 / 300 | 288 |
| accessHandlePool + WAL | 12 / 24 / 125 | 1550 | 9 / 28 / 96 | 1313 |
| opfsCoopSync | 26 / 47 / 100 | 1113 | 19 / 35 / 81 | 1150 |

This run motivated the move off `OPFSAnyContextVFS`: `idbBatchAtomic`
was a drop-in, SharedWorker-safe 5–8× improvement on the solo and
indexer scenarios, against 3–14× for `accessHandlePool` + WAL, which
would have required a DedicatedWorker migration.

### `indexer-speed.spec.js`

End-to-end regression for the background metadata indexer using the
Archive folder seeded by `tests/fixtures/seed-mail.mjs` (≥1500 msgs).
Asserts the indexer fully populates the folder within a budget after
a cold refresh. Lives here because it's a perf-budget assertion
rather than a behavioural test, and the seed folder + budget make it
slow / environment-sensitive.

### `body-click-benchmark.mjs`

Standalone Node script (Playwright launched programmatically). Compares
body-open latency when the user clicks during an in-flight prefetch:

- `queue` — current behaviour: click waits for the active
  `ensureMessageBodies(batch)` to finish
- `parallel` — priority single-id fetch in parallel with the prefetch

Modes: `repo` (no UI), `ui` (full click), `both` (default). Run with:

```bash
docker exec -u node -w /workspace \
  -e LOCAL_STACK=1 \
  thundermail-dev \
  node research/body-click-benchmark.mjs
```

### `archive-metadata-benchmark.mjs`

Standalone Node script that measures Archive folder metadata
indexing throughput against the staging server. Requires
`STAGE_USERNAME` / `STAGE_PASSWORD` / `STAGE_ACCOUNT_ID` /
`STAGE_ARCHIVE_MAILBOX_ID` in the environment.
