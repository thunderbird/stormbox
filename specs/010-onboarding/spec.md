# Welcome and Feature Announcements

This specification defines how Stormbox introduces itself to a new user
(the **Welcome modal** with its feature cards, live spotlights, and
keyboard-shortcut reference) and how it announces new features to a user
who has already been through Welcome (**feature beacons** and the header
pill that counts them). It is written to be extended: every release that
ships user-facing features adds an **announcement round** here, updates
the Welcome content, and declares the beacons for that round.

It refines `specs/001-mvp-scope/spec.md` R-8.3 (the avatar-menu action
that reopens Welcome) and R-3.7 (the shortcut tables Welcome displays),
and depends on `specs/006-user-settings/spec.md` for the `shortcutScheme`
setting and, in section 6, for the settings document that account-level
onboarding state is planned to live in. The architectural invariants in
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
| 3 | Announcement rounds | 6 | — | — |
| 4 | Beacons | 10 | 2 | — |
| 5 | Header pill | 5 | — | — |
| 6 | State and persistence | 4 | — | 7 |

Section 6.2 is a draft. Its requirements describe the intended account-level
persistence of onboarding state and have not been implemented; they are
open for review and may change before acceptance.

## Terminology

- **Welcome modal** — the full-screen dialog shown once to a user who has
  never dismissed it, and on demand from the avatar menu afterwards.
- **Feature card** — one tile in the Welcome modal's Features grid: icon,
  title, one-sentence description, and a `Show me` button.
- **Spotlight** — the scripted demonstration a `Show me` button runs against
  the live UI: rings around real controls, a simulated pointer, a caption
  per step, and cleanup that returns the app to where it was.
- **Announcement round** — one dated set of features announced together,
  identified by a round id such as `2026-09-compose`. A round owns a list of
  beacons and a storage key namespace.
- **Beacon** — a pulsing dot on the control a new feature lives on, with a
  short card. A **staged** beacon waits for a host surface (the composer,
  the Contacts space) to be on screen before its dot can appear.
- **Card** — the popover a beacon opens. A card is **previewed** (hover or
  focus), **pinned** (clicked, or chosen from the pill), or shown
  **alongside** (the user activated the control itself).
- **Pill** — the `N new` control in the top bar's right cell that counts
  unseen beacons and lists them.
- **Seen** — a beacon is seen once the user has read its card for the dwell
  time, pressed `Got it`, or used the control. A seen beacon draws no dot.
- **Session** — one connected page load. Rounds expire by session count.

## 1. Welcome modal

| ID / Status | Requirement |
|:--|:--|
| OB-1.1 🟩 Done | The Welcome modal shall open automatically the first time an authenticated session reaches the connected state on a device where Welcome has not been dismissed, and shall not open automatically again on that device once dismissed. |
| OB-1.2 🟩 Done | The modal shall be a labelled `aria-modal` dialog that takes focus on open, contains Tab within itself, closes on Escape when no spotlight is running, and offers a `Close welcome` button and a `Get Started` primary action that both dismiss it. Dismissal records the Welcome flag (OB-6.1). |
| OB-1.3 🟩 Done | The hero shall show the Thundermail logo and the heading `Welcome to Thundermail` centred together as one lockup, with a one-line tagline beneath the heading. The tagline is product copy and may change per round; it shall fit on one line at the modal's full width. |
| OB-1.4 🟩 Done | Below the hero the modal shall show a `Features` section (section 2) and a `Keyboard Shortcuts` section, in that order, inside one scrolling body, with the primary action in a footer that stays visible. In the single-column layout (viewport narrower than 640px, R-10.3) the `Keyboard Shortcuts` section, its `Style` picker included, shall be omitted: that layout is for phones, where there is no keyboard to use the shortcuts with. |
| OB-1.5 🟩 Done | The Keyboard Shortcuts heading shall carry an inline `Style` picker bound to the `shortcutScheme` setting; changing it shall re-render every displayed binding immediately and persist through the settings store like any other change to that setting. The hint line under the heading shall read `Web shortcuts avoid conflicting with the browser. You can change shortcut style later in Settings.` for the Web scheme and `Thunderbird shortcuts are the same as desktop, but may conflict with the browser in some cases.` for the Thunderbird scheme. |
| OB-1.6 🟩 Done | Shortcuts shall be listed in three groups — `Find and compose`, `Navigate`, `Message actions` — showing every action bound in the active scheme and omitting actions the scheme leaves unbound. Bindings shall display the current OS's primary modifier per R-3.7. |
| OB-1.7 🟩 Done | The Settings dialog shall carry a `Welcome & shortcuts` row whose `Show welcome` button closes Settings and reopens the modal for a connected session without changing any onboarding state. Reopening while a beacon round is active shall close any open beacon card and keep the round's progress. The account avatar menu shall not offer this action (R-8.3). |
| OB-1.8 🟩 Done | While the modal is open, global mail shortcuts shall be inert and beacon dots shall not render. |
| OB-1.9 🟨 Partial | The modal's surface tokens (`--modal-surface`, `--modal-border`, `--modal-shadow`, `--modal-scrim`, `--modal-scrim-blur`) are the reference every other dialog in the product uses, so dialogs read as one family in both themes. The panel shall fit within the viewport at 94vh, reflow the shortcut grid to one column below 820px, and stack the hero lockup below 460px. Gap: the composer's backdrop keeps its own rgba scrim instead of `--modal-scrim` / `--modal-scrim-blur`; left as is, the composer is not a member of the dialog family this row describes. |

