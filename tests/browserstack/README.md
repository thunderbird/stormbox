# Stormbox BrowserStack E2E Tests

This package contains UI-only Playwright tests for deployed Stormbox stage and production. These tests run against the public Stormbox web application on your local machine or in BrowserStack.

These tests are not for the local Stormbox stack. The local-stack integration tests live in `../e2e`; those tests use JMAP helpers, database reads, local stack setup, and cache assertions. Use this package when you want to verify the deployed UI only.

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
BROWSERSTACK_USERNAME="browserstack account user name"
BROWSERSTACK_ACCESS_KEY="corresponding browserstack access key"
```

The `.env.browserstack` file contains credentials and must stay local.

## UI Smoke Test Local Runs

These commands run the UI smoke test on your machine against the deployed `STORMBOX_BASE_URL`:

```bash
npm run e2e:desktop:firefox:smoke
npm run e2e:desktop:chrome:smoke
npm run e2e:desktop:safari:smoke
npm run e2e:mobile:google:pixel:viewport:smoke
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
npm run e2e:mobile:google:pixel:viewport
```

## Entire Suite BrowserStack Runs

These commands run all of the UI E2E tests in BrowserStack:

```bash
npm run e2e:browserstack:desktop:firefox
npm run e2e:browserstack:desktop:chrome
npm run e2e:browserstack:desktop:safari
npm run e2e:browserstack:mobile:android:chrome
```

Desktop runs authenticate once in `tests/desktop/auth.desktop.ts` and save `test-results/.auth/user.json`. Android mobile runs sign in through the UI for each test because BrowserStack mobile contexts cannot use the saved desktop auth state.
