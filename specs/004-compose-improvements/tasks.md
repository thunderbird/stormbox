# Tasks: Compose Improvements

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)
**Format**: `[ID] [P?] Description` — `[P]` means parallelizable with the
task above it.

All `npm` and `playwright` commands run inside the `stormbox-compose`
container:

```bash
docker exec stormbox-compose bash -c 'cd /workspace && npm test'
```

## Phase 0 — Specification

- [x] T001 Write `specs/004-compose-improvements/spec.md`
- [x] T002 Write `specs/004-compose-improvements/plan.md`
- [x] T003 Write `specs/004-compose-improvements/tasks.md`
- [x] T004 Amend R-4.4 in `specs/001-mvp-scope/spec.md` so a durable
      checkpoint between Email creation and submission is permitted, and
      move R-4.7 (Cc/Bcc) into this feature's scope

## Phase 1 — Send safety hotfix (CS-1.1 to CS-1.5, CS-1.11, CS-1.12)

- [ ] T101 Add `pickResponseById(result, methodName, callId)` to
      `src/sync/backends/jmap/invoke.ts`, leaving `pickResponse` intact
- [ ] T102 [P] Unit-test `pickResponseById` against a multi-tuple
      envelope containing two `Email/set` responses and an `error` tuple
- [ ] T103 Remove the `envelope` from the `EmailSubmission/set` create in
      `runSend` so the server derives `rcptTo` from To, Cc, and Bcc
- [ ] T104 Validate `Email/set`/`c1`, `EmailSubmission/set`/`s1`, and the
      implicit `Email/set`/`s1` in `runSend`, failing via
      `extractMethodError` when a tuple is missing, is an `error`, or
      carries no created id
- [ ] T105 Flag permanently-rejected submissions `terminal: true` so the
      outbox runner stops instead of recreating the Email per attempt
- [ ] T106 Gate `applySendLocally` on a confirmed submission and read
      mailbox placement from the `Email/get` result, so nothing enters
      Sent locally unless it was sent
- [ ] T107 Unit-test `runSend` failure paths: missing `EmailSubmission/set`
      tuple, `error` tuple, missing created id, failed implicit update.
      Assert no Sent write and a preserved mutation row in each case
- [ ] T108 Recover stale `in_flight` mutations at backend start, with a
      unit test proving a row stranded by a simulated crash is picked up
- [ ] T109 Block Close and Discard while a send is in flight, with a
      component test
- [ ] T110 E2E: send with To, Cc, and Bcc to separate accounts; assert
      all three receive and Bcc is absent from delivered headers
- [ ] T111 E2E: inject a method-level error and assert the composer
      reports failure, the mutation row survives, and Sent is untouched
- [ ] T112 Run `npm test`, `npm run typecheck`, `npm run lint`; commit

## Phase 2 — Recipients and reply (CS-2.1 to CS-2.8)

- [ ] T201 Add `src/utils/address-parse.ts` implementing the RFC 5322
      address-list grammar, returning parsed addresses and rejected
      fragments
- [ ] T202 [P] Unit-test the parser: quoted display name containing a
      comma, nested comments, group syntax, angle-addr, internationalized
      local part and domain, and malformed fragments
- [ ] T203 Rewrite `parseAddressList` in `src/utils/address-list.ts` on
      the new parser, keeping the existing signature working for callers
- [ ] T204 Remove the comma-split address handling from
      `src/utils/compose-quote.ts`
- [ ] T205 Move draft recipients to structured arrays in
      `src/stores/compose-store.ts`
- [ ] T206 Add Cc and Bcc fields to `src/components/ComposeDialog.vue`
- [ ] T207 Permit send when any of To, Cc, or Bcc holds a recipient
- [ ] T208 Rebuild Reply All from structured `message_addresses`:
      original To and Cc, Reply-To preferred over From, all owned
      addresses excluded, Bcc never copied
- [ ] T209 [P] Unit-test reply audience: Reply-To present, original Cc,
      duplicate recipients, several owned aliases, and a selected From
      that differs from the default identity
- [ ] T210 Set `inReplyTo` and extend `references` on the Email create
      from the cached parent values
- [ ] T211 Display Cc in the message detail view
- [ ] T212 Apply the Identity `replyTo` default on send; persist but do
      not apply `bcc` pending a product decision
- [ ] T213 E2E: Reply All against a message with Reply-To and Cc,
      asserting `In-Reply-To` and `References` over direct JMAP
- [ ] T214 Run checks; commit

## Phase 3 — Durable phased send (CS-1.6 to CS-1.10, CS-1.13)

