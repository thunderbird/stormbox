# Localization validation

Validated on 2026-10-28 in the worktree's dev container. The patch extracts application strings while preserving existing English output and behavior. It adds no language selector or non-English production catalog. Existing test assertions remain unchanged.

## Passing checks

- Catalog validation: 1,528 messages in the English catalog.
- Typecheck, production build, and source lint.
- Unit tests: 2,701 passed across 160 files.
- Live backend integration: 14 passed across five files.
- Full Playwright discovery: 270 tests across 53 files.
- Final focused browser run: Chromium and Firefox both pass the English Settings layout, injected test catalog, and English fallback checks (four checks including authentication setup).

The reported CI startup failure was reproduced: Node rejected the English JSON catalog import without a type attribute. Both catalog imports now use `with { type: 'json' }`, allowing the Node-side Playwright fixtures to load.

## Full browser run

The full local run recorded 255 passed, 11 skipped, one flaky test, and three failures. Two failures came from the new Settings assertion including pre-existing staff-only rows; the assertion now targets the general section and passes in both browsers.

The remaining Chromium method-error failure saw two empty Sent baseline reads followed by 50 older messages. Its retry sent over HTTP before the WebSocket-only fault injector connected. Firefox passed that test. The Firefox walkthrough's contact fixture reported an incomplete sync (`needsFullSync: true`), then passed on retry. Read-only review found no changed send/cache or contact-sync logic responsible for these readiness assumptions; the existing tests were not weakened.

[Fresh-stack CI run 40752513810](https://github.com/thunderbird/stormbox/actions/runs/40752513810) passed Chromium, Firefox, unit tests, and typecheck at `177d666`. The final follow-up changes only this validation record and the task checklist. [PR #233 checks](https://github.com/thunderbird/stormbox/pull/233/checks) show any subsequent rerun. Repository-wide lint still has six existing `no-var` / `eqeqeq` errors in untouched BrowserStack tests; source lint passes.
