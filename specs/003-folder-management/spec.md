# Folder Management and Folder UX — Product and Engineering Specification

This specification defines Stormbox's folder model, folder-tree
presentation, shared-folder behavior, subscription management, folder
creation/editing/deletion, folder favorites, and large-folder-tree
constraints.

It refines the folder requirements in `specs/001-mvp-scope/spec.md`,
especially R-2.1 and R-2.13, and the message-to-folder drag behavior in
R-3.5. The architectural invariants in
`.specify/memory/constitution.md` remain controlling: the UI is
cache-first, the server is authoritative, protocol mutations use the
outbox, and successful mutations update the local cache before their
RPC resolves.

**Implementation scope**: Vue 3 + Pinia, browser-local SQLite, JMAP
Mail against Stalwart, including JMAP shared accounts.

## Status legend

- 🟩 **Implemented** — the described behavior is present in the
  folder-management work. Verification depth is listed separately.
- 🟨 **Partial** — useful behavior is implemented, but a known product,
  protocol, batching, accessibility, or verification gap remains.
- 🟥 **Upstream blocked** — the intended behavior is specified by JMAP,
  but the reference server currently prevents it.

## Status overview

| Area | 🟩 Implemented | 🟨 Partial | 🟥 Upstream blocked |
|:--|--:|--:|--:|
| Discovery, storage, and synchronization | 8 | 2 | — |
| Sidebar hierarchy and presentation | 11 | 0 | — |
| Favorites | 6 | 0 | — |
| Manage Folders dialog shell | 7 | 3 | — |
| Manager row layout and visual rules | 5 | 1 | — |
| Subscription behavior | 7 | 2 | 1 |
| Creation, rename, move, and deletion | 8 | 2 | — |
| Selection and bulk actions | 6 | 4 | — |
| Mutation, cache, and error invariants | 3 | 3 | — |
| **Total** | **61** | **17** | **1** |

## Terminology and model

### Folder

Stormbox calls a JMAP `Mailbox` a **folder** in user-facing copy. The
word describes the tree UI; it does not imply one-folder-only message
membership.

A JMAP `Email` may belong to multiple Mailboxes through its
`mailboxIds` set. Stormbox therefore models membership as the
many-to-many `folder_messages(folder_id, message_id)` junction. A
folder can consequently behave like a traditional folder or a label,
and deleting a folder must preserve a message that remains filed in
another folder.

### Account kinds

- The **primary account** is the signed-in user's primary JMAP Mail
  account.
- A **shared account** is another mail-capable account advertised in
  the JMAP Session, generally with `isPersonal: false`, whose data was
  shared with the signed-in user.
- A **system folder** is a role-bearing folder in the primary account
  (for example Inbox, Drafts, Sent, Archive, Junk, or Trash).
- A **user folder** is a folder without a JMAP role.

Primary and shared JMAP accounts here are data scopes inside one
authenticated session; supporting them does not create a multi-login
or unified-account product.

### Subscription

`Mailbox.isSubscribed` is server-owned, per-user state. RFC 8621 says
it “MUST be stored separately per user where multiple users have access
to a shared Mailbox” and maps it to IMAP mailbox subscriptions. It is
not a Stormbox-local “show in this sidebar” preference.

Stormbox may omit unsubscribed folders from its sidebar, but the Manage
Folders dialog must continue to expose them. A future local show/hide
preference, if added, must be a separate property and control.

### Favorite

A **favorite** is a client-local Stormbox priority pin stored as
`folders.is_starred`. It is deliberately separate from
`Mailbox.isSubscribed` and JMAP `Mailbox.sortOrder`.

## Product principles

1. **The sidebar is a reading surface; Manage Folders is the complete
   management surface.** The sidebar shows role folders, subscribed
   folders, favorites, and shared sections. Manage Folders shows the
   complete discovered hierarchy and all permitted operations.
2. **Structural order and priority presentation are separate.** The
   manager and parent pickers remain in stable tree order while the
   sidebar may promote favorites. Toggling a star must never move the
   row under the pointer in Manage Folders.
3. **System folders are protected.** Primary role folders stay visible
   and cannot be subscribed/unsubscribed, selected for deletion,
   starred, renamed, moved, or deleted through the manager.
4. **Permissions are visible, not guessed away.** Shared-folder
   operations are derived from `myRights`. Unavailable actions are
   omitted or disabled and explained.
5. **Large trees are normal input.** Discovery, rendering, searching,
   selection, and mutations must not assume a few dozen folders.
6. **A hierarchy remains reachable after filtering.** If a visible
   subscribed or favorite folder's parent is omitted, that folder is
   promoted to a visible root rather than disappearing with its parent.
7. **Copy describes protocol semantics.** Subscription controls say
   “Subscribe”/“Subscribed”, not “Show”, “Visible”, or an eye metaphor.

## Requirements

### 1. Discovery, storage, and synchronization

