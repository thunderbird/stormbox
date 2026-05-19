import { test, expect } from '@playwright/test';

/**
 * Regression test for two iframe-height bugs we hit in MessageView:
 *
 *  1. The body-prefetch path in mail-store.selectMessage calls
 *     `refreshMessageBody` twice per click — once immediately, once
 *     after `drainBodyPrefetchQueue` settles. Each call assigns a
 *     fresh body object with the same content. The MessageView watch
 *     used to unconditionally reset `iframeHeight = 120` whenever the
 *     watch fired, even when the computed srcdoc string was identical
 *     to the current one — which meant the second body refresh
 *     clobbered the height that `measure()` had grown to via the
 *     iframe `load` event (the iframe's srcdoc attribute doesn't
 *     reload on no-op assignment, so `load` never refires).
 *
 *     The visible symptom was a tall HTML email locked at ~120 px on
 *     first open, only growing back when the user clicked away and
 *     back. This test pins that down by checking the height stabilises
 *     at > 1000 px and stays there.
 *
 *  2. Round-tripping through the multi-select bulk-summary view
 *     (article -> bulk via checkbox -> article via clear) must also
 *     leave the iframe at a real height, not 120.
 */

const STAGE_USERNAME = process.env.STAGE_USERNAME;
const STAGE_PASSWORD = process.env.STAGE_PASSWORD;

test.skip(
  !STAGE_USERNAME || !STAGE_PASSWORD,
  'STAGE_USERNAME / STAGE_PASSWORD not set',
);

async function iframeHeight(page) {
  return page.evaluate(() => {
    const ifr = document.querySelector('iframe.message-view__html-frame');
    if (!ifr) return null;
    return parseInt(ifr.style.height || '0', 10) || 0;
  });
}

test('iframe height grows past 120 on first open and survives body refresh', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.getByRole('button', { name: /use app password instead/i }).click();
  await page.getByLabel('Username').fill(STAGE_USERNAME);
  await page.getByLabel('App password').fill(STAGE_PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });

  await expect.poll(
    async () => page.evaluate(() => Array.from(
      document.querySelectorAll('.msg-list__items > li'),
    ).filter((li) => li.dataset.placeholder !== 'true').length),
    { timeout: 45_000 },
  ).toBeGreaterThan(2);

  // PledgeBox is the marketing email seeded into stage that exposed
  // this bug. It's a long table-layout newsletter that needs ~10 000 px
  // to render — way past the initial 120 px placeholder.
  const tall = page.locator('.msg-list__item').filter({ hasText: /pledgebox/i }).first();
  const target = (await tall.count()) > 0 ? tall : page.locator('.msg-list__item').nth(1);
  await target.locator('.msg-list__rows').click();

  // Wait for the iframe to mount AND for measure() to have run past
  // 120. With the fix in place this happens within ~500ms; without
  // the fix it never happens.
  await expect.poll(
    async () => iframeHeight(page),
    { timeout: 15_000, message: 'iframe height never grew past 120 on first open' },
  ).toBeGreaterThan(1000);

  // Sit on the height for 3 s to make sure no late watcher fires
  // clobber it back down — this is what the second refreshMessageBody
  // used to do.
  const initialHeight = await iframeHeight(page);
  await page.waitForTimeout(3000);
  const stableHeight = await iframeHeight(page);
  expect(stableHeight,
    `iframe height regressed after settling: was ${initialHeight}, now ${stableHeight}`)
    .toBeGreaterThan(1000);

  // Toggle a checkbox to swap to the bulk-summary view (iframe is
  // unmounted), then clear the selection so the article view comes
  // back. The iframe should re-mount AND grow to a real height again.
  const realRows = page.locator('.msg-list__item').filter({ hasNot: page.locator('[data-placeholder="true"]') });
  const otherCheckbox = realRows.nth(1).locator('.msg-list__check input');
  await otherCheckbox.click();
  await expect(page.locator('.message-view__bulk')).toBeVisible({ timeout: 5_000 });
  await page.locator('.message-view__bulk-actions .message-view__action--ghost').click();
  await expect(page.locator('iframe.message-view__html-frame')).toBeVisible({ timeout: 5_000 });
  await expect.poll(
    async () => iframeHeight(page),
    { timeout: 10_000, message: 'iframe height stuck at 120 after returning from bulk view' },
  ).toBeGreaterThan(1000);
});
