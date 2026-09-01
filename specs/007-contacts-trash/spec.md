# Synced Contacts Trash

This specification defines recoverable whole-card deletion for JMAP Contacts.
The Stormbox constitution and RFC 9610 remain controlling.

## CT-1 — Storage and convergence

| ID | Requirement |
|:--|:--|
| CT-1.1 | Contacts Trash shall use owned, versioned FileNodes named `stormbox-contacts-trash-<random-uuid>.json` under `thundermail/contacts_trash/`. Each local database shall persist one random open shard identity. Existing top-level trash documents shall be validated during pull and queued for serialized relocation before the next write. The legacy `stormbox-contacts-trash.json` may be read as an immutable shard, and new writes shall never target it or `stormbox-settings.json`. |
| CT-1.2 | An active entry shall preserve the complete freshly fetched ContactCard, its UID, prior remote id, original remote AddressBook ids, canonical email keys, deletion time, expiry, and lifecycle timestamp. Remote documents shall contain account-scoped protocol ids only. |
| CT-1.3 | Local storage shall keep a normalized account-scoped projection for list, detail, expiry, and email-suppression queries. Multi-statement projection updates shall be transactional. |
| CT-1.4 | Shard writes shall use FileNode collection discovery, bounded query/get/download, ownership, rights, upload, CAS, and collision checks. Only dirty or explicitly touched shards shall be pushed, and a shard shall become clean only if the uploaded local revision remains current. Clean shards whose FileNode and blob ids are unchanged shall not be downloaded again. Settings and Contacts Trash shall use separate filenames and serialized outbox lanes. |
| CT-1.5 | Snapshot and tombstone shard limits shall come from `stormbox.config.json`, whose FileStorage values shall match the deployment. Defaults shall match the local Stalwart server: 128 records, 25 MiB snapshot shards, and 256 KiB tombstone shards. A complete one-contact record shall be preflighted against the resolved byte limit before ContactCard destruction; arbitrary extension data is not assumed to fit. |
| CT-1.6 | Lifecycle records shall be append-only and merge deterministically by ContactCard UID across all shards. Tombstones shall remain for at least 180 days; currently all shadowed records and tombstones remain until compaction can prove that no older active record can resurrect. |

## CT-2 — Delete saga

| ID | Requirement |
|:--|:--|
| CT-2.1 | Removing one membership from a card that retains another membership shall not create a trash entry. All Contacts deletion and final-membership removal shall use the trash saga. |
| CT-2.2 | The saga shall fetch the authoritative card and AddressBook rights in groups bounded by the live Core get/set limits and configured shard record limit, persist each group's complete snapshots in exactly one shard, confirm that shard, checkpoint the imminent server write, destroy the same group's ContactCards, then reconcile SQLite before staging another group. A group that cannot fit the shard's remaining or configured byte capacity shall rotate or split recursively. |
| CT-2.3 | A ContactCard shall never be destroyed before its matching active snapshot is confirmed in the remote document. Missing FileNode support, invalid snapshots, marker collisions, and denied rights shall fail closed. |
| CT-2.4 | State mismatches shall re-fetch and reclassify the card. A card that gained another membership shall receive membership-only removal and any staged snapshot shall be tombstoned before the update. |
| CT-2.5 | Missing cards shall converge as successful destroys. Accepted chunks and response-loss windows shall resume from durable checkpoints without replaying completed cache work or creating duplicate snapshots. |
| CT-2.6 | A delete target shall fail closed with `ambiguousUid` when another target in its group has the same UID for a different remote card, or when another active trash snapshot already owns that UID. |
| CT-2.7 | When a server returns a ContactCard without a UID and does not permit adding one, Stormbox shall derive the same account-scoped UID on every client, store it in the confirmed snapshot, and restore the recreated card with that UID. |

## CT-3 — Restore, Delete Forever, and retention

| ID | Requirement |
|:--|:--|
| CT-3.1 | Active snapshots shall expire 30 days after `trashedAt`. The first bootstrap, FileNode StateChange, or reconnect sync at or after expiry shall append a tombstone to a writable shard and queue its CAS write. |
| CT-3.2 | Restore shall recreate the complete snapshot without its server-assigned `id`, preserve its UID, and restore every original AddressBook membership that still exists and has confirmed write rights. |
| CT-3.3 | UID lookup shall recover a restore whose create response was lost. After authoritative card reconciliation succeeds, the trash entry shall become a restored tombstone. |
| CT-3.4 | If no original membership remains writable, restore shall require an explicit writable destination. Stormbox shall not choose a destination silently. |
| CT-3.5 | Delete Forever shall tombstone only the trash entry. It shall not issue another ContactCard destroy. |
| CT-3.6 | Active trash email keys shall suppress automatic recent-recipient and trusted-contact recreation. Restore and purge shall remove that suppression. |

## CT-4 — Workspace

| ID | Requirement |
|:--|:--|
| CT-4.1 | The Contacts rail shall expose Trash with an active-entry count on desktop, tablet, and phone layouts. |
| CT-4.2 | Trash shall reuse the virtualized keyboard-accessible list and bulk selection while identifying its rows as trashed contacts. Stable keys shall be local projection ids. |
| CT-4.3 | Trash snapshots are read-only. Create, edit, move, and drag/drop shall be unavailable. Single and bulk actions shall expose Restore and Delete Forever. |
| CT-4.4 | The restore destination dialog shall appear only for entries with no valid original destination and shall list explicit writable AddressBooks. |
| CT-4.5 | Whole-card delete copy shall state 30-day recovery. Scoped membership-only copy shall remain distinct, and final-membership copy shall explain that those cards move to Trash. |
