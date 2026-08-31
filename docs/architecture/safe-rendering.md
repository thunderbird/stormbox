# Safe rendering

The constitution (`.specify/memory/constitution.md` Principle VI)
mandates that HTML email is sanitized and rendered in a sandboxed
iframe with a Content-Security-Policy that forbids scripts and active
content, and that links never navigate the host page. This document
states what that means in concrete terms for stormbox: the message
iframe pipeline, link handling, and the small set of rules that
keep received-message HTML in exactly one render path.

## Where untrusted HTML enters the app

Server-supplied HTML enters through JMAP message bodies, drafts, and
identity signatures. Full message documents are sender-controlled
and stay outside the host page's origin and JS context. Bounded rich
text used by editors and signature previews goes through the shared
rich-text sanitizer before entering the host DOM.

## The message iframe pipeline

`src/components/MessageView.vue` is the single path that displays
received-email HTML. The pipeline:

1. Read the body parts from local SQLite via the worker.
2. Resolve referenced `cid:` parts, then sanitize with
   `sanitizeMessageDocument` (whole-document DOMPurify, `ALLOWED_URI_REGEXP`,
   forbidden `base`/`link`/`meta`, raster `data:` allowlist).
3. Optionally `adaptHtmlForDarkMode`, then wrap with `buildMessageSrcDoc`,
   which injects the CSP meta tag and `buildBodyCss` defaults (into the
   email's own head when the markup is a full document).
4. Bind the resulting srcdoc string to `<iframe :srcdoc>`. The
   sandbox attribute is `IFRAME_SANDBOX`: `allow-same-origin` (parent
   reads `contentDocument` for resize and link rewrite), `allow-popups`
   and `allow-popups-to-escape-sandbox` (`target=_blank`), and no
   `allow-scripts` or `allow-top-navigation`.
5. On the iframe's `load` event, walk anchors and rewrite
   `target="_blank"` + `rel="noopener noreferrer"` so link clicks
   open in a new tab and cannot reach back into the host window.

The defence is layered: DOMPurify removes scripts and active
content, the CSP meta tag in the srcdoc blocks any tag DOMPurify
might miss, and the sandboxed iframe with no `allow-scripts` makes a
sanitizer bypass non-executable. Any one of those alone would still
leave a meaningful gap; together they cover the realistic attack
shapes (`<script>`, `<style>` exfiltration via `:visited`, inline
event handlers, `javascript:` URLs, frame-busting top-navigation).

### What this rules out

- `v-html` of a raw email HTML part is a bug. Sanitized plaintext
  (`plaintextToHtml` + DOMPurify) and sanitized identity / compose
  HTML (`sanitizeRichTextHtml` / `editSafeDraftHtml`) are the
  documented host exceptions.
- Removing `allow-scripts` from the sandbox is non-negotiable.
  Re-enabling it would bypass the third layer of defence even if
  DOMPurify and the CSP both held.
- Keep `allow-same-origin`. The parent must read `contentDocument`
  for auto-resize and link rewriting; script still cannot run.

## Compose drafts

`RichTextEditor.vue` configures Squire with
`sanitizeRichTextToDOMFragment`. Server-loaded drafts pass through
`editSafeDraftHtml` before editing, and identity signatures use the
same bounded rich-text sanitizer. Reply/forward previews are built
in `src/utils/compose-quote.ts` and seeded through the editor API.
Compose HTML does not use the received-message iframe because it
must remain interactive, but it is sanitized at every external
ingress.

## Attachment previews and downloads

Received attachment bytes are not stored in SQLite. Preview and
download use ephemeral worker RPCs (constitution Mutation Pipeline IV)
that fetch through JMAP download (RFC 8620 §6.2) and return `Blob` data
to the UI.

- Resolved inline `cid:` images stay inside the sandboxed iframe (R-2.11).
- Ordinary raster attachment previews render on the **host page** after
  the authored body, using revoked object URLs; they never enter the
  iframe or `v-html`.
- Plain-text previews use escaped text nodes or `<pre>` only. The attachment
  download RPC explicitly requests a truncating 256 KiB + 1-byte lookahead,
  cancels the response stream at that bound, decodes only the first 256 KiB,
  and marks the preview truncated from the lookahead or part metadata.
- PDF viewing opens a dedicated same-origin tab with no opener reference.
  The tab receives authenticated blob data over a one-use `BroadcastChannel`
  and embeds it in the browser's native PDF viewer.
- SVG, HTML, XML, archives, executables, and other unsafe types are
  download-only.

See `specs/010-attachments/spec.md` for layout, classification, and
compose-upload rules.

## `v-html` and our own assets

Inline SVG icons (folder rows, message-view toolbar) use `v-html`
bound to a Vite `?raw` import — bytes from `src/assets/icons/` that
the bundler embeds at build time. There is no untrusted-input
surface there; the binding is the equivalent of writing the SVG
markup directly in the template, with the bundler re-using one
shared string. The `aria-hidden="true"` on the host `<span>` is
present so screen readers do not narrate the SVG's internal
`<title>`/`<desc>` over the button's `aria-label`.

The rule for new code is short: build-time strings may use `v-html`
directly. Generated plaintext and bounded rich text must use their
dedicated sanitizer first. Full network-fetched message HTML goes
through the iframe.

## Contact avatars

Contact photos render only from validated PNG, JPEG, GIF, or WebP
`data:` URIs up to 1 MiB. Validation checks both the declared media
type and raster signature. Arbitrary remote media URIs, SVG, and
malformed data never become image sources; the shared initials and
color avatar is used instead. Stalwart v0.15.4 does not support
ContactCard media `blobId`, so new photos remain bounded data URIs.

## Audit (2026-08-30)

The reading-pane iframe is the only surface that consumes a full
sender HTML document. It does not use `v-html`; it binds the
sanitized + CSP-wrapped srcdoc string to `<iframe :srcdoc>` with
the sandbox attribute set to `IFRAME_SANDBOX`.

`v-html` itself is used in:

- `FolderNode.vue`, `MessageList.vue`, and the `MessageView.vue`
  toolbars — icon SVGs imported at build time.
- `MessageView.vue` plaintext — escaped, linkified output sanitized
  with DOMPurify.
- `IdentityDetailPane.vue` — a remote identity signature sanitized
  with `sanitizeRichTextHtml`.

All icon hosts carry `aria-hidden="true"`.

## Adding a new render surface

When a new feature renders external HTML:

1. Read-only untrusted HTML uses the message iframe pipeline:
   `sanitizeMessageDocument`, `buildMessageSrcDoc`, `IFRAME_SANDBOX`.
2. Editable or preview HTML that must live on the host uses
   `editSafeDraftHtml` / `sanitizeRichTextHtml` and must not grow a
   third ad-hoc sanitizer.
3. Never place unsanitized network content in `v-html`, Squire, or
   another host-page DOM sink.
