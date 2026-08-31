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
| 2 | Recipients, reply audience, and threading | 8 | 1 | — | 1 |
| 3 | Recipient autocomplete | 16 | — | — | — |
| 4 | Contact and identity source integrity | 8 | 1 | — | — |
| 5 | Verification | 7 | — | 1 | — |

CS-2.10 records a deliberate non-goal rather than outstanding work.

Two requirements remain partial. CS-2.3 accepts an unpaired UTF-16
surrogate in an unquoted display-name atom. CS-4.2 has the accepted
unknown-address-book residue described in its row.

CS-5.7 is planned rather than partial: no reusable upstream address-parser
corpus or differential fuzz harness has been added.

CS-3.2's nickname clause is live: the sync requests the RFC 9553 §2.2.2
`nicknames` property and every nickname joins the contact's search tokens.

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

#### Durable phase/effect matrix

`pending_mutations.phase` records which effects may already have happened.
The phase write precedes the protocol effect it guards, so recovery follows
this matrix rather than guessing from a generic `in_flight` status:

| Durable phase | What may already have happened | Only permitted next effect or transition | Recovery and replay rule |
|:--|:--|:--|:--|
| `NULL` | Inline-image blobs may have been uploaded, but neither `Email/set` nor `EmailSubmission/set` has been issued. | Persist `queued` with the operation id and Message-ID before creating the Email. | Resume from the start. Re-uploading a blob is safe; no Email or submission can be duplicated. |
| `queued` | `Email/set` may have been issued because this phase is written before that call, but no created Email id is confirmed. | Search the newest 100 candidate-mailbox Emails for the Message-ID. A match records `created`; a conclusive absence permits one create; an inconclusive scan stops. | Never create blindly on recovery. The evidence probe makes replay safe without duplicating an Email. |
| `created` | The Email exists and its id is checkpointed. Submission has not been issued because `submitting` is written first. | Persist `submitting`, then issue `EmailSubmission/set`. | Safe to continue to submission only after the `submitting` write succeeds. |
| `submitting` | `EmailSubmission/set` may be in flight or already accepted. | A surviving worker evaluates the response and positive evidence. A definitive retryable rejection rewinds to `created`; a terminal rejection destroys the Email and rewinds to `queued`; confirmed acceptance records `submitted`; unresolved ambiguity records `unknown`. | Never replay submission from this phase. Startup recovery conflicts the row because it cannot know whether the call was issued before the worker died. |
| `submitted` | Submission was accepted and the Email and submission ids are checkpointed. | Enter `cache_pending` and reconcile Sent filing and local cache state. | Never re-enter creation or submission; only filing and cache repair may run. |
| `cache_pending` | Submission was accepted, but Sent filing or local cache reconciliation is incomplete. | Retry the server read and local cache update, remaining `cache_pending` until success or the repair budget is exhausted. | Repair is replayable; creation and submission remain forbidden. |
| `unknown` | Submission may have been accepted, but available evidence cannot decide. | No automatic protocol effect or phase transition. Resolution is through the mailbox and explicit user action under CS-1.9. | Terminal for automation; never retry creation or submission. |

An unrecognized phase or a recorded phase with an unreadable checkpoint is
also terminally ambiguous: treating unknown durable state as an earlier phase
could repeat an irreversible effect.

### Ambiguous outcome

An outcome is **ambiguous** when a phase's response was lost and the
server state cannot distinguish "it happened" from "it did not". A
lost submission response is the canonical case. Stormbox resolves
ambiguity by positive evidence where evidence exists, and otherwise
stops. It never resolves ambiguity by retrying an irreversible act.

### Recipient candidate

A **candidate** is one suggestible `(email, display name, source,
score)` tuple sourced from a live synced ContactCard. The rebuildable
recipient-usage projection affects ranking but never supplies a candidate.
One address yields at most one candidate, regardless of how many contact
cards contain it.

### Owned address

