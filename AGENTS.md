# Stormbox — agent guide

Stormbox is a Vue 3 + Pinia webmail client backed by browser-local
SQLite in a shared writer worker, with JMAP as the mail source of
truth.

This document is the operational guide for agents and contributors.

- Product surface and capability requirements:
  `specs/001-mvp-scope/spec.md`.
- Folder hierarchy, shared accounts, subscriptions, CRUD, favorites,
  large-tree behavior, and folder-management UX:
  `specs/003-folder-management/spec.md`.
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

When a commit only relates to an issue without fixing it — follow-up work on an issue another commit already closed, partial progress, or a change whose context lives in that issue — reference it without the verb instead: `Commit message sentence. (#123)`. Reserve `Fixes` for the commit that actually closes the issue, so a reference never claims a fix it did not deliver.

# Code comments

Comments describe what the current code does and the constraints it must
satisfy. Do not narrate how the code used to behave or explain a fixed
bug at length. Concise references or links to fixed issues are acceptable;
detailed history belongs in the commit message and the issue.

Keep comments tight and strictly factual. Do not restate what the code
plainly does. Where a non-obvious constraint comes from a spec, cite the
requirement id (for example `FM-6.9`) or the RFC section instead of
explaining its background. The same applies to test comments: state what
the test pins, not which regression prompted it.

This governs comments you write. Leave existing comments alone, even
where they break the rule — do not rewrite them unless asked.

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
- **`container_name: thundermail-dev` is not unique to this checkout.**
  Sibling worktrees declare the same name, and whichever came up first
  owns it, so `docker compose -f .devcontainer/docker-compose.yml exec
  app ...` from here can run inside *another* checkout's container
  against its code — silently, since `/workspace` exists there too. The
  container bound to this worktree is `stormbox-compose`. Address it by
  name (`docker exec stormbox-compose ...`) and confirm the mount first:

```bash
docker inspect stormbox-compose \
  --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
```

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

## Reference server behaviour (Stalwart v0.15.4)

Measured directly against the local stack during the 004 compose work.
Several of these contradict what seemed obvious, so re-measure before
trusting an assumption rather than this list:

- It **does** derive `rcptTo` from To + Cc + Bcc for a separately stored
  Email, including the Bcc-only case. An earlier assumption to the contrary
  was wrong; do not reintroduce a client-built envelope without
  re-measuring.
- An explicit `rcptTo: []` is **accepted**, files the message into Sent
  and delivers to nobody. Omitting the envelope keeps the server's
  `noRecipients` rejection, which is why omission is the safer default.
- It emits the implicit `Email/set` from `onSuccessUpdateEmail` under the
  **submission's** call id, so `pickResponse` by name alone can never see
  it. Use `pickResponseById`.
- `EmailSubmission` records are retained briefly and reaped later, so
  their absence proves nothing.
- The object limits are `getMaxResults` 500 (what the session advertises as
  `maxObjectsInGet`), `setMaxObjects` 500, and **`queryMaxResults` 5000**.
  The query cap is the one to be careful with: it is not advertised in the
  session object, so a client only learns it from the `limit` a response
  echoes back. Probing it against a handful of contacts proves nothing —
  the cap is far above any small account, so a single unpaged query looks
  complete right up until an address book crosses 5000 and the reply comes
  back silently truncated. Paging is not optional, and neither is the
  `queryState` check that makes the pages one list.
- Every shape of the RFC 8621 `header` FilterCondition returns no results.
  Finding an Email by Message-ID means listing a mailbox and comparing
  client-side.
