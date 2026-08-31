# Send Later — Product and Engineering Specification

This specification defines Stormbox's server-backed Send Later behavior. It
refines the compose, folder, attachment, and settings requirements in
`specs/001-mvp-scope/spec.md`, `specs/003-folder-management/spec.md`,
`specs/004-compose-improvements/spec.md`, `specs/007-user-settings/spec.md`,
and `specs/010-attachments/spec.md`.

The architectural invariants in `.specify/memory/constitution.md` remain
controlling: the server is authoritative, protocol mutations enter the
durable outbox, and user-visible success follows a durable local checkpoint.

## Terminology

- A **scheduled Email** is the ordinary JMAP `Email` held before release.
- A **scheduled submission** is the corresponding JMAP `EmailSubmission`
  created with an RFC 4865 `HOLDFOR` envelope parameter.
- The **Scheduled mailbox** is a real, top-level, roleless JMAP Mailbox named
  `Scheduled`, exactly as conventional IMAP clients see it.
- The **target instant** is the absolute UTC instant derived from a wall time
  and IANA time zone.

## 1. Capability and compose controls

- **SL-1.1 — Capability gate.** Stormbox shall enable scheduling only when the
  active Mail account advertises the JMAP Submission capability with
  `submissionExtensions.FUTURERELEASE` and a positive safe-integer
  `maxDelayedSend`. A missing, malformed, zero, or account-stale capability
  shall disable scheduling.
- **SL-1.2 — Immediate Send remains available.** An unsupported or
  still-loading scheduling capability shall disable only the schedule segment.
  The ordinary Send action shall remain available and shall keep its normal
  immediate-send behavior.
- **SL-1.3 — Split-control order.** The expanded composer shall place the
  schedule dropdown segment immediately to the right of the primary Send
  button. The left segment shall remain labeled `Send`. The right segment
  shall have the accessible label and tooltip `Schedule send` before a
  selection, then expand to show the selected preset title or `Custom`.
- **SL-1.4 — Exact menu.** When scheduling is supported, the right segment
  shall open a menu containing these options in order: `Later today`, `This
  evening`, `Tomorrow`, `This weekend`, `Next week`, a separator, and `Choose
  a date and time`. Once a schedule is staged, `Send now` and a separator
  shall appear before those options so the user can clear it.
- **SL-1.5 — Resolved presets.** Each preset shall show its resolved local
  date/time in the active scheduling time zone. A preset outside the server's
  remaining range shall stay visible but disabled with an explanation.
- **SL-1.6 — Fresh acceptance check.** Opening the menu and committing a
  schedule shall refresh the live capability. A capability lost while the
  composer is open shall prevent scheduling without affecting immediate Send.
- **SL-1.7 — Explicit confirmation.** Selecting a preset or choosing `Set send
  time` in the custom dialog shall only stage that target and show its title
  in the dropdown segment; it shall not enqueue or submit anything. The
  primary button shall remain `Send`, and the user shall press it to commit
  the selected schedule. While a target is staged, choosing `Send now` shall
  clear it without sending.

## 2. Time zone, wall time, and range

- **SL-2.1 — Time-zone default.** The `timeZone` setting shall default to the
  browser's valid IANA time zone, falling back to `UTC` when detection does not
  produce a usable IANA identifier.
- **SL-2.2 — Synced selection.** Presets and the custom dialog shall use the
  same `timeZone` setting. Choosing another zone in the custom dialog shall
  persist it through the settings store and FileNode synchronization when that
  account supports FileNode; without FileNode it shall remain device-local.
- **SL-2.3 — Change propagation.** A time-zone change shall immediately
  re-resolve the current custom wall time and shall affect subsequently opened
  preset menus and custom dialogs. It shall not change an already accepted
  target instant.
- **SL-2.4 — DST gap.** A local wall time that does not exist because of a
  daylight-saving transition shall be rejected with an actionable validation
  message and shall not enqueue a mutation.
- **SL-2.5 — DST overlap.** When a wall time occurs twice, Stormbox shall use
  the earlier instant and shall disclose the ambiguity in the custom dialog.
- **SL-2.6 — Absolute target.** The durable mutation shall carry an absolute
  timestamp with `Z` or an explicit numeric offset. Backend validation shall
  reject malformed or already-expired targets.
