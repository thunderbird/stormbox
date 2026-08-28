# Compose Draft Lifecycle

This specification defines Stormbox's compose-session presentation, draft
autosave, close semantics, server revision protocol, Drafts reopening, and
interaction with send. It extends [spec.md](./spec.md); the constitution's
cache-first, server-authoritative, outbox, and verified-consistency rules
remain controlling.

## Status legend

- 🟩 **Done** — implemented and covered by tests.
- 🟨 **Partial** — implemented with a stated gap.
- 🟧 **Planned** — accepted scope, not yet implemented.

## Status overview

| Area | 🟩 Done | 🟨 Partial | 🟧 Planned |
|:--|--:|--:|--:|
| CD-1 Compose sessions and presentation | 8 | — | — |
| CD-2 Seed-relative dirtiness | 6 | — | — |
| CD-3 Autosave scheduling | 8 | — | — |
| CD-4 Durable JMAP revisions | 12 | — | — |
| CD-5 Close, save, and discard | 8 | — | — |
| CD-6 Reopen and send interaction | 9 | 1 | — |
| CD-7 Security and verification | 6 | 1 | — |

## Terminology and model

### Compose session

A **compose session** is one independently editable message keyed by a local
UUID. A session owns its editor, recipients, subject, identity, seed snapshot,
dirty state, autosave scheduler, and draft-revision checkpoints.

A session is either **expanded** or **minimized**. Any number may be minimized,
but at most one may be expanded. Minimized sessions remain mounted so editor
state and undo history survive.

### Seed and dirty state

The **seed** is the canonical semantic compose payload captured after a new,
reply, forward, or reopened-draft session has been initialized. A session is
**dirty** when its current canonical payload differs from the seed representing
its latest confirmed server revision.

Presentation state, focus, selection, editor history, autosave timestamps, and
generated protocol identifiers are not compose content and do not affect
dirtiness.

### Draft revision

A **draft revision** is one immutable JMAP Email carrying `$draft` and belonging
to the Drafts mailbox. RFC 8621 permits only `mailboxIds` and `keywords` to be
updated on an Email; changing recipients, subject, headers, or body therefore
creates a successor Email.

`draftSessionId` is stable and local to Stormbox. `revisionMessageId` is a
globally unique RFC 5322 Message-ID minted for one semantic revision. Retries
and reconciliation of that same revision reuse it; a later changed revision
gets a new one.

## CD-1 — Compose sessions and presentation

| ID / Status | Requirement |
|:--|:--|
| CD-1.1 🟩 Done | Stormbox shall support multiple simultaneous compose sessions, including new messages, replies, forwards, and reopened drafts. |
| CD-1.2 🟩 Done | At most one session shall be expanded. Starting a compose gesture while another session is expanded shall minimize the existing session and open the new session expanded. |
| CD-1.3 🟩 Done | A minimize control shall collapse an expanded composer into a docked bar at the bottom right without closing the session or changing its content. |
| CD-1.4 🟩 Done | Every minimized session shall have its own docked bar. Restoring one shall minimize the currently expanded session before expanding the selected session. |
| CD-1.5 🟩 Done | Minimized editors shall remain mounted so Squire state, selection-independent undo history, recipients, inline media, and unsaved edits survive minimize and restore. |
| CD-1.6 🟩 Done | A docked bar shall identify the session by subject, falling back to its first recipient and then “New message”. It shall expose Restore and Close with accessible names. |
| CD-1.7 🟩 Done | Minimize, restore, close, and discard shall be unavailable while the session is sending. A sending session shall remain expanded. |
| CD-1.8 🟩 Done | Global mail shortcuts shall be suppressed only while an expanded composer owns the interaction. A minimized session shall not prevent normal mail-list shortcuts. |

## CD-2 — Seed-relative dirtiness

| ID / Status | Requirement |
|:--|:--|
| CD-2.1 🟩 Done | Dirtiness shall be computed from a canonical semantic payload containing From identity, ordered To/Cc/Bcc entries including invalid raw fragments, subject, editable HTML/body meaning, reply threading fields, and inline-media or attachment references. |
| CD-2.2 🟩 Done | Opening a new, reply, forward, or server-draft session shall capture its seed only after all initial fields and editor content have been populated. Initial prefilling shall not make the session dirty. |
| CD-2.3 🟩 Done | A successful draft revision shall replace the seed with the exact semantic payload captured by that save. Per CD-3.8, invalid recipient fragments are acknowledged as local-only state in that seed even though they cannot be represented in JMAP; this prevents an unchanged invalid pill from causing repeated no-op revisions. Edits made while that save is in flight shall remain dirty against the newly confirmed seed. |
| CD-2.4 🟩 Done | Reverting every semantic field to the latest seed shall clear dirty state and cancel any save that has not begun. |
| CD-2.5 🟩 Done | A new compose session shall be considered meaningfully non-empty only when it has a recipient or invalid recipient fragment, non-whitespace subject, semantic body content, or inline media/attachment. A default From identity alone shall not count. |
| CD-2.6 🟩 Done | Empty new sessions shall never create server drafts. A reopened server draft remains a real saved draft even when its current semantic content is empty. |