| ID / Status | Requirement |
|:--|:--|
| FM-1.1 🟨 Partial | The current JMAP Session shall be the sole authority for which account scopes Stormbox renders for the active user. During ingest, the system shall upsert its primary Mail account and every other mail-capable account in `session.accounts`, persist `isPersonal`, mark only the current primary account as primary, distinguish non-primary personal accounts from shared scopes, and remove or deactivate a previously cached shared scope after the server removes it from that user's Session. This is local cache hygiene only; Stormbox cannot change which accounts the server advertises. Ingestion exists, but `refreshFolders()` currently also loads SQLite account rows merely because they share the same server origin. |
| FM-1.2 🟩 Implemented | The system shall sync each shared account's Mailboxes over the primary backend and transport, register each shared local account id for folder-scoped sync, and remove all primary/shared registrations when that backend stops. Failure to sync one shared account shall not block the primary account. |
| FM-1.3 🟩 Implemented | Archive repair shall run only for the primary account. The system shall not create, re-role, or repair Archive in a shared account. |
| FM-1.4 🟩 Implemented | Role lookups for archive, junk, Trash, and related message actions shall use the message's owning account. Primary messages shall use only primary role folders; shared messages shall use role folders in that shared account when advertised and permitted. Missing shared role targets shall disable/fail the action clearly, and Archive repair shall remain primary-only. |
| FM-1.5 🟩 Implemented | `Mailbox/get` shall request `id`, `name`, `parentId`, `role`, `sortOrder`, counts, `myRights`, and `isSubscribed`, then persist hot fields plus the raw response. `NULL is_subscribed` means the server has not reported the property, not “unsubscribed.” |
| FM-1.6 🟩 Implemented | A full Mailbox sync shall not trust an unpaged `Mailbox/get` when the result reaches `maxObjectsInGet`. It shall collect the complete id set with paged `Mailbox/query`, fetch missing Mailboxes in chunks no larger than the advertised cap (falling back to 500), and persist the complete hierarchy. |
| FM-1.7 🟩 Implemented | A full Mailbox sync shall be authoritative. A live local folder row absent from the complete server response shall be soft-deleted so stale rows cannot remain actionable or produce `notUpdated` mutations. |
| FM-1.8 🟩 Implemented | Incremental Mailbox sync shall follow `Mailbox/changes.hasMoreChanges`, carry each `newState` into the next call, combine and de-duplicate created/updated ids, chunk follow-up `Mailbox/get` calls, and persist the terminal state only after all pages apply. After 20 pages it shall fall back to a full sync rather than treating a partial delta as current. |
| FM-1.9 🟨 Partial | With at least 1,267 user folders, at least 100 top-level roots, and nesting up to eight levels, sync shall return the complete hierarchy; the collapsed sidebar shall mount only visible branches; Manage Folders shall mount only its virtualized window plus overscan; and search, expansion, selection, and subscription controls shall remain interactive without mounting the complete list. This scenario has been exercised manually and sync paging has unit coverage, but an automated browser benchmark and explicit latency/memory budgets remain to be defined. |
| FM-1.10 🟩 Implemented | Reconnect and push reconciliation shall keep an open shared-folder message window current, including shared-account `Email` and `EmailDelivery` changes. Active-view refresh, query/full-sync fallback, newly-added-id lookup, and body prefetch shall all receive the owning account and its account-scoped state tokens. A shared account without an `Email/changes` baseline reconciles bounded active views without inventing an account-wide state. |

### 2. Sidebar hierarchy and presentation

| ID / Status | Requirement |
|:--|:--|
| FM-2.1 🟩 Implemented | The sidebar shall render primary role folders first in fixed role order: Inbox, Drafts, Sent, Archive, Junk, then Trash. It shall render the remaining primary folders beneath a `Folders` heading. Folder and account headings shall use normal capitalization, never forced all-caps. |
| FM-2.2 🟩 Implemented | The `Folders` heading row shall always render and shall contain a 24×24 icon-only settings button aligned at the right. Its accessible label and tooltip shall be exactly `Manage Folders`. The action shall stay reachable independently of the length of the user-folder list. |
| FM-2.3 🟩 Implemented | Primary role folders shall always appear. A primary user folder shall appear unless `is_subscribed` is explicitly `0`; `NULL` shall remain visible for backward compatibility. A shared folder shall appear only when `is_subscribed` is explicitly `1`. |
| FM-2.4 🟩 Implemented | A visible folder whose parent is absent from the rendered set shall be promoted to the root of the relevant rendered group. This applies to subscribed children of unsubscribed parents and to favorites promoted out of their structural parents. |
| FM-2.5 🟩 Implemented | Unstarred subscribed shared folders shall render in a section labeled with their owning account. A shared section with no remaining visible folders shall not render. |
| FM-2.6 🟩 Implemented | The hierarchy shall start fully collapsed. Each branch shall retain independent expanded state for the current component lifetime. Expanding/collapsing shall not select a folder, and selecting a folder shall not alter expansion. |
| FM-2.7 🟩 Implemented | A collapsed folder's unread badge shall sum its own unread count and the counts of its hidden subtree. An expanded folder shall show only its own unread count while visible descendants show theirs. |
| FM-2.8 🟩 Implemented | A folder that has children shall have a separate disclosure button with `aria-expanded`; a leaf shall reserve the same alignment space without exposing a no-op button. The disclosure icon, folder icon, name, progress, and unread columns shall remain vertically aligned. |
| FM-2.9 🟩 Implemented | Sidebar rows shall use 4 px vertical folder-button padding with a 1 px list gap. A favorite marker shall overlap the lower-left corner of the folder icon so starred and unstarred rows use identical icon/name columns. |
| FM-2.10 🟩 Implemented | A message drag over a folder shall show distinct valid/invalid drop treatment. Within one JMAP account, the drop shall move the batched selection with one `Email/set` mailbox-membership update. Across account scopes — including personal-to-shared and shared-to-personal — it shall copy with standard `Email/copy`: `fromAccountId`, destination `accountId`, a creation map containing each source Email id and destination `mailboxIds`, and `onSuccessDestroyOriginal: false`. Omitted properties inherit their current source values, so Stormbox shall not overwrite `keywords` or `receivedAt` from stale local data. Copy results shall map creation ids to new destination Email ids, apply successful copies to destination cache/views before resolving, preserve sources, reconcile `alreadyExists`, report per-id failures, respect `maxObjectsInSet`, indicate copy versus move, and enforce source-read/destination-add rights. |
| FM-2.11 🟩 Implemented | Every message action performed while viewing a shared folder — read/unread, keyword changes, delete, archive, junk, move, copy, and refresh — shall resolve the message's owning JMAP account and issue/apply the operation in that scope. Pending rows shall remain queued under the primary local account whose single `OutboxRunner` drains the session, while payloads and typed handlers carry/group the true data-owning account. |

