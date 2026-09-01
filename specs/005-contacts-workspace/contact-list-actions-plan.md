# Implementation Plan: Contact List Bulk Actions

## Boundaries

- Contact selection and presentation remain protocol-neutral Vue state.
- Stores queue local row ids; the shared worker resolves JMAP ids and rights.
- JMAP owns `addressBookIds`, `ifInState`, Set limits, and per-object errors.
- Successful operations reconcile authoritative cards before resolving.
- AddressBooks remain server collections; JMAP Contact Groups are deferred.

## Work packages

### WP1 — Contract and shared list primitives

Record CL-1 through CL-5, generalize stable-key list selection, extract shared
selection-header chrome, and factor browser drag transport without coupling
contact rows to message rows.

### WP2 — Contact selection and transfer UI

Add contact-only multi-selection, contextual Delete and Move controls, hidden
detail behavior, dirty-editor protection, responsive keyboard/touch access,
and validated AddressBook drop targets.

### WP3 — AddressBook rights and batch contract

Persist nullable write rights, add a plural local-id contact mutation, keep
legacy pending rows readable, and carry per-contact outcomes back to the UI.

### WP4 — JMAP batch execution and cache repair

Build sparse membership patches, combine scoped updates and final-membership
destroys, chunk by server limits, rebase on state mismatch, checkpoint accepted
work, and batch authoritative cache repair.

### WP5 — Verification

Cover shared primitives, UI state, rights, protocol requests, durability, and
cache application with focused tests, then verify UI, SQLite, and direct JMAP
state in Chromium and Firefox.

## Data flow

```text
contact checkbox / row drag / Move menu / Delete
  -> ContactsView scope and dirty-editor guard
  -> contacts store plural local-id request
  -> pending_mutations contact-write lane
  -> fresh JMAP ContactCard + AddressBook rights
  -> server-sized ContactCard/set update + destroy
  -> accepted-write checkpoint
  -> targeted authoritative get + batched SQLite apply
  -> Contacts broadcast and selection/detail reconciliation
```

## Compatibility

- Existing multiple AddressBook memberships, including Trusted Senders, remain
  intact unless the viewed source membership is explicitly moved or deleted.
- Existing queued `deleteContact` mutations continue through their legacy
  handler.
- Message list behavior and future conversation rendering remain independent.
- Servers that omit or deny `myRights.mayWrite` expose read-only controls.