An **owned address** is any address belonging to the signed-in user:
the account's primary email plus the email of every synced `Identity`.
Reply audience computation and autocomplete suppression both operate on
the full owned-address set, not on the currently selected From identity.

## 1. Submission correctness and durability

| ID / Status | Requirement |
|:--|:--|
| CS-1.1 🟩 Done | Every recipient in To, Cc, and Bcc shall be delivered to. The system shall send an explicit `EmailSubmission` envelope whose `mailFrom` is the selected Identity address and whose `rcptTo` is the complete, de-duplicated To, Cc, then Bcc union, per RFC 8621 §7. Each `rcptTo` entry shall contain only the first-seen bare addr-spec, with the canonical address key used only for comparison and no display name sent on the wire. Omitting the envelope is forbidden because Stalwart v0.15.4 silently skips header addresses its sanitizer rejects and delivers to the surviving subset instead of rejecting the submission per §7.5. An empty recipient set shall fail before submission rather than send `rcptTo: []`, which triggers header derivation. |
| CS-1.2 🟩 Done | The system shall validate each JMAP method response by both method name and call id. A send shall require `Email/set` at call id `c1` with a created id, and `EmailSubmission/set` at call id `s1` with a created id; a missing tuple, an `["error", …]` tuple, or a missing created id shall fail the send. The implicit `Email/set` response that `onSuccessUpdateEmail` generates at the submission's call id shall be inspected separately and shall **not** fail the send: once submission is accepted the message may already be in transit, so a rejected filing patch shall mark filing unconfirmed per CS-1.4 rather than returning the row to submission. |
| CS-1.3 🟩 Done | The system shall not report a send successful, close the composer, or delete the mutation row unless both the created Email id and the submission id are confirmed. |
| CS-1.4 🟩 Done | The system shall not file a message into Sent — neither by persisting it nor by inserting it into an open Sent query view — unless submission was confirmed. Mailbox placement shall be read from the server's response rather than assumed from the requested target. |
| CS-1.5 🟩 Done | When a submission is definitively rejected for a reason that cannot succeed on retry, the mutation shall become terminal. The created Email shall be destroyed, its checkpoint id cleared, and the durable phase rewound to `queued`; the terminal mutation outcome prevents an automatic retry. Retryable rejections shall retain the Email and rewind to `created`, while ambiguous outcomes shall retain it without replaying submission. |
| CS-1.6 🟩 Done | The system shall persist a durable checkpoint before advancing between send phases, recording the phase, a client operation id, the client-generated Message-ID, the created Email id, and the submission id. A retry shall resume at the recorded phase and shall not repeat an already-confirmed phase. A phase shall be recorded before the call it guards, not after, so the window a replay would duplicate is always covered by a phase that forbids replay. Crash recovery shall read the phase rather than assume the worst: a row with no recorded phase is resumable because the first checkpoint precedes Email creation and submission; a row that had not yet issued its submission is likewise resumable; a row whose submission was in flight is ambiguous and shall be conflicted; a row past submission shall resume at local filing rather than be reported as a failure; and a row with an unreadable checkpoint is ambiguous. |
| CS-1.7 🟩 Done | The system shall generate one Message-ID per send operation, supply it at Email creation, and reuse it unchanged across retries of that operation. It may be supplied either as the JMAP `messageId` property or as the equivalent `header:Message-ID:asMessageIds` value: RFC 8621 §4.1.3 defines them as equivalent and §4.6 has the server generate one only when the client omits it, so `messageId` is immutable after creation rather than forbidden at creation. The value shall satisfy the RFC 5322 §3.6.4 `msg-id` grammar and be globally unique, and shall not be derived from message content or recipient addresses, which would leak them. |
| CS-1.8 🟩 Done | When a phase response is lost **to a worker that is still running**, the system shall seek positive evidence before repeating the phase: for creation, an Email carrying the operation's Message-ID within the expected mailbox scope; for submission, the known Email's mailbox and keyword state. Confirmed Sent placement shall be treated as success. This does not extend to startup recovery: a row whose worker died while its submission was in flight is ambiguous under CS-1.6 and shall be conflicted rather than reconciled from evidence, because the phase alone cannot distinguish a submission that was never issued from one whose response was lost, and parking is the outcome that can never deliver twice. Making that case evidence-recoverable would require a durable state that can never issue a second submission, which is deliberately out of scope. Reconciliation shall not depend on finding a retained `EmailSubmission`. Stalwart v0.15.4 does return the record, with its envelope and per-recipient `deliveryStatus`, when queried straight after the send, but the same account returns an empty list minutes later, so retention is best-effort and time-limited. A retained submission may be used as confirmation; its absence shall never be read as failure. Note also that on that server every shape of the RFC 8621 `header` FilterCondition returns no results, so finding an Email by its Message-ID means listing the candidate mailbox and comparing client-side rather than filtering server-side. That client-side reconciliation is bounded to the newest 100 Emails in the candidate mailbox, ordered by `receivedAt` descending; `absent` therefore means absent from that window, which covers the Email this operation would have created moments earlier without scanning an unbounded mailbox. |
| CS-1.9 🟩 Done | When the outcome remains ambiguous after reconciliation, the system shall record it durably, shall not retry automatically, and shall not present a plain Retry action that could silently duplicate delivery. The ambiguity shall resolve through the mailbox, not a dedicated composer state: the created Email is on the server in every reconciliation-reachable case — in Sent if the submission was accepted, in Drafts if not — so the composer shall close and direct the user to those folders, where sync makes the outcome visible. Only when an unreadable checkpoint leaves no server copy of the message known to exist shall the composer stay open holding the text, warning the user to check Sent before sending again; Send then remains available, because resending after that check is the user's decision to make, as it is in Thunderbird's Outbox and Roundcube's compose screen. |
| CS-1.10 🟩 Done | When the server write succeeded but cache reconciliation failed, the system shall checkpoint that distinction and retry only reconciliation. Cache failure shall never re-enter submission. This satisfies rather than weakens the constitution's cache-before-completion rule: the rule requires the cache to match the server, and a message the server still holds in Drafts is matched by a local row in Drafts. What the rule forbids is resolving while the cache claims a state the server does not have, which is exactly what CS-1.4 prevents. |
| CS-1.11 🟩 Done | The system shall recover mutation rows stranded in `in_flight` at every backend start, applying the ambiguous-outcome rules above. A one-time migration is insufficient because any later crash strands rows permanently. |
| CS-1.12 🟩 Done | While a send is in flight, the system shall not offer an action that destroys the only durable copy of the message. Discard shall be available only before submission begins, and destroying the Email after submission shall not be presented as cancelling delivery. A key event owned by an active input-method composition shall not dismiss the composer or discard its draft. |
| CS-1.13 🟩 Done | User-facing send confirmation shall mean accepted for submission, not confirmed delivery. |
| CS-1.14 🟩 Done | Sent-folder reconciliation after a send shall derive list position and total from the server rather than assuming them, and shall reconcile the affected Mailbox counters too. Each open Sent view takes the new message's position and authoritative total from its own `Email/query`, marking an unanswered view stale. The accompanying `Mailbox/get` persists `totalEmails`, `unreadEmails`, `totalThreads`, and `unreadThreads` together so every local counter reflects the same authoritative response. |

