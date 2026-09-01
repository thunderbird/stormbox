# Attachment Support — Research

Concise protocol, server, and reference-client notes for
`specs/008-attachments/spec.md`. Reproduced findings only; requirement
ids live in the spec.

## RFC 8620 — binary transfer

**§6.1 Upload.** The Session advertises `uploadUrl` with an `{accountId}`
template. POST returns `{ accountId, blobId, type, size }`. Core
`maxSizeUpload` caps a single upload. Under rare circumstances the server
may delete an uploaded blob before the client references it; the client
should keep a local copy so it can upload again.

**§6.2 Download.** The Session advertises `downloadUrl` with
`{accountId}`, `{blobId}`, `{type}`, and `{name}`. Downloads require the
same authenticated transport as JMAP calls; raw `<img src>` against the
download URL is insufficient.

**Blob/delete.** Core JMAP defines upload and download only. RFC 9404
adds optional `Blob/set` destroy/update, but Stormbox's first target
(Stalwart v0.15.4–v0.16.x) does not expose a client delete for an unused
upload. Stormbox therefore relies on server-side expiry/GC for abandoned
temporary blobs and on draft/send reconciliation for referenced ones.

## RFC 8621 — body parts and attachments

**BodyStructure.** Parts carry `partId`, `blobId`, `type`, `name`,
`disposition`, `cid`, `size`, and nested `subParts`. Stormbox already
projects attachment metadata into `body_parts`; this feature adds only
the classification fields needed for MIME order and bar visibility.

**Inline vs attachment.** RFC 8621 §4.1.4 models parts with
`disposition: "inline" | "attachment"`. HTML may reference inline parts
by `cid:`. The JMAP convenience `attachments` property on `Email/set`
creates `multipart/mixed` siblings that do not satisfy `cid:` resolution
(R-4.8); regular file attachments and pasted inline images therefore use
explicit body trees.

**Shared/shared-account routing.** Download and upload URLs are
account-scoped. Received messages on a shared mailbox must use that
message's owning remote account id, not the session's primary account.

## MIME disposition and Content-ID

**Content-ID.** Message HTML commonly references `cid:<content-id>` where
the part's `Content-ID` header may include angle brackets. Matching is
case-insensitive and must tolerate bracketed and bare forms (already
handled for inline display in R-2.11).

**Bar suppression rule.** A related part shall appear in the attachment
bar when it is explicitly attached, unreferenced by the rendered body,
or referenced but not successfully resolved for display. Only a part that
is referenced **and** resolved into the authored body location shall be
hidden from the bar.

**Preview safety.** Raster auto-preview uses the same PNG/JPEG/GIF/WebP/BMP/AVIF/ICO
allowlist as inline `cid:` and compose paste. SVG, HTML, XML, archives,
executables, and unknown active types remain download-only because they
cannot be rendered safely on the host page or inside the sandboxed iframe.

## Stalwart limits and blob lifetime (tested configuration)

Stormbox reads live capability values from the Session rather than
hard-coding vendor limits. On the pinned local/E2E Stalwart stack the
observed Core/Mail values include:

| Capability | Typical value | Use |
|:--|:--|:--|
| `maxSizeUpload` | 50 MiB | Per-file upload cap |
| `maxSizeAttachmentsPerEmail` | 50 MiB | Aggregate attachment budget per Email |
| `maxConcurrentUpload` | 4–10 | Parallel upload throttle |

Unused uploads are not referenced by an Email, FileNode, or other durable
object. Stalwart may return `blobNotFound` on later draft revision or
send when a temporary blob expired or was garbage-collected. Stormbox
therefore retains the in-memory `File` until the attachment set is
confirmed in a server draft (CD-6.10) and re-uploads on `blobNotFound`
rather than offering blob delete.

There is no Stormbox UI to delete an orphaned server blob; removing a
completed temporary upload from compose forgets the id locally and leaves
expiry to the server.

## Reference-client precedent

**Thunderbird Desktop.** Shows attachment metadata in a stable bar,
offers download for every part, and auto-displays ordinary image
attachments below the body while keeping them listed. Plain-text
attachments open on demand rather than inline by default.

**Roundcube.** Lists attachments separately from the body, downloads
through authenticated requests, and treats inline `cid:` parts as part
of the HTML viewer rather than as duplicate list rows when referenced.

**Bulwark.** Uses the same iframe/sandbox/srcdoc reading model as
Stormbox. Draft lifecycle issue 849 motivates gating predecessor destroy
on confirmed successor blob handles (CD-6.10, CD-7.4): attachment bytes
must rotate to canonical Email-part blob ids across draft revisions
without re-uploading when the server still holds the blob.

**Stormbox compose paste (existing).** R-4.8 already uploads pasted
inline rasters at send time via `multipart/related`. This feature keeps
that path for supported rasters ≤ 10 MiB and routes every other pasted
file through the regular attachment upload path.
