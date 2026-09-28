import { test, expect } from '@playwright/test';

import { discardCompose } from './helpers/compose.js';
import { loginViaOidc } from './helpers/oidc-login.js';
import { localStackEnabled, skipLocalStackMessage } from './helpers/stack-env.js';
import { waitForFolderTreeReady } from './helpers/ui.js';

test.skip(!localStackEnabled, skipLocalStackMessage);

const LEGACY_KEYS = [
  'stormbox.welcomeModalDismissed.v1',
  'stormbox.whatsNewSeen.2026-09-compose',
  'stormbox.featureBeacons.2026-09-compose',
];
/** Beacons in src/constants/feature-beacons.ts; the newest `seq`. */
const BEACON_COUNT = 9;

/** The synced `onboarding` setting, read from the local settings cache. */
async function readOnboarding(page) {
  return page.evaluate(async () => {
    const [account] = await window.__repo.listAccounts();
    return (await window.__repo.getSettings(account.id))?.doc?.settings?.onboarding ?? null;
  });
}

/**
 * Feature beacons for a user who dismissed Welcome before any beacon
 * shipped: the header pill counts every unseen beacon, a dot opens its
 * card, Got it retires that beacon, and Dismiss all stores one number in
 * the synced `onboarding` setting (specs/010 §3).
 */
test.describe('Feature beacons', () => {
  test('pill, dot card, Got it, and Dismiss all', async ({ page }) => {
    // Pre-sync device keys are deleted once the synced setting takes over.
    await page.addInitScript((keys) => {
      if (window.sessionStorage.getItem('stormbox.e2e.legacySeeded')) return;
      window.sessionStorage.setItem('stormbox.e2e.legacySeeded', '1');
      for (const key of keys) window.localStorage.setItem(key, '1');
    }, LEGACY_KEYS);
    await loginViaOidc(page, { beaconsSeen: false });
    await waitForFolderTreeReady(page);

    const pill = page.locator('.beacon-menu__pill');
    await expect(pill).toHaveText(`${BEACON_COUNT} new`);
    expect(await readOnboarding(page)).toEqual({ beaconsSeenThrough: 0 });
    expect(await page.evaluate((keys) => keys.map((key) => window.localStorage.getItem(key)), LEGACY_KEYS))
      .toEqual([null, null, null]);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    const composeDot = page.locator('.feature-beacons__dot[data-beacon="newMessage"]');
    await expect(composeDot).toBeVisible();
    await expect(page.locator('.feature-beacons__dot[data-beacon="manageFolders"]')).toBeVisible();
    await expect(page.locator('.feature-beacons__dot[data-beacon="contacts"]')).toBeVisible();
    await expect(page.locator('.feature-beacons__dot[data-beacon="starMessages"]')).toBeVisible();
    await expect(page.locator('.feature-beacons__dot[data-beacon="keyboardShortcuts"]')).toBeVisible();

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
      // The dot retired with the card, so focus lands on the control itself.
      await expect(page.locator('.sidebar__compose')).toBeFocused();
      await expect(pill).toHaveText(`${BEACON_COUNT - 1} new`);
      // newMessage is seq 1, so the mark advances.
      await expect.poll(() => readOnboarding(page)).toEqual({ beaconsSeenThrough: 1 });

      // Using the control itself retires its beacon and shows the card once,
      // beside the control, while the control does its own thing.
      const contactsDot = page.locator('.feature-beacons__dot[data-beacon="contacts"]');
      await page.locator('.app-spaces [aria-label="Contacts"]').click();
      const contactsCard = page.getByRole('dialog', { name: 'Contacts have their own space' });
      await expect(contactsCard).toBeVisible();
      await expect(contactsCard).toHaveAttribute('data-beacon-card-mode', 'alongside');
      await expect(contactsCard).not.toBeFocused();
      await expect(contactsDot).toHaveCount(0);
      await expect(pill).toHaveText(`${BEACON_COUNT - 2} new`);
      // contacts is seq 4, seen above the mark.
      await expect.poll(() => readOnboarding(page)).toEqual({ beaconsSeenThrough: 1, beaconsSeenAlso: [4] });
      await expect(page.locator('.feature-beacons__dot[data-beacon="manageIdentities"]')).toBeVisible();
      await page.mouse.click(600, 400);
      await expect(contactsCard).toHaveCount(0);
      await page.locator('.app-spaces [aria-label="Mail"]').click();
      await waitForFolderTreeReady(page);

      // The pill lists the rest and reveals a staged one by opening the composer.
      await pill.click();
      const menu = page.getByRole('group', { name: 'New features' });
      await expect(menu.locator('.beacon-menu__item')).toHaveCount(BEACON_COUNT - 2);
      await menu.getByRole('button', { name: /Send on your schedule/ }).click();
      const scheduleCard = page.getByRole('dialog', { name: 'Send on your schedule' });
      await expect(page.locator('.compose-dialog')).toBeVisible();
      const scheduleDot = page.locator('.feature-beacons__dot[data-beacon="composeSchedule"]');
      await expect(scheduleDot).toBeVisible();
      await expect(scheduleCard).toBeVisible();
      await expect(scheduleCard).toBeFocused();
      // The card never sits over the Send button beside its anchor.
      const [cardBox, sendBox] = await Promise.all([
        scheduleCard.boundingBox(),
        page.locator('.compose-dialog--expanded .compose-send').boundingBox(),
      ]);
      expect(cardBox).not.toBeNull();
      expect(sendBox).not.toBeNull();
      const overlaps = cardBox.x < sendBox.x + sendBox.width
        && cardBox.x + cardBox.width > sendBox.x
        && cardBox.y < sendBox.y + sendBox.height
        && cardBox.y + cardBox.height > sendBox.y;
      expect(overlaps, 'schedule card clear of Send').toBe(false);
      // Reading the card retires its dot; the pill sits under the composer's
      // scrim, so on close focus lands on the schedule control itself.
      await expect(scheduleDot).toHaveCount(0, { timeout: 5000 });
      await page.keyboard.press('Escape');
      await expect(scheduleCard).toHaveCount(0);
      await expect(page.locator('.compose-dialog')).toBeVisible();
      await expect(page.locator('.compose-dialog--expanded .compose-schedule-menu__trigger')).toBeFocused();
      // Sidebar dots hide behind the composer's backdrop.
      await expect(page.locator('.feature-beacons__dot[data-beacon="manageFolders"]')).toHaveCount(0);

      await discardCompose(page);
      await expect(page.locator('.compose-dialog')).toHaveCount(0);

    await pill.click();
    await menu.getByRole('button', { name: 'Dismiss all' }).click();
    await expect(pill).toHaveCount(0);
    await expect(page.locator('.feature-beacons__dot')).toHaveCount(0);
    // Everything seen is one number.
    await expect.poll(() => readOnboarding(page)).toEqual({ beaconsSeenThrough: BEACON_COUNT });

    // A reload keeps it (the seed runs once per tab).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForFolderTreeReady(page);
    await expect(pill).toHaveCount(0);
    await expect(page.locator('.feature-beacons__dot')).toHaveCount(0);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  });
});
