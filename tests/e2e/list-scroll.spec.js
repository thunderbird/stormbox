import { test, expect } from '@playwright/test';

import { loginViaOidc } from './helpers/oidc-login.js';
import {
  localStackEnabled,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import {
  attachConsoleTail,
  trackConsole,
  waitForShellReady,
} from './helpers/ui.js';

/**
 * Regression for a class of "rows never load after a fast scrollbar
 * drag" bugs.
 *
 * What triggers the class: anything that lets the message-list view
 * fall into a state where the user's visible window is uncovered
 * (rendering placeholder rows) and no async work is in flight to
 * fix it. The first concrete instance was a leading-edge-only
 * throttle on the scroll-driven fetch that fired the initial load
 * synchronously and then dropped every subsequent in-window
 * scroll, including the final one - so after the user released
 * the scrollbar nothing kicked the loader. Other instances of the
 * same shape (eg a hung promise, a forgotten setTimeout cleanup,
 * a re-pump that bails on the wrong condition) would also be
 * caught here.
 *
 * The test deliberately asserts on the symptom (visible rows are
 * not placeholders), not on the throttle mechanism, so it stays
 * valid if the implementation changes again.
 *
 * Uses the seeded Archive folder (>=1500 msgs from
 * tests/fixtures/seed-mail.mjs) so the scroll target is far
 * outside whatever the initial-paint window already covered.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

test.describe('Large folder scroll renders rows, no orphan placeholders', () => {
  test.setTimeout(180_000);

  test('rapid mid-folder scroll fills the visible window', async ({ page }, testInfo) => {
    const consoleLines = [];
    trackConsole(page, consoleLines);

    await loginViaOidc(page);
    await waitForShellReady(page);
    await page.waitForFunction(() => !!window.__repo, { timeout: 30_000 });

    const target = await page.evaluate(async () => {
      const accounts = await globalThis.__repo.listAccounts();
      const account = accounts[0];
      const folders = await globalThis.__repo.listFolders(account.id);
      const big = folders
        .filter((f) => Number(f.total_emails ?? 0) > 1000 && !f.is_deleted)
        .sort((a, b) => Number(b.total_emails) - Number(a.total_emails));
      const folder = big[0];
      return folder ? { name: folder.name, total: Number(folder.total_emails) } : null;
    });
    test.skip(!target, 'no folder over 1000 messages - run npm run stack:seed first');

    try {
      await page.locator('.folder-node').filter({ hasText: target.name }).click();
      const scroller = page.locator('.msg-list__scroller');
      await scroller.waitFor({ state: 'visible' });
      // Wait for the first page of rows to render so we know the
      // virtualizer is alive and an initial ensureLoaded has fired.
      await page.locator('.msg-list__item').first().waitFor({ state: 'visible' });

      // Reproduce the symptom shape exactly.
      //
      // The bug requires the system to land in a state where:
      //  - `lastPrefetch` was recently updated (so any new scroll
      //    is throttled),
      //  - no `_loadPage` is in flight and the mail-store
      //    `.finally` re-pump chain has already bailed on a
      //    covered range,
      //  - the visible window is NOT in paintedRanges,
      //  - no future watcher fire will occur (the scrollbar is
      //    released).
      //
      // To get there:
      //   1. A small scroll to shift the visible window by a few
      //      rows. This triggers a watcher fire that loads the new
      //      window and sets lastPrefetch.
      //   2. A short wait so the load completes and the
      //      `.finally` re-pump chain exits (it bails because
      //      requestedRange == the just-loaded range), but short
      //      enough that lastPrefetch is still inside the throttle
      //      window.
      //   3. A big jump to a position the cache covers but
      //      paintedRanges does not. The watcher fires for this
      //      range, gets throttled, and -- with the buggy code --
      //      nothing else runs.
      const SMALL_SCROLL_PX = 200;
      const BIG_SCROLL_PCT = 0.60;
      // Inside the production THROTTLE_MS (100 ms) but past the
      // typical cache-hit `_loadPage` time (<30 ms locally).
      const PRE_THROTTLE_WAIT_MS = 70;

      await scroller.evaluate((el, px) => {
        el.scrollTop = px;
      }, SMALL_SCROLL_PX);
      await page.waitForTimeout(PRE_THROTTLE_WAIT_MS);
      await scroller.evaluate((el, pct) => {
        el.scrollTop = Math.floor(el.scrollHeight * pct);
      }, BIG_SCROLL_PCT);

      // Generous settle window. A correctly-implemented fetch
      // chain should populate the visible window in well under a
      // second; we give 5 to make CI noise tolerable.
      await page.waitForTimeout(5_000);

      // Count placeholder vs real rows whose bounding box overlaps
      // the scroller viewport. Placeholders outside the viewport
      // are fine (the virtualizer renders a small over-render
      // buffer). What we are guarding against is the user seeing
      // empty rows where they expect content.
      const result = await page.evaluate(() => {
        const scroller = document.querySelector('.msg-list__scroller');
        if (!scroller) return null;
        const sRect = scroller.getBoundingClientRect();
        const items = Array.from(document.querySelectorAll(
          '.msg-list__item, .msg-list__item--placeholder',
        ));
        const visible = items.filter((el) => {
          const r = el.getBoundingClientRect();
          // overlaps the scroller viewport at all
          return r.bottom > sRect.top && r.top < sRect.bottom;
        });
        const placeholders = visible.filter((el) =>
          el.classList.contains('msg-list__item--placeholder'),
        );
        const real = visible.filter((el) =>
          el.classList.contains('msg-list__item'),
        );
        return {
          visibleCount: visible.length,
          placeholderCount: placeholders.length,
          realCount: real.length,
        };
      });

      expect(result, 'message-list scroller not in DOM').not.toBeNull();
      expect(
        result.realCount,
        'expected the post-scroll viewport to contain at least some real rows',
      ).toBeGreaterThan(0);
      expect(
        result.placeholderCount,
        `${result.placeholderCount} of ${result.visibleCount} visible rows are still placeholders after a 5s settle window`,
      ).toBe(0);
    } finally {
      await attachConsoleTail(testInfo, consoleLines);
    }
  });
});
