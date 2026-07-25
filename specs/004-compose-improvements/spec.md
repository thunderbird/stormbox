# Compose Improvements — Sending and Recipient Autocomplete

This specification defines Stormbox's outgoing-mail correctness model
(submission envelope, response validation, durable send phases, reply
audience and threading) and its recipient autocomplete model (candidate
sources, matching, ranking, and the recipient input control).

It refines the compose requirements in `specs/001-mvp-scope/spec.md`,
especially R-4.4 through R-4.7, and the contacts requirements R-5.1,
R-5.3, and R-5.6. The architectural invariants in
`.specify/memory/constitution.md` remain controlling: the UI is
cache-first, the server is authoritative, protocol mutations use the
outbox, and successful mutations update the local cache before their RPC
resolves.

**Implementation scope**: Vue 3 + Pinia, browser-local SQLite, JMAP Mail
plus JMAP Submission and JMAP Contacts against Stalwart.

## Status legend

- 🟩 **Done** — implemented and covered by tests.
- 🟨 **Partial** — implemented with known gaps, listed inline.
- 🟧 **Planned** — accepted scope, not yet implemented.

## Status overview

| # | Area | 🟩 Done | 🟨 Partial | 🟧 Planned |
|---|---|--:|--:|--:|
| 1 | Submission correctness and durability | — | — | 13 |
| 2 | Recipients, reply audience, and threading | — | — | 8 |
| 3 | Recipient autocomplete | — | — | 14 |
| 4 | Contact and identity source integrity | — | — | 7 |
| 5 | Verification | — | — | 4 |

## Terminology and model

### Submission versus delivery

A JMAP `EmailSubmission` records an attempt to send an existing `Email`
through an `Identity`. A created submission means the server **accepted
the message for submission**. It does not mean the message reached any
recipient: RFC 8621 §7 allows `deliveryStatus` to be absent or unknown
indefinitely, and permits a server to destroy successful submission
records immediately.

Stormbox therefore treats "Sent" as *accepted for submission*, and
treats the absence of an `EmailSubmission` object as **no evidence
either way** rather than as proof that nothing was sent.

### Send phases

A send is not one atomic protocol act. It has four distinct outcomes
that must be distinguished, because they carry different recovery rules:

1. **Created** — an `Email` exists on the server.
2. **Submitted** — an `EmailSubmission` for that Email was accepted.
3. **Filed** — the Email carries the Sent mailbox and lost `$draft`.
4. **Reconciled** — the local cache matches the server.

Only phases 1 and 2 are irreversible from the client's perspective.
Phases 3 and 4 are repairable, and repairing them must never re-run
phase 1 or 2.

### Ambiguous outcome

An outcome is **ambiguous** when a phase's response was lost and the
server state cannot distinguish "it happened" from "it did not". A
lost submission response is the canonical case. Stormbox resolves
ambiguity by positive evidence where evidence exists, and otherwise
stops. It never resolves ambiguity by retrying an irreversible act.

### Recipient candidate

A **candidate** is one suggestible `(email, display name, source,
score)` tuple. Candidates come from two pools: synced JMAP contacts
(authoritative metadata) and **recipient history** (addresses the user
has actually sent to). One address yields at most one candidate,
regardless of how many pools or contact cards contain it.

### Owned address

An **owned address** is any address belonging to the signed-in user:
the account's primary email plus the email of every synced `Identity`.
Reply audience computation and autocomplete suppression both operate on
the full owned-address set, not on the currently selected From identity.

## 1. Submission correctness and durability

