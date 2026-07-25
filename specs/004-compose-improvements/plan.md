# Implementation Plan: Compose Improvements

**Branch**: `compose-improvements` | **Spec**:
[spec.md](./spec.md) | **Base**: `origin/main` at 6b7861b

## Summary

Sending is currently unsafe in three independent ways: the submission
envelope drops Cc and Bcc, method-level JMAP failures can pass as
success, and an ambiguous outcome is retried automatically. Recipient
autocomplete is unusable for its primary source, because contacts match
on address prefix only. This plan fixes the safety defects first, then
the recipient model, then makes the contact source trustworthy, then
rebuilds autocomplete on top of it.

## Technical context

**Language**: TypeScript and JavaScript, Vue 3 `<script setup>`, Pinia.
**Storage**: browser-local SQLite (`wa-sqlite`, `IDBBatchAtomicVFS`) in a
SharedWorker, with migrations under `src/db/migrations/`.
**Protocol**: JMAP Core, Mail, Submission, Contacts against Stalwart
v0.15.4 locally.
**Testing**: Vitest for unit, Playwright for e2e against the
`thunderbird-accounts` local stack, all inside the container.
**Constraints**: cache-first reads, server-authoritative writes, all
protocol mutations through the outbox, cache updated before a mutation
RPC resolves.

## Constitution check

- **Cache-First, Server-Authoritative**: preserved. CS-1.4 tightens it,
  because filing an unsent message into the local Sent view is a
  cache-ahead-of-server violation the current code commits.
- **Mutation Pipeline**: preserved and extended. Send gains explicit
  phases inside the existing `pending_mutations` row rather than a new
  parallel mechanism.
- **Verified Consistency**: the constitution requires cache
  reconciliation before a mutation completes. CS-1.10 satisfies this
  with a distinct `cache_pending` phase instead of retrying the
  irreversible submission, which is the only way to honor the rule
  without risking duplicate delivery.
- **Layer boundaries**: protocol values stay below the JMAP backend.
  The store continues to queue local row ids only.

## Approach by work package

### WP1 — Send safety hotfix

`runSend` in [outbox.ts](../../src/sync/backends/jmap/outbox.ts) is the
one mutation runner in the file that does not use the established
missing-response guard. Every other runner does:

```js
const response = pickResponse(raw, 'Mailbox/set');
if (!response) {
  const failure = extractMethodError(raw);
  // fail the item
}
```

`runSend` instead reads `submission?.notCreated` and treats a null
response as success (outbox.ts:1852-1855), then derives
`createdRemoteId` from the first `Email/set` tuple (:1862-1863), then
calls `applySendLocally`, which early-returns on a falsy id (:1937) so
the failure is silent.

Changes:

1. Drop the `envelope` from the `EmailSubmission/set` create
   (outbox.ts:1836-1842) so the server derives recipients.
2. Add `pickResponseById(result, methodName, callId)` to
   [invoke.ts](../../src/sync/backends/jmap/invoke.ts). `pickResponse`
   returns the *first* tuple matching a name, so it cannot address the
   implicit `Email/set` that `onSuccessUpdateEmail` emits under call id
   `s1`. Keep `pickResponse` for existing callers.
3. Validate `c1`, `s1`, and the implicit `s1` `Email/set`, reusing
   `extractMethodError` (outbox.ts:2271) for the failure shape.
4. Mark permanently-rejected submissions terminal using the existing
   `terminal: true` error flag that `outbox-runner.ts` honors
   (outbox-runner.ts:428), rather than widening
   `TERMINAL_ERROR_TYPES` for a type that can also be transient.
5. Gate `applySendLocally` on confirmed submission, and take mailbox
   placement from the `Email/get` result instead of assuming the
   requested target.
6. Recover stale `in_flight` rows at backend start in
   [backend.ts](../../src/sync/backends/jmap/backend.ts); migration 002
   only runs once because `runMigrations` skips applied versions
   ([engine.ts](../../src/db/engine.ts):226-241).
7. Block Close and Discard while `status === SENDING` in
   [ComposeDialog.vue](../../src/components/ComposeDialog.vue) and
   [compose-store.ts](../../src/stores/compose-store.ts).

### WP2 — Recipients and reply

New `src/utils/address-parse.ts` implementing the RFC 5322 address-list
grammar as a small state machine over the input: quoted-string, comment
nesting, angle-addr, and group syntax. Modeled on postal-mime's parser
rather than importing it, so there is no dependency to upstream fixes
into. `parseAddressList` in
[address-list.ts](../../src/utils/address-list.ts) becomes a thin
wrapper that returns both parsed addresses and rejected fragments;
`compose-quote.ts` stops splitting on commas.

Reply audience moves to structured `message_addresses` rows (kind
`to`/`cc`/`reply-to`), with the owned-address set assembled from the
account primary email plus every row in `identities`, so it no longer
depends on `fromIdentity.value` at the moment `prepareReplyAll` runs.

Threading reads `messages.rfc822_message_id` and
`messages.references_json`
([001_init.sql](../../src/db/migrations/001_init.sql):113-115) and adds
`inReplyTo` and `references` to the Email create.

### WP3 — Durable phased send

The checkpoint lives in the existing `pending_mutations` row. A new
migration adds a `phase` column plus an index for startup recovery;
the operation id, Message-ID, Email id, and submission id go into
`server_response_json`, which already exists for this purpose.

Phase transitions are the only place that writes `phase`, and each
transition is persisted before the next protocol call. Recovery reads
`phase` and dispatches to a resume handler per phase. R-4.4 in
`specs/001-mvp-scope/spec.md` is amended because it mandates a single
chained call.

### WP4 — Contact and identity integrity

Fix the state bug in
[contacts.ts](../../src/sync/backends/jmap/contacts.ts):125-152, add a
generation column for mark-and-sweep, and mirror the folder rule
FM-1.7 for contacts. Add an `addressbook_contacts` junction table with
a backfill from the existing `contacts.addressbook_id`. Identity sync
becomes a snapshot and persists `bcc`.

### WP5 — Autocomplete data

New `recipient_history` table plus a search-token table for contacts,
both populated through the existing DB handler layer. Rewrite
`DB_RPC.CONTACT_AUTOCOMPLETE` in
[handlers.ts](../../src/db/handlers.ts):2209 to query both pools, merge
by normalized address, and rank in SQL where possible so the limit
applies after merging rather than per source.

### WP6 — Recipient input control

New `src/components/RecipientInput.vue` owning pills, keyboard, ARIA,
paste, and the stale-response guard, used three times by
`ComposeDialog.vue`.

### WP7 — iOS overlay

Stacking-context fix for the folders overlay against the compose
dialog.

## Sequencing and rationale

WP1 must precede WP2, because WP2 exposes Cc and Bcc fields whose
recipients WP1 makes deliverable. Shipping the fields first would
advertise a feature that silently drops recipients.

WP3 depends on WP1's response validation, since phase transitions are
only meaningful once a phase's success can be determined.

WP4 precedes WP5, because ranking and de-duplication over a source that
never forgets deleted contacts would produce confidently wrong results.

WP7 is independent and can land at any point.

## Risks

- **Stalwart behavior on an omitted envelope.** CS-1.1 relies on
  server-side derivation. Verify against the local stack before relying
  on it, and capture the wire exchange in the e2e assertion.
- **Migration ordering.** WP3 and WP4 both add migrations; they must be
  authored in landing order to keep `user_version` linear.
- **Shared e2e account.** The local stack's `e2e@example.org` is shared
  with other worktrees, so live runs cannot be concurrent.