## 2. Recipients, reply audience, and threading

| ID / Status | Requirement |
|:--|:--|
| CS-2.1 🟩 Done | The system shall provide Cc and Bcc recipient fields in compose, using the same input control and autocomplete behavior as To. This completes R-4.7. |
| CS-2.2 🟩 Done | The system shall permit sending when any of To, Cc, or Bcc holds at least one valid recipient, rather than requiring To. |
| CS-2.3 🟨 Partial | Address parsing shall implement the RFC 5322 §§3.4-3.4.1 address-list grammar — quoted display names containing commas, nested comments, and angle-addr — extended with the internationalized forms defined by RFC 6532 §§3.1-3.2. Group syntax is covered separately by CS-2.10 and is **not** part of what this requirement claims. Transporting those addresses additionally depends on SMTPUTF8 (RFC 6531), which is the server's concern. The system shall not split input on commas before parsing. Per an explicit product decision, `postal-mime` is used as a reference implementation rather than a dependency, so this parser is written in-repo against a stated grammar subset with conformance tests, instead of adopting a maintained parser as `AGENTS.md` would otherwise prefer. Quoted strings reject unpaired UTF-16 surrogates, but `isAtext()` currently accepts one in an unquoted display-name atom, so the RFC 6532 scalar-value restriction is not complete. |
| CS-2.10 🟥 Won't | Group syntax (`display-name ":" [group-list] ";"`, RFC 5322 §3.4) is **deliberately left unimplemented as a compose feature**, and this row exists so the spec stops implying otherwise. What does work, and must keep working, is parsing: an inbound header is flattened to its member mailboxes, and the empty case `undisclosed-recipients:;` parses to no recipients rather than to an error. That is required — it appears in real received mail, and reply audience is computed from these headers — and it matches Thunderbird, whose parser flattens by default and exposes `preserveGroups` only to callers that need the hierarchy. What is not supported is composing one: typing `Team: alice@example.com` is an unterminated group, so it commits as an invalid pill under CS-3.16, and no address-book mailing list is planned as a substitute. Thunderbird reached the same place from the other direction — accepting `;` as an alternative recipient separator cost it group input entirely (bug 242693, bug 919953) — though this parser keeps both, treating `;` as a terminator only once a colon has opened a group. |
| CS-2.4 🟩 Done | The system shall surface every fragment it could not parse as an address and shall neither silently drop it nor pass it through as an address. |
| CS-2.5 🟩 Done | Reply All shall be computed from the parent message's structured addresses, not its rendered header text. It shall carry forward the original To and Cc, target Reply-To when present and From otherwise, remove every owned address and exact duplicate, and never copy Bcc. Plain Reply shall remain narrow, targeting Reply-To or From only, with the user's own addresses removed from that target and From standing in when a Reply-To names nobody else. Whether a message is the user's own shall be determined from From alone: a Reply-To that happens to name an owned address does not make someone else's message the user's, and shall not widen a plain Reply to that message's other recipients. Replying to a message the user did send is the exception to narrowness — plain Reply shall target the addresses it was sent To, because replying to oneself addresses nobody, and Reply All shall add its Cc. |
| CS-2.6 🟩 Done | Reply and Reply All shall set `In-Reply-To` to the parent's Message-ID and extend `References` with it, drawn from the cached `rfc822_message_id` and `references_json` columns, so external clients thread the response. Subject prefixing alone is not threading. |
| CS-2.7 🟩 Done | The message detail view shall display Cc so the user can see the audience before replying. |
| CS-2.8 🟩 Done | New compose sessions shall use the client-selected Primary Identity. Replies shall use the first Identity matching the original message's To addresses and fall back to Primary. The system shall apply that Identity's `replyTo`, `bcc`, `htmlSignature`, and `textSignature` defaults per RFC 8621 §6. Reply-To is applied on save/send. Bcc and signatures shall be materialized before a new/reply/forward session captures its clean seed; changing From shall replace only intact auto-added values, and a reopened server draft shall receive no inferred defaults. The complete selection and provenance rules are `specs/005-contact-details/spec.md` CT-5.3 through CT-5.6. |
| CS-2.9 🟩 Done | The compose dialog shall remain visible and interactive above the folder navigation overlay on small viewports, so opening compose on iOS does not leave the user with an obscured or unreachable form. |

