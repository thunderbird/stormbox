# Feature Specification: Stormbox MVP Scope

**Feature Branch**: `001-mvp-scope`  
**Created**: 2026-05-21  
**Status**: Draft  
**Input**: Existing Webmail MVP Planning Scope document

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Read Mail Reliably (Priority: P1)

As an Earlybird alpha user, I can sign in, browse folders, see message
lists, and read individual messages so that Stormbox is useful as a daily
mail reader.

**Why this priority**: Reading mail is the minimum viable webmail
experience. Sending, contacts, and attachments depend on users trusting
the read surface.

**Independent Test**: Can be tested by signing in to an account with
seeded mail, opening folders, selecting messages, and verifying rendered
message content.

**Acceptance Scenarios**:

1. **Given** a user with a valid account, **When** the user signs in, **Then** the system displays the user's folders and message list.
2. **Given** a folder containing messages, **When** the user selects a message, **Then** the system displays the message content safely.
3. **Given** a message that belongs to a thread, **When** the user opens the message, **Then** the system presents the conversation using available JMAP thread data.

---

### User Story 2 - Manage Basic Mail State (Priority: P1)

As an Earlybird alpha user, I can mark messages read or unread, delete,
archive, and refresh so that basic mailbox triage works.

**Why this priority**: Basic state changes are expected in any usable
mail client and exercise the most important server/local-cache mutation
paths.

**Independent Test**: Can be tested by performing each action against a
seeded account and verifying the UI, local cache, and JMAP server state.

**Acceptance Scenarios**:

1. **Given** a visible unread message, **When** the user marks it read, **Then** the message is shown as read after the operation completes.
2. **Given** a visible message, **When** the user deletes or archives it, **Then** the message leaves the active folder view.
3. **Given** mailbox content may have changed on the server, **When** the user refreshes, **Then** the local view reflects current server state.

---

### User Story 3 - Send and Reply to Mail (Priority: P2)

As an Earlybird alpha user, I can compose, send, reply, reply-all, and
forward messages with a reliable editing experience.

**Why this priority**: Sending mail completes the core two-way webmail
workflow, but it depends on a stable read surface and mutation pipeline.

**Independent Test**: Can be tested by composing new mail and replies,
then verifying delivery/submission state and sent-mail handling.

**Acceptance Scenarios**:

1. **Given** the user is signed in, **When** the user composes and sends a message, **Then** the system submits the message and records it in sent mail.
2. **Given** the user is reading a message, **When** the user replies, replies all, or forwards, **Then** the compose view is populated with the expected recipient and quoted context.
3. **Given** rich text editing is available, **When** the user writes HTML mail, **Then** the system preserves the composed content for sending and offers a plain-text alternative path.

---

### User Story 4 - Use Contacts and Attachments (Priority: P3)

As an Earlybird alpha user, I can autocomplete recipients from read-only
contacts and download attachments from received mail.

**Why this priority**: Contacts and attachments are important usability
features, but the MVP remains useful if they follow the core reading and
sending flows.

**Independent Test**: Can be tested by typing recipient names in compose
fields and downloading an attachment from a seeded message.

**Acceptance Scenarios**:

1. **Given** read-only CardDAV contacts are configured, **When** the user types in To, Cc, or Bcc, **Then** matching contacts are offered for autocomplete.
2. **Given** a message has an attachment, **When** the user chooses to download it, **Then** the attachment is retrieved for the user.

### Edge Cases

- Session expiration must not leave the user in a stale authenticated UI.
- Unsafe HTML email content must not execute scripts or privileged page behavior.
- Self-hosted deployments may use basic username/password authentication instead of Keycloak OIDC.
- CardDAV contact lookup may be unavailable; compose must remain usable without autocomplete.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system shall allow users to sign in and sign out.
- **FR-002**: When a user session expires, the system shall present a recoverable session-expired state rather than silently continuing with stale credentials.
- **FR-003**: The system shall display a folder list and a message list for the signed-in account.
- **FR-004**: The system shall support labels or equivalent folder-affordances only where they fit the MVP mail model.
- **FR-005**: The system shall render threaded conversation reading using JMAP thread data.
- **FR-006**: The system shall safely display HTML and plain-text email.
- **FR-007**: The system shall support basic read/unread, delete, archive, and refresh actions.
- **FR-008**: The system shall support compose, send, reply, reply-all, and forward.
- **FR-009**: The system shall provide HTML compose with Squire where practical and a plain-text alternative.
- **FR-010**: The system shall handle sent mail for outgoing messages.
- **FR-011**: The system shall provide read-only CardDAV autocomplete for To, Cc, and Bcc.
- **FR-012**: The system shall support attachment download.

### Non-Goals

- Calendar.
- Automatic email categorization such as social or promotions tabs.
- Agent-based search, complex search, or mail handling rules.
- Editing contacts.
- Offline mode.
- Rules or filters.
- Advanced search.
- Multi-account unified inbox.
- End-to-end encryption.
- Mobile packaging.
- Electron-style desktop or mobile app packaging.

### Key Entities

- **Account**: The signed-in mail account for the MVP; currently single-account, with data structures that should not prevent future multi-account support.
- **Folder/Mailbox**: A server-backed grouping of messages shown in the sidebar and used for list navigation.
- **Message**: Mail metadata, thread membership, body cache data, and mutable state needed for list/detail views and basic actions.
- **Contact**: Read-only CardDAV recipient data used for compose autocomplete.
- **Attachment**: Downloadable metadata and content associated with a message.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user with valid credentials can sign in, open a folder, and read a seeded message without manual setup beyond account configuration.
- **SC-002**: A user can send a new message and find the submitted message through sent-mail handling.
- **SC-003**: Read/unread, delete, archive, and refresh actions update the UI after completion and remain consistent with local cache and server state.
- **SC-004**: Compose remains usable when CardDAV autocomplete is unavailable.

## Assumptions

- Project-wide architectural assumptions live in `.specify/memory/constitution.md`.
- The MVP targets an Earlybird audience alpha rather than full Thunderbird feature parity.
- The first implementation target is JMAP against Stalwart.