## 2. Feature cards and spotlights

| ID / Status | Requirement |
|:--|:--|
| OB-2.1 🟩 Done | The Features grid shall show these six cards in this order, three per row: `Compose with confidence`, `Send on your schedule`, `Attachments and Clipboard`; `Organize your mail`, `Contacts and identities`, `Smarter recipients`. Each card's description is one sentence naming what the user can do, not how it is built. The current copy is the source of truth in `src/constants/feature-tour.ts`. |
| OB-2.2 🟩 Done | `Send on your schedule` shall always be listed; when the account lacks the FUTURERELEASE capability the composer shows the schedule segment disabled (SL-1.2) and the spotlight rings it as-is. |
| OB-2.3 🟩 Done | Each card's `Show me` shall run one spotlight script. While a spotlight runs, every `Show me` shall be disabled, the modal panel shall be hidden so the live UI shows through, and a fixed caption shall remain: the card's icon and title, a step indicator when the script has more than one step, the current step's text in a live region, and a `Done` button that ends the spotlight. |
| OB-2.4 🟩 Done | A spotlight step shall ring the union of its target selectors' matches, falling back to the first matching fallback selector when no primary target exists (an empty favorites list rings the folder list instead). A step's stage selectors stay undimmed without a ring so the surface a control sits on remains readable. |
| OB-2.5 🟩 Done | When a step presses a control, a simulated pointer shall travel to it, show a pressed state, and only then apply the change the press stands for, so the user sees which control caused what happened. Rings shall clear the moment a press or prepared change moves or removes the pressed element; nothing stays highlighted in empty space. |
| OB-2.6 🟩 Done | Dimming is per script: scripts dim everything outside their rings and stage by default; the Contacts script uses rings alone. The compose script positions the composer directly beneath the caption and never dims it, including its first frame. |
| OB-2.7 🟩 Done | Spotlights shall act only on tour-owned state: the compose script opens its own empty session, sets the subject without triggering a draft save, and discards that session on completion or cancel; it shall never discard a session the user typed into. The folders script opens and closes Manage Folders; the Contacts script switches to the Contacts space, opens Manage identities, and restores the previous space. No spotlight shall enqueue a server mutation. |
| OB-2.8 🟨 Partial | Escape shall end a running spotlight before it can close the modal; `Done` and Escape both run the script's cleanup exactly once. Focus moves to `Done` while a spotlight runs and returns to the `Show me` that started it when it ends. Gaps, accepted: during the compose script the composer's own autofocus and the editor demo move focus into the To field or the editor rather than `Done`; a `prepare` step already under way when the script is cancelled runs to its end before cleanup. |
| OB-2.9 🟩 Done | Under `prefers-reduced-motion: reduce` pointer travel, press, and settle phases collapse to zero, caption transitions are disabled, and the modal's backdrop blur is off; each step's hold time is preserved so the captions can still be read. |

## 3. Announcement rounds

