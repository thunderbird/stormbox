# Tasks: Tag Views Include Archive and Exclude Junk

**Input**: `specs/011-message-keywords/plan.md`, `specs/011-message-keywords/spec.md`
**Prerequisites**: `plan.md` (required), `spec.md` (required), `research.md`, `data-model.md`, `quickstart.md`

**Tests**: Included. MK-3.4's verification map names unit and browser
coverage, and `AGENTS.md` requires tests for behavior changes.

**Organization**: This feature has one user story derived from MK-3.4:
tag and Starred views use the correct folder scope. The spec is
requirement-based rather than user-story-based, so US1 is the complete
behavioral increment for issue #237.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to
- Include exact file paths in descriptions

## Path Conventions

Single web application: `src/` and `tests/` at the repository root. All
commands run inside `stormbox-compose`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the amendment and scope before touching code.

- [X] T001 [P] Confirm the feature context and scope in `specs/011-message-keywords/plan.md`: Archive included, Trash and Junk excluded, no child-folder inheritance, no schema change.
- [X] T002 [P] Confirm `specs/011-message-keywords/spec.md` MK-3.4 and `docs/architecture/sqlite-storage.md` state the Trash or Junk exclusion; MK-3.4 includes Archive by omission and leaves child-folder inheritance unspecified, so no additional requirement is added.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Confirm the change needs no database migration.

- [X] T003 Confirm no migration or index task is needed by reading `src/db/migrations/001_init.sql` and `src/db/migrations/017_message_keywords_lower.sql`; the existing `folders.role`, `folder_messages`, and `message_keywords_lower` structures support the unchanged query.

**Checkpoint**: The implementation is known to be a predicate and test change only.

---

## Phase 3: User Story 1 - Correct tag and Starred folder scope (Priority: P1) 🎯 MVP

**Goal**: Archived messages carrying a tag or star appear in tag and
Starred views; Trash and Junk messages do not.

**Independent Test**: Seed or cache one tagged message in Inbox, Sent,
Archive, Trash, and Junk. Open a tag view and `Starred`. Archive, Inbox,
and Sent appear; Trash and Junk do not. A message in Inbox and Junk is
hidden; a message in Inbox and Archive is shown. The sidebar count equals
the cached query count.

### Tests for User Story 1

> **NOTE**: Write these tests first and confirm they fail against the
> current `role IN ('trash', 'archive')` predicate.

- [X] T004 [P] [US1] Rewrite the tag view test in `tests/unit/db/handlers.test.ts`: Archive-only row included; Trash-only and Junk-only rows excluded; Inbox+Archive included; Inbox+Junk excluded; `message.listKeywords({ forTagView: true })` counts match.
- [X] T005 [P] [US1] Rewrite the first case in `tests/e2e/tag-view.spec.js`: seed tagged mail in Inbox, Sent, Archive, Trash, and Junk; expect Archive, Inbox, and Sent visible, Trash and Junk absent, for both a defined tag and `$flagged`; assert cached `listMessagesForKeyword` rows and sidebar counts agree. Update the filing cases so Archive filing keeps the row and Trash or Junk filing removes it.

### Implementation for User Story 1

- [X] T006 [US1] Change `TAG_VIEW_ELIGIBLE_SQL` in `src/db/handlers.ts` from `role IN ('trash', 'archive')` to `role IN ('trash', 'junk')`, and update the two comments in that file that still say “outside Trash and Archive”.
- [X] T007 [US1] Confirm MK-3.4 says `Successful Junk and Delete actions remove the rows and update tag counts`, matching the new filing behavior; update the tag view note in `docs/architecture/sqlite-storage.md` if any stale Trash/Archive wording remains; keep the Starred and sidebar-count sentence consistent.

**Checkpoint**: US1 is independently testable and is the complete MVP for issue #237.

---

## Phase 4: Polish & Cross-Cutting Concerns

**Purpose**: Verify the contract across layers and leave no stale wording.

- [X] T008 [P] Run the focused unit suite in the container: `npx vitest run tests/unit/db/handlers.test.ts tests/unit/stores/mail-store.test.ts`.
- [X] T009 [P] Run `npm run typecheck` in the container and fix any type errors.
- [X] T010 [P] Search for stale scope wording with `rg -n "Trash or Archive|Trash and Archive|exclude.*Archive|archive.*exclude" src tests docs specs/011-message-keywords`; update only comments and documentation, not historical research notes.
- [X] T011 Run the browser suite in the container: `npm run test:e2e:local:full -- tests/e2e/tag-view.spec.js --project=chromium --project=firefox`; investigate any failure before treating it as a product defect.
- [X] T012 Review the final diff for unrelated changes and commit with `Include archived messages in tag views and exclude junk messages. (Fixes #237)`.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies; can start immediately.
- **Foundational (Phase 2)**: Depends on Setup; confirms no migration.
- **User Story 1 (Phase 3)**: Depends on Foundational; tests first, then predicate and documentation.
- **Polish (Phase 4)**: Depends on US1 completion.

### User Story Dependencies

- **US1 (P1)**: No dependency on another story. It is the entire feature.

### Within US1

- T004 and T005 (tests) must be written and must fail before T006 (implementation).
- T006 changes the predicate; T007 aligns the spec and architecture note.
- T008–T011 verify the result; T012 commits only after they pass.

### Parallel Opportunities

- T001 and T002 are independent.
- T004 and T005 touch different test files and can be written in parallel.
- T008, T009, and T010 are independent verification tasks.
- T010's search must not rewrite historical notes in `specs/011-message-keywords/research.md`.

---

## Parallel Example: User Story 1

```text
# Write the failing tests together:
Task: "Rewrite tests/unit/db/handlers.test.ts for Archive included, Trash/Junk excluded"
Task: "Rewrite tests/e2e/tag-view.spec.js for Archive visible, Trash/Junk absent"

# Then implement and align docs:
Task: "Change TAG_VIEW_ELIGIBLE_SQL and comments in src/db/handlers.ts"
Task: "Update MK-3.4 and docs/architecture/sqlite-storage.md"
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1: confirm scope and existing amendment.
2. Complete Phase 2: confirm no migration is required.
3. Complete Phase 3: make the tests fail for the right reason, then change the predicate.
4. **STOP and VALIDATE**: run the focused unit suite and the tag view E2E.
5. Commit. This closes issue #237.

### Incremental Delivery

This feature has one story. There is no second increment to schedule.
Do not add child-folder inheritance or per-folder union semantics; both
are explicit non-goals in `research.md`.

### Notes

- [P] tasks touch different files or are independent read-only checks.
- Do not change `src/db/repository.ts` signatures; the RPC contract is
  unchanged.
- Do not add a migration, index, JMAP request, or outbox mutation.
- The tag manager's keyword discovery (`forTagView` omitted) must keep
  seeing all folders.
