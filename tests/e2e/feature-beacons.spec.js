import { test, expect } from '@playwright/test';

import { discardCompose } from './helpers/compose.js';
import { loginViaOidc } from './helpers/oidc-login.js';
import { localStackEnabled, skipLocalStackMessage } from './helpers/stack-env.js';
import { waitForFolderTreeReady } from './helpers/ui.js';

test.skip(!localStackEnabled, skipLocalStackMessage);

const WHATS_NEW_KEY = 'stormbox.whatsNewSeen.2026-09-compose';
const PROGRESS_KEY = 'stormbox.featureBeacons.2026-09-compose';

/**
 * Feature beacons for a user who dismissed Welcome before this round: the
 * header pill counts every unseen beacon, a dot opens its card, Got it
 * retires that beacon, and Dismiss all ends the round for good.
 */
test.describe('Feature beacons', () => {
  test('pill, dot card, Got it, and Dismiss all', async ({ page }) => {
    await loginViaOidc(page, { whatsNewSeen: false });
    await waitForFolderTreeReady(page);
    // The shared storageState carries the What's New flag; clear it and any
    // stale progress so this session starts the round fresh.
    await page.evaluate(([flagKey, progressKey]) => {
      window.localStorage.removeItem(flagKey);
      window.localStorage.removeItem(progressKey);
    }, [WHATS_NEW_KEY, PROGRESS_KEY]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForFolderTreeReady(page);

    const pill = page.locator('.beacon-menu__pill');
    await expect(pill).toHaveText('6 new');
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    const composeDot = page.locator('.feature-beacons__dot[data-beacon="newMessage"]');
    await expect(composeDot).toBeVisible();
    await expect(page.locator('.feature-beacons__dot[data-beacon="manageFolders"]')).toBeVisible();
    await expect(page.locator('.feature-beacons__dot[data-beacon="contacts"]')).toBeVisible();

    // The dot sits on the New Message button's top-right corner.
    const [dotBox, buttonBox] = await Promise.all([
      composeDot.boundingBox(),
      page.locator('.sidebar__compose').boundingBox(),
    ]);
    expect(dotBox).not.toBeNull();
    expect(buttonBox).not.toBeNull();
    expect(Math.abs(dotBox.x + dotBox.width / 2 - (buttonBox.x + buttonBox.width))).toBeLessThan(4);
    expect(Math.abs(dotBox.y + dotBox.height / 2 - buttonBox.y)).toBeLessThan(4);

      // Hovering the control previews its card without pinning or focus.
      await page.locator('.sidebar__compose').hover();
      const card = page.getByRole('dialog', { name: 'A new composer' });
      await expect(card).toBeVisible();
      await expect(card).toHaveAttribute('data-beacon-card-mode', 'preview');
      await expect(card).not.toBeFocused();
      await page.mouse.move(600, 400);
      await expect(card).toHaveCount(0);
      await expect(composeDot).toBeVisible();

      // Clicking the dot pins it and takes focus.
      await composeDot.click();
      await expect(card).toBeVisible();
      await expect(card).toHaveAttribute('data-beacon-card-mode', 'pinned');
      await expect(card).toBeFocused();
      await expect(card).toContainText('Open a message to see the new controls');

      await card.getByRole('button', { name: 'Got it' }).click();
      await expect(card).toHaveCount(0);
      await expect(composeDot).toHaveCount(0);
      await expect(pill).toHaveText('5 new');
      expect(await page.evaluate((key) => JSON.parse(window.localStorage.getItem(key)), PROGRESS_KEY))
        .toEqual({ seen: ['newMessage'], sessions: 1 });
      expect(await page.evaluate((key) => window.localStorage.getItem(key), WHATS_NEW_KEY)).toBeNull();

      // Using the control itself retires its beacon and shows the card once,
      // beside the control, while the control does its own thing.
      const contactsDot = page.locator('.feature-beacons__dot[data-beacon="contacts"]');
      await page.locator('.app-spaces [aria-label="Contacts"]').click();
      const contactsCard = page.getByRole('dialog', { name: 'Contacts have their own space' });
      await expect(contactsCard).toBeVisible();
      await expect(contactsCard).toHaveAttribute('data-beacon-card-mode', 'alongside');
      await expect(contactsCard).not.toBeFocused();
      await expect(contactsDot).toHaveCount(0);
      await expect(pill).toHaveText('4 new');
      await expect(page.locator('.feature-beacons__dot[data-beacon="manageIdentities"]')).toBeVisible();
      await page.mouse.click(600, 400);
      await expect(contactsCard).toHaveCount(0);
      await page.locator('.app-spaces [aria-label="Mail"]').click();
      await waitForFolderTreeReady(page);

      // The pill lists the rest and reveals a staged one by opening the composer.
      await pill.click();
      const menu = page.getByRole('menu', { name: 'New features' });
      await expect(menu.getByRole('menuitem')).toHaveCount(4);
      await menu.getByRole('menuitem', { name: /Send on your schedule/ }).click();
      const scheduleCard = page.getByRole('dialog', { name: 'Send on your schedule' });
      await expect(page.locator('.compose-dialog')).toBeVisible();
      await expect(page.locator('.feature-beacons__dot[data-beacon="composeSchedule"]')).toBeVisible();
      await expect(scheduleCard).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(scheduleCard).toHaveCount(0);
      await expect(page.locator('.compose-dialog')).toBeVisible();
      // Sidebar dots hide behind the composer's backdrop.
      await expect(page.locator('.feature-beacons__dot[data-beacon="manageFolders"]')).toHaveCount(0);

      await discardCompose(page);
      await expect(page.locator('.compose-dialog')).toHaveCount(0);

    await pill.click();
    await menu.getByRole('button', { name: 'Dismiss all' }).click();
    await expect(pill).toHaveCount(0);
    await expect(page.locator('.feature-beacons__dot')).toHaveCount(0);
    expect(await page.evaluate((key) => window.localStorage.getItem(key), WHATS_NEW_KEY)).toBe('1');
    expect(await page.evaluate((key) => window.localStorage.getItem(key), PROGRESS_KEY)).toBeNull();

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForFolderTreeReady(page);
    await expect(pill).toHaveCount(0);
    await expect(page.locator('.feature-beacons__dot')).toHaveCount(0);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  });
});
