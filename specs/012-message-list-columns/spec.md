# Message List Columns — Design Note

The mail space shows one to eight message lists side by side, each bound
to a folder. This note records the component and state model chosen for
that feature and why; product behaviour follows R-2.x / R-3.x in
`specs/001-mvp-scope/spec.md`, which every column must honour identically.
The constitution's invariants (cache-first reads, one mutation pipeline,
stable surfaces) remain controlling.

**Implementation scope**: Vue 3 + Pinia, browser-local SQLite, JMAP Mail.

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
  `quickFilterQuery`, `canAddColumn`. Renders a title row (static folder
  title + `+` for the primary column; folder dropdown + `×` otherwise),
  the shared `SelectableListHeader` / `MessageBulkActions` header and the
  virtualised `MessageListRow` list. It is also the drop target for rows
  dragged from another column (`useMessageDropTarget`). Row DOM ids are
  prefixed with `listId` so `aria-activedescendant` stays unique when two
  columns show one folder.
- `MessageColumns.vue` — the columns area: renders one `MessageList` per
  column with keyboard-operable resizers between them, owns add/remove and
  focus hand-off, scrolls horizontally when the columns do not fit, and
  publishes the area width App's grid uses.
- `App.vue` places `MessageColumns` where the single list was; the grid
  track is `minmax(280px, <sum of column widths>)`, which the grid caps so
  the reading pane keeps its minimum width.
- `FolderTree.vue` highlights `currentFolderId` and calls `selectFolder`;
  `MessageView.vue` reads `openMessage` / `openMessageFolder`; the shortcut
  composable routes list commands to the column whose folder owns the
  selection, cursor or open message, falling back to the primary column.

## Sync

- `_refreshActiveQueryViews` reconciles the inbox, the recently synced
  views, and every folder the UI pinned through `sync.setActiveFolderViews`.
- `OUTBOX_APPLY_MOVE_BATCH` places a moved message into the destination
  view's cached head range when its sort key falls inside it (or the view
  is fully cached), so both columns repaint from SQLite; otherwise the view
  is marked stale as before and refetches on next read.

## Decisions

- Two columns may show the same folder; they share selection, cursor and
  open-message highlight because those are folder-keyed.
- Re-picking the primary folder in the sidebar clears that folder's
  selection and open message (existing behaviour) and scrolls the column
  to the top.
- Column widths are clamped to 280–720px. When the area is short of room
  the columns give way proportionally down to 280px before the area
  scrolls, so one column never overflows a narrow window; the last column
  stretches when the reading pane is hidden so a single column still
  fills the width.
- The pinned-folder set is the last one a tab sent; two tabs with different
  columns on one origin race, and the losing tab's extra folders fall back
  to recency-based refresh.

## Verification map

- Unit: `tests/unit/stores/message-columns-store.test.ts` (config, limit,
  persistence, remote-id resolution), `tests/unit/components/message-columns.test.ts`
  (add/remove/focus, primary follows the folder list, opening from another
  column, cross-column drop and same-folder no-op, unique DOM ids, shortcut
  routing), `tests/unit/stores/mail-store.test.ts` "per-folder views"
  (bound views, broadcast refresh, folder-keyed selection and open message,
  cache-only repaint after a move), `tests/unit/sync/jmap-backend.test.ts`
  (pinned view refresh), `tests/unit/sync/outbox-effects.test.ts` (local
  placement and the stale fallback), `tests/unit/components/responsive-css.test.ts`
  (title-row corner controls, single-column snapping), and the updated
  MessageList, MessageView and shortcut tests (folder-specific actions).
- Browser: `tests/e2e/message-columns.spec.js` adds a column, moves by drag
  and drop across columns with UI, cache and server assertions, checks the
  same-folder no-op and persistence across reload, on Chromium and Firefox.
