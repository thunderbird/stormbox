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

This is the `specs/001-mvp-scope/spec.md` legend rather than the
folder-management one, because this document refines MVP requirements
directly and its statuses are read alongside them.

## Status overview

| # | Area | 🟩 Done | 🟨 Partial | 🟧 Planned | 🟥 Won't |
|---|---|--:|--:|--:|--:|
| 1 | Submission correctness and durability | 14 | — | — | — |
| 2 | Recipients, reply audience, and threading | 8 | — | 1 | 1 |
| 3 | Recipient autocomplete | 16 | — | — | — |
| 4 | Contact and identity source integrity | 8 | — | — | — |
| 5 | Verification | 5 | 1 | — | — |

CS-2.10 records a deliberate non-goal rather than outstanding work.

What remains: CS-2.9 (WP7, the iOS overlay) and CS-5.4, which stays partial
until the last package ships its specification. CS-3.2's nickname clause is
satisfied only as far as "where available" allows: no column or sync field
carries a nickname, so none is tokenized.

These marks are part of each work package's close-out task, not a separate
ledger to reconcile later. `tasks.md` remains the authoritative checklist of
work; this table says only which requirements it has satisfied.

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

Phase 2 is irreversible: once submission is accepted the message may
already be in transit. Phase 1 is reversible through `Email/set destroy`
but is **not idempotent** — repeating it creates a second Email. Phases 3
and 4 are repairable, and repairing them must never re-run phase 1 or 2.

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
| CS-1.1 🟩 Done | Every recipient in To, Cc, and Bcc shall be delivered to. The system shall omit the `EmailSubmission` envelope so the server derives `rcptTo` from all three fields and strips Bcc on delivery, per RFC 8621 §7; this holds whether creation and submission share a request or are separated by the checkpoint of CS-1.6, verified against Stalwart v0.15.4 including the Bcc-only case. A **partial** envelope, such as the To-only one this code previously built, is forbidden. Omission also preserves the server's own `noRecipients` rejection, which an explicit `rcptTo: []` bypasses: that is accepted, files the message into Sent, and delivers to nobody. An explicit envelope becomes justified only for SMTP extension parameters such as FUTURERELEASE or DSN, and shall then carry all three fields de-duplicated. |
| CS-1.2 🟩 Done | The system shall validate each JMAP method response by both method name and call id. A send shall require `Email/set` at call id `c1` with a created id, and `EmailSubmission/set` at call id `s1` with a created id; a missing tuple, an `["error", …]` tuple, or a missing created id shall fail the send. The implicit `Email/set` response that `onSuccessUpdateEmail` generates at the submission's call id shall be inspected separately and shall **not** fail the send: once submission is accepted the message may already be in transit, so a rejected filing patch shall mark filing unconfirmed per CS-1.4 rather than returning the row to submission. |
| CS-1.3 🟩 Done | The system shall not report a send successful, close the composer, or delete the mutation row unless both the created Email id and the submission id are confirmed. |
| CS-1.4 🟩 Done | The system shall not file a message into Sent — neither by persisting it nor by inserting it into an open Sent query view — unless submission was confirmed. Mailbox placement shall be read from the server's response rather than assumed from the requested target. |
| CS-1.5 🟩 Done | When a submission is rejected for a reason that cannot succeed on retry, the mutation shall become terminal. The system shall not re-run the create-and-submit sequence, which would leave one orphaned draft per attempt. |
| CS-1.6 🟩 Done | The system shall persist a durable checkpoint before advancing between send phases, recording the phase, a client operation id, the client-generated Message-ID, the created Email id, and the submission id. A retry shall resume at the recorded phase and shall not repeat an already-confirmed phase. A phase shall be recorded before the call it guards, not after, so the window a replay would duplicate is always covered by a phase that forbids replay. Crash recovery shall read the phase rather than assume the worst: a row that had not yet issued its submission is resumable; a row whose submission was in flight is ambiguous and shall be conflicted; a row past submission shall resume at local filing rather than be reported as a failure; and a row with no recorded phase, or with an unreadable checkpoint, is ambiguous. |
| CS-1.7 🟩 Done | The system shall generate one Message-ID per send operation, supply it at Email creation, and reuse it unchanged across retries of that operation. It may be supplied either as the JMAP `messageId` property or as the equivalent `header:Message-ID:asMessageIds` value: RFC 8621 §4.1.3 defines them as equivalent and §4.6 has the server generate one only when the client omits it, so `messageId` is immutable after creation rather than forbidden at creation. The value shall satisfy the RFC 5322 §3.6.4 `msg-id` grammar and be globally unique, and shall not be derived from message content or recipient addresses, which would leak them. |
| CS-1.8 🟩 Done | When a phase response is lost, the system shall seek positive evidence before repeating the phase: for creation, an Email carrying the operation's Message-ID within the expected mailbox scope; for submission, the known Email's mailbox and keyword state. Confirmed Sent placement shall be treated as success. Reconciliation shall not depend on finding a retained `EmailSubmission`. Stalwart v0.15.4 does return the record, with its server-derived envelope and per-recipient `deliveryStatus`, when queried straight after the send, but the same account returns an empty list minutes later, so retention is best-effort and time-limited. A retained submission may be used as confirmation; its absence shall never be read as failure. Note also that on that server every shape of the RFC 8621 `header` FilterCondition returns no results, so finding an Email by its Message-ID means listing the candidate mailbox and comparing client-side rather than filtering server-side. |
| CS-1.9 🟩 Done | When the outcome remains ambiguous after reconciliation, the system shall enter a durable send-outcome-unknown state, shall not retry automatically, and shall not present a plain Retry action that could duplicate delivery. |
| CS-1.10 🟩 Done | When the server write succeeded but cache reconciliation failed, the system shall checkpoint that distinction and retry only reconciliation. Cache failure shall never re-enter submission. This satisfies rather than weakens the constitution's cache-before-completion rule: the rule requires the cache to match the server, and a message the server still holds in Drafts is matched by a local row in Drafts. What the rule forbids is resolving while the cache claims a state the server does not have, which is exactly what CS-1.4 prevents. |
| CS-1.11 🟩 Done | The system shall recover mutation rows stranded in `in_flight` at every backend start, applying the ambiguous-outcome rules above. A one-time migration is insufficient because any later crash strands rows permanently. |
| CS-1.12 🟩 Done | While a send is in flight, the system shall not offer an action that destroys the only durable copy of the message. Discard shall be available only before submission begins, and destroying the Email after submission shall not be presented as cancelling delivery. |
| CS-1.13 🟩 Done | User-facing send confirmation shall mean accepted for submission, not confirmed delivery. |
| CS-1.14 🟩 Done | Sent-folder reconciliation after a send shall derive list position and total from the server rather than assuming them. The current code inserts the new message at index 0 of every open Sent view and increments the cached total locally, which the constitution's requirement for server-derived `Email/query` positions and authoritative `query_views.total` does not permit. Affected Mailbox counters shall be reconciled too. |

