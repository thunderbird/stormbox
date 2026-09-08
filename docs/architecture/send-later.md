# Send Later architecture

Send Later is a server-timed delivery feature built on JMAP `EmailSubmission`
with an RFC 4865 `HOLDFOR` envelope parameter, a real top-level `Scheduled`
mailbox, and the existing durable send operation. The server owns the delivery
timer. Stormbox owns crash-safe acceptance, presentation, cancellation, and
post-release filing — all through machinery that already existed for
immediate send.

The product contract is in `../../specs/009-send-later/spec.md`.

## Design shape

There is exactly one create-and-submit state machine: the `SEND` phases in
`src/sync/backends/jmap/outbox/operations/send.ts`. A scheduled request is an
ordinary send request carrying an optional absolute `scheduledAt`; its
presence switches three things inside the shared operation and nothing else:

1. The Email is created in the real `Scheduled` mailbox instead of
   Outbox/Drafts, with `sentAt` set to the target instant (which becomes the
   RFC 5322 `Date` header) and `$seen` instead of `$draft` — Fastmail
   semantics, so external IMAP clients date the message by when it will leave.
2. The `EmailSubmission` envelope gains `mailFrom.parameters.HOLDFOR`,
   computed conservatively from a server-clock window so the message can
   release late by the clock uncertainty but never early. Capability
   (`submissionExtensions.FUTURERELEASE`, `maxDelayedSend`) is validated in
   the worker before the submission phase; failures are terminal and rewind
   the phase-1 Email.
3. `onSuccessUpdateEmail` is omitted: the message stays in Scheduled until
   the server decides release or cancellation.

Message-ID stability, attachment verification, ambiguity handling
(`outcomeUnknown`), and `SUBMITTED`/`CACHE_PENDING` crash recovery are the
shared operation's existing guarantees. The one scheduled-specific recovery
rule: because a scheduled Email sits in the Scheduled mailbox from the moment
it is created, mailbox placement proves nothing about submission — only a
retained `EmailSubmission` record counts as evidence on resume.

## Data model

Scheduled messages are ordinary cached messages: normal `messages` rows,
normal address/part/body storage, bodies loaded on demand. Migration
`016_scheduled_submissions.sql` adds exactly two columns to `messages`:

- `scheduled_submission_remote_id` — the server id of the holding submission;
- `scheduled_undo_status` — the last known status: `pending`, `final`,
  `canceled`, or `unknown`.

`messages.sent_at` already carries the target instant, so no dedicated
schedule table, projection cache, snapshot, or synthetic id space exists.
A partial index over `(account_id, sent_at)` where the status is non-null
serves the active-schedule queries.

## The Scheduled mailbox

The Scheduled mailbox is the account's `scheduled` role Mailbox (RFC 9979
§8.2): a normal, visible, top-level mailbox that the regular Mailbox sync
mirrors into `folders` with `role = 'scheduled'`. Every consumer — filing,
cancellation, the synchronizer, sort selection, folder presentation, and
`src/utils/folder-capabilities.ts` — identifies it by that role, exactly like
Drafts or Sent; there is no cached id, name predicate, or client-side
decoration.

Stalwart does not create the role folder by default, so
`src/sync/backends/jmap/scheduled-mailbox.ts` resolves it on the first
scheduled send. `ensureScheduledMailbox` checks the local role folder, then
`Mailbox/query { role: "scheduled" }` on the server, then adopts a top-level
roleless mailbox named `Scheduled` by patching the role onto it (a same-named
sibling cannot be created), and finally creates `Scheduled` with
`role: "scheduled"`, subscribed. A lost creation race re-runs discovery. A
top-level `Scheduled` carrying a different role fails scheduling tersely
rather than commandeering a user folder. The mailbox is mirrored locally right
away so filing works before the next Mailbox sync; the sync refreshes counts
and subscription afterwards.

As a role folder it is always shown in the sidebar and Manage Folders
regardless of `isSubscribed`, so nothing manages its subscription.

## Submission synchronization

`src/sync/backends/jmap/submissions.ts` is a thin, account-scoped
synchronizer with no state machine: every pass re-reads both sides and
converges.

