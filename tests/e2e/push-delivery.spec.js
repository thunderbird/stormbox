import { test, expect } from '@playwright/test';

import { loginViaOidc } from './helpers/oidc-login.js';
import {
  localStackEnabled,
  selfEmail,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import { sendSmtpMessage } from './helpers/smtp-client.js';
import { attachConsoleTail, trackConsole } from './helpers/ui.js';

/**
 * End-to-end push-delivery regression. Injects a real message through
 * Stalwart's authenticated SMTP path and asserts the new row appears in
 * the open Inbox WITHOUT the user clicking the refresh button.
 *
 * We intentionally do not use Stormbox compose here: Stalwart 0.15.4 drops
 * JMAP self-submissions as duplicate delivery, while SMTP self-delivery
 * correctly creates an Inbox copy and emits push state changes.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

test.describe('Push delivery to the open Inbox', () => {
  test.setTimeout(180_000);

  test('an authenticated SMTP self-send shows up in Inbox without manual refresh', async ({ page }, testInfo) => {
    const consoleLines = [];
    trackConsole(page, consoleLines);

    await loginViaOidc(page);

    await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });
    await expect.poll(
      async () => {
        const current = page.locator('.folder-node.is-current');
        if ((await current.count()) === 0) return null;
        return ((await current.first().textContent()) ?? '').toLowerCase();
      },
      { timeout: 30_000, message: 'expected Inbox to be auto-selected on first connect' },
    ).toMatch(/inbox/);

    await expect.poll(
      async () => page.locator('.msg-list__item').count(),
      { timeout: 60_000, message: 'expected the initial Inbox load to paint at least one row' },
    ).toBeGreaterThan(0);

    const initialTopSubject = (await page
      .locator('.msg-list__item .msg-list__subject')
      .first()
      .textContent() ?? '').trim();
    const initialCount = await page.locator('.msg-list__item').count();
    const initialHeaderText = await page.locator('.msg-list__count').textContent();
    const initialHeaderCount = Number(initialHeaderText?.match(/\d+/)?.[0] ?? Number.NaN);
    expect(Number.isFinite(initialHeaderCount)).toBe(true);
    console.log(`[push-delivery] initial inbox top="${initialTopSubject}" rows=${initialCount}`);

    const recipient = selfEmail();
    const subjectMarker = `Push delivery e2e ${Date.now()}`;
    console.log(`[push-delivery] SMTP self-send to ${recipient} with subject "${subjectMarker}"`);
    await sendSmtpMessage({
      to: recipient,
      subject: subjectMarker,
      text: 'push delivery regression',
    });
    const sendCompletedAt = Date.now();

    const inboxRow = page.locator('.folder-node').filter({ hasText: /^inbox/i }).first();
    if ((await inboxRow.locator('..').filter({ has: page.locator('.is-current') }).count()) === 0) {
      await inboxRow.click();
      await expect.poll(
        async () => {
          const current = page.locator('.folder-node.is-current');
          if ((await current.count()) === 0) return null;
          return ((await current.first().textContent()) ?? '').toLowerCase();
        },
        { timeout: 10_000 },
      ).toMatch(/inbox/);
    }

    let observedTopSubject = initialTopSubject;
    await expect.poll(
      async () => {
        observedTopSubject = (await page
          .locator('.msg-list__item .msg-list__subject')
          .first()
          .textContent() ?? '').trim();
        return observedTopSubject;
      },
      {
        timeout: 120_000,
        message: `expected a new top row with subject "${subjectMarker}" to appear via push within 120s of send completing`,
      },
    ).toBe(subjectMarker);

    const pushArrivedMs = Date.now() - sendCompletedAt;
    console.log(`[push-delivery] new row visible ${pushArrivedMs}ms after send completed`);

    const newTopIsReal = await page.locator('.msg-list__items > li').first().evaluate(
      (li) => li.dataset.placeholder !== 'true',
    );
    expect(newTopIsReal).toBe(true);

    await expect(page.locator('.msg-list__count'))
      .toHaveText(`${initialHeaderCount + 1} messages`, { timeout: 10_000 });

    await attachConsoleTail(testInfo, consoleLines, 100);
  });
});
