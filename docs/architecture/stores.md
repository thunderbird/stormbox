# Pinia store contract

This document codifies what every Pinia store in `src/stores/` is
allowed to do and what it must delegate elsewhere. The constitution
(`.specify/memory/constitution.md` Principle III, IV) is the source;
this file is the day-to-day reference contributors and reviewers
hit when a new store or a new store action lands.

## What a store is

A store is a Pinia composition-API `defineStore` that holds the
session-scoped state for one slice of the UI (auth, mail, compose,
contacts) and exposes the actions a component can call to mutate
that state. Stores never run protocol code, never touch the DOM,
and never own background timers other than what flows out of their
own watchers. Anything that does not fit those rules belongs in a
composable, a worker handler, a sync backend, or a component.

## Layer boundaries

### Stores must not

- Call `fetch`, JMAP, IMAP, or any other protocol transport. Reads
  and writes go through `Repository` RPC, which delegates to the
  SharedWorker.
- Read or write `document`, `window`, `localStorage`, or any other
  global that ties them to a tab. The eslint config bans `document`
  and `window` in `src/stores/**` to enforce this.
- Embed JMAP-shaped values in mutation payloads. `pending_mutations`
  rows carry local row ids only; the outbox resolves remote ids at
  dispatch.
- Hold their own setTimeout / setInterval that survives logout. If
  a store needs scheduling, it lives in a composable that takes the
  store's deps (repo, accountId) so the composable can guard
  against drain-after-logout.

### Stores may

- Hold reactive refs typed against `src/types/db.ts` row shapes.
- Watch other stores (typically `authStore.accountId`) and react.
- Subscribe to `Repository` table-touched broadcasts and re-run
  their queries.
- Insert into `pending_mutations` and call `runMutation` /
  `drainOutbox` to drive the outbox.
- Compose with other stores: `useMailStore` may call into
  `useAuthStore`, etc.

## State shape conventions

### Status as an enum

When a store has more than one boolean flag describing the same
underlying state machine, collapse the flags into a single status
ref typed against an `as const` object in `src/constants/states.ts`.
`AUTH_STATE`, `COMPOSE_STATE`, `SYNC_STATE`, `MUTATION_STATUS`, and
`SYNC_JOB_STATUS` are the existing examples. Derived UI booleans
(`isConnected`, `isOidcReady`) are computed from the status, not
parallel refs.

### Errors

Every store exposes `error: Ref<string | null>`. `null` is "no
error", an empty string is never used. The matching status enum
includes a `FAILED` variant that the action sets at the same time
it writes the error. The global `StoreErrorToast` component reads
each store's `error` and surfaces them through
`role="status" aria-live="polite"`; dismissing a toast nulls the
source ref.

### Absence is `null`

Refs that may be missing a value default to `null`, not `''` or
`undefined`. The exception is genuine empty user input (compose
draft fields, the quick-filter query), where empty string is the
literal user value.

### Naming

A ref named `errors` reads as "list of errors". A single string
goes by `error` or `errorMessage`. Names match shape.

### Repository handle

Every store that talks to SharedWorker storage holds the handle as
`let repo: Repository | null = null` (typed against
`src/db/repository.ts`). `null` means "before attach() resolved" or
"after detach()". The store re-checks before each call so a logout-
during-RPC race is harmless.

## Lifecycle

### attach / detach / $reset

Every store with a `Repository` subscription exposes the same
three-method shape:

- `attach()`: idempotent. Resolve the repo, subscribe to broadcasts,
  set up the `authStore.accountId` watch.
- `detach()`: unsubscribe, drop the repo handle, call `$reset()`.
- `$reset()`: drop every piece of session-scoped state to its
  initial value. Called from the accountId watch on logout, exposed
  publicly so account switching and tests can clear without going
  through an OIDC redirect.

