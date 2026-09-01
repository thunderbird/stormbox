# Implementation Plan: Contact Details and Identity Editing

## Boundaries

- Vue renders protocol-neutral detail DTOs and queues durable mutations through
  the Contacts store.
- Repository RPC owns cache reads and writes but does not interpret JSContact.
- The JMAP backend owns ContactCard and Identity wire shapes, stable-key patch
  construction, protocol validation, and authoritative post-write repair.
- `raw_json` is the lossless server snapshot; normalized rows are rebuildable
  cache projections used by the UI and search.
- Squire is instantiated only by the shared rich-text editor component.

## Work packages

### WP1 — Contract and shared editor

Specify CT-1 through CT-6, extract the existing Squire implementation without
changing compose behavior, and move editor-level characterization tests out of
the compose dialog suite.

### WP2 — Keyed contact cache and protocol

Add stable map keys and normalized detail tables, request complete
ContactCards, preserve raw objects, generate durable UIDs, and replace
whole-map writes with sparse leaf patches plus targeted reconciliation.

### WP3 — Three-column Contacts UI

Build the shared rail/list/detail shell, accessible virtual selection,
responsive drill-in, dirty-navigation protection, and the complete contact
viewer/editor.

### WP4 — Complete Identity UI and protocol

Expose every RFC 8621 mutable Identity field, reuse the detail shell and rich
editor, enforce server limits, preserve typed failures, and use targeted
post-write cache repair.

### WP5 — Identity defaults in compose

Apply Bcc and paired signatures before initial compose seeding, retain
session-only provenance, safely replace untouched defaults when From changes,
and route signature images through the existing inline-part pipeline.

### WP6 — Verification and review

Run focused and full static/unit/build gates, then Chromium and Firefox live
tests that verify UI, SQLite, and direct JMAP. Complete the Fable browser
review and fixes, freeze the tree, run the three-model code review, prove
retained findings in a disposable copy, update the canvas, and stop for user
approval.

## Data flow

```text
ContactCard/get or Identity/get
  -> JMAP normalization
  -> normalized SQLite projections + complete raw_json
  -> Repository detail DTO
  -> Contacts store
  -> detail viewer/editor

detail editor
  -> protocol-neutral durable mutation
  -> JMAP sparse set
  -> targeted authoritative get
  -> normalized SQLite projections
  -> broadcast and authoritative UI repaint
```

## Compatibility

- Existing flat/legacy contact shapes remain readable.
- Unknown JSContact properties and unsupported metadata remain in `raw_json`
  and survive sparse edits.
- Contact autocomplete remains name/organization/email based and email-only as
  an output.
- Existing server drafts never receive inferred Identity defaults.
- Signature data URLs are bounded by the pinned server's signature limit and
  become JMAP Email inline parts only after insertion into a compose session.