### 3. Favorites

| ID / Status | Requirement |
|:--|:--|
| FM-3.1 🟩 Implemented | Any non-system folder, including a shared folder, may be starred. Star state shall be stored only in local SQLite, applied optimistically, preserved across Mailbox sync upserts, and broadcast to other tabs using the same local database. |
| FM-3.2 🟩 Implemented | The system shall not encode favorites through JMAP `sortOrder`. `sortOrder` orders only sibling Mailboxes, while favorites are a cross-tree priority group; rewriting sibling order to simulate favorites would be destructive and failure-prone. |
| FM-3.3 🟩 Implemented | Every starred folder shall be subscribed and shall become its own root entry at the beginning of the sidebar's `Folders` section, including a starred child of a starred parent and a starred shared folder. The star control shall be disabled while a folder is unsubscribed. Unsubscribing shall also clear its star; if the server rejects the unsubscribe, reconciliation shall restore both the subscription and the prior star. |
| FM-3.4 🟩 Implemented | Multiple favorites shall sort among themselves by the normal folder comparator. Unstarred folders shall retain their normal structural order. |
| FM-3.5 🟩 Implemented | The sidebar shall identify favorites only with the integrated gold star badge. It shall not add a `Favorites` heading, `Others` heading, horizontal divider, empty favorite section, or ghost-star marker on collapsed ancestors. With no favorites, the sidebar shall look like the ordinary unstarred folder list. |
| FM-3.6 🟩 Implemented | Manage Folders shall remain in structural role/name order when stars change. Search results shall provide ancestor breadcrumbs for context instead of ghost-star hints. |

### 4. Manage Folders dialog shell

| ID / Status | Requirement |
|:--|:--|
| FM-4.1 🟩 Implemented | Activating `Manage Folders` shall open a body-teleported modal titled exactly `Manage Folders`. Teleportation is required so a transformed sidebar cannot constrain the fixed overlay. The close button shall receive initial focus. |
| FM-4.2 🟩 Implemented | The explanatory copy shall be exactly: `Drag a folder to move it, or select several to delete them.` Legacy paragraphs that equate subscription with a purely local visibility preference shall not be shown. |
| FM-4.3 🟨 Partial | On desktop the panel shall be at most 560 px wide, fit short content naturally, and grow only to `min(80vh, 100vh - 32px)` before its list scrolls. It shall never create a horizontal scrollbar; deep indentation and long names shall cap/ellipsize. Below 640 px it shall become a full-screen sheet and explicitly clear the desktop `max-height`. The current mobile rule sets `height: 100%` but still inherits the 80vh cap. |
| FM-4.4 🟩 Implemented | The unbounded flattened manager list shall be virtualized with dynamic row measurement and overscan. Opening inline editors or confirmation panels shall trigger remeasurement. |
| FM-4.5 🟩 Implemented | The manager shall start with branches collapsed. The primary system-folder block shall also start collapsed behind the primary account heading. Subscription/selection cascades shall still traverse hidden descendants. |
| FM-4.6 🟨 Partial | The primary account heading shall use `<account name or email> (default folders)`. The primary account shall have a visible tree root labeled exactly `Top Level`, positioned below its system-folder block and above its user folders. Every user-facing occurrence of the phrase shall use `Top Level`; current drag-hint prose still says lowercase `top level`. Shared accounts shall not have a root because a user cannot create a root Mailbox in another principal's account. Search mode shall omit the synthetic root. |
| FM-4.7 🟩 Implemented | Search shall match folder names across collapsed branches, flatten matching rows, and show each result's ancestor path. While searching, disclosure controls shall be omitted because collapse state does not filter the result set. |
| FM-4.8 🟩 Implemented | Unsubscribed folder names shall be muted/greyed in addition to showing an off switch. A collapsed ancestor shall not show a ghost star merely because a descendant is a favorite. |
| FM-4.9 🟩 Implemented | Pressing Escape shall close the innermost active layer first: the create dialog handles itself; then an inline editor or per-row confirmation closes; then a bulk confirmation closes; only then does the manager close. Backdrop activation shall close the manager. |
| FM-4.10 🟨 Partial | The dialog shall expose modal semantics, labels, tooltips, disclosure state, and keyboard-accessible non-drag alternatives. A complete focus trap and an automated accessibility audit are not yet implemented. |

### 5. Manager row layout and visual rules

