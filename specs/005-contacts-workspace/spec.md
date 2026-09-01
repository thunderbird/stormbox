# Contacts Workspace

This specification defines the Contacts workspace: contact and Identity
details, contact-list selection and AddressBook transfer, and AddressBook
management. The Stormbox constitution remains controlling.

Stormbox uses JSContact (RFC 9553) as its canonical contact representation and
JMAP Contacts (RFC 9610) as its synchronization protocol. vCard import,
export, RFC 9555 conversion, and user-facing JMAP group ContactCards are
outside this feature. Recoverable whole-card deletion is refined separately by
`specs/007-contacts-trash/spec.md`.

## Implementation records

- [Contact details plan](contact-details-plan.md) and
  [tasks](contact-details-tasks.md)
- [Contact list actions plan](contact-list-actions-plan.md) and
  [tasks](contact-list-actions-tasks.md)

## Status legend

- 🟩 **Done** — implemented and covered by the required tests.
- 🟨 **Partial** — implemented with the stated gap.
- 🟧 **Planned** — accepted scope, not yet implemented.

## Terminology

**All Contacts** is a union view, not an AddressBook. A **scoped delete** is a
Delete action issued while viewing one concrete AddressBook. A **move** removes
only the viewed source membership and adds one destination membership.

## Part I — Contact details and Identity editing

### CT-1 — Directory workspace

| ID / Status | Requirement |
|:--|:--|
| CT-1.1 🟩 Done | The Contacts space shall present an address-book rail, one shared virtualized directory list, and a third detail/editor column. Contact and Identity rows shall use the same list implementation and distinct detail panes inside one shared shell. |
| CT-1.2 🟩 Done | A contact row shall display a compact avatar, the contact name, and its first preferred email address. It shall not display organization, other detail fields, edit controls, or delete controls. A contact without an email address shall display “No email address.” |
| CT-1.3 🟩 Done | At desktop widths the three columns shall remain visible. At tablet widths the address-book rail shall become a compact horizontal control while list and detail remain side by side. Below 640 CSS pixels, the list and detail shall be mutually exclusive drill-in views with an accessible Back action; the inactive view shall be removed from keyboard and accessibility navigation. |
| CT-1.4 🟩 Done | Directory selection shall use stable contact/Identity keys rather than virtual indexes. Arrow keys, Home, End, pointer selection, filter changes, deletion, and asynchronous detail reads shall never select or render the wrong entry. |
| CT-1.5 🟩 Done | The detail column shall define empty, loading, viewing, creating, editing, validation-error, save-error, and delete-in-progress states. The contact view toolbar shall provide an icon-only Duplicate action that copies every surfaced field, the active photo, and address-book membership, appends the next available `(Copy N)` suffix to the display name, and selects the authoritative cache read-back. Other successful mutations shall likewise render the authoritative cache read-back rather than an assumed server result. |
| CT-1.6 🟩 Done | A dirty editor shall not be discarded by selecting another row, changing address book or directory type, leaving Contacts, or using mobile Back. The user shall receive themed Save, Discard, and Cancel choices. |
| CT-1.7 🟩 Done | No native `select` popup shall be used. Labels, date kinds, and work affiliations shall use Stormbox-themed dropdown controls per constitution principle IX. |

### CT-2 — Contact detail model

