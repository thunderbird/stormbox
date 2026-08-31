# Attachment Support — Received Mail and Compose

This specification defines Stormbox attachment download and preview on
received messages, file attachment picking and upload in compose, and the
worker blob-transfer plumbing both require. It refines
`specs/001-mvp-scope/spec.md` R-6 and R-4, extends inline-image behavior
in R-4.8, and integrates with draft lifecycle CD-6.10 in
`specs/004-compose-improvements/draft-lifecycle.md`.

The constitution remains controlling except for the explicit ephemeral
byte-transfer exception in Mutation Pipeline (IV). Protocol research lives
in [research.md](./research.md).

**Implementation scope**: Vue 3 + Pinia, browser-local SQLite metadata
only, JMAP Core upload/download (RFC 8620 §§6.1–6.2) and Mail body parts
(RFC 8621) against Stalwart.

## Status legend

- 🟩 **Done** — implemented and covered by tests.
- 🟨 **Partial** — implemented with known gaps, listed inline.
- 🟧 **Planned** — accepted scope, not yet implemented.

## Status overview

| # | Area | 🟩 Done | 🟨 Partial | 🟧 Planned |
|---|---|--:|--:|--:|
| 1 | Received presentation and layout | 8 | — | — |
| 2 | MIME classification and CID rules | 4 | — | — |
| 3 | Ephemeral blob transfer | 3 | — | 4 |
| 4 | Compose attachments | 10 | — | — |
| 5 | Draft/send MIME integration | 4 | — | — |
| 6 | Verification | 3 | — | 3 |

Row 2 includes R-2.5/R-6.1 metadata display (done). Row 5 includes the
existing inline-image/`multipart/related` send path (R-4.8, done).

## Terminology

### Attachment row

An **attachment row** is one user-visible file entry in the message
attachment bar: filename, type, size, and Preview/Download affordances.

### Ordinary raster attachment

An **ordinary raster attachment** is a non-inline or inline-failed part
whose declared type and decoded bytes match the shared raster allowlist
(PNG, JPEG, GIF, WebP, BMP, AVIF, ICO) and whose size is at most 10 MiB.

### Temporary blob

A **temporary blob** is a server `blobId` returned from JMAP upload that
is not yet referenced by a confirmed draft or sent Email. Temporary blobs
may expire server-side; the client retains the source `File` until a draft
checkpoint confirms canonical part handles.

### Ephemeral byte transfer

An **ephemeral byte transfer** is a worker RPC that uploads or downloads
bytes without creating or mutating a durable mail object and without
writing a `pending_mutations` row.

## AT-1 — Received presentation and layout

| ID / Status | Requirement |
|:--|:--|
| AT-1.1 🟩 Done | The open message view shall separate header/metadata, a shrinkable body scroll region, and a non-shrinking attachment bar. The attachment bar shall be a sibling of the body scroll area, not inside the sandboxed HTML iframe. |
| AT-1.2 🟩 Done | When the authored body is shorter than the available reading column, the attachment bar shall follow the content upward. When the body exceeds the column, only the body region shall scroll; the attachment bar shall remain visible below the header without scrolling away. |
| AT-1.3 🟩 Done | The attachment bar shall have a maximum height of `min(40vh, 220px)`. Longer lists shall scroll internally rather than expanding the message shell or forcing page-level overflow. |
| AT-1.4 🟩 Done | Each attachment row shall expose accessible Preview and/or Download actions with icon-only controls, visible text through labels/tooltips, and per-row pending, error, and retry state. |
| AT-1.5 🟩 Done | Ordinary raster attachments shall render as figures **after** the authored body content in MIME part order. Figures shall shrink to the reading-column width, shall not upscale beyond intrinsic size, and shall remain listed in the attachment bar. |
| AT-1.6 🟩 Done | Plain-text attachments shall preview only on explicit user request. Preview output shall be escaped, capped at 256 KiB, and rendered through text nodes or a `<pre>` block on the host page; it shall never use `v-html`, the message iframe, or unsanitized HTML. Text preview reads shall stream and cap bytes so a mislabeled or huge file is not fully buffered merely to preview. |
| AT-1.7 🟩 Done | PDF attachments shall open on explicit request in the browser's native PDF viewer in a separate tab. The tab shall receive authenticated blob data over a one-use same-origin channel and shall not retain an opener reference to Stormbox. SVG, HTML, XML, archive, executable, and other active or binary formats shall be download-only. They shall not auto-preview in the reading pane or iframe. |
| AT-1.8 🟩 Done | Download shall fetch bytes through the authenticated worker using the owning message account id, sanitize the untrusted filename for browser save, trigger a file save in the browser, and revoke any transient object URL after use. Stale download completions shall be ignored after the user selects a different message. |