| ID / Status | Requirement |
|:--|:--|
| FM-5.1 🟩 Implemented | A manageable row shall order its controls as: disclosure; selection checkbox; folder name and optional search path; star immediately beside the name; flexible spacer/status; `Subscribe` or `Subscribed` label; the same `SwitchToggle` used everywhere; pencil; and `+` last. The final `+` shall column-align with the `Top Level` row's `+`. |
| FM-5.2 🟩 Implemented | Chevron and checkbox centers shall align vertically and remain close together. Native checkbox margins shall be reset. Leaves shall reserve the disclosure width so every checkbox and name begins in the same column at a given depth. |
| FM-5.3 🟩 Implemented | Row icon buttons shall use a 24×24 hit area. Row and bulk glyphs shall use 14 px at 1.75 stroke; the pencil shall use 13 px at 1.75 stroke for optical balance. Consecutive icon buttons may use optical negative spacing so transparent hit-area padding does not create oversized ink gaps. |
| FM-5.4 🟩 Implemented | The subscription control shall use the services-ui `SwitchToggle`, including in the bulk bar. A different switch glyph, bell, eye, or smaller imitation control shall not be substituted. The dense row variant may reduce the services-ui track to 32×20 px while preserving its component behavior. |
| FM-5.5 🟨 Partial | All icon-only actions shall have descriptive accessible labels; non-obvious action buttons shall also provide tooltips. Destructive actions shall use the danger color. Labels are broadly implemented, but close and disclosure icon buttons do not yet provide tooltips. |
| FM-5.6 🟩 Implemented | System rows shall show `always shown` and expose no switch, selection checkbox, star, pencil, or create-child shortcut. A shared subscription that Stalwart will not permit shall show `read-only` and a disabled switch. |

### 6. Subscription behavior

| ID / Status | Requirement |
|:--|:--|
| FM-6.1 🟩 Implemented | A row switch shall submit JMAP `Mailbox/set` for `isSubscribed` through `pending_mutations`; components and stores shall not call JMAP directly. The mutation shall resolve the Mailbox's owning account, so shared-folder writes use the shared account id rather than the primary account id. |
| FM-6.2 🟨 Partial | The label before a row switch shall be `Subscribed` while on and `Subscribe` while off. Tooltip copy shall say that the setting affects mail apps **that honor subscriptions**, not imply that every mail app necessarily shows or hides the folder. Dynamic labels are implemented, but the current tooltip overstates the cross-client effect. |
| FM-6.3 🟩 Implemented | Toggling a parent shall apply the target subscription state to the parent and every editable, non-pending descendant that is not already in that state. It shall not affect siblings. Toggling a leaf shall affect only that leaf. Star cleanup is specified separately in FM-3.3. |
| FM-6.4 🟩 Implemented | A cascade or bulk subscription action shall optimistically flip all affected local rows in one reactive pass. Folder refreshes triggered by earlier server confirmations shall reapply an in-flight optimistic overlay so later descendants do not flash back into the sidebar. If any mutation fails, the system shall refresh from SQLite/server-confirmed state to reconcile. |
| FM-6.5 🟩 Implemented | While a folder subscription mutation is in flight, its switch shall be disabled and the row shall show `saving…`. Terminal JMAP policy errors shall resolve immediately rather than retrying with backoff while the control remains stuck. |
| FM-6.6 🟩 Implemented | A bulk subscription action shall affect exactly the selected editable rows, without an implicit descendant cascade. If any selected editable row is subscribed, the modal action shall unsubscribe all selected editable rows; only when all are unsubscribed shall it subscribe all. |
| FM-6.7 🟩 Implemented | Subscription shall use one plural-capable operation path: a single-folder toggle is the N=1 case and a cascade/bulk action supplies N targets. Each owning-account chunk, bounded by `maxObjectsInSet`, shall enqueue one payload under the session's primary local runner account, issue one multi-object `Mailbox/set.update` map for the owning JMAP account, and apply each chunk's confirmed ids transactionally before advancing. Durable per-id outcomes shall cross the runner/Repository boundary, and duplicate targets shall resolve deterministically with the last requested state winning. |
| FM-6.8 🟥 Upstream blocked | As a Stormbox interoperability requirement, a read-only user should be able to change their own server-synchronized `isSubscribed` value for a shared Mailbox without gaining rename rights. RFC 8621 requires per-user storage, while RFC 9670 still permits a server to reject some subscription changes; this is therefore an overbroad ACL coupling/interoperability bug rather than an unambiguous violation of the per-user storage MUST. Stalwart currently rejects every shared `Mailbox/set` update unless the user has `Acl::Modify`/`mayRename`. |
| FM-6.9 🟩 Implemented | Stormbox shall not add a local visibility fallback for read-only shared folders. It shall list the folder in Manage Folders, label it `read-only`, and disable its subscription switch when Stalwart denies the operation. If the server reports it unsubscribed, it remains absent from the sidebar unless the upstream permission behavior changes. |
| FM-6.10 🟨 Partial | When the currently open folder is successfully unsubscribed and leaves the sidebar, Stormbox shall navigate to the primary account's Inbox. The current implementation can leave the message view on a folder that no longer appears in navigation. |

### 7. Creation, rename, move, and deletion