| ID / Status | Requirement |
|:--|:--|
| CT-2.1 🟩 Done | A contact editor shall support display name, repeated email addresses, repeated phone numbers, repeated websites, repeated dates, repeated notes, and repeated Work affiliations. A contact may have no email address, but an entirely empty ContactCard shall not be created. |
| CT-2.2 🟩 Done | Each repeated editor row shall carry the stable JSContact map key of an existing value or a client-generated key for a new value. Removing or inserting a middle row shall not reassign another row's key, DOM identity, focus, validation, or server property. |
| CT-2.3 🟩 Done | Email, phone, and website rows shall offer common preset labels plus Custom. Presets shall map to standard JSContact `contexts` or phone `features` where such semantics exist; Custom shall map to the explicit `label` property. Unedited `pref`, contexts, features, labels, and extension properties shall survive an edit. |
| CT-2.4 🟩 Done | Dates shall use JSContact `anniversaries` and only the standard `birth`, `wedding`, and `death` kinds. The kind supplies the displayed label. The editor shall accept only RFC 9553-valid partial dates or timestamps and shall not add a non-standard `label` property. |
| CT-2.5 🟩 Done | Notes shall use the keyed JSContact `notes` map and allow multiple unlabeled note entries. Existing note metadata and extensions that the editor does not expose shall be preserved. |
| CT-2.6 🟩 Done | A Work affiliation shall map one keyed `Organization` to its ordered department unit plus independently keyed `Title` entries of kinds `title` and `role` linked through `organizationId`. When several affiliations exist, a themed selector shall let the user view and edit one at a time without hiding or replacing the others. |
| CT-2.7 🟩 Done | Phone and website validation shall retain legal RFC values received from the server. Newly entered websites shall be absolute HTTP or HTTPS URLs, and newly entered phone values shall be non-empty dial strings serialized in the server-compatible JSContact form. |
| CT-2.8 🟩 Done | Recipient autocomplete shall remain email-address based. Removing organization from contact rows shall not remove organization, department, title, role, name, nickname, or email evidence required by existing contact search and autocomplete rules. Notes shall not be indexed for autocomplete. |
| CT-2.9 🟩 Done | Contact rows and detail views shall use the shared sender initials and color algorithm when no renderable photo is available. The read-only avatar shall be centered above the display name. The editor shall offer Upload/Replace and Remove controls above the name field and accept validated PNG, JPEG, GIF, or WebP images up to 1 MiB without cropping or rewriting them. |

### CT-3 — Contact synchronization and mutation

| ID / Status | Requirement |
|:--|:--|
| CT-3.1 🟩 Done | Authoritative ContactCard reads persisted to the cache shall retain the complete server object in `raw_json` and normalize all surfaced fields into protocol-neutral local rows. The database layer shall neither parse nor construct JMAP or JSContact protocol objects. |
| CT-3.2 🟩 Done | Contact email, phone, website, anniversary, note, organization, unit, title, and media rows shall retain their JSContact map keys. Local presentation position is not protocol ordering and shall not be written as one. |
| CT-3.3 🟩 Done | Every newly created card shall carry a durable RFC 9553 `uid`, generated once before its outbox row is queued. Recovery from an ambiguous create shall search by that UID before any repeat create is permitted. |
| CT-3.4 🟩 Done | Contact edits shall use sparse, stable-key patches against a fresh authoritative card. Only values represented and changed by the editor may be altered or removed; concurrent additions, unsupported fields, unknown extensions, and unedited metadata shall survive. |
| CT-3.5 🟩 Done | A confirmed ContactCard write shall checkpoint before targeted server read-back. Cache-repair retries shall not repeat an accepted server write, and mutation success shall require server and local cache agreement. |
| CT-3.6 🟩 Done | Migration 009 shall install the keyed detail schema and then invalidate the disposable server-backed contact cache by removing cached contacts and every normalized contact detail, membership, and search-token row. It shall preserve AddressBooks, pending contact and Identity outbox mutations, and independent rebuildable recipient history. The next authoritative JMAP synchronization shall rebuild contacts. Runtime normalization shall remain tolerant of legacy flat-array server responses; local cached contact rows shall not be migrated forward. |
| CT-3.7 🟩 Done | Migration 014 shall normalize JSContact `media` while retaining the complete card in `raw_json`. The preferred `kind: "photo"` entry shall be selected by `pref` and position. Stalwart v0.15.4 rejects ContactCard media `blobId`, so new photos shall use a validated raster `data:` URI. Arbitrary remote media URIs and malformed raster data shall never be fetched or rendered automatically. Photo replace/remove shall patch only its stable media key and preserve concurrent or unsupported entries. |

### CT-4 — Identity detail and mutation