- **SL-2.7 — Maximum range.** The target shall not exceed
  `maxDelayedSend` relative to the conservative server-clock window. The UI
  shall bound its picker and the backend shall independently enforce the same
  limit before submission.
- **SL-2.8 — Conservative delay.** The backend shall round `HOLDFOR` upward
  from the lower server-clock bound so Date-header precision and request
  latency cannot release a message early.

## 3. One durable send operation

- **SL-3.1 — Shared mutation.** Scheduling shall enqueue the existing durable
  `send` mutation with one additional field: the absolute `scheduledAt` target
  instant. There shall be no separate scheduling mutation type, checkpoint
  schema, or phase enum; the shared operation's `QUEUED`/`CREATED`/
  `SUBMITTING`/`SUBMITTED`/`CACHE_PENDING` phases and stable operation
  Message-ID govern scheduled and immediate sends identically.
- **SL-3.2 — Scheduled Email placement.** A scheduled request shall create its
  Email directly in the Scheduled mailbox (resolving or creating that mailbox
  first), not in Outbox or Drafts.
- **SL-3.3 — Fastmail time surfaces.** The created Email's JMAP `sentAt` —
  and therefore its RFC 5322 `Date` header — shall carry the target instant,
  and the Email shall be created `$seen` and not `$draft`, so external clients
  date the message by when it will leave and do not count it as unread. No
  proprietary scheduling header shall be added; pending/final/canceled state
  belongs to `EmailSubmission` alone.
- **SL-3.4 — Held submission.** The scheduled submission shall use the
  selected Identity, the de-duplicated To/Cc/Bcc envelope from the immediate
  send contract, and `mailFrom.parameters.HOLDFOR` computed per SL-2.8. It
  shall omit `onSuccessUpdateEmail`; the message stays in the Scheduled
  mailbox until the server decides release or cancellation.
- **SL-3.5 — Acceptance evidence.** Stormbox shall report the compose action
  as scheduled only after either (a) `EmailSubmission/set` returns a created
  submission id or (b) a lost response is resolved by a retained matching
  submission record. Because a scheduled Email sits in the Scheduled mailbox
  from creation, mailbox placement shall never count as submission evidence
  for a scheduled request.
- **SL-3.6 — Unknown outcome.** When a submission response is lost and no
  positive evidence remains, the row shall park as terminal `outcomeUnknown`.
  Stormbox shall not create or submit another Email automatically.
- **SL-3.7 — Normal persistence.** An accepted scheduled message shall be
  cached through the ordinary message/body persistence path as a normal
  `messages` row in the Scheduled folder, with exactly two scheduling columns:
  the remote submission id and the last known undo status. `messages.sent_at`
  already carries the target instant; no dedicated schedule table, snapshot,
  or second body cache shall exist.
- **SL-3.8 — Draft replacement.** After acceptance, confirmed predecessor
  draft Emails shall be cleaned up by the existing verified draft-cleanup
  path. Draft cleanup failure shall not undo or repeat the accepted scheduled
  submission.

## 4. Scheduled mailbox and submission synchronization

- **SL-4.1 — Real mailbox shape.** Stormbox shall discover or create exactly
  one top-level, roleless Mailbox named `Scheduled`. A top-level mailbox
  carrying that name with a conflicting shape shall fail scheduling tersely
  rather than be adopted or duplicated.
- **SL-4.2 — Canonical id.** The mailbox's remote id shall be cached in the
  account's synced `scheduledMailboxRemoteId` setting; after discovery the
  cached id is canonical and every consumer shall compare against it through
  one shared predicate. Name matching is bootstrap and recovery only, and a
  stale cached id shall be re-verified against the server before reuse.
- **SL-4.3 — Permanent subscription.** Stormbox shall create the mailbox
  subscribed and keep its `isSubscribed` flag true after discovery. The
  idempotent reconciler shall repair an unsubscribed cached mailbox and rewrite
  any queued opposite subscription mutation so an old retry cannot hide it.
  Reconciliation failure shall never fail the send or cancel that triggered
  it.
- **SL-4.4 — Stalwart-compatible reads.** All submission reads shall use one
  unfiltered `EmailSubmission/query` plus explicit `EmailSubmission/get(ids)`
  with client-side filtering, never Stalwart's unreliable `undoStatus` query
  filter, and shall not branch by server version. An `undoStatus` outside
  `pending`/`final`/`canceled` shall be treated as unreadable rather than
  interpreted.
