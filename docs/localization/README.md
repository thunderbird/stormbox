# Localizing Stormbox

`src/locales/en.json` is the source catalog. The application uses Vue I18n 11 in Composition API mode. English is the only shipped language initially. Partial catalogs fall back to English per message.

## Add a language

1. Add `src/locales/<BCP-47-tag>.json` (for example `de.json` or `pt-BR.json`). Keep the source keys, translate values, and retain all named parameters. An incomplete catalog is allowed; omit unfinished messages instead of leaving empty strings.
2. Run `npm run check:locales`, `npm run lint`, and `npm test` **inside the dev container**, as described in `AGENTS.md`.
3. Check the language in Settings, including keyboard menus, narrow layouts, contacts, composer, date picker, and accessibility labels. The language list discovers catalog files automatically. Do not add a language to the UI before its catalog is reviewed.

The default follows `navigator.languages`. An explicit choice is stored under `stormbox.locale` in browser storage and is shared across tabs. It does not change account settings. Region subtags are retained for number and date formatting even when messages fall back to a base language. The root document and the standalone PDF viewer receive the selected `lang` and writing direction. Date-fns calendar locales are loaded on demand; unsupported calendar locales fall back to its English locale.

## Write messages

Use `t('component.descriptiveKey', { name })` from `src/i18n/messages.ts` for text in templates, helpers, and computed properties. Keep complete sentences in a single message; avoid translating a verb and joining it to an English noun. Module-level label registries need getters, not eagerly evaluated translations. Use `LocalizedText` with named slots when a sentence includes markup; never put HTML in a catalog or feed translated strings into `v-html`.

Vue I18n uses `{name}` parameters and ` | ` between plural forms. Forms are in CLDR order: **zero, one, two, few, many, other**, including only the categories used by the language. English uses `one | other` (and can use `zero | one | other` when zero has special wording). Supply the numeric choice as the third argument to `t`; rendered numbers use the active regional locale. Literal `@`, `{`, `}`, and `|` use Vue I18n literal syntax, for example `{'@'}`. Catalog validation checks syntax, markup, parameter consistency, missing source references, and statically detectable missing interpolation arguments.

Names entered by users, protocol tokens, CSS values, identifiers, and keyboard bindings are data. Preserve them. Default tag and folder names have display helpers; their stored/wire values remain stable. Standard English system-folder names are translated for display, while custom folder names remain verbatim. New generated reply/forward text uses the active language; existing messages and drafts are never rewritten.

## Errors and workers

Workers import only the framework-free `src/i18n/messages.ts` bridge. They produce stable English diagnostics from the same source catalog. `LocalizedError` carries `messageKey` and `messageParams` across RPC, and outbox errors can carry `descriptionKey` and `descriptionParams`. The main thread renders those keys with Vue I18n. `errorDescription` resolves persisted outbox descriptions, and unknown server diagnostics remain available as supplied by the server.

Language changes do not affect SQLite, JMAP requests, scheduling arithmetic, or stored user content. Preserve this boundary when adding messages. Internal developer logs and structural assertions need not be translated.

The template lint rule rejects new raw UI text. `npm run check:locales` validates every catalog; unit tests exercise fallback, regional formatting, plural rules, safe interpolation, RPC error metadata, and locale changes. Browser tests switch the running UI using a test-only in-memory catalog; no unreviewed translation ships in production.

References: [Vue I18n composition](https://vue-i18n.intlify.dev/guide/advanced/composition.html), [pluralization](https://vue-i18n.intlify.dev/guide/essentials/pluralization.html), [component interpolation](https://vue-i18n.intlify.dev/guide/advanced/component.html).
