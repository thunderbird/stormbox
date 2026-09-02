# Staff Kanban board (feature-flagged)

A staff-only, opt-in Kanban view of the mailbox: column one follows the
sidebar like the plain message list does, columns two and three show any
folder the user picks (a pick that is currently the sidebar folder is
shadowed, not shown twice). Rows are the shared `MessageListRow`, dragging a
row between columns moves the message, the two handles between columns
resize them (persisted per account), and opening a row hides the rightmost
column so `MessageView` fits beside the other two. Only the message being
read is highlighted; a column's keyboard cursor is exposed through
`aria-activedescendant` but not painted.

Each column multi-selects like the plain list (checkbox, Shift/Ctrl click,
Space, Shift+Arrow, Ctrl+A, Esc) and its header turns into the same bulk
toolbar (`MessageBulkActions`). The board holds one selection at a time,
keyed by folder; checking a row in another column replaces it, and a
selection hides the reading pane exactly as the list's does. Dragging a
checked row carries the whole selection; bulk actions and drops refresh
every column showing the source or destination folder.

The feature is off for everyone until the account enters the code `kanban`
in the gear dialog (`StaffGearButton`, visible only when `authStore.isStaff`).
With the flag off, nothing in Stormbox changes.

## Layout

| File | Role |
| --- | --- |
| `kanban-store.ts` | Pinia store; `unlocked` / `enabled` / column picks persisted in `localStorage` per account (`stormbox.kanban.<accountId>.v1`); column widths (`stormbox.kanban.columnWidths.v1`) and `compactBoardWidth`, which `App.vue` reads to size the shell grid; the in-memory board selection (`selectionFolderId` / `selectedIds`). |
| `StaffGearButton.vue` | Gear in the top bar; opens the dialog, fires the first-unlock celebration (fireworks + clip + docked volume pill) and seeding. |
| `KanbanUnlockDialog.vue` | Code textbox until unlocked, then an on/off switch. |
| `KanbanBoard.vue` | Three `KanbanColumn`s, the primary one bound to the sidebar's folder (board-driven `selectFolder` calls made to open a row are skipped), folder resolution by JMAP mailbox id, open-message flow, resize handles via `useColumnResize`; the hidden third column is paused in compact mode. |
| `KanbanColumn.vue` | One folder's rows (virtualised), `SelectableListHeader` (title or picker, filter-aware count; bulk toolbar while rows are checked), selection via `useListSelection` mirrored into the store, keyboard cursor (Arrow/Home/End/Enter; owns the f/b/n/p shortcuts once focused), drop target; `shadowed` empties it when its pick is the primary folder. |
| `KanbanColumnPicker.vue` | Folder dropdown; excludes the folders the other columns show; "Leave empty" clears the slot. |
| `useFolderWindow.ts` | Cache-first pager for a folder that is not the store's current folder, refreshed on `MESSAGES` broadcasts; can be paused; Quick Filter scans are capped at `QUICK_FILTER_MAX_ROWS`. |
| `kanban-seed.ts`, `kanban-seed-data.ts` | One-time creation of "Needs Reply" (15) and "Blocked" (23) with static sample mail via the `CREATE_EMAILS` outbox operation. A folder is seeded at most once (server counts are refreshed first); a failed seed can be retried from the dialog. |
| `celebration/` | Fireworks canvas (skipped under `prefers-reduced-motion`), `mm.mp3` playback with a persisted volume (`stormbox.kanban.celebrationVolume.v1`), and the `CelebrationVolume` pill shown until both have finished. |

## Touch points outside this directory

- `src/App.vue`: lazily renders `StaffGearButton` (staff only) and swaps
  `MessageList` for `KanbanBoard` while `kanbanStore.enabled`; in compact
  mode the shell's list track is `kanbanStore.compactBoardWidth` and the
  message-view resizer is dropped (the board's own handles size the pane).
- `src/composables/useColumnResize.ts`: the shell's resizer logic, extracted
  so the board's handles behave like the sidebar / message-view ones.
- `src/constants/states.ts`: `MUTATION_TYPE.CREATE_EMAILS`,
  `CREATE_EMAILS_PHASE` and its `MUTATION_RECOVERY_POLICIES` entry.
- `src/sync/backends/jmap/outbox/index.ts` +
  `operations/create-emails.ts`: the `Email/set create` outbox operation used
  by seeding. Checkpointed and at-most-once: an outcome the client cannot
  read is terminal (`createEmailsOutcomeUnknown`), never replayed.
- `src/stores/auth-store.ts` + `src/constants/staff.ts`: `email` and
  `isStaff` (the global staff flag).
- `src/stores/mail-store.ts`: optional `sourceFolderId` on `moveMessages` /
  `transferModeForFolder`, and `sourceFolderId` / `rows` options on the bulk
  actions (`markManySeen`, `archiveMessages`, `junkMessages`,
  `destroyMessages`, `whitelistSenders`) so they can act on a folder that is
  not the open one; `sortPropFor` / `jmapSortFor` exposed.
- `src/components/MessageListRow.vue` (with its `selectable` prop),
  `src/components/MessageBulkActions.vue` (the bulk toolbar buttons, pulled
  out of `MessageList.vue`), `SelectableListHeader`'s `showTotalCount` prop,
  and the helpers the row pulled out of `MessageList.vue`
  (`utils/message-row-presentation.ts`, `utils/quick-filter.ts`,
  `composables/useSenderAvatars.ts` — the list owner calls
  `provideSenderAvatars()`, rows call `useSenderAvatars()`).
- `src/composables/useThunderbirdShortcuts.ts`: `registerMessageListCommands`
  is called by a focused column (already public; used by `MessageList`).

## Removal

1. `rm -r src/features/kanban tests/unit/features/kanban tests/e2e/kanban.spec.js`
2. In `src/App.vue` drop the `StaffGearButton` / `KanbanBoard` async
   components, the `useKanbanStore()` call, `kanbanCompact` and its uses
   (the `shell--kanban-compact` class and CSS, the `availablePaneWidth` /
   `sidebarNeighbourReserve` branches, the `v-if` on the message-list
   resizer), the `<StaffGearButton v-if="authStore.isStaff" />` element, the
   `<KanbanBoard v-if=…>` branch (make `MessageList` a plain
   `v-if="displayedMessageList"` again) and the `.shell > .kanban-board` rule.
   `useColumnResize` can stay (the shell uses it) or be inlined again.
3. Delete `src/sync/backends/jmap/outbox/operations/create-emails.ts`, its
   `case` (and `checkpointedWrite` clause) in `outbox/index.ts`,
   `MUTATION_TYPE.CREATE_EMAILS`, `CREATE_EMAILS_PHASE`, the
   `MUTATION_RECOVERY_POLICIES` entry, and
   `tests/unit/sync/jmap-create-emails.test.ts` (plus the registry expectation
   in `tests/unit/constants/states.test.ts`).

`MessageListRow`, `MessageBulkActions`, the presentation utilities,
`isStaff` and the `sourceFolderId` / `rows` parameters are harmless
generalisations and can stay.

Data left behind: accounts that unlocked the feature keep their "Needs
Reply" / "Blocked" folders and sample mail on the server, and the
`stormbox.kanban.*` keys in `localStorage`. Neither is read by anything once
the code is gone; delete the folders like any other folder.
