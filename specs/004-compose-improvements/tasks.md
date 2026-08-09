# Tasks: Compose Improvements

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)
**Format**: `[ID] [P?] Description` — `[P]` means parallelizable with the
task above it.

**Landing order is 1, 3, 2, 6, 4, 5, 7** — durable send phases come
before the recipient model, per the sequencing rationale in
[plan.md](./plan.md). Phase numbers match work-package numbers, not
landing order.

All `npm` and `playwright` commands run inside the `stormbox-compose`
container. Git runs on the **host**: the worktree's `.git` file points
outside the container's mount, so git is unavailable inside it.

```bash
docker exec stormbox-compose bash -c 'cd /workspace && npm test'
```

Live e2e additionally needs the WS proxy running inside the container, or
`tests/e2e/global-setup.js` aborts:

```bash
docker exec -d stormbox-compose bash -c 'cd /workspace && npm run stack:ws-proxy > /tmp/ws-proxy.log 2>&1'
docker exec stormbox-compose bash -c 'cd /workspace && npm run test:e2e:local -- --project=chromium --project=firefox'
```

Manual browsing from the host on this worktree's port works, but only
because the dev proxy rewrites the realm's pinned `frontendUrl` to the
configured public origin. Serve it with every public URL pointed at the
same origin and a Keycloak client registered for it:

```bash
docker exec -d stormbox-compose bash -c 'cd /workspace && \
  VITE_LOCAL_PUBLIC_ORIGIN=https://localhost:3001 \
  VITE_OIDC_ISSUER=https://localhost:3001/realms/tbpro \
  VITE_OIDC_CLIENT_ID=stormbox-compose \
  VITE_JMAP_SERVER_URL=https://localhost:3001/stalwart-jmap \
  VITE_SENDER_AVATAR_PROXY_URL=https://localhost:3001/sender-avatar \
  npm run dev > /tmp/vite.log 2>&1'
```

Note the hazard in the other direction: `tests/fixtures/configure-keycloak.mjs`
writes the realm-wide `frontendUrl` and replaces the shared client's
redirect origins from `VITE_LOCAL_PUBLIC_ORIGIN`. Running it with a
non-default origin therefore reconfigures the realm for **every** worktree
sharing it. Run the fixtures with default env only; the dev proxy is what
makes a non-default origin work locally.

## Phase 0 — Specification

- [x] T001 Write `specs/004-compose-improvements/spec.md`
- [x] T002 Write `specs/004-compose-improvements/plan.md`
- [x] T003 Write `specs/004-compose-improvements/tasks.md`
- [x] T004 Amend R-4.4 in `specs/001-mvp-scope/spec.md` so a durable
      checkpoint between Email creation and submission is permitted, and
      move R-4.7 (Cc/Bcc) into this feature's scope

## Phase 1 — Send safety hotfix (CS-1.1 to CS-1.5, CS-1.11, CS-1.12)

- [x] T101 Add `pickResponseById(result, methodName, callId)` to
      `src/sync/backends/jmap/invoke.ts`, leaving `pickResponse` intact
- [x] T102 [P] Unit-test `pickResponseById` against a multi-tuple
      envelope containing two `Email/set` responses and an `error` tuple
- [x] T103 Remove the `envelope` from the `EmailSubmission/set` create in
      `runSend` so the server derives `rcptTo` from To, Cc, and Bcc
- [x] T104 Validate `Email/set`/`c1`, `EmailSubmission/set`/`s1`, and the
      implicit `Email/set`/`s1` in `runSend`, failing via
      `extractMethodError` when a tuple is missing, is an `error`, or
      carries no created id
- [x] T105 Flag permanently-rejected submissions `terminal: true` so the
      outbox runner stops instead of recreating the Email per attempt
- [x] T106 Gate `applySendLocally` on a confirmed submission and read
      mailbox placement from the `Email/get` result, so nothing enters
      Sent locally unless it was sent
- [x] T107 Unit-test `runSend` failure paths: missing `EmailSubmission/set`
      tuple, `error` tuple, missing created id, failed implicit update.
      Assert no Sent write and a preserved mutation row in each case
