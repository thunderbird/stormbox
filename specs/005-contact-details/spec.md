# Contact Details and Identity Editing

This specification defines the three-column Contacts workspace, the editable
JSContact detail model, complete JMAP Identity editing, and Identity defaults
applied to compose. The Stormbox constitution remains controlling.

## Status legend

- 🟩 **Done** — implemented and covered by the required tests.
- 🟨 **Partial** — implemented with the stated gap.
- 🟧 **Planned** — accepted scope, not yet implemented.

## Scope

Stormbox uses JSContact (RFC 9553) as its canonical contact representation and
JMAP Contacts (RFC 9610) as its synchronization protocol. vCard import,
export, and RFC 9555 conversion are explicitly outside this feature.
Contact-list multi-selection, scope-aware deletion, and AddressBook transfer
are specified separately by `specs/006-contact-list-actions/spec.md`.

## CT-1 — Directory workspace

| ID / Status | Requirement |
|:--|:--|
| CT-1.1 🟩 Done | The Contacts space shall present an address-book rail, one shared virtualized directory list, and a third detail/editor column. Contact and Identity rows shall use the same list implementation and distinct detail panes inside one shared shell. |
| CT-1.2 🟩 Done | A contact row shall display only the contact name and its first preferred email address. It shall not display organization, other detail fields, edit controls, or delete controls. A contact without an email address shall display “No email address.” |
| CT-1.3 🟩 Done | At desktop widths the three columns shall remain visible. At tablet widths the address-book rail shall become a compact horizontal control while list and detail remain side by side. Below 640 CSS pixels, the list and detail shall be mutually exclusive drill-in views with an accessible Back action; the inactive view shall be removed from keyboard and accessibility navigation. |
| CT-1.4 🟩 Done | Directory selection shall use stable contact/Identity keys rather than virtual indexes. Arrow keys, Home, End, pointer selection, filter changes, deletion, and asynchronous detail reads shall never select or render the wrong entry. |
| CT-1.5 🟩 Done | The detail column shall define empty, loading, viewing, creating, editing, validation-error, save-error, and delete-in-progress states. A successful mutation shall render the authoritative cache read-back rather than an assumed server result. |
| CT-1.6 🟩 Done | A dirty editor shall not be discarded by selecting another row, changing address book or directory type, leaving Contacts, or using mobile Back. The user shall receive themed Save, Discard, and Cancel choices. |
| CT-1.7 🟩 Done | No native `select` popup shall be used. Labels, date kinds, and work affiliations shall use Stormbox-themed dropdown controls per constitution principle IX. |

## CT-2 — Contact detail model

| ID / Status | Requirement |
|:--|:--|
| CT-2.1 🟩 Done | A contact editor shall support display name, repeated email addresses, repeated phone numbers, repeated websites, repeated dates, repeated notes, and repeated Work affiliations. A contact may have no email address, but an entirely empty ContactCard shall not be created. |
| CT-2.2 🟩 Done | Each repeated editor row shall carry the stable JSContact map key of an existing value or a client-generated key for a new value. Removing or inserting a middle row shall not reassign another row's key, DOM identity, focus, validation, or server property. |
| CT-2.3 🟩 Done | Email, phone, and website rows shall offer common preset labels plus Custom. Presets shall map to standard JSContact `contexts` or phone `features` where such semantics exist; Custom shall map to the explicit `label` property. Unedited `pref`, contexts, features, labels, and extension properties shall survive an edit. |
| CT-2.4 🟩 Done | Dates shall use JSContact `anniversaries` and only the standard `birth`, `wedding`, and `death` kinds. The kind supplies the displayed label. The editor shall accept only RFC 9553-valid partial dates or timestamps and shall not add a non-standard `label` property. |
| CT-2.5 🟩 Done | Notes shall use the keyed JSContact `notes` map and allow multiple unlabeled note entries. Existing note metadata and extensions that the editor does not expose shall be preserved. |
| CT-2.6 🟩 Done | A Work affiliation shall map one keyed `Organization` to its ordered department unit plus independently keyed `Title` entries of kinds `title` and `role` linked through `organizationId`. When several affiliations exist, a themed selector shall let the user view and edit one at a time without hiding or replacing the others. |
| CT-2.7 🟩 Done | Phone and website validation shall retain legal RFC values received from the server. Newly entered websites shall be absolute HTTP or HTTPS URLs, and newly entered phone values shall be non-empty dial strings serialized in the server-compatible JSContact form. |
| CT-2.8 🟩 Done | Recipient autocomplete shall remain email-address based. Removing organization from contact rows shall not remove organization, department, title, role, name, nickname, or email evidence required by existing contact search and autocomplete rules. Notes shall not be indexed for autocomplete. |