## 3. Recipient autocomplete

| ID / Status | Requirement |
|:--|:--|
| CS-3.1 🟩 Done | ContactCards shall be the only source of autocomplete candidates, and every email address on every live synced card shall be reachable through both name and address matching. A recipient absent from ContactCards shall not be suggested merely because an old local history row or received message names it. |
| CS-3.2 🟩 Done | Matching shall consider the contact's display name, full name, given and family names, organization, and nickname where available, and shall support unordered word-prefix matching so "jane smi" matches "Smith, Jane". |
| CS-3.3 🟩 Done | After a confirmed Stormbox submission, every unique To, Cc, and Bcc address shall become a ContactCard in `Trusted senders` unless that canonical address already exists on any card in any address book. Newly observed Sent Emails authored by an owned identity shall apply the same rule for sends made by other clients. Received mail shall never create contacts. |
| CS-3.4 🟩 Done | Candidate and contact creation shall be de-duplicated by normalized address across every email on every ContactCard in the account, regardless of address book. When duplicate cards already exist, autocomplete shall still yield one deterministic suggestion; Stormbox shall never create another duplicate. Adding a normal contact for an auto-collected address shall enrich and re-file its existing card. |
| CS-3.5 🟩 Done | Normalization for comparison shall trim whitespace, apply Unicode NFC and never NFKC (RFC 6532 §3.1 says NFC SHOULD be used and NFKC SHOULD NOT; this system pins both), and lower-case and IDNA-normalize the domain, which is case-insensitive. The local part shall be preserved verbatim in anything sent or stored, because RFC 5321 §2.4 makes it case-sensitive to the receiving server; suggestion de-duplication may fold its case as a deliberate UI trade-off, on the basis that two addresses differing only by local-part case are effectively never distinct people in practice. The system shall not apply provider-specific canonicalization such as dot-stripping or plus-tag removal. |
| CS-3.6 🟩 Done | Ranking shall be deterministic and ordered by match quality: exact address, address prefix, name-token prefix, then substring; with boosts for a contact's preferred address, recency, and frequency. Recency and frequency are a rebuildable local projection over the newest 300 Sent messages: one canonical recipient counts at most once per message, only messages authored by an owned identity count, and `last_sent_at` is the newest matching `sentAt`. Match tier always outranks a usage boost. |
| CS-3.7 🟩 Done | Suggestions shall exclude addresses already present in any of To, Cc, or Bcc, and shall suppress owned addresses unless the user types one exactly. |
| CS-3.8 🟩 Done | When a non-empty suggestion list opens, its first option shall already be highlighted and exposed through `aria-activedescendant`; Arrow Down shall therefore advance to the next option rather than selecting the first one. Enter shall accept the highlighted suggestion. When no suggestion is available, Enter shall commit valid typed input or report a precise parse error. The recipient control shall not act on keys owned by an active input-method composition. |
| CS-3.9 🟩 Done | The recipient control shall implement the WAI-ARIA editable combobox pattern: `aria-expanded`, `aria-controls`, `aria-activedescendant`, listbox and option roles, an announced result count, accessible removal of each committed recipient, and focus restoration after removal. |
| CS-3.10 🟩 Done | Suggestion queries shall be debounced, and a response that is no longer current shall be discarded rather than replacing newer results. |
| CS-3.11 🟩 Done | The control shall accept multi-address paste separated by commas, semicolons, or newlines, committing valid addresses and reporting rejected fragments per CS-2.4. |
| CS-3.12 🟩 Done | The suggestion list shall present at most 10 matches rather than the whole address book, and shall offer a path to browse contacts for full-list selection. The browse list shall not be capped: every contact in the address book shall be selectable from it, however large the book is. A ceiling on the browse fetch silently hides every contact sorted after it, which is worse than the typeahead the browse path exists to rescue. |
| CS-3.13 🟩 Done | Deleting an auto-collected ContactCard shall remove both its suggestion and trusted-sender status. Sent-window ranking refreshes and `cannotCalculateChanges` fallbacks are read-only with respect to contacts and shall not recreate it. A genuinely new confirmed send after deletion may trust the address again. Historical promotion of the newest 300 Sent messages shall complete automatically exactly once per account without user action, and shall not be exposed as a user-initiated command. It shall remain pending for a later bootstrap whenever no Sent messages are cached locally or the contact mutation fails, so that an empty cache can never record it as complete. |
| CS-3.14 🟩 Done | A suggestion query shall complete within 50 ms at the 95th percentile against 5,000 contacts carrying usage evidence, measured in the worker. The budget is the whole requirement: how a query is served — indexes, scans, tiers — is the implementation's business, judged only by whether the budget holds. |
| CS-3.15 🟩 Done | The suggestion list shall open once at least one non-whitespace character has been typed into a recipient field. |
| CS-3.16 🟩 Done | A committed recipient shall be shown as a pill, and an entry that is not a readable address shall be committed as a pill marked invalid rather than dropped, left as loose text, or reported only in a message beside the field. Invalid shall be conveyed by more than colour alone, per WCAG 1.4.1. Activating any pill shall reopen it as editable text, so a mistyped address is corrected in place rather than retyped; the invalid pill is therefore the parse error CS-3.8 requires, shown where the entry is. An invalid pill shall reopen as exactly the text that was entered, since nothing else can be known about it and a user correcting a typo needs to see the typo. A valid one shall reopen in canonical form — the address as the parser read it — which is the same recipient and re-commits unchanged, but does not preserve redundant quoting or RFC 5322 comments; keeping the original keystrokes of an address already understood would buy nothing a user can act on, and every other mail client drops them too. A draft holding an invalid pill shall not send, per CS-2.4. |