| ID / Status | Requirement |
|:--|:--|
| CT-4.1 🟩 Done | Manage identities shall use the same directory list and third-column shell as contacts. The Identity pane shall expose name, email, Reply-To, Bcc, signature, an icon-only Duplicate action, and a right-aligned Set as Primary action. Duplicate shall copy every mutable Identity value, append the next available `(Copy N)` suffix to the display name, and select the authoritative cache read-back. The Primary action shall be disabled for the current Primary Identity, and the directory row shall show a Primary badge before its name and email. Existing email and server-set `id`/`mayDelete` are read-only; email is editable only during create. |
| CT-4.2 🟩 Done | Reply-To and Bcc shall preserve ordered RFC 8621 EmailAddress values, including nullable display names. The editor shall allow multiple entries, validate each address, and preserve `null` versus unchanged empty values through sparse updates. |
| CT-4.3 🟩 Done | Identity HTML and plain-text signatures shall be two representations emitted by the single shared Squire editor. Existing HTML initializes the editor; a text-only signature is converted to safe equivalent HTML. User edits shall update both representations together. |
| CT-4.4 🟩 Done | The signature editor shall support raster data-URL images through the same rich-editor implementation used by compose. Before `Identity/set`, HTML shall be sanitized and the UTF-8 length of each signature shall be less than Stalwart v0.15.4's 2,048-byte limit. Oversize content shall remain editable and receive an actionable field error rather than a generic save failure. |
| CT-4.5 🟩 Done | Identity creates and updates shall send only mutable fields the user supplied or changed. Update shall never send `email`, `id`, or `mayDelete`. Delete shall be rejected in both UI and store unless `mayDelete` is true. The delete action shall not be rendered for a protected Identity, and its detail view shall state “The mail server doesn't allow this identity to be deleted.” |
| CT-4.6 🟩 Done | Identity action failures shall retain stable enumerated outcomes and identify invalid Reply-To, Bcc, signature, permission, immutable property, address-not-allowed, cache-repair, connectivity, and unknown failures where the server response permits. |
| CT-4.7 🟩 Done | Post-write Identity reconciliation shall target the confirmed Identity id. A create/update shall get and upsert that id; a confirmed delete shall remove that exact local row. A partial or truncated all-Identity response shall not erase unrelated cached identities. |
| CT-4.8 🟩 Done | Identity create shall record an authoritative baseline and durable submitting phase before `Identity/set`. A lost response shall never replay create automatically: a complete Identity snapshot may recover exactly one new field-matching identity, while no match, multiple matches, or an incomplete snapshot remains an explicit resolvable ambiguous outcome. |

### CT-5 — Shared rich-text editor and compose defaults

| ID / Status | Requirement |
|:--|:--|
| CT-5.1 🟩 Done | Stormbox shall have one Squire integration for every rich-text editing surface. Compose and Identity signatures shall reuse the same component for initialization, sanitization, toolbar state, commands, keyboard shortcuts, selection, undo/redo, image insertion, image resizing, responsive toolbar overflow, HTML serialization, and plain-text derivation. |
| CT-5.2 🟩 Done | Extracting the shared editor shall not change compose session switching, minimized editor persistence, focus trapping, inline-image behavior, draft dirtiness, autosave, or send serialization. |
| CT-5.3 🟩 Done | New and forward sessions shall default to the client-selected Primary Identity. With no valid selection, the first server-protected Identity shall be Primary, falling back to the first Identity. A reply shall instead use the first Identity matching the original message's To addresses and fall back to Primary. New, reply, and forward sessions shall apply that Identity's Reply-To, Bcc, HTML signature, and text signature before the initial clean seed is captured. Replies and forwards shall place the signature before quoted content. Merely opening a prefilled session shall not schedule autosave. |
| CT-5.4 🟩 Done | Compose shall track automatic Bcc and signature provenance only in the live session. Changing From shall replace an automatic value only while that value remains intact; manually edited, removed, or added Bcc recipients and body content shall be preserved and shall not be duplicated. |
| CT-5.5 🟩 Done | Reopened server drafts shall never infer automatic-value provenance or receive Identity defaults, including when the user resolves an unavailable From address. Saved or sent HTML shall not contain Stormbox's internal provenance marker. |
| CT-5.6 🟩 Done | Data-URL images originating in a signature shall enter the existing compose inline-image pipeline and be uploaded and rewritten to resolvable `cid:` parts in saved drafts and sent messages. Identity signature storage itself shall retain the bounded data URL. |