## 2. Recipients, reply audience, and threading

| ID / Status | Requirement |
|:--|:--|
| CS-2.1 🟩 Done | The system shall provide Cc and Bcc recipient fields in compose, using the same input control and autocomplete behavior as To. This completes R-4.7. |
| CS-2.2 🟩 Done | The system shall permit sending when any of To, Cc, or Bcc holds at least one valid recipient, rather than requiring To. |
| CS-2.3 🟩 Done | Address parsing shall implement the RFC 5322 §§3.4-3.4.1 address-list grammar — quoted display names containing commas, nested comments, and angle-addr — extended with the internationalized forms defined by RFC 6532 §§3.1-3.2. Group syntax is covered separately by CS-2.10 and is **not** part of what this requirement claims. Transporting those addresses additionally depends on SMTPUTF8 (RFC 6531), which is the server's concern. The system shall not split input on commas before parsing. Per an explicit product decision, `postal-mime` is used as a reference implementation rather than a dependency, so this parser is written in-repo against a stated grammar subset with conformance tests, instead of adopting a maintained parser as `AGENTS.md` would otherwise prefer. |
| CS-2.10 🟥 Unimplemented | Group syntax (`display-name ":" [group-list] ";"`, RFC 5322 §3.4) is **deliberately left unimplemented as a compose feature**, and this row exists so the spec stops implying otherwise. What does work, and must keep working, is parsing: an inbound header is flattened to its member mailboxes, and the empty case `undisclosed-recipients:;` parses to no recipients rather than to an error. That is required — it appears in real received mail, and reply audience is computed from these headers — and it matches Thunderbird, whose parser flattens by default and exposes `preserveGroups` only to callers that need the hierarchy. What is not supported is composing one: typing `Team: alice@example.com` is an unterminated group, so it commits as an invalid pill under CS-3.16, and no address-book mailing list is planned as a substitute. Thunderbird reached the same place from the other direction — accepting `;` as an alternative recipient separator cost it group input entirely (bug 242693, bug 919953) — though this parser keeps both, treating `;` as a terminator only once a colon has opened a group. |
| CS-2.4 🟩 Done | The system shall surface every fragment it could not parse as an address and shall neither silently drop it nor pass it through as an address. |
| CS-2.5 🟩 Done | Reply All shall be computed from the parent message's structured addresses, not its rendered header text. It shall carry forward the original To and Cc, target Reply-To when present and From otherwise, remove every owned address and exact duplicate, and never copy Bcc. Plain Reply shall remain narrow, targeting Reply-To or From only, with the user's own addresses removed from that target and From standing in when a Reply-To names nobody else. Whether a message is the user's own shall be determined from From alone: a Reply-To that happens to name an owned address does not make someone else's message the user's, and shall not widen a plain Reply to that message's other recipients. Replying to a message the user did send is the exception to narrowness — plain Reply shall target the addresses it was sent To, because replying to oneself addresses nobody, and Reply All shall add its Cc. |
| CS-2.6 🟩 Done | Reply and Reply All shall set `In-Reply-To` to the parent's Message-ID and extend `References` with it, drawn from the cached `rfc822_message_id` and `references_json` columns, so external clients thread the response. Subject prefixing alone is not threading. |
| CS-2.7 🟩 Done | The message detail view shall display Cc so the user can see the audience before replying. |
| CS-2.8 🟩 Done | The system shall apply the selected Identity's `replyTo` default on send, per RFC 8621 §6.1. Applying the Identity `bcc` default requires an explicit product decision first, because silently Bcc-ing the user is user-visible behavior; until that decision is recorded the property shall be persisted but not applied. |
| CS-2.9 🟧 Planned | The compose dialog shall remain visible and interactive above the folder navigation overlay on small viewports, so opening compose on iOS does not leave the user with an obscured or unreachable form. |