- **Self-addressed mail is accepted and never delivered** (issue #77).
  Assert delivery against the second account, never the sending one.
- **A rate-limited sender's mail is accepted and never delivered.** The
  default per-sender SMTP limit is 25 messages an hour, which a full e2e
  lane exceeds. Past it, `EmailSubmission/set` still returns a created
  submission, `onSuccessUpdateEmail` still files the message in Sent and
  clears `$draft`, and the internal SMTP hop then rejects it at `MAIL
  FROM` — no queue entry, no bounce, nothing delivered. Verified directly
  against v0.15.4: the JMAP answer is indistinguishable from a real send,
  so no client can detect this. Every unexplained "sent but never
  arrived" e2e failure should be checked against
  `smtp.rate-limit-exceeded` in the server log before it is treated as a
  defect.

  The local stack now raises that limit in
  `thunderbird-accounts/mail/etc/config.toml`
  (`queue.limiter.inbound."sender"`). Stalwart warns that the key also
  exists in its settings database, so the file's value cannot be assumed
  to win — it was confirmed by sending 30 messages in one burst and
  finding 30 deliveries and no rate-limit hits in the log.
- The JMAP `subject` filter is full-text tokenised and cannot match a
  subject containing `Re:`. Locate replies by exact-subject comparison
  over a mailbox listing.

## E2E environment gotchas

- `connectJmap()` takes `username`, not `email`. Passing `email` silently
  authenticates the default account and looks like a credentials failure.
- The second account is `shared-e2e@example.org` / `shared-e2e`,
  provisioned by `tests/fixtures/configure-keycloak.mjs`, which resets
  passwords on every run.
- That fixture writes the realm-wide `frontendUrl` and replaces the
  shared client's redirect origins from `VITE_LOCAL_PUBLIC_ORIGIN`, so
  running it with a non-default origin reconfigures Keycloak for **every**
  worktree. Run it with default env only.
- Do not pipe command output through `tail`; it buffers and hides
  progress on long runs.
- **Never run two lanes at once.** `workers: 1` serialises tests within one
  Playwright process and does nothing about a second process, and both share
  the one Stalwart account. An overlap produced a report of one hard failure
  and two flakes, none of which meant anything: the run that caused them
  passed, and the run that suffered them looked like a product defect —
  a mailbox seeded with 1033 messages counted 0 a moment later. Global setup
  now takes a lock (`tests/e2e/helpers/lane-lock.js`) and a second lane fails
  fast, naming the command that holds it. It cannot see a lane in another
  container.
- `resetSharedSession` had to learn to return to the Mail space:
  `contacts-junk.spec.js` leaves the window in Contacts, where no
  `.folder-node` exists, so the next spec's Inbox click waited out its
  full 30s timeout. Any new space-switching spec needs the same courtesy.
- Firefox ignores `clipboardData` passed to the `ClipboardEvent`
  constructor and substitutes an *empty* one, so a synthetic paste reads as
  an empty clipboard and a null check never catches it. Compare the payload
  and attach it with `Object.defineProperty` when it does not survive; see
  `pasteIntoTo` in `compose-recipient-control.spec.js`. A real paste always
  carries a payload, so this belongs in the harness, not in the component.
- A pill's own `aria-label` continues into a sentence ("… Activate to
  edit."), so an address matched out of it comes back with the full stop
  attached. `recipientAddresses` reads the remove button's label instead,
  which ends at the address.
- **`refresh-button.spec.js` is broken on Firefox, not flaky.** Pre-existing
  and unrelated to the change under test — the spec seeds over JMAP, writes a ghost row
  into the repository and reloads, never opening the composer — but recorded
  here properly because it fails the lane on its own. Three uncontended runs
  of it: Firefox failed 2, and one of those failed its retry as well;
  Chromium passed 3 for 3 in 3.0s each time. It dies at line 127 waiting for
  the ghost row after `page.reload()`, and the snapshot shows the Inbox
  settled at 15 rows holding neither the ghost row *nor* the baseline
  message the spec created and asserted visible before the reload. So the
  reloaded window renders a state older than the test's own setup, which is
  either a hydration defect or a race the spec's premise depends on. It was
  logged as an occasional Firefox flake earlier, and once on Chromium at the
  next assertion (line 128, the baseline row); the two engines fail at
  different assertions, so one root cause is not established.
- **A self-addressed send cannot prove delivery.** The client writes the
  Sent copy before submitting, so when Stalwart delivers the message back to
  the same account its ingest drops the inbound copy as a duplicate
  Message-ID — while still answering 250, and logging
  `message-ingest.duplicate`. The Inbox copy simply never appears. Anything
  asserting on what a recipient received has to send to the second account,
  which has no Sent copy to collide with.
- **The ws-proxy outlives the suite and can be running older code.** It is a
  long-lived process nothing in the run starts, Node loads a module once, and
  an older build forwards a marked frame untouched — which looks exactly like
  a marker that stopped matching, and costs a poll timeout to tell apart. Its
  `/__status` now lists the fault modes the running build knows, so a case can
  say "restart the proxy" instead. A new fault mode means adding it to
  `KNOWN_FAULT_MODES` **and** restarting the proxy.
- **Only the proxy inside `stormbox-compose` counts.** Vite forwards the
  JMAP socket to `127.0.0.1:8787` in its *own* namespace
  (`jmapWsDevProxyPlugin`), so the lane talks to the container's proxy.
  Leftover host-side proxies on the same port are unrelated: querying
  `/__status` from the host can report the mode a case needs while the
  proxy the lane actually uses is months old. Ask the container:

```bash
docker exec stormbox-compose curl -s http://127.0.0.1:8787/__status
```
- Counting a proxy's recorded faults does not prove one fired: the log
  outlives the run, so `> 0` is satisfied by an earlier case before the
  current one does anything. Bind the assertion to the id the fault was
  recorded against, as `faultApplied` and `cacheRefusalsFor` do.
- **A spec that needs the suggestion list open has to seed a contact.**
  Suggestions come from the address book and from addresses this account has
  written to, never from received mail (CS-3.3), and the e2e account is
  seeded with mail rather than with an address book. Part of the account's
  own address will not do either — an owned address is suppressed until it is
  typed in full (CS-3.7). Three specs typed `e2e` and passed on suggestions
  drawn from received mail, which is the defect WP5 removed.
- **Read suggestion rows only after the lookup has answered.** The query is
  debounced and then run in the worker, so an empty list a moment after
  typing means "not yet" as often as "nothing matched", and `count()` does
  not wait. The status line is written in both cases — a count, or "No
  suggestions" — so it is the signal to wait on. `settledSuggestions` in
  `compose-send-walkthrough.spec.js` does this.
- Nothing else in the suite is failing: `zz-large-bulk-move.spec.js` and
  `delete-message.spec.js` were only ever red under lane contention and pass
  6 for 6 uncontended, seed verification included. Chromium takes 15-19s over
  Firefox's ~1s on the Inbox-to-Trash case, consistently, which nobody has
  explained.

## Reviewing a work package

Each work package is implemented with tests, then reviewed by a *different*
agent before moving on. Approved reviewers: Kimi-K3, Opus 5, or GPT 5.6 Sol
— not Sonnet.

**OpenRouter and goose are for Kimi-K3 and nothing else.** Every other
reviewer comes from a Cursor subagent, which costs no OpenRouter credit and
does not depend on goose's stored key. Reaching for goose to run a GPT or
Opus review is wrong even when it would work. goose needs
`source ~/secrets.sh` first, because its own stored credential is stale:

```bash
source ~/secrets.sh >/dev/null 2>&1
goose run --no-session -q --provider openrouter --model moonshotai/kimi-k3 -t "…"
```

Budget the Kimi runs. A review that resends both diffs plus spec.md and
plan.md is roughly 61k input tokens *per turn* at $3/M, and an agentic loop
resends context every turn, so a full review costs dollars rather than
cents. Two of them died mid-run on the key's spend cap and reported it only
as `warning: Please check your account with your provider to add more
credits`, which reads like a transient failure and is not one. Check
`https://openrouter.ai/api/v1/key` for `limit_remaining` before blaming
anything else.

`~/.config/goose/secrets.yaml` holds a **stale** OpenRouter key that no
longer authenticates, and it does not matter: sourcing `~/secrets.sh` puts a
working key in the environment and goose prefers that over its stored
secret. Testing the file's value in isolation reports a revoked key and a
broken goose, which is wrong — one reviewer went down exactly that path.
Never print either value while checking; compare status codes.

**Give the reviewer a tree that cannot move.** Copy the worktree, or commit
first and hand over the ref — do not point a reviewer at files still being
edited. Reviewing the 004 recipient work, one reviewer's harness printed results that
contradicted the code it had read minutes earlier, because a second
reviewer's findings were being applied at the same time; it then spent its
remaining effort diffing snapshots to work out what it was looking at.
Findings against a moved file cannot be told apart from findings against a
defect, so both the reviewer's time and the reader's trust are wasted.

Reviews have repeatedly been right about substance, including one blocker
where a phase written after the wrong step reopened the duplicate-delivery
window, and one case where a claim of mine did not reproduce at all. Treat
their findings as claims to verify, not as either gospel or noise.

**A work package builds what it owns and nothing another one owns.** No
stand-in, no interim version, no "temporary" UI for a control a later
package specifies — that work is thrown away by the package that was always
going to do it properly, and it costs a second rewrite of every test that
touched it. In spec 004 the recipients package built a warning line under
the recipient field for unreadable fragments, which was the later pill
control's job; it was removed rather than shipped. When a requirement in the
current package seems to need part of a later one, the current package
delivers the guarantee at the level it owns — a fragment that reaches the
draft and a send that refuses, not a rendering of it — and the later package
adds the presentation.

Two rounds are worth the time when the first round changes anything
load-bearing. Reviewing Phase 1's close-out, Kimi found that
`transport.abort()` cancelled only what was in flight, so the next call of
a multi-call operation was issued after teardown began; the fix (a latch)
was then reviewed by GPT 5.6 Sol, which found that the latch's stated
justification — "nothing uses the transport after `stop()`" — was false,
because `_continueBootstrap()` runs detached and can reach
`openWebSocket()`. Each round found a defect the other did not, and the
second only existed because the first was acted on.

---

**Never let a reviewer write to the tree you are working in.** Hand over a
commit ref, or a copy. An agent asked to review WP4 read-only instead
applied its own fixes to the worktree, then ran `git checkout -- .` to tidy
up — which destroyed a round of uncommitted review fixes and silently
corrupted a Playwright lane that was running at the time, leaving the two
browsers executing different versions of the same spec. Commit before
handing work to any reviewer, and state the prohibition explicitly.