### CT-6 — Verification and review

| ID / Status | Requirement |
|:--|:--|
| CT-6.1 🟩 Done | Unit tests shall cover migrations, complete normalization, contact-photo validation and preference, stable map keys, strict dates, label mapping, multiple affiliations, unknown-field preservation, sparse patch construction, UID create recovery, Identity fields and limits, editor reuse, compose provenance, and every responsive/accessibility state. |
| CT-6.2 🟩 Done | Contact and Identity live tests shall assert the user-visible UI, local SQLite through `window.__repo`, and direct JMAP state in Chromium and Firefox. Signature compose tests shall additionally assert externally stored marker-free bodies and resolvable inline images. |
| CT-6.3 🟧 Planned | The virtualized list shall remain responsive with 10,000 candidates and filtering shall retain the existing 5,000-contact autocomplete performance budget. Selecting or editing detail shall not trigger full-list DOM rendering or scroll-position oscillation. |
| CT-6.4 🟩 Done | After implementation verification, Fable 5 shall perform a browser-first UI/UX review and code review. Independently reproduced high-confidence findings may be fixed with regressions and shall be recorded in the review canvas. |
| CT-6.5 🟩 Done | After Fable fixes, one immutable snapshot shall be reviewed independently by Grok 4.6, GPT 5.6 Sol, and Opus 5 for conciseness, protocol correctness, architecture, performance, and test quality. Retained findings shall be proven in a disposable copy where possible, recorded in a separate canvas tab, and not fixed in the active tree without explicit user approval. |

## Part II — Contact list actions

Contact creation, editing, and Identity management remain governed by Part I.
List actions must preserve the sparse-write and reconciliation guarantees in
CT-3.4 through CT-3.5.

### CL-1 — Shared selection behavior

| ID / Status | Requirement |
|:--|:--|
| CL-1.1 🟩 Done | Contact rows shall support checkbox, modifier-click, anchored Shift-range, Shift+Arrow, Space, Escape, and Ctrl/Cmd+A selection using stable contact ids. The viewed contact, keyboard cursor, and bulk-selection set shall remain separate states. |
| CL-1.2 🟩 Done | A plain row click shall clear bulk selection and open that contact. While bulk selection is non-empty, the detail pane shall be removed and the contact list shall fill the available column, matching the message-list interaction. |
| CL-1.3 🟩 Done | The shared selection algorithm and select-all/selection-count header chrome shall be reused by MessageList and the contact directory without sharing message rows, sparse mail loading, filters, or conversation-specific behavior. |
| CL-1.4 🟩 Done | Identities shall remain single-select and shall expose no bulk checkboxes, bulk actions, drag source, or drop target. Switching scope, directory kind, or filter shall clear hidden contact selection. |
| CL-1.5 🟩 Done | Starting bulk selection while a contact editor is dirty shall use the existing Save, Discard, and Cancel navigation guard before the detail pane can be hidden. |
| CL-1.6 🟩 Done | Contact listbox semantics shall expose a stable active descendant, multi-selection state, selected option state, selection count announcements, and keyboard-equivalent actions. Selection controls shall remain visible and usable without hover on touch layouts. |

### CL-2 — Scope-aware deletion

