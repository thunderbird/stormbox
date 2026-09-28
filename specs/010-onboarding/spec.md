# Welcome and Feature Announcements

This specification defines how Stormbox introduces itself to a new user
(the **Welcome modal** with its feature cards, live spotlights, and
keyboard-shortcut reference) and how it announces new features to a user
who has already been through Welcome (**feature beacons** and the header
pill that counts them). It is written to be extended: every release that
ships user-facing features updates the Welcome content and appends one
beacon per new control.

It refines `specs/001-mvp-scope/spec.md` R-8.3 (the avatar-menu action
that reopens Welcome) and R-3.7 (the shortcut tables Welcome displays),
and depends on `specs/006-user-settings/spec.md` for the `shortcutScheme`
setting and for the synced `onboarding` setting that holds Welcome and
beacon state (section 6). The architectural invariants in
`.specify/memory/constitution.md` remain controlling.

## Status legend

- 🟩 **Done** — implemented and covered by tests.
- 🟨 **Partial** — implemented with known gaps, listed inline.
- 🟧 **Planned** — accepted scope, not yet implemented.

## Status overview

| # | Area | 🟩 Done | 🟨 Partial | 🟧 Planned |
|---|---|--:|--:|--:|
| 1 | Welcome modal | 8 | 1 | — |
| 2 | Feature cards and spotlights | 8 | 1 | — |
| 3 | Announcing beacons | 5 | — | — |
| 4 | Beacons | 10 | 2 | — |
| 5 | Header pill | 5 | — | — |
| 6 | State and persistence | 5 | — | — |

## Terminology

- **Welcome modal** — the full-screen dialog shown once to a user who has
  never dismissed it, and on demand from the avatar menu afterwards.
- **Feature card** — one tile in the Welcome modal's Features grid: icon,
  title, one-sentence description, and a `Show me` button.
- **Spotlight** — the scripted demonstration a `Show me` button runs against
  the live UI: rings around real controls, a simulated pointer, a caption
  per step, and cleanup that returns the app to where it was.
- **Sequence number (`seq`)** — a beacon's permanent position in the order
  beacons were announced. It is assigned once, never changed, and never
  reused, even after its beacon is removed.
- **Beacon** — a pulsing dot on the control a new feature lives on, with a
  short card. Its **surface** says where that control lives (the spaces
  rail, the Mail sidebar, the message list, the composer, the Contacts
  space). A **staged** beacon's surface is a host that may not be mounted
  (the composer, the Contacts space), so its dot waits for it.
- **Card** — the popover a beacon opens. A card is **previewed** (hover or
  focus), **pinned** (clicked, or chosen from the pill), or shown
  **alongside** (the user activated the control itself).
- **Pill** — the `N new` control in the top bar's right cell that counts
  unseen beacons and lists them.
- **Seen** — a beacon is seen once the user has read its card for the dwell
  time, pressed `Got it`, or used the control. A seen beacon draws no dot.
- **High-water mark** — `beaconsSeenThrough`: every beacon whose `seq` is at
  or below it is seen.

## 1. Welcome modal