## AT-2 — MIME classification and CID rules

| ID / Status | Requirement |
|:--|:--|
| AT-2.1 🟩 Done | The system shall display attachment metadata (name, type, size) on the open message (R-2.5, R-6.1). |
| AT-2.2 🟩 Done | Attachment bar membership shall follow body-structure metadata in deterministic MIME order. Classification shall use part disposition, `cid`, declared type, and whether the rendered HTML or plaintext actually references the part. |
| AT-2.3 🟩 Done | Successfully resolved inline `cid:` images shall remain at their authored location inside the sandboxed iframe (R-2.11). A related part shall be suppressed from the attachment bar only when a permitted reference in the rendered body actually resolved for display. Failed, unsupported, unreferenced, or explicitly attached CID parts shall stay visible in the bar. |
| AT-2.4 🟩 Done | Raster preview eligibility shall use the same allowlist and size ceiling (10 MiB) as inline compose paste (R-4.8). Decode failures shall downgrade to download-only rows without removing them from the bar. |

## AT-3 — Ephemeral blob transfer

| ID / Status | Requirement |
|:--|:--|
| AT-3.1 🟧 Planned | Compose upload and attachment download shall use dedicated worker RPCs that accept `File`/`Blob` bodies and return `Blob` or structured download metadata. These RPCs shall not enqueue `pending_mutations` rows because they create no durable mail object. |
| AT-3.2 🟧 Planned | Each byte transfer shall support cancellation through the existing RPC cancel channel without aborting unrelated JMAP traffic. Progress events on the initiating `MessagePort` shall report bytes moved for uploads and downloads. |
| AT-3.3 🟧 Planned | Upload and download routing shall resolve the supplied local account id to the correct remote account. Received-message downloads shall never default to the session primary account when the message belongs to a shared account. |
| AT-3.4 🟩 Done | The worker shall expose live effective `maxSizeUpload`, `maxSizeAttachmentsPerEmail`, and `maxConcurrentUpload` from the JMAP Session/account capabilities. Missing, malformed, or non-positive required limits shall fail closed; the client shall not invent fallback limits. |
| AT-3.5 🟩 Done | The client shall reject a single file larger than `maxSizeUpload` and shall reject a compose attachment set whose total size exceeds `maxSizeAttachmentsPerEmail` before starting partial uploads. Picker order shall be preserved while honoring `maxConcurrentUpload`. |
| AT-3.6 🟧 Planned | Upload responses shall preserve server `{ blobId, type, size }` metadata for later MIME assembly. Existing base64 download callers shall remain supported for inline `cid:` resolution until migrated. |
| AT-3.7 🟩 Done | Unused successful uploads have no client delete operation on the first target server. Removing an uncheckpointed attachment from compose forgets the temporary `blobId` locally; server-side expiry/GC is expected. When a later draft or send returns `blobNotFound`, the client can re-upload from the retained `File` or requires re-selection after reload. |

## AT-4 — Compose attachments

