import { test } from '@playwright/test';

import { PLAYWRIGHT_TAG_DESKTOP, PLAYWRIGHT_TAG_DESKTOP_SMOKE } from '../../const/constants';
import { StormboxPage } from '../../pages/stormbox-page';

test.describe('stormbox desktop ui smoke', {
  tag: [PLAYWRIGHT_TAG_DESKTOP, PLAYWRIGHT_TAG_DESKTOP_SMOKE],
}, () => {
  test('verify and exercise basic webmail elements after signing in', async ({ page }) => {
    const stormbox = new StormboxPage(page);
    await stormbox.navigate();
    await stormbox.signInIfNeeded();
    await test.step('verify signed-in desktop ui is visible', async () => {
      await stormbox.assertDesktopUiVisible();
    });
    await test.step('exercise common desktop ui controls', async () => {
      await stormbox.exerciseCommonUiControls();
    });
  });
});
