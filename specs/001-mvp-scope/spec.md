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
| 2 | Read mail | 8 | 2 | 1 | Conversation UI, full mail search, browser navigation |
| 3 | Triage | 13 | — | 1 | Undo/redo queue |
| 4 | Compose and send | 7 | — | 1 | Cc/Bcc autocomplete |
| 5 | Contacts | 4 | — | — | — |
| 6 | Attachments | 1 | — | 1 | Download |
| 7 | Account storage usage | 2 | — | — | — |
| 8 | Application chrome and cross-product navigation | 5 | — | 1 | services-ui adoption |
| 9 | Browser notifications | — | — | 4 | Whole section is a draft |
| 10 | Responsive mail layout contracts | 12 | — | — | — |

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
| R-2.1 🟩 Done | The system shall display the signed-in account's folder hierarchy with role icons and per-folder unread counts. Role-based mailboxes (Inbox, Drafts, Sent, Archive, Junk, Trash) shall render first using their dedicated Thunderbird Desktop icons; all remaining mailboxes shall render below a "Folders" heading and shall use the Thunderbird Desktop generic folder icon in its goldenrod tone rather than a neutral grey. Per-folder unread counts shall display up to 99999 before truncating with a "+" suffix, and the spaces-toolbar unread badge shall show the Inbox unread count up to 9999 before truncating with a "+" suffix. |
| R-2.2 🟩 Done | The system shall render a virtualized message list whose scrollbar reflects the full folder size, with placeholder rows for positions not yet fetched. |
| R-2.3 🟩 Done | When the user opens a message, the system shall display its sanitized HTML body in a sandboxed iframe with no script execution, or its plain-text body when HTML is unavailable. |
| R-2.4 🟩 Done | While the user reads a message, the system shall mark the message as read. |
| R-2.5 🟩 Done | The system shall display attachment metadata (name, type, size) on the open message. |
| R-2.6 🟩 Done | The system shall persist scroll position per folder so re-entering a folder restores the previous view. |
| R-2.7 🟨 Partial | Thread metadata shall be synced to local storage. A conversation/thread reading UI is planned. |
| R-2.8 🟨 Partial | The message list shall provide text filters for the open folder. Filters shall be toggles with text labels rather than icons; when no filter is selected, the message list is in the All Mail state. The MVP shall include an Unread filter and a top-level Quick Filter text box. Quick Filter shall search only local cached message metadata in the current folder, matching From, To, and Subject; it shall not issue JMAP search requests. When Quick Filter has user-entered text, the text box shall show a clear "x" control at the far right that clears the Quick Filter text. When the user toggles a filter or changes Quick Filter text, the current previewed message shall be cleared before the filter applies. A filtered-out state change shall not remove a message previewed or checkbox-selected after the filter is active until the user clears that preview or selection. The select-all checkbox shall remain visible but disabled when a filter leaves the message list empty, so toolbar alignment stays stable. Full JMAP-backed mail search is planned for the MVP. |
| R-2.9 🟩 Done | The system shall let the user collapse and restore the folder list from the spaces toolbar. When the viewport is narrower than 1024 px and the message detail or bulk pane is visible, the folder list shall collapse automatically to preserve reading space. In this compact reading layout, automatic folder-list visibility shall mirror message-view visibility: the folder list collapses when the message detail or bulk pane appears, and restores when that pane is hidden. The toolbar button shall only toggle the current folder-list visibility state, not enable or disable the responsive behavior. Folder-list visibility changes shall use a short sliding transition unless the user requests reduced motion; when opening a message triggers the compact folder-list collapse, the message detail shall appear near the end of that transition. The compose affordance in the folder list shall remain usable at the minimum supported folder-list width. |
| R-2.10 🟧 Planned | The system shall use route-backed browser navigation for app spaces, folders, and opened messages so refresh, direct links, and the browser back and forward buttons preserve the expected mail context. Folder URLs shall use human-readable names where possible, and message URLs shall use stable server identifiers rather than local cache row ids. |
| R-2.11 🟩 Done | When an opened message references inline images by `cid:`, the system shall resolve them for display rather than leaving a broken reference: it shall download the referenced message part through the authenticated worker transport and rewrite the `cid:` reference to an inline `data:` URL inside the same sanitization pass (set via the DOM so the value cannot break out of the attribute). Resolution shall apply only to parts of the message being viewed and only to references the body actually uses. Both resolved inline images and author-embedded `data:` images shall be restricted to a raster image allowlist (PNG, JPEG, GIF, WebP, BMP, AVIF, ICO); SVG and non-image `data:` payloads shall be stripped, since DOMPurify cannot inspect bytes inside a `data:` URL. The HTML body shall continue to render inside the sandboxed, script-free iframe of R-2.3. |

