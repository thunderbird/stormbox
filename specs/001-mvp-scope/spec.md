# Stormbox MVP — Capability Reference

This document captures the product surface for the Stormbox MVP. It
describes what Stormbox is and what each capability shall do, in EARS
form. Architectural and runtime invariants live in
`.specify/memory/constitution.md`. Operational rules live in
`AGENTS.md`. Implementation notes live in `docs/architecture/`.

**Scope**: Webmail MVP for an Earlybird audience alpha. Single
account, JMAP against Stalwart.

## Status legend

Every requirement carries one of three markers:

- 🟩 **Done** — implemented and covered by tests.
- 🟨 **Partial** — implemented with known gaps, listed inline.
- 🟧 **Planned** — accepted scope, not yet implemented.

Items that are out of scope are listed once in [Non-goals](#non-goals)
and do not appear inline with the requirements.

## Status overview

Each numeric cell is the count of requirements in that status for the
capability.

| # | Capability | 🟩 Done | 🟨 Partial | 🟧 Planned | Outstanding work |
|---|---|---|---|---|---|
| 1 | Sign in and session lifecycle | 4 | — | 1 | Session-expired UX |
| 2 | Read mail | 7 | 2 | 1 | Conversation UI, full mail search, browser navigation |
| 3 | Triage | 13 | — | 1 | Undo/redo queue |
| 4 | Compose and send | 6 | — | 1 | Cc/Bcc autocomplete |
| 5 | Contacts | 4 | — | — | — |
| 6 | Attachments | 1 | — | 1 | Download |
| 7 | Account storage usage | 2 | — | — | — |
| 8 | Application chrome and cross-product navigation | 4 | — | — | — |
| 9 | Browser notifications | — | — | 4 | Whole section is a draft |

## Capabilities

### 1. Sign in and session lifecycle

| ID / Status | Requirement |
|:--|:--|
| R-1.1 🟩 Done | The system shall let the user sign in with Keycloak OIDC. |
| R-1.2 🟩 Done | The system shall let self-hosters sign in with username and password. |
| R-1.3 🟩 Done | When an OIDC session is already valid on app load, the system shall reconnect without prompting the user. |
| R-1.4 🟩 Done | When the user signs out, the system shall stop sync and clear in-memory account state. |
| R-1.5 🟧 Planned | When a session expires, the system shall surface a recoverable session-expired state and not silently use stale credentials. |

### 2. Read mail

| ID / Status | Requirement |
|:--|:--|
| R-2.1 🟩 Done | The system shall display the signed-in account's folder hierarchy with role icons and per-folder unread counts. Role-based mailboxes (Inbox, Drafts, Sent, Archive, Junk, Trash) shall render first using their dedicated Thunderbird Desktop icons; all remaining mailboxes shall render below a "Folders" heading and shall use the Thunderbird Desktop generic folder icon in its goldenrod tone rather than a neutral grey. Per-folder unread counts shall display up to 99999 before truncating with a "+" suffix, and the spaces-toolbar total-unread badge shall display up to 9999 before truncating with a "+" suffix. |
| R-2.2 🟩 Done | The system shall render a virtualized message list whose scrollbar reflects the full folder size, with placeholder rows for positions not yet fetched. |
| R-2.3 🟩 Done | When the user opens a message, the system shall display its sanitized HTML body in a sandboxed iframe with no script execution, or its plain-text body when HTML is unavailable. |
| R-2.4 🟩 Done | While the user reads a message, the system shall mark the message as read. |
| R-2.5 🟩 Done | The system shall display attachment metadata (name, type, size) on the open message. |
| R-2.6 🟩 Done | The system shall persist scroll position per folder so re-entering a folder restores the previous view. |
| R-2.7 🟨 Partial | Thread metadata shall be synced to local storage. A conversation/thread reading UI is planned. |
| R-2.8 🟨 Partial | The message list shall provide text filters for the open folder. Filters shall be toggles with text labels rather than icons; when no filter is selected, the message list is in the All Mail state. The MVP shall include an Unread filter and a top-level Quick Filter text box. Quick Filter shall search only local cached message metadata in the current folder, matching From, To, and Subject; it shall not issue JMAP search requests. When Quick Filter has user-entered text, the text box shall show a clear "x" control at the far right that clears the Quick Filter text. When the user toggles a filter or changes Quick Filter text, the current previewed message shall be cleared before the filter applies. A filtered-out state change shall not remove a message previewed or checkbox-selected after the filter is active until the user clears that preview or selection. The select-all checkbox shall remain visible but disabled when a filter leaves the message list empty, so toolbar alignment stays stable. Full JMAP-backed mail search is planned for the MVP. |
| R-2.9 🟩 Done | The system shall let the user collapse and restore the folder list from the spaces toolbar. When the viewport is 1024 px or narrower and the message detail or bulk pane is visible, the folder list shall collapse automatically to preserve reading space. In this compact reading layout, automatic folder-list visibility shall mirror message-view visibility: the folder list collapses when the message detail or bulk pane appears, and restores when that pane is hidden. The toolbar button shall only toggle the current folder-list visibility state, not enable or disable the responsive behavior. Folder-list visibility changes shall use a short sliding transition unless the user requests reduced motion; when opening a message triggers the compact folder-list collapse, the message detail shall appear near the end of that transition. The compose affordance in the folder list shall remain usable at the minimum supported folder-list width. |
| R-2.10 🟧 Planned | The system shall use route-backed browser navigation for app spaces, folders, and opened messages so refresh, direct links, and the browser back and forward buttons preserve the expected mail context. Folder URLs shall use human-readable names where possible, and message URLs shall use stable server identifiers rather than local cache row ids. |

### 3. Triage

| ID / Status | Requirement |
|:--|:--|
| R-3.1 🟩 Done | The system shall let the user mark messages read or unread, both individually and in bulk. |
| R-3.2 🟩 Done | When the user deletes messages, the system shall move them to Trash if a Trash folder exists, otherwise destroy them permanently. |
| R-3.3 🟩 Done | The system shall let the user permanently destroy messages already in Trash, including via Shift+Delete. |
| R-3.4 🟩 Done | The system shall let the user archive messages to the account's archive folder. |
| R-3.5 🟩 Done | The system shall let the user move selected messages to another folder by drag-and-drop. |
| R-3.6 🟩 Done | The system shall provide multi-select where a checkbox toggles a row's selection independently of the focused/preview row, shift-click extends a range from an anchor, and the bulk pane replaces the message detail when at least one row is selected. |
| R-3.7 🟩 Done | The system shall implement Thunderbird-compatible keyboard shortcuts for compose, reply, reply-all, forward, delete, permanent delete, archive, mark read/unread, list navigation (next/prev, next/prev unread, home/end), select all, and clear selection. |
| R-3.8 🟩 Done | When the user refreshes the open folder, the system shall rebuild the local view from the server to recover from drift. |
| R-3.9 🟩 Done | When new mail arrives on the server while the user is online, the open mailbox view shall update without a manual refresh. |
| R-3.10 🟩 Done | Toolbar action buttons shall use icons only, with action text provided through accessible labels and tooltips. Message action toolbars shall stay consistent with Thunderbird-compatible shortcuts where the action is visible in the MVP. |
| R-3.11 🟩 Done | When the currently previewed or checkbox-selected message or messages are removed from the open message list by a user action such as delete, archive, or move, the system shall move the preview to the next available message rather than leaving the UI with no message selected. If no later message is available, the system shall fall back to the previous available message. |
| R-3.12 🟩 Done | When a user action or server push makes a previously cached destination folder stale, the system shall invalidate the in-memory message-list cache for that folder and fetch the next visible window from JMAP using query state or query changes, rather than showing stale rows or requiring a full folder metadata reload. Existing covered ranges for large folders shall be preserved so a single move does not trigger whole-folder re-indexing. |
| R-3.13 🟧 Planned | The system shall provide an undo/redo queue for message triage operations including archive, move, delete (to Trash), and mark read/unread. The user shall be able to reverse the most recent action via Ctrl/Cmd+Z and reapply it via Ctrl/Cmd+Shift+Z (or Ctrl/Cmd+Y), matching Thunderbird-compatible behavior. The queue shall preserve a bounded history of recent operations within the active session, group bulk actions on multiple messages into a single undoable entry, and surface a transient confirmation (e.g. toast) after each action with an undo affordance. Permanent destroy (Shift+Delete and Trash purge) shall remain non-undoable. The queue shall be cleared on sign-out and is not required to survive page reloads. |
| R-3.14 🟩 Done | When the user issues a move or delete (move-to-Trash or permanent destroy) covering more than a configurable batch size (default 200 messages), the system shall split the dispatch into sequential JMAP `Email/set` chunks no larger than that batch size, display a modal progress indicator that names the operation and shows messages-completed / total, and block other user input until the operation finishes. Each chunk shall be its own `pending_mutations` row so the outbox apply step still keeps the local cache authoritative per chunk. On a chunk failure the system shall stop further chunks, leave already-succeeded chunks applied, surface an error that distinguishes the partial outcome (e.g. "Could not move message (requestTooLarge) (400 of 536 succeeded).") derived from the JMAP method-level error type when the server returns one, and clear the progress indicator. The batch size shall be a single source-level constant so it can be tuned without schema or API changes. |

### 4. Compose and send

| ID / Status | Requirement |
|:--|:--|
| R-4.1 🟩 Done | The system shall let the user compose a new message and reply, reply-all, or forward an open message. |
| R-4.2 🟩 Done | The system shall offer rich-text editing via Squire and send a plain-text alternative alongside the HTML body. |
| R-4.3 🟩 Done | The system shall let the user pick a sending identity when more than one is available. |
| R-4.4 🟩 Done | When the user sends, the system shall create the message and submit it through `EmailSubmission/set` in a chained JMAP call, and the sent message shall appear in the Sent folder. |
| R-4.5 🟩 Done | When send fails, the system shall surface the failure and keep the compose draft visible so the user can retry. |
| R-4.6 🟩 Done | Visible Reply-all and Forward toolbar buttons. |
| R-4.7 🟧 Planned | Cc/Bcc input fields with autocomplete. (The outbound payload already includes Cc/Bcc when populated.) |

### 5. Contacts

| ID / Status | Requirement |
|:--|:--|
| R-5.1 🟩 Done | When the JMAP Contacts capability is advertised, the system shall sync contacts read-only. |
| R-5.2 🟩 Done | The system shall let the user browse and filter synced contacts in a dedicated contacts view. |
| R-5.3 🟩 Done | The system shall offer recipient autocomplete in compose drawn from synced contacts and prior send history. |
| R-5.4 🟩 Done | When contact sync is unavailable, compose shall remain usable. |

### 6. Attachments

| ID / Status | Requirement |
|:--|:--|
| R-6.1 🟩 Done | The system shall display attachment metadata on the open message. |
| R-6.2 🟧 Planned | Attachment download. |

### 7. Account storage usage

| ID / Status | Requirement |
|:--|:--|
| R-7.1 🟩 Done | When the JMAP Quota capability is available, the system shall display the account's storage usage as a percentage of the hard limit. |
| R-7.2 🟩 Done | When the server does not report a hard limit, the system shall hide the storage indicator. |

### 8. Application chrome and cross-product navigation

| ID / Status | Requirement |
|:--|:--|
| R-8.1 🟩 Done | The system shall present a top bar above the mail columns whose left cell holds a Thundermail product menu, whose centre cell holds the Quick Filter (R-2.8), and whose right cell holds a dark/light theme toggle and an account avatar menu. |
| R-8.2 🟩 Done | The Thundermail product menu shall link the user to other Thunderbird Pro web products, including Thunderbird Appointment and Thunderbird Send. URLs shall resolve to production hosts when the app runs on the production webmail origin and to staging hosts in all other environments, and shall be overridable via Vite env vars for self-hosters. |
| R-8.3 🟩 Done | The account avatar menu shall display an initials-based avatar derived deterministically from the user's email address. On activation it shall reveal the signed-in email, an Account Settings link to the Thunderbird Accounts site (per R-8.2 host resolution), and a Log Out action that signs the user out per R-1.4. The folder list shall not duplicate a sign-out affordance. |
| R-8.4 🟩 Done | The system shall let the user toggle between dark and light themes via a button in the top bar, default to the system colour-scheme preference on first run, and persist the chosen theme across reloads. |

### 9. Browser notifications

> **Draft.** This section is an early sketch and has not been
> finalised. Requirements may change before acceptance.

| ID / Status | Requirement |
|:--|:--|
| R-9.1 🟧 Planned | When new mail arrives in the Inbox while the app is open and the user has granted browser notification permission, the system shall surface a desktop notification summarising the message (sender and subject) using the standard Web Notifications API. |
| R-9.2 🟧 Planned | The system shall request browser notification permission only in response to an explicit user opt-in (e.g. a setting toggle or first-run prompt) rather than on app load, and shall respect a denied or dismissed permission without re-prompting. |
| R-9.3 🟧 Planned | The system shall suppress notifications for mail that arrives in folders other than the Inbox, for messages already marked read on the server, and while the app tab is focused; activating a notification shall focus the app tab and open the corresponding message. |
| R-9.4 🟧 Planned | When multiple new messages arrive in quick succession, the system shall coalesce them into a single summary notification rather than emitting one per message. |

## Deferred to Future

The MVP excludes:

- Calendar.
- Automatic email categorization (e.g. social/promotions tabs).
- Agent-based or advanced search and rules.
- Editing contacts or sending attachments.
- Offline mode.
- Mail rules and filters.
- Multi-account unified inbox.
- End-to-end encryption.
- Mobile or Electron-style desktop packaging.

## Assumptions and pointers

- Project-wide invariants (cache-first reads, mutation pipeline,
  layer boundaries, browser baseline, safe rendering) live in
  `.specify/memory/constitution.md`.
- Operational rules (dev container, local stack, E2E test
  conventions, project layout) live in `AGENTS.md`.
- Performance and storage rationale live in `docs/architecture/`.
- The first implementation target is JMAP against Stalwart.
