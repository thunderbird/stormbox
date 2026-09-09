# Message Keywords: Stars and Tags — Product and Engineering Specification

This specification defines how Stormbox reads and writes JMAP `Email`
keywords that the user controls directly: the star (`$flagged`) and, as a
planned extension, tags (Thunderbird-compatible user keywords). It refines
the message-list requirements in `specs/001-mvp-scope/spec.md`, in
particular R-2.8 (filters), R-3.6 (multi-select), R-3.17 (batched keyword
mutations), and R-10.3 (the single-column layout), and it adds one beacon
to the round described in `specs/010-onboarding/spec.md` (OB-4.1).

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

Keywords the client manages on the user's behalf and never shows as tags:
`$seen`, `$flagged`, `$draft`, `$answered`, `$forwarded`, `$junk`,
`$notjunk`, `$phishing`, `$recent`, `$mdnsent`, `$deleted`, `$has_cal`.

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
| MK-1.5 ⬜ Planned | Keywords shall be normalized to lowercase before comparison and before being sent, since RFC 8621 requires servers to return them lowercase but Stalwart stores unknown keywords verbatim. |

### 2. Starring in the message list

| ID / Status | Requirement |
|:--|:--|
| MK-2.1 🟩 Implemented | In layouts at or above the single-column breakpoint (640px, R-10.3), hovering a message row shall overlay three pointer-only controls on the inline-end of the row's summary line: Star, Archive and Delete, each 34×28px, over the reserved star slot and the date. The overlay shall sit on the row's own background so the text beneath does not show through, and shall leave the preview line below uncovered. The buttons shall not be Tab stops, and clicking one shall neither select nor open the row. |
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
| MK-3.4 ⬜ Planned | A cross-folder `Starred` view (every starred message in the account regardless of folder) shall be a folderless query view with a `hasKeyword: $flagged` filter, and per-tag views shall follow the same shape. Blocked on the reference server: Stalwart ignores `hasKeyword` when combined with `inMailbox` (stalwart discussion #2916); the folderless form is unaffected but the work is deferred until the in-folder form can be verified against the same server. |

### 4. Keyboard

| ID / Status | Requirement |
|:--|:--|
| MK-4.1 🟩 Implemented | `S` shall toggle the star in both shortcut schemes (`toggleStar` in `src/constants/shortcuts.ts`), matching Thunderbird desktop. It acts on the checkbox selection when there is one, otherwise on the open message, with the same modal rule as MK-2.4, and is inert in a text field. |
| MK-4.2 ⬜ Planned | `1`–`9` shall toggle the nth tag in definition order and `0` shall clear all tags on the target, as in Thunderbird. |

### 5. Announcement

| ID / Status | Requirement |
|:--|:--|
| MK-5.1 🟩 Implemented | The starring feature shall be announced with one beacon, `starMessages`, in the current round (OB-4.1). Because the row star is hidden until hover, the dot sits on the always-visible `Starred` filter; revealing it from the pill switches to Mail and, in the single-column layout, closes the open message so the list header is on screen. The Welcome modal is unchanged. |

### 6. Tags

| ID / Status | Requirement |
|:--|:--|
| MK-6.1 ⬜ Planned | Stormbox shall ship the five Thunderbird default tags with Thunderbird's keywords and colors: `$label1` Important `#FF0000`, `$label2` Work `#FF9900`, `$label3` Personal `#009900`, `$label4` To Do `#3333FF`, `$label5` Later `#993399`. |
| MK-6.2 ⬜ Planned | Tag definitions (`keyword`, `name`, `color`, `order`) shall live in universal settings (`specs/006-user-settings/spec.md`) under one `messageTags` key so they follow the user across devices. One key means last-write-wins at list granularity: two devices editing different tags at once resolve to the later writer. Accepted for simplicity. |
| MK-6.3 ⬜ Planned | A new tag's keyword shall be derived once from its name: lowercase, drop characters JMAP forbids and any outside printable ASCII, cap at 128 characters (Stalwart's limit), reject empty, and disambiguate against existing keywords with a numeric suffix. Keywords are immutable once created; renaming a tag changes only its name, as in Thunderbird, so messages tagged from other clients keep matching. |
| MK-6.4 ⬜ Planned | Deleting a tag definition shall remove the definition only. Messages carrying the keyword keep it and render it as an undefined tag named from the keyword; stripping the keyword from messages is a separate, explicit action. |
| MK-6.5 ⬜ Planned | Any non-system keyword on a message shall render as a tag chip in the row and in the message view, using its definition when one exists and a neutral chip named from the keyword otherwise, so tags set in Nextcloud Mail or Thunderbird custom tags are never invisible. |
| MK-6.6 ⬜ Planned | Tags shall be set and cleared through `setKeywordsMany`, from a tag menu on the row overlay and the multi-select toolbar, and filtered with a per-tag dense local filter in the header alongside Unread and Starred. |

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
  reuses the Unread machinery and sidesteps the reference server's
  `inMailbox`+`hasKeyword` bug; the view is a follow-up (MK-3.4).
- **Thunderbird-compatible tags.** A fixed default set or custom-only tags
  were both rejected: the point of keywords is that they survive a change
  of client, so the defaults are Thunderbird's and custom ones derive their
  keywords the way Thunderbird does.

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

## Non-goals

- Server-side (JMAP) search by keyword; Starred is local to the open
  folder until MK-3.4.
- Per-folder or per-account tag definitions; tags are per user.
- Reproducing Thunderbird's modified-UTF-7 keyword encoding for non-ASCII
  tag names; non-ASCII is dropped from the derived keyword instead.
- `$important` handling beyond rendering it as an ordinary tag.

## Implementation map

- Store: `setKeywordsMany`, `markManyFlagged`, `toggleManyFlagged`,
  `selectAllLoadedMessages({ flaggedOnly })` in `src/stores/mail-store.ts`.
- Row: `.msg-list__actions` / `.msg-list__action--star` in
  `src/components/MessageListRow.vue`.
- Toolbar: `.msg-list__bulk-action--star` in
  `src/components/MessageBulkActions.vue`, wired in `MessageList.vue`.
- Filter: `flaggedOnly`, `toggleFlaggedFilter`, `.msg-list__filter--starred`
  in `src/components/MessageList.vue`.
- Shortcut: `toggleStar` in `src/constants/shortcuts.ts` and
  `src/composables/useThunderbirdShortcuts.ts`.
- Beacon: `starMessages` in `src/constants/feature-beacons.ts`;
  `SPOTLIGHT_TARGETS.starredFilter`; reveal in `src/App.vue`.

## References

- RFC 8621 §4.1.1, `Email.keywords`.
- Thunderbird tag model: `nsMsgTagService` (`$label1`–`$label5` defaults,
  keyword derivation, rename keeps the key).
- Stalwart discussion #2916: `Email/query` ignores `hasKeyword` combined
  with `inMailbox`.
- Issue #56.