- [x] T108 Recover stale `in_flight` mutations at backend start, with a
      unit test proving a row stranded by a simulated crash is picked up
- [x] T109 Block Close and Discard while a send is in flight, with a
      component test
- [x] T110 Never replay a send after a transport error: the socket can
      die after the server accepted the submission, so
      `unsafeToReplayTypes` makes that terminal instead of retryable
- [x] T111 E2E: send with To, Cc, and Bcc to separate accounts; assert
      all three receive and Bcc is absent from delivered headers
      (`tests/e2e/compose-send-walkthrough.spec.js`, Chromium + Firefox)
- [x] T112 E2E: inject a method-level error and assert the composer
      reports failure, the mutation row survives, and Sent is untouched
      (`tests/e2e/compose-send-method-error.spec.js`, Chromium +
      Firefox). Injection happens in the e2e WebSocket proxy
      (`tests/fixtures/ws-proxy/inject.mjs`): the transport lives in a
      SharedWorker, whose traffic Playwright's routing cannot reach, and
      it prefers WS whenever one is open. The proxy answers a marked
      request instead of forwarding it, so the server performs no
      operation and the spec can assert the message is in no mailbox at
      all. A method-level error naming the request is now terminal, so
      the composer stops waiting instead of burning eight retries
- [x] T113 Add a test asserting the migration list is contiguous and
      strictly increasing, so a later package cannot strand an earlier
      migration behind `user_version`
- [x] T113a Give HTTP JMAP requests an abortable deadline: with no
      timeout in `transport.ts`, a hung send leaves Close and
      Discard disabled indefinitely. The deadline spans the body read,
      not just the headers, and `backend.stop()` aborts the transport
      before awaiting runner shutdown. The abort latches: cancelling
      only what is in flight let the next call of a multi-call
      operation be issued after teardown began, holding `stop()` open
      for a fresh deadline. `openWebSocket` honours the latch on both
      sides of its awaits, and `_continueBootstrap` re-checks
      `_started`, because it runs detached from `start()` and swallows
      each step's failure — so teardown could not stop it, and it could
      leave an authenticated socket open for a signed-out account.
      Follow-ons the deadline exposed: the dedupe scan before a create
      now reports `found`/`absent`/`inconclusive` and only `absent`
      licenses a create (a stalled request, a WebSocket deadline, or a
      method-level rejection is not evidence that no draft exists), the
      scan is skipped entirely on a first attempt, and a stalled blob
      upload is terminal rather than spending eight 120s attempts with
      the composer stuck in its sending state
- [x] T113b Assert the new `{ filed }` send result in
      `tests/unit/sync/outbox-effects.test.ts`, which still ignores it
- [x] T114 Run unit, typecheck, lint, and the two-browser e2e lane;
      commit (855 unit tests, 90 e2e across Chromium and Firefox)

## Phase 2 — Recipients and reply (CS-2.1 to CS-2.8)

- [x] T201 Add `src/utils/address-parse.ts` implementing the RFC 5322
      address-list grammar, returning parsed addresses and rejected
      fragments
- [x] T202 [P] Unit-test the parser: quoted display name containing a
      comma, nested comments, group syntax, angle-addr, internationalized
      local part and domain, and malformed fragments
- [x] T203 Rewrite `parseAddressList` in `src/utils/address-list.ts` on
      the new parser, keeping the existing signature working for callers
- [x] T204 Remove the comma-split address handling from
      `src/utils/compose-quote.ts`
- [x] T205 Move draft recipients to structured arrays in
      `src/stores/compose-store.ts`
- [x] T206 Add Cc and Bcc fields to `src/components/ComposeDialog.vue`
- [x] T207 Permit send when any of To, Cc, or Bcc holds a recipient
- [x] T208 Rebuild Reply All from structured `message_addresses`:
      original To and Cc, Reply-To preferred over From, all owned
      addresses excluded, Bcc never copied
- [x] T209 [P] Unit-test reply audience: Reply-To present, original Cc,
      duplicate recipients, several owned aliases, and a selected From
      that differs from the default identity
- [x] T210 Set `inReplyTo` and extend `references` on the Email create
      from the cached parent values
