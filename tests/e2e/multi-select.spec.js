import { test, expect } from '@playwright/test';

/**
 * End-to-end regression test for the Fastmail-style multi-select
 * interaction model.
 *
 * Interaction model under test:
 *
 *   - Clicking a row body only OPENS the message in the right pane
 *     (mailStore.selectedMessageId). It does NOT toggle the row's
 *     membership in the selection set. The row gets the focused/
 *     accent highlight but its checkbox stays unchecked.
 *
 *   - The leading checkbox on each row is the *only* gesture that
 *     toggles selection. Shift-click on a checkbox extends a range
 *     from the previously-toggled row, replacing the prior range
 *     (Overture-style shrink semantics, not vue-multiclick's append).
 *
 *   - The right pane swaps from the article view to the
 *     "N messages selected" summary the moment the selection set
 *     becomes non-empty, regardless of whether there's also a
 *     focused message. The focused-message preview still appears
 *     inside the summary so the user can see what they were last
 *     reading.
 *
 *   - The bulk-action toolbar lives in the summary panel only (no
 *     duplicate toolbar above the list).
 *
 * This is also a regression test against a CSS layout bug where an
 * earlier revision of `.msg-list` (grid-template-rows: auto 1fr)
 * collapsed the scroller to 0 px height the moment any toolbar
 * appeared between header and scroller. We don't render that toolbar
 * anymore, but the scroller-height assertion stays as a defensive
 * canary.
 *
 * Skips unless STAGE_USERNAME and STAGE_PASSWORD are set.
 */

const STAGE_USERNAME = process.env.STAGE_USERNAME;
const STAGE_PASSWORD = process.env.STAGE_PASSWORD;

test.skip(
  !STAGE_USERNAME || !STAGE_PASSWORD,
  'STAGE_USERNAME / STAGE_PASSWORD not set',
);

async function listDiagnostics(page) {
  return page.evaluate(() => {
    const scroller = document.querySelector('.msg-list__scroller');
    const items = Array.from(document.querySelectorAll('.msg-list__items > li'));
    const real = items.filter((li) => li.dataset.placeholder !== 'true');
    const focused = Array.from(document.querySelectorAll('.msg-list__items > li.is-focused'))
      .map((li) => Number(li.dataset.index));
    const selected = Array.from(document.querySelectorAll('.msg-list__items > li.is-selected'))
      .map((li) => Number(li.dataset.index));
    return {
      scrollerHeight: scroller?.getBoundingClientRect().height ?? 0,
      itemsRendered: items.length,
      realRows: real.length,
      focusedIndexes: focused,
      selectedIndexes: selected.sort((a, b) => a - b),
      checkboxesChecked: document.querySelectorAll('.msg-list__check input:checked').length,
      headerCount: (document.querySelector('.msg-list__count')?.textContent ?? '').trim(),
      rightPaneMode: (() => {
        if (document.querySelector('.message-view__bulk')) return 'bulk-summary';
        if (document.querySelector('.message-view__article')) return 'article';
        if (document.querySelector('.message-view__empty')) return 'empty';
        return 'unknown';
      })(),
    };
  });
}

