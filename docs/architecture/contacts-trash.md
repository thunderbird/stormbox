# Contacts trash

Whole-card contact deletion is a durable saga spanning SQLite, a JMAP
FileNode document, and `ContactCard/set`.

Contacts Trash is independent from user settings. New writes use owned,
versioned shards named `stormbox-contacts-trash-<random-uuid>.json` inside
the JMAP FileNode path `thundermail/contacts_trash/`. User settings live in
`thundermail/`, so every application-owned settings document shares one
top-level namespace while trash data remains isolated below it. Pull is
read-only (`find`, no folder create, no `FileNode/set`) and force-queues the
trash outbox immediately. That outbox creates `thundermail/contacts_trash/`
if needed, then: unique top-level names are moved; a version-2 shard that
exists in both locations is merged into the folder copy and the top-level
node is destroyed in one conditional `FileNode/set`; `stormbox-contacts-trash.json`
in both locations fails closed (`alreadyExists`). Relocation can be the only
work of that run. The legacy filename remains read-only input.
New shards are document version 2; each append uses a random record id as
the map key. Visible state is still last-writer-wins by ContactCard UID.
The legacy file is version 1 and UID-keyed.
Each installation appends snapshots to its persistent local open shard and
terminal records to a separate tombstone lane. Snapshot shards rotate before either hard limit:
the configured record count or serialized UTF-8 byte cap. The record default
is 128. `snapshotShardMaxBytes: null` inherits `serverFileStorage.maxSize`
(checked-in resolve: 25 MiB). Tombstone shards use the same record limit and
default to 256 KiB, so restore, purge, expiry, and rollback never re-upload a
media-bearing snapshot shard.

`stormbox.config.json` records the deployment's FileStorage `maxSize`,
`maxFiles`, and `maxFolders` values and the Contacts Trash limits. Standard
JMAP does not advertise the FileStorage singleton limits, so deployments must
set these values before building Stormbox. `null` count limits mean the server
does not configure a cap; they are diagnostic because FileNode quotas are
shared with non-trash files. Record media caps are 32 items, 16 MiB each,
16 MiB total, plus a 2 MiB snapshot safety budget. Snapshot writes also clamp
to the live Core `maxSizeUpload`.

Active records carry the complete authoritative JSContact object, durable
base64 copies of referenced Media blobs, and account-scoped remote ids.
Bounded raster `data:` URI photos are self-contained in that object and
require no second media copy.
Restored and purged records carry lifecycle tombstones. Records are never
moved between shards, and old shadowed records and tombstones are retained.
The visible state is a deterministic last-writer-wins merge by ContactCard
UID across every shard. Active snapshots expire 30 days after `trashedAt`
(`CONTACTS_TRASH_RETENTION_MS`); the first pull at or after expiry appends a
purged tombstone. Retaining terminal records prevents an older active
record in another shard from resurrecting and exceeds the 180-day convergence
minimum.

SQLite projects the document into `contacts_trash` and
`contacts_trash_emails`. Lists, expiry scans, and recipient suppression use
those indexed tables instead of parsing shard JSON. Each physical document,
its remote FileNode id, dirty bit, and local revision are retained in
`contacts_trash_documents`. The two local open shard names are persisted separately.
Projection and shard metadata writes share one transaction.
Clean shards retain their confirmed FileNode and blob ids. Collection sync
downloads only new or changed blobs, merges them incrementally, then runs
expiry and projection finalization once.

For a whole-card delete, the outbox:

1. Fetches the complete card, referenced Media bytes, and current AddressBook
   rights.
2. Preflights a one-entry shard serialization, then persists the snapshot and
   checkpoints that phase. Unsupported extension data that makes the entry
   exceed the configured byte cap fails before card destruction.
3. Merges and conditionally writes only the touched shard until the snapshot is
   confirmed remotely.
4. Checkpoints the imminent `ContactCard/set`, then destroys the card.
5. Reconciles accepted updates and destroys into SQLite.

Snapshot groups contain at most the live Core get/set limit and the configured
record limit.
Each group is staged atomically into one shard; groups that exceed the shard's
remaining or configured byte capacity rotate or split recursively. Each confirmed
group is written before the next group is staged, so a terminal partial
failure cannot leave unconfirmed active trash records for live cards. Retries
re-fetch before destructive work. A missing card converges as destroyed, while a state mismatch
reclassifies current membership and refreshes the snapshot before another
attempt. Multi-membership scoped removals remain sparse membership patches
and never enter Trash.

A UID identifies one recoverable card. A delete group with duplicate UIDs, or
a live card whose UID is already owned by another active trash snapshot, fails
closed with `ambiguousUid`.

Stalwart accepts ContactCards without a UID but treats UID as immutable, so a
missing value cannot be repaired on the live card. Stormbox derives a stable
account-scoped UUID from the remote account and card ids, adds it only to the
durable trash snapshot, and uses it as the recreated card's UID on restore.
Every client derives the same value for the same UID-less card.

Restore removes the server-assigned `id`, retains the UID, and creates the
card in every original AddressBook that still exists with write rights. If
no original book remains writable, restore does not pick a destination; it
requires an explicit writable book (`destinationRequiredTrashIds`). A UID
query recovers response-loss windows. Preserved Media bytes are uploaded and
their replacement blob ids are patched into the cloned card before creation.
Data-URI media is recreated unchanged.
The restored tombstone is written only after the recreated card has been
fetched into the local contacts cache. Restore, Delete Forever, expiry, and
rollback append terminal records to the writable local tombstone shard; they
do not rewrite the shard that contains the active record.

Live coverage is in `tests/integration/contacts-live.test.ts`: new writes
under `thundermail/contacts_trash/`, UID-less derive/restore
(`contacts-trash\0{accountId}\0{cardId}`), contact-photo restore, and a
purged tombstone. Top-level
relocation and same-name shard merge are unit-only
(`tests/unit/sync/jmap-contacts-trash.test.ts`).
