import { test } from '@playwright/test';

import { PLAYWRIGHT_TAG_MOBILE, PLAYWRIGHT_TAG_MOBILE_SMOKE } from '../../const/constants';
import { StormboxPage } from '../../pages/stormbox-page';

let stormbox: StormboxPage;

test.describe('stormbox mobile ui smoke', {
  tag: [PLAYWRIGHT_TAG_MOBILE, PLAYWRIGHT_TAG_MOBILE_SMOKE],
}, () => {
  test.beforeEach(async ({ page }, testInfo) => {
    stormbox = new StormboxPage(page);
    await stormbox.navigate();

    // Check if the current browser supports everything Stormbox needs
    // For example, Stormbox uses SharedWorker which is supported on Android Chrome 148+
    // but not below; if the browser provided by BrowserStack is < 148 then skip
    // (BrowserStack support confirmed they don't have Android Chrome 148+ available yet)
    const missing = await stormbox.missingRequiredBrowserFeatures();
    test.skip(
      missing.length > 0,
      `Stormbox cannot run in this mobile browser. Missing: ${missing.join(', ')}.`,
    );

    await stormbox.signInIfNeeded(testInfo.project.name);
  });

  test('verify and exercise basic webmail elements after signing in', async ({ page }, testInfo) => {
    await test.step('verify signed-in mobile ui is visible', async () => {
      await stormbox.assertMobileUiVisible();
    });

    await test.step('exercise common mobile ui controls', async () => {
      await stormbox.exerciseCommonUiControls(testInfo.project.name);
    });
  });
});