## 4. Contact and identity source integrity

| ID / Status | Requirement |
|:--|:--|
| CS-4.1 🟩 Done | ContactCard synchronization shall persist the object state returned by `ContactCard/get`. The `queryState` from `ContactCard/query` is query-result state: RFC 8620 §5.5 allows it to be compared against a later identical query or passed to `queryChanges`, while `changes` consumes the object state from `get` per §5.2. Storing the former as the latter leaves incremental sync with no usable checkpoint. |
| CS-4.2 🟨 Partial | A full ContactCard sync shall be authoritative, in the same sense as FM-1.7 for folders: a live local contact absent from the complete server result shall be removed. Paging shall require a stable `queryState` across every page and restart the sweep when it changes, because paging by position alone lets a concurrent deletion shift an unseen card past the cursor — a gap a later `changes` catch-up cannot recover, since that card was never modified. Sweeping occurs only after every page succeeded, inside a transaction, and is followed by a `ContactCard/changes` catch-up from the baseline object state; an interrupted or incomplete sequence never sweeps. The accepted residue is a card filed only in an unknown address book: `ensureContacts()` does not refresh AddressBooks first, so the card is skipped fail-closed and the sweep is withheld, but the card can remain absent locally until another ContactCard push or a restart. Nothing is deleted in this case, but the full sync is not fully authoritative. |
| CS-4.3 🟩 Done | Contact storage shall represent address-book membership as a many-to-many relation, because RFC 9610 permits a card to belong to several address books. Collapsing membership to the first known book loses filing information. |
| CS-4.4 🟩 Done | A contact mutation shall not report success when its post-write cache reconciliation failed. The system shall checkpoint "server write succeeded, cache stale" and retry only reconciliation, never the already-applied server write. |
| CS-4.5 🟩 Done | A complete account-wide `Identity/get` shall be applied as an authoritative snapshot, including the empty-list case, so a removed identity cannot linger in the From picker. Partial or targeted results shall upsert only observed ids and shall never sweep unrelated cached identities. `replyTo`, `bcc`, `textSignature`, `htmlSignature`, and `mayDelete` shall be retained. Mutation repair shall use a targeted get for create/update and exact local removal after confirmed delete. |
| CS-4.6 🟩 Done | The system shall paint cached identities immediately when compose opens and refresh them in the background on compose open and on reconnect, so an alias added since the last sync appears without requiring an app restart. |
| CS-4.7 🟩 Done | Identity fidelity shall be verified at the protocol level: the selected local identity shall map to the expected JMAP Identity id, Email `from` name and address, and the From header of the externally received message. Reported alias and display-name defects shall be diagnosed from a captured transaction before assigning a cause to Stormbox or to the server. |
| CS-4.8 🟩 Done | `AddressBook/get` shall be applied as an authoritative snapshot with deletion handling, on the same reasoning as CS-4.2. `syncAddressBooks()` persists the result with `snapshot: true`, retiring live local rows omitted by the complete server list so removed books are no longer offered as filing targets. |
| CS-4.9 🟩 Done | Identity management shall live in the Contacts space behind **Manage identities** and shall reuse the contact list, third-column shell, and shared rich-text editor. The client-selected Primary Identity shall be marked in the list and persisted as a user setting because JMAP Identity has no primary property; absent a valid setting, the first Identity with `mayDelete: false` shall be Primary. Create, sparse update, and permitted delete actions shall use durable `Identity/set` outbox rows; accepted writes shall be checkpointed before targeted cache reconciliation and shall never be replayed during cache repair. Existing email is immutable, `mayDelete` is enforced in UI and store, protected Identities omit the delete action and explain the server restriction, and every mutable RFC 8621 field is exposed. Stalwart validation responses shall be normalized at the JMAP boundary into stable field-specific outcomes while retaining diagnostic detail. See `specs/005-contact-details/spec.md` CT-4. |

