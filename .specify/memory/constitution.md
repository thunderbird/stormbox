# Stormbox Constitution

This document holds Stormbox's product and architectural invariants.
Capability and behavior detail lives in `specs/001-mvp-scope/spec.md`.
Operational rules for agents and contributors live in `AGENTS.md`.
Implementation notes live in `docs/architecture/`.

## Core Principles

### I. Browser-Owned Mail Client

The system shall remain a fully in-browser webmail client with no
server-side mail application component. Self-hosters must be able to
run Stormbox against any supported mail server without adding a
Stormbox-specific backend.

### II. Cache-First, Server-Authoritative

- The UI shall paint navigation and message detail from local
  storage before any network round trip.
- The server shall be treated as the source of truth; the local cache
  is rebuildable on demand.
- Folder lists shall be read by JMAP `Email/query` position from
  `query_view_items`, not by SQL `OFFSET` over membership tables.
  `query_views.total` is the authoritative row count for an open
  mailbox window.
- Message bodies shall be treated as an LRU cache, not durable mail
  storage.
- When local data and server state disagree, the system shall
  reconcile from the server.

### III. Layer Boundaries

- Vue components and Pinia stores shall not call JMAP, `fetch`, or any
  protocol transport. UI reads go through `Repository` RPC; UI
  mutations go through `pending_mutations`.
- Protocol-specific code shall live behind a sync backend at
  `src/sync/backends/<protocol>/`.
- The browser-local SQLite engine, JMAP transport, sync engine, and
  mutation outbox shall run in a single shared writer worker per
  origin. SharedWorker is the current implementation; a leader-elected
  DedicatedWorker fallback is acceptable in browsers that lack
  SharedWorker (e.g. Android Chrome).
- Tabs shall communicate with the worker via `MessagePort` and
  observe writes via a `BroadcastChannel` that names the affected
  table families.

### IV. Mutation Pipeline

- User actions shall enqueue rows in `pending_mutations` and drain
  through the outbox runner. UI code shall not issue ad-hoc protocol
  writes.
- After a successful protocol write, the local cache shall already
  match the server before the mutation RPC resolves; waiting only for
  an asynchronous push is not sufficient.
- Ordinary delete moves a message to Trash. Permanent destroy is
  reserved for messages already in Trash or explicit destroy flows.
- Bulk applies shall batch SQL and coalesce per-row UI refreshes into
  one paint.

### V. Incremental Sync

- Incremental sync shall use JMAP state tokens (`Email/changes`,
  `Email/queryChanges`, `Mailbox/changes`, etc.) stored in
  `sync_states`. On `cannotCalculateChanges`, the affected slice shall
  be rebuilt from the server rather than treated as current.
- The system shall prefer chained JMAP calls (e.g. `Email/query` +
  `Email/get` via back-references) so network and SQLite batch shapes
  match.

### VI. Safe Email Rendering

HTML email shall be sanitized and rendered in a sandboxed iframe with
a Content-Security-Policy that forbids scripts and active content.
Links shall not navigate the host page.

### VII. Single-Account MVP, Extensible Model

The MVP supports a single active account. Storage and service
boundaries shall not assume only one account or one provider will
ever exist.

### VIII. Earlybird-Ready Scope Discipline

The system shall prioritize the smallest webmail surface suitable for
an Earlybird audience alpha: reliable sign-in, reading, sending, safe
display, basic message actions, and recipient autocomplete. Features
outside that scope must not displace core read/send reliability.

## Technology Commitments

- Frontend: Vue 3 + Pinia, Vite, TypeScript.
- Editor: Squire for HTML compose; a plain-text body sent alongside.
- Mail protocol: JMAP for the MVP, initially against Stalwart.
- Authentication: Keycloak OIDC for hosted/development flows; basic
  username/password for self-hosters.
- Local storage: wa-sqlite over IndexedDB (`IDBBatchAtomicVFS`)
  inside the shared writer worker.
- WebSocket auth bridge: when the browser cannot attach an
  `Authorization` header to `WebSocket`, JMAP traffic shall route
  through a proxy that converts a query-string credential into the
  upstream `Authorization` header.
- Hard runtime requirements: secure context (HTTPS), IndexedDB,
  BroadcastChannel, MessageChannel, and a worker context (SharedWorker
  or DedicatedWorker fallback). The system shall fail fast with a
  clear error when these are unavailable.

## Verified Consistency

Any change that mutates server state and the local cache must ship
with a Playwright E2E test that asserts:

1. The user-visible UI outcome.
2. The local cache outcome via `window.__repo`.
3. The server outcome via direct JMAP, not the worker read-through.

The test must run on both `--project=chromium` and
`--project=firefox`. Helpers, scope, and cleanup conventions live in
`AGENTS.md`.

## Workflow

Specs live under `specs/NNN-feature/` and follow this constitution.
Agents use the Spec Kit flow: `/speckit.constitution`,
`/speckit.specify`, `/speckit.plan`, `/speckit.tasks`,
`/speckit.implement`. Operational rules in `AGENTS.md` (dev container,
local stack, E2E conventions, project layout) take precedence over
this document for day-to-day contribution rules.

## Governance

This constitution is the source of project-wide product and
architectural constraints. Feature specs, plans, and tasks must call
out any conflict before implementation begins. Amendments require an
update to this file with a brief reason.

**Version**: 1.1.0 | **Ratified**: 2026-05-21 | **Last Amended**: 2026-05-22
