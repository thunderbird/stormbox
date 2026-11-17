# Stormbox string extraction

- L10N-1: Application-owned user-facing text is catalogued in English, including accessibility labels, notices, errors, onboarding, generated quote headers, and the PDF viewer. Protocol tokens, developer diagnostics, brand names, stored user content, and keyboard bindings are not translated.
- L10N-2: Vue I18n resolves extracted text with English as the initial and fallback locale. This patch adds no language-setting UI, automatic language negotiation, or non-English production catalog.
- L10N-3: Existing English wording, number/date formatting, calendar defaults, DOM structure, component contracts, and visible behavior remain unchanged.
- L10N-4: Translation does not change server identifiers, queries, saved messages, user-defined folder/tag/contact names, or mutation semantics. Workers remain independent of Vue and carry localizable error metadata to the UI.
- L10N-5: Catalog and UI checks detect raw text and invalid placeholders. Translation values render as text, not HTML.
- L10N-6: Vite and Node can load the message bridge, including full Playwright test discovery. Non-English text used by tests is injected in memory only.