| ID / Status | Requirement |
|:--|:--|
| CS-1.1 🟧 Planned | The system shall omit the `EmailSubmission` envelope so the server derives `rcptTo` from the Email's To, Cc, and Bcc and strips Bcc on delivery, per RFC 8621 §7. The system shall not construct a partial envelope. An explicit envelope becomes justified only when Stormbox needs SMTP extension parameters such as FUTURERELEASE or DSN, and shall then include all three recipient fields de-duplicated. |
| CS-1.2 🟧 Planned | The system shall validate each JMAP method response by both method name and call id. A send shall require: `Email/set` at call id `c1` with a created id and no `notCreated` entry; `EmailSubmission/set` at call id `s1` with a created id and no `notCreated` entry; and the implicit `Email/set` response that `onSuccessUpdateEmail` generates at the submission's call id. A missing tuple, an `["error", …]` tuple, or a missing created id shall fail the mutation. |
| CS-1.3 🟧 Planned | The system shall not report a send successful, close the composer, or delete the mutation row unless both the created Email id and the submission id are confirmed. |
| CS-1.4 🟧 Planned | The system shall not file a message into Sent — neither by persisting it nor by inserting it into an open Sent query view — unless submission was confirmed. Mailbox placement shall be read from the server's response rather than assumed from the requested target. |
| CS-1.5 🟧 Planned | When a submission is rejected for a reason that cannot succeed on retry, the mutation shall become terminal. The system shall not re-run the create-and-submit sequence, which would leave one orphaned draft per attempt. |
| CS-1.6 🟧 Planned | The system shall persist a durable checkpoint before advancing between send phases, recording the phase, a client operation id, the client-generated Message-ID, the created Email id, and the submission id. A retry shall resume at the recorded phase and shall not repeat an already-confirmed phase. |
| CS-1.7 🟧 Planned | The system shall generate one stable Message-ID per send operation, supply it as an RFC 5322 `Message-ID` header on Email creation, and reuse it across retries of that operation. The value shall be random rather than derived from message content or recipients, and shall not be assigned to the immutable JMAP `messageId` property. |
| CS-1.8 🟧 Planned | When a phase response is lost, the system shall seek positive evidence before repeating the phase: for creation, an Email carrying the operation's Message-ID within the expected mailbox scope; for submission, the known Email's mailbox and keyword state, and any retained `EmailSubmission` for that Email id. Confirmed Sent placement or a retained submission shall be treated as success. |
| CS-1.9 🟧 Planned | When the outcome remains ambiguous after reconciliation, the system shall enter a durable send-outcome-unknown state, shall not retry automatically, and shall not present a plain Retry action that could duplicate delivery. |
| CS-1.10 🟧 Planned | When the server write succeeded but cache reconciliation failed, the system shall checkpoint that distinction and retry only reconciliation. Cache failure shall never re-enter submission. |
| CS-1.11 🟧 Planned | The system shall recover mutation rows stranded in `in_flight` at every backend start, applying the ambiguous-outcome rules above. A one-time migration is insufficient because any later crash strands rows permanently. |
| CS-1.12 🟧 Planned | While a send is in flight, the system shall not offer an action that destroys the only durable copy of the message. Discard shall be available only before submission begins, and destroying the Email after submission shall not be presented as cancelling delivery. |
| CS-1.13 🟧 Planned | User-facing send confirmation shall mean accepted for submission, not confirmed delivery. |

## 2. Recipients, reply audience, and threading

| ID / Status | Requirement |
|:--|:--|
| CS-2.1 🟧 Planned | The system shall provide Cc and Bcc recipient fields in compose, using the same input control and autocomplete behavior as To. This completes R-4.7. |
| CS-2.2 🟧 Planned | The system shall permit sending when any of To, Cc, or Bcc holds at least one valid recipient, rather than requiring To. |
| CS-2.3 🟧 Planned | Address parsing shall implement the RFC 5322 address-list grammar: quoted display names containing commas, comments, angle-addr, group syntax, and internationalized addresses. The system shall not split input on commas before parsing. |
| CS-2.4 🟧 Planned | The system shall surface every fragment it could not parse as an address and shall neither silently drop it nor pass it through as an address. |
| CS-2.5 🟧 Planned | Reply All shall be computed from the parent message's structured addresses, not its rendered header text. It shall carry forward the original To and Cc, target Reply-To when present and From otherwise, remove every owned address and exact duplicate, and never copy Bcc. Plain Reply shall remain narrow, targeting Reply-To or From only. |
| CS-2.6 🟧 Planned | Reply and Reply All shall set `In-Reply-To` to the parent's Message-ID and extend `References` with it, drawn from the cached `rfc822_message_id` and `references_json` columns, so external clients thread the response. Subject prefixing alone is not threading. |
| CS-2.7 🟧 Planned | The message detail view shall display Cc so the user can see the audience before replying. |
| CS-2.8 🟧 Planned | The system shall apply the selected Identity's `replyTo` default on send, per RFC 8621 §6.1. Applying the Identity `bcc` default requires an explicit product decision first, because silently Bcc-ing the user is user-visible behavior; until that decision is recorded the property shall be persisted but not applied. |