| ID / Status | Requirement |
|:--|:--|
| OB-1.1 🟩 Done | The Welcome modal shall open automatically when an authenticated session reaches the connected state and its synced settings have been pulled, if Welcome has never been dismissed on any device (the `onboarding` setting is unset, OB-6.1), and shall not open automatically again once dismissed. |
| OB-1.2 🟩 Done | The modal shall be a labelled `aria-modal` dialog that takes focus on open, contains Tab within itself, closes on Escape when no spotlight is running, and offers a `Close welcome` button and a `Get Started` primary action that both dismiss it. Dismissal sets the `onboarding` setting (OB-3.3). |
| OB-1.3 🟩 Done | The hero shall show the Thundermail logo and the heading `Welcome to Thundermail` centred together as one lockup, with a one-line tagline beneath the heading. The tagline is product copy and may change per round; it shall fit on one line at the modal's full width. |
| OB-1.4 🟩 Done | Below the hero the modal shall show a `Features` section (section 2) and a `Keyboard Shortcuts` section, in that order, inside one scrolling body, with the primary action in a footer that stays visible. In the single-column layout (viewport narrower than 640px, R-10.3) the `Keyboard Shortcuts` section, its `Style` picker included, shall be omitted: that layout is for phones, where there is no keyboard to use the shortcuts with. |
| OB-1.5 🟩 Done | The Keyboard Shortcuts heading shall carry an inline `Style` picker bound to the `shortcutScheme` setting; changing it shall re-render every displayed binding immediately and persist through the settings store like any other change to that setting. The hint line under the heading shall read `Web shortcuts avoid conflicting with the browser. You can change shortcut style later in Settings.` for the Web scheme and `Thunderbird shortcuts are the same as desktop, but may conflict with the browser in some cases.` for the Thunderbird scheme. |
| OB-1.6 🟩 Done | Shortcuts shall be listed in three groups — `Find and compose`, `Navigate`, `Message actions` — showing every action bound in the active scheme and omitting actions the scheme leaves unbound. Bindings shall display the current OS's primary modifier per R-3.7. |
| OB-1.7 🟩 Done | The Settings dialog shall carry a `Welcome & shortcuts` row whose `Show welcome` button closes Settings and reopens the modal for a connected session without changing any onboarding state. Reopening while beacons are showing shall close any open beacon card and keep what has been seen. The account avatar menu shall not offer this action (R-8.3). |
| OB-1.8 🟩 Done | While the modal is open, global mail shortcuts shall be inert and beacon dots shall not render. |
| OB-1.9 🟨 Partial | The modal's surface tokens (`--modal-surface`, `--modal-border`, `--modal-shadow`, `--modal-scrim`, `--modal-scrim-blur`) are the reference every other dialog in the product uses, so dialogs read as one family in both themes. The panel shall fit within the viewport at 94vh, reflow the shortcut grid to one column below 820px, and stack the hero lockup below 460px. Gap: the composer's backdrop keeps its own rgba scrim instead of `--modal-scrim` / `--modal-scrim-blur`; left as is, the composer is not a member of the dialog family this row describes. |

## 2. Feature cards and spotlights

| ID / Status | Requirement |
|:--|:--|
| OB-2.1 🟩 Done | The Features grid shall show these six cards in this order, three per row: `Compose with confidence`, `Send on your schedule`, `Attachments and clipboard`; `Organize your mail`, `Contacts and identities`, `Smarter recipients`. Each card's description is one sentence naming what the user can do, not how it is built. The current copy is the source of truth in `src/constants/feature-tour.ts`. |
| OB-2.2 🟩 Done | `Send on your schedule` shall always be listed; when the account lacks the FUTURERELEASE capability the composer shows the schedule segment disabled (SL-1.2) and the spotlight rings it as-is. |
| OB-2.3 🟩 Done | Each card's `Show me` shall run one spotlight script. While a spotlight runs, every `Show me` shall be disabled, the modal panel shall be hidden so the live UI shows through, and a fixed caption shall remain: the card's icon and title, a step indicator when the script has more than one step, the current step's text in a live region, and a `Done` button that ends the spotlight. |
| OB-2.4 🟩 Done | A spotlight step shall ring the union of its target selectors' matches, falling back to the first matching fallback selector when no primary target exists (an empty favorites list rings the folder list instead). A step's stage selectors stay undimmed without a ring so the surface a control sits on remains readable. |
| OB-2.5 🟩 Done | When a step presses a control, a simulated pointer shall travel to it, show a pressed state, and only then apply the change the press stands for, so the user sees which control caused what happened. Rings shall clear the moment a press or prepared change moves or removes the pressed element; nothing stays highlighted in empty space. |
| OB-2.6 🟩 Done | Dimming is per script: scripts dim everything outside their rings and stage by default; the Contacts script uses rings alone. The compose script positions the composer directly beneath the caption and never dims it, including its first frame. |
| OB-2.7 🟩 Done | Spotlights shall act only on tour-owned state: the compose script opens its own empty session, sets the subject without triggering a draft save, and discards that session on completion or cancel; it shall never discard a session the user typed into. The folders script opens and closes Manage Folders; the Contacts script switches to the Contacts space, opens Manage identities, and restores the previous space. No spotlight shall enqueue a server mutation. |
| OB-2.8 🟨 Partial | Escape shall end a running spotlight before it can close the modal; `Done` and Escape both run the script's cleanup exactly once. Focus moves to `Done` while a spotlight runs and returns to the `Show me` that started it when it ends. Gaps, accepted: during the compose script the composer's own autofocus and the editor demo move focus into the To field or the editor rather than `Done`; a `prepare` step already under way when the script is cancelled runs to its end before cleanup. |
| OB-2.9 🟩 Done | Under `prefers-reduced-motion: reduce` pointer travel, press, and settle phases collapse to zero, caption transitions are disabled, and the modal's backdrop blur is off; each step's hold time is preserved so the captions can still be read. |

