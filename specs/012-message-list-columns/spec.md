# Message List Columns

The mail space shows one to eight message lists side by side, each bound
to a folder. This specification records the component and state model for
that feature; product behaviour follows R-2.x / R-3.x in
`specs/001-mvp-scope/spec.md`, which every column must honour identically.
The constitution's invariants (cache-first reads, one mutation pipeline,
stable surfaces) remain controlling.

**Implementation scope**: Vue 3 + Pinia, browser-local SQLite, JMAP Mail.

## Behavior

- The first column follows the folder list and has no folder picker.
  Columns two through eight choose any folder shown in that list: primary
  system folders plus subscribed primary and shared-account folders. A new
  or unresolved column starts in a "Choose a folder…" state.
- The primary column's `+` appends a column and moves focus to its folder
  picker. Each additional column has a `×`; removing one moves focus to
  the neighboring column control. The add control is disabled with an
  explanatory title at eight columns.
- Every column uses the same virtualized list, filters, select-all,
  multi-select, bulk and row actions, count, refresh, keyboard navigation,
  placeholders, body prefetch, and scroll memory. Folder-specific actions
  use that column's folder: Archive is absent in Archives, Not junk is
  limited to the primary account's Junk folder, and pending scheduled mail
  offers Cancel send.
- Opening a row identifies its source folder without changing the first
  column or sidebar selection. Clicking the open row closes it; checking
  rows hides the reading pane, and one checkbox selection exists across
  all columns.
- Messages drag between columns and to the folder list using the source
  and destination folders' transfer rules. A same-folder drop has no
  highlight and queues no mutation.
- Message shortcuts target the folder owning the checked rows, then the
  focused or open message. If two columns show that folder, list navigation
  targets the column holding keyboard focus.
- Every visible folder is pinned for push catch-up. A completed move
  repaints its source and destination columns from the local cache.
- Column folders and widths persist per account by remote account and
  mailbox identifiers. Widths clamp to 280–720px and shrink toward their
  minimum before the area scrolls.
- At 639px or below, each column occupies one screen and the scrollbar is
  hidden; returning from the reading view restores the column from which
  the message was opened.
- Columns have distinct region labels and prefix row and listbox DOM IDs.
  Folder and More menus expose keyboard navigation, labelled groups,
  visible focus, and focus return. At the reading pane's 240px minimum all
  toolbar actions remain reachable, and compact rows reserve the star on
  the sender line rather than over the subject.

## State model

| Concern | Where it lives | Shape |
|:--|:--|:--|
| Per-folder message window | `mail-store` `folderStates: Map<folderId, FolderCache>` (existing cache) | Each `FolderCache` gains a reactive `view` (`messages`, `total`, `isLoading`) that any column binds to through `folderView(folderId)`. `messages` / `totalForFolder` / `isLoading` stay as writable aliases of the primary column's view. |
| Bound folders | `mail-store` `boundFolderIds` (ref-counted by `bindFolderView`) | Drives broadcast re-reads (`refreshLoadedPages` runs for every bound folder) and the worker pin (`setActiveFolderViews`) so push refresh includes every displayed folder. |
| Primary column folder | `mail-store` `currentFolderId` | Unchanged meaning: what the sidebar highlights and `selectFolder` sets. |
| Selection | `mail-store` `selection = { folderId, ids }` | One checkbox selection across all columns. `selectedIds` is a writable alias; `setSelection(folderId, ids)` claims the folder. Columns read a folder-scoped view of it. |
| Open message / cursor | `mail-store` `{ id, folderId }` pairs (`selectedMessageId` + `selectedMessageFolderId`, `focusedMessageId` + `focusedFolderId`) | `selectMessage(id, folderId)` records the source folder; `openMessage` resolves the row from that folder's view. |
| Column configuration | `message-columns-store` | Ordered extra columns `{ id, folder: { accountRemoteId, mailboxRemoteId } \| null, width }` plus the primary width, persisted per account in `localStorage` (`stormbox.messageColumns.v1:<serverOrigin>|<remoteAccountId>`). Folders are stored by JMAP mailbox id so a cache reset does not lose them. |

