# Localizing Stormbox

`src/locales/en.json` contains the extracted application strings. Vue I18n 11 runs in Composition API mode with English as the initial and fallback locale. No other production catalog, language setting, or browser-language negotiation is included.

This extraction preserves the existing English text, number/date formatting, calendar defaults, stored names, and component contracts. Locale selection and additional translations can be introduced separately.

## Write messages

Use `t('component.descriptiveKey', { name })` from `src/i18n/messages.ts` in templates, helpers, and computed properties. Keep complete sentences in a single message where the existing component contract permits it. Module-level label registries use getters so messages can be re-evaluated. Use `LocalizedText` with named slots when a sentence includes markup; never put HTML in a catalog or pass translations to `v-html`.

Vue I18n uses `{name}` parameters and ` | ` between plural forms. Forms follow CLDR order: **zero, one, two, few, many, other**, including the categories used by the language. English uses `one | other` and may use `zero | one | other` for distinct zero wording. Supply the numeric choice as the third argument to `t`. Interpolation preserves the supplied value; existing callers retain their number and date formatting. Literal `@`, `{`, `}`, and `|` use Vue I18n literal syntax, for example `{'@'}`.

Names entered by users, protocol tokens, CSS values, identifiers, and keyboard bindings remain data. Stable defaults stored in server or cache records use the English `sourceText` helper. Translating displayed strings must not rename stored data or change lookup and parsing behavior.

## Errors and workers

Workers import the framework-free `src/i18n/messages.ts` bridge. Their diagnostics use the English source catalog. `LocalizedError` carries `messageKey` and `messageParams` across RPC; outbox errors can carry `descriptionKey` and `descriptionParams`. The UI resolves those keys with Vue I18n while preserving unknown server descriptions and existing fallback behavior.

Both Vite and Node load the bridge, including during Playwright test discovery. JSON imports must retain `with { type: 'json' }`.

## Checks

Run commands inside the worktree's dev container, as described in `AGENTS.md`:

- `npm run check:locales` validates syntax, references, and interpolation parameters.
- `npm run typecheck` and source lint check the integration.
- `npm run test:unit` checks existing behavior and translation handling.
- Full Playwright discovery and the existing Chromium/Firefox suites cover Node-side imports and browser behavior.

The template lint rule rejects new raw UI text. Localization tests inject a small in-memory catalog only to verify translation and English fallback; those messages are not a shipped language.

References: [Vue I18n composition](https://vue-i18n.intlify.dev/guide/advanced/composition.html), [pluralization](https://vue-i18n.intlify.dev/guide/essentials/pluralization.html), [component interpolation](https://vue-i18n.intlify.dev/guide/advanced/component.html), [Node JSON imports](https://nodejs.org/docs/latest/api/esm.html#json-modules).