## 5. Verification

| ID / Status | Requirement |
|:--|:--|
| CS-5.1 🟩 Done | Recipient delivery shall be covered end to end: To, Cc, and Bcc delivered to separate accounts, with Bcc absent from the delivered headers. |
| CS-5.2 🟩 Done | Reply behavior shall be covered with a Reply-To header, an original Cc, duplicate recipients, and several owned aliases, asserting `In-Reply-To` and `References` on the wire. |
| CS-5.3 🟩 Done | Autocomplete and recipient collection shall be covered with imports beyond one server page; first name, last name, reversed-token, organization, mixed-case, and accented matching; account-wide case/NFC/IDNA de-duplication; contact-only candidate provenance; rolling-window eviction and ranking; confirmed versus rejected sends; external-client Sent changes; deletion not undone by reconciliation; re-trust after a new send; and keyboard, screen-reader, paste, and rapid-typing behavior. |
| CS-5.4 🟩 Done | Every package that changes both server and cache state shall ship a Playwright specification asserting UI, local SQLite, and direct JMAP outcomes on Chromium and Firefox, per the constitution's Verified Consistency rule and `AGENTS.md`. `compose-reply-audience.spec.js` asserts the reply audience in the UI, the threading fields in the local Sent row, and the stored and delivered JMAP messages. |
| CS-5.5 🟩 Done | Send failure shall be covered by three distinct cases, because they have different correct outcomes. **Server-rejected** (a method-level error, or a rejection before submission): no delivery, no Sent copy, exactly one or zero Emails, the draft recoverable, and the failure surfaced. **Accepted but response lost**: exactly one delivery, and reconciliation resolving to success — a Sent copy here is correct, not a defect. **Genuinely ambiguous** (no evidence either way survives): at most one delivery, no automatic retry, and the durable no-automatic-retry record of CS-1.9 with its mailbox-based resolution rather than a plain Retry. A SharedWorker terminated and reloaded while its submission was in flight belongs to the third case, per CS-1.8: startup recovery conflicts it rather than resolving it from evidence. The second case covers a response lost to a worker that survives it. |
| CS-5.6 🟩 Done | Delivery shall be asserted against a second account, never against the sending account. On the pinned Stalwart v0.15.4 a self-addressed message is accepted for submission and never arrives (issue #77), so a self-delivery assertion would test the server's defect rather than this client. |
| CS-5.7 🟧 Planned | The RFC 5322/6532 address-list parser shall be tested against reusable upstream corpora from independent implementations and with differential fuzzing. Comparisons shall preserve intentional Stormbox semantics, including ordered rejected-fragment reporting and group flattening. This requirement applies only to email address parsing; it does not require fuzzing sending, synchronization, autocomplete, UI, or the outbox state machine. |
| CS-5.8 🟩 Done | Identity management shall be covered by component tests for the shared list/detail shell, every editable field, signature editor, protected deletion, defaults, and dirty navigation; protocol tests for sparse `Identity/set`, enumerated rejection outcomes, targeted cache read-back, and cache-only retry; and live Chromium/Firefox tests that assert UI, SQLite, direct JMAP, compose defaults, delivered From, stored Bcc/signature behavior, and permitted removal. |

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

- **Uncheckpointed compose recovery.** Server draft replacement, autosave,
  minimized compose sessions, and Close-versus-Discard semantics are defined
  by [draft-lifecycle.md](./draft-lifecycle.md). Restoring edits that never
  reached a durable draft checkpoint before every tab or worker closed remains
  outside both specifications.
- **Attachment reminders.** Received and compose attachment behavior is
  defined by [Attachment Support](../010-attachments/spec.md); reminder
  heuristics remain outside both specifications.
- **Undo Send and scheduled send.** Both depend on durable send state
  landing first. A client-local delay is not a durable scheduler once
  every tab closes; these need server-delayed submission with
  `maxDelayedSend`.
- **A user-visible Outbox folder and an offline send queue.**
- **Multiple Sent-copy targets**, equivalent to Thunderbird's Fcc2.
- **Distinct Mail and Submission primary accounts.** Stormbox requires the
  Session's `primaryAccounts` entries for `urn:ietf:params:jmap:mail` and
  `urn:ietf:params:jmap:submission` to identify the same account, as they
  do on Stalwart. Identity and EmailSubmission methods use the primary Mail
  account id; a server that advertises a separate Submission account is not
  supported.
- **Compose warnings** for empty subject or body, duplicate recipients,
  and large visible recipient lists.
- **Contact groups and organization-directory suggestion sources.**

## Open review follow-ups

These are the remaining actionable items from the compose reviews. They do
not change the requirement status overview above unless a requirement id is
named explicitly.

| ID | Priority | Follow-up |
|:--|:--|:--|
| S10 | Low — investigate | Determine whether an uncaught local database exception can reach the outbox runner's catch-all and be mislabeled as a `transport` failure. The review did not identify a concrete escaping call site. |
| P4 | Low — CS-2.3 | Reject an unpaired UTF-16 surrogate in an unquoted display-name atom without rejecting valid astral characters represented by a surrogate pair. |
| P5 | Low | Quote a display name such as `Alice B. Smith` when emitting it as a strict RFC 5322 phrase rather than relying on obsolete phrase syntax. |
| T1 | Medium — CS-1.1 | Add a live-Stalwart E2E case containing both supported and unsupported recipients, proving the explicit envelope rejects the submission atomically instead of delivering to only the supported subset. |
| T2 | Blocked — CS-5.5 | Terminate a real SharedWorker while `EmailSubmission/set` is in flight and verify startup recovery conflicts the row without replaying submission. The current harness can simulate the durable state but cannot terminate the worker. |
| T3 | Low — CS-4.2 | Test an out-of-order `AddressBook`/`ContactCard` StateChange and prove the unknown-book path withholds the contact sweep. |
| T5 | Low | Test a missing initial Email object state and a failed `needsFullSync` catch-up, including an external send arriving during snapshot paging. |
| T6 | Low — CS-2.3 | Add the parser regression cases for P4; quoted-string surrogate rejection is covered, but the unquoted-atom case is not. |
| T10 | Planned — CS-5.7 | Add reusable upstream address-parser corpora and differential fuzzing against independent implementations while preserving Stormbox's rejected-fragment and group-flattening semantics. |