## CD-3 — Autosave scheduling

| ID / Status | Requirement |
|:--|:--|
| CD-3.1 🟩 Done | Autosave shall begin only after a session is both dirty and meaningfully non-empty. |
| CD-3.2 🟩 Done | A dirty session shall save after two seconds without a semantic edit, with a thirty-second ceiling during continuous editing. |
| CD-3.3 🟩 Done | Each session shall permit at most one draft save in flight. Edits during an in-flight save shall coalesce into exactly one follow-up save of the latest semantic payload. |
| CD-3.4 🟩 Done | Minimized sessions shall continue autosaving. Switching the expanded session shall not reset another session's debounce or typing ceiling. |
| CD-3.5 🟩 Done | Autosave shall pause before send or discard enters the session's mutation lane and shall not enqueue a save after either operation has begun. |
| CD-3.6 🟩 Done | An autosave failure shall leave the editor open and dirty, preserve every confirmed server revision, and expose a non-blocking failure state. One save action shall make no more than three automatic attempts, and an HTTP authentication rejection shall stop after its first attempt rather than enter backoff. An explicit retry shall use the durable revision state machine rather than enqueue a duplicate semantic revision. |
| CD-3.7 🟩 Done | Closing the final application tab is not required to flush a debounce synchronously. Recovery covers revisions durably enqueued before shutdown, not edits that never reached a checkpoint. |
| CD-3.8 🟩 Done | An invalid recipient pill shall not block autosave or explicit Save Draft. The JMAP draft revision shall omit only invalid fragments and shall preserve every persistable field, including valid recipients, subject, body, threading, inline media, and attachments. The invalid pill shall remain visible in the current compose session but is local-only and therefore shall not reappear when the server draft is reopened. After a save observes an invalid pill, the UI shall show “Fix invalid recipients before saving or sending this message.” as non-blocking validation feedback; draft saving still succeeds, but sending remains blocked until every invalid pill is fixed or removed. |

## CD-4 — Durable JMAP revisions

| ID / Status | Requirement |
|:--|:--|
| CD-4.1 🟩 Done | Draft saves and discards shall enter `pending_mutations`; Vue components and stores shall not call JMAP directly. Saves, discard, and send for one compose session shall share one serialized runner lane. |
| CD-4.2 🟩 Done | Before issuing a create, Stormbox shall durably store the semantic payload and checkpoint `operationId`, `draftSessionId`, monotonic revision, `revisionMessageId`, payload hash, predecessor Email ids, and phase. |
| CD-4.3 🟩 Done | A changed revision shall be created by an `Email/set` containing `create` only, with `$draft`, the Drafts mailbox, and the revision Message-ID. No replacement request shall contain both successor creation and predecessor destruction. |
| CD-4.4 🟩 Done | Stormbox shall require an `Email/set` response with the expected method call id and `created[creationId].id` before treating the successor as confirmed. Per-object `notCreated`, method errors, malformed responses, and transport ambiguity shall not authorize predecessor cleanup. |
| CD-4.5 🟩 Done | After confirmation, Stormbox shall fetch the successor, reconcile its local row, mailbox views, counters, body parts, and attachment/inline-image blob handles, and durably checkpoint the new Email id before cleanup. |
| CD-4.6 🟩 Done | Only after CD-4.5 succeeds shall Stormbox issue a separate `Email/set` destroy for exact predecessor ids recorded by that session. Cleanup shall never select an Email merely because it is the newest match or shares a session/message identifier. |
| CD-4.7 🟩 Done | Destroy retries are idempotent. A confirmed destroy and `notFound` both complete cleanup; `serverPartialFail` requires authoritative resynchronization before the cache is resolved. |
| CD-4.8 🟩 Done | A lost create response shall be reconciled by searching Drafts for the exact revision Message-ID and verifying semantic content. Because Stalwart does not implement the RFC header filter, Stormbox shall fall back to a complete, paginated Drafts scan with stable query state. |
| CD-4.9 🟩 Done | An incomplete or unstable reconciliation scan is ambiguous and shall not authorize a repeat create or cleanup. After a complete stabilized scan proves no match, the same revision may be retried; duplicate exact matches are reconciled conservatively while the predecessor remains protected. |
| CD-4.10 🟩 Done | A fresh Message-ID shall be generated for each changed revision and reused only for retries of that revision. Correctness shall not depend on a stable custom wire header, stable Message-ID across revisions, or a server's create/destroy processing order. |
| CD-4.11 🟩 Done | Concurrent tabs or external clients may create legitimate successors to the same base. Stormbox shall preserve an unowned successor and surface a conflict rather than infer ownership and delete it. |
| CD-4.12 🟩 Done | Draft revision cleanup shall prefer a recoverable duplicate over a zero-copy state. A confirmed predecessor shall survive every create rejection, ambiguous create, cache failure, and attachment reconciliation failure. |

