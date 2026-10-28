# Stormbox localization

- L10N-1: All application-owned user-facing text is catalogued in English, including accessibility labels, notices, errors, onboarding, generated quote headers, and the PDF viewer. Protocol tokens, developer diagnostics, brand names, stored user content, and keyboard bindings are not translated.
- L10N-2: Vue I18n owns UI translation. Catalog discovery, English fallback, browser-language negotiation, a local language preference, and document language/direction work before the first render and on change.
- L10N-3: Number, date, time, and plural presentation follows the selected locale. Scheduling arithmetic remains independent of display language and preserves the chosen time zone.
- L10N-4: Translation never changes server identifiers, queries, saved messages, user-defined folder/tag/contact names, or mutation semantics. Workers remain independent of Vue and carry localizable error metadata to the UI.
- L10N-5: Missing/invalid translations fall back to English. Catalog and UI checks prevent unextracted text and invalid placeholders. Translation values render as text, not HTML.
- L10N-6: English ships first; adding a catalog does not require editing application components. No unreviewed machine translations ship as supported languages.
