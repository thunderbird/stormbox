# Localization validation

The patch extracts application strings while preserving existing English output and behavior. It adds no locale-selection interface or non-English production catalog. Existing unit-test expectations remain unchanged.

The CI failure was reproduced by full Playwright test discovery: Node rejected the English catalog import without a JSON type attribute. The shared bridge and UI initialization now use `with { type: 'json' }`; full discovery loads 272 checks across 53 files.

Targeted validation passes for Settings, message counts, compose scheduling, attachment sizes, and the translation bridge: 134 tests across six files. Catalog validation and typechecking pass. Full validation results are recorded after the final checks.

Repository-wide lint has six existing `no-var` / `eqeqeq` errors in untouched BrowserStack tests. Source lint is checked separately.