### Durable revision phases

| Phase | Durable meaning | Permitted next action |
|:--|:--|:--|
| `queued` | Create may be issued; no successor id is confirmed. | Reconcile the revision Message-ID, then create only after conclusive absence. |
| `created` | Successor id is confirmed; predecessor still exists. | Fetch and reconcile successor content and blob handles. |
| `cache_pending` | Successor is durable locally and remotely. | Destroy exact checkpointed predecessors. |
| `cleanup_pending` | Cleanup may have been issued. | Reconcile or retry destroy only. |
| `complete` | Successor is the confirmed seed and cleanup is settled. | Delete the mutation row. |
| `conflict` | Ownership or outcome cannot be established safely. | Preserve all server copies and require explicit resolution. |

An unknown phase or unreadable checkpoint is a conflict. It shall never be
treated as an earlier phase that permits another create or deletion.

## CD-5 — Close, save, and discard

| ID / Status | Requirement |
|:--|:--|
| CD-5.1 🟩 Done | The header **X** shall close a meaningfully empty message directly. For a meaningfully non-empty session it shall open a menu containing **Discard** and **Save Draft**. Escape on a dirty session shall open a themed confirmation with **Save draft**, **Don't Save**, and **Cancel**; Escape owned by an active input-method composition shall not close or prompt. |
| CD-5.2 🟩 Done | Save draft shall synchronously request the latest semantic revision, wait until it is confirmed and locally reconciled, and then close the compose session. Failure shall keep the session open. |
| CD-5.3 🟩 Done | Don't Save shall abandon only edits newer than the last confirmed seed and close the session. It shall leave the last confirmed server draft untouched. If no revision exists, it creates nothing. |
| CD-5.4 🟩 Done | Cancel shall close only the confirmation and return focus to the composer. |
| CD-5.5 🟩 Done | Closing a clean session through a non-destructive close path shall not prompt. It shall leave a confirmed server draft in Drafts and create nothing for an empty unsaved session. |
| CD-5.6 🟩 Done | The header-menu **Discard** action means permanent destruction of this session's confirmed, checkpoint-owned draft revisions plus abandonment of local edits. It is distinct from Don't Save. |
| CD-5.7 🟩 Done | Discard shall close only after server destruction and cache reconciliation are confirmed. A failure shall keep the session recoverable and report the failure. |
| CD-5.8 🟩 Done | The header-menu **Save Draft** control shall save the latest content and close the composer, using the same operation as Save draft in the close confirmation. The compose footer shall contain only **Send**. |

## CD-6 — Reopen and send interaction

| ID / Status | Requirement |
|:--|:--|
| CD-6.1 🟨 Partial | Selecting an Email carrying `$draft` from the Drafts mailbox opens it in a compose session rather than the message reader, and selecting an already-open draft restores its existing session. A draft with multiple sequential text or HTML body parts is refused with a notice because the current single-body composer cannot reproduce that MIME shape losslessly. |
| CD-6.2 🟩 Done | Reopen shall seed From, ordered To/Cc/Bcc, subject, reply headers, body, and inline parts before dirty tracking begins. The confirmed server Email id becomes the session's initial revision. |
| CD-6.3 🟩 Done | Reopened HTML shall be parsed into an edit-safe Squire representation. Raw server HTML and display-sanitized viewer HTML shall not be assigned directly to the editor. |
| CD-6.4 🟩 Done | `$draft` Emails claimed by a live, unknown, or conflicted send checkpoint shall not be adopted for editing, because they may be the unsent or partially filed Email of that send operation. |
| CD-6.5 🟩 Done | Send shall stop the session's autosave scheduler, await its in-flight save, and enter the same serialized mutation lane before creating or submitting mail. |
| CD-6.6 🟩 Done | The final outgoing Email shall be a fresh Email with its own send-operation Message-ID and the existing durable send checkpoints. Stormbox shall not submit an autosaved revision as the final outgoing Email. |
| CD-6.7 🟩 Done | Only after submission is confirmed may send destroy the current and superseded draft Email ids explicitly owned by that session. Cleanup failure shall enter repair without retrying submission or changing a confirmed send to failure. |
| CD-6.8 🟩 Done | A rejected or ambiguous send shall retain the latest confirmed draft according to CS-1.5 through CS-1.10. Draft cleanup shall never be used as evidence that delivery was cancelled. |
| CD-6.9 🟩 Done | Local Drafts and Sent query views and Mailbox counters shall reflect each confirmed server fact before its mutation resolves, including successor creation, predecessor cleanup, discard, and post-send cleanup. |
| CD-6.10 🟩 Done | Inline-image and attachment construction shall be shared by draft creation and send. A revision shall not destroy the Email that owns a part blob until the successor's corresponding blob handles have been confirmed. |