## 3. Recipient autocomplete

| ID / Status | Requirement |
|:--|:--|
| CS-3.1 🟩 Done | Every email address on every synced contact shall be reachable by autocomplete through both name and address matching. Address-prefix-only matching does not satisfy this. |
| CS-3.2 🟩 Done | Matching shall consider the contact's display name, full name, given and family names, organization, and nickname where available, and shall support unordered word-prefix matching so "jane smi" matches "Smith, Jane". |
| CS-3.3 🟩 Done | Learned recipient history shall be derived only from confirmed outgoing submissions, or from Sent-folder messages whose From is an owned address. Addresses observed on received mail shall not become suggestions. |
| CS-3.4 🟩 Done | Candidates shall be merged by normalized address so one address yields one suggestion. When several sources or cards supply different display names for one address, selection shall be deterministic and shall prefer contact metadata over history. |
| CS-3.5 🟩 Done | Normalization for comparison shall trim whitespace, apply Unicode NFC (never NFKC, per RFC 6532 §3.1), and lower-case and IDNA-normalize the domain, which is case-insensitive. The local part shall be preserved verbatim in anything sent or stored, because RFC 5321 §2.3.11 makes it case-sensitive to the receiving server; suggestion de-duplication may fold its case as a deliberate UI trade-off, on the basis that two addresses differing only by local-part case are effectively never distinct people in practice. The system shall not apply provider-specific canonicalization such as dot-stripping or plus-tag removal. |
| CS-3.6 🟩 Done | Ranking shall be deterministic and ordered by match quality: exact address, address prefix, name-token prefix, then substring; with boosts for a contact's preferred address, recent successful sends, and send frequency. An exact history match shall outrank a weak contact substring match. Two specific defects shall be removed. The contact query is currently issued with the caller's full limit, so contacts can consume the entire budget and an exact history match for the address the user typed is never offered. The history query carries no `ORDER BY`, so when more rows match than the remaining budget the subset returned is unspecified and can differ between identical queries. The starvation case and the duplicate-display-name case are pinned by characterisation tests in `tests/unit/db/handlers.test.ts` that must be updated when this lands; the missing `ORDER BY` is not, because an unspecified result order cannot be asserted deterministically. |
| CS-3.7 🟩 Done | Suggestions shall exclude addresses already present in any of To, Cc, or Bcc, and shall suppress owned addresses unless the user types one exactly. |
| CS-3.8 🟩 Done | Explicit user input shall take precedence over suggestions. Enter shall accept a suggestion only while one is highlighted; otherwise it shall commit valid typed input or report a precise parse error. |
| CS-3.9 🟩 Done | The recipient control shall implement the WAI-ARIA editable combobox pattern: `aria-expanded`, `aria-controls`, `aria-activedescendant`, listbox and option roles, an announced result count, accessible removal of each committed recipient, and focus restoration after removal. |
| CS-3.10 🟩 Done | Suggestion queries shall be debounced, and a response that is no longer current shall be discarded rather than replacing newer results. |
| CS-3.11 🟩 Done | The control shall accept multi-address paste separated by commas, semicolons, or newlines, committing valid addresses and reporting rejected fragments per CS-2.4. |
| CS-3.12 🟩 Done | The suggestion list shall present at most 10 matches rather than the whole address book, and shall offer a path to browse contacts for full-list selection. |
| CS-3.13 🟩 Done | Learned history shall remain local to the device, and the user shall be able to remove an individual suggestion and clear collected history. Bcc recipients shall be collected: the user deliberately addressed them, and the history never leaves the device. |
| CS-3.14 🟩 Done | A suggestion query shall complete within 50 ms at the 95th percentile against 5,000 contacts and 20,000 history rows, measured in the worker. It shall be served by indexed lookups and shall not perform unbounded substring scans over contacts or stored message addresses on each keystroke. |
| CS-3.15 🟩 Done | The suggestion list shall open once at least two characters have been typed into a recipient field. This threshold is current behaviour that no requirement previously stated; it is recorded here so it is a decision rather than an accident. |
| CS-3.16 🟩 Done | A committed recipient shall be shown as a pill, and an entry that is not a readable address shall be committed as a pill marked invalid rather than dropped, left as loose text, or reported only in a message beside the field. Invalid shall be conveyed by more than colour alone, per WCAG 1.4.1. Activating any pill shall reopen it as editable text, so a mistyped address is corrected in place rather than retyped; the invalid pill is therefore the parse error CS-3.8 requires, shown where the entry is. An invalid pill shall reopen as exactly the text that was entered, since nothing else can be known about it and a user correcting a typo needs to see the typo. A valid one shall reopen in canonical form — the address as the parser read it — which is the same recipient and re-commits unchanged, but does not preserve redundant quoting or RFC 5322 comments; keeping the original keystrokes of an address already understood would buy nothing a user can act on, and every other mail client drops them too. A draft holding an invalid pill shall not send, per CS-2.4. |

