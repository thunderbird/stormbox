# Pinia store contract

This document codifies what every Pinia store in `src/stores/` is
allowed to do and what it must delegate elsewhere. The constitution
(`.specify/memory/constitution.md` Principle III, IV) is the source;
this file is the day-to-day reference contributors and reviewers
hit when a new store or a new store action lands.

## What a store is

A store is a Pinia composition-API `defineStore` that holds the
session-scoped state for one slice of the UI (auth, mail, compose,
contacts, settings) and exposes the actions a component can call to mutate
that state. Stores never run protocol code or manipulate the DOM.
Narrow browser mirrors and lifecycle timers remain store-owned when
they are part of that state's account-safe lifecycle. Anything else
belongs in a composable, worker handler, sync backend, or component.

## Layer boundaries

### Stores must not

- Call `fetch`, JMAP, IMAP, or any other protocol transport. Reads
  and writes go through `Repository` RPC, which delegates to the
  SharedWorker.
- Read or write `document` or `window`. The eslint config bans both
  in `src/stores/**`. `globalThis.localStorage` is limited to the
  settings boot mirror; server data remains in SQLite.
- Embed JMAP method-call payloads in the store. Mail, send, draft, and
  mailbox `pending_mutations` rows carry local ids; the outbox resolves
  remote ids at dispatch. Identity (and some contact) rows already
  store the server `remoteId`.
- Leave a timer alive across reset or logout. Token renewal, notice
  expiry, and compose autosave timers are tracked by their owning
  store and cleared with its lifecycle.

### Stores may

- Hold reactive refs typed against `src/types/db.ts` row shapes.
- Watch other stores (typically `authStore.accountId`) and react.
- Subscribe to `Repository` table-touched broadcasts and re-run
  their queries.
- Insert into `pending_mutations` and call `runMutation` /
  `drainOutbox`, or patch settings through `applySettingsPatch`.
- Compose with other stores: `useMailStore` may call into
  `useAuthStore`, etc.

## State shape conventions

### Status as an enum

When a store has more than one boolean flag describing the same
underlying state machine, collapse the flags into a single status
ref typed against an `as const` object in `src/constants/states.ts`.
`AUTH_STATE` and `COMPOSE_STATE` are the store examples.
`MUTATION_STATUS` and `SYNC_JOB_STATUS` belong to the outbox and
`sync_jobs` rows, not store UI. Derived UI booleans (`isConnected`,
`isOidcReady`) are computed from the status, not parallel refs.

### Errors

Mail, compose, and contacts expose `error` as `string | null` (`ref`
or computed). `null` is "no error"; an empty string is never used.
Compose errors toast only when the dialog is closed. Mail and compose
also expose `notice` for success toasts. Auth keeps `error` for the
login gate. Settings does not participate. `StoreErrorToast` reads
those sources through `role="status" aria-live="polite"`; dismissing
a toast nulls the source ref.

### Absence is `null`

Refs that may be missing a value default to `null`, not `''` or
`undefined`. The exception is genuine empty user input (compose
draft fields, the quick-filter query), where empty string is the
literal user value.

### Naming

A ref named `errors` reads as "list of errors". A single string
goes by `error` or `errorMessage`. Names match shape.

### Repository handle

Every store with a Repository subscription holds the handle as
`let repo: Repository | null = null` (typed against
`src/db/repository.ts`). `null` means "before attach() resolved" or
"after detach()". The store re-checks before each call so a logout-
during-RPC race is harmless.

## Lifecycle

### attach / detach / $reset

Mail, compose, and contacts use the same three-method shape:

- `attach()`: idempotent. Resolve the repo, subscribe to broadcasts,
  set up the `authStore.accountId` watch.
- `detach()`: unsubscribe, drop the repo handle, call `$reset()`.
- `$reset()`: drop every piece of session-scoped state to its
  initial value. Called from the accountId watch on logout, exposed
  publicly so account switching and tests can clear without going
  through an OIDC redirect.

Settings `attach`/`detach` manage the repo subscription;
`$reset` restores the browser mirror and does not run from `detach`.
Auth has `$reset` and `logout`; `logout` stops token sync, stops the
worker account, then `$reset`, then the OIDC redirect.

### Broadcast subscriptions

Stores subscribe through `repo.subscribe(onTablesTouched)` and
re-run their derived queries when the matching `TABLE_FAMILIES`
flag is set. Bursts of broadcasts are coalesced single-flight so a
flurry of MESSAGES touches collapses into one re-read pass — see
`refreshLoadedPages` in `mail-store` for the pattern.

## Mutations

User actions that change server state are queued through
`pending_mutations` and drained by the worker-side `OutboxRunner`.
Mail triage that must be on screen when the action returns
(`destroy` / `move`) writes a row and awaits `runMutation`. Mark-seen
and keywords enqueue and let the runner drain. Settings patch through
`applySettingsPatch`, which coalesces `pushSettings` in the same
transaction.

### Mutation payloads carry local ids for mail

Mail, send, draft, and mailbox `request_json` uses local ids. The
modular outbox (`outbox/index.ts`) resolves remote ids at dispatch
(`resolveRemoteMessageIdsByAccount`, `resolveFolderRemoteIds`,
`resolveIdentity`). Identity and some contact rows already carry
server `remoteId`.

AddressBook create, edit, inventory, and delete remain contacts-store
actions. The store reads the persisted Contacts capability and fails
closed unless `mayCreateAddressBook` is explicitly true. It passes local
book ids and authoritative inventory envelopes through Repository; the
JMAP backend owns remote-id resolution, fresh rights checks, recovery,
and post-write reconciliation.

### Local cache reconciliation is synchronous

When a mutation's protocol call succeeds, the matching operation
under `src/sync/backends/jmap/outbox/` writes the local cache change
before `runMutation` resolves. Move and destroy go straight to the
protocol-neutral `OUTBOX_APPLY_MOVE_BATCH` /
`OUTBOX_APPLY_DESTROY_BATCH` DB handlers; send and fallback
reconciliation use `send-apply.ts` and `messages-shared.ts`. The store can
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
- Mail, compose, and contacts action tests that hit SQLite use the
  in-memory engine (`bootTestEngine` from `src/db/bootstrap-memory`)
  and exercise the public surface. Settings tests mock the repository
  and `localStorage`.
- Verified-Consistency e2e tests live in `tests/e2e/` and run on
  Firefox by default (Chromium via `INCLUDE_CHROMIUM=1`). The pass
  condition is the synchronous-cache invariant: by the time the
  awaited action resolves, the local cache already matches what the
  server now holds.