## 3. Announcing beacons

| ID / Status | Requirement |
|:--|:--|
| OB-3.1 🟩 Done | Beacons are one flat, append-only list. Announcing a feature appends one beacon per control with the next `seq`; there are no rounds, and a beacon added later reaches every user who has not seen it, whatever they dismissed before. Removing a beacon leaves its `seq` unused. |
| OB-3.2 🟩 Done | The Welcome modal always describes the whole current product. A release updates cards, copy, spotlights, and shortcut tables in place rather than adding a "what's new" section to Welcome; the announcement surface for existing users is beacons. |
| OB-3.3 🟩 Done | A user's first dismissal of Welcome marks every current beacon seen (`beaconsSeenThrough` set to the newest `seq`), so a new user never sees beacons for the features Welcome just showed. Reopening Welcome later from Settings leaves the state alone. |
| OB-3.4 🟩 Done | Once Welcome has been dismissed, every connected session shows the beacons that are not yet seen. A beacon stays until it is seen (OB-4.7, OB-4.6) or `Dismiss all` is chosen; it never expires on its own. |
| OB-3.5 🟩 Done | For testing, the `Staff settings` section of the Settings dialog shall carry a `Feature beacons` row whose `Refresh beacons` button sets `beaconsSeenThrough` to 0, shows every beacon at once, and closes Settings so the dots and pill show. Non-staff never see the row. |

## 4. Beacons