- **SL-4.5 — Thin synchronizer.** One account-scoped synchronizer shall
  reconcile the scheduling columns against the server's submissions: tracked
  rows may transition to `final`, `canceled`, or `unknown`; untracked pending
  future-dated submissions created by other clients shall be adopted by
  fetching their Emails through standard persistence. It shall hold no state
  machine and re-derive every decision each pass.
- **SL-4.6 — Sync triggers.** The synchronizer shall run on `EmailSubmission`
  StateChange, connect/reconnect, Scheduled-folder open, and one non-durable
  account-level wake-up armed at the nearest pending `sent_at`. There shall be
  no per-message timers and no durable polling mutations.
- **SL-4.7 — Missing records.** A submission the server no longer shows is
  conclusive for nothing: a pending row whose target has passed becomes
  `unknown` (RFC 8621 §7 allows reaping) and is never guessed as sent or
  canceled; a pending row with a future target keeps waiting.

## 5. Scheduled folder presentation

- **SL-5.1 — Permanent visibility.** Once discovered or created, the Scheduled
  folder shall remain in the folder pane while empty as well as while
  schedules are active. Stormbox shall not hide it after cancellation or
  release of the last schedule.
- **SL-5.2 — Placement.** The folder shall render as a special folder between
  Drafts and Sent, with its own icon, and shall not be renameable, deletable,
  reparentable, or usable as an ordinary move/copy target.
- **SL-5.3 — Normal list machinery.** Opening Scheduled shall use the same
  mailbox-window query, `messages` rows, and message-list component as every
  other real folder. There shall be no synthetic folder ids, synthetic message
  ids, or dedicated scheduled list component.
- **SL-5.4 — Soonest-first order.** The Scheduled view shall sort by ascending
  `sentAt` (soonest departure first), and list rows shall display the active
  sort timestamp rather than unconditionally showing `received_at`.
- **SL-5.5 — Read-only detail.** Opening a scheduled message shall render
  through the normal detail view with a scheduled banner showing the resolved
  send time and a `Cancel send` action. Reply, Reply All, Forward, archive,
  junk, delete, and draft-edit actions shall not be offered, and their
  keyboard shortcuts shall be inert; the metadata row shall label the target
  instant `Send at`.
- **SL-5.6 — Bulk-action gating.** Bulk archive, junk, delete, and move
  affordances shall be unavailable for the Scheduled folder, and the store
  shall independently refuse destroy/move requests that target scheduled
  messages.

## 6. Cancellation, release, and reconciliation

- **SL-6.1 — Durable cancel.** `Cancel send` shall enqueue one durable
  `cancelScheduledSend` mutation targeting the real `messages.id`. The
  operation shall be checkpoint-free: every attempt re-reads current
  submission and Email state and converges.
- **SL-6.2 — Portable two-call sequence.** For a pending submission the cancel
  shall always issue `EmailSubmission/set { undoStatus: "canceled" }` followed
  by an idempotent `Email/set` moving Scheduled → Drafts and restoring
  `$draft`, with no `onSuccessUpdateEmail` capability branch.
- **SL-6.3 — Convergent outcomes.** Already-canceled plus Drafts placement is
  success; `final` is too late and eligible for Sent filing; a vanished record
  is retryable while the target is future and terminal-`unknown` once it has
  passed. Cancellation shall be reported successful only after server state
  and the normal cache agree, and the scheduling columns shall clear only
  then.
- **SL-6.4 — Release filing.** When a submission turns `final`, the
  synchronizer shall enqueue the existing generic move operation to file the
  cached Email from Scheduled to Sent, clearing the scheduling columns only
  after placement confirms. A crash between the two repeats the idempotent
  move.
- **SL-6.5 — External cancellation.** A submission another client canceled
  shall hand the row to the same durable cancel operation for Drafts
  restoration.
- **SL-6.6 — Exactly-once boundary.** Synchronization, filing, and cancel
  shall never call `EmailSubmission/set` create. Retrying any of them shall
  not create another delivery.
- **SL-6.7 — Race outcome.** In a cancel/release race, current server state
  decides the result. Stormbox shall resolve to Drafts only with cancellation
  evidence and to Sent only with release evidence; it shall not report a
  successful cancellation after release has become final.

