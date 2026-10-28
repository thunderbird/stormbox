# Implementation plan

Use Vue I18n 11 (Composition API) with JSON catalogs. A framework-free message bridge allows shared validation code to retain English diagnostics in workers; the main thread installs Vue I18n as its translator. Structured errors preserve message ids and parameters across RPC. Lazy label getters avoid freezing translations at module load.

Negotiate available catalogs from the browser language list, with an explicit local preference and English fallback. Set lang/dir centrally. Keep calendar arithmetic and wire values stable; localize only display formatters and generated presentation.

Extract template and script strings, convert complete plural sentences, and audit residual literals. Validate catalogs, lint, typecheck, unit tests, production build, and browser behavior in Chromium and Firefox. Review a fixed commit read-only before completing.

References: https://vue-i18n.intlify.dev/guide/advanced/composition.html ; https://vue-i18n.intlify.dev/guide/advanced/fallback.html ; https://eslint-plugin-vue-i18n.intlify.dev/rules/no-raw-text.html .
