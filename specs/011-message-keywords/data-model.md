# Data Model: Tag View Folder Scope

**Feature**: MK-3.4 amendment for issue #237
**Date**: 2026-11-13

This change affects only read predicates over existing tables. No table,
column, index, or migration is added or modified.

## Entities

### Folder

Represents a JMAP `Mailbox`, called a folder in Stormbox.

| Field | Type | Notes |
|:--|:--|:--|
| `id` | integer | Local primary key. |
| `account_id` | integer | Owning JMAP account. |
| `remote_id` | text | JMAP Mailbox id. |
| `parent_id` | integer, nullable | Hierarchy parent. No role inheritance. |
| `name` | text | Display name. |
| `role` | text, nullable | Lowercase JMAP role, or `null` for a user folder. |
| `is_deleted` | integer | Soft-delete marker. |

Relevant roles for this change:

- `trash` — excluded from tag views and Starred.
- `junk` — excluded from tag views and Starred.
- `archive` — included.
- `inbox`, `sent`, `drafts`, `scheduled`, and roleless user folders —
  included unless the message also has a Trash or Junk membership.

`role` belongs to one folder. A child of a role folder is a separate row
with its own `role`, normally `null`.

### Folder membership

`folder_messages` is the many-to-many junction between a message and the
folders it is filed in.

| Field | Type | Notes |
|:--|:--|:--|
| `folder_id` | integer | References `folders.id`. |
| `message_id` | integer | References `messages.id`. |
| `account_id` | integer | Owning account, denormalized for scoping. |
| `sort_received_at` | integer, nullable | Membership-specific sort key. |
| `sort_sent_at` | integer, nullable | Membership-specific sort key. |

A message may have several memberships. This is central to the exclusion
rule below.

### Message

Cached message metadata.

| Field | Type | Notes |
|:--|:--|:--|
| `id` | integer | Local primary key. |
| `account_id` | integer | Owning JMAP account. |
| `remote_id` | text | JMAP Email id. |
| `received_at` | integer | Tag view sort key. |
| `keywords_json` | text | Full keyword object as last seen or optimistically written. |
| `is_flagged` | integer | Derived from `$flagged`. |

### Message keyword

`message_keywords` is the join table used to find messages by keyword.

| Field | Type | Notes |
|:--|:--|:--|
| `message_id` | integer | References `messages.id`. |
| `keyword` | text | Server spelling, matched with `LOWER()`. |

`message_keywords_lower` is an expression index on
`(LOWER(keyword), message_id)`. It already serves the tag view.

### Tag view (derived, not stored)

A tag view is not a row in `folders`. It is a synthetic view addressed by a
negative id (`tagViewIdFor`) and defined by:

- the signed-in account (`accountIds`)
- one lowercase keyword, or `$flagged` for Starred
- newest first by `received_at DESC, id DESC`
- a cap of 2000 rows
- one `source_folder_id` per row, chosen from the row's memberships

A folder row surfaced to folder-keyed code is synthetic and exists only in
the store. The database has no tag view table.

## Eligibility rule

A message is eligible for a tag view or Starred view when:

1. Its `messages.account_id` is in the requested account list.
2. It has a `message_keywords` row matching the requested keyword
   case-insensitively.
3. It has **no** `folder_messages` row whose folder has
   `folders.role IN ('trash', 'junk')` in the same account.

In predicate form:

```sql
NOT EXISTS (
  SELECT 1
    FROM folder_messages excluded_membership
    JOIN folders excluded_folder
      ON excluded_folder.id = excluded_membership.folder_id
   WHERE excluded_membership.message_id = m.id
     AND excluded_folder.account_id = m.account_id
     AND excluded_folder.role IN ('trash', 'junk')
)
```

This is a global exclusion over the message's memberships:

- Inbox only → included.
- Archive only → included.
- Inbox + Archive → included.
- Sent only → included.
- Roleless user folder only → included.
- Trash only → excluded.
- Junk only → excluded.
- Inbox + Junk → **excluded**, because one membership is Junk.
- Trash + Archive → **excluded**, because one membership is Trash.

Per-folder union semantics, where a message survives through any
non-excluded membership, are not part of this change. See
`research.md` Decision 2.

## Counts

`MESSAGE_COUNT_FOR_KEYWORD` and the `forTagView: true` form of
`MESSAGE_LIST_KEYWORDS` use the same eligibility rule. Therefore:

- a tag view's row count and its sidebar count agree
- Starred's sidebar count agrees with the Starred view
- the tag manager's keyword discovery, which does not pass
  `forTagView`, still sees keywords in all folders

## State transitions

There are no persisted state transitions. The view is a read model whose
inputs change when:

- a message gains or loses a keyword (`message_keywords`,
  `keywords_json`)
- a message is filed or unfiled (`folder_messages`)
- a folder's role changes or the folder is removed (`folders`)
- a message is destroyed

The store reloads a tag view on the relevant `MESSAGES` broadcast
(MK-3.4). No new event or mutation type is introduced.

## Validation and edge cases

| Case | Expected behavior |
|:--|:--|
| Empty account list | Return `[]` or `0`, as today. |
| Empty keyword | Return `[]` or `0`, as today. |
| Keyword spelled with different case in the cache | Match with `LOWER(keyword)` (MK-1.5). |
| Message in Archive and Trash | Excluded because of the Trash membership. |
| Message in Archive and Inbox | Included. |
| Message in Junk and Inbox | Excluded because of the Junk membership. |
| Message in a child of Trash or Junk | Included; children do not inherit roles. Out of scope for this change. |
| Shared-account messages | Not included; tag views cover the signed-in account only (MK-3.4). |
| More than 2000 matching rows | The view lists the newest 2000; the sidebar count remains the full count. |

## Schema impact

None. No migration is required. The existing roles, keyword join, and
membership table are sufficient.