| ID / Status | Requirement |
|:--|:--|
| OB-3.1 🟩 Done | Each release that announces features shall declare one round with a dated id (`YYYY-MM-<topic>`), the beacons it owns, and the Welcome changes it makes. The current round is `2026-09-compose`. |
| OB-3.2 🟩 Done | The Welcome modal always describes the whole current product. A round updates cards, copy, spotlights, and shortcut tables in place rather than adding a "what's new" section to Welcome; the announcement surface for existing users is beacons. |
| OB-3.3 🟩 Done | A user who dismisses Welcome is treated as having seen every round current at that moment: dismissal writes the round's seen flag unless a beacon round is already active for that user, in which case the round's progress is left alone. New users therefore never see beacons for the features Welcome just showed them. |
| OB-3.4 🟩 Done | A user whose device has the Welcome flag but not the current round's seen flag shall get that round's beacons on the next connected session. |
| OB-3.5 🟩 Done | A round shall retire itself after `BEACON_SESSION_LIMIT` (5) connected sessions, when every beacon is seen, or on `Dismiss all`. Retiring writes the round's seen flag and removes its progress record. |
| OB-3.6 🟩 Done | Rounds are keyed by id, so a new round supersedes an unfinished earlier one: the earlier round's progress is simply never read again and its beacons do not carry over. Beacons for a control that has moved or been renamed since must be re-declared in the new round or dropped. |

## 4. Beacons