- [x] T211 Display Cc in the message detail view
- [x] T212 Apply and persist the Identity `replyTo` default on send; do
      not request or persist Identity-level Bcc (CS-2.8)
- [x] T213 E2E: Reply All against a message with Reply-To and Cc,
      asserting `In-Reply-To` and `References` over direct JMAP
- [x] T214 E2E: reply audience and threading assertions against direct
      JMAP, on Chromium and Firefox
- [x] T215 Run checks including the two-browser e2e lane; commit

## Phase 3 — Durable phased send (CS-1.6 to CS-1.10, CS-1.13)

- [x] T301 Migration 006: add `phase` to `pending_mutations`
- [x] T302 Generate a stable per-operation Message-ID header and
      operation id, persisted before Email creation
- [x] T303 Split `runSend` into create, submit, and reconcile phases,
      persisting each checkpoint before the next protocol call
- [x] T304 Resume from the recorded phase; never repeat a confirmed phase
- [x] T305 Positive reconciliation after a lost response: Message-ID plus
      mailbox scope for creation, submission and mailbox state for
      submission. Note the Message-ID match is client-side: every shape
      of the RFC 8621 `header` FilterCondition returns nothing on
      Stalwart v0.15.4
- [x] T306 Durable `send-outcome-unknown` state with no automatic retry
      and no plain Retry action
- [x] T307 Separate `cache_pending` so reconciliation failure retries
      only reconciliation. Filing gets its own attempt budget
      (`cacheAttempts` on the checkpoint) because the row's `attempts`
      also counts the create and submit tries, and a send that burned
      those still deserves a full budget for the local repair
- [x] T308 [P] Unit-test each phase resume path, including a lost create
      response, a lost submission response, and a purged
      `EmailSubmission`
- [x] T309 Change send confirmation copy to mean accepted for submission.
      An unknown outcome now says so instead of claiming failure, and
      withdraws Send rather than inviting a second delivery
- [x] T310 E2E: kill and reload the SharedWorker mid-send; assert exactly
      one Email and at most one delivery
- [x] T311 E2E: a lost submission response resolving to success by
      reconciliation, and a genuinely ambiguous outcome staying in the
      unknown state without retrying (CS-5.5 cases two and three), plus
      the composer's own two answers: the warning with Send withheld, and
      the accepted-for-delivery confirmation
- [x] T312 Run checks including the two-browser e2e lane; commit

## Phase 4 — Contact and identity integrity (CS-4.1 to CS-4.8)

- [x] T401 Persist the ContactCard object state from `ContactCard/get`
      rather than `query.state`
- [x] T402 Migration: contact sync generation column plus an
      `addressbook_contacts` junction table with a backfill
- [x] T403 Make full contact sync authoritative: transactional
      mark-and-sweep after all pages succeed, then a
      `ContactCard/changes` catch-up from the baseline
- [x] T404 [P] Unit-test that an interrupted paging sequence does not
      sweep, and that a server-side deletion is reflected locally
- [x] T405 Represent multi-address-book membership through the junction
      table
- [x] T406 Stop reporting contact mutation success when cache
      reconciliation failed; checkpoint and retry reconciliation only
- [x] T407 Apply `Identity/get` as a snapshot including the empty-list
      case; persist `replyTo` and omit Identity-level Bcc (CS-2.8)
- [x] T407b Apply `AddressBook/get` as an authoritative snapshot with
      deletion handling (CS-4.8)
- [x] T408 Refresh identities on compose open and reconnect, painting
      cached values first