Why one store: the caching rules (positional windows, painted ranges,
single-flight page loads, stale detection, drift repair) already live in
`FolderCache`. Making the cache's projection reactive per folder is a
smaller change than a second cache, and it lets the primary column be
"a column whose folder is `currentFolderId`" with no special casing.

## Components

- `MessageList.vue` — one column. Props: `folderId`, `listId`, `primary`,
  `columnIndex`, `quickFilterQuery`, `canAddColumn`. Renders the shared
  one-row `SelectableListHeader` (see "Header" below) and the virtualised
  `MessageListRow` list; its filters live in `useMessageListFilters`, its
  virtualiser, window fetch and scroll memory in `useMessageListViewport`,
  and the header's tiers and More menu model in `useMessageListHeader`.
  It is also the drop target for rows dragged from another column
  (`useMessageDropTarget`). Row DOM ids are prefixed with `listId` so
  `aria-activedescendant` stays unique when two columns show one folder.
- `MessageListHeaderTitle.vue` — the folder at the start of the header
  row: a static title on the primary column, the folder dropdown (listbox
  of the folder list's folders with icons and labelled account groups) on
  the others; the row's only flexible item, so its name truncates. The
  panel is at least as wide as its trigger.
- `MessageListMoreMenu.vue` — the header's overflow menu (`role="menu"` on
  `AppDropdown`, groups as `role="group"` labelled by their heading, items
  with roving `tabindex="-1"`, arrow/Home/End through `useMenuKeyboard`,
  Tab closes the panel; focus returned to the trigger). `MessageBulkActions.vue`
  renders the action list `useBulkActionItems` builds; `splitBulkActions`
  decides which actions stay in the row.
- `MessageColumns.vue` — the columns area: renders one `MessageList` per
  column with keyboard-operable resizers between them, owns add/remove and
  focus hand-off, releases a folder's open message, cursor and checked rows
  when its last column stops showing it (`releaseFolderInteractions`),
  scrolls horizontally when the columns do not fit, and after the
  single-column reading view closes scrolls back to the column the message
  was opened from (`lastActiveColumnId`).
- `App.vue` places `MessageColumns` where the single list was; the grid
  track is `minmax(280px, <sum of column widths>)`, which the grid caps so
  the reading pane keeps its minimum width, and the folder list is clamped
  to leave every open column its minimum.
- `FolderTree.vue` highlights `currentFolderId` and calls `selectFolder`;
  `MessageView.vue` reads `openMessage` / `openMessageFolder`; the shortcut
  composable routes list commands to the column whose folder owns the
  selection, cursor or open message — the one holding keyboard focus when
  two columns show that folder — falling back to the primary column.

## Header

One row at every column width and in every state; nothing wraps. Normal
state, left to right: select-all, folder title or dropdown (flexible,
truncating), Unread and Starred, total count, Refresh, `+` or `×`, More.
Tiers by measured list width (`useMessageListHeader`): the count hides
below 520px, the filters turn icon-only below 440px, Refresh and `+`/`×`
move into the More menu below 340px. While rows are checked: select-all,
the bulk actions that fit (Delete or Cancel send and Clear always;
"Not junk" while it fits; the rest leave in the order Mark as unread,
Mark as read, Junk, Star, Archive), "N selected", More (holding the
overflowed actions, Refresh and the column control under the folder's
name). A column without a folder shows a disabled select-all, the dropdown,
and its `×`. The list's grid track is the column's width so the nowrap
header can never widen a column. Escape on an open dropdown closes it
without clearing the selection. When a row removal takes the focused
element with it, the list itself takes focus rather than the document body.

## Sync

