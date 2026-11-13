# Research: Tag View Folder Scope

**Feature**: MK-3.4 amendment for issue #237
**Date**: 2026-11-13

## Decision 1: Exclude by JMAP role on the membership folder

**Decision**: A tag view or Starred view includes a message unless the
message has a membership in a folder whose `folders.role` is `trash` or
`junk`. The predicate becomes:

```sql
AND excluded_folder.role IN ('trash', 'junk')
```

**Rationale**:

- JMAP `Mailbox.role` is the portable way to identify special folders.
  `trash`, `junk`, `archive`, `inbox`, and `sent` are RFC 8621 roles;
  Stormbox already stores them in `folders.role`.
- `TAG_VIEW_ELIGIBLE_SQL` is the single predicate behind
  `MESSAGE_LIST_FOR_KEYWORD`, `MESSAGE_COUNT_FOR_KEYWORD`, and
  `MESSAGE_LIST_KEYWORDS` with `forTagView: true`. Changing the role list
  updates rows, view counts, and sidebar counts together.
- Archive is a normal place to keep tagged mail. Thunderbird Desktop's
  tag views include it, matching the report in issue #237.
- Junk is excluded from tag views in Thunderbird Desktop and is not
  useful mail to surface through a tag.

**Alternatives considered**:

- Keep `('trash', 'archive')`. Rejected: this is the defect in #237.
- Exclude only `trash`. Rejected: Junk mail would remain eligible, unlike
  Thunderbird and unlike the amended MK-3.4.
- Filter in the store or UI. Rejected: the cache query is the single
  source for rows and counts; filtering later would make counts and rows
  disagree and leave the worker returning ineligible messages.

## Decision 2: Keep global membership exclusion

**Decision**: If a message has any Trash or Junk membership, it is
excluded from the tag view, even when it also has an Inbox, Sent, or
Archive membership.

**Rationale**:

- The existing predicate is a `NOT EXISTS` over all memberships, and
  MK-3.4 says "excluding any message with a Trash or Junk membership".
  This change preserves that semantic and only swaps Archive for Junk.
- The cache query stays simple: one anti-join against `folder_messages`
  and `folders`.
- It keeps rows and counts consistent without a second grouping step.

**Alternatives considered**:

- Thunderbird Desktop's model: a tag virtual folder searches every
  included folder, so a message filed in both Inbox and Junk appears
  through the Inbox membership because only the Junk folder is skipped.
  Adopting that here would change the meaning of "membership", require a
  different query shape (include if any membership is outside Trash or
  Junk), and change existing multi-membership tests. It is out of scope
  for #237.

**Explicit consequence**: A message in both Inbox and Junk does not
appear in a tag view. A message in both Inbox and Archive does appear.
The tests should pin this so the choice is not accidental.

## Decision 3: No child-folder inheritance

**Decision**: Only the role-bearing folder itself excludes a message. A
child folder of Trash or Junk is an ordinary roleless folder and does not
inherit the parent's role.

**Rationale**:

- JMAP roles are properties of a single Mailbox, not inherited by its
  children.
- `specs/003-folder-management/spec.md` FM-7.6 permits system folders to
  host children, but no Stormbox spec defines role inheritance for
  message views or actions.
- Implementing inheritance correctly requires walking `folders.parent_id`
  recursively or in the store, plus tests for nested Trash/Junk. That is
  a separate product decision and is out of scope for #237.

**Alternatives considered**:

- Recursive CTE in `TAG_VIEW_ELIGIBLE_SQL` to exclude role-folder
  descendants. Rejected for this change: no requirement, no tests, and it
  would make the predicate harder to reason about.
- Store-side ancestry check. Rejected for the same reason; the worker
  query is the right boundary if this is specified later.

## Decision 4: Starred uses the same predicate

**Decision**: The account-wide `Starred` view also includes Archived
messages and excludes Junk messages.

**Rationale**: MK-3.4 explicitly says "The same exclusions apply to
Starred and sidebar counts." Keeping one predicate avoids a second,
divergent definition of an account-wide view.

**Alternatives considered**: Separate Starred folder scope. Rejected
unless the product spec says otherwise; it would add a second predicate
and a second set of tests for no reported user need.

## Decision 5: No schema or index change

**Decision**: Do not add or change SQLite schema, migrations, or indexes.

**Rationale**:

- The predicate uses existing `folder_messages` and `folders` columns.
- `message_keywords_lower` already serves the keyword match.
- The query shape is unchanged; only the literal role list changes.
- `folder_messages` has no `message_id` index, but the current tag view
  already uses this anti-join. This change does not make that worse, and
  adding an index is a separate performance decision.

## Reference behavior: Thunderbird Desktop

Thunderbird's tag views are virtual folders. The relevant chain is:

- `mail/modules/SmartMailboxUtils.sys.mjs` creates one virtual folder per
  tag with `searchFolderUri = "*"` and the tag condition as its search
  term.
- `mail/modules/DBViewWrapper.sys.mjs` expands `"*"` to every folder in
  every account except folders matching `Trash | Junk | Queue | Virtual`.
  Archive is not in that list, so archived messages are searched.
- `nsMsgDBFolder::IsSpecialFolder(..., true)` checks ancestors, so
  Thunderbird also excludes subfolders under Trash or Junk.
- `Queue` and `Virtual` are Thunderbird folder flags with no Stormbox
  equivalent: Stormbox's send queue is the mutation outbox, and its tag
  and Starred views are synthetic negative-id views, not `folders` rows.

Stormbox follows the same Archive-included/Junk-excluded rule for direct
memberships. It deliberately does not copy the ancestor behavior in this
change.

## Resolved Unknowns

The Technical Context is fully known from the repository and the spec:

- Language and stack: TypeScript, Vue 3, Pinia, wa-sqlite.
- Test runners: Vitest and Playwright.
- Storage: local SQLite; no protocol change.
- Target: Chromium and Firefox.

No `NEEDS CLARIFICATION` items remain for this scope. The only deferred
questions are explicit non-goals: child-folder inheritance and
per-folder union semantics for multi-membership messages.