### 3. Triage

| ID / Status | Requirement |
|:--|:--|
| R-3.1 🟩 Done | The system shall let the user mark messages read or unread, both individually and in bulk. |
| R-3.2 🟩 Done | When the user deletes messages, the system shall move them to Trash if a Trash folder exists, otherwise destroy them permanently. |
| R-3.3 🟩 Done | The system shall let the user permanently destroy messages already in Trash, including via Shift+Delete. |
| R-3.4 🟩 Done | The system shall let the user archive messages to the account's archive folder. |
| R-3.5 🟩 Done | The system shall let the user move selected messages to another folder by drag-and-drop. |
| R-3.6 🟩 Done | The system shall provide multi-select where a checkbox toggles a row's selection independently of the focused/preview row, shift-click extends a range from an anchor, and the bulk pane replaces the message detail when at least one row is selected. In the single-mail-column layout (R-10.3) the bulk pane shall be suppressed and the message list shall remain visible so the user can continue managing selected rows; the bulk pane shall reappear when the layout returns to two or more columns. When the user shift-selects without an existing anchor, the selection range shall start at the first message visible at the top of the current message-list viewport. When messages are multi-selected, a plain click on a message row body shall clear the multi-selection and open that message for viewing. When the user holds Shift or Control while clicking anywhere on a message-list row, the click shall be handled as the matching multi-select action rather than as a view/open action. When the select-all checkbox is indeterminate because some but not all messages are selected, activating it shall clear the selection. |
| R-3.7 🟩 Done | The system shall implement Thunderbird-compatible keyboard shortcuts for compose, reply, reply-all, forward, delete, permanent delete, archive, mark read/unread, list navigation (next/prev, next/prev unread, home/end), select all, and clear selection. |
| R-3.8 🟩 Done | When the user refreshes the open folder, the system shall rebuild the local view from the server to recover from drift. If the currently previewed message still exists in the refreshed folder view, the system shall keep that message previewed after refresh; if it no longer exists, the system shall clear the preview. |
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
| R-4.3 🟩 Done | The system shall let the user pick a sending identity when more than one is available. New compose windows shall default to the signed-in account's primary identity when it is known, fall back to the provider's non-deletable or Thundermail identity when needed, and remember the user's most recently selected sending identity for later compose windows in the same account. |
| R-4.4 🟩 Done | When the user sends, the system shall create the message and submit it through `EmailSubmission/set` in a chained JMAP call, and the sent message shall appear in the Sent folder marked read on the server and in the local cache. |
| R-4.5 🟩 Done | When send fails, the system shall surface the failure and keep the compose draft visible so the user can retry. |
| R-4.6 🟩 Done | Visible Reply-all and Forward toolbar buttons. |
| R-4.7 🟧 Planned | Cc/Bcc input fields with autocomplete. (The outbound payload already includes Cc/Bcc when populated.) |
| R-4.8 🟩 Done | When the user pastes an image from the clipboard into the compose editor, the system shall inline it in the draft immediately as a `data:` URL, centered by default with its alignment controllable by the editor's alignment tools (alignment is applied to the image's containing block). On send, the system shall upload each inline image as a server blob and assemble the message as a `multipart/related` body — a `multipart/alternative` (text plus HTML) together with each image part referenced from the HTML by `cid:` with inline disposition — so recipients can resolve the reference. The system shall not rely on the JMAP convenience `attachments` property for this, because the server emits those parts as a `multipart/mixed` sibling that leaves the `cid:` unresolved. When the user replies to or forwards a message containing inline `cid:` images, the system shall re-inline those images into the quoted body (per R-2.11 resolution) so they are re-uploaded and re-attached to the new message rather than left as dangling references. This shall work across the supported browsers and platforms. |

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
| R-8.1 🟩 Done | The system shall present a top bar above the mail columns whose left cell holds a Thundermail product menu, whose centre cell holds the Quick Filter (R-2.8), and whose right cell holds a dark/light theme toggle and an account avatar menu. The Thundermail menu trigger shall keep consistent pill geometry between its closed and open states, and its product icon shall align with the spaces toolbar icon column. |
| R-8.2 🟩 Done | The Thundermail product menu shall link the user to other Thunderbird Pro web products, including Appointment and Send, with product icons aligned to the Thundermail menu icon column. These product links shall open in a new tab using safe `noopener noreferrer` link attributes. URLs shall resolve to production hosts when the app runs on the production webmail origin and to staging hosts in all other environments, and shall be overridable via Vite env vars for self-hosters. |
| R-8.3 🟩 Done | The account avatar menu shall display an initials-based avatar derived deterministically from the user's email address. On activation it shall reveal the signed-in email, an Account Settings link to the Thunderbird Accounts site (per R-8.2 host resolution), and a Log Out action that signs the user out per R-1.4. The folder list shall not duplicate a sign-out affordance. |
| R-8.4 🟩 Done | The system shall let the user toggle between dark and light themes via a button in the top bar, default to the system colour-scheme preference on first run, and persist the chosen theme across reloads. |
| R-8.5 🟩 Done | Space-specific UI shall not cross space boundaries. Mail-only UI such as the folder list, folder-list toggle, folder-list resizer, New Message button, and mail folder navigation shall not render in Contacts. |
| R-8.6 🟩 Done | The browser document title shall be `Thundermail` before the signed-in email is known and shall update to `Thundermail - <email address>` once an account email is available. |
| R-8.7 🟧 Planned | The system shall consume Thunderbird `services-ui` for shared UI primitives, starting with button components, and shall follow `services-ui` conventions for component variants, sizes, disabled states, focus treatment, tooltips, design tokens, and light/dark theme integration unless Stormbox-specific mail UX requires a documented exception. |

