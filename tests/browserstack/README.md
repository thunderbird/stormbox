# Stormbox BrowserStack E2E Tests

This package contains Playwright tests for deployed Stormbox stage and production. Test actions and assertions run through the public Stormbox UI on your local machine or in BrowserStack. The folder-management and Contacts suites use direct JMAP access from the Node test runner solely to remove test data left by earlier interrupted runs.

These tests are not for the local Stormbox stack. The local-stack integration tests live in `../e2e` and retain their own JMAP helper, database reads, local stack setup, and cache assertions. The BrowserStack JMAP helper connects only to a deployed stage or production Thundermail account using that dedicated test account's app password.

## Setup

Run these commands directly from this directory (NOT from the Stormbox root and not inside the `thundermail-dev` container):

```bash
cd tests/browserstack
npm install
npx playwright install
```

Note: If installing the playwright browsers fails (hangs at 100%), this is due to a known playwright/test 1.59 issue and 
Node 24:16+. The issue is fixed in playwright/test 1.60 however we cannot use 1.60 because it is not supported on BrowserStack. The workaround for this issue is to use Node 24:15 or BELOW.

Choose a target environment, then copy the matching example file:

```bash
cp .env.browserstack.stage.example .env.browserstack
# or
cp .env.browserstack.prod.example .env.browserstack
```

Fill in these values in `.env.browserstack`:

```bash
ACCTS_OIDC_EMAIL="Thundermail username"
ACCTS_OIDC_PWORD="Thundermail password"
PRIMARY_THUNDERMAIL_EMAIL="primary Thundermail email address"
THUNDERMAIL_JMAP_USERNAME="Thundermail JMAP username"
THUNDERMAIL_JMAP_APP_PASSWORD="Thundermail app password created in TB Accounts"
THUNDERMAIL_JMAP_URL="deployed Thundermail JMAP URL"
BROWSERSTACK_USERNAME="browserstack account user name"
BROWSERSTACK_ACCESS_KEY="corresponding browserstack access key"
```

The `.env.browserstack` file contains credentials and must stay local. `ACCTS_OIDC_PWORD` signs into the Stormbox UI; `THUNDERMAIL_JMAP_APP_PASSWORD` is the separate app password used only for direct JMAP cleanup.

## UI Smoke Test Local Runs

These commands run the UI smoke test on your machine against the deployed `STORMBOX_BASE_URL`:

```bash
npm run e2e:desktop:firefox:smoke
npm run e2e:desktop:chrome:smoke
npm run e2e:desktop:safari:smoke
npm run e2e:mobile:android:viewport:smoke
```

## UI Smoke Test BrowserStack Runs

These commands run the same UI smoke test in BrowserStack:

```bash
npm run e2e:browserstack:desktop:firefox:smoke
npm run e2e:browserstack:desktop:chrome:smoke
npm run e2e:browserstack:desktop:safari:smoke
npm run e2e:browserstack:mobile:android:chrome:smoke
```

## Entire Suite Local Runs

These commands run all of the UI E2E tests on your machine against the deployed `STORMBOX_BASE_URL`:

```bash
npm run e2e:desktop:firefox
npm run e2e:desktop:chrome
npm run e2e:desktop:safari
npm run e2e:mobile:android:viewport
```

## Entire Suite BrowserStack Runs

These commands run all of the UI E2E tests in BrowserStack:

```bash
npm run e2e:browserstack:desktop:firefox
npm run e2e:browserstack:desktop:chrome
npm run e2e:browserstack:desktop:safari
npm run e2e:browserstack:mobile:android:chrome
```

Desktop runs authenticate once in `tests/auth.desktop.ts` and save `test-results/.auth/user.json`. Android mobile runs sign in through the UI for each test because BrowserStack mobile contexts cannot use the saved desktop auth state.

## Contacts and address books

The full desktop and mobile suites include four independent Contacts cases:

| Case | UI flow |
| --- | --- |
| Create/edit contact | Create an `E2E-Contact` with a primary Home email, Work phone, Personal website, birthday, note, Work affiliation, and PNG photo. Edit its name, add a Work email and wedding date, change the phone, website, note, and title, and replace the photo with a GIF. Reload and check changed and preserved details. |
| Delete contact | Create a separate named contact with an email, remove it from All Contacts, and check it appears in Trash. Cleanup uses Delete Forever. |
| Create/edit address book | Create an `E2E-AddressBook` with a description without making it the default, add a contact inside it, rename the book and edit its description, and check the contact remains in it while the default book stays the same. |
| Delete address book | Create another book and sole contact, check the delete dialog reports one exclusive contact, then delete the book. Check the contact is absent from All Contacts and Trash. |

Each case uses a unique suffix. Before each test, direct JMAP cleanup deletes matching cards, then empty matching books, and the UI purges matching Trash entries after sign-in. After each test, the UI removes remaining test data. Runs using the same test account must not overlap because they sweep the shared `E2E-Contact` and `E2E-AddressBook` prefixes. The four production workflows share a concurrency group and start at 05:00, 05:45, 06:30, and 07:15 UTC. Run manual BrowserStack sessions one at a time, outside those nightly jobs.
