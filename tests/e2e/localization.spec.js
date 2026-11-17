import { test, expect } from '@playwright/test';
import { loginViaOidc } from './helpers/oidc-login.js';
import { localStackEnabled, skipLocalStackMessage } from './helpers/stack-env.js';

test.skip(!localStackEnabled, skipLocalStackMessage);

test('preserves the English interface and renders an injected test catalog', async ({ page }) => {
  await loginViaOidc(page);
  await page.locator('.app-spaces__settings').click();
  const dialog = page.locator('[data-settings-dialog]');
  await expect(dialog.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(dialog.locator('.settings-dialog__section').first().locator('.settings-dialog__row-title')).toHaveText([
    'Keyboard shortcuts', 'Follow system theme', 'Welcome & shortcuts',
  ]);
  await expect(dialog.getByRole('button', { name: 'Close settings', exact: true })).toBeVisible();

  // Injected messages exercise Vue I18n without shipping another language or preference UI.
  await page.evaluate(async () => {
    const { i18n } = await import('/src/i18n/index.ts');
    i18n.global.setLocaleMessage('de', { settingsDialog: { settings: 'Einstellungen' } });
    i18n.global.locale.value = 'de';
  });
  await expect(dialog.getByRole('heading', { name: 'Einstellungen' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close settings', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const { i18n } = await import('/src/i18n/index.ts');
    i18n.global.locale.value = 'en';
  });
  await expect(dialog.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
});
