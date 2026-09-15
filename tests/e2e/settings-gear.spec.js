import { expect, test } from './helpers/shared-session.js';
import { loginViaOidc } from './helpers/oidc-login.js';
import {
  localStackEnabled,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import { waitForInboxReady } from './helpers/ui.js';

test.skip(!localStackEnabled, skipLocalStackMessage);

async function shellOverflow(page) {
  return page.locator('.shell').evaluate((shell) => shell.scrollWidth - shell.clientWidth);
}

test.describe('Settings gear in narrow layouts', () => {
  // The gear sits at the foot of the spaces rail, above the sidebar toggle.
  // Below 640px the rail becomes the bottom bar, the gear is hidden and
  // the compact top-nav menu opens the same dialog. Neither placement may
  // widen the shell (sidebar-layout.spec.js measures the same shell at
  // 640px and 340px without knowing about the gear).
  test('the gear never widens the shell: in the rail from 640px, in the compact menu below', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 852 });
    await page.addInitScript(() => {
      window.localStorage.setItem('stormbox.welcomeModalDismissed.v1', '1');
      window.localStorage.setItem('stormbox.whatsNewSeen.2026-09-compose', '1');
    });
    await loginViaOidc(page);
    await waitForInboxReady(page);

    const gear = page.locator('[data-settings-gear]');
    await expect(gear).toBeVisible();
    expect(await gear.evaluate((el) => !!el.closest('.app-spaces__bottom-actions'))).toBe(true);
    expect(await shellOverflow(page)).toBeLessThanOrEqual(0);

    for (const width of [699, 640]) {
      await page.setViewportSize({ width, height: 852 });
      await expect(gear).toBeVisible();
      await expect.poll(() => shellOverflow(page), { message: `shell overflow at ${width}px` })
        .toBeLessThanOrEqual(0);
    }

    for (const width of [639, 340]) {
      await page.setViewportSize({ width, height: 852 });
      await expect(gear).toBeHidden();
      await expect.poll(() => shellOverflow(page), { message: `shell overflow at ${width}px` })
        .toBeLessThanOrEqual(0);
    }

    await page.locator('.top-nav-menu__button').click();
    await page.locator('[data-settings-menuitem]').click();
    await expect(page.locator('[data-settings-dialog]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-settings-dialog]')).toHaveCount(0);
  });
});
