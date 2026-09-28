# Visual server-side mail rules

**Status**: Prototype proposed upstream
**Proposal**: https://ideas.tb.pro/p/visual-server-side-mail-rules-using-jmap-sieve
**Issue**: https://github.com/thunderbird/stormbox/issues/128

## Goal

Stormbox shall let a signed-in user build ordered mail rules visually or edit their complete Sieve source and run them on the mail server through JMAP for Sieve (RFC 9661). The feature remains fully browser-owned and does not add a Stormbox application backend.

## Requirements

| ID | Requirement |
|---|---|
| MR-1 | When the account advertises `urn:ietf:params:jmap:sieve`, the account menu shall offer a Mail Rules editor. When the capability is absent, the editor shall explain that server-side rules are unavailable. |
| MR-2 | The editor shall support ordered, enabled/disabled rules; recursively nested all/any/not condition groups; From, To, To/Cc, Subject, and custom-header conditions; and exact, contains, or wildcard matching. |
| MR-3 | The editor shall support move, mark read, star, forward a copy, discard, and stop-processing actions, exposing only actions supported by the account's advertised Sieve extensions. |
| MR-4 | The server-stored Sieve source shall be authoritative. Stormbox shall parse scripts into a source-ranged syntax tree and project every completely representable script into the visual rule model. UI-only identifiers may be regenerated and shall not duplicate the executable rule model in metadata. The complete source shall remain available in a Source editor. |
| MR-5 | Every save shall use the durable mutation outbox, upload the generated or directly edited script, call `SieveScript/validate`, and activate it only after validation succeeds. |
| MR-6 | A save shall use the last observed `SieveScript` state and reject a concurrent server change instead of overwriting it. |
| MR-7 | The active script shall be edited in place. If it is completely representable, the user may switch between Visual and Source editors. If it is not representable, Stormbox shall open its complete source, explain the unsupported construct, and only allow switching to Visual after the edited source becomes representable. |
| MR-8 | Move actions shall use the RFC 9042 `:mailboxid` extension when supported, retaining a readable hierarchy path as the fallback mailbox name. |
| MR-9 | Invalid rule data, unsupported actions, server validation failures, and server conflicts shall remain visible and recoverable in the editor. Controls shall be disabled while a save is in flight. |
| MR-10 | The editor shall be keyboard accessible, trap focus while open, and confirm before discarding unsaved changes. |
| MR-11 | Stormbox shall only regenerate a script from the visual model when every required extension and executable construct is within the visual editor's semantics-preserving subset. Direct Source edits may use the server's full Sieve surface and remain subject to server validation. |

## Initial scope

- Server-side filtering of newly delivered mail.
- One active script edited visually or as source at a time; JMAP may retain other scripts and permits at most one active script.
- A source parser, deliberately limited visual projection, and Sieve emitter.
- Compatible existing scripts can be visualized and edited in place.
- Unsupported syntax falls back to the complete editable source with an exact visual-projection error.
- Visual-to-source switching is always available; source-to-visual switching requires complete projection.

## Non-goals

- Visually representing every Sieve extension or control-flow construct.
- Rich source-editor features such as syntax highlighting, completion, and inline diagnostics.
- Retroactively applying rules to existing messages.
- Shared-account rule management.
- A Cloudflare Worker rule engine; the deployment bridge only adapts browser CORS and WebSocket authentication.

## Verification

- Unit tests cover syntax parsing, visual projection, nested grouping, escaping, capability checks, source round-tripping, conflict handling, server validation, and outbox integration.
- Component tests cover loading, nested editing, Visual/Source switching, raw-source fallback, save locking, and discard confirmation.
- Local-stack Playwright coverage asserts the visible editor result, durable mutation completion, and the active script directly through JMAP in Chromium and Firefox.
