# Tasks: Contact Details and Identity Editing

## Phase 1 — Contract and shared editor

- [x] C001 Record CT-1 through CT-6 and update the controlling MVP, compose,
      draft, storage, and test contracts
- [x] C002 Extract one Squire-backed rich-text editor with paired HTML/text
      output, focus/reset APIs, sanitization, keyboard handling, toolbar
      overflow, and inline-image behavior
- [x] C003 Move editor characterization tests to the shared component while
      retaining compose integration and minimized-session coverage

## Phase 2 — Contact cache and JMAP model

- [x] C101 Add stable email map keys and normalized phone, link, anniversary,
      note, organization, unit, and title cache tables
- [x] C102 Extend protocol-neutral repository DTOs and invalidate legacy cached
      contact rows through migration while preserving durable outbox work
- [x] C103 Persist complete ContactCard snapshots and normalize every surfaced
      keyed field without moving JSContact parsing into the database layer
- [x] C104 Generate durable ContactCard UIDs, support email-less cards, and
      reconcile ambiguous create outcomes by UID
- [x] C105 Build sparse stable-key ContactCard updates that preserve unknown,
      unedited, and concurrently added properties

## Phase 3 — Directory shell and Contact editor

- [x] C201 Split Contacts into reusable rail, virtualized list, and detail
      shell components with stable selection and stale-read protection
- [x] C202 Add desktop/tablet/phone layouts, mobile drill-in, keyboard listbox
      behavior, focus restoration, and dirty-navigation confirmation
- [x] C203 Render contact rows with name and first/preferred email only
- [x] C204 Add contact view/create/edit states for repeated email, phone,
      website, standard-date, and note fields
- [x] C205 Add repeatable Work affiliations with organization, department,
      title, role, and a themed affiliation selector

## Phase 4 — Complete Identity editor

- [x] C301 Persist and expose Reply-To, Bcc, HTML signature, text signature,
      and server mutability metadata
- [x] C302 Add Identity view/create/edit to the shared detail shell with
      immutable existing email and protected deletion
- [x] C303 Reuse the shared editor for signatures, including bounded raster
      data URLs and exact UTF-8 server-limit validation
- [x] C304 Send sparse Identity creates/updates, preserve enumerated field
      errors, and replace full-snapshot mutation repair with targeted repair

## Phase 5 — Compose defaults

- [x] C401 Apply Reply-To, Bcc, and signatures to new/reply/forward sessions
      before the initial seed
- [x] C402 Track automatic Bcc/signature provenance and replace only intact
      values when From changes
- [x] C403 Keep reopened drafts unchanged, strip internal markers from all
      durable/wire payloads, and reuse the inline-image CID pipeline

## Phase 6 — Verification and review

- [x] C501 Cover migration, normalization, mutation, UI, editor, accessibility,
      responsive, performance, and compose-default behavior with focused tests
- [x] C502 Pass full unit, typecheck, lint, and production build gates
- [x] C503 Pass Chromium and Firefox UI/cache/direct-JMAP mutation coverage
- [x] C504 Complete Fable 5 browser-first review, fix independently reproduced
      high-confidence issues, and record fixes in the review canvas
- [x] C505 Freeze one immutable snapshot; complete Grok 4.6, GPT 5.6 Sol, and
      Opus 5 reviews; prove retained findings in a disposable copy; update the
      final-review canvas tab; and stop before fixes
