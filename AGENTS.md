# Stormbox — agent guide

Stormbox is a Vue 3 + Pinia webmail client backed by browser-local
SQLite in a shared writer worker, with JMAP as the mail source of
truth.

This document is the operational guide for agents and contributors.

- Product surface and capability requirements:
  `specs/001-mvp-scope/spec.md`.
- Project-wide product and architectural invariants (layer
  boundaries, cache-first reads, mutation pipeline, sync rules,
  browser baseline, safe rendering): `.specify/memory/constitution.md`.
  Read it before changing sync, stores, list/detail UI, or mutations.
- Implementation notes (storage schema, performance, sync flow):
  `docs/architecture/`.

# Commit messages

The first line of a commit message is one single, short sentence (200 characters max). For more complex commits, add 1-2 explanatory sentences as a body below, separated by a blank line. Do not include opinions and detailed research, stick to the precise facts of what was implemented in the commit.

Use a commit style similar to the other commits in the repository, don't randomly introduce conventional commit or any other types of tags.

When a commit closes a GitHub issue, append the issue reference in the historical format: `Commit message sentence. (Fixes #123)`.

## Spec-driven development

Spec Kit is the shared spec workflow. Slash commands:
`/speckit.constitution`, `/speckit.specify`, `/speckit.plan`,
`/speckit.tasks`, `/speckit.implement`.

Shared Spec Kit artifacts (`.specify/` and `specs/`) are committed.
Per-agent bindings, including `.cursor/skills/`, are local developer
setup and stay ignored.

```bash
uvx --from git+https://github.com/github/spec-kit.git@v0.4.4 \
  specify init --here --force --ai cursor-agent --ai-skills --offline
```

## Planning features and bug fixes

When implementing something new or fixing a bug, always search and review related literature.
For example if the implementation would touch JMAP code, review the JMAP spec and Stalwart's
code, as Stalwart is our reference implementation of JMAP.

Ensure to look for libraries that can supply functionality you need for the implementation.
This is especially important when performing calculations or interacting with complex data structures.
For example, writing our own HTML sanitizer doesn't make sense when DOMPurify exists.

Additionally, review implementations in other open source mail clients such as
Thunderbird desktop (comm-central), Roundcube, NextCloud webmail, Bulwark, Rainloop, etc.

Search for followup issues, regressions, and CVEs as well if you find a similar implementation.

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

## E2E coverage for cache + server mutations

The constitution's "Verified Consistency" rule requires every
server+cache mutation to ship with a Playwright E2E that asserts the
UI, local cache, and direct JMAP outcomes on Chromium and Firefox.
Operational details:

- Add coverage when introducing any new `mutation_type` in
  `pending_mutations`, any new post-success cache effect in
  `src/sync/backends/jmap/outbox.ts` (or any new
  `OUTBOX_APPLY_*` DB handler in `src/db/handlers.ts`), any change to
  `destroyMessage(s)`, `markManySeen`, `refresh`, compose `send`, or
  `resetViewForFolder` semantics, or any new field surfaced through
  `MESSAGE_LIST_FOR_VIEW` / `QUERY_VIEW_APPLY_CHANGES` that the mail
  store re-reads.
- Use the `delete-message.spec.js` / `bulk-delete.spec.js` files as
  templates. They show the UI assertions, the
  `window.__repo` reads (`listMessagesForView`, `queryViewProgress`),
  and the direct JMAP assertions (`Email/get`, `Email/query`).
- Use a unique subject prefix (e.g. `Delete e2e ...`,
  `Ghost refresh e2e ...`) so the sweep helpers can find leftover
  test mail.
- Clean up created server-side mail in `finally`, and scrub orphans
  from earlier interrupted runs in `beforeEach` via
  `sweepOrphanTestMessages` / `cleanupEmail` from
  `tests/e2e/helpers/`.
- Run via `npm run test:e2e:local -- --project=chromium --project=firefox`
  inside the dev container.

If you cannot add the E2E (e.g. the user explicitly defers it), call
that out in the PR description and link the existing test that comes
closest, so coverage gaps are visible.

Why Node-side fakes are not enough:

- Node's `BroadcastChannel` polyfill is more forgiving than a real
  worker → tab hop.
- `wa-sqlite` IndexedDB timing in Firefox differs from Chromium.
- Vue reactivity and the TanStack virtualizer fail at the DOM level,
  not in mocked stores.

## Local e2e stack (thunderbird-accounts submodule)

Live Playwright specs run against the **thunderbird-accounts** dev
stack vendored at `thunderbird-accounts/` (git submodule). Clone with
`git clone --recurse-submodules` or `git submodule update --init`.

Do **not** modify or commit inside the `thunderbird-accounts/`
submodule unless the user directly asks for a submodule change.
Stormbox-local setup should be handled from this repo (for example
via `tests/fixtures/configure-*`) so the parent repo can remain
pinned to an upstream submodule commit.

Stormbox stays on **HTTPS with a self-signed cert**
(`@vitejs/plugin-basic-ssl`) so the secure-context APIs Stormbox
relies on (SharedWorker, IndexedDB, SubtleCrypto) work. Keycloak
(:8999) and Stalwart JMAP (:8081) are plain HTTP on the host; when
`VITE_LOCAL_STACK=1`, Vite reverse-proxies them through
`https://localhost:3000` (`/realms/*`, `/stalwart-jmap/*`, `/jmap/ws`
→ local WS proxy).

```bash
# 1. Start Keycloak + Stalwart + Accounts (host or dev container with Docker)
cd thunderbird-accounts && docker compose up --build -d

# 2. One-time per fresh volume (DEV USE ONLY, not required for e2e):
#    open http://localhost:8087, sign in as admin@example.org / admin,
#    provision a Thundermail address. The e2e suite uses a separate
#    `e2e@example.org` account that is auto-provisioned by
#    tests/fixtures/configure-keycloak.mjs and configure-stalwart.mjs
#    on every run, so the developer's account stays uncontaminated.

# 3. Start the local WS proxy (background). seed-mail is no longer
#    required — the relevant specs seed their own data idempotently
#    via a beforeAll hook (see tests/e2e/helpers/jmap-client.js
#    `ensureArchivePopulated`).
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

## Import conventions

Local module imports must be extensionless for `.ts` and `.js` sources;
keep `.vue` and other asset extensions explicit. This is enforced by
ESLint (`import-x/extensions`) and matches the convention used in the
`thunderbird-accounts` submodule.

```ts
// good
import { useMailStore } from '../stores/mail-store';
import MessageView from '../components/MessageView.vue';
import iconUrl from '../assets/icons/tb-folder-archive.svg?raw';

// bad
import { useMailStore } from '../stores/mail-store.js';
import { useMailStore } from '../stores/mail-store.ts';
```

Package imports (e.g. `@journeyapps/wa-sqlite/src/examples/IDBBatchAtomicVFS`)
follow the same rule — drop the runtime extension when the resolver can
infer it.
