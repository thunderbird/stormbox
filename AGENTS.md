# Stormbox — agent guide

Stormbox is a Vue 3 + Pinia webmail client backed by OPFS SQLite in a
`SharedWorker`, with a Stalwart JMAP server as the mail source of truth.

# Commit messages

Keep commit messages concise, a single sentence when possible. 2-3 additional sentences after the first primary message is acceptable for more complex commits. Do not include opinions and detailed research, stick to the precise facts of what was implemented in the commit.

Use a commit style similar to the other commits in the repository, don't randomly introduce conventional commit or any other types of tags.

## Spec-driven development

Spec Kit is the shared spec workflow. Project-wide spec principles live in
`.specify/memory/constitution.md`; feature specs live under
`specs/NNN-feature/`. The usual flow is `/speckit.constitution`,
`/speckit.specify`, `/speckit.plan`, `/speckit.tasks`, then
`/speckit.implement`.

Shared Spec Kit artifacts (`.specify/` and `specs/`) are committed.
Per-agent bindings are local developer setup and stay ignored, including
`.cursor/skills/`.

```bash
uvx --from git+https://github.com/github/spec-kit.git@v0.4.4 \
  specify init --here --force --ai cursor-agent --ai-skills --offline
```

## Development environment (container only)

All `npm`, `npx`, `node`, `pnpm`, `yarn`, and `playwright` commands for
this repo MUST run inside the `thundermail-dev` container. Do **not**
run them on the host. Do **not** install packages, browsers, or system
tools on the host. This applies to unit tests, e2e tests, the dev
server, build, dependency installs, Playwright browser installs, and
ad-hoc Node scripts that import repo code.

```bash
# From the stormbox/ directory — start if needed:
docker compose -f .devcontainer/docker-compose.yml up -d

# Run any npm/node/playwright command via exec:
docker compose -f .devcontainer/docker-compose.yml exec app bash -c 'cd /workspace && npm test'

# Long-running processes (stack:ws-proxy, dev) should detach and log
# inside the container:
docker compose -f .devcontainer/docker-compose.yml exec -d app bash -c \
  'cd /workspace && npm run stack:ws-proxy >/tmp/ws-proxy.log 2>&1'
```

The project is mounted at `/workspace` in the container. Playwright
browsers and `node_modules` belong there, not on the host. If the
container is missing tooling, extend `.devcontainer/Dockerfile` or run
`npm ci` / `npx playwright install` **inside** the container only.

### Container lifecycle

- Do **not** `docker stop` / `kill` / `pkill` `thundermail-dev` or
  anything it owns (vite on port 3000, ws-proxy inside it, etc.).
- If the container looks broken, ask first. Don't recreate it
  unilaterally.
- Port 3000 belongs to the container's vite. If something else is on
  port 3000 on the host, that's a configuration question for the user,
  not a license to kill the container.

### Why this matters

Host vs. container have different network namespaces, different
`node_modules`, different Playwright browser caches, and different
proxy targets (`STORMBOX_IN_DOCKER=1` switches vite proxy hosts).
Running on the host silently produces a broken environment that does
not reflect how tests actually run, leading to spurious "fixes" that
mask the real problem.

## JMAP and local cache

These rules apply to any change touching sync, stores, list/detail UI, or
mutations. Deeper background: `docs/architecture/performance.md` and
`docs/architecture/sqlite-storage.md`.

### Layer boundaries

- **Vue components and Pinia stores never call JMAP, `fetch`, or the JMAP
  transport.** They read via `Repository` (SQLite RPC) and ask the sync
  layer to ensure data is fresh (`ensureFolderWindow`, `getMessageBodyForDisplay`,
  `runMutation`, etc.).
- **All JMAP-specific code lives under `src/sync/backends/jmap/`** (transport,
  `JmapBackend`, mailbox/email/contact sync, bodies, outbox, `outbox-apply`).
- **The SharedWorker** owns wa-sqlite, the JMAP session/WebSocket, sync, and
  SQL writes. One worker per origin; tabs share it via `MessagePort` + a
  `BroadcastChannel` for `tables-touched` invalidation.

### Reads

- **SQLite is what the UI renders.** Navigation should paint from the local
  cache immediately; network is for cache misses and background fill.
- **Folder lists are positional, not SQL `OFFSET` on `folder_messages`.**
  Use `MESSAGE_LIST_FOR_VIEW` / `listMessagesForView`, which reads
  `query_view_items.position` (the JMAP `Email/query` position). Sparse
  folder caches break `OFFSET`-based reads at deep scroll offsets.
- **`query_views.total` is the authoritative row count** for the open
  mailbox window (from `Email/query` / `Email/queryChanges`), not
  `folders.total_emails` alone when the two disagree after a delete/move.
- **Bodies are an LRU cache** (`body_parts` / `body_values`), not durable
  mail storage. List metadata is durable; bodies are fetched on demand.

### Writes (mutations)

- **User actions enqueue `pending_mutations`**, then drain through the outbox
  (`OutboxRunner` → `processMutationRow` → JMAP `Email/set` / submission).
  Do not fire ad-hoc JMAP `Email/set` from the UI or stores.
- **After a successful `Email/set`, update SQLite in `outbox-apply.js`
  before returning** (`applyMoveLocally`, `applyDestroyLocally`, keyword
  helpers). Do not rely on waiting for a later `StateChange` push alone;
  by the time `runMutation` resolves, local tables and broadcasts should
  already match the server outcome.
- **Ordinary Delete moves to Trash** (`moveToFolders`); **permanent destroy**
  is for messages already in Trash (or explicit destroy flows).