## 3. Recipient autocomplete

| ID / Status | Requirement |
|:--|:--|
| CS-3.1 🟧 Planned | Every email address on every synced contact shall be reachable by autocomplete through both name and address matching. Address-prefix-only matching does not satisfy this. |
| CS-3.2 🟧 Planned | Matching shall consider the contact's display name, full name, given and family names, organization, and nickname where available, and shall support unordered word-prefix matching so "jane smi" matches "Smith, Jane". |
| CS-3.3 🟧 Planned | Learned recipient history shall be derived only from confirmed outgoing submissions, or from Sent-folder messages whose From is an owned address. Addresses observed on received mail shall not become suggestions. |
| CS-3.4 🟧 Planned | Candidates shall be merged by normalized address so one address yields one suggestion. When several sources or cards supply different display names for one address, selection shall be deterministic and shall prefer contact metadata over history. |
| CS-3.5 🟧 Planned | Normalization for comparison shall trim whitespace, apply Unicode normalization, lower-case and IDNA-normalize the domain, and compare the local part case-insensitively. The system shall not apply provider-specific canonicalization such as dot-stripping or plus-tag removal, which would merge genuinely distinct addresses. |
| CS-3.6 🟧 Planned | Ranking shall be deterministic and ordered by match quality: exact address, address prefix, name-token prefix, then substring; with boosts for a contact's preferred address, recent successful sends, and send frequency. An exact history match shall outrank a weak contact substring match. |
| CS-3.7 🟧 Planned | Suggestions shall exclude addresses already present in any of To, Cc, or Bcc, and shall suppress owned addresses unless the user types one exactly. |
| CS-3.8 🟧 Planned | Explicit user input shall take precedence over suggestions. Enter shall accept a suggestion only while one is highlighted; otherwise it shall commit valid typed input or report a precise parse error. |
| CS-3.9 🟧 Planned | The recipient control shall implement the WAI-ARIA editable combobox pattern: `aria-expanded`, `aria-controls`, `aria-activedescendant`, listbox and option roles, an announced result count, accessible removal of each committed recipient, and focus restoration after removal. |
| CS-3.10 🟧 Planned | Suggestion queries shall be debounced, and a response that is no longer current shall be discarded rather than replacing newer results. |
| CS-3.11 🟧 Planned | The control shall accept multi-address paste separated by commas, semicolons, or newlines, committing valid addresses and reporting rejected fragments per CS-2.4. |
| CS-3.12 🟧 Planned | The suggestion list shall present a bounded number of best matches rather than the whole address book, and shall offer a path to browse contacts for full-list selection. |
| CS-3.13 🟧 Planned | Learned history shall remain local to the device, and the user shall be able to remove an individual suggestion and clear collected history. Whether Bcc recipients are collected shall be stated explicitly in the implementation. |
| CS-3.14 🟧 Planned | Suggestion queries shall be served by indexed lookups with a stated latency budget, and shall not perform unbounded substring scans over contacts or stored message addresses on each keystroke. |

## 4. Contact and identity source integrity

| ID / Status | Requirement |
|:--|:--|
| CS-4.1 🟧 Planned | ContactCard synchronization shall persist an object state obtained from `ContactCard/get`. The `queryState` returned by `ContactCard/query` is valid only for `queryChanges` and shall not be stored as the object state that `ContactCard/changes` consumes. |
| CS-4.2 🟧 Planned | A full ContactCard sync shall be authoritative, in the same sense as FM-1.7 for folders: a live local contact absent from the complete server result shall be removed. Sweeping shall occur only after every page succeeded, inside a transaction, and shall be followed by a `ContactCard/changes` catch-up from the baseline state so concurrent edits are not lost. An interrupted paging sequence shall never sweep. |
| CS-4.3 🟧 Planned | Contact storage shall represent address-book membership as a many-to-many relation, because RFC 9610 permits a card to belong to several address books. Collapsing membership to the first known book loses filing information. |
| CS-4.4 🟧 Planned | A contact mutation shall not report success when its post-write cache reconciliation failed. The system shall checkpoint "server write succeeded, cache stale" and retry only reconciliation, never the already-applied server write. |
| CS-4.5 🟧 Planned | `Identity/get` shall be applied as an authoritative snapshot, including the empty-list case, so a removed identity cannot linger in the From picker. The `replyTo` and `bcc` properties shall be persisted. |
| CS-4.6 🟧 Planned | The system shall paint cached identities immediately when compose opens and refresh them in the background on compose open and on reconnect, so an alias added since the last sync appears without requiring an app restart. |
| CS-4.7 🟧 Planned | Identity fidelity shall be verified at the protocol level: the selected local identity shall map to the expected JMAP Identity id, Email `from` name and address, and the From header of the externally received message. Reported alias and display-name defects shall be diagnosed from a captured transaction before assigning a cause to Stormbox or to the server. |