- `_refreshActiveQueryViews` reconciles the inbox, the recently synced
  views, and every folder the UI pinned through `sync.setActiveFolderViews`;
  a folder that has just been pinned is reconciled at once. Every writer of
  a view's positions and query state — catch-ups, foreground page loads,
  the metadata indexer, the Sent ranking pager — runs behind
  `_withViewRefreshLock`.
- `syncFolderWindow` brings a view's cached positions forward with
  `Email/queryChanges` before writing a page fetched under a newer query
  state; when the server cannot calculate the delta, the page is written
  alone and the other positions are dropped (`dropOtherPositions`,
  reported as `resetOtherPositions`). The indexer treats such a page as
  no progress unless coverage grew, and backs the folder off.
- Every positional shift of `query_view_items` transforms
  `query_view_ranges` the same way (`shiftViewRangesForInsert`,
  `shiftViewRangesForRemovals`), so coverage never claims a position that
  now holds another message.
- `OUTBOX_APPLY_MOVE_BATCH` places a moved message into the destination
  view's cached head range when its sort key falls strictly inside it (or
  the view is fully cached), so both columns repaint from SQLite; a tie on
  the sort key, or a key past the cached prefix, marks the view stale as
  before and it refetches on next read. Cross-account copies invalidate
  the destination view rather than placing against another account's
  cached ordering.
- A manual refresh runs once per folder at a time; two columns' Refresh
  controls share one run.

## Decisions

- Two columns may show the same folder; they share selection, cursor and
  open-message highlight because those are folder-keyed.
- Re-picking the primary folder in the sidebar clears that folder's
  selection and open message (existing behaviour) and scrolls the column
  to the top.
- The primary column starts at the width the single list had before
  columns existed (`stormbox.mailColumnWidths.v1.messageList`) when the
  account has no stored layout yet.
- Column widths are clamped to 280–720px. When the area is short of room
  the columns give way proportionally down to 280px before the area
  scrolls, so one column never overflows a narrow window; the last column
  stretches when the reading pane is hidden so a single column still
  fills the width.
- The pinned-folder set is the last one a tab sent; two tabs with different
  columns on one origin race, and the losing tab's extra folders fall back
  to recency-based refresh.
- The feature adds no database migration. Folder pins are in memory, and
  local placement and coverage use the existing query-view tables.

## Verification map

- Unit: `tests/unit/stores/message-columns-store.test.ts` (config, limit,
  persistence, remote-id resolution), `tests/unit/components/message-columns.test.ts`
  (add/remove/focus, primary follows the folder list, opening from another
  column, cross-column drop and same-folder no-op, unique DOM ids, shortcut
  routing), `tests/unit/stores/mail-store.test.ts` "per-folder views"
  (bound views, broadcast refresh, folder-keyed selection and open message,
  cache-only repaint after a move), `tests/unit/sync/jmap-backend.test.ts`
  (pinned view refresh and serialized view writers),
  `tests/unit/sync/outbox-effects.test.ts` (local placement, ambiguous
  sort-key placement, and the stale fallback), `tests/unit/db/handlers.test.ts`
  (coverage ranges follow positional shifts),
  `tests/unit/sync/jmap-messages.test.ts` (positions brought forward or
  dropped before a page write), `tests/unit/sync/jmap-indexer.test.ts`
  (coverage-based progress and reset backoff),
  `tests/unit/components/message-list-header.test.ts` (header tiers in the
  normal and bulk states, More menu semantics, focus hand-over, Escape
  keeps the selection), `tests/unit/components/responsive-css.test.ts`
  (one-row header, single-column snapping), and the updated MessageList,
  MessageView and shortcut tests (folder-specific actions).
- Browser: `tests/e2e/message-columns.spec.js` adds a column, moves by drag
  and drop across columns with UI, cache and server assertions, checks the
  same-folder no-op and persistence across reload; opens and deletes from
  another column while the primary column and the folder list stay put;
  round-trips the single-column layout; and checks the narrow one-row
  header with Refresh and `×` in the More menu. Chromium and Firefox.
