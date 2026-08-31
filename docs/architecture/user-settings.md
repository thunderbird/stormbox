# User settings storage and sync

Stormbox stores preferences in one versioned JSON document per account.
SQLite is the worker-side cache, and a JMAP FileNode named
`thundermail/stormbox-settings.json` provides cross-device sync when that account
advertises `urn:ietf:params:jmap:filenode`. Accounts without the capability
remain fully device-local.

The product requirements are in `specs/007-user-settings/spec.md`.

## Document format

```json
{
  "owner": "stormbox",
  "documentType": "user-settings",
  "version": 1,
  "settings": { "theme": "dark" },
  "updatedAt": { "theme": 1752480000000 }
}
```

The ownership, document type, and version marker must match before Stormbox
uses or replaces a remote document. Settings are a flat map, and
`updatedAt` provides per-key last-write-wins merging. Different keys can
therefore change concurrently on different devices without clobbering one
another.

## Local storage

Migration `011_user_settings.sql` creates one `user_settings` row per
account. It contains the document JSON, the current remote FileNode id, and
the local update time. Worker RPC handlers own all SQLite reads and writes.
A local patch and the creation or reuse of its `pushSettings` mutation are
one transaction. Pending and retry rows are coalesced, and the outbox is
notified only after commit.

`stormbox.settings.v1` is a synchronous values-only browser mirror used to
apply the last theme before authentication. Its metadata records which
account supplied it. It is never promoted into a different authenticated
account merely because it was visible during boot.

Changes made without an active account are stored separately as pending
browser patches. A patch associated with a previously active account stays
with that account; an anonymous legacy patch is claimed by the first account
that loads it. `stormbox.theme.v1` is migrated through this anonymous path.

## JMAP transport

`src/sync/backends/jmap/file-node.ts` owns protocol behavior for small JSON
documents:

- require the FileNode capability on the specific Session account;
- find the top-level `thundermail` folder during pull and create it only
  from the settings outbox, then query the exact settings name within it;
- check `myRights` and `mayCreateTopLevelFileNode` where applicable;
- download and marker-validate JSON before exposing it;
- upload JSON and issue `FileNode/set` with `ifInState` and `onExists: null`;
- preserve typed `stateMismatch`, `alreadyExists`, `notFound`, and
  `forbidden` failures.

Settings sync uses this boundary. Database handlers contain no JMAP logic.
An existing top-level `stormbox-settings.json` is validated and merged during
pull. The standard settings outbox moves it into `thundermail`; if both
locations exist, it writes their per-key merge and removes the top-level node
in one conditional `FileNode/set`.

## Sync flow

Bootstrap, reconnect, and primary-account `FileNode` StateChanges pull both
locations (legacy top-level, then `thundermail/`). A pull merges each found
document into SQLite. The pull enqueues the same coalesced `pushSettings`
outbox mutation used by UI writes when local keys are newer, the canonical
document is missing, or a top-level copy exists; it never writes the remote
node directly.

The outbox reads the current SQLite document, re-reads both locations
(legacy first), merges, then conditionally writes. State races and stale
node ids cause a bounded re-read/rebase. The per-account settings lane
prevents two document writes from interleaving while preserving the
existing independent mail, contact, identity, and draft lanes.

Live coverage is in `tests/integration/contacts-live.test.ts`: settings land
under `thundermail/`; pull leaves the top-level node; the settings outbox
merges per-key and removes it.

## UI registry

`src/constants/settings.ts` declares each setting's type, default, and raw
value validator. UI code reads through `settingsStore.get` and writes
through `settingsStore.update`; it does not branch on sync availability.
The current registry contains:

| Key | Default | Purpose |
|---|---|---|
| `theme` | `system` | Color scheme; `system` follows the OS preference. |
| `primaryIdentityRemoteId` | `null` | Client-selected JMAP Identity used as the default From address. |
| `scheduledMailboxRemoteId` | `null` | Cached JMAP id for the hidden Send Later backing Mailbox; exact-name discovery remains authoritative. |
| `timeZone` | detected IANA zone, else `UTC` | Wall-time zone shared by Send Later presets and the custom picker. |

`timeZone` accepts only values supported by the runtime's
`Intl.DateTimeFormat`; invalid remote or browser-mirror values resolve to the
detected default. Changing it through the custom schedule dialog uses the
normal settings patch/outbox path, so a FileNode-capable account converges
across devices and a non-FileNode account remains device-local. Scheduled
mutations store an absolute target instant, so a later setting change does not
reinterpret already accepted mail.

`scheduledMailboxRemoteId` is a cache rather than user-facing state. Send
Later startup still discovers the exact
`__stormbox_internal_scheduled__` name and repairs its hidden shape before
using it. See [Send Later](send-later.md).