| ID / Status | Requirement |
|:--|:--|
| FM-7.1 🟩 Implemented | Folder creation shall be entered through a `+` on `Top Level` or a `+` at the end of an eligible folder row. There shall be no oversized labeled New Folder button in the manager header. The row shortcut shall preselect that row as `Parent`; the root shortcut shall preselect `Top Level`. |
| FM-7.2 🟩 Implemented | The creation dialog shall be titled exactly `New folder`, collect `Name` and `Parent`, require a non-empty trimmed name, explicitly create with `isSubscribed: true`, and close only after the mutation succeeds. The parent picker shall include `Top Level` and all primary folders, plus shared folders that grant `mayCreateChild`. |
| FM-7.3 🟩 Implemented | The system shall reject a case-insensitive duplicate sibling name locally and surface `A folder with that name already exists here.` Server rejections remain authoritative. |
| FM-7.4 🟨 Partial | The pencil shall open an inline editor labeled `Name` and `Parent` (never `Location`). Saving may rename, re-parent, or do both in one `Mailbox/set`. A no-op save shall close the editor, but clearing a previously non-empty name shall show validation rather than silently becoming a no-op or move-only update. Blank-rename validation is not yet implemented. |
| FM-7.5 🟩 Implemented | A folder may be moved by choosing a parent or by dragging it onto another folder. Dropping on `Top Level` shall move it to the primary account's root. A parent must belong to the same account; the folder itself and its descendants shall be excluded; the current parent shall be a no-op; and every shared destination, including one selected in the inline parent picker, shall grant `mayCreateChild`. |
| FM-7.6 🟩 Implemented | System folders shall remain protected independently of reported rights. Shared rights shall fail closed when absent/malformed, while primary non-system folders may remain manageable when `rights_json` is absent. Capabilities shall distinguish `mayCreateChild` (folder creation/re-parent destination), `mayAddItems` (message destination), `mayRemoveItems` (message source/destructive mail removal), `mayRename` (folder rename/re-parent), and `mayDelete` (folder itself). Stalwart's `mayRename` subscription proxy shall remain explicitly server-specific. |
| FM-7.7 🟩 Implemented | A folder with children shall not be deleted unless its complete subtree is selected for deepest-first bulk deletion. The UI shall explain whether the user must select the whole subtree or move the retained child. |
| FM-7.8 🟩 Implemented | Deletion shall first call `Mailbox/set` with `onDestroyRemoveEmails: false`. A `mailboxHasEmail` response shall trigger a second, explicit permanent-deletion warning before retrying with `true`. The warning shall state that only messages not filed in another folder are permanently deleted. |
| FM-7.9 🟩 Implemented | Folder-destroy cache apply shall receive the owning account and whether `onDestroyRemoveEmails` was true. In one transaction it shall capture only messages linked to the target folder, remove memberships/views, soft-delete the folder, and reuse batched message-destroy/view-compaction logic. On the destructive path it shall delete captured messages with no remaining membership and preserve multi-filed messages. A successful non-destructive delete shall not infer Email destruction from incomplete cache; unexpected stale memberships shall be reconciled. |
| FM-7.10 🟨 Partial | The UI shall translate server quota and hierarchy failures into actionable copy: `overQuota` → `This account has reached its folder limit. Delete some folders to make room.`; a parent-depth `invalidProperties` response whose description says the relationship is too deep → `Folders cannot be nested this deeply. Choose a Parent closer to Top Level.` Limits are server-configured and shall not be hard-coded. Error mapping exists, but current visible copy still uses lowercase `top level`, contrary to the accepted `Top Level` rule. |

### 8. Selection and bulk actions

| ID / Status | Requirement |
|:--|:--|
| FM-8.1 🟩 Implemented | A non-system folder eligible for at least one bulk action shall have a general-purpose selection checkbox independent of its subscription switch and delete permission. Checking or unchecking a parent directly shall apply that selection state to selectable descendants, including collapsed descendants. |
| FM-8.2 🟩 Implemented | Shift-click shall apply the clicked row's new selected state to the inclusive range between the anchor and target in current visual order. A range selection shall not add an implicit descendant cascade. Ctrl-click or Command-click on a non-interactive part of a row shall toggle that row; modifier-clicks on buttons, inputs, selects, or switches shall retain the control's own behavior. |
| FM-8.3 🟩 Implemented | The selection anchor shall be the last checkbox or modifier-row toggle. Selection ids shall be pruned if folders disappear during sync or deletion. |
| FM-8.4 🟩 Implemented | When selection is non-empty, the footer shall show the selected count followed by: modal star/unstar icon; the same `SwitchToggle` used in rows; red trash icon; then clear `X` at the far right of the action cluster. Clear must remain to the right of trash. Each action shall expose its own enabled state; delete shall be disabled unless the complete selection is deletable. |
| FM-8.5 🟨 Partial | Bulk star and subscription actions are modal: if any applicable selected row has the state, activating the control clears it from every applicable selected row; otherwise it sets the state on every applicable selected row. An action shall be disabled when no selected row is eligible, and shall clearly apply only to eligible selected rows rather than silently implying it affected the rest. Modal behavior exists, but no-eligible/mixed-permission UX is incomplete. |
| FM-8.6 🟩 Implemented | Bulk deletion shall reject a selection that keeps an unselected descendant of a selected folder. A valid selection shall be destroyed deepest-first so each parent becomes a leaf before its turn. |
| FM-8.7 🟨 Partial | Bulk deletion shall first confirm only the folder count (`Delete 1 folder?` or `Delete N folders?`) and shall not display an aggregate message count. If any remaining folder contains mail, it shall escalate once to the permanent-deletion warning and retry only the remainder. The current confirmation still displays `It contains`/`They contain` message totals. |
| FM-8.8 🟨 Partial | Bulk confirmation shall omit the aggregate message count because summing each selected folder's `totalEmails` double-counts an Email filed in multiple selected folders. The destructive escalation shall continue to explain that mail is present and that messages not filed elsewhere may be permanently deleted. |
| FM-8.9 🟨 Partial | Bulk star and folder-delete paths shall use the same plural-capable handlers as N=1 operations, never per-folder await loops. Stars shall update all targets in one SQLite transaction/broadcast. Folder deletes shall batch each dependency-safe depth layer into `maxObjectsInSet`-bounded `Mailbox/set` requests, deepest first. If a child fails, its ancestors shall be pruned from later layers rather than sent to guaranteed `mailboxHasChild` failure; the destructive retry shall include only the `mailboxHasEmail` remainder. The plural star path and dependency-safe delete orchestration are implemented and unit-covered; live multi-depth, over-cap, and partial-transport browser verification remains outstanding. |
| FM-8.10 🟩 Implemented | Eligibility for bulk star, subscription, and deletion shall be evaluated independently. Star shall act on selected subscribed non-system folders; subscription shall act on selected subscription-editable folders; delete shall be enabled only when every selected folder is deletable and the subtree rules are satisfied. |

