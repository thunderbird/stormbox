# Implementation Plan: Compose Improvements

**Branch**: `compose-improvements` | **Spec**:
[spec.md](./spec.md) | **Base**: `origin/main` at 6b7861b

---

## Current state and handoff notes

Written so a fresh session can continue without the originating chat.
Everything below is either measured or committed; read [tasks.md](./tasks.md)
for the authoritative checklist.

### Where the work lives

- Worktree `/home/ec2-user/webmail/stormbox-compose`, branch
  `compose-improvements`, based on `origin/main` at 6b7861b.
- Dev container `stormbox-compose` (host port 3001 → container 3000).
  **Every** npm/node/playwright command runs inside it:
  `docker exec stormbox-compose bash -c 'cd /workspace && npm test'`.
- **Git runs on the host.** The worktree's `.git` points outside the
  container mount, so git is unavailable inside it.
- Live e2e additionally needs the WS proxy running in the container, or
  `tests/e2e/global-setup.js` aborts:
  `docker exec -d stormbox-compose bash -c 'cd /workspace && npm run stack:ws-proxy > /tmp/ws-proxy.log 2>&1'`

### Landing order, and the rule that keeps recurring

**`tasks.md` is the authoritative checklist — this section deliberately
keeps no second copy of it.** Landing order is **1, 3, 2, 6, 4, 5, 7**; the
reasoning is under "Sequencing and rationale" below.

One rule earned the hard way while closing WP1, and it generalises past
sending: **a read that exists to establish what the server has must
distinguish "the server says no" from "I could not ask"**. Collapsing the
two is what turns a stalled network into a duplicate. Three places had
done it — the dedupe scan before a create (`.catch(() => null)`), the
scan's own empty-list read when the method call was rejected outright,
and every request without a deadline, which could not report a stall at
all. `findEmailByMessageId` now returns `found` / `absent` /
`inconclusive`, and only `absent` licenses a create.

WP4 proved the same rule holds for reads that drive deletion rather than
creation: every way of misreading "the server has no more contacts" was a
way of deleting contacts it does have.

### Reference server, test environment, and review practice

These outlived this feature and moved to [AGENTS.md](../../AGENTS.md),
where the next one will find them: what Stalwart v0.15.4 was measured to
actually do, the e2e environment's traps, and how work packages get
reviewed. The lane lock's design rationale lives in
[lane-lock.js](../../tests/e2e/helpers/lane-lock.js) beside the code it
explains.

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
3. Validate `c1`, `s1`, and the implicit `s1` `Email/set`. Failure
   shapes come from a new `extractMethodErrorById`, because
   `extractMethodError` finds the first `error` tuple regardless of call
   id and would attribute Email/set's error to the submission.
   A missing implicit response does not fail the send: once submission is
   accepted the message may be in transit, so filing is marked
   unconfirmed instead of handing the row back for resubmission.
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
7. Close the larger duplicate-delivery hole: the runner turns a thrown
   `callJmap` into a retryable `transport` error, but the socket can die
   *after* the server accepted the submission. Mutation types listed in
   the runner's new `unsafeToReplayTypes` are never replayed
   automatically — not after a crash and not after a transport error.
   Until CS-1.8 lands, that means a flaky network turns a send into a
   surfaced failure with the draft intact, which is the safe direction.
8. Block Close and Discard while `status === SENDING` in
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

Reply audience moves to structured `message_addresses` rows (kinds
`to`, `cc`, and `replyTo` as written by `messages.ts`), with the
owned-address set assembled from the
account primary email plus every row in `identities`, so it no longer
depends on `fromIdentity.value` at the moment `prepareReplyAll` runs.

Threading reads `messages.rfc822_message_id` and
`messages.references_json`
([001_init.sql](../../src/db/migrations/001_init.sql):113-115) and adds
`inReplyTo` and `references` to the Email create.

**A stray separator stays a stray separator, inside a group as well as
outside one.** `Team: ,alice@example.com;` yields Alice and no rejection,
which the review read as a gap in CS-2.4. It is deliberate, and rejecting it
would be worse: an empty element carries no text and no address, so there is
no fragment to show and nothing was lost, while refusing the entry would
block the send over `a@b, , c@d` — which is what a field looks like the
moment a recipient is deleted from the middle of one. The opposite case *is*
rejected, because there something is at stake: `Team: alice@a bob@b;` has a
missing comma joining two entries the user wrote separately, and accepting
it would change who is addressed without saying so.

**A parser that runs on every keystroke is a performance surface, and the
cost has to be bounded by the input rather than by its shape.** `mailto:` and
`https:` are each a phrase followed by a colon, indistinguishable from the
start of a group, and a pasted list of them has no semicolon for any of them
to end at. Hunting for that terminator per element made the parse quadratic:
8,000 pasted links measured 2.7 seconds, paid again on every subsequent
keystroke. The fix records the first hunt's conclusion on the cursor, which
is sound because an element only ever begins outside a quoted string or a
comment, so the scan that reached the end read the same text in the same
state that every later element would. A textual `lastIndexOf(';')` would have
been simpler and wrong: in `G:"a;b"` the character is present and means
nothing. The linear bound is now a test, because the termination test that
was thought to cover this passed on inputs that never repeated the failing
shape.

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
becomes a snapshot and gives `bcc` a first-class column and API field;
today it survives only opaquely inside `raw_json`, with no typed column
and no way for the store to read it.

#### What the review changed

Nine defects, all verified against the code before being acted on. The
durable lesson is one sentence, and it is the same rule WP1 learned from the
other direction: **because the full sync sweeps whatever an older generation
left behind, every way of misreading "the server has no more cards" is a way
of deleting cards it does have.** A method-level error read as an empty page,
a page short of the server's own clamped limit read as the end of the list,
a card whose address book had not synced read as absent — each of them ended
in a deletion.

