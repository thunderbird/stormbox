# Implementation Plan: Tag Views Include Archive and Exclude Junk

**Branch**: `011-tag-view-archive-junk` | **Date**: 2026-11-13 | **Spec**: [spec.md](./spec.md)

**Input**: MK-3.4 amendment for issue #237: tag and Starred views include
Archived messages and exclude Junk messages.

## Summary

Change the local smart-view eligibility predicate used by tag views and
Starred from `role IN ('trash', 'archive')` to
`role IN ('trash', 'junk')`. Archived messages carrying the keyword
become visible, Junk messages stop appearing, and Trash remains excluded.
The change is confined to the local cache query; there is no JMAP call,
schema migration, or mutation path change.

The same predicate already drives tag view rows, tag view counts, sidebar
tag counts, and the Starred view, so one constant change covers all of
them. The implementation work is mostly updating the spec, architecture
note, and regression tests that currently pin the opposite behavior.

## Technical Context

**Language/Version**: TypeScript, Vue 3, Node.js 22 (`.node-version`)

**Primary Dependencies**: Vue 3, Pinia, Vite, wa-sqlite, Vitest, Playwright

**Storage**: Browser-local SQLite in the shared writer worker; JMAP remains
the source of truth

**Testing**: Vitest unit tests, Playwright E2E on Chromium and Firefox

**Target Platform**: Desktop and mobile browsers; secure context with
SharedWorker/DedicatedWorker and IndexedDB

**Project Type**: Single web application (`src/` + `tests/`)

**Performance Goals**: No regression. A tag view is capped at 2000 rows
(MK-3.4); the predicate change does not alter the query shape or add a
sort.

**Constraints**: Cache-first reads; account-scoped queries; no protocol
access from the store or UI; no schema change

**Scale/Scope**: One predicate constant in `src/db/handlers.ts`; affected
behaviors are tag views, Starred, and sidebar tag counts

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment |
|:--|:--|
| I. Browser-Owned Mail Client | Pass. No server component or new backend is added. |
| II. Cache-First, Server-Authoritative | Pass. The view remains a local SQLite read over the cache. No new JMAP query. |
| III. Layer Boundaries | Pass. The change stays in `src/db/handlers.ts`; the store and UI keep using `Repository`. |
| IV. Mutation Pipeline | Pass. No user action or server state is mutated. |
| V. Incremental Sync | Pass. No sync, state-token, or refresh behavior changes. |
| VI. Safe Email Rendering | Pass. No message content rendering is touched. |
| VII. Single-Account MVP | Pass. The predicate remains scoped by `account_id`. |
| VIII. Earlybird-Ready Scope | Pass. This is a small correctness fix to an existing view. |
| IX. Themed Widgets, Not Native Chrome | N/A. No control is added or changed. |
| X. Stable Interactive Surfaces | Pass. The tag view keeps its synthetic root, header, toolbar, geometry, and selection model. Only membership changes. |
| Verified Consistency | Not triggered. This is a read-only cache query, not a server+cache mutation. Existing `tag-view.spec.js` coverage is extended for the new contract. |

**Post-design re-check**: No new violation after Phase 1. No complexity
justification is needed.

## Project Structure

### Documentation (this feature)

```text
specs/011-message-keywords/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
└── spec.md              # MK-3.4 amendment
```

No `contracts/` directory is generated. The behavior is an internal
Repository RPC over the local cache, not a public API, protocol surface,
or user-facing command schema.

### Source Code (repository root)

```text
src/
├── db/
│   ├── handlers.ts       # TAG_VIEW_ELIGIBLE_SQL and tag view RPCs
│   └── repository.ts     # unchanged signatures
├── stores/
│   └── mail-store.ts     # unchanged tag view loading/counts
└── components/
    └── FolderTree.vue    # unchanged tag view rows and counts

tests/
├── unit/
│   ├── db/handlers.test.ts
│   └── stores/mail-store.test.ts
└── e2e/
    └── tag-view.spec.js

docs/architecture/
└── sqlite-storage.md     # "Smart folder: arbitrary keyword" note
```

**Structure Decision**: Single Vue application with the existing worker
database layer. The implementation touches the database handler constant
and its regression tests; no new modules are introduced.

## Implementation Approach

1. **Change eligibility in one place**

   In `src/db/handlers.ts`, update `TAG_VIEW_ELIGIBLE_SQL`:

   ```sql
   AND excluded_folder.role IN ('trash', 'junk')
   ```

   This predicate feeds:

   - `MESSAGE_LIST_FOR_KEYWORD` (tag view rows)
   - `MESSAGE_COUNT_FOR_KEYWORD` (tag view count)
   - `MESSAGE_LIST_KEYWORDS` with `forTagView: true` (sidebar counts)

2. **Keep the existing global-membership semantics**

   A message with any Trash or Junk membership is excluded, even if it is
   also filed in Inbox, Sent, or Archive. This preserves the existing
   predicate shape and MK-3.4 wording. Per-folder union semantics, as in
   Thunderbird Desktop, are out of scope for this change. See
   `research.md`.

3. **Do not add child-folder inheritance**

   Only the role-bearing folder itself is excluded. A child of Trash or
   Junk is a roleless user folder and does not inherit the parent role.
   This is explicitly out of scope for issue #237. See `research.md`.

4. **Update documentation**

   - `docs/architecture/sqlite-storage.md`, "Smart folder: arbitrary
     keyword": change "Trash or Archive membership" to "Trash or Junk
     membership".
   - `specs/011-message-keywords/spec.md`, MK-3.4 and its verification
     map: ensure the Archive-included/Junk-excluded contract is stated,
     including Starred and sidebar counts.
   - Code comments in `src/db/handlers.ts` that still say "outside Trash
     and Archive" must say "outside Trash and Junk".

5. **Update tests first**

   - `tests/unit/db/handlers.test.ts` currently asserts that Archive is
     excluded and Junk is kept. Invert that expectation: an archived
     message appears; a junk message does not; a trashed message does
     not; a multi-membership message with Junk is hidden.
   - `tests/unit/stores/mail-store.test.ts` tag view tests should continue
     to cover counts and broadcasts; update any fixtures that assume the
     old predicate.
   - `tests/e2e/tag-view.spec.js`: rename the first case from "exclude
     Trash and Archive" to the new contract. Seed tagged messages in
     Inbox, Sent, Archive, Trash, and Junk; assert that Archive appears,
     Trash and Junk do not, and sidebar counts agree. Keep the existing
     cache assertions through `window.__repo` and the server fixtures.
   - Starred is covered by the same predicate; assert both `$flagged` and
     a defined tag in the browser case.

6. **Run the verification**

   See `quickstart.md`. All commands run inside `stormbox-compose`.

## Risks and Mitigations

| Risk | Mitigation |
|:--|:--|
| Starred behavior changes unintentionally | MK-3.4 already ties Starred to the same exclusions; assert both `$flagged` and a tag in the E2E. |
| Existing tests encode the old contract | Update the assertions in the same change; do not weaken them to only check one folder. |
| Multi-membership semantics become ambiguous | Keep the global `NOT EXISTS` predicate and state it explicitly in MK-3.4. |
| Comment and docs drift | Update the spec, architecture note, and handler comments in the same commit. |
| Performance regression | No query shape change; the predicate is the same `NOT EXISTS` lookup. No new index is required for this change. |

## Complexity Tracking

> No Constitution Check violations. No complexity justification is needed.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|:--|:--|:--|
| — | — | — |
