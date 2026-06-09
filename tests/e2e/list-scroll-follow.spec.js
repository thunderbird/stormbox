import { test, expect } from '@playwright/test';

import {
  connectJmap,
  ensureArchiveMailbox,
  ensureArchivePopulated,
} from './helpers/jmap-client.js';
import { loginViaOidc } from './helpers/oidc-login.js';
import {
  liveE2eEnabled,
  selfEmail,
  skipLiveE2eMessage,
} from './helpers/stack-env.js';
import {
  attachConsoleTail,
  escapeRegExp,
  trackConsole,
  waitForShellReady,
} from './helpers/ui.js';

/**
 * Regression for issue #31: keyboard navigation must keep the focused
 * message inside the scroller viewport.
 *
 * The list is virtualized, so a selected row that has scrolled out of
 * view is not even in the DOM. Walking the selection down with the
 * Thunderbird `F` shortcut must drag the viewport along so the focused
 * row stays visible. Before the fix, selectedMessageId advanced but the
 * scroller never moved, so the focused row left the viewport (and was
 * recycled out of the DOM entirely).
 *
 * Asserts the symptom (focused row in viewport), not the mechanism, so
 * it stays valid if scrollToIndex is swapped for another approach.
 */

// temp skipping until get running, remove when ready to test this one
test.skip();

test.skip(!liveE2eEnabled, skipLiveE2eMessage);

// How many rows to step past the first paint window. The initial
// viewport shows ~12-15 rows at 64px; 25 guarantees we move well past
// the bottom edge while staying inside the first loaded page (~100).
const STEPS = 25;

function focusedRowReport(page) {
  return page.evaluate(() => {
    const scroller = document.querySelector('.msg-list__scroller');
    const focused = document.querySelector('.msg-list__items > li.is-focused');
    if (!scroller) return { hasScroller: false };
    const s = scroller.getBoundingClientRect();
    const activeId = scroller.getAttribute('aria-activedescendant');
    if (!focused) {
      return {
        hasScroller: true,
        hasFocused: false,
        scrollTop: scroller.scrollTop,
        activeId,
      };
    }
    const r = focused.getBoundingClientRect();
    return {
      hasScroller: true,
      hasFocused: true,
      scrollTop: scroller.scrollTop,
      focusedIndex: Number(focused.dataset.index),
      focusedDomId: focused.id,
      activeId,
      // True when the focused row is wholly within the viewport (a few
      // px of slack for sub-pixel rounding).
      withinViewport: r.top >= s.top - 2 && r.bottom <= s.bottom + 2,
      overlapsViewport: r.bottom > s.top && r.top < s.bottom,
    };
  });
}

// Reports the keyboard cursor row as identified by the listbox's
// aria-activedescendant (which tracks focusedMessageId, the leading
// edge during a Shift+Arrow range extension), independent of the
// previewed `.is-focused` row.
function cursorReport(page) {
  return page.evaluate(() => {
    const scroller = document.querySelector('.msg-list__scroller');
    if (!scroller) return { hasScroller: false };
    const s = scroller.getBoundingClientRect();
    const activeId = scroller.getAttribute('aria-activedescendant');
    const active = activeId ? document.getElementById(activeId) : null;
    const selectedCount = document.querySelectorAll(
      '.msg-list__items > li[aria-selected="true"]',
    ).length;
    const report = {
      hasScroller: true,
      scrollTop: scroller.scrollTop,
      activeId,
      hasActive: !!active,
      selectedCount,
    };
    if (active) {
      const r = active.getBoundingClientRect();
      report.activeIndex = Number(active.dataset.index);
      report.withinViewport = r.top >= s.top - 2 && r.bottom <= s.bottom + 2;
    }
    return report;
  });
}

