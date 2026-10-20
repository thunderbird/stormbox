import { discardCompose } from './helpers/compose.js';
import { expect, resetSharedSession, test } from './helpers/shared-session.js';
import { localStackEnabled, skipLocalStackMessage } from './helpers/stack-env.js';

test.skip(!localStackEnabled, skipLocalStackMessage);
test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ sharedPage }) => {
  await resetSharedSession(sharedPage, { extraSubjectPrefixes: ['Maximize views e2e'] });
});

test('composer fills the viewport and restores without replacing the editor', async ({ sharedPage: page }) => {
  await page.locator('.sidebar__compose').click();
  const dialog = page.locator('.compose-dialog--expanded');
  const card = dialog.locator('.compose-dialog__card');
  const editor = dialog.locator('.editor');
  try {
    await dialog.locator('#compose-subject').fill(`Maximize views e2e ${Date.now()}`);
    await editor.fill('Preserve this draft while changing its size.');
    await editor.evaluate((element) => {
      window.__maximizeEditor = element;
      const range = document.createRange();
      const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
      range.setStart(text, 8);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    const normal = await card.boundingBox();
    await dialog.getByRole('button', { name: 'Maximize composer', exact: true }).click();
    await expect.poll(() => card.boundingBox()).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
    expect(await editor.evaluate((element) => ({
      same: element === window.__maximizeEditor,
      focused: document.activeElement === element,
      offset: window.getSelection().anchorOffset,
    }))).toEqual({ same: true, focused: true, offset: 8 });
    await expect(editor).toHaveText('Preserve this draft while changing its size.');

    await dialog.getByRole('button', { name: 'Minimize', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.locator('.compose-dock__restore').click();
    await expect.poll(() => card.boundingBox()).toEqual({ x: 0, y: 0, width: 1440, height: 900 });

    const restore = dialog.getByRole('button', { name: 'Restore composer', exact: true });
    await restore.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => card.boundingBox()).toEqual(normal);
    await expect(dialog.getByRole('button', { name: 'Maximize composer', exact: true })).toBeFocused();

    for (const viewport of [{ width: 800, height: 650 }, { width: 390, height: 700 }]) {
      await page.setViewportSize(viewport);
      await dialog.getByRole('button', { name: 'Maximize composer', exact: true }).click();
      await expect.poll(() => card.boundingBox()).toEqual({ x: 0, y: 0, ...viewport });
      await dialog.getByRole('button', { name: 'Restore composer', exact: true }).click();
    }
  } finally {
    await discardCompose(page);
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});