## 4. Contact and identity source integrity

| ID / Status | Requirement |
|:--|:--|
| CS-4.1 🟩 Done | ContactCard synchronization shall persist the object state returned by `ContactCard/get`. The `queryState` from `ContactCard/query` is query-result state: RFC 8620 §5.5 allows it to be compared against a later identical query or passed to `queryChanges`, while `changes` consumes the object state from `get` per §5.2. Storing the former as the latter leaves incremental sync with no usable checkpoint. |
| CS-4.2 🟩 Done | A full ContactCard sync shall be authoritative, in the same sense as FM-1.7 for folders: a live local contact absent from the complete server result shall be removed. Paging shall require a stable `queryState` across every page and restart the sweep when it changes, because paging by position alone lets a concurrent deletion shift an unseen card past the cursor — a gap a later `changes` catch-up cannot recover, since that card was never modified. Sweeping shall occur only after every page succeeded, inside a transaction, and shall be followed by a `ContactCard/changes` catch-up from the baseline object state. An interrupted paging sequence shall never sweep. |
| CS-4.3 🟩 Done | Contact storage shall represent address-book membership as a many-to-many relation, because RFC 9610 permits a card to belong to several address books. Collapsing membership to the first known book loses filing information. |
| CS-4.4 🟩 Done | A contact mutation shall not report success when its post-write cache reconciliation failed. The system shall checkpoint "server write succeeded, cache stale" and retry only reconciliation, never the already-applied server write. |
| CS-4.5 🟩 Done | `Identity/get` shall be applied as an authoritative snapshot, including the empty-list case, so a removed identity cannot linger in the From picker. The `replyTo` and `bcc` properties shall be persisted. |
| CS-4.6 🟩 Done | The system shall paint cached identities immediately when compose opens and refresh them in the background on compose open and on reconnect, so an alias added since the last sync appears without requiring an app restart. |
| CS-4.7 🟩 Done | Identity fidelity shall be verified at the protocol level: the selected local identity shall map to the expected JMAP Identity id, Email `from` name and address, and the From header of the externally received message. Reported alias and display-name defects shall be diagnosed from a captured transaction before assigning a cause to Stormbox or to the server. |
| CS-4.8 🟩 Done | `AddressBook/get` shall be applied as an authoritative snapshot with deletion handling, on the same reasoning as CS-4.2. It is currently upsert-only, so a removed address book persists locally and can still be offered as a filing target. |

