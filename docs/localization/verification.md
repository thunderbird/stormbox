# Localization validation

Validated on 2026-10-28 in the isolated `localize-stormbox` worktree, using the `stormbox-i18n` container mounted at `/workspace`. The original checkout and the Accounts submodule were not modified.

## Automated checks

- `npm run check:locales`: 1,559 messages in the English source catalog; syntax, references, and interpolation checks pass.
- `npm run typecheck`: passes.
- `npx eslint src scripts/check-locales.mjs tests/unit/i18n`: no errors. The existing unused `reactive` import in `mail-store.ts` remains a warning.
- `npm run build`: passes. Dependency annotation, chunk size, and the already-bundled English date-fns locale produce warnings.
- `npm run test:unit`: 2,704 tests pass across 160 files.
- `npm run test:e2e:local -- tests/e2e/localization.spec.js --project=chromium --project=firefox`: six checks pass, including two authentication setup checks. The four localization cases cover switching an open interface, per-message fallback, keyboard selection, reload persistence, regional date formatting, and cross-tab synchronization.

The browser cases inject a partial German catalog in memory. English remains the only production catalog. Wide and 360-pixel screenshots were inspected; the settings dialog and language control remain usable without horizontal overflow.

Repository-wide lint is not clean: untouched BrowserStack files contain six existing `no-var` / `eqeqeq` errors in `tests/browserstack/pages/stormbox-page.ts` and `tests/browserstack/tests/folder-management.spec.ts`. These files are outside this change.

## Review

A separate agent reviewed immutable commits `f61f4de` and `6f0198c` read-only. Findings were addressed: DOM/CSS identifiers remain literal, locale matching retains regional subtags, translated prop defaults update reactively, filtered empty states use complete messages, and send errors preserve localization metadata. Generated nameless-contact labels are resolved at the read boundary using source provenance; stored values and explicitly authored names are preserved. A missing sender-label import identified in the follow-up was restored before the final passing typecheck and test runs.

Worker diagnostics retain stable English source text and carry message keys and parameters for UI translation. No database schema, JMAP protocol identifiers, or server/cache mutation semantics were changed.