| ID / Status | Requirement |
|:--|:--|
| CL-2.1 🟩 Done | Delete from All Contacts shall move every selected ContactCard into the separate synced Contacts Trash before destroying it. Because the operation is recoverable for 30 days, it shall run without a confirmation dialog. |
| CL-2.2 🟩 Done | A scoped delete shall remove only the viewed AddressBook membership when a card has another membership. If the viewed book is the card's final membership, the operation shall move the card into Contacts Trash before destroying it, as RFC 9610 forbids a surviving card with no AddressBook. |
| CL-2.3 🟩 Done | A scoped operation that only moves contacts to Trash shall run without confirmation. A scoped confirmation that includes membership-only removal shall distinguish that removal from final-membership trashing. It may additionally show the current removal and trash counts, but concurrent changes shall never make execution more destructive than the confirmed rule. |
| CL-2.4 🟩 Done | The existing detail-pane Delete action shall use the same plural-capable path with one contact. N=1 and N>1 shall not have different mutation semantics. |
| CL-2.5 🟩 Done | Before dispatch, the complete requested set shall pass local account, membership, and `AddressBook.myRights.mayWrite` checks. Unknown or false rights shall fail closed. Per-object server failures after dispatch shall retain failed contacts selected and report the partial outcome. |

### CL-3 — Move between AddressBooks

| ID / Status | Requirement |
|:--|:--|
| CL-3.1 🟩 Done | Drag shall start only from a concrete AddressBook. Dragging from All Contacts or Identities shall be disabled. Dragging a checked row shall move the checked set; dragging an unchecked row shall move only that row. |
| CL-3.2 🟩 Done | Concrete writable AddressBooks other than the viewed source shall be drop targets. All Contacts, Manage Identities, the source book, deleted books, cross-account books, and books without confirmed `mayWrite` shall reject the drop and expose no misleading move effect. |
| CL-3.3 🟩 Done | A move shall atomically patch the destination membership to `true` and the viewed source membership to `null` on each card while preserving every other membership and every contact field. No Copy operation or modifier-copy behavior shall be exposed. |
| CL-3.4 🟩 Done | The bulk toolbar shall provide a themed Move to address book menu with the same target eligibility as drag/drop, so keyboard and touch users can perform every move. |
| CL-3.5 🟩 Done | A successful move shall disappear from the source list, appear in the destination list, retain All Contacts visibility, reconcile the open detail deliberately, and complete only after the authoritative server state is present in the local cache. |

### CL-4 — Rights, durability, and reconciliation

| ID / Status | Requirement |
|:--|:--|
| CL-4.1 🟩 Done | AddressBook sync shall persist a protocol-neutral nullable write-right projection. Only an explicit `mayWrite: true` grants contact modification; omitted, malformed, false, stale, or cross-service rights deny it. |
| CL-4.2 🟩 Done | UI actions shall queue one discriminated local-id-only contact batch mutation. Existing queued legacy single-contact mutations shall remain dispatchable, while all new single and bulk deletes use the plural path. |
| CL-4.3 🟩 Done | The JMAP backend shall resolve local ids, fetch fresh ContactCards and AddressBooks, revalidate rights, checkpoint whole-card snapshots in bounded `stormbox-contacts-trash-<random-uuid>.json` shards, and issue sparse `ContactCard/set` updates/destroys in bounded groups. Every destroyed card shall have a confirmed remote snapshot, and each confirmed group shall be reconciled before staging a later shard group. |
| CL-4.4 🟩 Done | Membership writes shall include `ifInState`. A state mismatch shall refetch and rebuild unresolved sparse patches; a full reconstructed `addressBookIds` map shall never overwrite concurrent memberships. |
| CL-4.5 🟩 Done | Every accepted server chunk shall checkpoint updated and destroyed ids before cache repair. Retry shall repeat only unresolved server work; accepted writes shall receive targeted read-back or local destroy repair without replay. |
| CL-4.6 🟩 Done | Cache updates and destroys shall be applied in batched SQL and produce one coalesced Contacts repaint. Mutation results shall retain per-contact successes and terminal failures through the outbox, Repository, store, and UI. |

### CL-5 — Verification

| ID / Status | Requirement |
|:--|:--|
| CL-5.1 🟩 Done | Unit tests shall cover keyed shared selection, header reuse, grouped drag payloads, invalid targets, dirty-editor guards, scope-aware confirmation, rights, sparse membership patches, final-membership destruction, server limits, rebasing, partial results, checkpoints, and cache apply. |
| CL-5.2 🟩 Done | Chromium and Firefox tests shall verify the user-visible UI, local SQLite through `window.__repo`, and direct JMAP state for multi-select move, scoped mixed removal/destruction, and All Contacts permanent deletion. |
| CL-5.3 🟩 Done | The 10,000-row virtualized contact list shall remain bounded, keyboard navigation shall keep its active row in view, and selection/move/delete shall not mount the full list or cause scroll oscillation. |