- [ ] T301 Migration: add `phase` to `pending_mutations` with a recovery
      index
- [ ] T302 Generate a stable per-operation Message-ID header and
      operation id, persisted before Email creation
- [ ] T303 Split `runSend` into create, submit, and reconcile phases,
      persisting each checkpoint before the next protocol call
- [ ] T304 Resume from the recorded phase; never repeat a confirmed phase
- [ ] T305 Positive reconciliation after a lost response: Message-ID plus
      mailbox scope for creation, submission and mailbox state for
      submission
- [ ] T306 Durable `send-outcome-unknown` state with no automatic retry
      and no plain Retry action
- [ ] T307 Separate `cache_pending` so reconciliation failure retries
      only reconciliation
- [ ] T308 [P] Unit-test each phase resume path, including a lost create
      response, a lost submission response, and a purged
      `EmailSubmission`
- [ ] T309 Change send confirmation copy to mean accepted for submission
- [ ] T310 E2E: kill and reload the SharedWorker mid-send; assert exactly
      one Email and at most one delivery
- [ ] T311 Run checks; commit

## Phase 4 — Contact and identity integrity (CS-4.1 to CS-4.7)

- [ ] T401 Persist the ContactCard object state from `ContactCard/get`
      rather than `query.state`
- [ ] T402 Migration: contact sync generation column plus an
      `addressbook_contacts` junction table with a backfill
- [ ] T403 Make full contact sync authoritative: transactional
      mark-and-sweep after all pages succeed, then a
      `ContactCard/changes` catch-up from the baseline
- [ ] T404 [P] Unit-test that an interrupted paging sequence does not
      sweep, and that a server-side deletion is reflected locally
- [ ] T405 Represent multi-address-book membership through the junction
      table
- [ ] T406 Stop reporting contact mutation success when cache
      reconciliation failed; checkpoint and retry reconciliation only
- [ ] T407 Apply `Identity/get` as a snapshot including the empty-list
      case; persist `replyTo` and `bcc`
- [ ] T408 Refresh identities on compose open and reconnect, painting
      cached values first
- [ ] T409 E2E: alias fidelity — selected alias reaches the externally
      received From header (#60, #86)
- [ ] T410 Run checks; commit

## Phase 5 — Autocomplete data (CS-3.1 to CS-3.7, CS-3.13, CS-3.14)

- [ ] T501 Migration: `recipient_history` plus a contact search-token
      table with indexes
- [ ] T502 Write recipient history only after a confirmed submission
- [ ] T503 Backfill history from Sent-folder messages whose From is an
      owned address; exclude everything else
- [ ] T504 Populate search tokens for display name, full name, given and
      family names, organization, and nickname on contact persist
- [ ] T505 Rewrite `DB_RPC.CONTACT_AUTOCOMPLETE`: query both pools, merge
      by normalized address, rank deterministically, apply the limit
      after merging
- [ ] T506 [P] Unit-test matching and ranking: name and token-order
      matches, exact history outranking a weak contact substring,
      one row per address, deterministic display-name winner
- [ ] T507 Exclude addresses already entered across To, Cc, and Bcc, and
      suppress owned addresses
- [ ] T508 Add remove-suggestion and clear-history controls
- [ ] T509 [P] Performance test at 500+ contacts and a large history
      against a stated latency budget
- [ ] T510 E2E: import beyond one server page, then find a late-page
      contact by name from compose
- [ ] T511 Run checks; commit

## Phase 6 — Recipient input control (CS-3.8 to CS-3.12)

- [ ] T601 Add `src/components/RecipientInput.vue` with committed
      recipient pills and validation state
- [ ] T602 Implement the WAI-ARIA combobox pattern, including
      `aria-activedescendant`, announced result count, accessible pill
      removal, and focus restoration
- [ ] T603 Enter accepts a highlighted suggestion only; otherwise commit
      typed input or report a parse error
- [ ] T604 Debounce queries and discard stale responses via a request
      sequence
- [ ] T605 Multi-address paste on comma, semicolon, and newline, with
      rejected fragments surfaced
- [ ] T606 Bound the suggestion list and add a browse-contacts path
- [ ] T607 Use the control for To, Cc, and Bcc in `ComposeDialog.vue`
- [ ] T608 [P] Component tests: mouse, keyboard, Escape, blur, paste,
      cross-field duplicate suppression, rapid typing
- [ ] T609 Run checks; commit

## Phase 7 — iOS compose overlay (#49)

- [ ] T701 Fix the folders overlay stacking against the compose dialog
- [ ] T702 Responsive CSS test coverage
- [ ] T703 Run checks; commit