The findings and their fixes are recorded where they can be read against the
change itself, in commit `f35aa7d`.

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

**A typed comma commits only at the top level.** Gmail commits on every
comma, which makes `"Smith, Alice"` untypeable — the name is cut in half and
what is left is not an address. The control asks `endsInsideAddress()` about
the text ahead of the caret first, so a separator inside quotes, a comment,
angle brackets or a domain literal is just a character. That predicate
replaced WP2's `lastSeparatorIndex`, which existed to find where the entry
being typed began in a plain text field and has no work left now that
committed recipients are pills.

**Escape is arbitrated above the control, not inside it.**
`useThunderbirdShortcuts` binds keydown on `document` in the *capture*
phase, so it sees Escape before the control does and no amount of
`stopPropagation` in the control can hold it back — the dialog closed and
took the draft with it while a suggestion list was merely open. The
handler therefore asks whether the *focused* element is a
`[role="combobox"][aria-expanded="true"]` inside `.compose-dialog` and stands
down if it is. That reads the state the control already publishes for a
screen reader rather than a second flag kept in parallel with it, and any
later popup in the dialog inherits the behaviour by being accessible.

Focus is load-bearing in that sentence. The first version asked only whether
such a combobox existed anywhere in the dialog, which both reviews found a
way to exploit: a list can be left expanded on a field the user has moved
away from, and then Escape reaches nothing — the handler stands down, and
the control never receives the key because it does not have focus. A message
that cannot be closed by the key that closes messages is worse than either
behaviour it was arbitrating between.

**A list that is no longer wanted must stop being asked for.** The stale
answer both reviews found was one bug with three doors: `closeList()` hid
the list without invalidating the query behind it, so an answer landing
afterwards reopened it — after Escape, after the field was left, and after a
pill was committed. Cancelling the debounce there matters as much as bumping
the token, because picking a suggestion with the mouse deliberately does not
blur the field, so nothing else would cancel it. Invalidating in one place
rather than at each of the four call sites is what makes the guarantee
readable: whatever the reason the list stopped being wanted, no answer to an
older question may bring it back.

**Not every finding was accepted.** Two were answered with an argument
rather than a change:

*Reopening a valid pill gives canonical text, not the original keystrokes.*
Sol read CS-3.16's "reopen as the text it was entered as" literally and
found the implementation deviates. Threading raw source text through the
store to honour that would preserve exactly two things — redundant quoting
and RFC 5322 comments — and lose nothing else, because the parse is
lossless for everything a recipient consists of. Reopening `"Alice"
<a@b.com>` as `Alice <a@b.com>` is the same recipient, re-commits
unchanged, and is what Thunderbird and Gmail also do. The requirement was
the thing that was wrong, so CS-3.16 now says which form each kind reopens
as: exactly-as-entered for an invalid pill, where nothing else is knowable
and the typo is the point, and canonical for a valid one. Sol was
unambiguously right about the test, which handed in an already-parsed
object and asserted the formatter's output — it proved nothing and has been
rewritten to type a real entry.

*Typing a group interactively still breaks at the first comma.* Kimi is
right that `Team: alice@a.com,` commits an invalid pill where a pasted group
flattens correctly, and the obvious fix is to teach `endsInsideAddress`
about an unterminated group. The trade is bad: a colon would then suppress
every comma until a semicolon arrived, so `mailto:alice@x.com,` and any
other stray colon would silently stop committing — a key that does nothing
is harder to understand than a pill that is visibly wrong and reopens for
correction. Groups are also vanishingly rare in a compose field, and Enter,
Tab, blur and paste all handle them correctly today.

### WP7 — iOS overlay

Stacking-context fix for the folders overlay against the compose
dialog.

## Sequencing and rationale

WP1 ships first: WP2 exposes Cc and Bcc fields whose recipients only WP1
makes deliverable, so shipping the fields first would advertise a feature
that silently drops recipients.

**WP3 runs second, before WP2.** WP1 makes an unknown send outcome
*stop* rather than duplicate, which is safe but blunt: a flaky network
now surfaces a failure the user must act on, and there is no positive
reconciliation to resolve it automatically. That interim cost should be
short-lived, so durable phases and Message-ID reconciliation come next,
ahead of the recipient-model work. WP3 depends on WP1's response
validation, since phase transitions are only meaningful once a phase's
success can be determined.

**WP6 runs immediately after WP2, ahead of WP4 and WP5.** WP2 leaves the
recipient rows as plain text fields, which is the control WP6 replaces with
committed pills. Every recipient interaction in the e2e suite is written
against whichever control is there, so any package landing between the two
pays for its recipient assertions twice. WP6 depends on WP2's structured
recipients and on nothing in WP4 or WP5: better suggestion data changes what
the list offers, not how the control commits what is chosen.

WP4 precedes WP5, because ranking and de-duplication over a source that
never forgets deleted contacts would produce confidently wrong results.

WP7 is independent and can land at any point.

## Risks

- **Stalwart behavior on an omitted envelope.** CS-1.1 relies on
  server-side derivation. Verify against the local stack before relying
  on it, and capture the wire exchange in the e2e assertion.
- **Migration ordering.** WP3, WP4, and WP5 all add migrations.
  `runMigrations` skips every version `<=` the stored `user_version`
  ([engine.ts](../../src/db/engine.ts):226-241), so a higher-numbered
  migration landing first makes existing databases skip the lower one
  permanently. Numbers are assigned at landing time, and a test asserts
  the migration list is contiguous and strictly increasing rather than
  relying on discipline.
- **Shared e2e account.** The local stack's `e2e@example.org` is shared
  with other worktrees, so live runs cannot be concurrent.
