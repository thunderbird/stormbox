import {
  expect,
  resetSharedSession,
  test,
} from './helpers/shared-session.js';
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

// expect.poll on a derived projection of listDiagnostics(). Returns the
// last observed diagnostics object so each step can run additional
// assertions against the settled state without taking another
// snapshot.
async function pollDiagnostics(page, predicate, { timeout = 5_000, message } = {}) {
  let last = null;
  await expect.poll(
    async () => {
      last = await listDiagnostics(page);
      return predicate(last);
    },
    { timeout, message: message ?? 'list diagnostics never matched predicate' },
  ).toBe(true);
  return last;
}

test.describe('multi-select (Fastmail model)', () => {
  test.beforeEach(async ({ sharedPage }) => {
    await resetSharedSession(sharedPage);
  });

  test('row click views without selecting; checkbox selects without viewing', async ({ sharedPage: page }) => {
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
    const afterRowClick = await pollDiagnostics(
      page,
      (d) => d.rightPaneMode === 'article' && d.focusedIndexes.length === 1 && d.focusedIndexes[0] === 0,
      { message: 'row click should focus row 0 and open the article view' },
    );
    expect(afterRowClick.itemsRendered).toBeGreaterThan(0);
    expect(afterRowClick.scrollerHeight).toBeGreaterThan(200);
    expect(afterRowClick.selectedIndexes,
      'row click must not toggle the selection set').toEqual([]);
    expect(afterRowClick.checkboxesChecked).toBe(0);

    // We poll on the "N selected" header text and the right-pane mode
    // because those are bound directly to the Pinia selection model.
    // Polling on the checkbox `:checked` attribute is unreliable: the
    // native input element can briefly report a stale state during the
    // click + reactive-update cycle, especially under firefox.
    await realRows.nth(2).locator('.msg-list__check input').click();
    const afterCheckbox = await pollDiagnostics(
      page,
      (d) => d.rightPaneMode === 'bulk-summary' && /\b1 selected\b/.test(d.headerCount),
      { message: 'checkbox click should select exactly row 2 and switch to bulk pane' },
    );
    expect(afterCheckbox.focusedIndexes,
      'checkbox click must not move the focused row').toEqual([0]);
    expect(afterCheckbox.selectedIndexes).toEqual([2]);

    await realRows.nth(4).locator('.msg-list__check input').click({ modifiers: ['Shift'] });
    const afterShift = await pollDiagnostics(
      page,
      (d) => /\b3 selected\b/.test(d.headerCount),
      { message: 'shift-click should extend the selection to 3 rows' },
    );
    expect(afterShift.selectedIndexes).toEqual([2, 3, 4]);

    await realRows.nth(3).locator('.msg-list__check input').click({ modifiers: ['Shift'] });
    const afterShrink = await pollDiagnostics(
      page,
      (d) => /\b2 selected\b/.test(d.headerCount),
      { message: 'shift-click on row 3 should shrink the selection to 2 rows' },
    );
    expect(afterShrink.selectedIndexes).toEqual([2, 3]);

    await page.locator('.message-view__bulk-actions .message-view__action--ghost').click();
    const afterClear = await pollDiagnostics(
      page,
      (d) => d.rightPaneMode === 'article' && !/\bselected\b/.test(d.headerCount),
      { message: 'clearing the bulk selection should return to article view' },
    );
    expect(afterClear.selectedIndexes).toEqual([]);
    expect(afterClear.focusedIndexes).toEqual([0]);
    expect(afterClear.itemsRendered).toBeGreaterThan(0);
    expect(afterClear.scrollerHeight).toBeGreaterThan(200);

    await realRows.nth(0).locator('.msg-list__content').click();
    const afterClose = await pollDiagnostics(
      page,
      (d) => d.rightPaneMode === 'unknown',
      { message: 're-click on the open row should close the message view' },
    );
    expect(afterClose.focusedIndexes,
      'focused highlight tracks the viewer pointer, not checkbox selection').toEqual([]);
    expect(afterClose.selectedIndexes).toEqual([]);
    expect(afterClose.checkboxesChecked).toBe(0);
    expect(afterClose.shellMessageViewHidden).toBe(true);

    await realRows.nth(0).locator('.msg-list__content').click();
    const afterReopen = await pollDiagnostics(
      page,
      (d) => d.rightPaneMode === 'article',
      { message: 'second click should open the message again' },
    );
    expect(afterReopen.selectedIndexes).toEqual([]);
    expect(afterReopen.checkboxesChecked).toBe(0);
    expect(afterReopen.focusedIndexes).toEqual([0]);
    expect(afterReopen.shellMessageViewHidden).toBe(false);
  });
});