| ID / Status | Requirement |
|:--|:--|
| OB-4.1 🟩 Done | A beacon declares an id, a permanent `seq`, a surface (`spacesRail`, `mailSidebar`, `mailList`, `composer`, or `contacts`), a CSS selector for the control it sits on, a title, a one- or two-sentence body, an icon, and optionally where its dot sits (`inline-start` for a full-width row). All of it lives in one entry of `FEATURE_BEACONS` (`src/constants/feature-beacons.ts`); no other code names a beacon. The beacons, by `seq`: 1 `newMessage` (New Message button), 2 `composeMinimize` and 3 `composeSchedule` (staged in the composer), 4 `contacts` (the Contacts space button), 5 `manageIdentities` (staged in Contacts), 6 `manageFolders` (the folder list's Manage Folders button), 7 `starMessages` (the message list's Starred filter, standing in for the row star that only shows on hover; `specs/011-message-keywords/spec.md`), 8 `keyboardShortcuts` (the spaces rail's Settings gear, which leads to the shortcut style picker and, through Show welcome, the full list; opening Settings for any reason retires it per OB-4.6, and its alongside card is hidden behind the dialog per OB-4.10), and 9 `tagMessages` (the sidebar Tags heading's Manage Tags button; `specs/011-message-keywords/spec.md`). |
| OB-4.2 🟩 Done | The dot shall be a 10px accent disc with a slow pulsing halo, centred on the anchor's top-right corner (or, for a beacon on a full-width row such as Identities, on the anchor's left edge at mid-height, in line with its label), inside a 32px hit target, and clamped to the viewport. Under reduced motion the halo is static. |
| OB-4.3 🟩 Done | A dot renders only while its beacon is unseen and its anchor is mounted, has a non-zero box on screen, and is not covered by another element at its centre (the composer backdrop over the sidebar, a row scrolled out of its container). Anchors are re-measured on resize, scroll, and DOM mutation, coalesced to one animation frame; the layer's own dots and card never count as cover. |
| OB-4.4 🟨 Partial | Hovering a dot or its anchored control, or moving keyboard focus to a dot, shall preview the card after 150 ms. Leaving shall close a preview after a 250 ms grace unless the pointer moved onto the card. A preview takes no focus and does not gate shortcuts. Touch pointers skip hover handling. Gap, accepted: the pointer leaving the window altogether does not start the close grace, so a preview can stay up until the pointer returns. |
| OB-4.5 🟩 Done | Clicking a dot, or choosing a beacon from the pill, shall pin the card: it takes focus, contains Tab, closes on Escape, on click outside, or on clicking the same dot again, and returns focus to where it was pinned from (the dot, or the pill). When that origin is gone or covered — the dot retired while the card was read (OB-4.7), the pill left with the last unseen beacon, a revealed host such as the composer now covers the pill — focus goes to the beacon's dot if it is still showing, otherwise to the anchored control itself. Global mail shortcuts are inert while a card is pinned. |
| OB-4.6 🟨 Partial | Activating the anchored control itself shall mark the beacon seen and show its card once alongside the control without taking focus, while the control performs its normal action. The alongside card closes on the next click anywhere, on Escape, after 6 s, or as soon as the anchor leaves the screen. Gap, accepted: when the control clicked is the last unseen beacon, marking it seen turns the beacon layer off (OB-4.11 keeps it alive only for a card already showing), so that one alongside card never appears. |
| OB-4.7 🟩 Done | A card that has been visible for 1.5 s shall mark its beacon seen; the dot retires but the card stays readable until closed. `Got it` marks seen and closes at once. There is no `Later` action: closing without the dwell leaves the beacon unseen. |
| OB-4.8 🟩 Done | The card shall be a labelled `dialog` with a `New` kicker, the beacon's icon and title, its body, and `Got it`, positioned by floating-ui to the anchor's right (`right-start`), falling back to below or above it aligned to its right edge (`bottom-end`, `top-end`) and only then to its left (`left-start`), shifting to stay within 12px of the viewport; the order keeps the card off the neighbouring controls in the anchor's row (Send beside the schedule segment). Until positioned it is transparent rather than hidden so it can still receive focus. |
| OB-4.9 🟩 Done | A pinned card whose anchor is not yet on screen (a staged beacon revealed from the pill while its host mounts) shall wait up to 2 s for the anchor and then close if it never appears. |
| OB-4.10 🟩 Done | The beacon layer sits above the composer and its dock and below every modal; it does not render while the Welcome modal or Settings dialog is open, and is removed when the session disconnects. |
| OB-4.11 🟩 Done | Once every beacon is seen the beacon layer stays enabled only while a card is still showing, so the last card can be read, and disables when that card closes. |
| OB-4.12 🟩 Done | The `newMessage` card text shall cover features that have no control of their own on the empty shell (recipient pills, paste of images and links, attachments), and shall tell the user the new controls appear when a message is opened. |

## 5. Header pill

| ID / Status | Requirement |
|:--|:--|
| OB-5.1 🟩 Done | While at least one beacon is unseen, the top bar's right cell shall show a `N new` pill beside the account avatar, counting every unseen beacon, staged ones included. It disappears at zero. |
| OB-5.2 🟩 Done | The pill shall disclose a `New features` list (a labelled group, not an ARIA menu: it carries an intro line and a footer action, and Tab is its only keyboard navigation) naming each unseen beacon with its icon, title, and body, plus a `Dismiss all` action. It closes on click outside and on Escape, which returns focus to the pill. |
| OB-5.3 🟩 Done | Choosing a listed beacon shall bring its control on screen according to its surface — nothing for `spacesRail`; returning to Mail and showing a hidden folder list for `mailSidebar`; returning to Mail and closing an open message in the single-column layout for `mailList`; restoring or opening a compose session for `composer`; switching to Contacts for `contacts` — and then pin its card (OB-4.5, OB-4.9). A space change the user refuses (leaving Contacts with unsaved edits) leaves the card closed. |
| OB-5.4 🟩 Done | `Dismiss all` shall mark every current beacon seen (`beaconsSeenThrough` set to the newest `seq`) and remove the pill and every dot immediately. |
| OB-5.5 🟩 Done | The pill remains visible at narrow widths where other top-bar actions collapse into the overflow menu. |

