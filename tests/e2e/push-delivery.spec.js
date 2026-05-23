import { test, expect } from '@playwright/test';

import { loginViaOidc } from './helpers/oidc-login.js';
import {
  localStackEnabled,
  selfEmail,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import { sendSmtpMessage } from './helpers/smtp-client.js';
import { attachConsoleTail, clickFolder, trackConsole } from './helpers/ui.js';
import { connectJmap, sweepOrphanTestMessages } from './helpers/jmap-client.js';

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
  test.beforeEach(async () => {
    const jmap = await connectJmap();
    await sweepOrphanTestMessages(jmap, { subjectPrefix: 'Push delivery' });
  });

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
      { timeout: 30_000, message: 'expected the initial Inbox load to paint at least one row' },
    ).toBeGreaterThan(0);

    // Give the SharedWorker time to finish the WebSocketPushEnable handshake
    // after the first Inbox paint. Fall back to a short settle delay when
    // worker logs are not forwarded to the page console under load.
    try {
      await expect.poll(
        async () => consoleLines.some((line) => /WebSocket open, push enabled/i.test(line)),
        { timeout: 15_000, message: 'expected JMAP WebSocket push to be enabled before SMTP inject' },
      ).toBe(true);
    } catch {
      await page.waitForTimeout(5_000);
    }

    await clickFolder(page, 'Inbox');

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

    // See mail-flow.spec.js for why textContent-anchored regex is
    // brittle here. The accessible name is whitespace-clean.
    const inboxRow = page.getByRole('button', { name: /^Inbox(\s|$)/i });
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
        if (observedTopSubject === subjectMarker) return subjectMarker;
        const rowCount = await page.locator('.msg-list__item').filter({ hasText: subjectMarker }).count();
        return rowCount > 0 ? subjectMarker : observedTopSubject;
      },
      {
        timeout: 30_000,
        message: `expected "${subjectMarker}" to appear via push within 30s of send completing`,
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
