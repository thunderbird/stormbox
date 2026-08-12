import { test } from '@playwright/test';

import {
  PLAYWRIGHT_TAG_DESKTOP,
  PLAYWRIGHT_TAG_DESKTOP_SMOKE,
  PLAYWRIGHT_TAG_MOBILE,
  PLAYWRIGHT_TAG_MOBILE_SMOKE
} from '../const/constants';

import { StormboxPage } from '../pages/stormbox-page';

let stormbox: StormboxPage;
let mobile: boolean = false;

test.describe('stormbox ui smoke', {
  tag: [PLAYWRIGHT_TAG_DESKTOP, PLAYWRIGHT_TAG_DESKTOP_SMOKE, PLAYWRIGHT_TAG_MOBILE, PLAYWRIGHT_TAG_MOBILE_SMOKE],
}, () => {
  test.beforeEach(async ({ page }, testInfo) => {
    mobile = testInfo.project.name.toLowerCase().includes('android');
    stormbox = new StormboxPage(page);
    await stormbox.navigate();

    // make sure browser has required dependencies; i.e. sharedworker is supported on Android Chrome 148+ only
    const missing = await stormbox.missingRequiredBrowserFeatures();
    test.skip(
      missing.length > 0,
      `Stormbox cannot run in this mobile browser. Missing: ${missing.join(', ')}.`,
    );

    // on mobile we need to sign in each time (desktop uses auth.desktop and saves context)
    if (mobile) {
      await stormbox.signInIfNeeded(testInfo.project.name);
    }
  });

  test('verify and exercise basic webmail elements after signing in', async ({ page }, testInfo) => {
    await test.step('verify signed-in stormbox ui is visible', async () => {
      if (mobile) {
        await stormbox.assertMobileUiVisible();
      } else {
        await stormbox.assertDesktopUiVisible();
      }
    });

    await test.step('exercise common stormbox ui controls', async () => {
      await stormbox.exerciseCommonUiControls(testInfo.project.name);
    });
  });
});
