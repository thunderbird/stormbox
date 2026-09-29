# Message Keywords: Stars and Tags — Product and Engineering Specification

This specification defines how Stormbox reads and writes JMAP `Email`
keywords that the user controls directly: the star (`$flagged`) and tags
(Thunderbird-compatible user keywords). It refines
the message-list requirements in `specs/001-mvp-scope/spec.md`, in
particular R-2.8 (filters), R-3.6 (multi-select), R-3.17 (batched keyword
mutations), and R-10.3 (the single-column layout), and it adds beacons
described in `specs/010-onboarding/spec.md` (OB-4.1).

The architectural invariants in `.specify/memory/constitution.md` remain
controlling: the server is authoritative, protocol mutations enter the
durable outbox, the UI applies optimistically from the local cache, and
single and batched writes share one code path.

**Implementation scope**: Vue 3 + Pinia, browser-local SQLite, JMAP Mail
against Stalwart.

## Status legend

- 🟩 **Implemented** — the described behavior is present.
- 🟨 **Partial** — useful behavior is implemented, but a known gap remains.
- ⬜ **Planned** — decided and specified, not built.

## Terminology and model

### Keyword

A JMAP `Email.keywords` entry (RFC 8621 §4.1.1): a case-insensitive
string of printable ASCII without `(){]%*"\` or whitespace, at most 255
octets, present or absent on a message. Keywords map one to one onto IMAP
flags and keywords, which is what makes them interoperable with
Thunderbird, Apple Mail, Fastmail and every other IMAP client on the same
account. Stormbox compares and sends keywords lowercase.

### Star

The `$flagged` keyword (IMAP `\Flagged`). "Star" is the user-facing word;
"flagged" is the protocol and schema word (`messages.is_flagged`).

### System keywords

Keywords the tag UI hides (`SYSTEM_KEYWORDS` in
`src/utils/message-tags.ts`), in two tiers.

**Reserved** keywords are ones the client reads or writes itself and are
never tags, even with a definition (`RESERVED_KEYWORDS`): `$seen`,
`$flagged` and the RFC 9979 §3 flag-color bits
`$mailflagbit0`–`$mailflagbit2`, which qualify the star; `$draft`,
`$answered`, `$forwarded`, `$junk`, `$notjunk`; and the remaining IMAP
system flags `$recent` and `$deleted`.

**Hidden** keywords are not shown until the user defines a tag with that
exact keyword, after which it renders and toggles like any other tag.
Until then nothing in the UI lists, suggests or counts them, including
the tag manager's "keywords on your messages" list:

- Every other keyword in the IANA "IMAP and JMAP Keywords" registry,
  which Stalwart models as its built-in keywords: `$mdnsent`,
  `$submitpending`, `$submitted`, `$phishing`, `$important` (RFC 8457),
  and the rest of the RFC 9979 §3 set.
- Status markers other clients and servers write to shared accounts:
  the unprefixed junk-classifier keywords `junk`, `nonjunk`, `notjunk`,
  `nojunk` and `junkrecorded` (Thunderbird, Roundcube, Claws, Apple
  Mail) and Gmail's `$notphishing`; Evolution's `$has_cal` and
  `$has_note`; KMail's `$attachment`, `$encrypted`, `$error`,
  `$ignored`, `$invitation`, `$queued`, `$replied`, `$sent`, `$signed`,
  `$todo` and `$watched`; Bulwark's `$pinned`; `$readreceipt` and
  `$notdelivered`; and Cyrus's `$restored`, `$snoozed` and
  `$sievefailed`.

A derived keyword (MK-6.3) keeps a leading `$` and avoids only the
reserved keywords, so naming a tag `NonJunk` or `$todo` defines `nonjunk`
or `$todo`, and naming one `$seen` defines `$seen2`. A stored definition over a
reserved keyword is kept in the setting but never offered as a tag.

### Tag

Any other keyword. A tag may have a **definition** (name, color, order)
in universal settings; a keyword without one still renders, named from the
keyword.

### Local cache

`messages.keywords_json` holds the full keyword object as last seen or
optimistically written; `messages.is_seen`, `is_flagged` and `is_junk` are
derived columns kept in step with it; `message_keywords(message_id,
keyword)` is the join used for keyword queries. All three are written in
one transaction by `replaceMessageKeywordsMany`.

## Product principles

- One keyword path. Every keyword write, single or bulk, star or seen or
  junk, goes through `setKeywordsMany`, so optimistic apply, cache
  invariants, batching and reconciliation cannot drift between features.
- The star is where the eye already rests. It lives on the summary line of
  the row, at the inline-end beside the date, and a set star stays in that
  exact position at rest, so the hover control and the state indicator are
  one thing.
- Keyboard users are first-class without cluttering the Tab order. Row
  controls are pointer-only; the `S` shortcut and the multi-select toolbar
  carry the keyboard.
- Filters stay honest. Starred, like Unread, is a dense local filter over
  the open folder's canonical view, never a broader projection, so a
  filter count can never exceed the All count.

## Requirements

### 1. Data and mutation path

| ID / Status | Requirement |
|:--|:--|
| MK-1.1 🟩 Implemented | The star shall be the JMAP `$flagged` keyword and nothing else. A star set in Stormbox shall appear as flagged in every other client on the account, and a flag set elsewhere shall appear as a star after the next sync of the message. |
| MK-1.2 🟩 Implemented | All keyword writes shall go through one store path, `setKeywordsMany(ids, { add, remove })`, which: skips rows already in the target state; writes `keywords_json`, the derived columns and `message_keywords` for the rest in one optimistic transaction; and enqueues exactly one `setKeywords` outbox mutation for the batch, carrying `messageIds`, `add`, `remove`, an `optimisticPatchJson` for the derived columns, and `targetMessageId` when the batch has one row. Mark read, mark unread, junk, not-junk and star are all thin wrappers over it. |
| MK-1.3 🟩 Implemented | Star writes shall skip scheduled (Send Later) rows, which are read-only outgoing mail (`specs/009-send-later/spec.md`), and shall resolve the account from the row's source folder so shared-folder rows are checked against their own account. |
| MK-1.4 🟩 Implemented | A failed optimistic write shall log and report zero rows changed rather than throw into the UI, matching the other bulk actions; the outbox retries the server write independently of the UI. |
| MK-1.5 🟩 Implemented | Keywords shall be normalized to lowercase before comparison and before being sent, since RFC 8621 requires servers to return them lowercase but Stalwart stores unknown keywords verbatim. A cached keyword in another spelling counts as present; removing it also names that spelling on the wire, because Stalwart matches custom keywords case-sensitively. |

### 2. Starring in the message list

| ID / Status | Requirement |
|:--|:--|
| MK-2.1 🟩 Implemented | In layouts at or above the single-column breakpoint (640px, R-10.3), hovering a message row shall overlay pointer-only controls on the inline-end of the row's summary line: the tag stack (MK-6.5), Star, Archive and Delete, 28px tall and 2px apart, over the reserved 56px tag and 34px star slots and the date; the overlay is anchored at its end, so a wider stack grows leftward. The overlay shall sit on the row's own background so the text beneath does not show through, and shall leave the preview line below uncovered. The buttons shall not be Tab stops, and clicking one shall neither select nor open the row. |
| MK-2.2 🟩 Implemented | A set star shall stay visible at rest in exactly the position it has in the hover overlay (the 34px slot immediately before the date on the summary line), filled and colored; an unset star shall be hidden at rest and outlined on hover. Archive and Delete show only on hover. |
| MK-2.3 🟩 Implemented | In the single-column layout (below 640px) there shall be no hover overlay. The row shall always show a single star button, outlined when unset and filled when set, in the same 34px slot immediately before the date on the summary line, so it never overlaps the preview line. Archive and Delete shall not be rendered in that layout. |
| MK-2.4 🟩 Implemented | While rows are checkbox-selected, the multi-select toolbar (R-3.6) shall include a Star toggle beside its other icon actions. It is modal over the selection: if any selected row is starred it shall read `Unstar` and unstar them all; otherwise it shall read `Star` and star them all. It shall not render in the Scheduled folder. |
| MK-2.5 🟩 Implemented | Star controls shall expose `Star` / `Unstar` as both `title` and accessible name and shall carry `aria-pressed` reflecting the current state. |
| MK-2.6 🟩 Implemented | Starring is available from the list only. The open-message toolbar shall not carry a star control; `S` and the list controls cover the open message. |
| MK-2.7 🟩 Implemented | The row-actions overlay, hover or single-column, shall not render in the Scheduled folder. |

### 3. Filtering

| ID / Status | Requirement |
|:--|:--|
| MK-3.1 🟩 Implemented | The message list header shall offer a `Starred` text toggle immediately after `Unread` (R-2.8). It is a dense local filter over the open folder's canonical query view: it never issues a JMAP query and never reads a broader projection than All. Toggling it on clears the previewed message and expands the cached view into memory so the count covers the whole folder. |
| MK-3.2 🟩 Implemented | Unread and Starred may be active together and combine as AND. Select-all under either or both selects only the rows that pass every active filter. The empty state shall name the active filters (`No starred messages in …`, `No unread starred messages in …`). |
| MK-3.3 🟩 Implemented | A row that stops matching (for example, unstarred under the Starred filter) shall stay in the list while it is previewed or checkbox-selected, and leave once that preview or selection is cleared, as R-2.8 requires. |
| MK-3.4 🟩 Implemented | A cross-folder view per tag (every message of the signed-in account carrying the keyword, regardless of folder) and an account-wide `Starred` view are local smart views: a `message_keywords JOIN messages` read over the cache (`message.listForKeyword`, the "Smart folder: arbitrary keyword" query in `docs/architecture/sqlite-storage.md`), never a server `Email/query`. A view is addressed like a folder by a negative id (`tagViewIdFor`), so columns, selection, the cursor and the open message bind to it unchanged; it is loaded whole (at most 2000 rows, newest first) and re-read on every `MESSAGES` broadcast. The sidebar's `Tags` section lists `Starred` and every defined tag with its cached count; picking one opens the view and dropping messages on one adds the tag (stars them, for `Starred`). A note under the header states what the view cannot show: how much of the account the indexer has covered while that is incomplete, so a partial index is not read as an empty tag; that only the newest 2000 of a larger count are listed; and, where shared folders are mounted, that they are not included. Filing — archive, junk, delete, move, drag — is not offered in a tag view, since its rows live in many folders; keyword actions and reply are. |

### 4. Keyboard

| ID / Status | Requirement |
|:--|:--|
| MK-4.1 🟩 Implemented | `S` shall toggle the star in both shortcut schemes (`toggleStar` in `src/constants/shortcuts.ts`), matching Thunderbird desktop. It acts on the checkbox selection when there is one, otherwise on the open message, with the same modal rule as MK-2.4, and is inert in a text field. |
| MK-4.2 🟩 Implemented | `1`–`9` shall toggle the nth tag in definition order and `0` shall clear all tags on the target, as in Thunderbird, in both schemes. A digit toggle is modal over the target: the tag is removed only when every target row carries it, otherwise added to the rows missing it. In the Web scheme `T` opens the tag menu for the target (the toolbar menu over a selection, a popover on the open message's row); the Thunderbird scheme leaves `T` alone, since the desktop client binds it to "next unread thread". Digits match with or without Shift, for layouts that put them on the shifted row. Hints show the digits as `1–9`; `aria-keyshortcuts` lists each. |

### 5. Announcement

| ID / Status | Requirement |
|:--|:--|
| MK-5.1 🟩 Implemented | The starring feature shall be announced with one beacon, `starMessages` (OB-4.1). Because the row star is hidden until hover, the dot sits on the always-visible `Starred` filter; revealing it from the pill switches to Mail and, in the single-column layout, closes the open message so the list header is on screen. The Welcome modal is unchanged. |
| MK-5.2 🟩 Implemented | Tags shall be announced with one beacon, `tagMessages` (seq 9, OB-4.1), on the sidebar Tags heading's Manage Tags button, which is always on screen while the row's tag stack is not; revealing it from the pill returns to Mail and shows a hidden folder list. The Welcome modal lists the tag shortcuts in their own card (MK-4.2). |

### 6. Tags

| ID / Status | Requirement |
|:--|:--|
| MK-6.1 🟩 Implemented | Stormbox shall ship the five Thunderbird default tags with Thunderbird's keywords and colors: `$label1` Important `#FF0000`, `$label2` Work `#FF9900`, `$label3` Personal `#009900`, `$label4` To Do `#3333FF`, `$label5` Later `#993399`. |
| MK-6.2 🟩 Implemented | Tag definitions (`keyword`, `name`, `color`, `order`) shall live in universal settings (`specs/006-user-settings/spec.md`) under one `messageTags` key so they follow the user across devices. One key means last-write-wins at list granularity: two devices editing different tags at once resolve to the later writer. Accepted for simplicity. The list is capped at 64 definitions: Stalwart's per-account keyword cache holds 99 distinct custom keywords, and room is left for keywords other clients set. |
| MK-6.3 🟩 Implemented | Display names shall accept all languages, spaces, punctuation and emoji, trimmed and limited to 100 Unicode code points; blank names, controls, line breaks and lone surrogates are rejected with visible validation, never silently truncated. A new keyword shall be derived once, as Thunderbird's `nsMsgTagService::AddTag` does: keep a leading `$`, lowercase ASCII letters only, encode spaces, `=`, `()[]{}%*"\<>;&` and every non-ASCII character as lowercase `=xx` escapes of the name's own UTF-8 bytes, cap at 128 ASCII bytes (Stalwart's limit), and disambiguate against existing and reserved keywords with a numeric suffix. Keywords are immutable once created; renaming changes only the display name. New tags take the next unused color from the fixed palette. |
| MK-6.4 🟩 Implemented | Deleting a tag definition shall remove the definition only. Messages carrying the keyword keep it and render it as an undefined tag named from the keyword; stripping the keyword from messages is a separate, explicit action. The tag manager lists the keywords found on cached messages that no definition names (`message.listKeywords`), each adoptable as a tag with its keyword kept as-is, so tags set by another client or a Sieve script can be given a name and color. |
| MK-6.5 🟩 Implemented | Any non-system keyword on a message shall be visible in the row and in the message view, using its definition when one exists and a neutral rendering named from the keyword otherwise, so tags set in Nextcloud Mail or Thunderbird custom tags are never invisible. A row shows them as Thunderbird's cards-view tag stack (`thread-card-tags`): up to three overlapping tag icons in the tags' colors, defined tags first in definition order, later icons drawn over earlier ones, then `+N`; the stack's label names every tag. The stack is the row's tag control — the first item of the hover overlay, visible at rest while the row is tagged and as a hollow tag icon on hover otherwise — and clicking it opens the tag menu. The message view shows named chips. Hidden system keywords (see "System keywords" above) render only once a definition names them, and reserved ones never do, whatever their case. |
| MK-6.6 🟩 Implemented | Tags shall be set and cleared through `setKeywordsMany`, from one tag menu reached three ways: the row's tag stack (a popover, since a virtualized row cannot host a `<details>`), a Tag action in the multi-select toolbar (a dropdown; overflowing into More opens the same popover), and the open message's tag stack in the reading toolbar after Forward (the header lists its tags as removable chips), which is also how a single message is tagged below the hover breakpoint. The menu offers Remove All Tags (while any target carries one), every defined tag as a tri-state checkbox over the targets (checked, mixed, unchecked; toggling adds unless every target has it), the targets' keywords without a definition under Other keywords, and Manage Tags…, which opens the tag manager (MK-6.7), where new tags are defined. It opens with focus on its first item; while it has focus, 1–9 toggle the tag with that digit, 0 removes every tag, as in the list (MK-4.2), and T closes it. It is as tall as its contents, scrolling only when the viewport cannot fit it above or below its anchor. Actions apply at once and keep the menu open. The message list has no tag filter; the sidebar's tag views (MK-3.4) list a tag's messages. |
| MK-6.7 🟩 Implemented | Tags shall be managed in their own modal, the tag manager, reached from the sidebar's Tags heading and from every tag menu's Manage tags…; the Settings dialog does not host it. It lists the definitions in order with color (native color input), name (committed on blur or Enter), the immutable keyword, the digit that toggles it, move up/down and delete, under a New Tag form at the top that previews the derived keyword; focus opens in that form's name field. Definitions stay in the `messageTags` setting (specs/006). |

## Normative UX decisions and rejected alternatives

- **Overlay on the summary line, not a pushed layout.** Shoving the avatar
  and text aside on hover was prototyped and rejected: the row jitters and
  the set star had no stable home. Overlaying the star slot and date keeps
  the star at rest and on hover in one place (Fastmail's pin behaves the
  same way).
- **Star on the Starred filter for the beacon.** Beacon dots need a visible
  anchor (`elementFromPoint` hit test); the row star fails that until
  hover, so the dot sits on the filter that the star feeds.
- **No star in the open-message toolbar.** Considered and dropped; the list
  is where the eye is, and `S` covers the keyboard.
- **Dense local Starred filter first, cross-folder view later.** The filter
  reuses the Unread machinery; the view is a follow-up (MK-3.4) and is
  itself a local read, since every list Stormbox paints comes from the
  cache.
- **Thunderbird-compatible tags.** A fixed default set or custom-only tags
  were both rejected: the point of keywords is that they survive a change
  of client, so the defaults are Thunderbird's and custom ones derive their
  keywords the way Thunderbird does.
- **No tag filter in the list header; tags as icons, not named chips.**
  A per-folder tag filter duplicated the sidebar's cross-folder tag views,
  and named chips on a row competed with the subject or the preview for
  width. The row carries Thunderbird's cards-view tag stack instead: color
  at a glance in a fixed slot, names in its label and in the open message.
- **Tags in the open message, star not.** The star stays out of the
  reading toolbar (MK-2.6) because the list covers it; the Tags row is the
  only single-message path below the hover breakpoint, and its chips are
  where a reader sees what a message is tagged.
- **Toggles apply at once; no Apply button.** A checkbox menu that needs a
  confirming click (Fastmail's `L` menu) is a recurring complaint; the
  menu stays open so several tags can be set in one visit.
- **Undefined keywords stay visible.** Nextcloud Mail, Thunderbird custom
  tags and Sieve scripts set keywords Stormbox has no definition for; a
  neutral chip and an Other keywords group keep them removable and
  adoptable rather than silently hidden, which is Thunderbird's
  long-standing gap (bug 731143).

## Verification map

- Unit: `tests/unit/stores/mail-store.test.ts` covers `setKeywordsMany`
  skipping unchanged rows, one batch and one outbox row per write,
  `markManyFlagged` both ways, the modal `toggleManyFlagged`, the scheduled
  skip, and `selectAllLoadedMessages` under `flaggedOnly` and combined
  filters. `tests/unit/components/message-list-bulk-actions.test.ts` pins
  the Star slot, its modal label, and the Starred filter's effect on rows
  and select-all. `tests/unit/composables/useThunderbirdShortcuts.test.ts`
  pins `S` in both schemes. `tests/unit/components/feature-beacon-layer.test.ts`
  and `app-layout.test.ts` include the `starMessages` beacon.
  `tests/unit/components/message-list-row-baseline.test.ts` snapshots the
  row overlay markup.
- Browser (Verified Consistency): `tests/e2e/star-message.spec.js` seeds
  mail on the server, stars from the hover overlay, bulk-stars two rows,
  filters to Starred, unstars with `S`, and asserts the row state, the
  cache's `is_flagged` through `window.__repo`, and the server's
  `Email.keywords.$flagged` after the outbox drains, in Chromium and
  Firefox. `tests/e2e/feature-beacons.spec.js` counts the new beacon.
- Tags, unit: `tests/unit/utils/message-tags.test.ts` (keyword grammar,
  derivation, system keywords, definition validator, defaults),
  `tests/unit/stores/mail-store.test.ts` "tags" (lowercase compare and
  wire, cased-spelling removal, system-keyword guard, scheduled skip,
  `toggleTagMany`, `clearTagsMany` from the caller's rows),
  `tests/unit/sync/jmap-outbox.test.ts` (lowercase on the wire),
  `tests/unit/components/tag-picker.test.ts` (tri-state, in-menu digits,
  Other keywords, Remove All Tags, dropdown trigger and focus, row tag
  stack and `+N`), `message-list-tag-chips.test.ts` (stack in a mounted
  list, popover toggle and focus), `message-list-header.test.ts`
  (overflow ranks, tiers),
  `message-view.test.ts` (Tags row), `useThunderbirdShortcuts.test.ts`
  (digits, `0`, `T`, hints), `tag-definitions-editor.test.ts`,
  `tag-manager-dialog.test.ts` (own modal, focus, dismissal, shortcuts
  held), `tests/unit/db/handlers.test.ts` (`message.listKeywords`).
- Tag views, unit: `tests/unit/stores/mail-store.test.ts` "tag views"
  (ids, synthetic folder, loading and broadcast reload, refused filing,
  counts and coverage), `tests/unit/db/handlers.test.ts`
  (`message.listForKeyword` / `countForKeyword`),
  `tests/unit/components/folder-tree.test.ts` "Tags section" (rows,
  pick, drop-to-tag), `message-list-header.test.ts` (bulk actions without
  filing).
- Tag views, browser: `tests/e2e/tag-view.spec.js` tags mail in Inbox and
  Archive on the server, opens the Personal view from the sidebar, asserts
  both rows, the absence of filing controls, the cache's
  `listMessagesForKeyword`, removes the tag from the open message and
  asserts the row leaves, the sidebar count drops and the server agrees,
  in Chromium and Firefox.
- Tags, browser (Verified Consistency): `tests/e2e/tag-message.spec.js`
  seeds mail on the server, tags from the row menu, bulk-tags two rows
  from the toolbar menu, presses `2`, removes a tag from the open
  message's chips, presses `0`, uses Remove All Tags from a row's stack,
  and asserts the row's tag stack, the cache's `keywords_json` through
  `window.__repo`, and the server's `Email.keywords` after the outbox
  drains, in Chromium and Firefox. It uses the default tags so no
  definition is written to the account.

## Non-goals

- Server-side (JMAP) search by keyword; every filter and view reads the
  local cache. A tag view covers the signed-in account only and lists at
  most 2000 rows.
- Per-folder or per-account tag definitions; tags are per user.
- Reproducing Thunderbird's legacy modified-UTF-7 keyword encoding;
  new keywords use lowercase UTF-8 hex escapes as described in MK-6.3.
- Presenting `$important` as an importance marker; it is a hidden system
  keyword unless the user defines a tag over it.
- Aliasing Evolution's `$labelimportant`…`$labellater` onto the default
  `$label1`–`$label5` tags.
- Stripping a deleted tag's keyword from the messages that carry it.
- Managing the Sieve scripts that could set tags on delivery (RFC 5232
  `imap4flags`; Stalwart exposes them over RFC 9661). Keywords a script
  sets arrive through the ordinary `Email/changes` refresh and render as
  tags, defined or not.

## Implementation map

- Store: `setKeywordsMany`, `markManyFlagged`, `toggleManyFlagged`,
  `setTagsMany`, `toggleTagMany`, `clearTagsMany`,
  `selectAllLoadedMessages({ flaggedOnly })` in
  `src/stores/mail-store.ts`; lowercase on the wire in
  `src/sync/backends/jmap/outbox/operations/set-keywords.ts`.
- Tag model: `src/utils/message-tags.ts` (system keywords, defaults,
  palette, derivation, validator, `tagKeywordsOf`, `resolveMessageTags`,
  `tagPresence`); definitions via `useMessageTags` over the `messageTags`
  setting (`src/constants/settings.ts`).
- Row: `.msg-list__actions` / `.msg-list__action--star` /
  `.msg-list__action--tag` (the tag stack, `MessageTagStack.vue`, after
  Thunderbird's `thread-card-tags` and `tag-sm.svg`), in
  `src/components/MessageListRow.vue`; open-message chips in
  `MessageTagChip.vue`.
- Tag menu: `TagPickerPanel.vue` (contents), `TagPickerDropdown.vue`
  (toolbar and open-message trigger), `TagPickerPopover.vue` (rows and
  the More menu), wired in `MessageList.vue` and `MessageView.vue`.
- Toolbar: `.msg-list__bulk-action--star` and the `tag` slot in
  `src/components/MessageBulkActions.vue`; `useBulkActionItems`.
- Filters: `flaggedOnly` in `src/composables/useMessageListFilters.ts`;
  `.msg-list__filter--starred` in `src/components/MessageList.vue`.
- Tag views: `isTagViewId`, `tagViewIdFor`, `tagViewKeyword`, `loadTagView`,
  `tagCounts`, `tagViewCoverage`, `rejectTagViewSource` in
  `src/stores/mail-store.ts`; `message.listForKeyword` /
  `message.countForKeyword` in `src/db/handlers.ts`; the sidebar section in
  `src/components/FolderTree.vue` with `TagViewNode.vue`; `fileActions` in
  `useBulkActionItems`, `deleteAction` / `draggable` on `MessageListRow.vue`.
- Tag manager: `src/components/tags/TagManagerDialog.vue` with
  `TagDefinitionsEditor.vue`; `message.listKeywords` in
  `src/db/handlers.ts`; the sidebar heading and "Manage tags…" reach it
  through `useTagManagerRequest`.
- Shortcuts: `toggleStar`, `toggleTag`, `clearTags`, `openTagMenu` in
  `src/constants/shortcuts.ts` and
  `src/composables/useThunderbirdShortcuts.ts`.
- Beacons: `starMessages`, `tagMessages` in
  `src/constants/feature-beacons.ts`; `SPOTLIGHT_TARGETS.starredFilter`,
  `.tagsFilter`; reveal in `src/App.vue`.

## References

### Unicode names and persistence review (2026-09-22)

- [RFC 8621 §4.1.1](https://www.rfc-editor.org/rfc/rfc8621.html#section-4.1.1) restricts wire keywords to 1–255 printable ASCII characters, excluding atom-specials. This is not a restriction on the separate display name.
- [Stalwart keyword implementation](https://github.com/stalwartlabs/stalwart/blob/main/crates/types/src/keyword.rs) uses `MAX_LENGTH = 128` and truncates longer custom keywords. Generated keys stay within that stricter bound; truncation collisions use the existing numeric suffix mechanism.
- [Thunderbird nsMsgTagService](https://github.com/mozilla/releases-comm-central/blob/master/mailnews/base/src/nsMsgTagService.cpp) preserves Unicode display names separately and now encodes unsafe UTF-8 bytes as lowercase hex escapes. [Bug 650623](https://bugzilla.mozilla.org/show_bug.cgi?id=650623) documents why lowercasing the former modified UTF-7 encoding corrupts international names. Stormbox uses the standard `TextEncoder`; no codec dependency is needed. Existing keywords are not migrated.
- [Nextcloud Mail validation](https://github.com/nextcloud/mail/blob/main/src/util/tag.js) permits Unicode names and reports validation errors. Its [TagsController](https://github.com/nextcloud/mail/blob/main/lib/Controller/TagsController.php) caps display names at 128 characters using `mb_strlen`. Stormbox retains its existing 100-character product limit, counted as Unicode code points rather than UTF-16 units. This cap is independent of the encoded keyword limit; combining marks count individually.
- Imported keywords retain the RFC's 255-byte allowance; the 128-byte server cap applies only to newly generated keywords. Adopting a keyword longer than the display-name limit opens the existing name form and requires an explicit valid name, without shortening the keyword. Collision suffixes are appended only after complete encoded code-point chunks.
- Definition writes snapshot all primitive fields before reaching the settings repository's MessagePort. Editor tests enforce structured cloning so a reactive object cannot silently bypass the worker boundary in mocks.

- RFC 8621 §4.1.1, `Email.keywords`; RFC 9979 §3, `$MailFlagBit0–2`.
- Thunderbird tag model: `nsMsgTagService` (`$label1`–`$label5` defaults,
  keyword derivation, rename keeps the key); bug 731143 (undefined
  keywords are not shown).
- Stalwart: custom keywords capped at 128 characters and 99 distinct per
  account in its keyword cache, compared case-sensitively.
- Issue #56.