## 5. Verification

| ID / Status | Requirement |
|:--|:--|
| CS-5.1 🟩 Done | Recipient delivery shall be covered end to end: To, Cc, and Bcc delivered to separate accounts, with Bcc absent from the delivered headers. |
| CS-5.2 🟩 Done | Reply behavior shall be covered with a Reply-To header, an original Cc, duplicate recipients, and several owned aliases, asserting `In-Reply-To` and `References` on the wire. |
| CS-5.3 🟩 Done | Autocomplete shall be covered with imports beyond one server page, matching by first name, last name, reversed token order, organization, mixed case, and accented text; cross-source de-duplication; proof that suggestions derive only from outgoing recipients; and keyboard, screen-reader, paste, and rapid-typing behavior. |
| CS-5.4 🟨 Partial | Every package that changes both server and cache state shall ship a Playwright specification asserting UI, local SQLite, and direct JMAP outcomes on Chromium and Firefox, per the constitution's Verified Consistency rule and `AGENTS.md`. |
| CS-5.5 🟩 Done | Send failure shall be covered by three distinct cases, because they have different correct outcomes. **Server-rejected** (a method-level error, or a rejection before submission): no delivery, no Sent copy, exactly one or zero Emails, the draft recoverable, and the failure surfaced. **Accepted but response lost**: exactly one delivery, and reconciliation resolving to success — a Sent copy here is correct, not a defect. **Genuinely ambiguous** (no evidence either way survives): at most one delivery, no automatic retry, and the durable unknown-outcome state of CS-1.9 rather than a plain Retry. A SharedWorker terminated and reloaded mid-send shall be covered under the second and third cases. |
| CS-5.6 🟩 Done | Delivery shall be asserted against a second account, never against the sending account. On the pinned Stalwart v0.15.4 a self-addressed message is accepted for submission and never arrives (issue #77), so a self-delivery assertion would test the server's defect rather than this client. |

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
