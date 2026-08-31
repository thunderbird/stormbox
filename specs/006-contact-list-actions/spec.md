# Contact List Bulk Actions

This specification defines contact-only multi-selection, scope-aware deletion,
and move-only transfer between JMAP AddressBooks. The Stormbox constitution
remains controlling.

## Status legend

- 🟩 **Done** — implemented and covered by the required tests.
- 🟨 **Partial** — implemented with the stated gap.
- 🟧 **Planned** — accepted scope, not yet implemented.

## Scope and terminology

JMAP Contacts (RFC 9610) models `ContactCard.addressBookIds` as a set. Stormbox
shall preserve every server-provided membership, including memberships used by
Trusted Senders, but shall not expose Copy as a contact-list operation.
User-facing Contact Groups are separate JMAP group ContactCards and are outside
this feature.

**All Contacts** is a union view, not an AddressBook. A **scoped delete** is a
Delete action issued while viewing one concrete AddressBook. A **move** removes
only the viewed source membership and adds one destination membership.

## CL-1 — Shared selection behavior

| ID / Status | Requirement |
|:--|:--|
| CL-1.1 🟩 Done | Contact rows shall support checkbox, modifier-click, anchored Shift-range, Shift+Arrow, Space, Escape, and Ctrl/Cmd+A selection using stable contact ids. The viewed contact, keyboard cursor, and bulk-selection set shall remain separate states. |
| CL-1.2 🟩 Done | A plain row click shall clear bulk selection and open that contact. While bulk selection is non-empty, the detail pane shall be removed and the contact list shall fill the available column, matching the message-list interaction. |
| CL-1.3 🟩 Done | The shared selection algorithm and select-all/selection-count header chrome shall be reused by MessageList and the contact directory without sharing message rows, sparse mail loading, filters, or conversation-specific behavior. |
| CL-1.4 🟩 Done | Identities shall remain single-select and shall expose no bulk checkboxes, bulk actions, drag source, or drop target. Switching scope, directory kind, or filter shall clear hidden contact selection. |
| CL-1.5 🟩 Done | Starting bulk selection while a contact editor is dirty shall use the existing Save, Discard, and Cancel navigation guard before the detail pane can be hidden. |
| CL-1.6 🟩 Done | Contact listbox semantics shall expose a stable active descendant, multi-selection state, selected option state, selection count announcements, and keyboard-equivalent actions. Selection controls shall remain visible and usable without hover on touch layouts. |

## CL-2 — Scope-aware deletion

| ID / Status | Requirement |
|:--|:--|
| CL-2.1 🟩 Done | Delete from All Contacts shall move every selected ContactCard into the separate synced Contacts Trash before destroying it. Because the operation is recoverable for 30 days, it shall run without a confirmation dialog. |
| CL-2.2 🟩 Done | A scoped delete shall remove only the viewed AddressBook membership when a card has another membership. If the viewed book is the card's final membership, the operation shall move the card into Contacts Trash before destroying it, as RFC 9610 forbids a surviving card with no AddressBook. |
| CL-2.3 🟩 Done | A scoped operation that only moves contacts to Trash shall run without confirmation. A scoped confirmation that includes membership-only removal shall distinguish that removal from final-membership trashing. It may additionally show the current removal and trash counts, but concurrent changes shall never make execution more destructive than the confirmed rule. |
| CL-2.4 🟩 Done | The existing detail-pane Delete action shall use the same plural-capable path with one contact. N=1 and N>1 shall not have different mutation semantics. |
| CL-2.5 🟩 Done | Before dispatch, the complete requested set shall pass local account, membership, and `AddressBook.myRights.mayWrite` checks. Unknown or false rights shall fail closed. Per-object server failures after dispatch shall retain failed contacts selected and report the partial outcome. |

## CL-3 — Move between AddressBooks

| ID / Status | Requirement |
|:--|:--|
| CL-3.1 🟩 Done | Drag shall start only from a concrete AddressBook. Dragging from All Contacts or Identities shall be disabled. Dragging a checked row shall move the checked set; dragging an unchecked row shall move only that row. |
| CL-3.2 🟩 Done | Concrete writable AddressBooks other than the viewed source shall be drop targets. All Contacts, Manage Identities, the source book, deleted books, cross-account books, and books without confirmed `mayWrite` shall reject the drop and expose no misleading move effect. |
| CL-3.3 🟩 Done | A move shall atomically patch the destination membership to `true` and the viewed source membership to `null` on each card while preserving every other membership and every contact field. No Copy operation or modifier-copy behavior shall be exposed. |
| CL-3.4 🟩 Done | The bulk toolbar shall provide a themed Move to address book menu with the same target eligibility as drag/drop, so keyboard and touch users can perform every move. |
| CL-3.5 🟩 Done | A successful move shall disappear from the source list, appear in the destination list, retain All Contacts visibility, reconcile the open detail deliberately, and complete only after the authoritative server state is present in the local cache. |

## CL-4 — Rights, durability, and reconciliation

| ID / Status | Requirement |
|:--|:--|
| CL-4.1 🟩 Done | AddressBook sync shall persist a protocol-neutral nullable write-right projection. Only an explicit `mayWrite: true` grants contact modification; omitted, malformed, false, stale, or cross-service rights deny it. |
| CL-4.2 🟩 Done | UI actions shall queue one discriminated local-id-only contact batch mutation. Existing queued legacy single-contact mutations shall remain dispatchable, while all new single and bulk deletes use the plural path. |
| CL-4.3 🟩 Done | The JMAP backend shall resolve local ids, fetch fresh ContactCards and AddressBooks, revalidate rights, checkpoint whole-card snapshots in bounded `stormbox-contacts-trash-<random-uuid>.json` shards, and issue sparse `ContactCard/set` updates/destroys in bounded groups. Every destroyed card shall have a confirmed remote snapshot, and each confirmed group shall be reconciled before staging a later shard group. |
| CL-4.4 🟩 Done | Membership writes shall include `ifInState`. A state mismatch shall refetch and rebuild unresolved sparse patches; a full reconstructed `addressBookIds` map shall never overwrite concurrent memberships. |
| CL-4.5 🟩 Done | Every accepted server chunk shall checkpoint updated and destroyed ids before cache repair. Retry shall repeat only unresolved server work; accepted writes shall receive targeted read-back or local destroy repair without replay. |
| CL-4.6 🟩 Done | Cache updates and destroys shall be applied in batched SQL and produce one coalesced Contacts repaint. Mutation results shall retain per-contact successes and terminal failures through the outbox, Repository, store, and UI. |

## CL-5 — Verification

| ID / Status | Requirement |
|:--|:--|
| CL-5.1 🟩 Done | Unit tests shall cover keyed shared selection, header reuse, grouped drag payloads, invalid targets, dirty-editor guards, scope-aware confirmation, rights, sparse membership patches, final-membership destruction, server limits, rebasing, partial results, checkpoints, and cache apply. |
| CL-5.2 🟩 Done | Chromium and Firefox tests shall verify the user-visible UI, local SQLite through `window.__repo`, and direct JMAP state for multi-select move, scoped mixed removal/destruction, and All Contacts permanent deletion. |
| CL-5.3 🟩 Done | The 10,000-row virtualized contact list shall remain bounded, keyboard navigation shall keep its active row in view, and selection/move/delete shall not mount the full list or cause scroll oscillation. |
