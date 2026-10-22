import { expect, test } from './helpers/shared-session.js';
import { discardCompose, waitForIdentities } from './helpers/compose.js';
import { localStackEnabled, skipLocalStackMessage } from './helpers/stack-env.js';

test.skip(!localStackEnabled, skipLocalStackMessage);

async function expectTabContained(page, dialog, count = 12) {
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let index = 0; index < count; index += 1) {
      await page.keyboard.press(key);
      await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement)))
        .toBe(true);
    }
  }
}

test('bulk progress contains focus with no controls and restores its opener', async ({ sharedPage: page }) => {
  const opener = page.locator('[data-settings-gear]');
  await opener.focus();
  await page.evaluate(async () => {
    const { useMailStore } = await import('/src/stores/mail-store.ts');
    useMailStore().bulkOperation = { active: true, label: 'Moving', total: 100 };
  });
  try {
    const dialog = page.getByRole('dialog', { name: 'Moving' });
    await expect(dialog).toBeFocused();
    await expectTabContained(page, dialog, 3);
    await opener.evaluate((el) => el.focus());
    await expect(dialog).toBeFocused();
    await page.keyboard.press('c');
    await expect(page.locator('.compose-dialog--expanded')).toHaveCount(0);
  } finally {
    await page.evaluate(async () => {
      const { useMailStore } = await import('/src/stores/mail-store.ts');
      useMailStore().bulkOperation = { active: false, label: '', total: 0 };
    });
  }
  await expect(opener).toBeFocused();
});

test('folder dialogs trap each layer and restore focus through the openers', async ({ sharedPage: page }) => {
  const opener = page.locator('[data-manage-folders]');
  await opener.click();
  const manager = page.getByRole('dialog', { name: 'Manage Folders', exact: true });
  await expect(manager).toBeVisible();
  await expectTabContained(page, manager);
  const newFolder = manager.locator('[data-folder-new]');
  await newFolder.click();
  const create = page.getByRole('dialog', { name: 'New folder', exact: true });
  await expect(create.locator('[data-folder-create-name]')).toBeFocused();
  await expectTabContained(page, create);
  await opener.evaluate((el) => el.focus());
  await expect.poll(() => create.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await create.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(newFolder).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(manager).toBeHidden();
  await expect(opener).toBeFocused();
});

test('settings and welcome keep their controls inside the active modal', async ({ sharedPage: page }) => {
  const opener = page.locator('[data-settings-gear]');
  await opener.click();
  const settings = page.locator('[data-settings-dialog]');
  await expectTabContained(page, settings);
  await settings.locator('[data-show-welcome]').click();
  const welcome = page.locator('.welcome__panel');
  await expect(welcome).toBeVisible();
  await expectTabContained(page, welcome, 20);
  await page.keyboard.press('Escape');
  await expect(welcome).toBeHidden();
  await opener.focus();
  await expect(opener).toBeFocused();
});

test('compose allows its dropdowns and restores background focus on minimize', async ({ sharedPage: page }) => {
  const opener = page.locator('[data-settings-gear]');
  await opener.focus();
  await page.keyboard.press('c');
  await waitForIdentities(page);
  const compose = page.locator('.compose-dialog--expanded');
  try {
    await expectTabContained(page, compose, 25);
    await compose.locator('.from-picker__summary').click();
    await expectTabContained(page, compose, 25);
    await page.keyboard.press('Escape');
    await expect(compose).toBeVisible();
    await compose.getByRole('button', { name: 'Minimize', exact: true }).click();
    await expect(compose).toBeHidden();
    await expect(opener).toBeFocused();
  } finally {
    const restore = page.locator('.compose-dock__restore').first();
    if (await restore.isVisible()) await restore.click();
    await discardCompose(page);
  }
});


test('modal Tab order includes textareas and skips hidden and inert descendants', async ({ sharedPage: page }) => {
  await page.locator('[data-settings-gear]').click();
  const dialog = page.locator('[data-settings-dialog]');
  await dialog.evaluate((el) => {
    const fields = document.createElement('div');
    fields.innerHTML = '<button data-focus-first>First</button>'
      + '<div hidden><button>Hidden</button></div>'
      + '<div inert><button>Inert</button></div>'
      + '<fieldset disabled><input aria-label="Disabled field"></fieldset>'
      + '<details><summary>Closed menu</summary><button>Hidden item</button></details>'
      + '<textarea aria-label="Modal text"></textarea>'
      + '<button tabindex="-1">Programmatic only</button><button data-focus-last>Last</button>';
    el.append(fields);
  });
  try {
    await dialog.locator('[data-focus-first]').focus();
    await page.keyboard.press('Tab');
    await expect(dialog.locator('summary')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('textbox', { name: 'Modal text' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.locator('[data-focus-last]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.locator('[data-focus-last]')).toBeFocused();
    await dialog.locator('[data-focus-last]').evaluate((el) => el.remove());
    await expect(dialog).toBeFocused();
  } finally {
    await page.keyboard.press('Escape');
  }
});
