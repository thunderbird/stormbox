# Safe rendering

The constitution (`.specify/memory/constitution.md` Principle VI)
mandates that HTML email is sanitized and rendered in a sandboxed
iframe with a Content-Security-Policy that forbids scripts and active
content, and that links never navigate the host page. This document
states what that means in concrete terms for stormbox: the message
iframe pipeline, link handling, and the small set of rules that
follow from "untrusted HTML lives in exactly one place."

## Where untrusted HTML enters the app

The only source of untrusted HTML in stormbox is a JMAP `Email/get`
`text/html` body part served by the configured mail server. The
sender controls those bytes. Everything else rendered into the DOM
— Vue templates, compose draft content, icon SVGs — is bytes the
project itself shipped at build time or that the local user typed
into the compose editor.

The job of the safe-rendering layer is to keep the sender-controlled
bytes off the host page's origin and out of the host's JS context.

## The message iframe pipeline

`src/components/MessageView.vue` is the single path that displays
received-email HTML. The pipeline:

1. Read the body parts from local SQLite via the worker.
2. Sanitize the HTML with `DOMPurify.sanitize`, restricting the URI
   scheme set via `ALLOWED_URI_REGEXP` from
   `src/utils/message-html.ts`.
3. Wrap the sanitized HTML with `buildMessageSrcDoc`, which prepends
   the CSP meta tag and the host's typography stylesheet.
4. Bind the resulting srcdoc string to `<iframe :srcdoc>`. The
   sandbox attribute is `IFRAME_SANDBOX` — no `allow-scripts`, no
   `allow-top-navigation`, no `allow-popups`.
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

- Any code path that takes server-supplied HTML and writes it
  outside the iframe (innerHTML, `v-html` of an email body,
  `document.write`, etc.) is a bug.
- Removing `allow-scripts` from the sandbox is non-negotiable.
  Re-enabling it would bypass the third layer of defence even if
  DOMPurify and the CSP both held.
- Adding `allow-same-origin` to the sandbox is also non-negotiable.
  The iframe must run as a null origin so script in it (if it ever
  ran) could not reach `localStorage`, IndexedDB, or the SharedWorker
  via `postMessage` to the parent.

## Compose drafts

The Squire rich-text editor in `src/components/ComposeDialog.vue`
writes into a `contenteditable` element. The store reads
`Squire.getHTML()` for the outgoing payload. Reply/forward previews
are built in `src/utils/compose-quote.ts` and seeded into Squire via
its API, not via `v-html`. Compose-side HTML is the local user's own
input — no sanitisation is required against the user's own
keystrokes — but it never round-trips through the iframe path
either, because nothing renders it into a DOM the user reads in
that session.

## `v-html` and our own assets

Inline SVG icons (folder rows, message-view toolbar) use `v-html`
bound to a Vite `?raw` import — bytes from `src/assets/icons/` that
the bundler embeds at build time. There is no untrusted-input
surface there; the binding is the equivalent of writing the SVG
markup directly in the template, with the bundler re-using one
shared string. The `aria-hidden="true"` on the host `<span>` is
present so screen readers do not narrate the SVG's internal
`<title>`/`<desc>` over the button's `aria-label`.

The rule for new code is short: `v-html` is fine for build-time
project-owned strings (`?raw` imports, hard-coded literals), and
absolutely not for anything that could carry sender-controlled or
network-fetched content. The latter goes through the iframe.

## Audit (2026-05-24)

The reading-pane iframe is the only render surface that consumes
sender-controlled HTML. It does not use `v-html`; it binds the
sanitized + CSP-wrapped srcdoc string to `<iframe :srcdoc>` with
the sandbox attribute set to `IFRAME_SANDBOX`.

`v-html` itself is used in:

- `src/components/FolderNode.vue` — folder icon SVG (`?raw` import).
- `src/components/MessageView.vue` toolbar — archive / reply /
  reply-all / forward icon SVGs (`?raw` imports).

All hosts carry `aria-hidden="true"`.

## Adding a new render surface

When a new feature would render HTML that did not originate in the
local app:

1. Run it through the message iframe pipeline above. Sanitise with
   DOMPurify, wrap with `buildMessageSrcDoc`, render into a
   sandboxed iframe with the same `IFRAME_SANDBOX` mask.
2. If the requirement is "render this without scripting in the host
   page," the iframe path covers it. If the requirement is "render
   this with the host's interactivity," reject the requirement;
   stormbox does not have a safe answer for that and the constitution
   does not allow inventing one.
