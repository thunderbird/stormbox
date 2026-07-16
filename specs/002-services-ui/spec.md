# services-ui Integration — Reference

This document describes what Stormbox uses from
[`@thunderbirdops/services-ui`](https://github.com/thunderbird/services-ui)
(v1.6.5) and how our usage differs from the library defaults.

## Imports

services-ui enters the app through four files:

- `src/main.ts` — imports `@thunderbirdops/services-ui/style.css`
  (before `assets/styles.css`, so our token overrides win).
- `src/components/AppButton.vue` — imports `PrimaryButton`.
- `src/components/LoginGate.vue` — imports `NoticeWarningIcon`.
- `src/components/FolderManagerDialog.vue` — imports `SwitchToggle`
  for row and bulk folder-subscription controls.

No other component imports from the library directly.

## Components

### AppButton (wraps `PrimaryButton`)

`AppButton` is the house button. All labeled buttons render through it:
New Message, Sign In (OIDC and app-password submit), compose
Send/Discard, contacts Add/Save/Cancel, and the welcome modal
confirmation. It forwards the `variant` (`filled`/`outline`),
`form-action`, and `disabled` props and the `iconLeft`/`iconRight`
slots.

Differences from the stock `PrimaryButton`:

| Property | services-ui | AppButton |
|---|---|---|
| Border radius | 0.5rem | 3px |
| Icon-to-label gap | 8px | 6px |
| Label weight | 400 | 600 |
| Slot icon size | 0.75rem | 16px, `translateY(1.4px)` |
| Height (`size="compact"`, default) | 2.875rem | 34px |

`size="default"` keeps the services-ui height (used on the login card).

### AppToggleButton

A square 40×40 icon toggle used for the spaces rail (Mail, Contacts,
folder-list toggle). Not a services-ui component, but its active state
fills with `--primary-filled-gradient` (below) so it matches the
`PrimaryButton` filled surface exactly.

### NoticeWarningIcon

Rendered at 18×18 in the login-gate alpha warning banner. The banner
itself is our own element styled with the `--warn-*` tokens.

### SwitchToggle

The Manage Folders dialog uses the same controlled `SwitchToggle`
component for each row's JMAP `Mailbox.isSubscribed` setting and for
the modal bulk subscription action. Stormbox reduces the track from
the stock settings-page size to 32×20 px and the handle to 14×14 px so
the control fits dense folder rows; state, disabled behavior, and
events remain those of the services-ui component. The folder-management
contract and rationale live in `specs/003-folder-management/spec.md`.

## Theme mechanism

Dark/light is the services-ui convention: `dark`/`light` classes on
`<html>`, toggled by `applyTheme()` in `App.vue`. With no explicit
choice, `prefers-color-scheme` decides. `color-scheme: dark light` is
declared on `:root`.

## Colors

### Light mode

Light mode uses the services-ui palette as shipped. Our own `--accent`
token is set to `#1373d9` (`--colour-primary-default`) so
accent-colored Stormbox elements match services-ui buttons.

Light-mode warning tokens: `--warn-bg: #fdf4d0`, `--warn-fg: #664700`,
`--warn-border: #e7c34d`.

### Dark mode

Dark mode keeps the Stormbox palette. `html.dark` re-declares the
services-ui `--colour-*` tokens (in `assets/styles.css`) so every
services-ui component renders with our colors:

- **Neutrals** alias to our chrome tokens: `--bg #0b0c0f`,
  `--panel #11131a`, `--border #1e2230`, plus `#08090c` (lower) and
  `#2a3142` (intense border).
- **Primary** aliases to our accent `#4f8cff`, with `#16203a` (soft),
  `#5e97ff` (hover), `#3c79e6` (pressed). `--colour-accent-blue` also
  aliases to the accent.
- **Text/icon** aliases to `--text #e6e8ef` / `--muted #9aa3b2`, with
  `#c2c8d4` (secondary), accent (highlight), `#ffd166` (warning),
  `#ff6b6b` (critical), `#45c483` (success).
- **Warning** family: `#2a2206` / `#ffd166` / `#ffdb85` / `#f5c23e`.
- **Danger** family: `#3a1418` / `#ff6b6b` / `#ff8585` / `#e85555`.
- **Success** family: `#0d2a1a` / `#57c98a` / `#6ed79b` / `#2e9e63`.

Not overridden (services-ui defaults retained): the `secondary` family,
the decorative `accent-{teal,purple,orange,pink,gray}` set, and
other-product brand tokens (`apmt-*`, `send-*`, `service-*`). Nothing
in webmail renders them.

One component-level override exists: `html.dark
.base.primary.filled:not(:disabled) { color: #fff }`, because the
filled primary button takes its text color from
`--colour-neutral-base`, which is a dark surface in our dark mode.

Dark-mode warning tokens: `--warn-bg: rgba(255,193,7,0.1)`,
`--warn-fg: #ffd166`, `--warn-border: rgba(255,193,7,0.38)`.

### Shared gradient token

`--primary-filled-gradient` (defined on `:root`) reproduces the
vertical gradient services-ui paints on filled primary buttons:

```css
linear-gradient(
  180deg,
  var(--colour-accent-blue) -31.82%,
  var(--colour-primary-default) 8.74%,
  var(--colour-primary-hover) 100%
);
```

It is built from the `--colour-*` tokens, so it is theme-correct in
both modes. `AppToggleButton` uses it for its active state.

## Elements that remain Stormbox-native

The following stay on our own elements and tokens; services-ui has no
equivalent component:

- Message-action icon buttons (message view, message list, three-dot
  menus).
- Message-list filter chips.
- The alpha warning banner container (uses `--warn-*` tokens).
- Avatars, folder list (apart from its subscription switches), and
  bulk-operation progress overlay.

These draw their colors from the shared theme tokens above, so they
stay consistent with services-ui components in both modes.
