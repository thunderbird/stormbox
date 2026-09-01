# User Settings — Storage and Sync

This specification defines typed user settings, account-safe local behavior,
and optional cross-device synchronization through JMAP FileNode.

## Scope

Settings are a small flat key/value map exposed to UI code through one
reactive store. Stormbox operates no settings service. When the active JMAP
account supports FileNode, a marked JSON document synchronizes the values;
otherwise they remain device-local.

## Design

The same versioned document is cached in SQLite and stored in the account as
the `thundermail/stormbox-settings.json` FileNode:

```json
{
  "owner": "stormbox",
  "documentType": "user-settings",
  "version": 1,
  "settings": { "<key>": "<JSON value>" },
  "updatedAt": { "<key>": 1752480000000 }
}
```

Per-key timestamps provide last-write-wins merging. The browser keeps a
values-only boot mirror, but SQLite becomes authoritative once the account
is known. Pending pre-authentication changes are tracked separately from
that mirror.

## Requirements

| ID / Status | Requirement |
|:--|:--|
| R-SET.1 🟩 Done | The system shall store settings as a flat map in one marked, versioned JSON document with per-key modification timestamps and last-write-wins per-key merging. |
| R-SET.2 🟩 Done | The system shall declare every setting's type, default, and validator in one registry, and UI reads shall resolve invalid or missing values to that default. |
| R-SET.3 🟩 Done | UI code shall access settings only through a reactive read/update store and shall not depend on synchronization availability. |
| R-SET.4 🟩 Done | FileNode synchronization shall require the capability on the specific account, not only in Session capabilities. |
| R-SET.5 🟩 Done | The system shall keep the settings document in the top-level `thundermail` folder, validate and merge an existing top-level settings document during pull, relocate it through the settings outbox, find only the exact name within each location, and validate its ownership, document type, version, media type, and available read rights before using it. |
| R-SET.6 🟩 Done | Remote writes shall honor available account/node rights, upload JSON, and conditionally call `FileNode/set` with `ifInState` without silently replacing a name collision. |
| R-SET.7 🟩 Done | `stateMismatch`, `alreadyExists`, `notFound`, and `forbidden` shall remain distinguishable outcomes; conflicts shall re-read and rebase within a bounded attempt count. |
| R-SET.8 🟩 Done | A local SQLite patch and ensuring one pending/retry `pushSettings` row shall commit atomically, with duplicate eligible rows coalesced and outbox notification occurring after commit. |
| R-SET.9 🟩 Done | Pull-triggered creation or repair shall enqueue the standard outbox mutation and shall not write the FileNode directly. |
| R-SET.10 🟩 Done | Settings document mutations shall use one per-account outbox lane without serializing unrelated mail, contact, identity, or draft work. |
| R-SET.11 🟩 Done | Bootstrap, reconnect, and primary-account FileNode StateChanges shall pull settings without dispatching a shared account's change through the primary account. |
| R-SET.12 🟩 Done | Without FileNode capability, settings shall remain functional and device-local and queued pushes shall retire as successful no-ops. |
| R-SET.13 🟩 Done | The browser may apply the last theme before authentication, but the boot mirror shall not seed a different authenticated account. |
| R-SET.14 🟩 Done | Pre-authentication changes shall be tracked separately and account-safely, and the legacy `stormbox.theme.v1` value shall migrate without becoming an unmarked cross-account seed. |
| R-SET.15 🟩 Done | The Send Later time zone shall use the same validated setting locally and across FileNode-capable devices; changing it shall not reinterpret already accepted absolute schedule targets. |

## Current registry

| Key | Type | Default | Meaning |
|---|---|---|---|
| `theme` | `light \| dark \| system` | `system` | Color scheme; `system` follows the OS preference. |
| `primaryIdentityRemoteId` | `string \| null` | `null` | Client-selected JMAP Identity used as the default From address. |
| `scheduledMailboxRemoteId` | `string \| null` | `null` | Cached canonical remote id for the managed top-level Scheduled mailbox; cached ids are verified before reuse. |
| `timeZone` | IANA time-zone string | detected IANA zone, else `UTC` | Wall-time zone used by Send Later presets and custom scheduling. |

## Non-goals

- A dedicated settings panel.
- Large-document storage or attachments.
- A Stormbox-operated synchronization backend.
- Cross-key conflict transactions.

## Pointers

- Architecture: `docs/architecture/user-settings.md`
- Migration: `src/db/migrations/011_user_settings.sql`
- Store: `src/stores/settings-store.ts`
- FileNode transport: `src/sync/backends/jmap/file-node.ts`
- Settings sync: `src/sync/backends/jmap/settings.ts`
