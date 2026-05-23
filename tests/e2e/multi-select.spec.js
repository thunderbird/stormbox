import { test, expect } from '@playwright/test';

import { loginViaOidc } from './helpers/oidc-login.js';
import {
  localStackEnabled,
  skipLocalStackMessage,
} from './helpers/stack-env.js';

/**
 * End-to-end regression test for the Fastmail-style multi-select
 * interaction model.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

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
      shellMessageViewHidden: document.querySelector('.shell')?.classList
        .contains('shell--message-view-hidden') ?? false,
    };
  });
}

test.describe('multi-select (Fastmail model)', () => {
  test('row click views without selecting; checkbox selects without viewing', async ({ page }) => {
    await loginViaOidc(page);
    await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });

    await expect.poll(
      async () => page.evaluate(() => Array.from(
        document.querySelectorAll('.msg-list__items > li'),
      ).filter((li) => li.dataset.placeholder !== 'true').length),
      { timeout: 30_000, message: 'inbox messages never rendered' },
    ).toBeGreaterThan(3);

    const baseline = await listDiagnostics(page);
    expect(baseline.itemsRendered).toBeGreaterThan(0);
    expect(baseline.scrollerHeight).toBeGreaterThan(200);
    expect(baseline.selectedIndexes).toEqual([]);
    expect(['empty', 'unknown']).toContain(baseline.rightPaneMode);

    const realRows = page.locator('.msg-list__items > li:not([data-placeholder="true"])');
    const realCount = await realRows.count();
    expect(realCount).toBeGreaterThan(3);

    await realRows.nth(0).locator('.msg-list__content').click();
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

    await realRows.nth(4).locator('.msg-list__check input').click({ modifiers: ['Shift'] });
    await page.waitForTimeout(200);
    const afterShift = await listDiagnostics(page);
    expect(afterShift.selectedIndexes).toEqual([2, 3, 4]);
    expect(afterShift.checkboxesChecked).toBe(3);
    expect(afterShift.headerCount).toMatch(/^3 selected/);

    await realRows.nth(3).locator('.msg-list__check input').click({ modifiers: ['Shift'] });
    await page.waitForTimeout(200);
    const afterShrink = await listDiagnostics(page);
    expect(afterShrink.selectedIndexes).toEqual([2, 3]);

    await page.locator('.message-view__bulk-actions .message-view__action--ghost').click();
    await page.waitForTimeout(200);
    const afterClear = await listDiagnostics(page);
    expect(afterClear.selectedIndexes).toEqual([]);
    expect(afterClear.focusedIndexes).toEqual([0]);
    expect(afterClear.itemsRendered).toBeGreaterThan(0);
    expect(afterClear.scrollerHeight).toBeGreaterThan(200);
    expect(afterClear.rightPaneMode).toBe('article');

    await realRows.nth(0).locator('.msg-list__content').click();
    await expect.poll(
      async () => (await listDiagnostics(page)).rightPaneMode,
      { timeout: 5_000, message: 're-click on the open row should close the message view' },
    ).toBe('unknown');
    const afterClose = await listDiagnostics(page);
    expect(afterClose.focusedIndexes,
      'focused highlight tracks the viewer pointer, not checkbox selection')
      .toEqual([]);
    expect(afterClose.selectedIndexes).toEqual([]);
    expect(afterClose.checkboxesChecked).toBe(0);
    expect(afterClose.shellMessageViewHidden).toBe(true);

    await realRows.nth(0).locator('.msg-list__content').click();
    await expect.poll(
      async () => (await listDiagnostics(page)).rightPaneMode,
      { timeout: 5_000, message: 'second click should open the message again' },
    ).toBe('article');
    const afterReopen = await listDiagnostics(page);
    expect(afterReopen.selectedIndexes).toEqual([]);
    expect(afterReopen.checkboxesChecked).toBe(0);
    expect(afterReopen.focusedIndexes).toEqual([0]);
    expect(afterReopen.shellMessageViewHidden).toBe(false);
  });
});