| ID / Status | Requirement |
|:--|:--|
| OB-4.1 🟩 Done | A beacon declares an id, a CSS selector for the control it sits on, a title, a one- or two-sentence body, an icon, and an optional stage (`composer` or `contacts`). The current round's beacons are: `newMessage` (New Message button), `composeMinimize` and `composeSchedule` (staged in the composer), `contacts` (the Contacts space button), `manageIdentities` (staged in Contacts), `manageFolders` (the folder list's Manage Folders button), and `starMessages` (the message list's Starred filter, standing in for the row star that only shows on hover; `specs/011-message-keywords/spec.md`). |
| OB-4.2 🟩 Done | The dot shall be a 10px accent disc with a slow pulsing halo, centred on the anchor's top-right corner, inside a 32px hit target, and clamped to the viewport. Under reduced motion the halo is static. |
| OB-4.3 🟩 Done | A dot renders only while its beacon is unseen and its anchor is mounted, has a non-zero box on screen, and is not covered by another element at its centre (the composer backdrop over the sidebar, a row scrolled out of its container). Anchors are re-measured on resize, scroll, and DOM mutation, coalesced to one animation frame; the layer's own dots and card never count as cover. |
| OB-4.4 🟨 Partial | Hovering a dot or its anchored control, or moving keyboard focus to a dot, shall preview the card after 150 ms. Leaving shall close a preview after a 250 ms grace unless the pointer moved onto the card. A preview takes no focus and does not gate shortcuts. Touch pointers skip hover handling. Gap, accepted: the pointer leaving the window altogether does not start the close grace, so a preview can stay up until the pointer returns. |
| OB-4.5 🟩 Done | Clicking a dot, or choosing a beacon from the pill, shall pin the card: it takes focus, contains Tab, closes on Escape, on click outside, or on clicking the same dot again, and returns focus to where it was pinned from (the dot, or the pill). When that origin is gone or covered — the dot retired while the card was read (OB-4.7), the pill left with the last unseen beacon, a revealed host such as the composer now covers the pill — focus goes to the beacon's dot if it is still showing, otherwise to the anchored control itself. Global mail shortcuts are inert while a card is pinned. |
| OB-4.6 🟨 Partial | Activating the anchored control itself shall mark the beacon seen and show its card once alongside the control without taking focus, while the control performs its normal action. The alongside card closes on the next click anywhere, on Escape, after 6 s, or as soon as the anchor leaves the screen. Gap, accepted: when the control clicked is the last unseen beacon, marking it seen retires the round (OB-4.11 keeps it alive only for a card already showing), so that one alongside card never appears. |
| OB-4.7 🟩 Done | A card that has been visible for 1.5 s shall mark its beacon seen; the dot retires but the card stays readable until closed. `Got it` marks seen and closes at once. There is no `Later` action: closing without the dwell leaves the beacon unseen. |
| OB-4.8 🟩 Done | The card shall be a labelled `dialog` with a `New` kicker, the beacon's icon and title, its body, and `Got it`, positioned by floating-ui to the anchor's right (`right-start`), falling back to below or above it aligned to its right edge (`bottom-end`, `top-end`) and only then to its left (`left-start`), shifting to stay within 12px of the viewport; the order keeps the card off the neighbouring controls in the anchor's row (Send beside the schedule segment). Until positioned it is transparent rather than hidden so it can still receive focus. |
| OB-4.9 🟩 Done | A pinned card whose anchor is not yet on screen (a staged beacon revealed from the pill while its host mounts) shall wait up to 2 s for the anchor and then close if it never appears. |
| OB-4.10 🟩 Done | The beacon layer sits above the composer and its dock and below every modal; it does not render while the Welcome modal or Settings dialog is open, and is removed when the session disconnects. |
| OB-4.11 🟩 Done | Once every beacon is seen the round stays enabled only while a card is still showing, so the last card can be read, and disables when that card closes. |
| OB-4.12 🟩 Done | The `newMessage` card text shall cover features that have no control of their own on the empty shell (recipient pills, paste of images and links, attachments), and shall tell the user the new controls appear when a message is opened. |

## 5. Header pill

| ID / Status | Requirement |
|:--|:--|
| OB-5.1 🟩 Done | While a round is active and at least one beacon is unseen, the top bar's right cell shall show a `N new` pill beside the account avatar, counting every unseen beacon, staged ones included. It disappears at zero. |
| OB-5.2 🟩 Done | The pill shall disclose a `New features` list (a labelled group, not an ARIA menu: it carries an intro line and a footer action, and Tab is its only keyboard navigation) naming each unseen beacon with its icon, title, and body, plus a `Dismiss all` action. It closes on click outside and on Escape, which returns focus to the pill. |
| OB-5.3 🟩 Done | Choosing a listed beacon shall bring its control on screen — restoring or opening a compose session for composer-staged beacons, switching to Contacts for Contacts-staged ones, returning to Mail and showing a hidden folder list for sidebar controls — and then pin its card (OB-4.5, OB-4.9). A space change the user refuses (leaving Contacts with unsaved edits) leaves the card closed. |
| OB-5.4 🟩 Done | `Dismiss all` shall retire the round (OB-3.5) and remove the pill and every dot immediately. |
| OB-5.5 🟩 Done | The pill remains visible at narrow widths where other top-bar actions collapse into the overflow menu. |

## 6. State and persistence

### 6.1 Device-local state (current)

| ID / Status | Requirement |
|:--|:--|
| OB-6.1 🟩 Done | Onboarding state is held in browser `localStorage` under three keys: `stormbox.welcomeModalDismissed.v1` (`'1'` once Welcome was dismissed), `stormbox.whatsNewSeen.<round>` (`'1'` once the round is retired), and `stormbox.featureBeacons.<round>` (`{ "seen": BeaconId[], "sessions": number }` while a round is in progress). |
| OB-6.2 🟩 Done | All storage access goes through `src/utils/onboarding-storage.ts`. Every read tolerates missing, malformed, or unavailable storage: an unreadable progress record reads as no progress, unknown beacon ids are dropped, and a blocked store makes onboarding a session-only affordance rather than an error. |
| OB-6.3 🟩 Done | Arming a round increments and persists the session count before any beacon is shown, so a session that never interacts still counts toward expiry. A page load is one session however many times its connection drops and returns: re-arming after a disconnect re-reads progress without incrementing the count. |
| OB-6.4 🟩 Done | State is per browser profile: a user who finished a round on one device sees it again on another, and clearing site data shows Welcome again. |

### 6.2 Account-level state (draft, not implemented)

> **Draft.** This subsection records the intended design so the next
> round can implement it. Nothing here is built; the requirements and the
> open questions below are the scope of that work.

Goal: a user who has dismissed Welcome or worked through a round on one
device should not be shown it again on another device signed into the same
account, while a fresh browser with no synced state still behaves exactly as
section 6.1 describes.

| ID / Status | Requirement |
|:--|:--|
| OB-6.5 🟧 Planned | Onboarding state shall be stored in the account's synced settings document (`specs/006-user-settings/spec.md`, R-SET.1) as registered keys rather than in a second FileNode document, so it inherits the existing pull/push lanes, ownership checks, rights handling, conflict rebase, and the no-FileNode fallback (R-SET.12). |
| OB-6.6 🟧 Planned | The registry shall gain: `welcomeDismissedAt` (`number \| null`, epoch ms), `announcementRoundsSeen` (`string[]` of round ids), and `announcementProgress` (`Record<roundId, { seen: BeaconId[]; sessions: number }>`, holding at most the current round). Each key has a validator that discards unknown shapes and unknown ids, per R-SET.2. |
| OB-6.7 🟧 Planned | Merge semantics shall be monotone for the keys that represent "has seen": `announcementRoundsSeen` merges by set union and `announcementProgress[round].seen` merges by set union, so two devices working the same round never un-see a beacon. `sessions` shall take the maximum. This requires the settings merge to support per-key merge functions in addition to last-write-wins; `welcomeDismissedAt` remains last-write-wins. |
| OB-6.8 🟧 Planned | Precedence: when both the synced document and `localStorage` have state, the synced document wins for "seen" facts (a round seen on any device is seen here), and local progress for the current round is merged into it by the rules in OB-6.7 and then pushed. A device with no synced state yet shall not show Welcome or beacons before the first settings pull has either completed or failed; the connected-state gate that arms a round waits for that pull, bounded by a short timeout after which local state is used. |
| OB-6.9 🟧 Planned | Migration: on the first pull that succeeds for an account, existing `localStorage` flags shall be folded into the document (Welcome flag → `welcomeDismissedAt`, round seen flag → `announcementRoundsSeen`, progress → `announcementProgress`) and the local keys retained as the offline mirror. Local keys are never the only copy again once a push has succeeded. |
| OB-6.10 🟧 Planned | Shared accounts (`specs/003-folder-management/spec.md`) shall not contribute onboarding state; only the primary account's document is read and written, matching R-SET.11. |
| OB-6.11 🟧 Planned | The e2e suite shall keep a way to start a fresh round for the e2e account without clearing server state for other lanes: either a per-run round id override or a test hook that resets the three keys through the settings store. |

Open questions for the implementing round:

1. Should the session counter be per account (a user who opens the app on
   three devices burns through the five sessions faster) or per device (the
   current behaviour)? Per device requires keeping `sessions` local and out
   of the synced document.
2. Whether a settings-document merge function per key is acceptable
   architecture, or whether `announcementRoundsSeen` should be flattened into
   one boolean key per round (`announcement.<round>.seen`) so that plain
   last-write-wins of `true` is already monotone. The flattened form avoids
   changing the merge but grows the registry by one key per round.
3. Whether Welcome should re-show on a new device when the synced document
   says it was dismissed more than N months ago and several rounds have
   shipped since, or whether the pill alone is enough.

## 7. Adding a round

The checklist a release follows when it announces features. Every item is a
code or spec change in this repository; none is a server change.

1. Pick the round id (`YYYY-MM-<topic>`) and set it in
   `src/constants/feature-beacons.ts` (`FEATURE_BEACONS_STORAGE_KEY`) and
   `src/utils/onboarding-storage.ts` (`WHATS_NEW_STORAGE_KEY`).
2. Update Welcome: `FEATURE_CARDS` in `src/constants/feature-tour.ts`
   (titles, copy, order; drop cards that no longer earn their place), the
   matching scripts in `src/composables/featureSpotlightScripts.ts`, the
   tagline in `WelcomeModal.vue` if the product story changed, and the
   shortcut groups if actions were added.
3. Declare the round's beacons in `FEATURE_BEACONS`: one per control a user
   could miss, staged where the control lives inside the composer or the
   Contacts space. Features without a control of their own go into the body
   of the beacon on the control that leads to them (OB-4.12).
4. Update tests: `tests/unit/components/app-layout.test.ts` (Welcome and
   beacon flows, `BEACON_RECTS` for new anchors), `feature-beacon-layer.test.ts`
   and `feature-beacons-store.test.ts` for new ids, and
   `tests/e2e/feature-beacons.spec.js` for the new count and any new staged
   host. `tests/e2e/helpers/oidc-login.js` seeds the new round's seen flag.
5. Update this spec: OB-2.1 (cards), OB-3.1 (current round), OB-4.1
   (beacons), and the status overview.

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
  `tests/unit/stores/feature-beacons-store.test.ts` (session limit, one
  session per page load across reconnects, seen persistence, retire on all
  seen and on Dismiss all, corrupt storage).
- Browser: `tests/e2e/feature-beacons.spec.js` covers the pill count, dot
  geometry on the New Message button, hover preview, pinned card focus and
  its return to the control after `Got it`, `Got it` persistence,
  control-click retirement with the alongside card, staged reveal through
  the composer with the card clear of Send and focus landing on the
  schedule control, sidebar dots hidden under the composer backdrop, and
  `Dismiss all` surviving reload, on Chromium and Firefox. The Welcome modal has no dedicated e2e; every other spec
  dismisses it through `tests/e2e/helpers/shared-session.js`, which
  exercises OB-1.2 on each run.
