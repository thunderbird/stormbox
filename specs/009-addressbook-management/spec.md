# Address Book Management

This specification defines JMAP AddressBook create, metadata edit, default
changes, and warned permanent deletion. Address Book Trash is not
part of this feature. The Stormbox constitution remains controlling.

## Status legend

- 🟩 **Done** — implemented and covered by the required tests.
- 🟨 **Partial** — implemented with the stated gap.
- 🟧 **Planned** — accepted scope, not yet implemented.

## AB-1 — Contacts workspace

| ID / Status | Requirement |
|:--|:--|
| AB-1.1 🟩 Done | The address-book rail shall place an icon-only Create address book action immediately left of New Contact. Only an explicit account capability `mayCreateAddressBook: true` shall enable it. |
| AB-1.2 🟩 Done | Each book shall keep its server name. The default book shall carry a `Personal` badge. |
| AB-1.3 🟩 Done | A concrete book shall center its name in the contact-list header and show icon-only Edit address book and Delete address book actions immediately after the selection checkbox. Bulk selection, All Contacts, Trash, and Identities shall hide these actions. |
| AB-1.4 🟩 Done | Create and Edit shall share the existing third-column shell and provide name, description, and default controls with dirty-navigation guards, mobile Back, validation, authoritative save errors, and focus restoration. Opening book metadata shall preserve the selected contact. |

## AB-2 — Rights, writes, and recovery

| ID / Status | Requirement |
|:--|:--|
| AB-2.1 🟩 Done | AddressBook sync shall persist `sortOrder`, `isDefault`, `isSubscribed`, and nullable `mayWrite` and `mayDelete` projections. Missing or malformed rights shall deny the corresponding action. |
| AB-2.2 🟩 Done | Create and sparse update shall use durable outbox mutations. `isDefault` shall never be patched; default changes shall use `onSuccessSetIsDefault`. |
| AB-2.3 🟩 Done | Create shall checkpoint a complete pre-create snapshot before `AddressBook/set`. A lost response shall recover only when exactly one new AddressBook matches the requested fields; otherwise the mutation shall stop as ambiguous without replaying create. |
| AB-2.4 🟩 Done | Every accepted create or update shall complete only after a full authoritative `AddressBook/get` has repaired SQLite. |

## AB-3 — Permanent deletion

| ID / Status | Requirement |
|:--|:--|
| AB-3.1 🟩 Done | Delete shall be disabled without explicit `mayDelete`, for Trusted Senders, and for the final non-Trusted-Senders book. Deleting the default book is allowed when another eligible book remains, and the warning shall state that the server chooses its replacement. |
| AB-3.2 🟩 Done | Before confirmation, the client shall page an authoritative `ContactCard/query { inAddressBook }` inventory and classify contacts as exclusive or shared. The dialog shall state which contacts will be destroyed permanently and which will only lose one membership. |
| AB-3.3 🟩 Done | The durable destroy mutation shall re-inventory immediately before dispatch. Any more-destructive result shall require confirmation again. Only this confirmed path shall send `onDestroyRemoveContents: true`. |
| AB-3.4 🟩 Done | A lost destroy response shall verify whether the AddressBook still exists before replay. An accepted or verified destroy shall complete only after authoritative AddressBook and ContactCard synchronization retires the book, removes exclusive contacts, and updates shared memberships. |
| AB-3.5 🟩 Done | AddressBook deletion is irreversible and shall not create Contacts Trash rows, FileNodes, tombstones, or restore actions. |

## AB-4 — Verification

| ID / Status | Requirement |
|:--|:--|
| AB-4.1 🟩 Done | Unit coverage shall pin capability and rights gates, create recovery, sparse/default writes, inventory stability, destructive escalation, response-loss recovery, cache repair, workspace controls, dirty guards, and warning copy. |
| AB-4.2 🟩 Done | Focused live coverage shall verify one metadata/default round trip and one mixed exclusive/shared permanent deletion without repeating the unit failure matrix. |
| AB-4.3 🟩 Done | Chromium shall exercise the complete management flow. Firefox shall retain one smoke flow for the critical workspace controls and resulting list state. |