## 6. State and persistence

| ID / Status | Requirement |
|:--|:--|
| OB-6.1 🟩 Done | Onboarding state is the `onboarding` key of the synced settings document (`specs/006-user-settings/spec.md`): unset until Welcome is first dismissed, then `{ "beaconsSeenThrough": number, "beaconsSeenAlso"?: number[] }`. It follows the user to every device on a FileNode-capable account and stays device-local otherwise (R-SET.12). Welcome and beacons wait until the connected account's settings have been pulled, or the pull has failed, so a second device never flashes Welcome before its synced state arrives. |
| OB-6.2 🟩 Done | A beacon is seen when its `seq` is at or below `beaconsSeenThrough` or listed in `beaconsSeenAlso`. Seeing a beacon out of order lists it; the mark then advances over every listed `seq` and every `seq` no longer in the beacon list, so the list stays short and a user who has seen everything stores one number. `Dismiss all` and the first Welcome dismissal store `{ "beaconsSeenThrough": <newest seq> }`. |
| OB-6.3 🟩 Done | The device-local keys used before OB-6.1 — `stormbox.welcomeModalDismissed.v1`, `stormbox.whatsNewSeen.2026-09-compose`, and `stormbox.featureBeacons.2026-09-compose` — seed the setting once, when the account has none: a finished `2026-09-compose` round means seen through `keyboardShortcuts` (seq 8), unfinished progress carries its seen beacons over, and a Welcome flag alone means nothing seen. The keys are then deleted, and deleted again on any later load that still finds them. All reads tolerate missing, malformed, or unavailable storage (`src/utils/onboarding-storage.ts`). |
| OB-6.4 🟩 Done | The setting merges like every other key: last write wins per key (R-SET.1). Two devices seeing different beacons at the same moment can lose one out-of-order entry, which then shows again once; because the mark only moves up, a batch of seen beacons does not come back. |
| OB-6.5 🟩 Done | Only the primary account's settings document holds onboarding state; shared accounts do not contribute (R-SET.11). |

## 7. Adding a beacon

Everything about a beacon is one entry in `FEATURE_BEACONS`
(`src/constants/feature-beacons.ts`). Storage, the pill, the dots, reveal,
and migration all read that list, and nothing else names a beacon, so a
new beacon is one entry plus tests and this spec. No server, settings, or
storage change is involved.

### 7.1 The entry

1. Add the id to the `BeaconId` union and append the entry to
   `FEATURE_BEACONS` with:
   - `seq`: the next number after the current highest. Never renumber or
     reuse a `seq`, even for a beacon being removed: dismissals are stored
     against it (OB-6.2), so reusing one would hide the new beacon from
     everyone who dismissed the old.
   - `surface`: where the control lives (OB-4.1, OB-5.3). A new kind of
     place needs a new `BeaconSurface` value, and TypeScript then requires
     a matching case in `revealBeacon` (`src/App.vue`).
   - `anchor`: a stable selector for the control. A selector the Welcome
     spotlights also use belongs in `SPOTLIGHT_TARGETS`
     (`src/composables/featureSpotlightScripts.ts`) and is referenced from
     there.
   - `title`, `body` (one or two sentences), `icon` (a `@lucide/vue`
     icon), and `dot: 'inline-start'` only for a control that spans a row.
2. The anchor must be on screen, with a non-zero box and nothing covering
   its centre, whenever its surface is (OB-4.3). A control that shows only
   on hover cannot carry a dot; anchor on an always-visible control that
   leads to it and say so in the body, as `starMessages` (Starred filter)
   and `tagMessages` (Manage Tags) do. A feature with no control of its
   own goes in the body of the beacon on the control that leads to it
   (OB-4.12).
