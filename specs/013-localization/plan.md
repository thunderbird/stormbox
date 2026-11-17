# Implementation plan

Use Vue I18n 11 in Composition API mode with an English JSON catalog. Keep initial and fallback locale English. A framework-free bridge preserves English diagnostics in workers while structured error metadata reaches the UI. Use existing formatting and component contracts without adding locale preferences or changing data reads.

Extract template and script strings, preserve exact English output, and retain named slots for markup. Validate catalogs, typecheck, lint, unit tests, production build, full E2E discovery, and existing Chromium/Firefox browser tests. Review an immutable commit read-only before completion.

References: https://vue-i18n.intlify.dev/guide/advanced/composition.html ; https://vue-i18n.intlify.dev/guide/advanced/fallback.html ; https://nodejs.org/docs/latest/api/esm.html#json-modules .
