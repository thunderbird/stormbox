# Tasks: Contact List Bulk Actions

## Phase 1 — Contract and shared foundations

- [x] L001 Record CL-1 through CL-5 and add the controlling MVP reference
- [x] L002 Generalize stable-key list selection and extract shared
      selection-header chrome without coupling contact rows to MessageList
- [x] L003 Extract domain-neutral drag transport while preserving existing
      message drag/drop behavior

## Phase 2 — Contact list interactions

- [x] L101 Add contact-only checkbox, modifier, range, keyboard, and select-all
      behavior with viewed and bulk-selected state kept separate
- [x] L102 Add contextual scoped/global Delete and the Move to address book
      menu with dirty-editor protection and partial-result recovery
- [x] L103 Add grouped contact dragging and writable AddressBook drop targets;
      reject All Contacts, Identities, source, and read-only targets
- [x] L104 Preserve desktop/tablet/phone focus, detail hiding, touch controls,
      live announcements, and 10,000-row virtualization bounds

## Phase 3 — Rights and durable batch mutation

- [x] L201 Persist nullable AddressBook write rights and enforce unknown rights
      fail-closed
- [x] L202 Add one discriminated local-id plural contact mutation and retain
      legacy queued single-contact dispatch
- [x] L203 Return per-contact success/failure outcomes and generalize the large
      bulk-operation overlay for Mail and Contacts

## Phase 4 — JMAP and cache consistency

- [x] L301 Build fresh, sparse move and scoped-delete patches with `ifInState`
      and final-membership destruction
- [x] L302 Dispatch real server-limited `ContactCard/set` batches and preserve
      unrelated memberships and contact fields
- [x] L303 Checkpoint accepted chunks, retry only unresolved work, rebase state
      mismatches, and apply authoritative cache updates/deletes in batches

## Phase 5 — Verification

- [x] L401 Cover shared selection/drag, UI state, permissions, protocol,
      batching, durability, and cache repair with focused unit tests
- [x] L402 Pass typecheck, lint, unit, and production-build gates
- [x] L403 Pass Chromium and Firefox UI/cache/direct-JMAP coverage and update
      requirement/task statuses