`auth-store.logout()` is the auth-specific equivalent; it calls
`stopSyncAccount`, runs the local clear (the same fields `$reset()`
clears), and then drives the OIDC redirect.

### Broadcast subscriptions

Stores subscribe through `repo.subscribe(onTablesTouched)` and
re-run their derived queries when the matching `TABLE_FAMILIES`
flag is set. Bursts of broadcasts are coalesced single-flight so a
flurry of MESSAGES touches collapses into one re-read pass — see
`refreshLoadedPages` in `mail-store` for the pattern.

## Mutations

User actions that change server state are queued through
`pending_mutations` and drained by the worker-side `OutboxRunner`.
The store is the producer; it writes a row, calls `runMutation`
(per-row) or `drainOutbox` (account-wide) on the repository, and
then reads back the success / error fields to surface to the UI.

### Mutation payloads carry local ids only

`pending_mutations.request_json` for SET_KEYWORDS, MOVE_TO_FOLDERS,
DESTROY, and SEND uses local `messages.id`, `folders.id`, and
`identities.id`. The outbox resolves to JMAP `remote_id` at dispatch
through `resolveRemoteMessageIds`, `resolveRemoteFolderIds`, and
`resolveIdentity`. Storing remote ids in the row would leak the
protocol across the layer boundary and break a hypothetical
non-JMAP backend that consumes the same row.

### Local cache reconciliation is synchronous

When a mutation's protocol call succeeds, the matching cache effect
in `src/sync/backends/jmap/outbox.ts` writes the local cache change
before `runMutation` resolves. Move and destroy go straight to the
protocol-neutral `OUTBOX_APPLY_MOVE_BATCH` /
`OUTBOX_APPLY_DESTROY_BATCH` DB handlers; send and the
notUpdated/notDestroyed fallback are handled by `applySendLocally`
and `reconcileMessageFromServer` in the same file. The store can
therefore splice the affected rows out of `messages.value`
synchronously after `runMutation` returns success — it does not need
to wait for the JMAP push channel and the broadcast hop.

## Type discipline

- Public actions exported from the store have explicit parameter and
  return types.
- Refs that hold row arrays use the canonical row types from
  `src/types/db.ts` (`FolderRow`, `MessageRow`, `IdentityRow`, etc.)
  rather than `any`. The sparse positional message buffer uses
  `CachedRow = MessageRow | undefined` (defined in
  `src/stores/mail-store-types.ts`).
- Folder role comparisons type the `folder` parameter against
  `{ role: MailboxRole | null }` so a typo in the literal side
  (`'sent'`, `'drafts'`, ...) is a compile error rather than a
  silent mis-route.
- `Repository.call<T>()` is generic; named helper methods on the
  Repository class can declare their return type when the consumer
  needs it. Stores typically rely on the destination ref's
  declared type to narrow.

## Comments

Comments in store code explain the non-obvious invariants and the
reason a particular shape protects them. Examples to keep:

- Why a coalescing single-flight is necessary on a broadcast handler
  (drift between MESSAGES storms and the UI re-render budget).
- Why a per-folder cache key holds its own `pageInflight` (cross-
  folder loads must not share an inflight promise or rapid switches
  deadlock).
- Why local ids cross the mutation boundary and remote ids do not.

Skip comments that just narrate what the next line does.

## Testing

- Pure helpers extracted from a store (address-list parser, folder
  presentation, body-prefetch composable) get their own focused
  unit-test file under `tests/unit/utils/` or
  `tests/unit/composables/` respectively.
- Store action tests use the in-memory engine
  (`bootTestEngine` from `src/db/bootstrap-memory.js`) and exercise
  the action through its public surface, not through internal
  implementation details.
- Verified-Consistency e2e tests live in `tests/e2e/` and run on
  Chromium and Firefox. Every shipped server+cache mutation has
  one. The pass condition is the synchronous-cache invariant: by
  the time the action's promise resolves, the local cache already
  matches what the server now holds.