## CT-3 — Contact synchronization and mutation

| ID / Status | Requirement |
|:--|:--|
| CT-3.1 🟩 Done | Authoritative ContactCard reads persisted to the cache shall retain the complete server object in `raw_json` and normalize all surfaced fields into protocol-neutral local rows. The database layer shall neither parse nor construct JMAP or JSContact protocol objects. |
| CT-3.2 🟩 Done | Contact email, phone, website, anniversary, note, organization, unit, and title rows shall retain their JSContact map keys. Local presentation position is not protocol ordering and shall not be written as one. |
| CT-3.3 🟩 Done | Every newly created card shall carry a durable RFC 9553 `uid`, generated once before its outbox row is queued. Recovery from an ambiguous create shall search by that UID before any repeat create is permitted. |
| CT-3.4 🟩 Done | Contact edits shall use sparse, stable-key patches against a fresh authoritative card. Only values represented and changed by the editor may be altered or removed; concurrent additions, unsupported fields, unknown extensions, and unedited metadata shall survive. |
| CT-3.5 🟩 Done | A confirmed ContactCard write shall checkpoint before targeted server read-back. Cache-repair retries shall not repeat an accepted server write, and mutation success shall require server and local cache agreement. |
| CT-3.6 🟩 Done | Migration 009 shall install the keyed detail schema and then invalidate the disposable server-backed contact cache by removing cached contacts and every normalized contact detail, membership, and search-token row. It shall preserve AddressBooks, pending contact and Identity outbox mutations, and independent rebuildable recipient history. The next authoritative JMAP synchronization shall rebuild contacts. Runtime normalization shall remain tolerant of legacy flat-array server responses; local cached contact rows shall not be migrated forward. |

## CT-4 — Identity detail and mutation

| ID / Status | Requirement |
|:--|:--|
| CT-4.1 🟩 Done | Manage identities shall use the same directory list and third-column shell as contacts. The Identity pane shall expose name, email, Reply-To, Bcc, and signature. Existing email and server-set `id`/`mayDelete` are read-only; email is editable only during create. |
| CT-4.2 🟩 Done | Reply-To and Bcc shall preserve ordered RFC 8621 EmailAddress values, including nullable display names. The editor shall allow multiple entries, validate each address, and preserve `null` versus unchanged empty values through sparse updates. |
| CT-4.3 🟩 Done | Identity HTML and plain-text signatures shall be two representations emitted by the single shared Squire editor. Existing HTML initializes the editor; a text-only signature is converted to safe equivalent HTML. User edits shall update both representations together. |
| CT-4.4 🟩 Done | The signature editor shall support raster data-URL images through the same rich-editor implementation used by compose. Before `Identity/set`, HTML shall be sanitized and the UTF-8 length of each signature shall be less than Stalwart v0.15.4's 2,048-byte limit. Oversize content shall remain editable and receive an actionable field error rather than a generic save failure. |
| CT-4.5 🟩 Done | Identity creates and updates shall send only mutable fields the user supplied or changed. Update shall never send `email`, `id`, or `mayDelete`. Delete shall be rejected in both UI and store unless `mayDelete` is true. |
| CT-4.6 🟩 Done | Identity action failures shall retain stable enumerated outcomes and identify invalid Reply-To, Bcc, signature, permission, immutable property, address-not-allowed, cache-repair, connectivity, and unknown failures where the server response permits. |
| CT-4.7 🟩 Done | Post-write Identity reconciliation shall target the confirmed Identity id. A create/update shall get and upsert that id; a confirmed delete shall remove that exact local row. A partial or truncated all-Identity response shall not erase unrelated cached identities. |
| CT-4.8 🟩 Done | Identity create shall record an authoritative baseline and durable submitting phase before `Identity/set`. A lost response shall never replay create automatically: a complete Identity snapshot may recover exactly one new field-matching identity, while no match, multiple matches, or an incomplete snapshot remains an explicit resolvable ambiguous outcome. |