test.describe('multi-select (Fastmail model)', () => {
  test.setTimeout(180_000);

  test('row click views without selecting; checkbox selects without viewing', async ({ page }) => {
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
      { timeout: 45_000, message: 'inbox messages never rendered' },
    ).toBeGreaterThan(3);

    const baseline = await listDiagnostics(page);
    expect(baseline.itemsRendered).toBeGreaterThan(0);
    expect(baseline.scrollerHeight).toBeGreaterThan(200);
    expect(baseline.selectedIndexes).toEqual([]);
    expect(baseline.rightPaneMode).toBe('empty');

    const realRows = page.locator('.msg-list__items > li:not([data-placeholder="true"])');
    const realCount = await realRows.count();
    expect(realCount).toBeGreaterThan(3);

    // 1. Plain click on the first row's body. This should ONLY view
    //    the message; the row's checkbox must stay unchecked and the
    //    right pane must show the article view, NOT the bulk summary.
    await realRows.nth(0).locator('.msg-list__rows').click();
    await page.waitForTimeout(200);
    const afterRowClick = await listDiagnostics(page);
    expect(afterRowClick.itemsRendered,
      'plain row click must not collapse the list')
      .toBeGreaterThan(0);
    expect(afterRowClick.scrollerHeight).toBeGreaterThan(200);
    expect(afterRowClick.focusedIndexes,
      'row click should set the focused row')
      .toEqual([0]);
    expect(afterRowClick.selectedIndexes,
      'row click must not toggle the selection set')
      .toEqual([]);
    expect(afterRowClick.checkboxesChecked).toBe(0);
    expect(afterRowClick.rightPaneMode,
      'right pane should show the article view when nothing is selected')
      .toBe('article');

    // 2. Click the checkbox on a DIFFERENT row. The selection should
    //    contain that row but the FOCUSED/viewed row stays at index 0.
    //    Right pane swaps to bulk-summary because selection >= 1.
    await realRows.nth(2).locator('.msg-list__check input').click();
    await page.waitForTimeout(200);
    const afterCheckbox = await listDiagnostics(page);
    expect(afterCheckbox.focusedIndexes,
      'checkbox click must not move the focused row')
      .toEqual([0]);
    expect(afterCheckbox.selectedIndexes).toEqual([2]);
    expect(afterCheckbox.checkboxesChecked).toBe(1);
    expect(afterCheckbox.headerCount).toMatch(/^1 selected/);
    expect(afterCheckbox.rightPaneMode,
      'right pane should switch to bulk summary at >= 1 selected')
      .toBe('bulk-summary');

    // 3. Shift-click checkbox on another row to extend a range from
    //    the previously toggled row (index 2). Range should be {2,3,4}.
    await realRows.nth(4).locator('.msg-list__check input').click({ modifiers: ['Shift'] });
    await page.waitForTimeout(200);
    const afterShift = await listDiagnostics(page);
    expect(afterShift.selectedIndexes).toEqual([2, 3, 4]);
    expect(afterShift.checkboxesChecked).toBe(3);
    expect(afterShift.headerCount).toMatch(/^3 selected/);

    // 4. Shrink-shift-click: pivot anchor is still 2, shift-click on 3
    //    should leave {2,3} (Overture replaces the range, not appends).
    await realRows.nth(3).locator('.msg-list__check input').click({ modifiers: ['Shift'] });
    await page.waitForTimeout(200);
    const afterShrink = await listDiagnostics(page);
    expect(afterShrink.selectedIndexes).toEqual([2, 3]);

    // 5. Clear the selection via the X button in the bulk summary.
    //    The right pane should snap back to the article view of the
    //    originally focused message (index 0); the row at index 0 is
    //    still the focused row and is unchanged by any of the above.
    await page.locator('.message-view__bulk-actions .message-view__action--ghost').click();
    await page.waitForTimeout(200);
    const afterClear = await listDiagnostics(page);
    expect(afterClear.selectedIndexes).toEqual([]);
    expect(afterClear.focusedIndexes).toEqual([0]);
    expect(afterClear.itemsRendered).toBeGreaterThan(0);
    expect(afterClear.scrollerHeight).toBeGreaterThan(200);
    expect(afterClear.rightPaneMode).toBe('article');

    // 6. Clicking the focused row's body never toggles its checkbox,
    //    no matter how many times we click. The article view remount
    //    after step 5's clear is async (Vue patches, then the body
    //    fetch enqueues a prefetch round trip), so poll rather than
    //    snapshot synchronously.
    await realRows.nth(0).locator('.msg-list__rows').click();
    await expect.poll(
      async () => (await listDiagnostics(page)).rightPaneMode,
      { timeout: 5_000, message: 'right pane never returned to article view after re-click' },
    ).toBe('article');
    await realRows.nth(0).locator('.msg-list__rows').click();
    const afterRepeatClicks = await listDiagnostics(page);
    expect(afterRepeatClicks.selectedIndexes).toEqual([]);
    expect(afterRepeatClicks.checkboxesChecked).toBe(0);
    expect(afterRepeatClicks.rightPaneMode).toBe('article');
  });
});