Reads are the one Stalwart 0.15.4-portable shape — an unfiltered
`EmailSubmission/query` plus explicit `EmailSubmission/get(ids)` with
client-side filtering — because the server's `undoStatus` query filter is
unreliable (removing this path once a fixed server ships is tracked
follow-up). An `undoStatus` outside the RFC 8621 §7 set maps to null and is
treated conservatively.

Each pass:

- transitions tracked rows to what the server shows (`pending` → `final` /
  `canceled`), or to `unknown` when a pending row's target has passed and its
  record is gone (RFC 8621 §7 lets servers reap records; omission is never
  proof of release or cancellation);
- adopts schedules created by other clients — pending, future-dated
  submissions whose Emails it fetches through standard persistence;
- hands settled rows to existing durable operations: `final` enqueues the
  generic `MOVE_TO_FOLDERS` from Scheduled to Sent, external `canceled`
  enqueues `CANCEL_SCHEDULED_SEND` for Drafts restoration. Scheduling columns
  clear only after placement confirms, so a crash repeats an idempotent move
  instead of stranding a released message;
- reports the nearest pending target.

Triggers (in `src/sync/backends/jmap/backend.ts`): `EmailSubmission`
StateChange, connect/reconnect, Scheduled-folder open, and one non-durable
account-level timer armed at the nearest pending `sent_at`. Concurrent
triggers collapse into one running pass plus one queued re-run. No
per-message timers, no durable polling mutations.

## Cancellation

`src/sync/backends/jmap/outbox/operations/cancel-scheduled-send.ts` is a
durable mutation (user actions must survive reload) but deliberately
checkpoint-free: nothing in it is ambiguous the way a send is, so every
attempt re-reads current submission and Email state and converges.

Server writes are one portable two-call sequence:
`EmailSubmission/set { undoStatus: "canceled" }` (RFC 8621 §7.3), then an
idempotent `Email/set` moving Scheduled → Drafts and restoring `$draft`.
Outcome mapping: already-canceled plus Drafts placement is success; `final`
is too late (terminal, eligible for Sent filing by the synchronizer); a
vanished record retries while the target is future and parks as terminal
`unknown` once it has passed — never guessed as sent or canceled. Success is
reported only after server state and the normal message cache agree, and the
scheduling columns clear only then. In a cancel/release race, current server
state decides.

Nothing in synchronization, filing, or cancel ever calls
`EmailSubmission/set` create; retries cannot produce a second delivery.

## UI reuse

The Scheduled folder is rendered by the normal folder tree through the role
maps in `src/utils/folder-presentation.ts`: its own icon, placement between
Drafts and Sent, and the `src/utils/folder-capabilities.ts` protections shared
by every role folder (no rename, delete, reparent, or subscription changes)
plus its own bar on use as a move/copy target. Opening it runs the same
mailbox-window query and `MessageList` as every real folder, with one generic
extension: mailbox-window sorts carry a direction, Scheduled sorts by
ascending `sentAt` (soonest first), and list rows display the active sort's
timestamp instead of unconditionally showing `received_at`.

`MessageView` renders scheduled messages through the normal detail path; the
scheduling columns only add a status banner with the resolved send time and a
`Cancel send` action, swap the toolbar to read-only, and label the date row
`Send at`. Reply/forward/delete keyboard shortcuts are inert for scheduled
rows, and the store independently refuses destroy/move requests that target
them. Canceling deselects the message first so the restored draft does not
auto-open the compose editor mid-cancel.

Compose controls (split button, presets, custom picker with IANA time-zone
search, DST validation, synced `timeZone` setting) live in
`ComposeDialog.vue`, `ScheduleSendDialog.vue`, and `src/utils/schedule-time.ts`;
choosing a preset or custom time only stages an absolute target and changes the
dropdown segment to the preset title or `Custom`. The primary action remains
`Send`, and the user must click it before `scheduleSend` validates capability
and target client-side and delegates to the ordinary `send` action with
`scheduledAt` attached. While a target is staged, the dropdown adds `Send now`;
choosing it clears the target without submitting anything.

## Verification

See the verification map in the spec: unit coverage for the scheduled send
branch, synchronizer, cancel operation, triggers, capability, and DST math;
live Stalwart verticals in `tests/integration/send-later-live.test.ts`
(time surfaces, cancellation, release-to-Sent with delivery, external-client
adoption, role-folder placement); and the browser flow in
`tests/e2e/send-later.spec.js` (Firefox and Chromium).