### 9. Mutation, cache, and error invariants

| ID / Status | Requirement |
|:--|:--|
| FM-9.1 🟨 Partial | All folder mutations shall enter one plural-first orchestration interface that accepts an operation and target set; N=1 shall not use a separate implementation. A thin dispatcher shall group/chunk by owning account and call typed create/update/subscription/destroy helpers rather than become a god function. Pending rows remain under the session's primary local runner account while payloads identify owning accounts. Server helpers emit the minimum valid `Mailbox/set` requests; stars use the same plural-first store contract but one batched Repository RPC. The protocol helpers and subscription/destroy/star store paths are plural-first; create/update remain exposed only through singular store APIs, though their payload/dispatcher contract is plural-capable. |
| FM-9.2 🟩 Implemented | After a successful JMAP mutation, the corresponding `OUTBOX_APPLY_FOLDER_*` handler shall update the cache and broadcast the `FOLDERS` table family before the user-facing mutation promise resolves. |
| FM-9.3 🟩 Implemented | A created folder shall be upserted by `(account_id, remote_id)` so a concurrent `Mailbox/changes` ingestion cannot duplicate it. Updates shall distinguish “parent omitted” from “move to Top Level.” Destroy shall preserve messages that retain other memberships. |
| FM-9.4 🟩 Implemented | JMAP `notCreated`, `notUpdated`, and `notDestroyed` SetErrors caused by permissions, invalid hierarchy, retained children, mail, or quota shall be terminal policy outcomes. They shall not be retried as transient transport failures. |
| FM-9.5 🟨 Partial | Multi-folder operations shall preserve JMAP's per-id `created/notCreated`, `updated/notUpdated`, and `destroyed/notDestroyed` outcomes through durable mutation state, `OutboxRunner`, Repository RPC, store result, and UI. Results shall identify succeeded target ids and errors keyed by target, not only attempted/succeeded/failed counts. Runner/Repository/store propagation and selective subscription rollback are implemented; the manager still presents aggregate failure copy rather than precise per-folder partial outcomes. |
| FM-9.6 🟨 Partial | Conflicting folder mutations from multiple tabs shall serialize by folder target, not only by message target or tab-local pending state. Folder mutations currently have no shared folder-target lock, so two tabs can race subscription, rename, move, or delete operations on the same folder. |

## Normative UX decisions and rejected alternatives

These decisions resulted from iterative review. Future changes should
not reintroduce a rejected pattern without first updating this spec.

1. **Manage action placement** — use one icon-only settings action in
   the `Folders` heading. Do not use a full-width “Manage Folders” row
   that can be buried in a long list.
2. **Subscription affordance** — use the services-ui switch and
   `Subscribe`/`Subscribed` labels. Do not use an eye, checkbox,
   bell, unrelated toggle icon, or a custom miniature switch.
3. **Selection separation** — checkboxes mean selection; switches mean
   subscription. One control must not serve both meanings.
4. **Creation placement** — use `+` on `Top Level` and eligible rows.
   Do not restore a labeled header button whose text and icon compete
   for space.
5. **Tree root** — always spell `Top Level` with both words
   capitalized. Position it below system folders. Use `Parent`, not
   `Location`, in editors.
6. **Modal height** — fit content up to an 80% viewport maximum. Do
   not force a minimum 80% height for a short collapsed tree.
7. **Capitalization** — use `Folders` and `Manage Folders`, not
   all-caps headings. Do not apply `text-transform: uppercase` to
   folder-management copy.
8. **Favorite separation** — use an integrated star badge and leading
   priority placement. Do not add a horizontal divider, a persistent
   `Favorites`/`Others` heading pair, or extra vertical whitespace.
9. **Favorite hierarchy** — starring is available only while
   subscribed and always promotes the exact folder to its own root
   favorite, even if its parent is also starred. Unsubscribing clears
   the star. Do not preserve latent favorites that subscription
   filtering hides.
10. **Manager stability** — star changes must not reorder the manager
    or parent pickers. Favorite sorting belongs only to the sidebar.
11. **Collapsed favorite discovery** — do not add ghost stars to
    ancestors. Search plus ancestor breadcrumbs is the accepted
    context mechanism.
12. **Bulk action styling** — star, subscription, trash, and clear
    controls use the same icon scale and visual language as row
    controls. Clear stays to the right of trash.
13. **Control alignment** — the final row order is star near the name,
    subscription label/switch, pencil, then `+`; `+` aligns with the
    root create action. Folder icons and names must not shift merely
    because a star is present.
14. **Horizontal overflow** — indentation and long names must shrink
    or ellipsize inside the modal. A horizontal folder-list scrollbar
    is not an acceptable solution.

## Reference-server constraint: read-only subscriptions

RFC 8621 §2 defines `isSubscribed` as the user's indication that they
wish to see a Mailbox and states:

> This MUST be stored separately per user where multiple users have
> access to a shared Mailbox.