- **Bulk local applies should not spam partial UI refreshes.** Batch SQL and
  coalesce `refreshLoadedPages` when many `MESSAGES` broadcasts arrive in
  one mutation (see `mail-store.js`).

### Sync

- **Incremental sync uses JMAP state tokens** (`Email/changes`,
  `Email/queryChanges`, `Mailbox/changes`, etc.) stored in `sync_states`.
  On `cannotCalculateChanges`, rebuild that slice (full refetch), do not
  pretend the cache is current.
- **Prefer chained JMAP calls** (e.g. `Email/query` + `Email/get` via
  back-references) to match network batch shape with SQLite batch writes
  (`MESSAGE_UPSERT_MANY`, `FOLDER_MEMBERSHIP_REPLACE_MANY`, etc.).
- **WebSocket transport** may require the Cloudflare proxy documented in
  `infra/ws-proxy/README.md` when the browser cannot send `Authorization`
  on `new WebSocket()`.

### Testing changes that touch server + cache

Any change that issues a JMAP/sync mutation **and** updates local SQLite
(`messages`, `folder_messages`, `query_view_items`, `query_views`, …) must
come with a Playwright E2E test in `stormbox/tests/e2e/`. Unit and
integration tests are necessary but not sufficient — Node-side fakes
hide failures we have been bitten by repeatedly:

- Node's `BroadcastChannel` polyfill is more forgiving than the Firefox
  SharedWorker → tab hop.
- `wa-sqlite` OPFS timing in Firefox differs from Chromium.
- Vue reactivity and the TanStack virtualizer only fail at the DOM
  level, not in mocked stores.

Every such E2E must:

1. Assert the user-visible UI outcome (rows appear / disappear in the
   rendered list, toolbar counts update, etc.).
2. Assert the local cache outcome via `window.__repo`
   (`listMessagesForView`, `queryViewProgress`, raw `db.query` reads).
3. Assert the server outcome via direct JMAP (`Email/get`, `Email/query`,
   etc.) — DO NOT rely on the worker's read-through.
4. Run on BOTH `--project=chromium` AND `--project=firefox`.
5. Clean up any test-created server-side mail in `finally` AND scrub
   orphans from prior interrupted runs in `beforeEach`. The
   `delete-message.spec.js` / `bulk-delete.spec.js` helpers
   (`sweepOrphanTestMessages`, `cleanupEmail`) are the template.
6. Use a unique subject prefix (`Delete e2e ...`,
   `Ghost refresh e2e ...`, etc.) so the sweep can find them.

Operations this rule covers:

- Any new `mutation_type` in `pending_mutations`.
- Any new `apply*Locally` helper in `src/sync/backends/jmap/outbox-apply.ts`.
- Any change to `destroyMessage(s)`, `markManySeen`, `refresh`, compose
  `send`, or `resetViewForFolder` semantics.
- Any new field surfaced through `MESSAGE_LIST_FOR_VIEW` /
  `QUERY_VIEW_APPLY_CHANGES` that the mail store re-reads.

If you cannot add the E2E (e.g. the user explicitly defers it), call
that out in the PR description and link the existing test that comes
closest, so coverage gaps are visible.

Run Playwright and perf scripts via `docker compose … exec app`, not on
the host (see above). Live specs require `LOCAL_STACK=1`
(`npm run test:e2e:local`) and the **thunderbird-accounts** submodule
stack.

### Local e2e stack (thunderbird-accounts submodule)

Live Playwright specs run against the **thunderbird-accounts** dev stack
vendored at `thunderbird-accounts/` (git submodule). Clone with
`git clone --recurse-submodules` or `git submodule update --init`.

Do **not** modify or commit inside the `thunderbird-accounts/` submodule
unless the user directly asks for a submodule change. Stormbox-local setup
should be handled from this repo (for example via `tests/fixtures/configure-*`)
so the parent repo can remain pinned to an upstream submodule commit.

Stormbox stays on **HTTPS with a self-signed cert** (`@vitejs/plugin-basic-ssl`)
so OPFS / SharedWorker / SubtleCrypto work. Keycloak (:8999) and Stalwart JMAP
(:8081) are plain HTTP on the host; when `VITE_LOCAL_STACK=1`, Vite reverse-
proxies them through `https://localhost:3000` (`/realms/*`, `/stalwart-jmap/*`,
`/jmap/ws` → local WS proxy).

```bash
# 1. Start Keycloak + Stalwart + Accounts (host or dev container with Docker)
cd thunderbird-accounts && docker compose up --build -d

# 2. One-time per fresh volume: open http://localhost:8087, sign in as
#    admin@example.org / admin, provision a Thundermail address.

# 3. Seed mail + start the local WS proxy (background)
npm run stack:seed
npm run stack:ws-proxy &

# 4. Run live e2e inside the dev container
docker compose -f .devcontainer/docker-compose.yml exec app bash -c \
  'cd /workspace && npm run test:e2e:local -- --project=chromium --project=firefox'
```

Without `LOCAL_STACK=1`, only `smoke.spec.js` runs (no stack required).
See `tests/e2e/.env.local.example` for optional overrides.

## Vue and project layout (summary)

- `<script setup>` only; section order: script, template, style.
- Pinia stores in `src/stores/` (`defineStore` composition API, `*-store.js`).
- Routes in `src/router/`; human-readable folder names in URLs.
- Views in `src/views/`; shared components in `src/components/`.
- Config via `src/defines.js` and Vite env vars (`VITE_JMAP_SERVER_URL`, etc.).
