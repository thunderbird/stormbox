import { test, expect } from '@playwright/test';

import { loginViaOidc } from './helpers/oidc-login.js';
import {
  localStackEnabled,
  skipLocalStackMessage,
} from './helpers/stack-env.js';

/**
 * Regression test for two iframe-height bugs we hit in MessageView.
 * Uses the tall HTML message seeded by tests/fixtures/seed-mail.mjs.
 */

const TALL_HTML_SUBJECT = /Seed e2e tall HTML message/i;

test.skip(!localStackEnabled, skipLocalStackMessage);

async function iframeHeight(page) {
  return page.evaluate(() => {
    const ifr = document.querySelector('iframe.message-view__html-frame');
    if (!ifr) return null;
    return parseInt(ifr.style.height || '0', 10) || 0;
  });
}

test('iframe height grows past 120 on first open and survives body refresh', async ({ page }) => {
  test.setTimeout(180_000);
  await loginViaOidc(page);
  await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });

  await expect.poll(
    async () => page.evaluate(() => Array.from(
      document.querySelectorAll('.msg-list__items > li'),
    ).filter((li) => li.dataset.placeholder !== 'true').length),
    { timeout: 45_000 },
  ).toBeGreaterThan(2);

  const tall = page.locator('.msg-list__item').filter({ hasText: TALL_HTML_SUBJECT }).first();
  const target = (await tall.count()) > 0 ? tall : page.locator('.msg-list__item').nth(1);
  await target.locator('.msg-list__rows').click();

  await expect.poll(
    async () => iframeHeight(page),
    { timeout: 15_000, message: 'iframe height never grew past 120 on first open' },
  ).toBeGreaterThan(1000);

  const initialHeight = await iframeHeight(page);
  await page.waitForTimeout(3000);
  const stableHeight = await iframeHeight(page);
  expect(stableHeight,
    `iframe height regressed after settling: was ${initialHeight}, now ${stableHeight}`)
    .toBeGreaterThan(1000);

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