### 9. Browser notifications

> **Draft.** This section is an early sketch and has not been
> finalised. Requirements may change before acceptance.

| ID / Status | Requirement |
|:--|:--|
| R-9.1 🟧 Planned | When new mail arrives in the Inbox while the app is open and the user has granted browser notification permission, the system shall surface a desktop notification summarising the message (sender and subject) using the standard Web Notifications API. |
| R-9.2 🟧 Planned | The system shall request browser notification permission only in response to an explicit user opt-in (e.g. a setting toggle or first-run prompt) rather than on app load, and shall respect a denied or dismissed permission without re-prompting. |
| R-9.3 🟧 Planned | The system shall suppress notifications for mail that arrives in folders other than the Inbox, for messages already marked read on the server, and while the app tab is focused; activating a notification shall focus the app tab and open the corresponding message. |
| R-9.4 🟧 Planned | When multiple new messages arrive in quick succession, the system shall coalesce them into a single summary notification rather than emitting one per message. |

### 10. Responsive mail layout contracts

| ID / Status | Requirement |
|:--|:--|
| R-10.1 🟩 Done | The mail shell shall enforce pane minimums without allowing horizontal shell overflow: the folder list shall support a minimum width of 180 px, the message list shall support a minimum width of 280 px, and the message view shall support a minimum width of 240 px. Desktop users may resize panes down to these minimums. |
| R-10.2 🟩 Done | When the viewport is narrower than 1024 px and a message detail or bulk pane is visible, the folder list shall collapse automatically to preserve reading space; below the single-column threshold it shall collapse regardless of whether a message is selected. When the responsive condition no longer applies, a folder list hidden by this responsive behavior shall be restored. Manual folder-list toggles from the spaces toolbar shall affect only the current visibility state. |
| R-10.3 🟩 Done | When the viewport is narrower than 640 px, the system shall enter a single-mail-column layout immediately when the reading pane is requested: the message list and message-list resizer shall be hidden, and the message view shall fill the full content width above the bottom spaces bar. With no reading pane selected, the message list shall occupy that same single content column. At 640 px and wider, compact reading remains a two-pane mail layout when a reading pane is visible. |
| R-10.4 🟩 Done | The message list shall use its multiline card row layout when the message-list pane is narrower than 360 px, and shall keep the single-line row layout at 360 px and wider. In card layout, subjects shall have up to two lines before truncating, while message previews shall be limited to one line. Card layout shall not make read message subjects or senders look unread; only rows whose message is unread shall render sender and subject text in the unread bold weight. |
| R-10.5 🟩 Done | In the open message header, From, To, Subject, and Date values shall wrap to additional lines when needed rather than truncating with ellipses. Long unbroken values such as email addresses and long subjects shall be allowed to break within the value so they do not force horizontal overflow. |
| R-10.6 🟩 Done | The message view and its internal article, header, metadata, body, iframe, and action toolbar shall shrink with the available column width and shall not force page-level or shell-level horizontal overflow, including when the message-view column is narrower than 300 px. If action buttons exceed the available header width, the action toolbar may scroll internally. |
| R-10.7 🟩 Done | The folder-list New Message button shall remain contained within the visible folder-list header at the minimum folder-list width, including when the folder list is opened as a mobile overlay; its label may ellipsize, but the button shall not overflow into the resizer or adjacent panes. |
| R-10.8 🟩 Done | On mobile browsers whose visible viewport changes as browser chrome appears or hides, the app shell shall size to the dynamic visible viewport rather than the larger layout viewport, keeping the spaces rail bottom actions visible and clear of safe-area insets. |
| R-10.9 🟩 Done | Mobile browsers shall not inflate the app chrome or message-list text beyond the authored CSS sizes through automatic text autosizing; normal pinch zoom and user accessibility settings remain browser-controlled. |
| R-10.10 🟩 Done | In single-column mode, the spaces navigation shall move from the left rail to a bottom bar. The folder-list toggle shall remain anchored at the bottom-left in Mail and shall open the folder list as an overlay, while the Mail and Contacts actions shall be centered in the bottom bar. |
| R-10.11 🟩 Done | The message-view HTML iframe shall fit each email body to the available reading-column width by setting CSS `zoom` on the iframe documentElement. The fit ratio shall be computed as the reading-column width divided by the larger of the email body's measured content width and a 400 px minimum layout width; when that ratio is at least 1 the iframe shall render at zoom 1. Width measurement shall use the iframe document's current viewport so reflowable content does not trigger gratuitous zoom-down, and the iframe element's rendered height shall scale by the same ratio so HTML emails never force horizontal overflow of the reading column. The iframe document itself shall never own a scrollbar (horizontal or vertical); the message view body is the sole scroll container for the open message. |
| R-10.12 🟩 Done | In the single-mail-column layout (R-10.3), the message-view header toolbar, metadata block, plain-text body, and HTML iframe gutter shall use a minimal 5 px outer inset rather than the wider desktop insets so HTML email content has the maximum readable width. In the same layout, the per-row selection checkbox in the message list shall remain visible without requiring hover, since touch users have no hover affordance to surface it. |

## Deferred to Future

The MVP excludes:

- Calendar.
- Automatic email categorization (e.g. social/promotions tabs).
- Agent-based or advanced search and rules.
- Editing contacts, or attaching files via a picker (inline images pasted into compose are supported per R-4.8).
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
