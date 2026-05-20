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

Everything in here runs inside the dev container against the local
stack. The host's dev server must already be running on `localhost:3000`
(use `PLAYWRIGHT_REUSE=1` so Playwright does not try to start its own).

```bash
docker exec -u node -w /workspace \
  -e LOCAL_STACK=1 -e PLAYWRIGHT_REUSE=1 \
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

### `vfs-bench.spec.js` + `vfs-bench/`

Head-to-head SQLite VFS comparison run in a DedicatedWorker:

- `opfsAnyContext` — current production VFS (async build, no WAL,
  works in SharedWorker)
- `accessHandlePool` — sync build + `locking_mode=exclusive` +
  `journal_mode=WAL` (DedicatedWorker only, single connection)
- `opfsCoopSync` — sync build, multi-handle, no WAL

Three scenarios per VFS:

- `solo` — no background load, measures the per-tx floor
- `indexer` — 100 inserts per tx every 250 ms (production indexer
  pacing)
- `saturated` — 100 inserts per tx with no pause (worst case)

Each scenario runs for `VFS_BENCH_DURATION` ms (default 8000) and
reports foreground p50/p95/p99 latency plus background rows/sec.
Authored to decide whether to migrate off SharedWorker+
OPFSAnyContextVFS — see the conversation log for the headline result
(AccessHandlePool+WAL gave 4–14× faster foreground latency on both
browsers, biggest win on Firefox).

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