## Part III — AddressBook management

AddressBook deletion is permanent server-side management and remains distinct
from the recoverable ContactCard deletion workflow in Contacts Trash.

### AB-1 — Contacts workspace

| ID / Status | Requirement |
|:--|:--|
| AB-1.1 🟩 Done | The address-book rail shall place an icon-only Create address book action immediately left of New Contact. Only an explicit account capability `mayCreateAddressBook: true` shall enable it. |
| AB-1.2 🟩 Done | Each book shall keep its server name. The default book shall carry a `Personal` badge. |
| AB-1.3 🟩 Done | A concrete book shall center its name in the contact-list header and show icon-only Edit address book and Delete address book actions immediately after the selection checkbox. Bulk selection, All Contacts, Trash, and Identities shall hide these actions. |
| AB-1.4 🟩 Done | Create and Edit shall share the existing third-column shell and provide name, description, and default controls with dirty-navigation guards, mobile Back, validation, authoritative save errors, and focus restoration. Opening book metadata shall preserve the selected contact. |

### AB-2 — Rights, writes, and recovery

| ID / Status | Requirement |
|:--|:--|
| AB-2.1 🟩 Done | AddressBook sync shall persist `sortOrder`, `isDefault`, `isSubscribed`, and nullable `mayWrite` and `mayDelete` projections. Missing or malformed rights shall deny the corresponding action. |
| AB-2.2 🟩 Done | Create and sparse update shall use durable outbox mutations. `isDefault` shall never be patched; default changes shall use `onSuccessSetIsDefault`. |
| AB-2.3 🟩 Done | Create shall checkpoint a complete pre-create snapshot before `AddressBook/set`. A lost response shall recover only when exactly one new AddressBook matches the requested fields; otherwise the mutation shall stop as ambiguous without replaying create. |
| AB-2.4 🟩 Done | Every accepted create or update shall complete only after a full authoritative `AddressBook/get` has repaired SQLite. |

### AB-3 — Permanent deletion

| ID / Status | Requirement |
|:--|:--|
| AB-3.1 🟩 Done | Delete shall be disabled without explicit `mayDelete`, for Trusted Senders, and for the final non-Trusted-Senders book. Deleting the default book is allowed when another eligible book remains, and the warning shall state that the server chooses its replacement. |
| AB-3.2 🟩 Done | Before confirmation, the client shall page an authoritative `ContactCard/query { inAddressBook }` inventory and classify contacts as exclusive or shared. The dialog shall state which contacts will be destroyed permanently and which will only lose one membership. |
| AB-3.3 🟩 Done | The durable destroy mutation shall re-inventory immediately before dispatch. Any more-destructive result shall require confirmation again. Only this confirmed path shall send `onDestroyRemoveContents: true`. |
| AB-3.4 🟩 Done | A lost destroy response shall verify whether the AddressBook still exists before replay. An accepted or verified destroy shall complete only after authoritative AddressBook and ContactCard synchronization retires the book, removes exclusive contacts, and updates shared memberships. |
| AB-3.5 🟩 Done | AddressBook deletion is irreversible and shall not create Contacts Trash rows, FileNodes, tombstones, or restore actions. |

### AB-4 — Verification

| ID / Status | Requirement |
|:--|:--|
| AB-4.1 🟩 Done | Unit coverage shall pin capability and rights gates, create recovery, sparse/default writes, inventory stability, destructive escalation, response-loss recovery, cache repair, workspace controls, dirty guards, and warning copy. |
| AB-4.2 🟩 Done | Focused live coverage shall verify one metadata/default round trip and one mixed exclusive/shared permanent deletion without repeating the unit failure matrix. |
| AB-4.3 🟩 Done | Chromium shall exercise the complete management flow. Firefox shall retain one smoke flow for the critical workspace controls and resulting list state. |