- [x] T409 E2E: alias fidelity — selected alias reaches the externally
      received From header (#60, #86)
- [x] T410 E2E: a contact mutation whose cache reconciliation fails
      reports failure rather than success, and retries only reconciliation
- [x] T411 E2E: a server-side contact deletion disappears locally after a
      full sync
- [x] T412 Run checks including the two-browser e2e lane; commit

## Phase 5 — Autocomplete data (CS-3.1 to CS-3.7, CS-3.13, CS-3.14)

- [x] T501 Migrations: add application-written contact address keys and
      search tokens in 007, plus the rebuildable recipient-usage cache in 008
- [x] T502 Promote recipients to ContactCards only after a confirmed
      submission
- [x] T503 Promote recipients from the newest 300 cached Sent messages
      whose From is an owned address; exclude everything else. Run the
      bounded scan off the compose path so the first keystroke never waits
      on it, and keep an empty or failed first pass pending for bootstrap
      retry.
- [x] T504 Populate search tokens for display name, full name, given and
      family names, organization, and nickname on contact persist
- [x] T505 Rewrite `DB_RPC.CONTACT_AUTOCOMPLETE`: query live ContactCards,
      join recipient-usage boosts, merge by normalized address, rank
      deterministically, and apply the limit after merging
- [x] T506 [P] Unit-test matching and ranking: name and token-order
      matches, exact address outranking a weak contact substring,
      one row per address, deterministic display-name winner
- [x] T507 Exclude addresses already entered across To, Cc, and Bcc, and
      suppress owned addresses
- [x] T508 Make normal ContactCard deletion remove the suggestion while
      keeping ranking refreshes read-only
- [x] T509 [P] Performance test against CS-3.14's budget as written: 50 ms
      at the 95th percentile over 5,000 contacts carrying usage evidence,
      measured in the worker rather than through the UI. Those are the
      numbers the requirement states; an easier fixture would leave the
      requirement untested rather than met.
- [x] T510 E2E: import beyond one server page, then find a late-page
      contact by name from compose
- [x] T511 Run checks including the two-browser e2e lane; commit

## Phase 6 — Recipient input control (CS-3.8 to CS-3.12)

- [x] T601 Add `src/components/RecipientInput.vue` with committed
      recipient pills and validation state: an unreadable entry commits as
      an invalid pill, marked by more than colour, and any pill reopens as
      editable text when activated — exactly as entered where it is invalid,
      canonical where it is not (CS-3.16)
- [x] T602 Implement the WAI-ARIA combobox pattern, including
      `aria-activedescendant`, announced result count and announced absence
      of results, accessible pill removal, and focus restoration. Every
      control operable by click, which is what a keyboard and a screen
      reader dispatch
- [x] T603 Enter accepts a highlighted suggestion only; otherwise commit
      typed input or report a parse error
- [x] T604 Debounce queries and discard stale responses via a request
      sequence, including answers to a list that has since been dismissed,
      left, or committed over
- [x] T605 Multi-address paste on comma, semicolon, and newline, with
      rejected fragments surfaced
- [x] T606 Bound the suggestion list and add a browse-contacts path
- [x] T607 Use the control for To, Cc, and Bcc in `ComposeDialog.vue`
- [x] T608 [P] Component tests: mouse, keyboard, Escape, blur, paste,
      cross-field duplicate suppression, rapid typing
- [x] T609 E2E: keyboard-only recipient entry and screen-reader
      semantics in both browsers
- [x] T610 Run checks including the two-browser e2e lane; commit

## Phase 7 — iOS compose overlay (#49)

- [x] T701 Fix the folders overlay stacking against the compose dialog
      so compose stays visible and interactive on small viewports
      (CS-2.9)
- [x] T702 Responsive CSS test coverage
- [x] T703 Run checks; commit

## Phase 8 — Explicit submission envelope (CS-1.1)

- [x] T801 Build the `EmailSubmission` envelope in `runSend` as the
      de-duplicated To, Cc, then Bcc union, reversing T103: server-side
      derivation silently skips header addresses its sanitizer rejects
      and delivers to the surviving subset
- [x] T802 Fail a send carrying no envelope recipients before any
      protocol call rather than sending `rcptTo: []`, which falls through
      to header derivation
- [x] T803 [P] Unit tests: envelope contents and ordering, Cc-only and
      Bcc-only sends, canonical de-duplication keeping the first
      addr-spec, atomic `invalidProperties` rejection without retry, and
      envelope stability across a resume
- [x] T804 Run checks; commit

## Phase 9 — Automatic historical recipient promotion (CS-3.13)

- [x] T901 Remove the Contacts import control and its RPC surface; run the
      historical ContactCard promotion automatically after a non-empty
      cached Sent-window refresh
- [x] T902 Preserve the per-account at-most-once latch, defer completion for
      an empty Sent window or failed mutation, and cover bootstrap retries
      and deletion permanence in unit tests