## CT-5 — Shared rich-text editor and compose defaults

| ID / Status | Requirement |
|:--|:--|
| CT-5.1 🟩 Done | Stormbox shall have one Squire integration for every rich-text editing surface. Compose and Identity signatures shall reuse the same component for initialization, sanitization, toolbar state, commands, keyboard shortcuts, selection, undo/redo, image insertion, image resizing, responsive toolbar overflow, HTML serialization, and plain-text derivation. |
| CT-5.2 🟩 Done | Extracting the shared editor shall not change compose session switching, minimized editor persistence, focus trapping, inline-image behavior, draft dirtiness, autosave, or send serialization. |
| CT-5.3 🟩 Done | New, reply, and forward sessions shall apply the selected Identity's Reply-To, Bcc, HTML signature, and text signature before the initial clean seed is captured. Replies and forwards shall place the signature before quoted content. Merely opening a prefilled session shall not schedule autosave. |
| CT-5.4 🟩 Done | Compose shall track automatic Bcc and signature provenance only in the live session. Changing From shall replace an automatic value only while that value remains intact; manually edited, removed, or added Bcc recipients and body content shall be preserved and shall not be duplicated. |
| CT-5.5 🟩 Done | Reopened server drafts shall never infer automatic-value provenance or receive Identity defaults, including when the user resolves an unavailable From address. Saved or sent HTML shall not contain Stormbox's internal provenance marker. |
| CT-5.6 🟩 Done | Data-URL images originating in a signature shall enter the existing compose inline-image pipeline and be uploaded and rewritten to resolvable `cid:` parts in saved drafts and sent messages. Identity signature storage itself shall retain the bounded data URL. |

## CT-6 — Verification and review

| ID / Status | Requirement |
|:--|:--|
| CT-6.1 🟩 Done | Unit tests shall cover migrations, complete normalization, stable map keys, strict dates, label mapping, multiple affiliations, unknown-field preservation, sparse patch construction, UID create recovery, Identity fields and limits, editor reuse, compose provenance, and every responsive/accessibility state. |
| CT-6.2 🟩 Done | Contact and Identity live tests shall assert the user-visible UI, local SQLite through `window.__repo`, and direct JMAP state in Chromium and Firefox. Signature compose tests shall additionally assert externally stored marker-free bodies and resolvable inline images. |
| CT-6.3 🟧 Planned | The virtualized list shall remain responsive with 10,000 candidates and filtering shall retain the existing 5,000-contact autocomplete performance budget. Selecting or editing detail shall not trigger full-list DOM rendering or scroll-position oscillation. |
| CT-6.4 🟩 Done | After implementation verification, Fable 5 shall perform a browser-first UI/UX review and code review. Independently reproduced high-confidence findings may be fixed with regressions and shall be recorded in the review canvas. |
| CT-6.5 🟩 Done | After Fable fixes, one immutable snapshot shall be reviewed independently by Grok 4.6, GPT 5.6 Sol, and Opus 5 for conciseness, protocol correctness, architecture, performance, and test quality. Retained findings shall be proven in a disposable copy where possible, recorded in a separate canvas tab, and not fixed in the active tree without explicit user approval. |