| ID / Status | Requirement |
|:--|:--|
| AT-4.1 🟩 Done | Compose shall expose an **Attach** button with a paperclip icon immediately beside Send that opens a hidden `multiple` file input. Native file picking is permitted here per constitution Principle IX. |
| AT-4.2 🟩 Done | Selecting files shall start immediate worker upload for each accepted file. The session shall retain the in-memory `File`, upload metadata, stable client attachment id, and `uploading | ready | failed` status. Attachment bytes shall not be written to SQLite, OPFS, or a second IndexedDB store. |
| AT-4.3 🟩 Done | Attachment rows shall show name, size, progress while uploading, and Retry, Cancel, and Remove actions. Failed or still-uploading attachments shall block Send but shall not block text-body autosave. Close/save messaging shall state when an attachment has not yet reached the draft. |
| AT-4.4 🟩 Done | Reloading or restarting before the first confirmed draft revision that captures the attachment set may require the user to re-select files. Recovery of uncheckpointed uploads is best-effort only, consistent with CD-3.7. |
| AT-4.5 🟩 Done | Partial multi-file picker failure shall retain successful uploads. Retry shall apply only to failed files. Cancel shall abort the in-flight transfer without affecting unrelated attachments. |
| AT-4.6 🟩 Done | Pasting files into the compose editor shall classify each clipboard file item. Supported raster images up to 10 MiB shall continue through the existing inline `data:` URL editor path (R-4.8). Every other pasted file — including SVG, undecodable images, oversized images, and non-images — shall enter the regular attachment upload path. File clipboard items are authoritative; parallel HTML clipboard representations shall not duplicate insertion. |
| AT-4.7 🟩 Done | Empty files, unknown MIME types, duplicate filenames, Unicode or path-like names, picker cancellation, aggregate-limit overflow, offline/auth failures, cancellation races, and edits during in-flight upload/save shall surface precise, non-destructive errors without corrupting the text draft. |
| AT-4.8 🟩 Done | Once a blob id is available, compose shall trigger an immediate draft save so the attachment set reaches a server draft checkpoint as soon as practicable. |
| AT-4.9 🟩 Done | Removing a completed attachment before checkpoint shall drop the temporary blob reference locally without a delete RPC. After checkpoint, removal shall follow the next draft revision semantics and CD-6.10 blob rotation. |
| AT-4.10 🟩 Done | Regular file attachments are encoded as explicit body parts in a `multipart/mixed` envelope alongside the existing `multipart/related` inline-image tree. The JMAP convenience `attachments` property is not used (R-4.8). |

## AT-5 — Draft/send MIME integration

| ID / Status | Requirement |
|:--|:--|
| AT-5.1 🟩 Done | Inline pasted rasters shall upload at send/draft time and assemble as `multipart/related` with `cid:` references (R-4.8). |
| AT-5.2 🟩 Done | Draft save and send share one MIME builder for regular attachments and inline images. |
| AT-5.3 🟩 Done | Across draft revisions, Stormbox reuses same-account canonical Email-part blob ids while their owning predecessor exists rather than re-uploading bytes (CD-6.10). Successor canonical handles are persisted before predecessor destroy. |
| AT-5.4 🟩 Done | Reopened drafts shall seed compose attachment state from server body parts. Merge by stable client id and order so an in-flight save cannot drop a later-added attachment or resurrect a removed one. |

## AT-6 — Verification

| ID / Status | Requirement |
|:--|:--|
| AT-6.1 🟩 Done | Unit tests shall cover MIME classification, CID bar suppression, raster/text/PDF/archive routing, adaptive bar DOM structure, filename sanitization, object-URL cleanup, and stale completion guards. |
| AT-6.2 🟧 Planned | Transport and backend tests shall cover owning-account routing, capability limits, upload size validation, progress, cancellation, timeout behavior, and `blobNotFound` recovery. |
| AT-6.3 🟩 Done | Draft/outbox tests prove regular-only and regular-plus-inline MIME trees, one initial upload followed by canonical blob reuse, and create-successor → confirm handles → destroy-predecessor ordering across multiple revisions (Bulwark/CD-7.4 class). |
| AT-6.4 🟩 Done | Live integration tests shall cover one received-message case (metadata, preview/download bytes, MIME order, account routing), one compose case (immediate upload, first draft checkpoint, reopen, send), and one failure case (uncheckpointed or missing blob remains retryable without corrupting the text draft). |
| AT-6.5 🟧 Planned | Playwright tests on Chromium and Firefox shall assert short-body bar placement, long-body non-scrolling bar, raster preview after body with bar retention, capped text preview, PDF browser viewing, ZIP download-only, picker and mixed paste through autosave/reopen/send, and agreement among UI, SQLite metadata, and direct JMAP/raw MIME. |
| AT-6.6 🟧 Planned | Every package that changes server and cache state shall satisfy the constitution Verified Consistency rule; ephemeral transfer RPCs shall be covered by focused unit and live transport tests instead. |

## Non-goals

- Persisting attachment bytes in SQLite, OPFS, or a dedicated local file store.
- Client-side delete of unused JMAP uploads where the server exposes no destroy method.
- Auto-preview of SVG/HTML/XML inside the message iframe or on the host page.
- Attachment reminders, read receipts, or virus scanning UI.
- Offline attachment queueing or a user-visible Outbox for uploads.
- Server-side `Blob/set` destroy/update (RFC 9404) in the first release.