## CD-7 — Security and verification

| ID / Status | Requirement |
|:--|:--|
| CD-7.1 🟩 Done | Unit tests shall cover the one-expanded invariant, minimize/restore, mounted editor preservation, seed-relative dirtiness, meaningful emptiness, debounce and typing ceiling, one in-flight save, and one coalesced follow-up. |
| CD-7.2 🟩 Done | Protocol tests shall prove create rejection preserves the predecessor, no replacement call combines create and destroy, lost create responses reconcile without blind replay, destroy retries are idempotent, and incomplete reconciliation blocks cleanup. |
| CD-7.3 🟩 Done | Protocol tests shall prove every changed revision receives a fresh Message-ID, retries retain it, and cleanup contains only exact checkpoint-owned Email ids. |
| CD-7.4 🟩 Done | The Bulwark attachment lifecycle case shall be covered: reopen a draft whose body uses Email-part blob ids, save it twice, and prove the second successor is valid after predecessor cleanup. |
| CD-7.5 🟩 Done | Playwright tests on Chromium and Firefox shall assert the visible UI, including direct close for an empty message and the non-empty header action menu, browser-local SQLite state through `window.__repo`, and direct JMAP state for autosave, minimize/restore, Save draft, Don't Save, Discard, reopen, and send cleanup. |
| CD-7.6 🟨 Partial | Live Stalwart tests exercise create rejection, lost create response, lost cleanup response with idempotent retry, and attachment replacement without relying on Cyrus ordering. Complete paginated reconciliation is covered with a server-faithful unit transport rather than by filling the live account with more than one server page of drafts. |
| CD-7.7 🟩 Done | Tests shall seed unique subjects and clean server artifacts in `finally`, and shall never use self-delivery as proof of submission. |

## Protocol decision and prior art

RFC 8621 §4.10 demonstrates replacing a draft with one `Email/set` containing
both `create` and `destroy`. RFC 8620 §5.3 nevertheless makes each object
operation independently atomic, permits partial success, and requires the
server to continue after `notCreated`. The example therefore describes only the
success path; it does not provide an all-or-nothing replacement guarantee.

Bulwark issue 849 reproduced the resulting zero-draft state when successor
creation failed on stale part blobs while predecessor destruction succeeded.
Current Bulwark, TMail, Sterna, Ltt.rs, Mailove, CEFIRO, and JMAPJolt all gate
cleanup on acknowledged successor creation. Sterna additionally keeps a
device-local copy and verifies content fidelity; Mailove uses
`Email/import`'s `alreadyExists(existingId)` where available.

Stormbox uses separate create/reconcile/destroy requests because it already
has a durable outbox and JMAP Email construction. The following alternatives
are rejected:

- updating immutable Email content in place;
- one `Email/set` containing both create and destroy;
- unconditional create and destroy method calls in one JMAP request;
- a same-request `Core/echo` ResultReference gate, which current Stalwart does
  not implement for `Core/echo`;
- `ifInState`, whose account-wide state changes for unrelated mail and which
  does not make one object operation conditional on another;
- a stable Message-ID across changed revisions;
- correctness based on a custom header that another client may drop or send;
- `Email/import` plus a new raw-MIME builder solely for this prototype; and
- submitting an autosaved draft as the final outgoing Email.

## Non-goals

- Restoring edits that were never durably enqueued before every tab or worker
  closed.
- Hiding or automatically resolving legitimate concurrent successors created
  by another tab or client.
- General offline compose-session synchronization across devices.
- Undo Send, scheduled send, or a user-visible Outbox.
- File-attachment picking; this work preserves and reconciles attachment and
  inline-part data already present in a reopened or pasted-image draft.
