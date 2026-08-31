# Implementation Plan: Attachment Support

## Boundaries

- Vue renders attachment metadata and transient compose state; it does not
  call JMAP or `fetch` directly.
- Received downloads and compose uploads use cancellable worker RPCs that
  move bytes only; they do not write `pending_mutations` rows.
- Every `Email/set`, draft replacement, send, and submission remains on
  the durable outbox path defined by `specs/004-compose-improvements/`.
- Attachment and inline-image MIME construction stays shared between
  draft save and send (CD-6.10).
- No attachment bytes are persisted in SQLite, OPFS, or a second IndexedDB
  store; only metadata and ephemeral memory/object URLs.

## Work packages

### WP1 — Contract and architecture rule

Record AT-1 through AT-6, amend the constitution's mutation exception,
update MVP scope, and add focused architecture notes for safe preview
rendering and blob routing.

### WP2 — Blob transfer plumbing

Add File/Blob-native upload/download RPCs with owning-account routing,
live capability limits, per-transfer cancellation, progress events, and
sanitized browser downloads. Preserve existing base64 download callers.

### WP3 — Received attachment UI

Refactor the message view into header, scrollable body, and adaptive
attachment bar; add Preview/Download actions, capped text preview,
raster figures after the body, and strict CID bar-suppression rules.

### WP4 — Compose picker, paste, and state

Add paperclip + multiple picker beside Send, immediate uploads, retry/
cancel/remove rows, paste classification, and send gating. Retain in-memory
`File` handles until the first confirmed draft checkpoint.

### WP5 — Draft/send MIME and blob rotation

Wire regular attachments into the shared compose MIME builder, reuse
same-account canonical part blob ids across draft revisions, and rotate
handles per CD-6.10 without redundant re-upload.

### WP6 — Verification

Unit-test classification, layout, RPC limits, cancellation, filename
safety, and MIME trees; add Chromium/Firefox live coverage for preview,
download, picker, paste, reopen, send, and uncheckpointed reload recovery.

## Data flow

```text
Received message
  -> SQLite attachment metadata (immediate)
  -> optional worker download RPC (preview/download only)
  -> host-page preview or browser save; iframe keeps authored cid: only

Compose pick/paste
  -> in-memory File + immediate worker upload RPC
  -> temporary blobId in session state
  -> first draft Email/set via pending_mutations
  -> canonical part blob ids on successor revisions (reuse, no re-upload)
  -> send uses same MIME builder as draft save
```

## Compatibility

- R-2.11 inline `cid:` resolution inside the sandboxed iframe is unchanged.
- R-4.8 pasted inline rasters ≤ 10 MiB keep the existing editor/data-URL
  path and `multipart/related` send shape.
- CD-6.10 predecessor/successor blob rotation extends to regular
  attachments; Bulwark regression coverage remains authoritative.
- Shared-mailbox messages download through the owning account id.
