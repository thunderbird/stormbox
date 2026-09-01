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

`src/sync/backends/jmap/scheduled-mailbox.ts` manages a normal, visible,
top-level, roleless mailbox named `Scheduled` — the same folder Fastmail
exposes. Discovery order: the remote id cached in the synced settings document
(`scheduledMailboxRemoteId`), verified against the server before reuse; then a
name match on the exact top-level shape; then creation. The cached id is
canonical once discovered, and `isScheduledMailbox` in
`src/constants/scheduled-mailbox.ts` is the one predicate every consumer
(folder presentation, capabilities, sort selection, view gating) compares
through. A top-level `Scheduled` with a conflicting shape fails scheduling
tersely rather than commandeering a user folder.

The mailbox is created subscribed and stays visible when empty.
`reconcileScheduledSubscription` idempotently repairs an unsubscribed cached
mailbox and rewrites queued opposite subscription writes before they can hide
it. It reuses the durable `SET_MAILBOX_SUBSCRIPTION` mutation when a server
write is needed. The reconciler is best-effort by design — it only controls
visibility, and every caller sits past a point of no return where a cosmetic
failure must not fail the row.

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
- keeps the mailbox subscribed and reports the nearest pending target.

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

The Scheduled folder is rendered by the normal folder tree, decorated through
the shared predicate: its own icon, placement between Drafts and Sent, and
`src/utils/folder-capabilities.ts` restrictions (no rename, delete, reparent,
child creation, or use as a move/copy target). Opening it runs the same
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
adoption, permanent subscription); and the browser flow in
`tests/e2e/send-later.spec.js` (Firefox and Chromium).