test.describe('Keyboard navigation keeps the focused row in view', () => {
  test.beforeAll(async () => {
    const jmap = await connectJmap();
    const archive = await ensureArchiveMailbox(jmap);
    await ensureArchivePopulated(jmap, {
      archiveMailboxId: archive.id,
      fromEmail: selfEmail(),
    });
  });

  test('F shortcut drags the viewport to follow the selection', async ({ page }, testInfo) => {
    const consoleLines = [];
    trackConsole(page, consoleLines);

    await loginViaOidc(page);
    await waitForShellReady(page);
    await page.waitForFunction(() => !!window.__repo, { timeout: 30_000 });

    const target = await page.evaluate(async () => {
      const accounts = await globalThis.__repo.listAccounts();
      const folders = await globalThis.__repo.listFolders(accounts[0].id);
      const big = folders
        .filter((f) => Number(f.total_emails ?? 0) > 1000 && !f.is_deleted)
        .sort((a, b) => Number(b.total_emails) - Number(a.total_emails));
      return big[0] ? { name: big[0].name } : null;
    });
    if (!target) {
      throw new Error('no folder over 1000 messages visible to client');
    }

    try {
      const exactName = new RegExp(`^${escapeRegExp(target.name)}\\s*\\d`);
      await page.getByRole('button', { name: exactName }).first().click();
      const scroller = page.locator('.msg-list__scroller');
      await scroller.waitFor({ state: 'visible' });
      await page.locator('.msg-list__item').first().waitFor({ state: 'visible' });

      // Open the first row, then walk the selection down with F.
      await page.locator('.msg-list__item').first().click();
      await expect.poll(async () => (await focusedRowReport(page)).hasFocused)
        .toBe(true);

      const startScrollTop = (await focusedRowReport(page)).scrollTop;

      for (let i = 0; i < STEPS; i += 1) {
        await page.keyboard.press('f');
        await page.waitForTimeout(20);
      }

      let report = null;
      await expect.poll(
        async () => {
          report = await focusedRowReport(page);
          return Boolean(report.hasFocused && report.withinViewport);
        },
        {
          timeout: 5_000,
          message: 'focused row never settled inside the scroller viewport',
        },
      ).toBe(true);

      expect(report.hasFocused, 'focused row missing from DOM after navigating down').toBe(true);
      expect(report.withinViewport, 'focused row is outside the scroller viewport').toBe(true);
      expect(report.focusedIndex, 'selection did not advance').toBeGreaterThanOrEqual(STEPS - 2);
      // The viewport actually moved (the bug left scrollTop pinned at 0).
      expect(report.scrollTop, 'scroller never scrolled to follow the selection')
        .toBeGreaterThan(startScrollTop);
      // On plain nav the cursor and preview coincide, so the listbox's
      // aria-activedescendant points at the previewed row.
      expect(report.activeId, 'aria-activedescendant not set on the listbox')
        .toBe(report.focusedDomId);
    } finally {
      await attachConsoleTail(testInfo, consoleLines);
    }
  });

  test('Shift+Arrow extends the selection and drags the viewport with the cursor', async ({ page }, testInfo) => {
    const consoleLines = [];
    trackConsole(page, consoleLines);

    await loginViaOidc(page);
    await waitForShellReady(page);
    await page.waitForFunction(() => !!window.__repo, { timeout: 30_000 });

    const target = await page.evaluate(async () => {
      const accounts = await globalThis.__repo.listAccounts();
      const folders = await globalThis.__repo.listFolders(accounts[0].id);
      const big = folders
        .filter((f) => Number(f.total_emails ?? 0) > 1000 && !f.is_deleted)
        .sort((a, b) => Number(b.total_emails) - Number(a.total_emails));
      return big[0] ? { name: big[0].name } : null;
    });
    if (!target) {
      throw new Error('no folder over 1000 messages visible to client');
    }

    try {
      const exactName = new RegExp(`^${escapeRegExp(target.name)}\\s*\\d`);
      await page.getByRole('button', { name: exactName }).first().click();
      const scroller = page.locator('.msg-list__scroller');
      await scroller.waitFor({ state: 'visible' });
      await page.locator('.msg-list__item').first().waitFor({ state: 'visible' });

      // Anchor on the first row, then focus the list so Arrow keys
      // reach the scroller's keydown handler (F is document-global, but
      // Arrow nav is bound to the scroller).
      await page.locator('.msg-list__item').first().click();
      await scroller.evaluate((el) => el.focus());
      await expect.poll(async () => (await cursorReport(page)).hasActive).toBe(true);
      const startScrollTop = (await cursorReport(page)).scrollTop;

      for (let i = 0; i < STEPS; i += 1) {
        await page.keyboard.press('Shift+ArrowDown');
        await page.waitForTimeout(20);
      }

      let report = null;
      await expect.poll(
        async () => {
          report = await cursorReport(page);
          return Boolean(report.hasActive && report.withinViewport);
        },
        {
          timeout: 5_000,
          message: 'cursor row never settled inside the scroller viewport',
        },
      ).toBe(true);

      expect(report.hasActive, 'aria-activedescendant did not resolve to a rendered row').toBe(true);
      expect(report.withinViewport, 'cursor row is outside the scroller viewport').toBe(true);
      expect(report.activeIndex, 'cursor did not advance').toBeGreaterThanOrEqual(STEPS - 2);
      expect(report.selectedCount, 'Shift+Arrow did not extend the selection').toBeGreaterThan(1);
      expect(report.scrollTop, 'scroller never scrolled to follow the cursor')
        .toBeGreaterThan(startScrollTop);
    } finally {
      await attachConsoleTail(testInfo, consoleLines);
    }
  });
});