## 5. Verification

| ID / Status | Requirement |
|:--|:--|
| CS-5.1 🟧 Planned | Sending shall be covered end to end: To, Cc, and Bcc delivered to separate accounts with Bcc absent from delivered headers; an injected method-level error, a failure after Email creation, and a lost submission response each producing no false success, exactly one Email, at most one delivery, and no Sent copy; and a SharedWorker terminated and reloaded mid-send. |
| CS-5.2 🟧 Planned | Reply behavior shall be covered with a Reply-To header, an original Cc, duplicate recipients, and several owned aliases, asserting `In-Reply-To` and `References` on the wire. |
| CS-5.3 🟧 Planned | Autocomplete shall be covered with imports beyond one server page, matching by first name, last name, reversed token order, organization, mixed case, and accented text; cross-source de-duplication; proof that suggestions derive only from outgoing recipients; and keyboard, screen-reader, paste, and rapid-typing behavior. |
| CS-5.4 🟧 Planned | Every package that changes both server and cache state shall ship a Playwright specification asserting UI, local SQLite, and direct JMAP outcomes on Chromium and Firefox, per the constitution's Verified Consistency rule and `AGENTS.md`. |

## Prior art

Thunderbird Desktop and Roundcube both already separate delivery from
filing the Sent copy. Thunderbird runs its Fcc step after delivery and
surfaces a failed copy through `notifyListenerOnStopCopy` without
re-entering delivery; Roundcube's `rcmail_sendmail::save_message()`
runs after the send and raises "Could not save message in {folder}"
while the message still counts as sent. CS-1.10 adopts that split.

Both also carry a client-generated Message-ID through delivery.
Thunderbird sets `_compFields.messageId` at compose time; Roundcube
reuses the compose session's message id and falls back to
`gen_message_id()`. CS-1.7 adopts that, because a server-assigned id
leaves no reconciliation key after a lost response.

Neither client retries an ambiguous send automatically: Thunderbird
waits for "Send Unsent Messages" and Roundcube waits for the user to
press Send again. CS-1.9 restores that default, since automatic retry of
an irreversible act is the main duplicate-delivery risk.

Where Stormbox can go further is reconciliation. SMTP offers no way to
ask whether a message was delivered, so both clients' ambiguity is
unresolvable and Thunderbird's Outbox has a genuine duplicate window.
JMAP keeps the Email and the EmailSubmission as addressable objects, so
CS-1.8 can resolve automatically what is resolvable and stop only on the
remainder.

Thunderbird bug 1656240 is the cautionary case and the same class of
defect as Stormbox's current behavior: an SMTP timeout leaves the
message copied to Sent although it was never delivered, so the user
cannot tell what went out. It motivates CS-1.4 and the absence-of-Sent
assertion in CS-5.1.

## Non-goals

These are out of scope for this specification and are recorded here so
later work has a home rather than being absorbed silently:

- **Draft persistence and recovery.** Local autosave, restore after
  reload or crash, server draft replacement, and the Close-versus-Discard
  distinction beyond the in-flight safety rule in CS-1.12.
- **Attachment handling.** File attachments are not implemented, so
  attachment reminders are premature.
- **Undo Send and scheduled send.** Both depend on durable send state
  landing first. A client-local delay is not a durable scheduler once
  every tab closes; these need server-delayed submission with
  `maxDelayedSend`.
- **A user-visible Outbox folder and an offline send queue.**
- **Multiple Sent-copy targets**, equivalent to Thunderbird's Fcc2.
- **Compose warnings** for empty subject or body, duplicate recipients,
  and large visible recipient lists.
- **Contact groups and organization-directory suggestion sources.**
