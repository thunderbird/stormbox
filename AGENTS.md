# Stormbox — agent guide

Stormbox is a Vue 3 + Pinia webmail client backed by OPFS SQLite in a
`SharedWorker`, with a Stalwart JMAP server as the mail source of truth.

## Development environment (container only)

Do **not** install dependencies, browsers, or CLI tools on the host
(`npm install`, `npx playwright install`, system packages, etc.). Run all
commands inside the dev container (`thundermail-dev`).

```bash
# From the stormbox/ directory — start if needed:
docker compose -f .devcontainer/docker-compose.yml up -d

# Run any npm/node/playwright command via exec:
docker compose -f .devcontainer/docker-compose.yml exec app bash -c 'cd /workspace && npm test'
```

The project is mounted at `/workspace` in the container. Playwright
browsers and `node_modules` belong there, not on the host. If the
container is missing tooling, extend `.devcontainer/Dockerfile` or run
`npm ci` / `npx playwright install` **inside** the container only.

## JMAP and local cache

These rules apply to any change touching sync, stores, list/detail UI, or
mutations. Deeper background: `docs/performance-architecture.md` and
`../WEBMAIL_SQLITE_STORAGE_SPEC.md` (parent repo).

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
follow `.cursor/rules/cache-server-tests.mdc`: Playwright E2E on Chromium
and Firefox, asserting UI + `window.__repo` + direct JMAP (not worker
read-through), with orphan sweep and cleanup. Run Playwright and perf
scripts via `docker compose … exec app`, not on the host (see above).

## Vue and project layout (summary)

- `<script setup>` only; section order: script, template, style.
- Pinia stores in `src/stores/` (`defineStore` composition API, `*-store.js`).
- Routes in `src/router/`; human-readable folder names in URLs.
- Views in `src/views/`; shared components in `src/components/`.
- Config via `src/defines.js` and Vite env vars (`VITE_JMAP_SERVER_URL`, etc.).