## 7. Attachments and inline images

- **SL-7.1 — Shared compose preparation.** Scheduled send shall use the same
  upload validation and MIME construction as immediate send, including regular
  attachment blob handles, body alternatives, inline-image CID parts, and the
  explicit recipient envelope.
- **SL-7.2 — Source verification.** Reused attachment blobs shall be verified
  against the confirmed predecessor draft before Email creation. A definitive
  `blobNotFound` shall keep the composer available and identify attachments
  that need re-selection; a transport failure shall remain retryable.
- **SL-7.3 — Normal body storage.** Scheduled message bodies and attachment
  metadata shall live in the ordinary message part/body cache and load on
  demand; no scheduled-specific body snapshot shall exist.

## 8. Accessibility

- **SL-8.1 — Split-control semantics.** The schedule trigger shall expose
  `aria-haspopup="menu"`, an availability description, busy/disabled state,
  and keyboard focus only while actionable. Menu choices shall be real
  `menuitem` buttons with disabled state conveyed to assistive technology.
- **SL-8.2 — Custom-dialog semantics.** The custom picker shall be an
  `aria-modal` labeled dialog, announce resolved or invalid time state, trap
  Tab focus, close on Escape when not busy, and expose searchable IANA zones
  with combobox/listbox semantics.
- **SL-8.3 — Scheduled banner semantics.** The scheduled banner shall be a
  `status` region, and `Cancel send` shall expose disabled/busy state while
  its durable mutation runs.

## Reference-server behavior and standards assumptions

Stormbox's first target is pinned Stalwart **0.15.4**. The implementation uses
JMAP Core and Mail from RFC 8620/RFC 8621 and JMAP Submission's advertised
SMTP-extension model. Scheduling assumes the account advertises
`submissionExtensions.FUTURERELEASE` plus `maxDelayedSend`, and Stalwart maps
the submission envelope's `mailFrom.parameters.HOLDFOR` seconds to delayed
release.

Stalwart 0.15.4 has three observed behaviors that shape the client without
weakening its correctness contract:

1. `EmailSubmission/query` filtering by `undoStatus` is not reliable, so
   Stormbox queries the complete id set and filters validated objects locally
   (SL-4.4). Removing this compatibility path once a fixed server is deployed
   is tracked as follow-up work.
2. A scheduled submission may disappear before synchronization needs it, so
   submission omission is never treated as proof of cancellation or release
   (SL-4.7).
3. The delayed SMTP release does not itself move the Email between mailboxes.
   Stormbox holds the Email in the visible Scheduled mailbox and performs
   idempotent Drafts or Sent filing after the server has decided cancellation
   or release (SL-6.2, SL-6.4).

The workaround must not become a client-side scheduler: the server owns the
delayed delivery timer, and Stormbox never waits in an open tab to submit
later.

## Verification map

- Unit: `tests/unit/sync/jmap-send-scheduled.test.ts` (scheduled branch of the
  shared send), `jmap-submissions.test.ts` (synchronizer + subscription
  reconciler), `jmap-cancel-scheduled-send.test.ts` (durable cancel),
  `jmap-backend-submissions.test.ts` (sync triggers and wake-up),
  `jmap-schedule-capability.test.ts`, `jmap-schedule-time.test.ts`, and
  `tests/unit/utils/schedule-time.test.ts` (DST/timezone), plus compose-store,
  settings-store, ScheduleSendDialog, and ComposeDialog tests.
- Live Stalwart: `tests/integration/send-later-live.test.ts` covers the target
  instant on `Email.sentAt`, the raw MIME `Date` header, and
  `EmailSubmission.sendAt`; permanent subscription; pre-release cancellation
  to Drafts with no delivery; short-delay release through delivery, Sent
  filing, and cleared tracking (with an attachment); and fresh-client adoption
  of an externally created schedule.
- Browser: `tests/e2e/send-later.spec.js` covers split-control geometry,
  staged preset/custom selection with explicit Send-later confirmation,
  permanent real-folder placement below Drafts, soonest-first ordering, normal
  list/detail rendering with the scheduled banner, inert reply/delete
  shortcuts, cancellation back to Drafts, and empty-folder persistence, in
  Firefox and Chromium.
