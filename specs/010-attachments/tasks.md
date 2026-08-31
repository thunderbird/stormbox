# Tasks: Attachment Support

## Phase 1 — Contract and architecture

- [ ] A001 Record AT-1 through AT-6 in `specs/010-attachments/spec.md`
- [ ] A002 Add `research.md`, `plan.md`, and this task list
- [ ] A003 Update `specs/001-mvp-scope/spec.md` attachment and compose rows;
      remove file picking from deferred scope
- [ ] A004 Amend `.specify/memory/constitution.md` ephemeral byte-transfer rule
- [ ] A005 Extend architecture notes for preview rendering and blob routing

## Phase 2 — Ephemeral blob transfer

- [ ] A101 Add compose-upload and attachment-download RPCs with Blob/File bodies,
      progress, cancellation, and preserved base64 download callers
- [ ] A102 Route transfers by local account id; fix received download ownership
- [x] A103 Expose live upload/attachment/concurrency limits and validate before transfer
- [ ] A104 Sanitize download filenames and revoke transient object URLs

## Phase 3 — Received attachment UI

- [x] A201 Refactor message view into header, body scroller, and attachment bar
- [x] A202 Implement MIME-ordered bar, Preview/Download actions, and row state
- [x] A203 Add raster figures after body and capped on-demand text preview
- [x] A204 Tighten CID classification and stale-completion guards

## Phase 4 — Compose picker, paste, and session state

- [x] A301 Add paperclip + multiple picker beside Send and attachment rows
- [x] A302 Upload immediately; gate Send; retain `File` until draft checkpoint
- [x] A303 Classify paste: inline raster ≤ 10 MiB vs regular attachment
- [x] A304 Handle partial failure, retry/cancel/remove, and close/save copy

## Phase 5 — Draft/send MIME and blob rotation

- [x] A401 Encode regular attachments in shared `multipart/mixed` builder
- [x] A402 Reuse canonical part blob ids across revisions (CD-6.10)
- [x] A403 Seed reopened drafts from server parts; merge by stable client id

## Phase 6 — Verification

- [x] A501 Unit-test classification, layout, RPC limits, cancellation, and MIME
- [x] A502 Add live integration cases for received, compose, and failure paths
- [ ] A503 Add Chromium/Firefox Playwright coverage per AT-6.5
- [ ] A504 Run typecheck, lint, unit, build, and both-browser E2E gates
- [x] A505 Update requirement statuses in `spec.md` and `001-mvp-scope`