It also says the property corresponds to IMAP mailbox subscriptions.
RFC 9670 permits a server to reject subscription to some otherwise
readable shared resources, so the research does not establish an
unambiguous standards violation. It establishes that Stalwart couples
this per-user operation to the unrelated rename/modify right, creating
a concrete Stormbox interoperability dead end.

Stalwart nevertheless applies a blanket shared-Mailbox update gate
before handling the specific property. This was reproduced with real
JMAP requests against release **v0.16.13** and confirmed in current
upstream source at commit
[`45602a35ba1cbec189ae4468019063417f371b4f`](https://github.com/stalwartlabs/stalwart/commit/45602a35ba1cbec189ae4468019063417f371b4f):

- `crates/jmap/src/mailbox/set.rs:202-210` rejects a shared update when
  `effective_acl` lacks `Acl::Modify`; the rejecting condition is line
  204.
- `crates/jmap/src/mailbox/set.rs:392-400` handles
  `MailboxProperty::IsSubscribed`, but execution never reaches it
  after the blanket rejection.
- `crates/jmap-proto/src/object/mailbox.rs:449-458` maps
  `MailboxRight::MayRename` to `Acl::Modify`.

Consequently, granting only read rights makes the Mailbox discoverable
but does not let that user subscribe. Granting `mayRename` makes the
same subscription update succeed. At the time of research, no existing
upstream issue was found.

Stormbox's accepted mitigation is truthful degradation: show the shared
row in Manage Folders, label it `read-only`, disable its subscription
switch, and allow all other rights-independent local presentation such
as starring only when the folder is already subscribed. An
unsubscribed read-only share therefore cannot enter the sidebar.
Stormbox will not add a separate local visibility fallback; an upstream
Stalwart fix may later make the disabled subscription action available.

## Protocol and data rationale

### Why favorites are local

JMAP `Mailbox.sortOrder` is an unsigned, writable ordering value among
Mailboxes that share the same `parentId`. It cannot express a
cross-tree priority group. Using it for favorites would require
rewriting unrelated sibling groups, would not create a global order,
and would not map to IMAP. `is_starred` is therefore a local SQLite
preference and Mailbox sync must never overwrite it.

### Why folder deletion warns about mail

JMAP's `onDestroyRemoveEmails` controls whether destroying a Mailbox
also removes that membership. Because `mailboxIds` is a set, an Email
filed elsewhere survives; an Email with no remaining Mailbox may be
destroyed by the server. The confirmation copy must preserve that
distinction rather than implying that every message counted in a
folder is necessarily destroyed.

### Why complete mailbox paging is mandatory

The reference server caps `Mailbox/get` results according to
`maxObjectsInGet` (500 in the tested configuration) and can return only
that prefix from an unpaged request. A partial hierarchy creates
orphaned children, stale local rows, misleading top-level entries, and
`notUpdated` errors when the UI mutates a row no longer represented by
the server. Folder discovery must therefore page independently of UI
virtualization.

### Mailbox count and depth limits

Mailbox-count quota and maximum hierarchy depth are server policy.
Stormbox must not assume the local development defaults are production
limits. The server may report count exhaustion as `overQuota` and
Stalwart reports excess depth as `invalidProperties` on `parentId` with
a “too deep” description. Product copy must explain the remedy rather
than expose raw protocol codes.

## Verification requirements

Folder mutations are subject to the constitution's Verified
Consistency rule. Every server/cache mutation must be exercised on
Chromium and Firefox and assert:

1. the visible UI outcome;
2. the browser-local cache through `window.__repo`; and
3. the direct JMAP server outcome.

Current automated coverage includes:

- `tests/e2e/folder-subscriptions.spec.js`
  - subscription switch round-trips through UI, cache, and server;
  - unsubscribed primary user folders leave the sidebar and return
    after subscribing.
- `tests/e2e/folder-crud.spec.js`
  - create, rename, and delete round-trip through UI/cache/server;
  - deletion escalation for a Mailbox containing mail;
  - bulk delete with partial first-pass success and escalation;
  - system folders expose no subscription, selection, or edit controls.
- `tests/unit/components/folder-tree.test.ts`
  - collapse state, unread roll-up, favorite promotion, subscription
    filtering, orphan promotion, shared sections, and manager entry.
- `tests/unit/components/folder-manager-dialog.test.ts`
  - cascaded subscription and selection, search through collapsed
    trees, virtualized manager behavior, Shift/Ctrl selection, modal
    bulk star/subscription actions, deletion gap checks, deepest-first
    deletion, drag/drop constraints, rights gating, stable structural
    order, exact control order, no ghost star, search breadcrumbs, and
    row-parent create shortcuts.
- `tests/unit/components/folder-create-dialog.test.ts`
  - creation inputs, parent selection, pending behavior, and error
    handling.
- `tests/unit/sync/jmap-mailboxes.test.ts`
  - paging behavior using a simulated cap of 2 with 5 Mailboxes,
    authoritative
    tombstoning, `hasMoreChanges` iteration, parent resolution,
    subscription persistence, and shared-account archive behavior.
- `tests/unit/sync/jmap-outbox.test.ts`
  - subscription/create/update/destroy request shapes, owning-account
    resolution, grouping/chunking, partial outcomes, immediate cache
    effects, terminal/retryable errors, destructive semantics,
    owner-account message move/destroy, and cross-account `Email/copy`
    request/cache/partial/`alreadyExists` behavior, including
    post-copy reconciliation failures that cannot duplicate copies.
- `tests/unit/integration/mail-store-delete.test.ts`
  - store-built cross-account copy payload through the real
    `OutboxRunner`/`processMutationRow` path into destination cache.
- `tests/unit/utils/folder-capabilities.test.ts`
  - primary fallback, system protection, malformed shared-rights
    fail-closed behavior, independent item/hierarchy rights, and stars.
- `tests/unit/sync/jmap-backend.test.ts`
  - account-scoped shared `EmailDelivery` active-view reconciliation
    and newly-added body prefetch without inventing `Email/changes`
    state, per-account push failure isolation, and shared reconnect
    catch-up.

Coverage still required before treating the feature as complete:

- an automated 1,267+-folder browser performance/regression scenario;
- direct E2E coverage of shared-account rendering, permitted shared
  mutations, session cleanup, and per-user cache isolation;
- direct coverage that `mayRename: false` disables a shared
  subscription control and that missing rights fail closed;
- shared-folder open-window reconciliation on push and reconnect;
- batched personal↔shared `Email/copy`, including UI copy feedback,
  destination cache insertion, unchanged source state, rights failures,
  and direct JMAP verification;
- shared-folder message actions using the shared owning account rather
  than the primary account;
- successful parent-picker and drag-and-drop folder moves through UI,
  cache, and server;
- cascaded and bulk subscription changes through UI, cache, and server;
- deletion of one Mailbox while a multi-filed Email survives in its
  other Mailbox;
- E2E coverage of create/move failures at count quota and maximum
  depth;
- favorite persistence across reload and enforcement that
  unsubscribed folders cannot remain starred;
- literal 501+/1,267-folder live sync and DOM-windowing assertions,
  not only a reduced-cap algorithm test;
- pagination failure/race cases and the 20-page changes fallback;
- test mocks that implement `Repository.listAccounts` instead of
  silently exercising a failed folder attachment;
- browser-level partial-failure UX for multi-object subscriptions;
- a focused accessibility audit/focus-trap test for both dialogs.

## Non-goals

- Editing folder-sharing ACLs or choosing share recipients.
- A unified cross-account Inbox.
- Treating shared JMAP principals as separate signed-in users; they
  remain part of one authenticated session under the single-active-
  account MVP.
- Partitioning retained IndexedDB/SQLite caches between different
  Stormbox users who sign into the same origin sequentially in one
  browser profile. That is an important cross-session authentication
  and storage-isolation issue, but is tracked outside this
  folder-management feature.
- Synchronizing favorites between devices.
- Arbitrary manual sibling ordering or a `sortOrder` editor.
- A client-local show/hide preference conflated with subscription.
- Deleting or renaming protected role folders.
- Treating a JMAP Mailbox as proof that each message belongs to exactly
  one folder.

## Implementation map

- `src/components/FolderTree.vue` — primary/shared sidebar grouping,
  subscription filtering, favorite promotion, hierarchy construction,
  unread roll-up, and the Manage Folders entry point.
- `src/components/FolderNode.vue` — dense recursive sidebar rows,
  disclosures, integrated favorite badge, unread/index badges, and
  message-drop feedback.
- `src/components/FolderManagerDialog.vue` — virtualized management
  tree, search, collapse, subscription, selection, bulk actions,
  drag/drop, inline editing, permissions, and destructive confirmation.
- `src/components/FolderCreateDialog.vue` — creation form and
  permission-aware parent picker.
- `src/stores/mail-store.ts` — account/folder projections, sidebar
  filtering, optimistic subscription and star state, mutation enqueue,
  validation, and error normalization.
- `src/db/migrations/004_folder_subscriptions.sql` and
  `005_folder_stars.sql` — `is_subscribed`, `is_personal`, and
  client-local `is_starred`.
- `src/db/{protocol,repository,handlers}.ts` — Repository RPCs,
  post-success cache effects, soft deletion, and FOLDERS broadcasts.
- `src/sync/backends/jmap/{session,backend,mailboxes,outbox,outbox-runner}.ts`
  plus `src/sync/sync-host.ts` — shared-account ingestion/routing,
  complete Mailbox synchronization, push handling, mutation dispatch,
  and terminal SetError behavior.
- `src/constants/states.ts`, `src/types/{db,jmap}.ts`, and
  `src/utils/folder-presentation.ts` — mutation names, persisted row
  shapes, JMAP account metadata, role presentation, and sidebar-only
  favorite sorting.
- Folder-focused unit and E2E suites under
  `tests/unit/{components,stores,sync,utils,db}` and `tests/e2e/`.

## Research and implementation references

- [RFC 8620 — JMAP Core](https://www.rfc-editor.org/rfc/rfc8620.html)
  (Session accounts and capabilities).
- [RFC 8621 — JMAP Mail](https://www.rfc-editor.org/rfc/rfc8621.html)
  (`Mailbox`, `isSubscribed`, `sortOrder`, `Mailbox/set`, and
  multi-Mailbox membership).
- [RFC 9670 — JMAP Sharing](https://www.rfc-editor.org/rfc/rfc9670.html)
  (shared account and rights model).
- [Stormbox issue #51 — Show Shared Folders](https://github.com/thunderbird/stormbox/issues/51).
- Stalwart release v0.16.13 live reproduction and current-main source
  analysis described in the reference-server section above.
- Roundcube's folder-settings subscription tree and Thunderbird's
  Subscribe dialog were reviewed as prior art. The accepted Stormbox
  design keeps their separate management-surface concept while using a
  virtualized, permission-aware tree suitable for large JMAP accounts.
