import { test, expect } from '@playwright/test';

import { loginViaOidc } from './helpers/oidc-login.js';
import {
  localStackEnabled,
  skipLocalStackMessage,
} from './helpers/stack-env.js';

/**
 * Compose against the folder drawer on a phone (CS-2.9, #49).
 *
 * Below the single-column breakpoint the folder list stops being a column and
 * becomes a drawer over the mail columns — and it is the only place the New
 * Message button lives at that width. So the drawer opens compose and then
 * covered it: the dialog was painted underneath, and every tap aimed at the
 * form landed on the folder list instead. On iOS that left a form the user
 * could see the edges of and not use.
 *
 * This has to be a browser test. The defect is a stacking order, which is
 * decided by layout and paint from CSS a component test never applies, and the
 * symptom is which element a tap reaches — so it is asserted by hit-testing a
 * point the drawer and the dialog both cover, rather than by reading a z-index
 * back out of a stylesheet.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

// iPhone-sized, and the width is the point: under 640px the drawer overlays.
test.use({ viewport: { width: 390, height: 844 } });

/** What a tap at this point would actually reach. */
function topmostAt(page, x, y) {
  return page.evaluate(({ px, py }) => {
    const el = document.elementFromPoint(px, py);
    return {
      inDialog: !!el?.closest('.compose-dialog'),
      inDrawer: !!el?.closest('.sidebar-slot'),
      description: el ? `${el.tagName.toLowerCase()}.${el.className}` : null,
    };
  }, { px: x, py: y });
}

test.describe('Compose on a phone-sized viewport', () => {
  test('stays above the folder drawer that opened it, and takes typing', async ({ page }) => {
    await loginViaOidc(page);
    await expect(page.locator('.msg-list')).toBeVisible({ timeout: 30_000 });

    // The drawer is collapsed at this width, so this is the route a phone user
    // has to compose: open the folder list, then New Message inside it.
    await page.getByRole('button', { name: 'Show folder list' }).click();
    const drawer = page.locator('.sidebar-slot');
    // Not `toBeVisible`: the collapsed drawer is slid out of the viewport with
    // a transform, so it keeps a box and passes that check while off-screen.
    await expect(drawer).not.toHaveClass(/sidebar-slot--hidden/);
    await expect.poll(
      async () => (await drawer.boundingBox())?.x ?? -1,
      { message: 'the drawer should finish sliding in before anything is measured' },
    ).toBeGreaterThanOrEqual(0);
    const drawerBox = await drawer.boundingBox();

    // The drawer must be over the mail columns — that is what makes it a
    // drawer, and a "fix" that simply moved it out of the way would pass every
    // assertion below while breaking this.
    const overColumns = await topmostAt(
      page, drawerBox.x + drawerBox.width / 2, drawerBox.y + drawerBox.height / 2,
    );
    expect(
      overColumns.inDrawer,
      `the drawer overlays the mail columns; topmost was ${overColumns.description}`,
    ).toBe(true);

    await page.getByRole('button', { name: 'New Message' }).click();
    const dialog = page.locator('.compose-dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // A point inside both: the card is ~96vw wide and centred, so its left
    // edge sits within the drawer's 240px. This is where the bug showed.
    const card = page.locator('.compose-dialog__card');
    const cardBox = await card.boundingBox();
    const fromBox = await page.locator('.compose-dialog .from-picker').boundingBox();
    expect(fromBox.x + fromBox.width, 'the From picker stays inside the compose card')
      .toBeLessThanOrEqual(cardBox.x + cardBox.width + 0.5);
    const x = cardBox.x + 12;
    const y = cardBox.y + cardBox.height / 2;
    expect(x, 'the sample point must be one the drawer also covers')
      .toBeLessThan(drawerBox.x + drawerBox.width);

    const overlap = await topmostAt(page, x, y);
    expect(
      overlap.inDialog,
      `a tap on the form should reach the form, not ${overlap.description}`,
    ).toBe(true);
    expect(overlap.inDrawer, 'and not the drawer that opened it').toBe(false);

    // Visible and above is half of it; the requirement also says interactive.
    const to = page.locator('.compose-dialog #compose-to');
    await to.click();
    await to.fill('phone@example.org');
    await expect(to).toHaveValue('phone@example.org');
    await expect(to, 'and the field the user tapped is the one with focus').toBeFocused();
  });
});
