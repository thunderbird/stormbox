# Safe rendering

The constitution (`.specify/memory/constitution.md` Principle VI)
mandates that HTML email is sanitized and rendered in a sandboxed
iframe with a Content-Security-Policy that forbids scripts and active
content, and that links never navigate the host page. This document
states the project-wide rules that follow from that principle and
records the audit results for the existing render paths.

## Where untrusted HTML enters the app

The only source of untrusted HTML is a JMAP `Email/get` body part
served by the configured mail server. Every other byte rendered into
the DOM is either user input the local user typed (compose draft) or
build-time assets the project owns (icon SVGs).

## Rules

### 1. Untrusted HTML renders only through the message iframe

The reading-pane iframe in `src/components/MessageView.vue` is the
single path for displaying received-email HTML. The pipeline is:

1. Read body parts from local SQLite via the worker.
2. Sanitize with `DOMPurify.sanitize`, restricting the URI scheme
   set via `ALLOWED_URI_REGEXP`.
3. Wrap the sanitized HTML through `buildMessageSrcDoc` from
   `src/utils/message-html.ts`, which prepends the CSP meta tag and
   stylesheet.
4. Bind the resulting srcdoc string to `<iframe :srcdoc>`. The
   sandbox attribute is `IFRAME_SANDBOX` (no `allow-scripts`, no
   `allow-top-navigation`).
5. Rewrite anchor `target` and `rel` on the iframe `load` event so
   link clicks open `_blank` with `noopener noreferrer`.

The iframe runs in its own browsing context with no `allow-scripts`,
so a sanitizer bypass cannot execute JavaScript even if one slipped
through DOMPurify.

### 2. `v-html` is restricted to compile-time-trusted strings

`v-html` is permitted only for values whose source is one of:

- A Vite `?raw` import (build-time-bundled file content from the
  project's own asset directory).
- A DOMPurify output that is in turn placed inside the message
  iframe path described above.

All current uses (audit results below) fall into the first category.
A new `v-html` whose source is anything else — server response, user
input, draft contents, etc. — is a bug.

### 3. Compose drafts and other user-typed HTML never use `v-html`

The Squire editor in `src/components/ComposeDialog.vue` writes into a
contenteditable element and round-trips through `Squire.getHTML()`.
Compose previews (replies, forwards) are constructed in
`src/utils/compose-quote.ts` and assigned to the editor through the
Squire API, never through a `v-html` binding.

### 4. Icon SVGs that use `v-html` mark the host element `aria-hidden`

All inline SVG host elements that take a `v-html` bind also set
`aria-hidden="true"` so screen readers do not announce the SVG's
internal title/desc accidentally. The accessible name for an
icon-only button comes from the button's `aria-label`/`title`.

## Current audit (2026-05-24)

`v-html` appears in two places in `src/`, both bound to Vite `?raw`
SVG imports:

| File                                      | Bound expression                                              | Source                            |
| ----------------------------------------- | ------------------------------------------------------------- | --------------------------------- |
| `src/components/FolderNode.vue:49`        | `iconSvg`                                                     | `tb-folder-*.svg?raw` (asset dir) |
| `src/components/MessageView.vue:395,435` | `archiveIcon`                                                 | `tb-folder-archive.svg?raw`       |
| `src/components/MessageView.vue:441`     | `replyIcon`                                                   | `tb-reply.svg?raw`                |
| `src/components/MessageView.vue:444`     | `replyAllIcon`                                                | `tb-reply-all.svg?raw`            |
| `src/components/MessageView.vue:447`     | `forwardIcon`                                                 | `tb-forward.svg?raw`              |

Each host `<span>` carries `aria-hidden="true"`. Both files import
the SVGs at the top of `<script setup>` from
`src/assets/icons/`, so the bundle includes them at build time and
runtime cannot redirect the source.

The reading-pane iframe in `MessageView.vue` does not use `v-html`;
it binds the sanitized + CSP-wrapped srcdoc string to the iframe's
`:srcdoc` attribute (line where `iframeSrcDoc` is bound).

## Adding a new render surface

Before introducing a new `v-html` site, check that:

1. The source string is either a `?raw` asset import or a DOMPurify
   output bound for the message iframe.
2. The host element is `aria-hidden="true"` if the binding is
   purely decorative.
3. The PR description states the source category explicitly so the
   reviewer can confirm.

If neither condition (1) holds, render through the iframe path
described in rule 1 instead.