3. Welcome describes the whole product (OB-3.2): update its cards, copy,
   spotlights, and shortcut groups in the same change if the feature
   belongs there. Users who dismissed Welcome before get the beacon;
   users who dismiss it afterwards never do (OB-3.3).

### 7.2 Tests

- Counts and "newest beacon" assertions derive from `FEATURE_BEACONS`
  (`app-layout.test.ts`, `feature-beacons-store.test.ts`,
  `settings-dialog.test.ts`), so they need no edit.
- `tests/unit/components/app-layout.test.ts`: add the anchor to
  `BEACON_RECTS` if a flow there should show its dot or reveal it from the
  pill; add a reveal test for a new surface.
- `tests/unit/components/feature-beacon-layer.test.ts`: add the anchor to
  `RECTS` and `ALL_ANCHORS` and the id to the expected dot lists, if the
  layer tests should cover its dot.
- `tests/e2e/feature-beacons.spec.js`: bump `BEACON_COUNT`, and cover a
  new staged host if there is one. The e2e helpers seed "everything seen"
  as a mark above any future `seq`, so they need no change.
- `tests/unit/utils/onboarding-state.test.ts` already fails on a duplicate
  `seq`.

### 7.3 Spec

Add the beacon to OB-4.1 with its `seq` and anchor, and to the verification
map if new tests were added. If the feature has its own spec, reference the
beacon there as `specs/011-message-keywords/spec.md` MK-5.1 and MK-5.2 do.

### 7.4 Removing or moving a beacon

Delete its entry and leave the `seq` unused; the high-water mark steps
over it (OB-6.2). A control that moved keeps its beacon with a new
`anchor` and `surface`, and the same `seq`, unless the move is itself worth
announcing again, in which case it gets a new beacon with a new `seq`.

## Non-goals

- A `What's New` modal or changelog page. The Welcome modal is the only
  full-screen onboarding surface; existing users get beacons.
- A multi-step guided tour that drives the user through the product. Each
  spotlight is one self-contained demonstration.
- Server-side or analytics tracking of which beacons were seen.
- Announcing changes that have no user-visible control or behaviour.

## Verification map

- Unit: `tests/unit/components/app-layout.test.ts` (Welcome on first
  connect and persistence, the shortcuts section dropped in the
  single-column layout, Escape order with a running spotlight, shortcut
  gating, style picker persistence, compose/contacts spotlight ownership and
  cleanup, beacon arming for existing users, pill reveal including a hidden
  folder list and a refused space change, the pill's list roles, layer
  hidden behind Welcome and Settings, reopening Welcome without touching
  state), `tests/unit/components/feature-beacon-layer.test.ts` (dot
  placement and occlusion, preview on hover and focus, pin with focus,
  focus return to a retired dot's control and from an off-screen origin,
  dwell, control click, staged anchors, last-card read), and
  `tests/unit/stores/feature-beacons-store.test.ts` (arming only after
  Welcome, the mark and out-of-order entries, no expiry, Dismiss all as one
  number, first versus later Welcome dismissal, another device finishing
  the list, staff restart, and legacy-key migration and deletion),
  `tests/unit/utils/onboarding-state.test.ts` (validation, compaction over
  removed beacons, unique `seq`s);
  `tests/unit/components/settings-dialog.test.ts` (the staff-only
  `Refresh beacons` row).
- Browser: `tests/e2e/feature-beacons.spec.js` covers the pill count, dot
  geometry on the New Message button, hover preview, pinned card focus and
  its return to the control after `Got it`, `Got it` persistence,
  control-click retirement with the alongside card, staged reveal through
  the composer with the card clear of Send and focus landing on the
  schedule control, sidebar dots hidden under the composer backdrop, the
  synced `onboarding` value after each step, legacy keys deleted on load,
  and `Dismiss all` storing one number that survives reload, on Chromium
  and Firefox. The Welcome modal has no dedicated e2e; the e2e helpers seed the
  `onboarding` setting through the settings store's pre-sign-in pending
  patch (`tests/e2e/helpers/oidc-login.js`).
