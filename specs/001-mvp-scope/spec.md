# Stormbox MVP — Capability Reference

This document captures the product surface for the Stormbox MVP. It
describes what Stormbox is and what each capability shall do, in EARS
form. Architectural and runtime invariants live in
`.specify/memory/constitution.md`. Operational rules live in
`AGENTS.md`. Implementation notes live in `docs/architecture/`.

**Scope**: Webmail MVP for an Earlybird audience alpha. Single
account, JMAP against Stalwart.

## Status legend

- **Done** — implemented and covered by tests.
- **Partial** — implemented with known gaps, listed inline.
- **Planned** — accepted scope, not yet implemented.
- **Deferred** — accepted but explicitly out of MVP.
- **Non-goal** — out of scope; will not be built for the MVP.

## Capabilities

### 1. Sign in and session lifecycle [Done; session-expired UX Planned]

- **R-1.1** The system shall let the user sign in with Keycloak OIDC.
- **R-1.2** The system shall let self-hosters sign in with username
  and password.
- **R-1.3** When an OIDC session is already valid on app load, the
  system shall reconnect without prompting the user.
- **R-1.4** When the user signs out, the system shall stop sync and
  clear in-memory account state.
- **R-1.5** When a session expires, the system shall surface a
  recoverable session-expired state and not silently use stale
  credentials. *(Planned)*

### 2. Read mail [Done; conversation UI Planned]

- **R-2.1** The system shall display the signed-in account's folder
  hierarchy with role icons and per-folder unread counts.
- **R-2.2** The system shall render a virtualized message list whose
  scrollbar reflects the full folder size, with placeholder rows for
  positions not yet fetched.
- **R-2.3** When the user opens a message, the system shall display
  its sanitized HTML body in a sandboxed iframe with no script
  execution, or its plain-text body when HTML is unavailable.
- **R-2.4** While the user reads a message, the system shall mark
  the message as read.
- **R-2.5** The system shall display attachment metadata (name, type,
  size) on the open message.
- **R-2.6** The system shall persist scroll position per folder so
  re-entering a folder restores the previous view.
- **R-2.7** Thread metadata shall be synced to local storage. A
  conversation/thread reading UI is *Planned*.
- **R-2.8** The message list shall provide text filters for the open
  folder. Filters shall be toggles with text labels rather than
  icons; when no filter is selected, the message list is in the All
  Mail state. The MVP shall include an Unread filter. When the user
  toggles a filter, the current previewed message shall be cleared
  before the filter applies. A filtered-out state change shall not
  remove a message previewed or checkbox-selected after the filter is
  active until the user clears that preview or selection. The
  select-all checkbox shall remain visible but disabled when a filter
  leaves the message list empty, so toolbar alignment stays stable.

### 3. Triage [Done]

- **R-3.1** The system shall let the user mark messages read or
  unread, both individually and in bulk.
- **R-3.2** When the user deletes messages, the system shall move
  them to Trash if a Trash folder exists, otherwise destroy them
  permanently.
- **R-3.3** The system shall let the user permanently destroy
  messages already in Trash, including via Shift+Delete.
- **R-3.4** The system shall let the user archive messages to the
  account's archive folder.
- **R-3.5** The system shall let the user move selected messages to
  another folder by drag-and-drop.
- **R-3.6** The system shall provide multi-select where a checkbox
  toggles a row's selection independently of the focused/preview
  row, shift-click extends a range from an anchor, and the bulk
  pane replaces the message detail when at least one row is
  selected.
- **R-3.7** The system shall implement Thunderbird-compatible
  keyboard shortcuts for compose, reply, reply-all, forward, delete,
  permanent delete, archive, mark read/unread, list navigation
  (next/prev, next/prev unread, home/end), select all, and clear
  selection.
- **R-3.8** When the user refreshes the open folder, the system shall
  rebuild the local view from the server to recover from drift.
- **R-3.9** When new mail arrives on the server while the user is
  online, the open mailbox view shall update without a manual
  refresh.
- **R-3.10** Toolbar action buttons shall use icons only, with
  action text provided through accessible labels and tooltips. Message
  action toolbars shall stay consistent with Thunderbird-compatible
  shortcuts where the action is visible in the MVP.
- **R-3.11** When the currently previewed or checkbox-selected
  message or messages are removed from the open message list by a
  user action such as delete, archive, or move, the system shall move
  the preview to the next available message rather than leaving the UI
  with no message selected. If no later message is available, the
  system shall fall back to the previous available message.
- **R-3.12** When a user action or server push makes a previously
  cached destination folder stale, the system shall invalidate the
  in-memory message-list cache for that folder and fetch the next
  visible window from JMAP using query state or query changes, rather
  than showing stale rows or requiring a full folder metadata reload.
  Existing covered ranges for large folders shall be preserved so a
  single move does not trigger whole-folder re-indexing.

### 4. Compose and send [Partial — UI gaps]

- **R-4.1** The system shall let the user compose a new message and
  reply, reply-all, or forward an open message.
- **R-4.2** The system shall offer rich-text editing via Squire and
  send a plain-text alternative alongside the HTML body.
- **R-4.3** The system shall let the user pick a sending identity
  when more than one is available.
- **R-4.4** When the user sends, the system shall create the message
  and submit it through `EmailSubmission/set` in a chained JMAP call,
  and the sent message shall appear in the Sent folder.
- **R-4.5** When send fails, the system shall surface the failure and
  keep the compose draft visible so the user can retry.
- **R-4.6** Visible Reply-all and Forward toolbar buttons. *(Done)*
- **R-4.7** Cc/Bcc input fields with autocomplete. *(Planned; the
  outbound payload already includes Cc/Bcc when populated.)*

### 5. Contacts [Done; editing Non-goal]

- **R-5.1** When the JMAP Contacts capability is advertised, the
  system shall sync contacts read-only.
- **R-5.2** The system shall let the user browse and filter synced
  contacts in a dedicated contacts view.
- **R-5.3** The system shall offer recipient autocomplete in compose
  drawn from synced contacts and prior send history.
- **R-5.4** When contact sync is unavailable, compose shall remain
  usable.

### 6. Attachments [Partial — download Planned]

- **R-6.1** The system shall display attachment metadata on the open
  message.
- **R-6.2** Attachment download. *(Planned)*

### 7. Account storage usage [Done]

- **R-7.1** When the JMAP Quota capability is available, the system
  shall display the account's storage usage as a percentage of the
  hard limit.
- **R-7.2** When the server does not report a hard limit, the system
  shall hide the storage indicator.

## Non-goals

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

## Success Criteria

- **SC-1** A user with valid credentials can sign in, open a folder,
  and read a seeded message without manual setup beyond account
  configuration.
- **SC-2** A user can send a new message and find it in Sent.
- **SC-3** Triage actions (read/unread, delete, archive, refresh)
  remain consistent across the rendered UI, the local cache (via
  `window.__repo`), and direct JMAP queries on Chromium and Firefox.
- **SC-4** New mail arriving on the server while the user is online
  appears in the open Inbox without a manual refresh.
- **SC-5** Compose remains usable when contact autocomplete is
  unavailable.

## Assumptions and pointers

- Project-wide invariants (cache-first reads, mutation pipeline,
  layer boundaries, browser baseline, safe rendering) live in
  `.specify/memory/constitution.md`.
- Operational rules (dev container, local stack, E2E test
  conventions, project layout) live in `AGENTS.md`.
- Performance and storage rationale live in `docs/architecture/`.
- The first implementation target is JMAP against Stalwart.
